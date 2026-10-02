import CryptoKit
import DsulCore
import Foundation
import Security
import Testing
@testable import Dsul

/// GoTrue's /otp, by path: its query carries the record's nonce, so FakeServer
/// matches it without the query.
enum EmailJSON {
    static let otpRoute = "POST /auth/v1/otp"
    static let address = "me@example.com"
    static let rateLimited = "{\"code\":\"over_email_send_rate_limit\",\"message\":\"email rate limit exceeded\"}"
}

/// The S256 challenge of a verifier, as GoTrue checks it.
private func challenge(of verifier: String) -> String {
    return PKCE.challenge(for: verifier) { data in Data(SHA256.hash(data: data)) }
}

/// The link's hand-back for `nonce`, as the /auth/ios page writes it.
private func emailCallback(code: String = "code-1234", nonce: String) -> URL {
    return URL(string: "app.dsul.ios://auth/callback?code=\(code)&n=\(nonce)")!
}

private func emailError(_ code: String, nonce: String) -> URL {
    return URL(string: "app.dsul.ios://auth/callback?error_code=\(code)&n=\(nonce)")!
}

/// The `redirect_to` a recorded /otp request asked for.
private func redirectTo(_ request: FakeServer.Request?) -> String? {
    guard let route = request?.route, let space = route.firstIndex(of: " ") else { return nil }
    let path = String(route[route.index(after: space)...])
    return URLComponents(string: "https://example.supabase.co" + path)?
        .queryItems?.first { $0.name == "redirect_to" }?.value
}

@MainActor
@Suite struct EmailSignInTests {
    private func makeAuth(_ server: FakeServer, store: InMemoryTokenStore) -> AuthStore {
        let defaults = UserDefaults(suiteName: "dsul-tests-" + UUID().uuidString)!
        let config = SupabaseConfigStore(origin: URL(string: "https://dsul.test")!, defaults: defaults,
                                         transport: server.transport)
        let auth = AuthStore(tokenStore: store, configStore: config, transport: server.transport,
                             sleep: { _ in })
        store.observedAuth = auth
        return auth
    }

    /// The config, a send that goes, and an exchange that answers `a1`/`r1`.
    private func makeServer(email: String = EmailJSON.address) async -> FakeServer {
        let server = FakeServer()
        await server.on(AuthJSON.configRoute, .status(200, AuthJSON.config))
        await server.on(EmailJSON.otpRoute, .status(200, "{}"))
        await server.on(AuthJSON.exchangeRoute, .status(200, AuthJSON.token(access: "a1", refresh: "r1", email: email)))
        return server
    }

    private func sends(_ server: FakeServer) async -> [FakeServer.Request] {
        let all = await server.requests
        return all.filter { $0.route.hasPrefix(EmailJSON.otpRoute + "?") }
    }

    private func exchanges(_ server: FakeServer) async -> [FakeServer.Request] {
        let all = await server.requests
        return all.filter { $0.route == AuthJSON.exchangeRoute }
    }

    /// A live record, as an earlier send (perhaps before a quit) left it.
    private func liveRecord(sentAgo: TimeInterval = 30) -> EmailSignIn {
        return EmailSignIn.start(email: EmailJSON.address, now: Date().addingTimeInterval(-sentAgo))
    }

    // MARK: Sending

    @Test func aSignedOutLaunchReadsNoRecord() async {
        let server = FakeServer()
        let store = InMemoryTokenStore(pendingEmail: liveRecord())
        let auth = makeAuth(server, store: store)
        #expect(auth.state == .signedOut)
        #expect(auth.emailSent == nil)
        #expect(store.pendingLoads == 0)
        let requests = await server.requests
        #expect(requests.isEmpty)
    }

    @Test func aSendKeepsTheRecordBeforeItAsksForALinkBoundToIt() async throws {
        let server = await makeServer()
        await server.close(EmailJSON.otpRoute)
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)

        let sending = Task { await auth.sendEmailLink(to: "  Me@Example.com\n") }
        #expect(await waitUntil { await sends(server).count == 1 })
        // The request is out, and the verifier it needs is already kept.
        let record = try #require(store.pendingEmail)
        #expect(record.email == EmailJSON.address)
        #expect(auth.isSendingEmail)
        #expect(auth.emailSent == nil)

        await server.open(EmailJSON.otpRoute)
        await sending.value

