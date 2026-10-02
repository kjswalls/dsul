import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// The testable half of the iPhone's sign-in: Supabase Auth (GoTrue) spoken
// directly, with no SDK. Google OAuth through the authorization-code flow with
// PKCE (S256); the app opens `authorizeURL` in an ephemeral
// ASWebAuthenticationSession, GoTrue sends the browser to
// https://do.dsul.app/auth/ios (app/auth/ios/route.ts), which forwards the
// code to `app.dsul.ios://auth/callback?code=…`, and the app exchanges it with
// the verifier it kept in memory.
//
// What lives here is pure: the PKCE strings, the URLs and requests, the token
// response, expiry, how a failed refresh is read, and the callback check. The
// SHA-256 (CryptoKit), the Keychain and the auth session stay in the app.
// Every request carries `apikey` and pins the API version, so errors come back
// with a stable `code` (auth-js reads `code` from that version on).

public enum GoTrue {
    /// The `X-Supabase-Api-Version` every request sends.
    public static let apiVersion = "2024-01-01"
    /// The app's own callback scheme. Not `dsul://`, which the desktop app owns.
    public static let callbackScheme = "app.dsul.ios"
    /// Where GoTrue sends the browser after Google: app/auth/ios/route.ts, which
    /// 302s a well-formed code on to `callbackScheme`.
    public static let redirectTo = "https://do.dsul.app/auth/ios"
    /// A token is refreshed this many seconds before it expires.
    public static let refreshLeeway: TimeInterval = 60
}

// MARK: - PKCE (RFC 7636)

