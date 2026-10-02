import CryptoKit
import DsulCore
import Foundation
import Observation

/// A signed-in session (DsulCore AuthCore.swift), named for the app.
typealias AuthSession = DsulCore.Session

/// Where the app is: the sign-in screen (or a sign-in under way), the
/// signed-in user's planner, or the sample planner.
enum AuthState: Equatable, Sendable {
    case signedOut
    case signingIn
    case signedIn(AuthSession)
    case sample
}

enum AuthError: Error, Equatable, Sendable {
    /// No session, or GoTrue says it can never refresh again.
    case signedOut
    /// Auth couldn't be reached; the tokens are kept and tried again later.
    case unavailable
    /// The sign-in didn't complete (a callback that didn't parse, a refused
    /// exchange).
    case failed
    /// Google or GoTrue sent an error code back (never its description).
    case provider(String)
    /// GoTrue refused to exchange a code: its status and error code.
    case exchange(status: Int, code: String?)
    /// GoTrue refused to send a sign-in email: its status and error code.
    case send(status: Int, code: String?)
}

/// Sign-in, the tokens and their refresh: Supabase Auth (GoTrue) spoken
/// directly, with the pure half in DsulCore's AuthCore.swift.
///
/// - Google, through the authorization-code flow with PKCE (S256). The
///   verifier is made here, held in memory for one attempt and dropped after
///   it, whether the exchange worked or not.
/// - An emailed link, with PKCE too, but the verifier has to outlive the app:
///   the link may be opened after a quit. It is kept in an `EmailSignIn`
///   record in the token store from before the request until a link signs in,
///   with a nonce that the link brings back; a callback without it moves
///   nothing (memory/plans/ios-app.md, "Email link").
/// - Tokens are saved BEFORE the app counts itself signed in, and every
///   refreshed pair before it is handed out. A failed save keeps the pair in
///   memory and tries the save again on the next token request.
/// - One refresh at a time (`refreshTask`): refresh tokens rotate, and two
///   refreshes with one token would revoke the session. Only a GoTrue verdict
///   that the session is gone signs out (`classifyRefreshFailure`, which is how
///   a global sign-out on the web arrives); a 5xx, a 429 or no network keeps
///   the tokens and retries with the SAME refresh token, inside GoTrue's reuse
///   window (about 10 seconds, from memory).
/// - Sign-out is `scope=local`: GoTrue's default is global, which would sign
///   the web and the desktop app out too. The local wipe happens first and
///   whatever the call does.
@Observable @MainActor
final class AuthStore {
    private(set) var state: AuthState
    /// Why the sign-in screen is showing: a failed sign-in, or a session that
    /// ended. Nil on a plain first launch and after a cancel.
    private(set) var message: String? = nil

    private let tokenStore: any TokenStore
    private let configStore: SupabaseConfigStore
    private let transport: Transport
    private let now: @Sendable () -> Date
    private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private var refreshTask: Task<AuthSession, Error>? = nil
    /// A refreshed or new session the token store couldn't keep yet.
    @ObservationIgnored private var unsaved: AuthSession? = nil
    /// The email of an interactive sign-in, until the app has said "Signed in
    /// as …" once.
    @ObservationIgnored private var welcome: String? = nil
    /// The address a sign-in link just went to: the sign-in screen says
    /// "Check your email" while it is set.
    private(set) var emailSent: String? = nil
    /// A link is being sent; the sign-in screen holds its buttons meanwhile.
    private(set) var isSendingEmail = false
    /// The email sign-in under way, read from the token store at most once and
    /// only when needed, so a signed-out launch reads nothing.
    @ObservationIgnored private var pending: EmailSignIn? = nil
    @ObservationIgnored private var pendingLoaded = false

    /// The waits between refresh attempts that failed for want of a server:
    /// three tries within about three seconds, well inside the reuse window.
    static let refreshRetryDelays: [Duration] = [.seconds(1), .seconds(2)]

