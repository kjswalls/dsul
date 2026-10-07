import AuthenticationServices
import CryptoKit
import DsulCore
import Foundation
import Testing
@testable import Dsul

/// GoTrue's id_token grant and user routes, and what Apple's sheet hands back
/// on a first consent.
enum AppleJSON {
    static let grantRoute = "POST /auth/v1/token?grant_type=id_token"
    static let userRoute = "PUT /auth/v1/user"

    /// Apple's identity token: the phone never reads it, only passes it on.
    static let identityToken = "apple-identity-token"

    /// A first consent: the name is there.
    static let credential = AppleCredential(user: "001234.dsul.0001", identityToken: identityToken,
                                            givenName: "Kirby", familyName: "Fox")

    /// AuthJSON.token, with the account's name in user_metadata when it has one.
    static func token(access: String, refresh: String, expiresIn: Int = 3600,
                      email: String = "kirby@example.com", fullName: String? = nil) -> String {
        let metadata = fullName.map { ",\"user_metadata\":{\"full_name\":\"\($0)\"}" } ?? ""
        return "{\"access_token\":\"\(access)\",\"token_type\":\"bearer\",\"expires_in\":\(expiresIn),"
            + "\"expires_at\":0,\"refresh_token\":\"\(refresh)\","
            + "\"user\":{\"id\":\"\(lowerID(testUserID))\",\"email\":\"\(email)\"\(metadata)}}"
    }
}

/// Apple's credential state, faked: every id asked about, in order, answered
/// from a queue (the last answer repeats), and held while `hold` is on.
actor FakeAppleCredentialState {
    private var answers: [AppleIDCredentialState]
    private var held = false
    private(set) var asked: [String] = []

    init(_ answers: AppleIDCredentialState...) {
        self.answers = answers
    }

    func hold() {
        held = true
    }

    func release() {
        held = false
    }

    func state(forUserID userID: String) async -> AppleIDCredentialState {
        asked.append(userID)
        var waited = 0
        while held && waited < 2000 {
            try? await Task.sleep(for: .milliseconds(5))
            waited += 1
        }
        guard let answer = answers.first else { return .unknown }
        if answers.count > 1 { answers.removeFirst() }
        return answer
    }
}

/// A grant that doesn't sign in, and the line it leaves.
struct AppleGrantRefusal: Sendable, CustomTestStringConvertible {
    let testDescription: String
    var config: FakeServer.Reply = .status(200, AuthJSON.config)
    let grant: FakeServer.Reply
    let message: String
}

/// A sign-in after which no name is written.
struct AppleKeptName: Sendable, CustomTestStringConvertible {
    let testDescription: String
    /// The account's name in the grant's answer, if it has one.
    let accountName: String?
    let credential: AppleCredential
}

private let providerDisabled = #"{"code":"provider_disabled","message":"Provider (issuer \"https://appleid.apple.com\") is not enabled"}"#
private let providerOffLine = "Sign in with Apple isn't available right now. Use Google or an email link."
private let offlineLine = "Couldn't reach dsul. Check your connection and try again."
private let refusedLine = "Couldn't sign in. Try again."
private let revokedLine = "You were signed out. Sign in again to see your day."

/// The emailed link's hand-back for `nonce`, as the /auth/ios page writes it.
private func emailCallback(nonce: String) -> URL {
    return URL(string: "app.dsul.ios://auth/callback?code=code-1234&n=\(nonce)")!
}

