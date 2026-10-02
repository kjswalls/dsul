import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(CryptoKit)
import CryptoKit
#endif
import Testing
import DsulCore

// URLs are checked by component, never as whole strings: swift-foundation and
// Darwin's Foundation are free to encode the same URL differently.

private let config = GoTrueConfig(supabaseUrl: URL(string: "https://ref.supabase.co")!, anonKey: "anon-key")

private func queryItems(_ url: URL?) -> [String: String] {
    guard let url = url, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return [:] }
    var out: [String: String] = [:]
    for item in items { out[item.name] = item.value ?? "" }
    return out
}

private func jsonBody(_ request: URLRequest?) -> [String: String]? {
    guard let data = request?.httpBody,
          let object = try? JSONSerialization.jsonObject(with: data, options: []),
          let dict = object as? [String: String]
    else { return nil }
    return dict
}

@Suite struct PKCETests {
    // RFC 7636 Appendix B.
    private let appendixBytes: [UInt8] = [
        116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186,
        22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
    ]
    private let appendixVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"

    @Test func theVerifierIsBase64URLOfItsBytes() {
        #expect(PKCE.makeVerifier(bytes: appendixBytes) == appendixVerifier)
    }

    @Test func aFreshVerifierIs43URLSafeCharacters() {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        let a = PKCE.makeVerifier()
        let b = PKCE.makeVerifier()
        #expect(a.count == 43)
        #expect(a.allSatisfy { allowed.contains($0) })
        #expect(a != b)
    }

    @Test func theChallengeHashesTheVerifiersASCII() {
        var seen: Data?
        let challenge = PKCE.challenge(for: "abc") { input in
            seen = input
            return Data([0xFB, 0xFF, 0xFE])
        }
        #expect(seen == Data("abc".utf8))
        // base64 "+//+" → base64url "-__-".
        #expect(challenge == "-__-")
    }

    #if canImport(CryptoKit)
    @Test func theChallengeMatchesRFC7636AppendixB() {
        let challenge = PKCE.challenge(for: appendixVerifier) { Data(SHA256.hash(data: $0)) }
        #expect(challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }
    #endif
}

@Suite struct GoTrueRequestTests {
    @Test func theAuthorizeURLAsksGoogleWithAnS256Challenge() throws {
        let url = try #require(GoTrue.authorizeURL(config: config, codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"))
        let c = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(c.scheme == "https")
        #expect(c.host == "ref.supabase.co")
        #expect(c.path == "/auth/v1/authorize")
        #expect(queryItems(url) == [
            "provider": "google",
            "redirect_to": "https://do.dsul.app/auth/ios",
            "code_challenge": "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            "code_challenge_method": "s256",
        ])
        // The redirect is fully encoded, so no platform reads it as part of the path.
        #expect(c.percentEncodedQuery?.contains("redirect_to=https%3A%2F%2Fdo.dsul.app%2Fauth%2Fios") == true)
    }

    @Test func aTrailingSlashOnTheBaseIsNotDoubled() throws {
        let slashed = GoTrueConfig(supabaseUrl: URL(string: "https://ref.supabase.co/")!, anonKey: "k")
        let url = try #require(GoTrue.authorizeURL(config: slashed, codeChallenge: "x"))
        #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.path == "/auth/v1/authorize")
    }

    private func expectGoTrueHeaders(_ request: URLRequest, _ label: String) {
        #expect(request.httpMethod == "POST", "\(label)")
        #expect(request.value(forHTTPHeaderField: "apikey") == "anon-key", "\(label)")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json", "\(label)")
        #expect(request.value(forHTTPHeaderField: "X-Supabase-Api-Version") == "2024-01-01", "\(label)")
    }

    @Test func theExchangeSendsTheCodeAndVerifier() throws {
        let request = try #require(GoTrue.exchangeRequest(config: config, authCode: "code-123", codeVerifier: "verifier-456"))
        expectGoTrueHeaders(request, "exchange")
        #expect(request.url?.path == "/auth/v1/token")
        #expect(queryItems(request.url) == ["grant_type": "pkce"])
        #expect(jsonBody(request) == ["auth_code": "code-123", "code_verifier": "verifier-456"])
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func aRefreshSendsTheRefreshToken() throws {
        let request = try #require(GoTrue.refreshRequest(config: config, refreshToken: "rt-1"))
        expectGoTrueHeaders(request, "refresh")
        #expect(request.url?.path == "/auth/v1/token")
        #expect(queryItems(request.url) == ["grant_type": "refresh_token"])
        #expect(jsonBody(request) == ["refresh_token": "rt-1"])
    }

    @Test func signOutIsLocalAndBearsTheAccessToken() throws {
        let request = try #require(GoTrue.logoutRequest(config: config, accessToken: "at-1"))
        expectGoTrueHeaders(request, "logout")
        #expect(request.url?.path == "/auth/v1/logout")
        #expect(queryItems(request.url) == ["scope": "local"])
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer at-1")
    }
}

@Suite struct SessionTests {
    private let received = Date(timeIntervalSince1970: 1_790_000_000)

    private func body(user: String = "6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b") -> Data {
        let json = """
        {"access_token":"at","token_type":"bearer","expires_in":3600,"expires_at":1790003600,
         "refresh_token":"rt","user":{"id":"\(user)","email":"kirby@example.com","aud":"authenticated"}}
        """
        return Data(json.utf8)
    }

