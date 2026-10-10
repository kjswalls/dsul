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

/// What SignInWithAppleButton's completion came to, without AuthenticationServices.
enum AppleSignInOutcome: Sendable, Equatable {
    case credential(AppleCredential)
    /// ASAuthorizationError.canceled: silent.
    case cancelled
    /// Any other error, or a credential that isn't an Apple ID one.
    case failed
}

/// ASAuthorizationAppleIDProvider.CredentialState, plus a failed ask.
enum AppleIDCredentialState: Sendable, Equatable {
    case authorized, revoked, notFound, transferred, unknown
}

/// What `deleteAccount` came to. `failed` carries the line the sheet shows;
/// the session is untouched.
enum AccountDeletionOutcome: Sendable, Equatable {
    /// The account is gone: the session is over and `message` says so, and
    /// AppGate has moved on.
    case deleted(AppleRevocation)
    case failed(String)
    /// The session ended under the call; nothing to show.
    case signedOut
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
/// - Apple, through Apple's own sheet (SignInWithAppleButton) and GoTrue's
///   id_token grant, with no redirect. `beginAppleSignIn` makes a nonce for
///   one attempt, held in memory only, and gives Apple's request its hash;
///   `finishAppleSignIn` takes it back first, whatever happened, and sends
///   the RAW nonce with Apple's identity token (token_oidc.go IdTokenGrant).
///   Apple gives the name once, on the first consent, and it is written to
///   the account (`PUT /auth/v1/user`) only when the account has none. The
///   session keeps the Apple user id it signed in with, and
///   `checkAppleCredential` signs this phone out when Apple says that id was
///   revoked or isn't the phone's Apple Account any more
///   (memory/plans/ios-app.md, "Sign in with Apple").
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
/// - Delete account is two calls to dsul's own server, which deletes through
///   GoTrue's admin API (memory/plans/account-deletion.md): `accountFacts` for
///   what the sheet says, then `deleteAccount`, answered once the account and
///   everything in it are gone. The server's secret key and the Apple key stay
///   on the server; the phone sends at most Apple's one-time code. A deletion
///   ends this phone's session the way a sign-out does, but with no logout
///   call (the user and its sessions are gone with it), and only while the
///   session is still the one that asked.
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
    /// True from `beginAppleSignIn` until the attempt signs in, fails or is
    /// cancelled. It goes false in the same step as the state leaves
    /// `.signingIn`, before the name write, never later.
    private(set) var isSigningInWithApple = false
    /// The raw nonce of the Apple attempt under way: never saved, never
    /// logged, and cleared before anything else when the attempt ends.
    @ObservationIgnored private var appleNonce: String? = nil
    /// Asks Apple about an Apple ID (`AppleAuthorization` in the app); nil
    /// asks nothing.
    private let appleCredentialState: (@Sendable (String) async -> AppleIDCredentialState)?
    /// Where Delete account's two routes are: the web app, as for the planner.
    private let apiOrigin: URL
    /// This install's registry id (DeviceIdentity): released at sign-out,
    /// and sent on Delete account's writes. Nil releases nothing.
    private let deviceId: String?

    /// The waits between refresh attempts that failed for want of a server:
    /// three tries within about three seconds, well inside the reuse window.
    static let refreshRetryDelays: [Duration] = [.seconds(1), .seconds(2)]

    init(tokenStore: any TokenStore, configStore: SupabaseConfigStore, transport: @escaping Transport,
         now: @escaping @Sendable () -> Date = { Date() },
         sleep: @escaping @Sendable (Duration) async throws -> Void = { duration in try await Task.sleep(for: duration) },
         appleCredentialState: (@Sendable (String) async -> AppleIDCredentialState)? = nil,
         apiOrigin: URL = AppConfig.apiOrigin, deviceId: String? = nil) {
        self.tokenStore = tokenStore
        self.configStore = configStore
        self.transport = transport
        self.now = now
        self.sleep = sleep
        self.appleCredentialState = appleCredentialState
        self.apiOrigin = apiOrigin
        self.deviceId = deviceId
        if let saved = tokenStore.load() {
            state = .signedIn(saved)
        } else {
            state = .signedOut
        }
    }