/// RFC 4648 §5 base64url, unpadded.
public func base64URLEncode(_ data: Data) -> String {
    return data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

public enum PKCE {
    /// A code verifier from 32 random bytes: 43 base64url characters, the
    /// shortest RFC 7636 allows.
    public static func makeVerifier() -> String {
        var generator = SystemRandomNumberGenerator()
        var bytes: [UInt8] = []
        bytes.reserveCapacity(32)
        for _ in 0..<32 { bytes.append(UInt8.random(in: UInt8.min...UInt8.max, using: &generator)) }
        return makeVerifier(bytes: bytes)
    }

    /// The verifier for given bytes (tests pin RFC 7636 Appendix B with this).
    public static func makeVerifier(bytes: [UInt8]) -> String {
        return base64URLEncode(Data(bytes))
    }

    /// The S256 challenge: base64url(SHA-256(ASCII(verifier))). The hash is
    /// injected so this file stays Foundation-only; the app passes CryptoKit's.
    public static func challenge(for verifier: String, sha256: (Data) -> Data) -> String {
        return base64URLEncode(sha256(Data(verifier.utf8)))
    }
}

// MARK: - URLs and requests

/// Where GoTrue lives and the public key it wants, from GET /api/app/config.
public struct GoTrueConfig: Codable, Sendable, Hashable {
    /// `https://<ref>.supabase.co`.
    public var supabaseUrl: URL
    /// The anon (publishable) key; public by design, it ships in the web bundle.
    public var anonKey: String

    public init(supabaseUrl: URL, anonKey: String) {
        self.supabaseUrl = supabaseUrl
        self.anonKey = anonKey
    }
}

/// RFC 3986 unreserved characters only, so the query reads the same on every
/// platform (Foundation leaves `:` and `/` bare in query values).
private func strictPercentEncode(_ s: String) -> String {
    let hex: [Character] = Array("0123456789ABCDEF")
    var out = ""
    for byte in s.utf8 {
        let isUnreserved = (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57)
            || byte == 45 || byte == 46 || byte == 95 || byte == 126
        if isUnreserved {
            out.append(Character(Unicode.Scalar(byte)))
        } else {
            out.append("%")
            out.append(hex[Int(byte >> 4)])
            out.append(hex[Int(byte & 0x0F)])
        }
    }
    return out
}

/// `{supabaseUrl}/auth/v1/{path}?{query}`, keeping any path the base already has.
private func goTrueURL(_ config: GoTrueConfig, _ path: String, _ query: [(String, String)]) -> URL? {
    guard var components = URLComponents(url: config.supabaseUrl, resolvingAgainstBaseURL: false) else { return nil }
    var base = components.percentEncodedPath
    while base.hasSuffix("/") { base.removeLast() }
    components.percentEncodedPath = base + "/auth/v1/" + path
    components.percentEncodedQuery = query.isEmpty
        ? nil
        : query.map { "\(strictPercentEncode($0.0))=\(strictPercentEncode($0.1))" }.joined(separator: "&")
    components.fragment = nil
    return components.url
}

extension GoTrue {
    /// The page the auth session opens: Google, then back through
    /// `redirectTo`. Carries no apikey; it is a browser navigation.
    public static func authorizeURL(config: GoTrueConfig, codeChallenge: String, redirectTo: String = GoTrue.redirectTo) -> URL? {
        return goTrueURL(config, "authorize", [
            ("provider", "google"),
            ("redirect_to", redirectTo),
            ("code_challenge", codeChallenge),
            ("code_challenge_method", "s256"),
        ])
    }

    /// POST /auth/v1/token?grant_type=pkce `{auth_code, code_verifier}`.
    public static func exchangeRequest(config: GoTrueConfig, authCode: String, codeVerifier: String) -> URLRequest? {
        guard let url = goTrueURL(config, "token", [("grant_type", "pkce")]) else { return nil }
        return jsonRequest(url, config: config, body: ["auth_code": authCode, "code_verifier": codeVerifier])
    }

    /// POST /auth/v1/token?grant_type=refresh_token `{refresh_token}`.
    public static func refreshRequest(config: GoTrueConfig, refreshToken: String) -> URLRequest? {
        guard let url = goTrueURL(config, "token", [("grant_type", "refresh_token")]) else { return nil }
        return jsonRequest(url, config: config, body: ["refresh_token": refreshToken])
    }

    /// POST /auth/v1/logout?scope=local: ends THIS session only. GoTrue's
    /// default is global, which would sign the web and the desktop out too.
    public static func logoutRequest(config: GoTrueConfig, accessToken: String) -> URLRequest? {
        guard let url = goTrueURL(config, "logout", [("scope", "local")]) else { return nil }
        var request = jsonRequest(url, config: config, body: nil)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        return request
    }

    private static func jsonRequest(_ url: URL, config: GoTrueConfig, body: [String: String]?) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(config.anonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(GoTrue.apiVersion, forHTTPHeaderField: "X-Supabase-Api-Version")
        if let body = body {
            request.httpBody = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        }
        return request
    }
}

// MARK: - Sessions

/// GoTrue's token response, as it arrives (snake_case).
public struct TokenResponse: Decodable, Sendable, Hashable {
    public var accessToken: String
    public var tokenType: String?
    public var expiresIn: Double
    public var expiresAt: Double?
    public var refreshToken: String
    public var user: TokenUser

    public struct TokenUser: Decodable, Sendable, Hashable {
        public var id: String
        public var email: String?
    }

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
        case expiresAt = "expires_at"
        case refreshToken = "refresh_token"
        case user
    }
}

/// A signed-in session, as the app keeps it (one Keychain blob).
public struct Session: Codable, Sendable, Hashable {
    public var accessToken: String
    public var refreshToken: String
    /// When the access token stops working, by this device's clock: the time
    /// the response arrived plus `expires_in`, so a skewed clock can't make a
    /// token look fresher than it is.
    public var expiresAt: Date
    public var userId: UUID
    public var email: String?

    public init(accessToken: String, refreshToken: String, expiresAt: Date, userId: UUID, email: String?) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.userId = userId
        self.email = email
    }

    /// Nil when the user id isn't a uuid or a token is empty.
    public init?(response: TokenResponse, receivedAt: Date) {
        guard let userId = UUID(uuidString: response.user.id),
              !response.accessToken.isEmpty, !response.refreshToken.isEmpty
        else { return nil }
        self.init(
            accessToken: response.accessToken,
            refreshToken: response.refreshToken,
            expiresAt: receivedAt.addingTimeInterval(response.expiresIn),
            userId: userId,
            email: response.user.email
        )
    }

    /// Decodes a token response body (the PKCE exchange or a refresh).
    public static func decode(_ data: Data, receivedAt: Date) throws -> Session {
        let response = try JSONDecoder().decode(TokenResponse.self, from: data)
        guard let session = Session(response: response, receivedAt: receivedAt) else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "token response without a usable user or tokens")
            )
        }
        return session
    }

    /// True from `refreshLeeway` seconds before expiry on.
    public func needsRefresh(now: Date) -> Bool {
        return now >= expiresAt.addingTimeInterval(-GoTrue.refreshLeeway)
    }
}

