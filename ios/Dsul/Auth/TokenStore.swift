import DsulCore
import Foundation
import Security

/// Where the signed-in session lives between launches. Behind a protocol so
/// the hosted tests never touch the Keychain: CI builds unsigned, and an
/// unsigned simulator app gets -34018 from every SecItem call.
@MainActor
protocol TokenStore: AnyObject {
    /// The saved session, or nil. Any failure to read is "signed out".
    func load() -> AuthSession?
    /// Throws when the session couldn't be kept; AuthStore then holds it in
    /// memory and tries again.
    func save(_ session: AuthSession) throws
    func clear()
}

struct KeychainError: Error, Equatable {
    let status: OSStatus
}

/// The session as one JSON blob in a generic-password item,
/// `AfterFirstUnlockThisDeviceOnly`: readable in the background once the
/// phone has been unlocked (later widgets, the Live Activity), and never
/// synced through iCloud or carried to another phone in a backup.
///
/// Keychain items survive deleting the app; UserDefaults doesn't. So the
/// Keychain is read only when this install's defaults say it wrote a session
/// (`inUseKey`), and an install's first launch wipes whatever an earlier
/// install left (`installSeenKey`): a reinstall starts signed out, and its
/// old refresh token is never used. After that first launch, a signed-out
/// launch touches no Keychain at all.
@MainActor
final class KeychainTokenStore: TokenStore {
    private static let service = "app.dsul.ios.auth"
    private static let account = "session"
    static let inUseKey = "auth.keychainInUse"
    static let installSeenKey = "auth.installSeen"

    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    private var baseQuery: [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
        ]
    }

    func load() -> AuthSession? {
        if !defaults.bool(forKey: Self.installSeenKey) {
            defaults.set(true, forKey: Self.installSeenKey)
            if !defaults.bool(forKey: Self.inUseKey) {
                _ = SecItemDelete(baseQuery as CFDictionary)
            }
        }
        guard defaults.bool(forKey: Self.inUseKey) else { return nil }
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(AuthSession.self, from: data)
    }

    func save(_ session: AuthSession) throws {
        let data = try JSONEncoder().encode(session)
        _ = SecItemDelete(baseQuery as CFDictionary)
        var attributes = baseQuery
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        defaults.set(true, forKey: Self.inUseKey)
    }

    func clear() {
        defaults.removeObject(forKey: Self.inUseKey)
        _ = SecItemDelete(baseQuery as CFDictionary)
    }
}

/// A session held in memory only: the hosted tests, and the app when it is a
/// test host (`AuthStore.makeLive`).
@MainActor
final class InMemoryTokenStore: TokenStore {
    private(set) var session: AuthSession?
    /// Tests: every save fails while this is on, as a locked Keychain does.
    var failSaves = false
    /// Tests: the store whose state each save records, so a test can see that
    /// the tokens were kept BEFORE the app counted itself signed in.
    weak var observedAuth: AuthStore?
    private(set) var stateAtSave: [AuthState] = []

    init(session: AuthSession? = nil) {
        self.session = session
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
}
