import DsulCore
import Foundation

/// Where the app finds its server. Nothing secret and nothing per-environment
/// is committed under ios/: the Supabase URL and anon key come from the server
/// itself (`SupabaseConfigStore`).
enum AppConfig {
    /// The web app: /api/app/* for data, /auth/ios for the Google hand-back.
    /// /api/* is never redirected to the canonical host (lib/canonical-host.ts),
    /// so the app calls it directly.
    static let productionOrigin = URL(string: "https://do.dsul.app")!

    /// The launch argument a Debug build reads (Edit Scheme → Run → Arguments:
    /// `-DsulAPIOrigin http://127.0.0.1:3000`), through UserDefaults' argument
    /// domain. Release builds always use production.
    static let debugOriginKey = "DsulAPIOrigin"

    static var apiOrigin: URL {
        #if DEBUG
        if let raw = UserDefaults.standard.string(forKey: debugOriginKey),
           let url = URL(string: raw), let scheme = url.scheme,
           scheme == "https" || scheme == "http", url.host != nil {
            return url
        }
        #endif
        return productionOrigin
    }

    /// `{origin}{path}`, where `path` starts with "/".
    static func endpoint(_ path: String, origin: URL) -> URL? {
        var base = origin.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: base + path)
    }

    /// GoTrue's `redirect_to` for Google: app/auth/ios/route.ts on the same
    /// origin, which 302s the code on to `app.dsul.ios://auth/callback`. The
    /// emailed link adds `?via=email&n=…` to it (`GoTrue.emailRedirect`).
    /// Production's is `GoTrue.redirectTo`, covered by the Supabase allow-list's
    /// `https://do.dsul.app/**`.
    static var authRedirect: String {
        return endpoint("/auth/ios", origin: apiOrigin)?.absoluteString ?? GoTrue.redirectTo
    }
}

/// The Supabase URL and anon key, from GET /api/app/config. Asked for on the
/// first sign-in tap (a signed-out launch makes no request at all), then kept
/// in UserDefaults. Asked again, once, if GoTrue refuses the cached key.
@MainActor
final class SupabaseConfigStore {
    private let origin: URL
    private let defaults: UserDefaults
    private let transport: Transport
    private var cached: GoTrueConfig?

    init(origin: URL, defaults: UserDefaults, transport: @escaping Transport) {
        self.origin = origin
        self.defaults = defaults
        self.transport = transport
    }

    /// Per origin, so a Debug build pointed elsewhere never mixes the two.
    private var cacheKey: String { "supabaseConfig:" + origin.absoluteString }

    func config() async throws -> GoTrueConfig {
        if let cached { return cached }
        if let data = defaults.data(forKey: cacheKey),
           let stored = try? JSONDecoder().decode(GoTrueConfig.self, from: data) {
            cached = stored
            return stored
        }
        return try await download()
    }

    /// Drops the cached config and asks the server again.
    func reload() async throws -> GoTrueConfig {
        cached = nil
        defaults.removeObject(forKey: cacheKey)
        return try await download()
    }

    private func download() async throws -> GoTrueConfig {
        guard let url = AppConfig.endpoint("/api/app/config", origin: origin) else { throw AuthError.unavailable }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let result = try await transport(request)
        guard result.status == 200 else { throw AuthError.unavailable }
        let config = try JSONDecoder().decode(GoTrueConfig.self, from: result.data)
        if let data = try? JSONEncoder().encode(config) {
            defaults.set(data, forKey: cacheKey)
        }
        cached = config
        return config
    }

    /// Supabase's gateway refused the anon key itself (a rotated key): a 401
    /// that names the API key, where GoTrue's own refusals carry an error code.
    nonisolated static func isAPIKeyRejected(_ result: HTTPResult) -> Bool {
        guard result.status == 401 else { return false }
        let text = String(decoding: result.data, as: UTF8.self).lowercased()
        return text.contains("api key") || text.contains("apikey")
    }
}