        #expect(!auth.isSendingEmail)
        #expect(auth.emailSent == EmailJSON.address)
        #expect(auth.message == nil)
        #expect(auth.state == .signedOut)
        let sent = await sends(server)
        let send = sent.first
        let body = bodyJSON(send)
        #expect(body?["email"] as? String == EmailJSON.address)
        #expect(body?["code_challenge"] as? String == challenge(of: record.verifier))
        #expect(body?["code_challenge_method"] as? String == "s256")
        #expect(body?["create_user"] == nil)
        #expect(send?.headers["apikey"] == "anon-key")
        #expect(redirectTo(send) == GoTrue.emailRedirect(from: AppConfig.authRedirect, nonce: record.nonce))
        #expect(redirectTo(send)?.hasSuffix("/auth/ios?via=email&n=" + record.nonce) == true)
    }

    @Test func somethingThatIsNotAnAddressSendsNothing() async {
        let server = await makeServer()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)

        await auth.sendEmailLink(to: "me@")

        #expect(auth.message == "That doesn't look like an email address.")
        #expect(auth.emailSent == nil)
        #expect(store.pendingEmail == nil)
        let requests = await server.requests
        #expect(requests.isEmpty)
    }

    @Test func aRefusedResendKeepsTheVerifierTheFirstEmailNeeds() async throws {
        let server = await makeServer()
        await server.on(EmailJSON.otpRoute, .status(200, "{}"), .status(429, EmailJSON.rateLimited))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)

        await auth.sendEmailLink(to: EmailJSON.address)
        let first = try #require(store.pendingEmail)
        await auth.sendEmailLink(to: EmailJSON.address)   // "Send again", too soon

        #expect(auth.message == "Too many sign-in emails just now. Try again in a few minutes.")
        #expect(auth.emailSent == EmailJSON.address)
        let kept = try #require(store.pendingEmail)
        #expect(kept.verifier == first.verifier)
        #expect(kept.nonce == first.nonce)

        // The first email's link still signs in, with the verifier whose
        // challenge every send carried, the refused one included.
        await auth.handleOpenURL(emailCallback(nonce: first.nonce))

        #expect(auth.isSignedIn)
        let exchanged = await exchanges(server)
        let verifier = try #require(bodyJSON(exchanged.first)?["code_verifier"] as? String)
        let sent = await sends(server)
        let challenges = sent.map { bodyJSON($0)?["code_challenge"] as? String }
        #expect(challenges.count == 2)
        #expect(challenges.allSatisfy { $0 == challenge(of: verifier) })
        #expect(store.pendingEmail == nil)
        #expect(auth.emailSent == nil)
    }

    @Test func anotherAddressStartsAfreshAndTheOldLinkMovesNothing() async throws {
        let server = await makeServer()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)

        await auth.sendEmailLink(to: EmailJSON.address)
        let first = try #require(store.pendingEmail)
        auth.useDifferentEmail()
        #expect(auth.emailSent == nil)
        #expect(store.pendingEmail == first)   // the first email still works until replaced
        await auth.sendEmailLink(to: "you@example.com")
        let second = try #require(store.pendingEmail)

        #expect(second.email == "you@example.com")
        #expect(second.verifier != first.verifier)
        #expect(second.nonce != first.nonce)
        #expect(auth.emailSent == "you@example.com")

        await auth.handleOpenURL(emailCallback(nonce: first.nonce))
        #expect(auth.state == .signedOut)
        #expect(auth.message == nil)
        let exchanged = await exchanges(server)
        #expect(exchanged.isEmpty)
    }

    @Test func anAddressGoTrueRefusesLeavesTheEarlierSignInWorking() async throws {
        let server = await makeServer()
        await server.on(EmailJSON.otpRoute, .status(200, "{}"),
                        .status(400, "{\"code\":\"email_address_not_authorized\",\"message\":\"Email address not authorized\"}"))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await auth.sendEmailLink(to: EmailJSON.address)
        let first = try #require(store.pendingEmail)
        auth.useDifferentEmail()

        await auth.sendEmailLink(to: "you@example.com")

        #expect(auth.message == "dsul can't email that address yet.")
        #expect(store.pendingEmail == first)
        await auth.handleOpenURL(emailCallback(nonce: first.nonce))
        #expect(auth.isSignedIn)
        let exchanged = await exchanges(server)
        #expect(exchanged.count == 1)
        #expect(bodyJSON(exchanged.first)?["code_verifier"] as? String == first.verifier)
    }

    @Test func aSendToAnotherAddressThatMayHaveLandedKeepsItsRecord() async throws {
        let server = await makeServer()
        await server.on(EmailJSON.otpRoute, .status(200, "{}"), .offline)
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await auth.sendEmailLink(to: EmailJSON.address)
        let first = try #require(store.pendingEmail)
        auth.useDifferentEmail()

        await auth.sendEmailLink(to: "you@example.com")

        #expect(auth.message == "Couldn't send the link. Check your connection and try again.")
        let kept = try #require(store.pendingEmail)
        #expect(kept.email == "you@example.com")
        #expect(kept.nonce != first.nonce)
    }

    @Test func eachSendFailureSaysWhatHappened() {
        let cases: [(Error, String)] = [
            (AuthError.send(status: 429, code: "over_email_send_rate_limit"),
             "Too many sign-in emails just now. Try again in a few minutes."),
            (AuthError.send(status: 429, code: nil), "Too many sign-in emails just now. Try again in a few minutes."),
            (AuthError.send(status: 400, code: "validation_failed"), "That doesn't look like an email address."),
            (AuthError.send(status: 400, code: "email_address_invalid"), "That doesn't look like an email address."),
            (AuthError.send(status: 400, code: "email_address_not_authorized"), "dsul can't email that address yet."),
            (AuthError.send(status: 422, code: "otp_disabled"), "That address can't sign in by email."),
            (AuthError.send(status: 422, code: "signup_disabled"), "That address can't sign in by email."),
            (AuthError.send(status: 500, code: "unexpected_failure"), "Couldn't send the link. Try again."),
            (URLError(.notConnectedToInternet), "Couldn't send the link. Check your connection and try again."),
            (AuthError.unavailable, "Couldn't send the link. Check your connection and try again."),
        ]
        for (error, copy) in cases {
            #expect(AuthStore.sendMessage(for: error) == copy, "\(error)")
        }
    }

    // MARK: The link

    @Test func theLinkSignsInAndTheWelcomeIsTheSessionsAddress() async throws {
        // The token says who this is; the address typed is only what was asked.
        let server = await makeServer(email: "other@example.com")
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await auth.sendEmailLink(to: EmailJSON.address)
        let record = try #require(store.pendingEmail)

        await auth.handleOpenURL(emailCallback(code: "code-5678", nonce: record.nonce))

        #expect(auth.isSignedIn)
        #expect(store.session?.accessToken == "a1")
        #expect(store.stateAtSave == [.signingIn])
        #expect(auth.takeWelcome() == "other@example.com")
        #expect(store.pendingEmail == nil)
        #expect(auth.emailSent == nil)
        #expect(auth.message == nil)
        let exchanged = await exchanges(server)
        let body = bodyJSON(exchanged.first)
        #expect(body?["auth_code"] as? String == "code-5678")
        #expect(body?["code_verifier"] as? String == record.verifier)
    }

    @Test func aRelaunchFinishesTheSignInTheLastRunStarted() async throws {
        let server = await makeServer()
        let store = InMemoryTokenStore()
        let before = makeAuth(server, store: store)
        await before.sendEmailLink(to: EmailJSON.address)
        let record = try #require(store.pendingEmail)

        // Quit and opened by the link: a new store over the same Keychain.
        let after = makeAuth(server, store: store)
        await after.handleOpenURL(emailCallback(nonce: record.nonce))

        #expect(after.isSignedIn)
        let exchanged = await exchanges(server)
        #expect(bodyJSON(exchanged.first)?["code_verifier"] as? String == record.verifier)
    }

    @Test func aCallbackWithoutThisPhonesNonceMovesNothing() async throws {
        let server = await makeServer()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await auth.sendEmailLink(to: EmailJSON.address)
        let record = try #require(store.pendingEmail)

        for url in [
            emailCallback(nonce: "ZZZZZZZZZZZZZZZZZZZZZZ"),
            emailError("otp_expired", nonce: "ZZZZZZZZZZZZZZZZZZZZZZ"),
            URL(string: "app.dsul.ios://auth/callback?code=code-1234")!,   // Google's shape
            URL(string: "app.dsul.ios://auth/callback?error_code=access_denied")!,
            URL(string: "app.dsul.ios://elsewhere?code=code-1234&n=\(record.nonce)")!,
        ] {
            await auth.handleOpenURL(url)
            #expect(auth.state == .signedOut, "\(url)")
            #expect(auth.message == nil, "\(url)")
            #expect(auth.emailSent == EmailJSON.address, "\(url)")
        }
        #expect(store.pendingEmail == record)
        let exchanged = await exchanges(server)
        #expect(exchanged.isEmpty)

        // Nor does one reach the sample.
        auth.enterSample()
        await auth.handleOpenURL(emailCallback(nonce: "ZZZZZZZZZZZZZZZZZZZZZZ"))
        #expect(auth.state == .sample)
    }

    @Test func withNoRecordALinkIsDroppedSilently() async {
        let server = await makeServer()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)

        await auth.handleOpenURL(emailCallback(nonce: "AbCdEfGhIjKlMnOpQrStUv"))

        #expect(auth.state == .signedOut)
        #expect(auth.message == nil)
        let requests = await server.requests
        #expect(requests.isEmpty)
    }

    @Test func aLapsedRecordIsDroppedWithAWordAndNothingSent() async {
        let server = await makeServer()
        let lapsed = liveRecord(sentAgo: EmailSignIn.window + 1)
        let store = InMemoryTokenStore(pendingEmail: lapsed)
        let auth = makeAuth(server, store: store)

        await auth.handleOpenURL(emailCallback(nonce: lapsed.nonce))

        #expect(auth.state == .signedOut)
        #expect(auth.message == "That link has expired. Send a new one.")
        #expect(store.pendingEmail == nil)
        let requests = await server.requests
        #expect(requests.isEmpty)
    }

    @Test func anErrorOnTheLinkSaysWhyAndKeepsTheRecord() async {
        let server = await makeServer()
        let record = liveRecord()
        let store = InMemoryTokenStore(pendingEmail: record)
        let auth = makeAuth(server, store: store)

        await auth.handleOpenURL(emailError("otp_expired", nonce: record.nonce))

        #expect(auth.state == .signedOut)
        #expect(auth.message == "That link was replaced or already used. Open the newest email from dsul, or send a new link.")
        // "Check your email" is back, so Send again is one tap.
        #expect(auth.emailSent == EmailJSON.address)
        #expect(store.pendingEmail == record)
        let requests = await server.requests
        #expect(requests.isEmpty)
    }

    @Test func anExchangeThatCouldNotReachGoTrueIsTriedAgainOnTheNextDelivery() async {
        let server = await makeServer()
        await server.on(AuthJSON.exchangeRoute, .offline, .status(200, AuthJSON.token(access: "a1", refresh: "r1")))
        let record = liveRecord()
        let store = InMemoryTokenStore(pendingEmail: record)
        let auth = makeAuth(server, store: store)
        let url = emailCallback(nonce: record.nonce)

        await auth.handleOpenURL(url)
        #expect(auth.state == .signedOut)
        #expect(auth.message == "Couldn't reach dsul. Check your connection, then go back and tap Open dsul.")
        #expect(store.pendingEmail == record)

        // The page's Open dsul button sends the same code again.
        await auth.handleOpenURL(url)
        #expect(auth.isSignedIn)
        let exchanged = await exchanges(server)
        #expect(exchanged.count == 2)
    }

    @Test func aSecondDeliveryDuringTheExchangeIsDropped() async {
        let server = await makeServer()
        await server.close(AuthJSON.exchangeRoute)
        let record = liveRecord()
        let store = InMemoryTokenStore(pendingEmail: record)
        let auth = makeAuth(server, store: store)
        let url = emailCallback(nonce: record.nonce)

        let first = Task { await auth.handleOpenURL(url) }
        #expect(await waitUntil { auth.state == .signingIn })
        await auth.handleOpenURL(url)
        await server.open(AuthJSON.exchangeRoute)
        await first.value

        #expect(auth.isSignedIn)
        let exchanged = await exchanges(server)
        #expect(exchanged.count == 1)
    }

    @Test func anExpiredFlowStateAsksForOneMoreLinkWithTheSameVerifier() async throws {
        let server = await makeServer()
        await server.on(AuthJSON.exchangeRoute,
                        .status(422, "{\"code\":\"flow_state_expired\",\"message\":\"Flow state has expired\"}"))
        let record = liveRecord()
        let store = InMemoryTokenStore(pendingEmail: record)
        let auth = makeAuth(server, store: store)

        await auth.handleOpenURL(emailCallback(nonce: record.nonce))

        #expect(auth.state == .signedOut)
        #expect(auth.message == "Almost there. Send one more link and it will sign you straight in.")
        #expect(store.pendingEmail == record)
        let sentTo = try #require(auth.emailSent)

        await auth.sendEmailLink(to: sentTo)   // "Send again"
        let sent = await sends(server)
        #expect(bodyJSON(sent.first)?["code_challenge"] as? String == challenge(of: record.verifier))
        #expect(store.pendingEmail?.nonce == record.nonce)
    }

    @Test func eachExchangeFailureSaysWhatToDo() {
        let cases: [(Error, String)] = [
            (AuthError.exchange(status: 422, code: "flow_state_expired"),
             "Almost there. Send one more link and it will sign you straight in."),
            (AuthError.exchange(status: 404, code: "flow_state_not_found"),
             "That link was for a different sign-in. Send a new one from this iPhone."),
            (AuthError.exchange(status: 400, code: "bad_code_verifier"),
             "That link was for a different sign-in. Send a new one from this iPhone."),
            (AuthError.exchange(status: 503, code: nil), "Couldn't finish signing in. Go back and tap Open dsul to try again."),
            (AuthError.exchange(status: 429, code: "over_request_rate_limit"),
             "Couldn't finish signing in. Go back and tap Open dsul to try again."),
            (AuthError.exchange(status: 400, code: "validation_failed"), "Couldn't sign in with that link. Send a new one."),
            (URLError(.timedOut), "Couldn't reach dsul. Check your connection, then go back and tap Open dsul."),
        ]
        for (error, copy) in cases {
            #expect(AuthStore.exchangeMessage(for: error) == copy, "\(error)")
        }
        #expect(AuthStore.linkErrorMessage("access_denied")
            == "That link was replaced or already used. Open the newest email from dsul, or send a new link.")
        #expect(AuthStore.linkErrorMessage("server_error") == "Couldn't sign in with that link. Send a new one.")
    }

    @Test func theSampleDayGivesWayToTheUsersOwnLink() async throws {
        let server = await makeServer()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await auth.sendEmailLink(to: EmailJSON.address)
        let record = try #require(store.pendingEmail)
        auth.enterSample()

        await auth.handleOpenURL(emailCallback(nonce: record.nonce))

        #expect(auth.isSignedIn)
    }

    @Test func aLinkThatSignsInWhileASendIsOutWins() async throws {
        let server = await makeServer()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await auth.sendEmailLink(to: EmailJSON.address)
        let record = try #require(store.pendingEmail)

        await server.close(EmailJSON.otpRoute)
        let resending = Task { await auth.sendEmailLink(to: EmailJSON.address) }
        #expect(await waitUntil { await sends(server).count == 2 })
        #expect(auth.isSendingEmail)

        // Google waits while a send is out.
        await auth.signInWithGoogle { _ in
            Issue.record("Google opened while a link was being sent")
            return AuthJSON.callback
        }
        #expect(auth.state == .signedOut)

        // The earlier email's link arrives and signs in first.
        await auth.handleOpenURL(emailCallback(nonce: record.nonce))
        #expect(auth.isSignedIn)

        await server.open(EmailJSON.otpRoute)
        await resending.value
        #expect(auth.isSignedIn)
        #expect(auth.emailSent == nil)
        #expect(auth.message == nil)
        #expect(store.pendingEmail == nil)
    }

    // MARK: Google beside it

    @Test func googlesCopyIsUnchangedWhenItsExchangeIsRefused() async {
        let server = await makeServer()
        await server.on(AuthJSON.exchangeRoute,
                        .status(422, "{\"code\":\"flow_state_expired\",\"message\":\"Flow state has expired\"}"))
        let auth = makeAuth(server, store: InMemoryTokenStore())

        await auth.signInWithGoogle { _ in AuthJSON.callback }

        #expect(auth.state == .signedOut)
        #expect(auth.message == "Couldn't sign in. Try again.")
        #expect(AuthStore.googleMessage(for: AuthError.exchange(status: 500, code: nil)) == "Couldn't sign in. Try again.")
    }

    @Test func signingInWithGoogleEndsAnEmailSignInSoItsLinkMovesNothingLater() async throws {
        let server = await makeServer()
        await server.on(AuthJSON.logoutRoute, .status(204, ""))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await auth.sendEmailLink(to: EmailJSON.address)
        let record = try #require(store.pendingEmail)

        await auth.signInWithGoogle { _ in AuthJSON.callback }

        #expect(auth.isSignedIn)
        #expect(store.pendingEmail == nil)
        #expect(auth.emailSent == nil)

        await auth.signOut()
        // The email's link has nothing left to finish.
        await auth.handleOpenURL(emailCallback(nonce: record.nonce))
        #expect(auth.state == .signedOut)
        #expect(auth.message == nil)
    }

    // MARK: The app

    @Test func theAppOwnsItsCallbackScheme() {
        let types = Bundle.main.infoDictionary?["CFBundleURLTypes"] as? [[String: Any]] ?? []
        let schemes = types.flatMap { $0["CFBundleURLSchemes"] as? [String] ?? [] }
        #expect(schemes.contains(GoTrue.callbackScheme))
    }
}