    init(tokenStore: any TokenStore, configStore: SupabaseConfigStore, transport: @escaping Transport,
         now: @escaping @Sendable () -> Date = { Date() },
         sleep: @escaping @Sendable (Duration) async throws -> Void = { duration in try await Task.sleep(for: duration) }) {
        self.tokenStore = tokenStore
        self.configStore = configStore
        self.transport = transport
        self.now = now
        self.sleep = sleep
        if let saved = tokenStore.load() {
            state = .signedIn(saved)
        } else {
            state = .signedOut
        }
    }

    /// The app's store: the Keychain, the production origin (or a Debug
    /// override) and URLSession. As a test host the app keeps tokens in
    /// memory, so the hosted tests never read a Keychain a developer signed
    /// in to on the same simulator.
    static func makeLive() -> AuthStore {
        let defaults = UserDefaults.standard
        let store: any TokenStore
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil {
            store = InMemoryTokenStore()
        } else {
            store = KeychainTokenStore(defaults: defaults, keychain: SystemKeychain())
        }
        let config = SupabaseConfigStore(origin: AppConfig.apiOrigin, defaults: defaults, transport: HTTP.live)
        return AuthStore(tokenStore: store, configStore: config, transport: HTTP.live)
    }

    var session: AuthSession? {
        if case .signedIn(let session) = state { return session }
        return nil
    }

    var isSignedIn: Bool { session != nil }
    var email: String? { session?.email }

    /// What AppGate keys the planner on: one per user, one for the sample,
    /// none on the sign-in screen. A token refresh doesn't change it.
    var gateKey: String {
        switch state {
        case .signedOut, .signingIn:
            return "signed-out"
        case .sample:
            return "sample"
        case .signedIn(let session):
            return "user:" + session.userId.uuidString
        }
    }

    // MARK: Signing in

    /// Google in the auth session, then the code exchanged for tokens. The
    /// view passes the session's `authenticate`, which must throw
    /// `CancellationError` when the user closes the sheet: a cancel is silent.
    func signInWithGoogle(authenticate: @MainActor (URL) async throws -> URL) async {
        guard state == .signedOut, !isSendingEmail else { return }
        state = .signingIn
        message = nil
        do {
            let config = try await configStore.config()
            let verifier = PKCE.makeVerifier()
            let challenge = PKCE.challenge(for: verifier) { data in Data(SHA256.hash(data: data)) }
            guard let url = GoTrue.authorizeURL(config: config, codeChallenge: challenge,
                                                redirectTo: AppConfig.authRedirect)
            else { throw AuthError.failed }
            let callback = try await authenticate(url)
            guard let parsed = parseCallback(callback) else { throw AuthError.failed }
            let code: String
            switch parsed {
            case .code(let value):
                code = value
            case .error(let value):
                throw AuthError.provider(value)
            }
            let session = try await exchange(code: code, verifier: verifier)
            persist(session)
            // Signed in another way: an email link still out has nothing to finish.
            if storedPending() != nil { dropPending() }
            emailSent = nil
            welcome = session.email ?? ""
            state = .signedIn(session)
        } catch is CancellationError {
            state = .signedOut
        } catch {
            state = .signedOut
            message = Self.googleMessage(for: error)
        }
    }

    /// POST /auth/v1/token?grant_type=pkce. Not retried: a code is good once.
    private func exchange(code: String, verifier: String) async throws -> AuthSession {
        let result = try await goTrue { config in
            GoTrue.exchangeRequest(config: config, authCode: code, codeVerifier: verifier)
        }
        guard result.isSuccess else {
            throw AuthError.exchange(status: result.status, code: GoTrue.errorCode(in: result.data))
        }
        return try AuthSession.decode(result.data, receivedAt: self.now())
    }

    // MARK: The email link