/// Sign in with Apple through AuthStore, with Apple's sheet stood in for by
/// `finishAppleSignIn`'s outcome: the nonce, the id_token grant, the name
/// write, the welcome, the error lines, and the credential check that signs
/// this phone out when Apple says the Apple ID was revoked or changed
/// (memory/plans/ios-app.md, "Sign in with Apple").
@MainActor
@Suite struct AppleSignInTests {
    /// An AuthStore on `server`, with its own empty defaults, no waiting
    /// between refresh retries, and Apple's answers from `credentialState`
    /// (none: nothing to ask).
    private func makeAuth(_ server: FakeServer, store: InMemoryTokenStore,
                          credentialState: FakeAppleCredentialState? = nil) -> AuthStore {
        let defaults = UserDefaults(suiteName: "dsul-tests-" + UUID().uuidString)!
        let config = SupabaseConfigStore(origin: URL(string: "https://dsul.test")!, defaults: defaults,
                                         transport: server.transport)
        var check: (@Sendable (String) async -> AppleIDCredentialState)? = nil
        if let credentialState {
            check = { userID in await credentialState.state(forUserID: userID) }
        }
        let auth = AuthStore(tokenStore: store, configStore: config, transport: server.transport,
                             sleep: { _ in }, appleCredentialState: check)
        store.observedAuth = auth
        return auth
    }

    /// Google, faked: the sheet comes straight back with a code.
    private func signInWithGoogle(_ auth: AuthStore) async {
        await auth.signInWithGoogle { _ in AuthJSON.callback }
    }

    /// A tap, and Apple's sheet answering with `credential`.
    private func signInWithApple(_ auth: AuthStore, _ credential: AppleCredential = AppleJSON.credential) async {
        _ = auth.beginAppleSignIn()
        await auth.finishAppleSignIn(.credential(credential))
    }

    /// The config, a grant that answers `a1`/`r1` (for an account with
    /// `fullName`, or none), and a name write that goes.
    private func serverForApple(expiresIn: Int = 3600, fullName: String? = nil) async -> FakeServer {
        let server = FakeServer()
        await server.on(AuthJSON.configRoute, .status(200, AuthJSON.config))
        await server.on(AppleJSON.grantRoute,
                        .status(200, AppleJSON.token(access: "a1", refresh: "r1", expiresIn: expiresIn,
                                                     fullName: fullName)))
        await server.on(AppleJSON.userRoute, .status(200, "{}"))
        return server
    }

    private func grants(_ server: FakeServer) async -> [FakeServer.Request] {
        let all = await server.requests
        return all.filter { $0.route == AppleJSON.grantRoute }
    }

    private func logouts(_ server: FakeServer) async -> [FakeServer.Request] {
        let all = await server.requests
        return all.filter { $0.route.hasPrefix("POST /auth/v1/logout") }
    }