/// Stands in for the Keychain: one item per account, every call recorded.
@MainActor
private final class FakeKeychain: KeychainBackend {
    private(set) var items: [String: Data] = [:]
    private(set) var calls: [String] = []
    var failAdds = false

    func seed(_ account: String, _ data: Data) {
        items[account] = data
    }

    func copyData(_ query: [String: Any]) -> Data? {
        let account = Self.account(query)
        calls.append("copy " + account)
        return items[account]
    }

    func add(_ attributes: [String: Any]) -> OSStatus {
        let account = Self.account(attributes)
        calls.append("add " + account)
        if failAdds { return errSecInteractionNotAllowed }
        items[account] = attributes[kSecValueData as String] as? Data
        return errSecSuccess
    }

    func delete(_ query: [String: Any]) {
        let account = Self.account(query)
        calls.append("delete " + account)
        items[account] = nil
    }

    /// "*" for a query that names no account, which would match every item.
    private static func account(_ query: [String: Any]) -> String {
        return query[kSecAttrAccount as String] as? String ?? "*"
    }
}

@MainActor
@Suite struct KeychainTokenStoreTests {
    private let session = AuthSession(accessToken: "a1", refreshToken: "r1", expiresAt: Date(timeIntervalSince1970: 1_790_003_600),
                                      userId: testUserID, email: "me@example.com")
    private let record = EmailSignIn(email: "me@example.com", verifier: "verifier", nonce: "nonce",
                                     sentAt: Date(timeIntervalSince1970: 1_790_000_000))