    /// "Email me a sign-in link": asks GoTrue to email a link whose code only
    /// the pending record's verifier can exchange, sent back through
    /// /auth/ios with `via=email` and the record's nonce.
    ///
    /// The record is chosen and saved BEFORE the first await, so the flow
    /// state GoTrue commits is always matched by a verifier the phone still
    /// has, and a resend to the same address reuses it (`EmailSignIn`). The
    /// result lands only if nothing moved while the request was out: still
    /// signed out, and still this send's record.
    func sendEmailLink(to typed: String) async {
        guard state == .signedOut, !isSendingEmail else { return }
        guard let email = normalizedEmail(typed) else {
            message = "That doesn't look like an email address."
            return
        }
        let previous = storedPending()
        let record = EmailSignIn.forSend(to: email, existing: previous, now: self.now())
        keepPending(record)
        isSendingEmail = true
        message = nil
        let challenge = PKCE.challenge(for: record.verifier) { data in Data(SHA256.hash(data: data)) }
        let redirect = GoTrue.emailRedirect(from: AppConfig.authRedirect, nonce: record.nonce)
        var failure: Error? = nil
        do {
            let result = try await goTrue { config in
                GoTrue.otpRequest(config: config, email: email, codeChallenge: challenge, redirectTo: redirect)
            }
            if !result.isSuccess {
                failure = AuthError.send(status: result.status, code: GoTrue.errorCode(in: result.data))
            }
        } catch {
            failure = error
        }
        isSendingEmail = false
        guard state == .signedOut, pending == record else { return }
        if let failure {
            // GoTrue refused this address outright: no email went out and no
            // flow state was stored, so an earlier sign-in to another address
            // is put back and its email still works. After any other failure
            // the new record stays, since the request may have landed.
            if let previous, !previous.matches(email: email), Self.isRefusal(failure) {
                keepPending(previous)
            }
            message = Self.sendMessage(for: failure)
        } else {
            emailSent = email
        }
    }

    /// "Use a different email": back to the address field. The record stays,
    /// so the email already sent still signs in until a send to another
    /// address replaces it.
    func useDifferentEmail() {
        guard !isSendingEmail else { return }
        emailSent = nil
        message = nil
    }

    /// `app.dsul.ios://auth/callback?code=…&n=…`, from the /auth/ios page an
    /// emailed link opens (DsulApp's `onOpenURL`).
    ///
    /// Anything that isn't the email shape, arrives signed in or mid-sign-in,
    /// or doesn't carry the pending record's nonce is dropped before it changes
    /// anything: any page or app can open this scheme. One that matches is the
    /// user's own sign-in, so it leaves the sample. A second delivery while the
    /// exchange runs meets `.signingIn` and is dropped; one after a failed
    /// exchange is tried again (the code outlives a failed exchange, and the
    /// page's "Open dsul" button sends it again).
    func handleOpenURL(_ url: URL) async {
        guard let callback = parseEmailCallback(url) else { return }
        guard state == .signedOut || state == .sample else { return }
        guard let record = storedPending(), record.nonce == callback.nonce else { return }
        guard record.isLive(now: self.now()) else {
            dropPending()
            emailSent = nil
            state = .signedOut
            message = "That link has expired. Send a new one."
            return
        }
        switch callback.result {
        case .error(let code):
            state = .signedOut
            emailSent = record.email
            message = Self.linkErrorMessage(code)
        case .code(let code):
            state = .signingIn
            message = nil
            do {
                let session = try await exchange(code: code, verifier: record.verifier)
                persist(session)
                dropPending()
                emailSent = nil
                // The server's word for who this is, never the typed address.
                welcome = session.email ?? ""
                state = .signedIn(session)
            } catch {
                // The record stays: GoTrue keeps the flow state after a failed
                // exchange, and "Send again" reuses it.
                state = .signedOut
                emailSent = record.email
                message = Self.exchangeMessage(for: error)
            }
        }
    }

    private func storedPending() -> EmailSignIn? {
        if !pendingLoaded {
            pending = tokenStore.loadPendingEmail()
            pendingLoaded = true
        }
        return pending
    }