    @Test func expiryCountsFromWhenTheResponseArrived() throws {
        let s = try Session.decode(body(), receivedAt: received)
        #expect(s.accessToken == "at")
        #expect(s.refreshToken == "rt")
        #expect(s.expiresAt == received.addingTimeInterval(3600))
        #expect(s.userId == UUID(uuidString: "6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b"))
        #expect(s.email == "kirby@example.com")
    }

    @Test func refreshesASixtySecondsEarly() throws {
        let s = try Session.decode(body(), receivedAt: received)
        #expect(!s.needsRefresh(now: received))
        #expect(!s.needsRefresh(now: received.addingTimeInterval(3539)))
        #expect(s.needsRefresh(now: received.addingTimeInterval(3540)))
        #expect(s.needsRefresh(now: received.addingTimeInterval(7200)))
    }

    @Test func aUserIdThatIsNotAUUIDIsRefused() {
        #expect(throws: (any Error).self) {
            _ = try Session.decode(body(user: "nope"), receivedAt: received)
        }
    }

    @Test func roundTripsThroughItsOwnBlob() throws {
        let s = try Session.decode(body(), receivedAt: received)
        let blob = try JSONEncoder().encode(s)
        #expect(try JSONDecoder().decode(Session.self, from: blob) == s)
    }
}

@Suite struct RefreshFailureTests {
    private func classify(_ status: Int, _ json: String) -> RefreshFailure {
        return classifyRefreshFailure(status: status, body: Data(json.utf8))
    }

    @Test(arguments: [
        "refresh_token_not_found", "refresh_token_already_used", "session_not_found",
        "session_expired", "user_not_found",
    ])
    func aDeadSessionSignsOut(_ code: String) {
        #expect(classify(400, #"{"code":"\#(code)","message":"x"}"#) == .signedOut)
        #expect(classify(403, #"{"error_code":"\#(code)","msg":"x"}"#) == .signedOut)
    }

    @Test func theLegacyInvalidGrantSignsOutOnA400Only() {
        let legacy = #"{"error":"invalid_grant","error_description":"Invalid Refresh Token: Refresh Token Not Found"}"#
        #expect(classify(400, legacy) == .signedOut)
        #expect(classify(500, legacy) == .retry)
    }

    @Test func everythingElseRetries() {
        #expect(classify(429, #"{"code":"over_request_rate_limit","message":"x"}"#) == .retry)
        #expect(classify(500, #"{"code":"unexpected_failure","message":"x"}"#) == .retry)
        #expect(classify(502, "<html>Bad gateway</html>") == .retry)
        #expect(classify(503, "") == .retry)
        #expect(classify(400, #"{"code":"validation_failed","message":"x"}"#) == .retry)
    }
}

@Suite struct CallbackTests {
    private func parse(_ s: String) -> AuthCallback? {
        guard let url = URL(string: s) else { return nil }
        return parseCallback(url)
    }

    @Test func aCodeComesBack() {
        #expect(parse("app.dsul.ios://auth/callback?code=abc123-_.~XYZ") == .code("abc123-_.~XYZ"))
    }

    @Test func anErrorComesBackWithoutItsDescription() {
        #expect(parse("app.dsul.ios://auth/callback?error_code=access_denied") == .error("access_denied"))
    }

    @Test(arguments: [
        "dsul://auth/callback?code=abcdefgh",  // the desktop app's scheme
        "app.dsul.ios://other/callback?code=abcdefgh",
        "app.dsul.ios://auth/elsewhere?code=abcdefgh",
        "app.dsul.ios://auth/callback/?code=abcdefgh",
        "app.dsul.ios://auth/callback",
        "app.dsul.ios://auth/callback?",
        "app.dsul.ios://auth/callback?code=abcdefgh&state=x",
        "app.dsul.ios://auth/callback?code=abcdefgh#frag",
        "app.dsul.ios://auth:443/callback?code=abcdefgh",
        "app.dsul.ios://me@auth/callback?code=abcdefgh",
        "app.dsul.ios://auth/callback?code=abcdefg",  // 7 characters
        "app.dsul.ios://auth/callback?code=abc%41defgh",  // encoded, never decoded to pass
        "app.dsul.ios://auth/callback?code=abc+defgh",
        "app.dsul.ios://auth/callback?error=access_denied",
        "app.dsul.ios://auth/callback?error_code=Access_Denied",
        "app.dsul.ios://auth/callback?error_description=bad",
        "app.dsul.ios://auth/callback?access_token=abcdefgh",
        "app.dsul.ios://auth/callback?code=",
    ])
    func anythingElseIsRefused(_ s: String) {
        #expect(parse(s) == nil)
    }

    @Test func theCodeLengthBounds() {
        let longest = String(repeating: "a", count: 256)
        #expect(parse("app.dsul.ios://auth/callback?code=\(longest)") == .code(longest))
        #expect(parse("app.dsul.ios://auth/callback?code=\(longest)a") == nil)
        #expect(parse("app.dsul.ios://auth/callback?error_code=\(String(repeating: "e", count: 65))") == nil)
    }
}
