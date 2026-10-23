import Foundation

// The JSON body of POST /api/app/containers/:kind/:id, as lib/app-containers.ts
// `RoutineWriteSchema` and `SeasonWriteSchema` take it (Organize O8a):
// - a routine's Pause: `{"action":"pause","paused":true}`, with
//   `"pausedUntil":"yyyy-MM-dd"` for Pause until, never null (the schema is
//   `.optional()`, not `.nullable()`);
// - its Resume: `{"action":"pause","paused":false}`, never with a day (the
//   union's refine refuses one);
// - either with `"timeZone":…`, the device's zone, only when there is one the
//   schema takes (a string of at most 100 UTF-16 units); the server reads it
//   only when the account stores no usable zone (lib/app-http.ts `pauseZone`);
// - a season's Status: `{"action":"state","state":"auto"|"active"|"paused"}`.
// Every member is `.strict()` there, so a key the route doesn't name is a 400,
// and `encode(to:)` is written out by hand, so it writes exactly these keys. A
// body goes only to a kind whose union holds its action: the failable init
// refuses any other, so the phone never builds the bodies the route refuses
// (container-writes.json's `invalid`). Checked against the route by
// ContainerWritesFixtureTests: every case's body is the JSON this encodes.
//
// The kind and the id are the path (`ContainerRoutes.write`), never the body:
// a body meant for a season can't reach a routine with the same id.

/// One container write, ready to encode.
public struct ContainerWriteBody: Encodable, Sendable, Hashable {
    /// The kind whose route takes it.
    public let kind: OrganizeKind
    /// What it asks.
    public let intent: ContainerIntent

    /// The body of `intent` for `kind`'s route, or nil when that route's union
    /// doesn't hold the intent's action (it would answer 400).
    public init?(_ intent: ContainerIntent, for kind: OrganizeKind) {
        guard intent.applies(to: kind) else { return nil }
        self.kind = kind
        self.intent = intent
    }

    /// The route's `action`, which `containerWrites` lists.
    public var action: ContainerAction { intent.action }

    private enum Key: String, CodingKey {
        case action, paused, pausedUntil, timeZone, state
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(intent.action.rawValue, forKey: .action)
        switch intent {
        case .pause(let until, let zone):
            try c.encode(true, forKey: .paused)
            if let until {
                try c.encode(until.description, forKey: .pausedUntil)
            }
            if let zone = Self.sendableZone(zone) {
                try c.encode(zone, forKey: .timeZone)
            }
        case .resume(let zone):
            try c.encode(false, forKey: .paused)
            if let zone = Self.sendableZone(zone) {
                try c.encode(zone, forKey: .timeZone)
            }
        case .state(let state):
            try c.encode(state.rawValue, forKey: .state)
        }
    }

    /// The zone as the schema takes it (`z.string().max(100)`), or nil to
    /// leave the key out: an empty zone says nothing, and a longer one would
    /// turn the whole write into a 400. No IANA zone comes close.
    static func sendableZone(_ zone: String?) -> String? {
        guard let zone, !zone.isEmpty, zone.utf16.count <= 100 else { return nil }
        return zone
    }
}

/// Where a container write goes.
public enum ContainerRoutes {
    /// POST /api/app/containers/:kind/:id: `/api/app/containers/<kind>/<id>`,
    /// the id lowercased as the route lowercases it. The kind is the route's
    /// own segment (lowercase, singular). A sample id, which is not a uuid,
    /// would be a 404; the sample never sends.
    public static func write(_ ref: ContainerRef) -> String {
        return "/api/app/containers/\(ref.kind.rawValue)/\(ref.id.lowercased())"
    }
}
