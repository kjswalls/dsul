import DsulCore
import Foundation
import Testing
@testable import Dsul

// The device registry from the phone's side (reminders Phase 2d): this
// install's id, the body POST /api/app/devices takes, and the X-Dsul-Device
// header every /api/app write carries. The hub's once-a-launch registration
// is in NotificationTests; the sign-out release in AuthStoreTests.

@MainActor
@Suite struct DeviceRegistrarTests {
    private let origin = URL(string: "https://dsul.test")!
    private let device = "ios:0b7c2f9a-1d3e-4c5b-9a8f-7e6d5c4b3a21"

    @Test func theIdIsMadeOnceAndKept() {
        let defaults = UserDefaults(suiteName: "dsul-tests-" + UUID().uuidString)!
        let first = DeviceIdentity.id(defaults)
        #expect(first.hasPrefix("ios:"))
        #expect(DeviceIdentity.isValid(first))
        #expect(DeviceIdentity.id(defaults) == first)

        // Anything 065's CHECK would refuse is replaced, never sent.
        defaults.set("not an id", forKey: DeviceIdentity.defaultsKey)
        let remade = DeviceIdentity.id(defaults)
        #expect(remade != "not an id")
        #expect(DeviceIdentity.isValid(remade))
    }

    @Test func validityIsTheMigrationsCheck() {
        #expect(DeviceIdentity.isValid(device))
        #expect(!DeviceIdentity.isValid("ios:1"))
        #expect(!DeviceIdentity.isValid("ios:a b c d e"))
        #expect(!DeviceIdentity.isValid("ios:" + String(repeating: "a", count: 125)))
        #expect(!DeviceIdentity.isValid("ios:../../x/y"))
    }

    @Test func theBodyIsTheShapeTheRouteTakes() throws {
        let body = DeviceRegistrationBody(deviceId: device, appVersion: "1.0 (12)", osVersion: "27.0",
                                          timezone: "America/Los_Angeles")
        let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        #expect(Set(json.keys) == ["deviceId", "platform", "transport", "delivery", "os", "form",
                                   "appVersion", "osVersion", "timezone"])
        #expect(json["deviceId"] as? String == device)
        #expect(json["platform"] as? String == "ios")
        #expect(json["transport"] as? String == "none")
        #expect(json["delivery"] as? String == "local")
        #expect(json["os"] as? String == "ios")
        #expect(json["form"] as? String == "phone")
        #expect(json["label"] == nil)

        // A field it doesn't know is left out, never sent as null.
        let bare = DeviceRegistrationBody(deviceId: device)
        let bareJSON = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(bare)) as? [String: Any])
        #expect(bareJSON["appVersion"] == nil)
        #expect(bareJSON["timezone"] == nil)
    }

    @Test func theCurrentBodyNamesThisSystemAndZone() {
        let body = DeviceRegistrationBody.current(deviceId: device, timezone: "Europe/London")
        #expect(body.deviceId == device)
        #expect(body.timezone == "Europe/London")
        let version = ProcessInfo.processInfo.operatingSystemVersion
        #expect(body.osVersion?.hasPrefix("\(version.majorVersion).\(version.minorVersion)") == true)
        #expect(DeviceRegistrationBody.current(deviceId: device, timezone: "").timezone == nil)
    }

    @Test func writesCarryTheDeviceAndReadsDoNot() async throws {
        let server = FakeServer()
        await server.on("POST /api/app/timezone", .status(200, "{\"ok\":true}"))
        let api = APIClient(origin: origin, tokens: FakeTokens(), transport: server.transport, deviceId: device)
        _ = try? await api.fetchPlanner()
        try await api.saveTimeZone("UTC")
        let requests = await server.requests
        #expect(requests.first { $0.route == "GET /api/app/planner" }?.headers["x-dsul-device"] == nil)
        #expect(requests.first { $0.route == "POST /api/app/timezone" }?.headers["x-dsul-device"] == device)
    }

    @Test func noDeviceIdSendsNoHeader() async throws {
        let server = FakeServer()
        await server.on("POST /api/app/timezone", .status(200, "{\"ok\":true}"))
        let api = APIClient(origin: origin, tokens: FakeTokens(), transport: server.transport)
        try await api.saveTimeZone("UTC")
        let requests = await server.requests
        #expect(requests.first?.headers["x-dsul-device"] == nil)
    }

    @Test func theReleaseIsADeleteByThisDevicesId() async throws {
        let server = FakeServer()
        let route = "DELETE /api/app/devices/" + device
        await server.on(route, .status(200, "{\"ok\":true}"))
        let api = APIClient(origin: origin, tokens: FakeTokens(), transport: server.transport, deviceId: device)
        try await api.releaseDevice(device)
        #expect(await server.count(route) == 1)
        #expect(await server.requests.first?.body == nil)
    }

    @Test func aMalformedIdIsNeverSent() async {
        let server = FakeServer()
        let api = APIClient(origin: origin, tokens: FakeTokens(), transport: server.transport)
        await #expect(throws: APIError.badResponse) { try await api.releaseDevice("../account") }
        #expect(await server.requests.isEmpty)
    }

    @Test func theEndingTokenIsNeverRefreshed() async throws {
        let source = EndingSessionToken("a1")
        #expect(try await source.accessToken(rejecting: nil) == "a1")
        await #expect(throws: AuthError.signedOut) { try await source.accessToken(rejecting: "a1") }
    }
}
