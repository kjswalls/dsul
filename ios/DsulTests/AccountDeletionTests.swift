import AuthenticationServices
import DsulCore
import Foundation
import Testing
@testable import Dsul

/// A delete's 200, and the line the sign-in screen then shows.
struct DeletionDoneLine: Sendable, CustomTestStringConvertible {
    let testDescription: String
    let body: String
    let hadApple: Bool
    let apple: AppleRevocation
    let message: String
}

/// A delete that didn't go, and the line the sheet shows.
struct DeletionFailure: Sendable, CustomTestStringConvertible {
    let testDescription: String
    let reply: FakeServer.Reply
    let message: String
}

/// Delete account through AuthStore (memory/plans/account-deletion.md): the
/// facts, the Apple ID the sheet asks Apple about, and the delete, which ends
/// this phone's session with the done line and no logout call, only while it
/// is still the session that asked. AuthStore needs CryptoKit, so this runs on
/// the xcode-27 runner only; AccountAPITests covers the wire.
@MainActor
@Suite struct AccountDeletionTests {
    private let appleID = "001234.dsul.0001"

    /// A session read at launch: signed in, with nothing asked of GoTrue.
    private func savedSession(appleUserId: String? = nil) -> AuthSession {
        return AuthSession(accessToken: "a1", refreshToken: "r1", expiresAt: Date().addingTimeInterval(3600),
                           userId: testUserID, email: "kirby@example.com", appleUserId: appleUserId)
    }

    /// An AuthStore on `server`, which is also the web app the account routes
    /// are on, with its own empty defaults, no waiting between refresh retries,
    /// and Apple's answers from `credentialState` (none: nothing to ask).
    private func makeAuth(_ server: FakeServer, store: InMemoryTokenStore,
                          credentialState: FakeAppleCredentialState? = nil) -> AuthStore {
        let defaults = UserDefaults(suiteName: "dsul-tests-" + UUID().uuidString)!
        let origin = URL(string: "https://dsul.test")!
        let config = SupabaseConfigStore(origin: origin, defaults: defaults, transport: server.transport)
        var check: (@Sendable (String) async -> AppleIDCredentialState)? = nil
        if let credentialState {
            check = { userID in await credentialState.state(forUserID: userID) }
        }
        let auth = AuthStore(tokenStore: store, configStore: config, transport: server.transport,
                             sleep: { _ in }, appleCredentialState: check, apiOrigin: origin)
        store.observedAuth = auth
        return auth
    }

    private func logouts(_ server: FakeServer) async -> [FakeServer.Request] {
        let all = await server.requests
        return all.filter { $0.route.hasPrefix("POST /auth/v1/logout") }
    }

    /// Facts for this account with `appleIds`, from a server whose Apple setup
    /// is in place (or not).
    private func facts(appleIds: [String], appleRevocable: Bool = true) -> AccountFacts {
        return AccountFacts(userId: AccountJSON.account, email: "kirby@example.com", appleIds: appleIds,
                            appleRevocable: appleRevocable)
    }

    // MARK: The delete

    @Test func aDeletionEndsTheSessionWithNoLogoutCall() async {
        let server = FakeServer()
        await server.on(AccountJSON.deleteRoute, .status(200, AccountJSON.revoked))
        let pending = EmailSignIn.start(email: EmailJSON.address, now: Date())
        let store = InMemoryTokenStore(session: savedSession(appleUserId: appleID), pendingEmail: pending)
        let auth = makeAuth(server, store: store)
        #expect(auth.isSignedIn)

        let outcome = await auth.deleteAccount(account: AccountJSON.account, appleCode: "c0de.1", hadApple: true)

        #expect(outcome == .deleted(.revoked))
        #expect(auth.state == .signedOut)
        #expect(auth.message == AccountDeletion.deletedMessage)
        #expect(auth.message == "Your dsul account is deleted.")
        #expect(store.session == nil)
        #expect(store.pendingEmail == nil)
        #expect(auth.emailSent == nil)
        // One request, to dsul's own route: nothing to GoTrue, so no logout.
        let requests = await server.requests
        #expect(requests.map(\.route) == [AccountJSON.deleteRoute])
        #expect(requests.first?.headers["authorization"] == "Bearer a1")
        let body = bodyJSON(requests.first)
        #expect(body?["account"] as? String == AccountJSON.account)
        #expect(body?["appleCode"] as? String == "c0de.1")
        #expect(body?["confirm"] as? String == "DELETE")
        let ended = await logouts(server)
        #expect(ended.isEmpty)
    }