// MARK: - Refresh failures

/// What a failed refresh means. Only a verdict that the session is gone signs
/// the user out; a 5xx, a 429, an unknown error or a network failure keeps the
/// tokens and retries with the SAME refresh token (GoTrue rotates them, and
/// reusing an old one outside its short reuse window revokes the family).
public enum RefreshFailure: Sendable, Hashable {
    case signedOut
    case retry
}

/// GoTrue error codes that mean the session can never refresh again. A web
/// sign-out is global, so it lands here as `session_not_found`.
private let terminalRefreshCodes: Set<String> = [
    "refresh_token_not_found",
    "refresh_token_already_used",
    "session_not_found",
    "session_expired",
    "user_not_found",
]

/// Reads a failed refresh's HTTP status and body. The code comes from `code`
/// (API version 2024-01-01) or `error_code`; a body with neither but the
/// legacy `{"error":"invalid_grant"}` on a 400 is terminal too.
public func classifyRefreshFailure(status: Int, body: Data) -> RefreshFailure {
    guard let object = try? JSONSerialization.jsonObject(with: body, options: []),
          let json = object as? [String: Any]
    else { return .retry }
    let code = (json["code"] as? String) ?? (json["error_code"] as? String)
    if let code = code, terminalRefreshCodes.contains(code) { return .signedOut }
    if status == 400, (json["error"] as? String) == "invalid_grant" { return .signedOut }
    return .retry
}

/// `classifyRefreshFailure(status:body:)` spelled positionally, as the PR 3
/// design writes it.
public func classifyRefreshFailure(_ status: Int, _ body: Data) -> RefreshFailure {
    return classifyRefreshFailure(status: status, body: body)
}

// MARK: - The callback

/// What `app.dsul.ios://auth/callback` brought back.
public enum AuthCallback: Sendable, Hashable {
    /// An authorization code to exchange with the verifier.
    case code(String)
    /// GoTrue's or Google's error code (never its description).
    case error(String)
}

/// The callback, checked as strictly as app/auth/ios/route.ts writes it:
/// scheme `app.dsul.ios`, host `auth`, path `/callback`, no user, password,
/// port or fragment, and exactly one query item, either
/// `code=^[A-Za-z0-9._~-]{8,256}$` or `error_code=^[a-z_]{1,64}$`. Values are
/// read raw, so a percent-encoded character never passes. Anything else is nil.
public func parseCallback(_ url: URL) -> AuthCallback? {
    guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
          c.scheme?.lowercased() == GoTrue.callbackScheme,
          c.host?.lowercased() == "auth",
          c.percentEncodedPath == "/callback",
          c.user == nil, c.password == nil, c.port == nil, c.fragment == nil,
          let query = c.percentEncodedQuery
    else { return nil }
    let pair = query.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
    guard pair.count == 2, !query.contains("&") else { return nil }
    let name = String(pair[0])
    let value = String(pair[1])
    switch name {
    case "code":
        return isCallbackCode(value) ? .code(value) : nil
    case "error_code":
        return isCallbackErrorCode(value) ? .error(value) : nil
    default:
        return nil
    }
}

/// `^[A-Za-z0-9._~-]{8,256}$`.
private func isCallbackCode(_ s: String) -> Bool {
    let bytes = Array(s.utf8)
    guard bytes.count >= 8 && bytes.count <= 256 else { return false }
    return bytes.allSatisfy { b in
        (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || (b >= 48 && b <= 57)
            || b == 46 || b == 95 || b == 126 || b == 45
    }
}

/// `^[a-z_]{1,64}$`.
private func isCallbackErrorCode(_ s: String) -> Bool {
    let bytes = Array(s.utf8)
    guard bytes.count >= 1 && bytes.count <= 64 else { return false }
    return bytes.allSatisfy { b in (b >= 97 && b <= 122) || b == 95 }
}