    /// The lowercase hex SHA-256 of `raw`, worked out here rather than by
    /// DsulCore: what GoTrue compares with the token's claim.
    private func sha256Hex(_ raw: String) -> String {
        return SHA256.hash(data: Data(raw.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: The attempt

    @Test func anAttemptCarriesTheHashOfAFreshNonce() async throws {
        let server = await serverForApple()
        let auth = makeAuth(server, store: InMemoryTokenStore())

        let hash = try #require(auth.beginAppleSignIn())

        #expect(hash.count == 64)
        #expect(hash.allSatisfy { "0123456789abcdef".contains($0) })
        #expect(auth.state == .signingIn)
        #expect(auth.isSigningInWithApple)
        #expect(auth.message == nil)
        // One attempt at a time.
        #expect(auth.beginAppleSignIn() == nil)
        #expect(auth.isSigningInWithApple)
        // Apple's sheet is up; nothing has been asked of the server yet.
        let requests = await server.requests
        #expect(requests.isEmpty)
    }

    @Test func aCredentialSignsInWithTheRawNonce() async throws {
        let server = await serverForApple()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)

        let hash = try #require(auth.beginAppleSignIn())
        await auth.finishAppleSignIn(.credential(AppleJSON.credential))

        #expect(auth.isSignedIn)
        #expect(!auth.isSigningInWithApple)
        #expect(auth.message == nil)
        #expect(auth.email == "kirby@example.com")
        #expect(auth.gateKey == "user:" + testUserID.uuidString)
        #expect(store.stateAtSave == [.signingIn])
        #expect(store.session?.accessToken == "a1")
        #expect(store.session?.appleUserId == "001234.dsul.0001")
        #expect(auth.session?.appleUserId == "001234.dsul.0001")
        #expect(auth.takeWelcome() == "kirby@example.com")
        #expect(auth.takeWelcome() == nil)

        // The grant carried Apple's token and the RAW nonce, whose hash is
        // what Apple's request carried.
        let sent = await grants(server)
        #expect(sent.count == 1)
        let grant = sent.first
        let body = bodyJSON(grant)
        #expect(body?["provider"] as? String == "apple")
        #expect(body?["id_token"] as? String == AppleJSON.identityToken)
        let raw = try #require(body?["nonce"] as? String)
        #expect(raw.count == 43)
        #expect(sha256Hex(raw) == hash)
        #expect(body?.count == 3)
        #expect(grant?.headers["apikey"] == "anon-key")
        #expect(grant?.headers["x-supabase-api-version"] == "2024-01-01")
        #expect(grant?.headers["authorization"] == nil)
    }

    @Test func everyAttemptHasItsOwnNonce() async throws {
        let server = await serverForApple()
        let auth = makeAuth(server, store: InMemoryTokenStore())

        let first = try #require(auth.beginAppleSignIn())
        await auth.finishAppleSignIn(.cancelled)
        let second = try #require(auth.beginAppleSignIn())
        #expect(second != first)

        await auth.finishAppleSignIn(.credential(AppleJSON.credential))

        #expect(auth.isSignedIn)
        let sent = await grants(server)
        #expect(sent.count == 1)
        let raw = try #require(bodyJSON(sent.first)?["nonce"] as? String)
        #expect(sha256Hex(raw) == second)
    }

    @Test func aCancelIsSilentAndAsksNothing() async {
        let server = await serverForApple()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)

        _ = auth.beginAppleSignIn()
        await auth.finishAppleSignIn(.cancelled)

        #expect(auth.state == .signedOut)
        #expect(auth.message == nil)
        #expect(!auth.isSigningInWithApple)
        #expect(store.session == nil)
        let requests = await server.requests
        #expect(requests.isEmpty)
    }

    @Test(arguments: [
        AppleSignInOutcome.failed,
        .credential(AppleCredential(user: "001234.dsul.0001", identityToken: nil)),
        .credential(AppleCredential(user: "001234.dsul.0001", identityToken: "")),
    ])
    func anAppleFailureSaysSoAndAsksNothing(_ outcome: AppleSignInOutcome) async {
        let server = await serverForApple()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)

        _ = auth.beginAppleSignIn()
        await auth.finishAppleSignIn(outcome)

        #expect(auth.state == .signedOut)
        #expect(auth.message == AuthStore.appleFailedMessage)
        #expect(auth.message == "Apple couldn't sign you in. Try again.")
        #expect(!auth.isSigningInWithApple)
        #expect(store.session == nil)
        let requests = await server.requests
        #expect(requests.isEmpty)
        // The next tap starts clean.
        #expect(auth.beginAppleSignIn() != nil)
        #expect(auth.message == nil)
    }

    @Test func aCompletionWithNoAttemptIsDropped() async {
        let server = await serverForApple()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await auth.sendEmailLink(to: "me@")   // a line on the screen, and no request
        let shown = auth.message
        #expect(shown != nil)

        await auth.finishAppleSignIn(.credential(AppleJSON.credential))

        #expect(auth.state == .signedOut)
        #expect(auth.message == shown)
        #expect(!auth.isSigningInWithApple)
        #expect(store.session == nil)
        let requests = await server.requests
        #expect(requests.isEmpty)
    }

