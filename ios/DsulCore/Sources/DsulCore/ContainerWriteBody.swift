import Foundation

// The JSON body of POST /api/app/containers/:kind/:id, as lib/app-containers.ts
// `RoutineWriteSchema`, `SeasonWriteSchema`, `GoalWriteSchema` and
// `ProjectWriteSchema` take it:
// - a routine's Pause: `{"action":"pause","paused":true}`, with
//   `"pausedUntil":"yyyy-MM-dd"` for Pause until, never null (the schema is
//   `.optional()`, not `.nullable()`);
// - its Resume: `{"action":"pause","paused":false}`, never with a day (the
//   union's refine refuses one);
// - either with `"timeZone":…`, the device's zone, only when there is one the
//   schema takes (a string of at most 100 UTF-16 units); the server reads it
//   only when the account stores no usable zone (lib/app-http.ts `pauseZone`);
// - a season's Status: `{"action":"state","state":"auto"|"active"|"paused"}`;
// - from O8b: a routine's `{"action":"usualTime","usualTime":"HH:mm"|null}`; a
//   season's `{"action":"dates","startsOn":…|null,"endsOn":…|null}` and a
//   goal's `{"action":"window","startsOn":…|null,"targetOn":…|null}`, both
//   keys always (null is an open end); a goal's
//   `{"action":"state","state":"active"|"achieved"|"abandoned"}`;
//   `{"action":"notes","notes":…|null}` and a goal's
//   `{"action":"why","why":…|null}`, null to clear;
// - from O9, on every kind: `{"action":"rename","name":…}`,
//   `{"action":"icon","icon":"icon:<Name>"}` (never null) and
//   `{"action":"color","color":"var(--accent-N)"|null}` (null is Auto);
// - from O10, on every kind: `{"action":"delete"}`, and nothing else;
// - from O12, a routine's `{"action":"moveMember","itemId":…,"afterId":…|null}`
//   (`afterId` always, null for first), and from O13 a season's
//   `{"action":"holdRoutine","routineId":…,"hold":true|false}`: the two
//   membership intents, `MembershipWriteBody` below, each id lowercased as the
//   route's `Id` reads it.
// Every member is `.strict()` there, so a key the route doesn't name is a 400,
// and `encode(to:)` is written out by hand, so it writes exactly these keys. A
// body goes only to a kind whose union holds its intent, with values its
// schema takes: the failable init refuses any other, so the phone never
// builds the bodies the route refuses (container-writes.json's `invalid`).
// Checked against the route by ContainerWritesFixtureTests: every case's body
// is the JSON this encodes.
//
// The kind and the id are the path (`ContainerRoutes.write`), never the body:
// a body meant for a season can't reach a routine with the same id. A new
// container's body is ContainerCreate.swift's, and goes to the kind alone
// (`ContainerRoutes.create`).

/// One container write, ready to encode.
public struct ContainerWriteBody: Encodable, Sendable, Hashable {
    /// The kind whose route takes it.
    public let kind: OrganizeKind
    /// What it asks.
    public let intent: ContainerIntent

    /// The body of `intent` for `kind`'s route, or nil when that route's union
    /// doesn't hold the intent (`applies(to:)`) or its schema refuses the
    /// intent's values (`isWellFormed`): either would answer 400.
    public init?(_ intent: ContainerIntent, for kind: OrganizeKind) {
        guard intent.applies(to: kind), intent.isWellFormed else { return nil }
        self.kind = kind
        self.intent = intent
    }

    /// The route's `action`, which `containerWrites` lists.
    public var action: ContainerAction { intent.action }

    private enum Key: String, CodingKey {
        case action, paused, pausedUntil, timeZone, state
        case usualTime, startsOn, endsOn, targetOn, notes, why, name, icon, color
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(intent.action.rawValue, forKey: .action)
        /// A value, or an explicit null: the schema's `.nullable()` keys are
        /// required, so an open end or a clear is sent, never left out.
        func put(_ value: String?, _ key: Key) throws {
            if let value { try c.encode(value, forKey: key) } else { try c.encodeNil(forKey: key) }
        }
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
        case .goalState(let state):
            try c.encode(state.rawValue, forKey: .state)
        case .usualTime(let time):
            try put(time, .usualTime)
        case .dates(let start, let end):
            try put(start?.description, .startsOn)
            try put(end?.description, .endsOn)
        case .window(let start, let target):
            try put(start?.description, .startsOn)
            try put(target?.description, .targetOn)
        case .notes(let text):
            try put(text, .notes)
        case .why(let text):
            try put(text, .why)
        case .rename(let name):
            try c.encode(name, forKey: .name)
        case .icon(let token):
            try c.encode(token, forKey: .icon)
        case .color(let color):
            try put(color, .color)
        case .delete:
            // The action alone: the schema is `{action}` and strict.
            break
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

/// One membership write (O12, O13), ready to encode: a routine's step move or
/// a season's routine hold, to the same route as a field write
/// (`ContainerRoutes.write`, the container's kind and id).
public struct MembershipWriteBody: Encodable, Sendable, Hashable {
    /// The kind whose route takes it: a routine for a move, a season for a
    /// hold.
    public let kind: OrganizeKind
    /// What it asks.
    public let intent: MembershipIntent

    /// The body of `intent` for `kind`'s route, or nil when the route would
    /// answer 400: another kind's route (`applies(to:)`), a step placed after
    /// itself (`isWellFormed`), or a routine id the route's `Id` (lib/app-http.ts
    /// `UUID`) doesn't read, a sample's. The sample never sends.
    public init?(_ intent: MembershipIntent, for kind: OrganizeKind) {
        guard intent.applies(to: kind), intent.isWellFormed else { return nil }
        if case .holdRoutine(let routineId, _) = intent, !isUUIDText(routineId) { return nil }
        self.kind = kind
        self.intent = intent
    }

    /// The route's `action`, which `containerWrites` lists.
    public var action: ContainerAction { intent.action }

    private enum Key: String, CodingKey {
        case action, itemId, afterId, routineId, hold
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(intent.action.rawValue, forKey: .action)
        switch intent {
        case .moveMember(let item, let after):
            try c.encode(item.uuidString.lowercased(), forKey: .itemId)
            // Required, null for first: the schema's `Id.nullable()`.
            if let after {
                try c.encode(after.uuidString.lowercased(), forKey: .afterId)
            } else {
                try c.encodeNil(forKey: .afterId)
            }
        case .holdRoutine(let routineId, let hold):
            try c.encode(routineId.lowercased(), forKey: .routineId)
            try c.encode(hold, forKey: .hold)
        }
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
