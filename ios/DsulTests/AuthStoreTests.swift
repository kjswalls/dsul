import Foundation
import Testing
@testable import Dsul

/// GoTrue and /api/app/config bodies, and the routes AuthStore calls.
enum AuthJSON {
    static let config = "{\"supabaseUrl\":\"https://example.supabase.co\",\"anonKey\":\"anon-key\"}"
    static let rotatedConfig = "{\"supabaseUrl\":\"https://example.supabase.co\",\"anonKey\":\"anon-key-2\"}"

    static let configRoute = "GET /api/app/config"
    static let exchangeRoute = "POST /auth/v1/token?grant_type=pkce"
    static let refreshRoute = "POST /auth/v1/token?grant_type=refresh_token"
    static let logoutRoute = "POST /auth/v1/logout?scope=local"

    static let callback = URL(string: "app.dsul.ios://auth/callback?code=code-1234")!

    /// A token response as GoTrue sends it (snake_case).
    static func token(access: String, refresh: String, expiresIn: Int = 3600,
                      email: String = "kirby@example.com") -> String {
        return "{\"access_token\":\"\(access)\",\"token_type\":\"bearer\",\"expires_in\":\(expiresIn),"
            + "\"expires_at\":0,\"refresh_token\":\"\(refresh)\","
            + "\"user\":{\"id\":\"\(lowerID(testUserID))\",\"email\":\"\(email)\"}}"
    }
}

@MainActor
@Suite struct AuthStoreTests {
    /// An AuthStore on `server`, with its own empty defaults and no waiting
    /// between refresh retries.
    private func makeAuth(_ server: FakeServer, store: InMemoryTokenStore, deviceId: String? = nil) -> AuthStore {
        let defaults = UserDefaults(suiteName: "dsul-tests-" + UUID().uuidString)!
        let config = SupabaseConfigStore(origin: URL(string: "https://dsul.test")!, defaults: defaults,
                                         transport: server.transport)
        let auth = AuthStore(tokenStore: store, configStore: config, transport: server.transport,
                             sleep: { _ in }, deviceId: deviceId)
        store.observedAuth = auth
        return auth
    }

    /// Google, faked: the sheet comes straight back with a code.
    private func signIn(_ auth: AuthStore) async {
        await auth.signInWithGoogle { _ in
            return AuthJSON.callback
        }
    }

    /// The config and an exchange that answers `a1`/`r1`.
    private func serverForSignIn(expiresIn: Int = 3600) async -> FakeServer {
        let server = FakeServer()
        await server.on(AuthJSON.configRoute, .status(200, AuthJSON.config))
        await server.on(AuthJSON.exchangeRoute,
                        .status(200, AuthJSON.token(access: "a1", refresh: "r1", expiresIn: expiresIn)))
        return server
    }

    @Test func aSignedOutLaunchAsksNothing() async {
        let server = FakeServer()
        let auth = makeAuth(server, store: InMemoryTokenStore())
        #expect(auth.state == .signedOut)
        #expect(auth.gateKey == "signed-out")
        let requests = await server.requests
        #expect(requests.isEmpty)
    }

    @Test func signingInKeepsTheTokensBeforeCountingItselfSignedIn() async {
        let server = await serverForSignIn()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)

        var opened: URL? = nil
        await auth.signInWithGoogle { url in
            opened = url
            return AuthJSON.callback
        }

        #expect(auth.isSignedIn)
        #expect(auth.email == "kirby@example.com")
        #expect(auth.gateKey == "user:" + testUserID.uuidString)
        #expect(store.session?.accessToken == "a1")
        #expect(store.stateAtSave == [.signingIn])
        #expect(auth.takeWelcome() == "kirby@example.com")
        #expect(auth.takeWelcome() == nil)

        // The sheet opened GoTrue's authorize page with an S256 challenge.
        let items: [URLQueryItem] = opened.flatMap {
            URLComponents(url: $0, resolvingAgainstBaseURL: false)?.queryItems
        } ?? []
        #expect(opened?.absoluteString.hasPrefix("https://example.supabase.co/auth/v1/authorize?") == true)
        #expect(items.first { $0.name == "provider" }?.value == "google")
        #expect(items.first { $0.name == "code_challenge" }?.value?.count == 43)
        #expect(items.first { $0.name == "code_challenge_method" }?.value == "s256")
        #expect(items.first { $0.name == "redirect_to" }?.value?.hasSuffix("/auth/ios") == true)

