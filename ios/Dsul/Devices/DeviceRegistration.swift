import Foundation

/// This install's id in the device registry (migration 065, `devices`):
/// `ios:` and a lowercase UUID, made on first use and kept in UserDefaults.
/// The web's twin is `dsul-device-id` in localStorage
/// (lib/devices/web-client.ts); like it, the id is never cleared, so signing
/// out and back in is the same device. A reinstall starts a new one, and the
/// old row, which nothing is ever sent to, goes at the nightly 180-day prune.
enum DeviceIdentity {
    static let defaultsKey = "dsul.deviceId"

    static func id(_ defaults: UserDefaults = .standard) -> String {
        if let stored = defaults.string(forKey: defaultsKey), isValid(stored) { return stored }
        let made = "ios:" + UUID().uuidString.lowercased()
        defaults.set(made, forKey: defaultsKey)
        return made
    }

    /// 065's `devices_device_id_check`: `^[A-Za-z0-9:._-]{8,128}$`.
    static func isValid(_ id: String) -> Bool {
        guard (8...128).contains(id.count) else { return false }
        return id.unicodeScalars.allSatisfy { scalar in
            switch scalar {
            case "A"..."Z", "a"..."z", "0"..."9", ":", ".", "_", "-": return true
            default: return false
            }
        }
    }
}

/// This install's APNs device token (reminders Phase 3) and the host it
/// belongs to. A Debug build is signed with the development push
/// entitlement, so its token is a sandbox token; a TestFlight or App Store
/// build's is a production one. Sent to the wrong host a token answers
/// BadDeviceToken, which the server prunes on, so the two must never mix.
struct PushToken: Equatable, Sendable {
    var hex: String
    var environment: String

    init(hex: String, environment: String = PushToken.buildEnvironment) {
        self.hex = hex
        self.environment = environment
    }

    init(deviceToken: Data, environment: String = PushToken.buildEnvironment) {
        self.init(hex: deviceToken.map { String(format: "%02x", $0) }.joined(), environment: environment)
    }

    static var buildEnvironment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    /// What the route takes (lib/devices/transports/apns.ts APNS_TOKEN): hex,
    /// 64 characters today, and Apple says not to assume the length.
    var isValid: Bool {
        (64...200).contains(hex.count) && hex.allSatisfy(\.isHexDigit)
            && (environment == "production" || environment == "sandbox")
    }
}

/// The body of POST /api/app/devices (app/api/app/devices/route.ts): an
/// iPhone that arms its own cues (`delivery 'local'`), with no token
/// (`transport 'none'`) or, once APNs has handed it one, `transport 'apns'`
/// with the token and its environment, for what it cannot ring alone (the
/// last call, a pledge). The server's DeviceRegistrationSchema (@dsul/types)
/// is strict, so nothing else goes in it; a nil field is left out, and the
/// registry keeps what it already held for it.
struct DeviceRegistrationBody: Encodable, Equatable, Sendable {
    var deviceId: String
    var platform = "ios"
    var transport = "none"
    var delivery = "local"
    var os = "ios"
    var form = "phone"
    /// Never sent: with no label the web's roster calls the row "dsul on
    /// iPhone" (lib/devices/roster.ts), which tells it from the Home Screen
    /// app's "Browser on iPhone", and a rename in Settings is the owner's.
    var label: String? = nil
    var appVersion: String?
    var osVersion: String?
    var timezone: String?
    var token: String? = nil
    var apnsEnvironment: String? = nil

    /// This body with the push token, when there is a valid one; without, as it was.
    func withPush(_ push: PushToken?) -> DeviceRegistrationBody {
        guard let push, push.isValid else { return self }
        var body = self
        body.transport = "apns"
        body.token = push.hex.lowercased()
        body.apnsEnvironment = push.environment
        return body
    }

    /// This iPhone now: the bundle's version and build, the system's version,
    /// and the zone it rings in.
    static func current(deviceId: String, timezone: String, bundle: Bundle = .main,
                        process: ProcessInfo = .processInfo) -> DeviceRegistrationBody {
        let info = bundle.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String
        let build = info["CFBundleVersion"] as? String
        let app: String?
        switch (short, build) {
        case let (short?, build?): app = "\(short) (\(build))"
        case let (short?, nil): app = short
        case let (nil, build?): app = build
        default: app = nil
        }
        let system = process.operatingSystemVersion
        let os = "\(system.majorVersion).\(system.minorVersion)"
            + (system.patchVersion > 0 ? ".\(system.patchVersion)" : "")
        return DeviceRegistrationBody(deviceId: deviceId,
                                      appVersion: app.map { String($0.prefix(64)) },
                                      osVersion: os,
                                      timezone: timezone.isEmpty ? nil : String(timezone.prefix(64)))
    }
}

/// One token, no refresh: the session sign-out has just ended, whose release
/// must go before the GoTrue logout that ends its token. A 401 to it is final.
@MainActor
final class EndingSessionToken: AccessTokenSource {
    private let token: String

    init(_ token: String) {
        self.token = token
    }

    func accessToken(rejecting rejected: String?) async throws -> String {
        if rejected == token { throw AuthError.signedOut }
        return token
    }
}
