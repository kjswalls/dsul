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

/// `jsonBody` without the cast, for a nested body (the name write).
private func jsonObject(_ request: URLRequest?) -> [String: Any]? {
    guard let data = request?.httpBody,
          let object = try? JSONSerialization.jsonObject(with: data, options: []),
          let dict = object as? [String: Any]
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

    @Test func theIdTokenGrantSendsTheTokenTheRawNonceAndApple() throws {
        let request = try #require(GoTrue.idTokenRequest(config: config, idToken: "eyJ.apple.token", nonce: "raw-nonce-1"))
        expectGoTrueHeaders(request, "id_token")
        #expect(request.url?.path == "/auth/v1/token")
        #expect(queryItems(request.url) == ["grant_type": "id_token"])
        let c = try #require(request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) })
        #expect(c.percentEncodedQuery == "grant_type=id_token")
        // The RAW nonce, which GoTrue hashes itself. No access_token, client_id,
        // issuer or link_identity: a sign-in, never a link.
        #expect(jsonBody(request) == ["id_token": "eyJ.apple.token", "nonce": "raw-nonce-1", "provider": "apple"])
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func theNameWriteIsAPutOfUserMetadata() throws {
        let request = try #require(GoTrue.userNameRequest(config: config, accessToken: "a1", fullName: "Kirby Fox"))
        #expect(request.httpMethod == "PUT")
        #expect(request.url?.path == "/auth/v1/user")
        #expect(request.url?.query == nil)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer a1")
        #expect(request.value(forHTTPHeaderField: "apikey") == "anon-key")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "X-Supabase-Api-Version") == "2024-01-01")
        // Only `data`, with only the two keys GoTrue's Apple callback writes:
        // user_metadata takes them key by key and keeps the rest.
        let body = try #require(jsonObject(request))
        #expect(body.keys.sorted() == ["data"])
        let data = body["data"] as? [String: String]
        #expect(data == ["full_name": "Kirby Fox", "name": "Kirby Fox"])
    }
}

@Suite struct SessionTests {
    private let received = Date(timeIntervalSince1970: 1_790_000_000)

    private func body(user: String = "6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b", email: String = "kirby@example.com") -> Data {
        let json = """
        {"access_token":"at","token_type":"bearer","expires_in":3600,"expires_at":1790003600,
         "refresh_token":"rt","user":{"id":"\(user)","email":"\(email)","aud":"authenticated"}}
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

    @Test func theAppleUserIdRoundTrips() throws {
        var s = try Session.decode(body(), receivedAt: received)
        s.appleUserId = "001234.dsul.0001"
        let blob = try JSONEncoder().encode(s)
        let back = try JSONDecoder().decode(Session.self, from: blob)
        #expect(back == s)
        #expect(back.appleUserId == "001234.dsul.0001")
    }

    @Test func aBlobSavedBeforeAppleStillLoads() throws {
        // A session with no Apple id writes the blob it always did: no key.
        let s = try Session.decode(body(), receivedAt: received)
        let blob = try JSONEncoder().encode(s)
        let object = try JSONSerialization.jsonObject(with: blob, options: [])
        let fields = try #require(object as? [String: Any])
        #expect(fields.keys.sorted() == ["accessToken", "email", "expiresAt", "refreshToken", "userId"])
        #expect(try JSONDecoder().decode(Session.self, from: blob) == s)
        // And a blob as a Keychain holds it today, written out by hand.
        let saved = #"{"accessToken":"at","refreshToken":"rt","expiresAt":811696400,"userId":"6F1C2A9E-3B4D-4E5F-8A6B-7C8D9E0F1A2B","email":"kirby@example.com"}"#
        let loaded = try JSONDecoder().decode(Session.self, from: Data(saved.utf8))
        #expect(loaded.appleUserId == nil)
        #expect(loaded == s)
    }

    @Test func aTokenResponseLeavesTheAppleUserIdUnset() throws {
        #expect(try Session.decode(body(), receivedAt: received).appleUserId == nil)
    }

    @Test func aBlankEmailIsNoEmail() throws {
        // GoTrue writes "" for a user it made without an address.
        #expect(try Session.decode(body(email: ""), receivedAt: received).email == nil)
        #expect(try Session.decode(body(), receivedAt: received).email == "kirby@example.com")
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

@Suite struct EmailLinkRequestTests {
    private let nonce = "AbCdEfGhIjKlMnOpQrStUv"

    @Test func theRedirectAsksForThePageAndCarriesTheNonce() {
        #expect(GoTrue.emailRedirect(from: "https://do.dsul.app/auth/ios", nonce: nonce)
            == "https://do.dsul.app/auth/ios?via=email&n=AbCdEfGhIjKlMnOpQrStUv")
    }

    @Test func theSendAsksForALinkBoundToTheChallenge() throws {
        let redirect = GoTrue.emailRedirect(from: GoTrue.redirectTo, nonce: nonce)
        let request = try #require(GoTrue.otpRequest(config: config, email: "me@example.com",
                                                     codeChallenge: "challenge-1", redirectTo: redirect))
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "apikey") == "anon-key")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "X-Supabase-Api-Version") == "2024-01-01")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(request.url?.path == "/auth/v1/otp")
        // redirect_to rides in the query, where GoTrue reads it, whole.
        #expect(queryItems(request.url) == ["redirect_to": redirect])
        let c = try #require(request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) })
        #expect(c.percentEncodedQuery == "redirect_to=https%3A%2F%2Fdo.dsul.app%2Fauth%2Fios%3Fvia%3Demail%26n%3D" + nonce)
        // create_user is left to GoTrue's default, as the web sends it.
        #expect(jsonBody(request) == [
            "email": "me@example.com",
            "code_challenge": "challenge-1",
            "code_challenge_method": "s256",
        ])
    }

    @Test func anErrorBodysCodeIsRead() {
        func code(_ json: String) -> String? { GoTrue.errorCode(in: Data(json.utf8)) }
        #expect(code(#"{"code":"over_email_send_rate_limit","message":"x"}"#) == "over_email_send_rate_limit")
        // Without the API version header GoTrue puts the status in `code`.
        #expect(code(#"{"code":429,"error_code":"over_email_send_rate_limit","msg":"x"}"#) == "over_email_send_rate_limit")
        #expect(code(#"{"error_code":"flow_state_expired"}"#) == "flow_state_expired")
        #expect(code(#"{"code":"","error_code":"otp_expired"}"#) == "otp_expired")
        #expect(code(#"{"message":"x"}"#) == nil)
        #expect(code("<html>Bad gateway</html>") == nil)
        #expect(code("") == nil)
    }
}

@Suite struct EmailSignInTests {
    private let sent = Date(timeIntervalSince1970: 1_790_000_000)

    @Test func aFreshRecordHasItsOwnVerifierAndNonce() {
        let a = EmailSignIn.start(email: "me@example.com", now: sent)
        let b = EmailSignIn.start(email: "me@example.com", now: sent)
        #expect(a.verifier.count == 43)
        #expect(a.nonce.count == 22)
        #expect(a.verifier != b.verifier)
        #expect(a.nonce != b.nonce)
        #expect(a.sentAt == sent)
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        #expect(a.nonce.allSatisfy { allowed.contains($0) })
    }

    @Test func itIsLiveForAnHourAfterTheLatestSend() {
        let r = EmailSignIn(email: "me@example.com", verifier: "v", nonce: "n", sentAt: sent)
        #expect(r.isLive(now: sent))
        #expect(r.isLive(now: sent.addingTimeInterval(3599)))
        #expect(!r.isLive(now: sent.addingTimeInterval(3600)))
        // A clock set back a little still counts; a send from the future doesn't.
        #expect(r.isLive(now: sent.addingTimeInterval(-60)))
        #expect(!r.isLive(now: sent.addingTimeInterval(-61)))
    }

    @Test func aResendToTheSameAddressKeepsTheVerifierAndNonce() {
        let first = EmailSignIn.start(email: "me@example.com", now: sent)
        let later = sent.addingTimeInterval(120)
        let again = EmailSignIn.forSend(to: "ME@example.com", existing: first, now: later)
        #expect(again.verifier == first.verifier)
        #expect(again.nonce == first.nonce)
        #expect(again.email == first.email)
        #expect(again.sentAt == later)
    }

    @Test func anotherAddressOrALapsedRecordStartsAfresh() {
        let first = EmailSignIn.start(email: "me@example.com", now: sent)
        let other = EmailSignIn.forSend(to: "you@example.com", existing: first, now: sent)
        #expect(other.verifier != first.verifier)
        #expect(other.nonce != first.nonce)
        #expect(other.email == "you@example.com")
        let lapsed = EmailSignIn.forSend(to: "me@example.com", existing: first, now: sent.addingTimeInterval(3600))
        #expect(lapsed.verifier != first.verifier)
        let none = EmailSignIn.forSend(to: "me@example.com", existing: nil, now: sent)
        #expect(none.email == "me@example.com")
    }

    @Test func itRoundTripsThroughItsBlob() throws {
        let r = EmailSignIn(email: "me@example.com", verifier: "verifier", nonce: "nonce", sentAt: sent)
        let blob = try JSONEncoder().encode(r)
        #expect(try JSONDecoder().decode(EmailSignIn.self, from: blob) == r)
    }

    @Test func anAddressIsTrimmedAndLowercasedAsGoTrueKeepsIt() {
        #expect(normalizedEmail("  Me@Example.COM\n") == "me@example.com")
        #expect(normalizedEmail("first.last+dsul@mail.example.co.uk") == "first.last+dsul@mail.example.co.uk")
    }

    @Test(arguments: [
        "", "   ", "me", "me@", "@example.com", "me@example", "me@@example.com", "me@ex@ample.com",
        "me@example.", "me@.example.com", "me@example..com", "m e@example.com", "me@exa\tmple.com",
        "me@example.com\u{0}",
    ])
    func somethingThatCannotBeAnAddressIsRefused(_ raw: String) {
        #expect(normalizedEmail(raw) == nil)
    }

    @Test func aVeryLongAddressIsRefused() {
        let local = String(repeating: "a", count: 243)
        #expect(normalizedEmail(local + "@example.com") == nil)   // 255 bytes
        #expect(normalizedEmail(String(local.dropFirst()) + "@example.com") != nil)   // 254
    }
}

@Suite struct EmailCallbackTests {
    private let nonce = "AbCdEfGhIjKlMnOpQrStUv"

    private func parse(_ s: String) -> EmailCallback? {
        guard let url = URL(string: s) else { return nil }
        return parseEmailCallback(url)
    }

    @Test func aCodeComesBackWithItsNonce() {
        #expect(parse("app.dsul.ios://auth/callback?code=abc123-_.~XYZ&n=\(nonce)")
            == EmailCallback(result: .code("abc123-_.~XYZ"), nonce: nonce))
    }

    @Test func anErrorComesBackWithItsNonce() {
        #expect(parse("app.dsul.ios://auth/callback?error_code=otp_expired&n=\(nonce)")
            == EmailCallback(result: .error("otp_expired"), nonce: nonce))
    }

    @Test func googlesParserRefusesTheEmailShapeAndThisOneRefusesGoogles() {
        let email = URL(string: "app.dsul.ios://auth/callback?code=abcdefgh&n=\(nonce)")!
        #expect(parseCallback(email) == nil)
        let google = URL(string: "app.dsul.ios://auth/callback?code=abcdefgh")!
        #expect(parseEmailCallback(google) == nil)
    }

    @Test(arguments: [
        "app.dsul.ios://auth/callback?n=AbCdEfGhIjKlMnOpQrStUv&code=abcdefgh",  // the page's order only
        "app.dsul.ios://auth/callback?code=abcdefgh&n=AbCdEfGhIjKlMnO",  // 15 characters
        "app.dsul.ios://auth/callback?code=abcdefgh&n=" + String(repeating: "a", count: 65),
        "app.dsul.ios://auth/callback?code=abcdefgh&n=AbCdEfGhIjKlMnOp.rStUv",
        "app.dsul.ios://auth/callback?code=abcdefgh&n=AbCdEfGhIjKlMnOp%41rStUv",
        "app.dsul.ios://auth/callback?code=abcdefgh&n=",
        "app.dsul.ios://auth/callback?code=abcdefgh&nonce=AbCdEfGhIjKlMnOpQrStUv",
        "app.dsul.ios://auth/callback?code=abcdefgh&n=AbCdEfGhIjKlMnOpQrStUv&x=1",
        "app.dsul.ios://auth/callback?code=abcdefgh&n=AbCdEfGhIjKlMnOpQrStUv#frag",
        "app.dsul.ios://auth/callback?code=abcdefg&n=AbCdEfGhIjKlMnOpQrStUv",  // 7-character code
        "app.dsul.ios://auth/callback?error_code=Otp_Expired&n=AbCdEfGhIjKlMnOpQrStUv",
        "app.dsul.ios://auth/callback?error=access_denied&n=AbCdEfGhIjKlMnOpQrStUv",
        "app.dsul.ios://auth/callback?access_token=abcdefgh&n=AbCdEfGhIjKlMnOpQrStUv",
        "app.dsul.ios://auth/other?code=abcdefgh&n=AbCdEfGhIjKlMnOpQrStUv",
        "dsul://auth/callback?code=abcdefgh&n=AbCdEfGhIjKlMnOpQrStUv",
        "app.dsul.ios://me@auth/callback?code=abcdefgh&n=AbCdEfGhIjKlMnOpQrStUv",
    ])
    func anythingElseIsRefused(_ s: String) {
        #expect(parse(s) == nil)
    }
}

@Suite struct AppleNonceTests {
    @Test func theNonceIsBase64URLOfItsBytes() {
        let bytes: [UInt8] = Array(0..<32)
        #expect(AppleSignIn.makeNonce(bytes: bytes) == "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8")
    }

    @Test func aFreshNonceIs43URLSafeCharacters() {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        let a = AppleSignIn.makeNonce()
        let b = AppleSignIn.makeNonce()
        #expect(a.count == 43)
        #expect(b.count == 43)
        #expect(a.allSatisfy { allowed.contains($0) })
        #expect(b.allSatisfy { allowed.contains($0) })
        #expect(a != b)
    }

    @Test func theHashIsLowercaseHexOfTheRawNoncesUTF8() {
        var seen: Data?
        let hash = AppleSignIn.hashedNonce("abc") { input in
            seen = input
            return Data([0x00, 0xAB, 0xFF])
        }
        #expect(seen == Data("abc".utf8))
        #expect(hash == "00abff")
        // A SHA-256's 32 bytes are Apple's 64 characters.
        let full = AppleSignIn.hashedNonce("abc") { _ in Data(repeating: 0xA5, count: 32) }
        #expect(full == String(repeating: "a5", count: 32))
    }

    #if canImport(CryptoKit)
    @Test func theHashIsWhatGoTrueComputes() {
        // fmt.Sprintf("%x", sha256.Sum256([]byte("abc"))), token_oidc.go's check.
        let hash = AppleSignIn.hashedNonce("abc") { Data(SHA256.hash(data: $0)) }
        #expect(hash == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }
    #endif
}

@Suite struct AppleNameTests {
    @Test func givenAndFamilyJoinAsGoTrueJoinsThem() {
        #expect(AppleSignIn.fullName(given: "Kirby", family: "Fox") == "Kirby Fox")
    }

    @Test func eitherHalfIsEnough() {
        #expect(AppleSignIn.fullName(given: "Kirby", family: nil) == "Kirby")
        #expect(AppleSignIn.fullName(given: nil, family: "Fox") == "Fox")
    }

    @Test func nothingIsNoName() {
        #expect(AppleSignIn.fullName(given: nil, family: nil) == nil)
        #expect(AppleSignIn.fullName(given: " ", family: "") == nil)
        #expect(AppleSignIn.fullName(given: "\u{0}", family: "\n") == nil)
    }

    @Test func controlCharactersGo() {
        #expect(AppleSignIn.fullName(given: "Kir\u{0}by\u{7}", family: "Fox") == "Kirby Fox")
        #expect(AppleSignIn.fullName(given: "\u{85}Kir\tby", family: "Fox\u{9F}") == "Kirby Fox")
        // Only Cc: the joiner inside an emoji (Cf) stays.
        #expect(AppleSignIn.fullName(given: "Kirby", family: "\u{1F469}\u{200D}\u{1F4BB}")
            == "Kirby \u{1F469}\u{200D}\u{1F4BB}")
    }

    @Test func innerSpacesStayAsGoTrueKeepsThem() {
        #expect(AppleSignIn.fullName(given: " Kirby ", family: " Fox ") == "Kirby   Fox")
    }

    @Test func aNameOverTheLimitIsNotSaved() {
        #expect(AppleSignIn.nameLimit == 200)
        let longest = String(repeating: "a", count: 200)
        #expect(AppleSignIn.fullName(given: longest, family: nil) == longest)
        #expect(AppleSignIn.fullName(given: longest + "a", family: nil) == nil)
        // The limit is the joined name's, after the trim.
        #expect(AppleSignIn.fullName(given: longest + "  ", family: "") == longest)
        let half = String(repeating: "a", count: 100)
        #expect(AppleSignIn.fullName(given: half, family: String(repeating: "b", count: 99)) != nil)
        #expect(AppleSignIn.fullName(given: half, family: String(repeating: "b", count: 100)) == nil)
        // One Character of 601 bytes: a count of Characters would let it through.
        let stacked = "e" + String(repeating: "\u{0301}", count: 300)
        #expect(stacked.count == 1)
        #expect(stacked.utf8.count == 601)
        #expect(AppleSignIn.fullName(given: stacked, family: nil) == nil)
    }

    @Test func aNameIsMeasuredInBytesNotLetters() {
        // Four letters of three bytes each, 13 bytes with the space: kept.
        #expect(AppleSignIn.fullName(given: "\u{5c71}\u{7530}", family: "\u{592a}\u{90ce}")
            == "\u{5c71}\u{7530} \u{592a}\u{90ce}")
        // 66 of them are 198 bytes; 67 are 201, though far fewer than 200 letters.
        let mountain = "\u{5c71}"
        #expect(AppleSignIn.fullName(given: String(repeating: mountain, count: 66), family: nil) != nil)
        #expect(AppleSignIn.fullName(given: String(repeating: mountain, count: 67), family: nil) == nil)
    }
}

@Suite struct DisplayNameTests {
    /// A token response whose user has `metadata` as its user_metadata, or no
    /// such key when nil.
    private func name(_ metadata: String?) -> String? {
        let meta = metadata.map { #","user_metadata":"# + $0 } ?? ""
        let json = #"{"access_token":"at","token_type":"bearer","expires_in":3600,"refresh_token":"rt","#
            + #""user":{"id":"6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b","email":"kirby@example.com""# + meta + "}}"
        return GoTrue.displayName(in: Data(json.utf8))
    }

    @Test func fullNameComesFirst() {
        #expect(name(#"{"full_name":"Kirby Fox","name":"Kirby"}"#) == "Kirby Fox")
        #expect(name(#"{"full_name":" Kirby Fox\n","name":"Kirby"}"#) == "Kirby Fox")
        #expect(name(#"{"name":"Kirby"}"#) == "Kirby")
    }

    @Test func aBlankFullNameFallsThroughToName() {
        #expect(name(#"{"full_name":"","name":"Kirby"}"#) == "Kirby")
        #expect(name(#"{"full_name":" \t","name":"Kirby"}"#) == "Kirby")
        #expect(name(#"{"full_name":"  ","name":"  "}"#) == nil)
    }

    @Test func aNonStringFallsThrough() {
        #expect(name(#"{"full_name":3,"name":" Kirby\n"}"#) == "Kirby")
        #expect(name(#"{"full_name":null,"name":"Kirby"}"#) == "Kirby")
        #expect(name(#"{"full_name":["Kirby"],"name":true}"#) == nil)
    }

    @Test func noMetadataIsNoName() {
        #expect(name(nil) == nil)
        #expect(name("null") == nil)
        #expect(name(#"{"email":"kirby@example.com","email_verified":true}"#) == nil)
    }

    @Test func aBodyThatIsNotJSONIsNoName() {
        #expect(GoTrue.displayName(in: Data("<html>Bad gateway</html>".utf8)) == nil)
        #expect(GoTrue.displayName(in: Data()) == nil)
        #expect(GoTrue.displayName(in: Data(#"{"code":"unexpected_failure","message":"x"}"#.utf8)) == nil)
    }
}

@Suite struct AppleRefusalTests {
    @Test func appleRefusalsReadTheirCode() {
        func code(_ json: String) -> String? { GoTrue.errorCode(in: Data(json.utf8)) }
        // The provider switched off: an HTTPError, with its code under API version 2024-01-01.
        #expect(code(#"{"code":"provider_disabled","message":"Provider (issuer \"https://appleid.apple.com\") is not enabled"}"#)
            == "provider_disabled")
        // The token's own refusals are OAuthErrors, which carry no code.
        #expect(code(#"{"error":"invalid request","error_description":"Unacceptable audience in id_token: [app.dsul.ios]"}"#) == nil)
        #expect(code(#"{"error":"invalid nonce","error_description":"Nonces mismatch"}"#) == nil)
        #expect(code(#"{"error":"invalid request","error_description":"Bad ID token"}"#) == nil)
    }
}