    /// The app's store: the Keychain, the production origin (or a Debug
    /// override), URLSession and Apple's credential state. As a test host the
    /// app keeps tokens in memory, so the hosted tests never read a Keychain a
    /// developer signed in to on the same simulator.
    static func makeLive() -> AuthStore {
        let defaults = UserDefaults.standard
        let store: any TokenStore
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil {
            store = InMemoryTokenStore()
        } else {
            store = KeychainTokenStore(defaults: defaults, keychain: SystemKeychain())
        }
        let origin = AppConfig.apiOrigin
        let config = SupabaseConfigStore(origin: origin, defaults: defaults, transport: HTTP.live)
        return AuthStore(tokenStore: store, configStore: config, transport: HTTP.live,
                         appleCredentialState: { await AppleAuthorization.credentialState(forUserID: $0) },
                         apiOrigin: origin, deviceId: DeviceIdentity.id(defaults))
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

    // MARK: Sign in with Apple

    /// SignInWithAppleButton's onRequest: starts an attempt (a fresh nonce, state
    /// .signingIn, message cleared) and returns the hash Apple's request carries.
    /// Nil, and nothing changes, unless signed out with no send under way.
    ///
    /// The hash is the lowercase hex SHA-256 GoTrue computes from the raw nonce
    /// it is sent (token_oidc.go), so the token's claim matches it.
    func beginAppleSignIn() -> String? {
        guard state == .signedOut, !isSendingEmail else { return nil }
        let raw = AppleSignIn.makeNonce()
        appleNonce = raw
        isSigningInWithApple = true
        state = .signingIn
        message = nil
        return AppleSignIn.hashedNonce(raw) { data in Data(SHA256.hash(data: data)) }
    }

    /// SignInWithAppleButton's onCompletion: ends the attempt (its nonce is cleared
    /// first, whatever happens), and on a credential runs the id_token grant with
    /// the raw nonce. Dropped when no attempt is under way.
    ///
    /// A completion can't say which request it answers, so one that meets no
    /// attempt (none begun, or the last already ended) is dropped, and a nonce
    /// goes to at most one grant. Nothing is retried: a tap is a new attempt
    /// with a new nonce. `isSigningInWithApple` goes false in the same step as
    /// the state leaves `.signingIn` on every path, so a slow name write can't
    /// hold "Signing in…" up after a sign-out, or end a later attempt's flag.
    func finishAppleSignIn(_ outcome: AppleSignInOutcome) async {
        guard let raw = appleNonce, state == .signingIn else { return }
        appleNonce = nil
        let credential: AppleCredential
        switch outcome {
        case .cancelled:
            isSigningInWithApple = false
            state = .signedOut
            return
        case .failed:
            isSigningInWithApple = false
            state = .signedOut
            message = Self.appleFailedMessage
            return
        case .credential(let value):
            credential = value
        }
        // No token, nothing to send: not even the config is asked for.
        guard let idToken = credential.identityToken, !idToken.isEmpty else {
            isSigningInWithApple = false
            state = .signedOut
            message = Self.appleFailedMessage
            return
        }
        let signedIn: AuthSession
        let tokenBody: Data
        do {
            let result = try await goTrue { config in
                GoTrue.idTokenRequest(config: config, idToken: idToken, nonce: raw)
            }
            guard result.isSuccess else {
                throw AuthError.exchange(status: result.status, code: GoTrue.errorCode(in: result.data))
            }
            var decoded = try AuthSession.decode(result.data, receivedAt: self.now())
            decoded.appleUserId = credential.user
            signedIn = decoded
            tokenBody = result.data
        } catch {
            isSigningInWithApple = false
            state = .signedOut
            message = Self.appleMessage(for: error)
            return
        }
        persist(signedIn)
        // Signed in another way: an email link still out has nothing to finish.
        if storedPending() != nil { dropPending() }
        emailSent = nil
        welcome = signedIn.email ?? ""
        isSigningInWithApple = false
        state = .signedIn(signedIn)

        // Apple gives the name only on a first consent and never in the token,
        // so it is saved to the account now or never: GoTrue's own keys
        // (provider_apple.go ParseUser), and only when the account has no name
        // (a Google one, or one the web flow stored, stays). One try, nothing
        // said either way.
        guard let name = AppleSignIn.fullName(given: credential.givenName, family: credential.familyName),
              GoTrue.displayName(in: tokenBody) == nil
        else { return }
        _ = try? await goTrue { config in
            GoTrue.userNameRequest(config: config, accessToken: signedIn.accessToken, fullName: name)
        }
    }

    /// Asks Apple about the session's Apple ID and signs out on revoked or notFound.
    /// Nothing without a session or an appleUserId, or without the closure.
    ///
    /// `revoked` is Apple's "should be signed out"; `notFound` is how Apple says
    /// the phone's Apple Account changed ("Verifying a user"), and its sample
    /// signs out on both. An answer that comes back after the session changed
    /// moves nothing. Apple's call is local and cheap, so the app asks at
    /// launch, on every return to the front and on Apple's revoked notification
    /// (AppGate). Google and email-link sessions have no Apple ID and are never
    /// asked about.
    func checkAppleCredential() async {
        guard let check = appleCredentialState, let asked = session, let appleID = asked.appleUserId else { return }
        let answer = await check(appleID)
        guard answer == .revoked || answer == .notFound,
              session?.userId == asked.userId, session?.appleUserId == appleID
        else { return }
        await signOut(message: "You were signed out. Sign in again to see your day.")
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
                    var fresh = try AuthSession.decode(result.data, receivedAt: self.now())
                    // A refresh answers with the user, not how they signed in.
                    fresh.appleUserId = current.appleUserId
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
    /// slow call can't leave the app signed in. `message` is what the sign-in
    /// screen then says (nil for the user's own Sign out). Then this iPhone's
    /// row in the device registry is released with the ending token, before
    /// the GoTrue logout ends it; offline, the row stays, and as it is never
    /// sent anything it waits harmlessly for the 180-day prune.
    func signOut(message: String? = nil) async {
        guard let ending = session else {
            leaveSample()
            return
        }
        refreshTask?.cancel()
        refreshTask = nil
        endSession(message: message)
        if let deviceId {
            let api = APIClient(origin: apiOrigin, tokens: EndingSessionToken(ending.accessToken),
                                transport: transport)
            try? await api.releaseDevice(deviceId)
        }
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

    // MARK: Deleting the account

    /// GET /api/app/account: what the Delete account sheet says. Nil on any
    /// failure. A 410 `gone` (an earlier call deleted the account and its
    /// answer was lost) also ends the session, if still signed in as the user
    /// who asked, with `AccountDeletion.deletedMessage` and no logout call,
    /// exactly as a deletion does; AppGate drops the sheet.
    func accountFacts() async -> AccountFacts? {
        guard let asking = session else { return nil }
        do {
            return try await accountAPI().accountFacts()
        } catch APIError.rejected(status: 410, code: "gone"?) {
            endDeletedSession(asked: asking, message: AccountDeletion.deletedMessage)
            return nil
        } catch {
            return nil
        }
    }

    /// The first of `facts.appleIds` this phone's Apple Account can authorize
    /// (`.authorized`), only when `facts.appleRevocable`; nil with no
    /// credential-state closure. Local and cheap ("Verifying a user"), so the
    /// sheet asks when it opens and again just before Apple's request: a retry
    /// may follow a deletion that already revoked the id, and a request for a
    /// revoked id would ask Apple for a new first consent that nothing then
    /// revokes.
    func deletionAppleUserId(for facts: AccountFacts) async -> String? {
        guard facts.appleRevocable, let check = appleCredentialState else { return nil }
        for appleID in facts.appleIds {
            if await check(appleID) == .authorized { return appleID }
        }
        return nil
    }

    /// POST /api/app/account/delete with `account`, the facts' `userId`: a
    /// guard the server checks against the caller, never a target. Any 2xx is
    /// a deletion. If still signed in as the user who asked, any refresh is
    /// cancelled, the pending email record dropped and the session ended with
    /// the done line (`AccountDeletion.doneMessage`), with no logout call; if
    /// already signed out, only `message` becomes the done line; if someone
    /// else is signed in by then, nothing changes. A failure leaves the session
    /// as it was.
    ///
    /// A refresh still out when the session ends finds it gone and changes
    /// nothing (`performRefresh`). Apple's revoked notification may sign the
    /// phone out first (`checkAppleCredential`); the 200 then only sets the
    /// line.
    func deleteAccount(account: String, appleCode: String?, hadApple: Bool) async -> AccountDeletionOutcome {
        guard let asking = session else { return .signedOut }
        do {
            let answer = try await accountAPI().deleteAccount(account: account, appleCode: appleCode)
            endDeletedSession(asked: asking,
                              message: AccountDeletion.doneMessage(apple: answer.apple, hadApple: hadApple))
            return .deleted(answer.apple)
        } catch APIError.signedOut {
            return .signedOut
        } catch APIError.unavailable {
            return .failed(AccountDeletion.unreachableMessage)
        } catch APIError.rejected(status: 409, code: _) {
            return .failed(AccountDeletion.changedMessage)
        } catch is CancellationError {
            return .failed(AccountDeletion.unreachableMessage)
        } catch {
            return .failed(AccountDeletion.failedMessage)
        }
    }

    /// The end of a session whose account is gone: the user and its sessions
    /// went with it, so there is no logout call to make (it would answer 403).
    /// Only the session that asked is ended; one that already ended takes the
    /// line, and someone else's is never touched.
    private func endDeletedSession(asked: AuthSession, message: String) {
        switch state {
        case .signedIn(let current) where current.userId == asked.userId:
            refreshTask?.cancel()
            refreshTask = nil
            dropPending()
            endSession(message: message)
        case .signedOut:
            self.message = message
        case .signedIn, .signingIn, .sample:
            break
        }
    }

    /// Delete account's own client: never the planner's, since the deletion
    /// drops the planner.
    private func accountAPI() -> APIClient {
        return APIClient(origin: apiOrigin, tokens: self, transport: transport, deviceId: deviceId)
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

    /// Apple's sheet failed, or handed back no identity token. No code: Apple's
    /// are numbers.
    static let appleFailedMessage = "Apple couldn't sign you in. Try again."

    /// A grant that didn't sign in. GoTrue's audience, nonce and bad-token
    /// refusals are OAuth errors with no code (token_oidc.go), so only the
    /// provider being off has words of its own.
    static func appleMessage(for error: Error) -> String {
        if let authError = error as? AuthError, case .exchange(_, let code) = authError,
           code == "provider_disabled" {
            return "Sign in with Apple isn't available right now. Use Google or an email link."
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