    private func defaults() -> UserDefaults {
        return UserDefaults(suiteName: "dsul-tests-" + UUID().uuidString)!
    }

    @Test func aFreshInstallDeletesWhatAnEarlierOneLeftAndReadsNothing() {
        let keychain = FakeKeychain()
        keychain.seed("session", Data("old".utf8))
        keychain.seed("pendingEmail", Data("old".utf8))
        let store = KeychainTokenStore(defaults: defaults(), keychain: keychain)

        #expect(store.load() == nil)
        #expect(store.loadPendingEmail() == nil)

        #expect(keychain.calls == ["delete session", "delete pendingEmail"])
        #expect(keychain.items.isEmpty)
    }

    @Test func aSignedOutLaunchTouchesNoKeychain() {
        let keychain = FakeKeychain()
        let defaults = defaults()
        defaults.set(true, forKey: KeychainTokenStore.installSeenKey)
        let store = KeychainTokenStore(defaults: defaults, keychain: keychain)

        #expect(store.load() == nil)
        #expect(store.loadPendingEmail() == nil)
        #expect(keychain.calls.isEmpty)
    }

    @Test func eachRecordIsItsOwnItem() throws {
        let keychain = FakeKeychain()
        let store = KeychainTokenStore(defaults: defaults(), keychain: keychain)
        try store.save(session)
        try store.savePendingEmail(record)
        #expect(store.load() == session)
        #expect(store.loadPendingEmail() == record)

        store.clear()
        #expect(store.load() == nil)
        #expect(store.loadPendingEmail() == record)

        try store.save(session)
        store.clearPendingEmail()
        #expect(store.load() == session)
        #expect(store.loadPendingEmail() == nil)

        // No call ever named no account.
        #expect(!keychain.calls.contains { $0.hasSuffix(" *") })
    }

    @Test func aRecordTheKeychainRefusedIsNeverReadBack() {
        let keychain = FakeKeychain()
        let defaults = defaults()
        let store = KeychainTokenStore(defaults: defaults, keychain: keychain)
        keychain.failAdds = true

        var refused: Error? = nil
        do {
            try store.savePendingEmail(record)
        } catch {
            refused = error
        }
        #expect(refused is KeychainError)
        #expect(!defaults.bool(forKey: KeychainTokenStore.pendingEmailInUseKey))
        #expect(store.loadPendingEmail() == nil)
    }
}