    /// Kept in memory whatever the store says, so a locked Keychain costs a
    /// quit, not the sign-in.
    private func keepPending(_ record: EmailSignIn) {
        pending = record
        pendingLoaded = true
        try? tokenStore.savePendingEmail(record)
    }

    private func dropPending() {
        pending = nil
        pendingLoaded = true
        tokenStore.clearPendingEmail()
    }

    /// The email to show once ("Signed in as …"), after an interactive sign-in.
    func takeWelcome() -> String? {
        let email = welcome
        welcome = nil
        return email
    }

    func enterSample() {
        guard state == .signedOut, !isSendingEmail else { return }
        message = nil
        state = .sample
    }

    func leaveSample() {
        guard state == .sample else { return }
        state = .signedOut
    }

    // MARK: Tokens

    func accessToken() async throws -> String {
        return try await accessToken(rejecting: nil)
    }

    private func refreshed(from current: AuthSession) async throws -> AuthSession {
        if let running = refreshTask {
            return try await running.value
        }
        let task = Task<AuthSession, Error> { try await self.performRefresh(current) }
        refreshTask = task
        defer {
            if refreshTask == task { refreshTask = nil }
        }
        return try await task.value
    }

    /// POST /auth/v1/token?grant_type=refresh_token, retried on anything but a
    /// verdict, always with the same refresh token.
    private func performRefresh(_ current: AuthSession) async throws -> AuthSession {
        var attempt = 0
        while true {
            var result: HTTPResult? = nil
            do {
                result = try await goTrue { config in
                    GoTrue.refreshRequest(config: config, refreshToken: current.refreshToken)
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                result = nil  // offline, or the config couldn't be fetched: try again
            }
            // Signed out (or switched) while the request was out: never revive it.
            guard session?.userId == current.userId else { throw AuthError.signedOut }
            if let result {
                if result.isSuccess {
                    let fresh = try AuthSession.decode(result.data, receivedAt: self.now())
                    persist(fresh)
                    state = .signedIn(fresh)
                    return fresh
                }
                if classifyRefreshFailure(status: result.status, body: result.data) == .signedOut {
                    endSession(message: "You were signed out. Sign in again to see your day.")
                    throw AuthError.signedOut
                }
            }
            if attempt >= Self.refreshRetryDelays.count { throw AuthError.unavailable }
            try await self.sleep(Self.refreshRetryDelays[attempt])
            attempt += 1
        }
    }

    private func persist(_ session: AuthSession) {
        do {
            try tokenStore.save(session)
            unsaved = nil
        } catch {
            unsaved = session
        }
    }

    private func retryUnsavedSave() {
        guard let pending = unsaved else { return }
        guard session?.userId == pending.userId else {
            unsaved = nil
            return
        }
        persist(pending)
    }

    // MARK: Signing out

    /// Ends this phone's session only. The wipe comes first, so a failed or
    /// slow call can't leave the app signed in.
    func signOut() async {
        guard let ending = session else {
            leaveSample()
            return
        }
        refreshTask?.cancel()
        refreshTask = nil
        endSession(message: nil)
        _ = try? await goTrue { config in
            GoTrue.logoutRequest(config: config, accessToken: ending.accessToken)
        }
    }

    private func endSession(message: String?) {
        tokenStore.clear()
        unsaved = nil
        welcome = nil
        emailSent = nil
        state = .signedOut
        self.message = message
    }

    // MARK: GoTrue

    /// Sends one GoTrue request built from the config. If the gateway refuses
    /// the cached anon key (rotated since), the config is fetched again and the
    /// request rebuilt and sent once more.
    private func goTrue(_ build: (GoTrueConfig) -> URLRequest?) async throws -> HTTPResult {
        let config = try await configStore.config()
        guard let request = build(config) else { throw AuthError.failed }
        let result = try await self.transport(request)
        guard SupabaseConfigStore.isAPIKeyRejected(result) else { return result }
        let fresh = try await configStore.reload()
        guard let retry = build(fresh) else { throw AuthError.failed }
        return try await self.transport(retry)
    }

    /// A send GoTrue refused for the address itself (a 4xx other than "too
    /// soon"), before it stored anything.
    private static func isRefusal(_ error: Error) -> Bool {
        guard let authError = error as? AuthError, case .send(let status, _) = authError else { return false }
        return (400..<500).contains(status) && status != 429
    }

    // MARK: Copy

    private static func isOffline(_ error: Error) -> Bool {
        return error is URLError || (error as? AuthError) == .unavailable
    }

    /// Google's sign-in. A refused exchange reads as it always has.
    static func googleMessage(for error: Error) -> String {
        if let authError = error as? AuthError, case .provider(let code) = authError {
            if code == "access_denied" { return "Google sign-in was cancelled." }
            return "Google couldn't sign you in (\(code)). Try again."
        }
        if isOffline(error) {
            return "Couldn't reach dsul. Check your connection and try again."
        }
        return "Couldn't sign in. Try again."
    }

    /// A send that didn't go. GoTrue answers both its 60-second resend limit
    /// and the project's hourly email cap with over_email_send_rate_limit, so
    /// the copy promises neither wait.
    static func sendMessage(for error: Error) -> String {
        if let authError = error as? AuthError, case .send(let status, let code) = authError {
            switch code ?? "" {
            case "over_email_send_rate_limit", "over_request_rate_limit":
                return "Too many sign-in emails just now. Try again in a few minutes."
            case "validation_failed", "email_address_invalid":
                return "That doesn't look like an email address."
            case "email_address_not_authorized":
                return "dsul can't email that address yet."
            case "otp_disabled", "signup_disabled", "email_provider_disabled":
                return "That address can't sign in by email."
            default:
                if status == 429 { return "Too many sign-in emails just now. Try again in a few minutes." }
                return "Couldn't send the link. Try again."
            }
        }
        if isOffline(error) {
            return "Couldn't send the link. Check your connection and try again."
        }
        return "Couldn't send the link. Try again."
    }

    /// An error GoTrue's /verify put on the link. The commonest after "Send
    /// again" is the older email tapped: a resend replaces its token.
    static func linkErrorMessage(_ code: String) -> String {
        switch code {
        case "otp_expired", "access_denied":
            return "That link was replaced or already used. Open the newest email from dsul, or send a new link."
        default:
            return "Couldn't sign in with that link. Send a new one."
        }
    }

    /// An exchange of an emailed code that failed. flow_state_expired is
    /// mostly a first-time address: its code lasts 5 minutes from the SEND,
    /// and the next link goes the quicker way, since the address is confirmed
    /// by then. A failure with no verdict leaves the code good for a while, so
    /// it points back at the page's button rather than a new email.
    static func exchangeMessage(for error: Error) -> String {
        if let authError = error as? AuthError, case .exchange(let status, let code) = authError {
            switch code ?? "" {
            case "flow_state_expired":
                return "Almost there. Send one more link and it will sign you straight in."
            case "flow_state_not_found", "bad_code_verifier":
                return "That link was for a different sign-in. Send a new one from this iPhone."
            default:
                if status >= 500 || status == 429 {
                    return "Couldn't finish signing in. Go back and tap Open dsul to try again."
                }
                return "Couldn't sign in with that link. Send a new one."
            }
        }
        if isOffline(error) {
            return "Couldn't reach dsul. Check your connection, then go back and tap Open dsul."
        }
        return "Couldn't sign in with that link. Send a new one."
    }
}

extension AuthStore: AccessTokenSource {
    func accessToken(rejecting rejected: String?) async throws -> String {
        retryUnsavedSave()
        guard let current = session else { throw AuthError.signedOut }
        let wasRejected = rejected != nil && rejected == current.accessToken
        if !wasRejected && !current.needsRefresh(now: self.now()) { return current.accessToken }
        return try await refreshed(from: current).accessToken
    }
}