    @Test(arguments: [
        DeletionDoneLine(testDescription: "revoked", body: AccountJSON.revoked, hadApple: true,
                         apple: .revoked, message: AccountDeletion.deletedMessage),
        DeletionDoneLine(testDescription: "not revoked", body: #"{"deleted":true,"apple":"not_revoked"}"#,
                         hadApple: true, apple: .notRevoked, message: AccountDeletion.appleLeftMessage),
        DeletionDoneLine(testDescription: "a retry, with Apple", body: #"{"deleted":true,"apple":"unknown"}"#,
                         hadApple: true, apple: .unknown, message: AccountDeletion.appleLeftMessage),
        DeletionDoneLine(testDescription: "a retry, without Apple", body: #"{"deleted":true,"apple":"unknown"}"#,
                         hadApple: false, apple: .unknown, message: AccountDeletion.deletedMessage),
        DeletionDoneLine(testDescription: "no Apple id", body: #"{"deleted":true,"apple":"none"}"#,
                         hadApple: false, apple: AppleRevocation.none, message: AccountDeletion.deletedMessage),
        DeletionDoneLine(testDescription: "unreadable, with Apple", body: #"{"deleted":true}"#,
                         hadApple: true, apple: .unknown, message: AccountDeletion.appleLeftMessage),
    ])
    func theDoneLineSaysWhatBecameOfApple(_ done: DeletionDoneLine) async {
        let server = FakeServer()
        await server.on(AccountJSON.deleteRoute, .status(200, done.body))
        let store = InMemoryTokenStore(session: savedSession())
        let auth = makeAuth(server, store: store)

        let outcome = await auth.deleteAccount(account: AccountJSON.account, appleCode: nil, hadApple: done.hadApple)

        #expect(outcome == .deleted(done.apple))
        #expect(auth.state == .signedOut)
        #expect(auth.message == done.message)
        #expect(store.session == nil)
    }

    @Test(arguments: [
        DeletionFailure(testDescription: "503", reply: .status(503, AccountJSON.refusal("unavailable")),
                        message: AccountDeletion.unreachableMessage),
        DeletionFailure(testDescription: "offline", reply: .offline, message: AccountDeletion.unreachableMessage),
        DeletionFailure(testDescription: "500", reply: .status(500, AccountJSON.refusal("failed")),
                        message: AccountDeletion.failedMessage),
        DeletionFailure(testDescription: "400", reply: .status(400, AccountJSON.refusal("invalid")),
                        message: AccountDeletion.failedMessage),
        DeletionFailure(testDescription: "409", reply: .status(409, AccountJSON.refusal("changed")),
                        message: AccountDeletion.changedMessage),
    ])
    func aDeleteThatDidNotGoKeepsTheSession(_ failure: DeletionFailure) async {
        let server = FakeServer()
        await server.on(AccountJSON.deleteRoute, failure.reply)
        let pending = EmailSignIn.start(email: EmailJSON.address, now: Date())
        let store = InMemoryTokenStore(session: savedSession(), pendingEmail: pending)
        let auth = makeAuth(server, store: store)

        let outcome = await auth.deleteAccount(account: AccountJSON.account, appleCode: nil, hadApple: false)

        #expect(outcome == .failed(failure.message))
        #expect(auth.isSignedIn)
        #expect(auth.message == nil)
        #expect(store.session?.accessToken == "a1")
        #expect(store.pendingEmail == pending)
    }

    @Test func a401AfterARefreshIsAFailureNotASignOut() async {
        let server = FakeServer()
        await server.on(AuthJSON.configRoute, .status(200, AuthJSON.config))
        await server.on(AuthJSON.refreshRoute, .status(200, AuthJSON.token(access: "a2", refresh: "r2")))
        await server.on(AccountJSON.deleteRoute, .status(401, AccountJSON.refusal("unauthorized")))
        let store = InMemoryTokenStore(session: savedSession())
        let auth = makeAuth(server, store: store)

        let outcome = await auth.deleteAccount(account: AccountJSON.account, appleCode: nil, hadApple: false)

        #expect(outcome == .failed(AccountDeletion.failedMessage))
        #expect(auth.isSignedIn)
        #expect(auth.session?.accessToken == "a2")
        let requests = await server.requests
        let deletes = requests.filter { $0.route == AccountJSON.deleteRoute }
        #expect(deletes.map { $0.headers["authorization"] } == ["Bearer a1", "Bearer a2"])
    }