    @Test(arguments: [
        AppleGrantRefusal(testDescription: "provider off", grant: .status(400, providerDisabled), message: providerOffLine),
        AppleGrantRefusal(testDescription: "audience",
                          grant: .status(400, #"{"error":"invalid request","error_description":"Unacceptable audience in id_token: [app.dsul.ios]"}"#),
                          message: refusedLine),
        AppleGrantRefusal(testDescription: "nonce",
                          grant: .status(400, #"{"error":"invalid nonce","error_description":"Nonces mismatch"}"#),
                          message: refusedLine),
        AppleGrantRefusal(testDescription: "5xx", grant: .status(500, "{}"), message: refusedLine),
        AppleGrantRefusal(testDescription: "offline", grant: .offline, message: offlineLine),
        AppleGrantRefusal(testDescription: "no config", config: .status(503, "{}"),
                          grant: .status(200, AppleJSON.token(access: "a1", refresh: "r1")), message: offlineLine),
    ])
    func eachGrantRefusalSaysWhatHappened(_ refusal: AppleGrantRefusal) async {
        let server = FakeServer()
        await server.on(AuthJSON.configRoute, refusal.config)
        await server.on(AppleJSON.grantRoute, refusal.grant)
        await server.on(AppleJSON.userRoute, .status(200, "{}"))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)

        await signInWithApple(auth)

        #expect(auth.state == .signedOut)
        #expect(auth.message == refusal.message)
        #expect(!auth.isSigningInWithApple)
        #expect(store.session == nil)
        #expect(auth.takeWelcome() == nil)
        let names = await server.count(AppleJSON.userRoute)
        #expect(names == 0)
    }

    // MARK: The name

    @Test func theNameIsWrittenOnceWhenTheAccountHasNone() async {
        let server = await serverForApple()
        await server.close(AppleJSON.userRoute)
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)

        #expect(auth.beginAppleSignIn() != nil)
        let finishing = Task { await auth.finishAppleSignIn(.credential(AppleJSON.credential)) }

        // Signed in, with the flag already down, while the name write is held.
        #expect(await waitUntil { auth.isSignedIn })
        #expect(!auth.isSigningInWithApple)
        #expect(await waitUntil { await server.count(AppleJSON.userRoute) == 1 })

        // A sign-out meanwhile: the slow write never puts "Signing in…" back.
        await auth.signOut()
        #expect(!auth.isSigningInWithApple)
        #expect(auth.message == nil)

        await server.open(AppleJSON.userRoute)
        await finishing.value
        #expect(!auth.isSigningInWithApple)
        #expect(auth.state == .signedOut)

        let requests = await server.requests
        let writes = requests.filter { $0.route == AppleJSON.userRoute }
        #expect(writes.count == 1)
        let write = writes.first
        #expect(write?.headers["authorization"] == "Bearer a1")
        #expect(write?.headers["apikey"] == "anon-key")
        let body = bodyJSON(write)
        let data = body?["data"] as? [String: Any]
        #expect(body?.count == 1)
        #expect(data?.count == 2)
        #expect(data?["full_name"] as? String == "Kirby Fox")
        #expect(data?["name"] as? String == "Kirby Fox")
    }

    @Test(arguments: [
        AppleKeptName(testDescription: "the account has one", accountName: "Kirby F.",
                      credential: AppleJSON.credential),
        AppleKeptName(testDescription: "Apple gave none", accountName: nil,
                      credential: AppleCredential(user: "001234.dsul.0001", identityToken: AppleJSON.identityToken)),
    ])
    func aNameTheAccountHasIsKept(_ kept: AppleKeptName) async {
        let server = await serverForApple(fullName: kept.accountName)
        let auth = makeAuth(server, store: InMemoryTokenStore())

        await signInWithApple(auth, kept.credential)

        #expect(auth.isSignedIn)
        let names = await server.count(AppleJSON.userRoute)
        #expect(names == 0)
    }

    @Test(arguments: [FakeServer.Reply.status(500, "{}"), .offline])
    func aNameThatDoesNotSaveChangesNothingElse(_ reply: FakeServer.Reply) async {
        let server = await serverForApple()
        await server.on(AppleJSON.userRoute, reply)
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)