        // The exchange carried the code, the verifier and the anon key.
        let requests = await server.requests
        let exchange = requests.first { $0.route == AuthJSON.exchangeRoute }
        let body = bodyJSON(exchange)
        #expect(body?["auth_code"] as? String == "code-1234")
        #expect((body?["code_verifier"] as? String)?.count == 43)
        #expect(exchange?.headers["apikey"] == "anon-key")
        #expect(exchange?.headers["x-supabase-api-version"] == "2024-01-01")
    }

    @Test func concurrentCallersShareOneRefresh() async throws {
        let server = await serverForSignIn(expiresIn: 30)   // inside the leeway: due now
        await server.on(AuthJSON.refreshRoute, .status(200, AuthJSON.token(access: "a2", refresh: "r2")))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await signIn(auth)
        await server.setDelay(.milliseconds(20))

        let one = Task { try await auth.accessToken() }
        let two = Task { try await auth.accessToken() }
        let three = Task { try await auth.accessToken() }
        let tokens: [String] = [try await one.value, try await two.value, try await three.value]

        #expect(tokens == ["a2", "a2", "a2"])
        let refreshes = await server.count(AuthJSON.refreshRoute)
        #expect(refreshes == 1)
        #expect(store.session?.refreshToken == "r2")
        #expect(auth.session?.accessToken == "a2")
    }

    @Test func aRefreshThatFailsForWantOfAServerRetriesWithTheSameToken() async throws {
        let server = await serverForSignIn(expiresIn: 30)
        await server.on(AuthJSON.refreshRoute,
                        .status(503, "{}"),
                        .offline,
                        .status(200, AuthJSON.token(access: "a2", refresh: "r2")))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await signIn(auth)

        let token = try await auth.accessToken()

        #expect(token == "a2")
        let requests = await server.requests
        let refreshes = requests.filter { $0.route == AuthJSON.refreshRoute }
        #expect(refreshes.count == 3)
        #expect(refreshes.allSatisfy { bodyJSON($0)?["refresh_token"] as? String == "r1" })
        #expect(auth.isSignedIn)
    }

    @Test func aRefreshThatNeverRecoversKeepsTheSession() async {
        let server = await serverForSignIn(expiresIn: 30)
        await server.on(AuthJSON.refreshRoute, .status(500, "{}"))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await signIn(auth)

        var thrown: Error? = nil
        do {
            _ = try await auth.accessToken()
        } catch {
            thrown = error
        }

        #expect((thrown as? AuthError) == .unavailable)
        #expect(auth.isSignedIn)
        #expect(store.session?.refreshToken == "r1")
        let refreshes = await server.count(AuthJSON.refreshRoute)
        #expect(refreshes == 1 + AuthStore.refreshRetryDelays.count)
    }

    @Test func aTerminalRefreshFailureSignsOutAndWipes() async {
        let server = await serverForSignIn(expiresIn: 30)
        await server.on(AuthJSON.refreshRoute,
                        .status(400, "{\"code\":\"refresh_token_not_found\",\"msg\":\"Invalid Refresh Token\"}"))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await signIn(auth)

        var thrown: Error? = nil
        do {
            _ = try await auth.accessToken()
        } catch {
            thrown = error
        }

        #expect((thrown as? AuthError) == .signedOut)
        #expect(auth.state == .signedOut)
        #expect(store.session == nil)
        #expect(auth.message != nil)
        let refreshes = await server.count(AuthJSON.refreshRoute)
        #expect(refreshes == 1)
    }

    @Test func aCancelledSignInIsSilent() async {
        let server = await serverForSignIn()
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)

        await auth.signInWithGoogle { _ in
            throw CancellationError()
        }

        #expect(auth.state == .signedOut)
        #expect(auth.message == nil)
        #expect(store.session == nil)
        let exchanges = await server.count(AuthJSON.exchangeRoute)
        #expect(exchanges == 0)
    }

    @Test func aRefusalFromGoogleSaysSo() async {
        let server = await serverForSignIn()
        let auth = makeAuth(server, store: InMemoryTokenStore())

        await auth.signInWithGoogle { _ in
            return URL(string: "app.dsul.ios://auth/callback?error_code=access_denied")!
        }

        #expect(auth.state == .signedOut)
        #expect(auth.message == "Google sign-in was cancelled.")
        let exchanges = await server.count(AuthJSON.exchangeRoute)
        #expect(exchanges == 0)
    }

    @Test func signingOutEndsOnlyThisSessionAndWipesEvenOffline() async {
        let server = await serverForSignIn()
        await server.on(AuthJSON.logoutRoute, .offline)
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store)
        await signIn(auth)
        #expect(store.session != nil)

        await auth.signOut()

        #expect(auth.state == .signedOut)
        #expect(auth.message == nil)
        #expect(store.session == nil)
        let requests = await server.requests
        let logout = requests.first { $0.route.hasPrefix("POST /auth/v1/logout") }
        #expect(logout?.route == AuthJSON.logoutRoute)
        #expect(logout?.headers["authorization"] == "Bearer a1")
        #expect(logout?.headers["apikey"] == "anon-key")
    }

    /// Sign out releases this iPhone's registry row with the ending token,
    /// before the GoTrue logout ends it, and the wipe still comes first.
    @Test func signingOutReleasesThisDeviceBeforeTheLogout() async {
        let device = "ios:0b7c2f9a-1d3e-4c5b-9a8f-7e6d5c4b3a21"
        let release = "DELETE /api/app/devices/" + device
        let server = await serverForSignIn()
        await server.on(release, .status(200, "{\"ok\":true}"))
        await server.on(AuthJSON.logoutRoute, .status(204, ""))
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store, deviceId: device)
        await signIn(auth)

        await auth.signOut()

        #expect(auth.state == .signedOut)
        #expect(store.session == nil)
        let routes = await server.requests.map(\.route)
        let released = routes.firstIndex(of: release)
        let loggedOut = routes.firstIndex(of: AuthJSON.logoutRoute)
        #expect(released != nil)
        #expect(loggedOut != nil)
        if let released, let loggedOut { #expect(released < loggedOut) }
        let request = await server.requests.first { $0.route == release }
        #expect(request?.headers["authorization"] == "Bearer a1")
    }

    /// Offline, the release fails quietly and the logout is still sent.
    @Test func anOfflineReleaseStillLogsOut() async {
        let device = "ios:0b7c2f9a-1d3e-4c5b-9a8f-7e6d5c4b3a21"
        let server = await serverForSignIn()
        await server.on("DELETE /api/app/devices/" + device, .offline)
        let store = InMemoryTokenStore()
        let auth = makeAuth(server, store: store, deviceId: device)
        await signIn(auth)

        await auth.signOut()

        #expect(auth.state == .signedOut)
        #expect(await server.count(AuthJSON.logoutRoute) == 1)
    }

    @Test func aSessionTheStoreCouldNotKeepIsHeldAndSavedLater() async throws {
        let server = await serverForSignIn()
        let store = InMemoryTokenStore()
        store.failSaves = true
        let auth = makeAuth(server, store: store)
        await signIn(auth)

        #expect(auth.isSignedIn)
        #expect(store.session == nil)

        store.failSaves = false
        let token = try await auth.accessToken()
        #expect(token == "a1")
        #expect(store.session?.accessToken == "a1")
    }

    @Test func aRotatedAnonKeyIsFetchedAgainOnce() async {
        let server = FakeServer()
        await server.on(AuthJSON.configRoute,
                        .status(200, AuthJSON.config), .status(200, AuthJSON.rotatedConfig))
        await server.on(AuthJSON.exchangeRoute,
                        .status(401, "{\"message\":\"Invalid API key\"}"),
                        .status(200, AuthJSON.token(access: "a1", refresh: "r1")))
        let auth = makeAuth(server, store: InMemoryTokenStore())
        await signIn(auth)

        #expect(auth.isSignedIn)
        let requests = await server.requests
        let keys: [String?] = requests.filter { $0.route == AuthJSON.exchangeRoute }.map { $0.headers["apikey"] }
        #expect(keys == ["anon-key", "anon-key-2"])
        let configs = await server.count(AuthJSON.configRoute)
        #expect(configs == 2)
    }

    @Test func theSampleNeedsNoAccount() async {
        let server = FakeServer()
        let auth = makeAuth(server, store: InMemoryTokenStore())

        auth.enterSample()
        #expect(auth.state == .sample)
        #expect(auth.gateKey == "sample")
        #expect(!auth.isSignedIn)

        await auth.signOut()   // "Leave sample data" from the same menu slot
        #expect(auth.state == .signedOut)
        let requests = await server.requests
        #expect(requests.isEmpty)
    }
}
