import DsulCore
import Foundation
import Security

/// Where the signed-in session lives between launches, and the email sign-in
/// this phone started (`EmailSignIn`, whose link may be opened after the app
/// was quit). Behind a protocol so the hosted tests never touch the Keychain:
/// CI builds unsigned, and an unsigned simulator app gets -34018 from every
/// SecItem call.
@MainActor
protocol TokenStore: AnyObject {
    /// The saved session, or nil. Any failure to read is "signed out".
    func load() -> AuthSession?
    /// Throws when the session couldn't be kept; AuthStore then holds it in
    /// memory and tries again.
    func save(_ session: AuthSession) throws
    /// Forgets the session only; a pending email sign-in stays.
    func clear()
    /// The email sign-in under way, or nil. Any failure to read is nil.
    func loadPendingEmail() -> EmailSignIn?
    /// Throws when the record couldn't be kept; AuthStore holds it in memory.
    func savePendingEmail(_ pending: EmailSignIn) throws
    /// Forgets the email sign-in only; the session stays.
    func clearPendingEmail()
}

struct KeychainError: Error, Equatable {
    let status: OSStatus
}

/// The three SecItem calls KeychainTokenStore makes, so the hosted tests can
/// see which items it touches and when (`SystemKeychain` is the real one).
@MainActor
protocol KeychainBackend: AnyObject {
    /// The item's data, or nil (none, or any failure to read).
    func copyData(_ query: [String: Any]) -> Data?
    func add(_ attributes: [String: Any]) -> OSStatus
    func delete(_ query: [String: Any])
}

@MainActor
final class SystemKeychain: KeychainBackend {
    func copyData(_ query: [String: Any]) -> Data? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        return SecItemAdd(attributes as CFDictionary, nil)
    }

    func delete(_ query: [String: Any]) {
        _ = SecItemDelete(query as CFDictionary)
    }
}

/// Each record as one JSON blob in its own generic-password item (accounts
/// "session" and "pendingEmail"), `AfterFirstUnlockThisDeviceOnly`: readable
/// in the background once the phone has been unlocked (later widgets, the Live
/// Activity), and never synced through iCloud or carried to another phone in a
/// backup. Every query names its account, so no call here can ever read or
/// delete the other item.
///
/// Keychain items survive deleting the app; UserDefaults doesn't. So an item
/// is read only when this install's defaults say it wrote one (`inUseKey`,
/// `pendingEmailInUseKey`), and an install's first launch deletes each item
/// whose flag it never set (`installSeenKey`): a reinstall starts signed out,
/// and an old refresh token or verifier is never used. After that first
/// launch, a signed-out launch touches no Keychain at all.
@MainActor
final class KeychainTokenStore: TokenStore {
    private static let service = "app.dsul.ios.auth"
    static let sessionAccount = "session"
    static let pendingEmailAccount = "pendingEmail"
    static let inUseKey = "auth.keychainInUse"
    static let pendingEmailInUseKey = "auth.pendingEmailInUse"
    static let installSeenKey = "auth.installSeen"

    private let defaults: UserDefaults
    private let keychain: any KeychainBackend

    init(defaults: UserDefaults, keychain: any KeychainBackend) {
        self.defaults = defaults
        self.keychain = keychain
    }

    static func query(account: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func load() -> AuthSession? {
        return read(AuthSession.self, account: Self.sessionAccount, flag: Self.inUseKey)
    }

    func save(_ session: AuthSession) throws {
        try write(session, account: Self.sessionAccount, flag: Self.inUseKey)
    }

    func clear() {
        remove(account: Self.sessionAccount, flag: Self.inUseKey)
    }

    func loadPendingEmail() -> EmailSignIn? {
        return read(EmailSignIn.self, account: Self.pendingEmailAccount, flag: Self.pendingEmailInUseKey)
    }

    func savePendingEmail(_ pending: EmailSignIn) throws {
        try write(pending, account: Self.pendingEmailAccount, flag: Self.pendingEmailInUseKey)
    }

    func clearPendingEmail() {
        remove(account: Self.pendingEmailAccount, flag: Self.pendingEmailInUseKey)
    }

    /// The first launch of an install deletes what an earlier install left:
    /// each item this install's defaults never marked as written.
    private func wipeOnFirstLaunch() {
        guard !defaults.bool(forKey: Self.installSeenKey) else { return }
        defaults.set(true, forKey: Self.installSeenKey)
        if !defaults.bool(forKey: Self.inUseKey) {
            keychain.delete(Self.query(account: Self.sessionAccount))
        }
        if !defaults.bool(forKey: Self.pendingEmailInUseKey) {
            keychain.delete(Self.query(account: Self.pendingEmailAccount))
        }
    }

    private func read<Value: Decodable>(_ type: Value.Type, account: String, flag: String) -> Value? {
        wipeOnFirstLaunch()
        guard defaults.bool(forKey: flag), let data = keychain.copyData(Self.query(account: account)) else { return nil }
        return try? JSONDecoder().decode(Value.self, from: data)
    }

    private func write<Value: Encodable>(_ value: Value, account: String, flag: String) throws {
        wipeOnFirstLaunch()
        let data = try JSONEncoder().encode(value)
        keychain.delete(Self.query(account: account))
        var attributes = Self.query(account: account)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = keychain.add(attributes)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        defaults.set(true, forKey: flag)
    }

    private func remove(account: String, flag: String) {
        defaults.removeObject(forKey: flag)
        keychain.delete(Self.query(account: account))
    }
}

/// A session and a pending email sign-in held in memory only: the hosted
/// tests, and the app when it is a test host (`AuthStore.makeLive`).
@MainActor
final class InMemoryTokenStore: TokenStore {
    private(set) var session: AuthSession?
    private(set) var pendingEmail: EmailSignIn?
    /// Tests: every save fails while this is on, as a locked Keychain does.
    var failSaves = false
    /// Tests: the store whose state each save records, so a test can see that
    /// the tokens were kept BEFORE the app counted itself signed in.
    weak var observedAuth: AuthStore?
    private(set) var stateAtSave: [AuthState] = []
    /// Tests: how often the pending record was read, so a test can see that a
    /// signed-out launch never asks.
    private(set) var pendingLoads = 0

    init(session: AuthSession? = nil, pendingEmail: EmailSignIn? = nil) {
        self.session = session
        self.pendingEmail = pendingEmail
    }

    func load() -> AuthSession? {
        return session
    }

    func save(_ session: AuthSession) throws {
        if let observedAuth { stateAtSave.append(observedAuth.state) }
        if failSaves { throw KeychainError(status: -34018) }
        self.session = session
    }

    func clear() {
        session = nil
    }

    func loadPendingEmail() -> EmailSignIn? {
        pendingLoads += 1
        return pendingEmail
    }

    func savePendingEmail(_ pending: EmailSignIn) throws {
        if failSaves { throw KeychainError(status: -34018) }
        pendingEmail = pending
    }

    func clearPendingEmail() {
        pendingEmail = nil
    }
}