        await signInWithApple(auth)

        #expect(auth.isSignedIn)
        #expect(auth.message == nil)
        #expect(!auth.isSigningInWithApple)
        #expect(store.session?.accessToken == "a1")
        #expect(auth.takeWelcome() == "kirby@example.com")
        // Tried once, never again.
        let names = await server.count(AppleJSON.userRoute)
        #expect(names == 1)
    }

    // MARK: Beside the email link

    @Test func appleEndsAnEmailSignInSoItsLinkMovesNothingLater() async throws {
        let server = await serverForApple()
        await server.on(EmailJSON.otpRoute, .status(200, "{}"))
        await server.on(AuthJSON.exchangeRoute, .status(200, AuthJSON.token(access: "a2", refresh: "r2")))
        await server.on(AuthJSON.logoutRoute, .status(204, ""))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await auth.sendEmailLink(to: EmailJSON.address)
        let record = try #require(store.pendingEmail)

        await signInWithApple(auth)

        #expect(auth.isSignedIn)
        #expect(store.pendingEmail == nil)
        #expect(auth.emailSent == nil)

        await auth.signOut()
        // The email's link has nothing left to finish.
        await auth.handleOpenURL(emailCallback(nonce: record.nonce))
        #expect(auth.state == .signedOut)
        #expect(auth.message == nil)
        let exchanges = await server.count(AuthJSON.exchangeRoute)
        #expect(exchanges == 0)
    }

    @Test func appleWaitsForAnEmailSend() async {
        let server = await serverForApple()
        await server.on(EmailJSON.otpRoute, .status(200, "{}"))
        await server.close(EmailJSON.otpRoute)
        let auth = makeAuth(server, store: InMemoryTokenStore())

        let sending = Task { await auth.sendEmailLink(to: EmailJSON.address) }
        #expect(await waitUntil { auth.isSendingEmail })

        #expect(auth.beginAppleSignIn() == nil)
        #expect(auth.state == .signedOut)
        #expect(auth.message == nil)
        #expect(!auth.isSigningInWithApple)

        await server.open(EmailJSON.otpRoute)
        await sending.value
        #expect(auth.emailSent == EmailJSON.address)
        let sent = await grants(server)
        #expect(sent.isEmpty)
    }

    // MARK: The session

    @Test func aRefreshKeepsTheAppleUserId() async throws {
        let server = await serverForApple(expiresIn: 30)   // inside the leeway: due now
        await server.on(AuthJSON.refreshRoute, .status(200, AuthJSON.token(access: "a2", refresh: "r2")))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await signInWithApple(auth)

        let token = try await auth.accessToken()

        #expect(token == "a2")
        let refreshes = await server.count(AuthJSON.refreshRoute)
        #expect(refreshes == 1)
        #expect(store.session?.refreshToken == "r2")
        // Both: the Keychain's for the next launch, memory's for the check.
        #expect(store.session?.appleUserId == "001234.dsul.0001")
        #expect(auth.session?.appleUserId == "001234.dsul.0001")
    }

    // MARK: Credential state

    @Test(arguments: [AppleIDCredentialState.revoked, .notFound])
    func aRevokedOrChangedAppleIDSignsThisPhoneOut(_ answer: AppleIDCredentialState) async {
        let apple = FakeAppleCredentialState(answer)
        let server = await serverForApple()
        await server.on(AuthJSON.logoutRoute, .status(204, ""))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store, credentialState: apple)
        await signInWithApple(auth)
        #expect(auth.isSignedIn)

        await auth.checkAppleCredential()

        let asked = await apple.asked
        #expect(asked == ["001234.dsul.0001"])
        #expect(auth.state == .signedOut)
        #expect(store.session == nil)
        #expect(auth.message == revokedLine)
        // This phone only, as the user's own Sign out.
        let ended = await logouts(server)
        #expect(ended.count == 1)
        #expect(ended.first?.route == AuthJSON.logoutRoute)
        #expect(ended.first?.headers["authorization"] == "Bearer a1")
    }

    @Test(arguments: [AppleIDCredentialState.authorized, .transferred, .unknown])
    func anyOtherAnswerKeepsTheSession(_ answer: AppleIDCredentialState) async {
        let apple = FakeAppleCredentialState(answer)
        let server = await serverForApple()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store, credentialState: apple)
        await signInWithApple(auth)

        await auth.checkAppleCredential()

        let asked = await apple.asked
        #expect(asked == ["001234.dsul.0001"])
        #expect(auth.isSignedIn)
        #expect(auth.message == nil)
        #expect(store.session?.accessToken == "a1")
        let ended = await logouts(server)
        #expect(ended.isEmpty)
    }

    @Test func googleAndEmailSessionsAreNeverAskedAbout() async throws {
        let apple = FakeAppleCredentialState(.revoked)
        let server = await serverForApple()
        await server.on(AuthJSON.exchangeRoute, .status(200, AuthJSON.token(access: "a1", refresh: "r1")))
        await server.on(EmailJSON.otpRoute, .status(200, "{}"))
        await server.on(AuthJSON.logoutRoute, .status(204, ""))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store, credentialState: apple)

        // Google.
        await signInWithGoogle(auth)
        #expect(auth.isSignedIn)
        #expect(auth.session?.appleUserId == nil)
        await auth.checkAppleCredential()
        #expect(auth.isSignedIn)

        // The email link.
        await auth.signOut()
        await auth.sendEmailLink(to: EmailJSON.address)
        let record = try #require(store.pendingEmail)
        await auth.handleOpenURL(emailCallback(nonce: record.nonce))
        #expect(auth.isSignedIn)
        #expect(auth.session?.appleUserId == nil)
        await auth.checkAppleCredential()
        #expect(auth.isSignedIn)

        // A session saved before Apple, read at launch.
        let saved = AuthSession(accessToken: "a9", refreshToken: "r9", expiresAt: Date().addingTimeInterval(3600),
                                userId: testUserID, email: "kirby@example.com")
        let launched = makeAuth(server, store: InMemoryTokenStore(session: saved), credentialState: apple)
        await launched.checkAppleCredential()
        #expect(launched.isSignedIn)

        let asked = await apple.asked
        #expect(asked.isEmpty)
    }

    @Test func anAnswerForAnEarlierSessionMovesNothing() async {
        let apple = FakeAppleCredentialState(.revoked)
        await apple.hold()
        let server = await serverForApple()
        await server.on(AuthJSON.exchangeRoute, .status(200, AuthJSON.token(access: "a2", refresh: "r2")))
        await server.on(AuthJSON.logoutRoute, .status(204, ""))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store, credentialState: apple)
        await signInWithApple(auth)

        let checking = Task { await auth.checkAppleCredential() }
        #expect(await waitUntil { await apple.asked.count == 1 })
        // Meanwhile: signed out, and back in with Google.
        await auth.signOut()
        await signInWithGoogle(auth)
        #expect(auth.session?.accessToken == "a2")

        await apple.release()
        await checking.value

        #expect(auth.isSignedIn)
        #expect(auth.session?.accessToken == "a2")
        #expect(store.session?.accessToken == "a2")
        #expect(auth.message == nil)
        // Only the user's own sign-out, of the Apple session.
        let ended = await logouts(server)
        #expect(ended.count == 1)
        #expect(ended.first?.headers["authorization"] == "Bearer a1")
    }

    @Test func aSignedOutLaunchAsksAppleNothing() async {
        let apple = FakeAppleCredentialState(.revoked)
        let server = FakeServer()
        let auth = makeAuth(server, store: InMemoryTokenStore(), credentialState: apple)

        await auth.checkAppleCredential()

        #expect(auth.state == .signedOut)
        #expect(auth.message == nil)
        let asked = await apple.asked
        #expect(asked.isEmpty)
        let requests = await server.requests
        #expect(requests.isEmpty)
    }

    @Test func theSampleCannotStartAnAppleSignIn() async {
        let apple = FakeAppleCredentialState(.revoked)
        let server = FakeServer()
        let auth = makeAuth(server, store: InMemoryTokenStore(), credentialState: apple)
        auth.enterSample()

        #expect(auth.beginAppleSignIn() == nil)
        #expect(auth.state == .sample)
        #expect(!auth.isSigningInWithApple)

        // Nor is Apple asked about the sample.
        await auth.checkAppleCredential()
        #expect(auth.state == .sample)
        let asked = await apple.asked
        #expect(asked.isEmpty)
        let requests = await server.requests
        #expect(requests.isEmpty)
    }

    // MARK: One completion per attempt

    @Test(arguments: [AppleSignInOutcome.cancelled, .failed, .credential(AppleJSON.credential)])
    func aFinishedAttemptTakesNoSecondCompletion(_ first: AppleSignInOutcome) async {
        let server = await serverForApple()
        await server.on(AppleJSON.grantRoute, .status(400, providerDisabled))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        _ = auth.beginAppleSignIn()
        await auth.finishAppleSignIn(first)
        let stateAfter = auth.state
        let messageAfter = auth.message

        await auth.finishAppleSignIn(.credential(AppleJSON.credential))

        // Only a credential reaches the grant, and only the first one does.
        let expected = first == .cancelled || first == .failed ? 0 : 1
        let sent = await grants(server)
        #expect(sent.count == expected)
        #expect(auth.state == stateAfter)
        #expect(auth.state == .signedOut)
        #expect(auth.message == messageAfter)
        #expect(!auth.isSigningInWithApple)
        #expect(store.session == nil)
    }

    @Test func aSecondCompletionAfterASignInIsDropped() async {
        let server = await serverForApple()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        _ = auth.beginAppleSignIn()
        await auth.finishAppleSignIn(.credential(AppleJSON.credential))
        let signedIn = auth.session
        #expect(signedIn != nil)

        await auth.finishAppleSignIn(.credential(AppleJSON.credential))

        let sent = await grants(server)
        #expect(sent.count == 1)
        #expect(auth.isSignedIn)
        #expect(auth.session == signedIn)
        #expect(store.stateAtSave == [.signingIn])
        #expect(auth.takeWelcome() == "kirby@example.com")
        #expect(auth.takeWelcome() == nil)
    }
}

/// AuthenticationServices' half: Apple's request and what the button's result
/// comes to. The sheet itself can't open in a test.
@Suite struct AppleAuthorizationTests {
    @Test func theRequestAsksForNameAndEmailWithTheHash() {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        let hash = String(repeating: "ab", count: 32)

        AppleAuthorization.configure(request, hashedNonce: hash)

        #expect(request.requestedScopes == [.fullName, .email])
        #expect(request.nonce == hash)
    }

    @Test func aRefusedAttemptCarriesNoNonce() {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.nonce = "left-over"

        AppleAuthorization.configure(request, hashedNonce: nil)

        #expect(request.nonce == nil)
        #expect(request.requestedScopes == [.fullName, .email])
    }

    @Test func aCancelIsACancelAndTheRestFail() {
        #expect(AppleAuthorization.outcome(.failure(ASAuthorizationError(.canceled))) == .cancelled)
        #expect(AppleAuthorization.outcome(.failure(ASAuthorizationError(.failed))) == .failed)
        #expect(AppleAuthorization.outcome(.failure(ASAuthorizationError(.unknown))) == .failed)
        #expect(AppleAuthorization.outcome(.failure(URLError(.notConnectedToInternet))) == .failed)
    }
}