    @Test func noSessionSendsNothing() async {
        let server = FakeServer()
        await server.on(AccountJSON.deleteRoute, .status(200, AccountJSON.revoked))
        let auth = makeAuth(server, store: InMemoryTokenStore())

        #expect(await auth.deleteAccount(account: AccountJSON.account, appleCode: nil, hadApple: false) == .signedOut)
        #expect(auth.state == .signedOut)
        #expect(auth.message == nil)

        // Nor from the sample, which has no account.
        auth.enterSample()
        #expect(await auth.deleteAccount(account: AccountJSON.account, appleCode: nil, hadApple: false) == .signedOut)
        #expect(auth.state == .sample)
        #expect(auth.message == nil)

        let requests = await server.requests
        #expect(requests.isEmpty)
    }

    @Test func aSessionThatEndedUnderTheCallOnlyTakesTheLine() async {
        let server = FakeServer()
        await server.on(AuthJSON.configRoute, .status(200, AuthJSON.config))
        await server.on(AuthJSON.logoutRoute, .status(204, ""))
        await server.on(AccountJSON.deleteRoute, .status(200, #"{"deleted":true,"apple":"not_revoked"}"#))
        await server.close(AccountJSON.deleteRoute)
        let store = InMemoryTokenStore(session: savedSession())
        let auth = makeAuth(server, store: store)

        let deleting = Task { await auth.deleteAccount(account: AccountJSON.account, appleCode: nil, hadApple: true) }
        #expect(await waitUntil { await server.count(AccountJSON.deleteRoute) == 1 })
        // Meanwhile, the user's own Sign out.
        await auth.signOut()
        #expect(auth.message == nil)

        await server.open(AccountJSON.deleteRoute)
        let outcome = await deleting.value

        #expect(outcome == .deleted(.notRevoked))
        #expect(auth.state == .signedOut)
        #expect(auth.message == AccountDeletion.appleLeftMessage)
        // Only the user's own sign-out called GoTrue.
        let ended = await logouts(server)
        #expect(ended.count == 1)
    }

    @Test func someoneElsesSessionIsNeverTouched() async {
        let other = UUID(uuidString: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d")!
        let otherToken = "{\"access_token\":\"b1\",\"token_type\":\"bearer\",\"expires_in\":3600,"
            + "\"expires_at\":0,\"refresh_token\":\"s1\","
            + "\"user\":{\"id\":\"\(lowerID(other))\",\"email\":\"other@example.com\"}}"
        let server = FakeServer()
        await server.on(AuthJSON.configRoute, .status(200, AuthJSON.config))
        await server.on(AuthJSON.logoutRoute, .status(204, ""))
        await server.on(AuthJSON.exchangeRoute, .status(200, otherToken))
        await server.on(AccountJSON.deleteRoute, .status(200, AccountJSON.revoked))
        await server.close(AccountJSON.deleteRoute)
        let store = InMemoryTokenStore(session: savedSession())
        let auth = makeAuth(server, store: store)

        let deleting = Task { await auth.deleteAccount(account: AccountJSON.account, appleCode: nil, hadApple: false) }
        #expect(await waitUntil { await server.count(AccountJSON.deleteRoute) == 1 })
        // Meanwhile: signed out, and in again as someone else.
        await auth.signOut()
        await auth.signInWithGoogle { _ in AuthJSON.callback }
        #expect(auth.session?.userId == other)

        await server.open(AccountJSON.deleteRoute)
        let outcome = await deleting.value

        #expect(outcome == .deleted(.revoked))
        #expect(auth.session?.userId == other)
        #expect(store.session?.accessToken == "b1")
        #expect(auth.message == nil)
    }

    // MARK: The facts

    @Test func theFactsAreTheRoutesAnswer() async {
        let server = FakeServer()
        await server.on(AccountJSON.factsRoute, .status(200, AccountJSON.facts))
        let store = InMemoryTokenStore(session: savedSession())
        let auth = makeAuth(server, store: store)

        let facts = await auth.accountFacts()

        #expect(facts?.userId == AccountJSON.account)
        #expect(facts?.appleIds == [appleID])
        #expect(auth.isSignedIn)
        let requests = await server.requests
        #expect(requests.map(\.route) == [AccountJSON.factsRoute])
        #expect(requests.first?.headers["authorization"] == "Bearer a1")
    }

    @Test func goneFactsEndTheSessionAsADeletionDoes() async {
        let server = FakeServer()
        await server.on(AccountJSON.factsRoute, .status(410, AccountJSON.refusal("gone")))
        let pending = EmailSignIn.start(email: EmailJSON.address, now: Date())
        let store = InMemoryTokenStore(session: savedSession(), pendingEmail: pending)
        let auth = makeAuth(server, store: store)

        let facts = await auth.accountFacts()

        #expect(facts == nil)
        #expect(auth.state == .signedOut)
        #expect(auth.message == AccountDeletion.deletedMessage)
        #expect(store.session == nil)
        #expect(store.pendingEmail == nil)
        let requests = await server.requests
        #expect(requests.map(\.route) == [AccountJSON.factsRoute])
        let ended = await logouts(server)
        #expect(ended.isEmpty)
    }

    @Test(arguments: [
        FakeServer.Reply.status(503, AccountJSON.refusal("unavailable")),
        .offline,
        .status(401, AccountJSON.refusal("unauthorized")),
        .status(200, #"{"email":"kirby@example.com"}"#),
    ])
    func factsThatDidNotLoadKeepTheSession(_ reply: FakeServer.Reply) async {
        let server = FakeServer()
        await server.on(AuthJSON.configRoute, .status(200, AuthJSON.config))
        await server.on(AuthJSON.refreshRoute, .status(200, AuthJSON.token(access: "a2", refresh: "r2")))
        await server.on(AccountJSON.factsRoute, reply)
        let store = InMemoryTokenStore(session: savedSession())
        let auth = makeAuth(server, store: store)

        let facts = await auth.accountFacts()

        #expect(facts == nil)
        #expect(auth.isSignedIn)
        #expect(auth.message == nil)
        #expect(store.session != nil)
    }

    @Test func goneFactsAfterTheSessionEndedOnlySetTheLine() async {
        let server = FakeServer()
        await server.on(AuthJSON.configRoute, .status(200, AuthJSON.config))
        await server.on(AuthJSON.logoutRoute, .status(204, ""))
        await server.on(AccountJSON.factsRoute, .status(410, AccountJSON.refusal("gone")))
        await server.close(AccountJSON.factsRoute)
        let auth = makeAuth(server, store: InMemoryTokenStore(session: savedSession()))

        let loading = Task { await auth.accountFacts() }
        #expect(await waitUntil { await server.count(AccountJSON.factsRoute) == 1 })
        await auth.signOut()
        await server.open(AccountJSON.factsRoute)

        #expect(await loading.value == nil)
        #expect(auth.state == .signedOut)
        #expect(auth.message == AccountDeletion.deletedMessage)
        let ended = await logouts(server)
        #expect(ended.count == 1)
    }

    @Test func noSessionAsksForNoFacts() async {
        let server = FakeServer()
        await server.on(AccountJSON.factsRoute, .status(200, AccountJSON.facts))
        let auth = makeAuth(server, store: InMemoryTokenStore())

        #expect(await auth.accountFacts() == nil)
        let requests = await server.requests
        #expect(requests.isEmpty)
    }

    // MARK: The Apple ID the sheet asks Apple about

    @Test func theAppleIDIsTheFirstThisPhoneCanAuthorize() async {
        let apple = FakeAppleCredentialState(.notFound, .authorized)
        let auth = makeAuth(FakeServer(), store: InMemoryTokenStore(session: savedSession()), credentialState: apple)

        let chosen = await auth.deletionAppleUserId(for: facts(appleIds: ["001234.dsul.0002", appleID, "001234.dsul.0003"]))

        #expect(chosen == appleID)
        // It stops at the first.
        let asked = await apple.asked
        #expect(asked == ["001234.dsul.0002", appleID])
    }

    @Test func noAppleIDWithoutTheServersAppleSetup() async {
        let apple = FakeAppleCredentialState(.authorized)
        let auth = makeAuth(FakeServer(), store: InMemoryTokenStore(session: savedSession()), credentialState: apple)

        #expect(await auth.deletionAppleUserId(for: facts(appleIds: [appleID], appleRevocable: false)) == nil)
        #expect(await auth.deletionAppleUserId(for: facts(appleIds: [])) == nil)
        let asked = await apple.asked
        #expect(asked.isEmpty)
    }

    @Test func noAppleIDWithNothingToAsk() async {
        let auth = makeAuth(FakeServer(), store: InMemoryTokenStore(session: savedSession()))

        #expect(await auth.deletionAppleUserId(for: facts(appleIds: [appleID])) == nil)
    }

    @Test func noAppleIDWhenNoneIsAuthorized() async {
        let apple = FakeAppleCredentialState(.revoked, .notFound, .transferred, .unknown)
        let auth = makeAuth(FakeServer(), store: InMemoryTokenStore(session: savedSession()), credentialState: apple)
        let ids = ["001234.dsul.0001", "001234.dsul.0002", "001234.dsul.0003", "001234.dsul.0004"]

        #expect(await auth.deletionAppleUserId(for: facts(appleIds: ids)) == nil)
        let asked = await apple.asked
        #expect(asked == ids)
    }

    /// The sheet asks when it opens and again just before Apple's request: an
    /// id revoked in between (an earlier deletion whose answer was lost) gets
    /// no request.
    @Test func theSecondAskSeesARevokedID() async {
        let apple = FakeAppleCredentialState(.authorized, .revoked)
        let auth = makeAuth(FakeServer(), store: InMemoryTokenStore(session: savedSession()), credentialState: apple)
        let account = facts(appleIds: [appleID])

        #expect(await auth.deletionAppleUserId(for: account) == appleID)
        #expect(await auth.deletionAppleUserId(for: account) == nil)
    }

    // MARK: The sheet's slot

    @Test func theSheetRidesThePlannersOneSlot() {
        #expect(PlannerSheet.deleteAccount.id == "deleteAccount")
        let planner = SamplePlanner(todayString: PlannerJSON.today, now: { PlannerJSON.noon })
        planner.activeSheet = .deleteAccount
        #expect(planner.sheetOverApp == .deleteAccount)
        #expect(planner.sheetOverBraindump == nil)
        #expect(!planner.isShowingItemSheet)

        planner.activeSheet = nil
        planner.showBraindumpSheet = true
        planner.activeSheet = .deleteAccount
        #expect(planner.sheetOverApp == nil)
        #expect(planner.sheetOverBraindump == .deleteAccount)

        planner.sheetOverBraindump = nil
        #expect(planner.activeSheet == nil)
    }
}

/// AuthenticationServices' half of Delete account: Apple's request and what
/// its answer comes to. The sheet itself can't open in a test, and
/// `ASAuthorizationAppleIDCredential` has no public initializer, so
/// `deletionOutcome(credential:)` is read in review.
@Suite struct AppleDeletionAuthorizationTests {
    @Test func theRequestAsksForNothingButTheKnownUser() {
        let request = AppleAuthorization.deletionRequest(user: "001234.dsul.0001")

        #expect((request.requestedScopes ?? []).isEmpty)
        #expect(request.user == "001234.dsul.0001")
        #expect(request.nonce == nil)
    }

    @Test func aCancelIsACancelAndTheRestFail() {
        #expect(AppleAuthorization.deletionOutcome(error: ASAuthorizationError(.canceled)) == .cancelled)
        // As Apple's sheet throws it: an NSError in Apple's domain.
        let bridged = NSError(domain: ASAuthorizationError.errorDomain, code: ASAuthorizationError.Code.canceled.rawValue)
        #expect(AppleAuthorization.deletionOutcome(error: bridged) == .cancelled)
        #expect(AppleAuthorization.deletionOutcome(error: ASAuthorizationError(.failed)) == .failed)
        #expect(AppleAuthorization.deletionOutcome(error: ASAuthorizationError(.unknown)) == .failed)
        #expect(AppleAuthorization.deletionOutcome(error: NSError(domain: "dsul.test", code: 1001)) == .failed)
        #expect(AppleAuthorization.deletionOutcome(error: URLError(.notConnectedToInternet)) == .failed)
    }
}
