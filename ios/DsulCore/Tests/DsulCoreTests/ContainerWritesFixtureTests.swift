import Foundation
import Testing
import DsulCore

// The web's own answers for POST /api/app/containers/:kind/:id, checked
// against ContainerIntent.swift and ContainerWriteBody.swift:
// tests/fixtures/organize/container-writes.json. tests/unit/organize-fixtures.test.ts
// writes it from lib/app-containers.ts `containerIntentPatch` (UPDATE_FIXTURES=1),
// parses every `body` through the route's schema, and app-containers.test.ts
// runs every case through the route itself and reads the row back as `after`.
//
// Each case pins the container before, the body the phone sends, the instant
// and the zone the server resolved it with (and `today`, that instant's day in
// that zone), and what the route answers: its refusal or its patch (a cleared
// field as null; `{}` is "already so"), and the container after. The phone
// must build exactly that body, step to exactly that container, and refuse
// what the route refuses. `invalid` lists bodies the route answers 400, which
// the phone must never build.
//
// From O8b and O9 the cases cover all four kinds: a routine's usual time, a
// season's Runs, a goal's Status and window, notes and a why, and rename,
// icon and colour on each kind. A project rename's `after` is the project
// alone: its members' re-file is `refiledItems` / `refiling`, hand-tested
// below.
//
// From O10, `deletes`: one `{"action":"delete"}` per kind, each 200 (the
// route's bin and 404 answers depend on rows the phone never holds, so the
// route's own test pins them). From O11, `creates`: POST
// /api/app/containers/:kind's body and the container the row reads back as
// (`after`), which the phone's own (`containerCreateRecord`) must equal; and
// `createInvalid`, bodies the route answers 400 and the phone never builds
// (ContainerCreate.swift).
//
// From O12, `moves`: a routine's `moveMember` over the member order the route
// read (`before.itemIds`), answered 200 with the order it wrote, or 409
// `member_gone` / `anchor_gone` with the order untouched; and from O13,
// `holds`: a season's `holdRoutine` over the routines it held, with whether
// the routine named is live, answered 200 with the routines it holds after
// (in the payload's routine-id order, so compared as a set) or 409
// `container_gone`. `invalid` gains the membership bodies the route refuses.
// The phone must send exactly the body (ids lowercased), and its own answer
// (`memberMoveResult`, `routineHoldResult`) must be the route's.

/// One case of `cases`, its containers read as the kind says.
private struct WriteCase: Decodable, Sendable {
    let name: String
    let kind: OrganizeKind
    let before: ContainerSnapshot
    let body: JSONValue
    let now: String
    let timeZone: String
    let today: String
    let refused: String?
    let status: Int
    /// The patch as the web wrote it, a cleared field as null; nil on a refusal.
    let patch: [String: JSONValue]?
    let after: ContainerSnapshot

    private enum Key: String, CodingKey {
        case name, kind, before, body, now, timeZone, today, expected
    }

    private enum ExpectedKey: String, CodingKey {
        case refused, status, patch, after
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        name = try c.decode(String.self, forKey: .name)
        let rawKind = try c.decode(String.self, forKey: .kind)
        guard let kind = OrganizeKind(rawValue: rawKind) else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "kind \(rawKind)")
        }
        self.kind = kind
        before = try Self.snapshot(kind, c, .before)
        body = try c.decode(JSONValue.self, forKey: .body)
        now = try c.decode(String.self, forKey: .now)
        timeZone = try c.decode(String.self, forKey: .timeZone)
        today = try c.decode(String.self, forKey: .today)
        let e = try c.nestedContainer(keyedBy: ExpectedKey.self, forKey: .expected)
        refused = try e.decodeIfPresent(String.self, forKey: .refused)
        status = try e.decode(Int.self, forKey: .status)
        patch = try e.decodeIfPresent([String: JSONValue].self, forKey: .patch)
        after = try Self.snapshot(kind, e, .after)
    }

    private static func snapshot<K: CodingKey>(
        _ kind: OrganizeKind, _ c: KeyedDecodingContainer<K>, _ key: K
    ) throws -> ContainerSnapshot {
        switch kind {
        case .routine: return .routine(try c.decode(Routine.self, forKey: key))
        case .season: return .season(try c.decode(Season.self, forKey: key))
        case .goal: return .goal(try c.decode(Goal.self, forKey: key))
        case .project: return .project(try c.decode(Project.self, forKey: key))
        }
    }
}

/// One body of `invalid`: the route answers 400 `invalid` to it.
private struct InvalidCase: Decodable, Sendable {
    let name: String
    let kind: String
    let body: JSONValue
    let expected: InvalidExpected
}

private struct InvalidExpected: Decodable, Sendable {
    let status: Int
    let error: String
}

/// One row of `deletes`: the delete's body on a kind, and the route's 200.
private struct DeleteCase: Decodable, Sendable {
    let name: String
    let kind: String
    let body: JSONValue
    let expected: DeleteExpected
}

private struct DeleteExpected: Decodable, Sendable {
    let status: Int
}

/// One row of `creates`: the body the create sheet sends, and the route's
/// answer with the container the row reads back as.
private struct CreateCase: Decodable, Sendable {
    let name: String
    let kind: OrganizeKind
    let body: JSONValue
    let status: Int
    let id: String
    let after: ContainerSnapshot

    private enum Key: String, CodingKey {
        case name, kind, body, expected
    }

    private enum ExpectedKey: String, CodingKey {
        case status, id, after
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        name = try c.decode(String.self, forKey: .name)
        let rawKind = try c.decode(String.self, forKey: .kind)
        guard let kind = OrganizeKind(rawValue: rawKind) else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "kind \(rawKind)")
        }
        self.kind = kind
        body = try c.decode(JSONValue.self, forKey: .body)
        let e = try c.nestedContainer(keyedBy: ExpectedKey.self, forKey: .expected)
        status = try e.decode(Int.self, forKey: .status)
        id = try e.decode(String.self, forKey: .id)
        switch kind {
        case .routine: after = .routine(try e.decode(Routine.self, forKey: .after))
        case .season: after = .season(try e.decode(Season.self, forKey: .after))
        case .goal: after = .goal(try e.decode(Goal.self, forKey: .after))
        case .project: after = .project(try e.decode(Project.self, forKey: .after))
        }
    }
}

/// One row of `moves` (O12): the routine's member order as the route read
/// it, the body sent, and what the route answered with the order after.
private struct MoveCase: Decodable, Sendable {
    let name: String
    let kind: String
    let before: MoveBefore
    let body: JSONValue
    let expected: MoveExpected
}

private struct MoveBefore: Decodable, Sendable {
    let itemIds: [String]
}

private struct MoveExpected: Decodable, Sendable {
    let status: Int
    let error: String?
    let itemIds: [String]
}

/// One row of `holds` (O13): the season's routines as the route read them,
/// whether the routine named is live, the body sent, and what the route
/// answered with the routines after.
private struct HoldCase: Decodable, Sendable {
    let name: String
    let kind: String
    let before: HoldBefore
    let routineLive: Bool
    let body: JSONValue
    let expected: HoldExpected
}

private struct HoldBefore: Decodable, Sendable {
    let routineIds: [String]
}

private struct HoldExpected: Decodable, Sendable {
    let status: Int
    let error: String?
    let routineIds: [String]
}

private struct ContainerWritesFixture: Decodable, Sendable {
    let cases: [WriteCase]
    let invalid: [InvalidCase]
    let deletes: [DeleteCase]
    let creates: [CreateCase]
    /// Shaped as `invalid`: each answered 400 `invalid`.
    let createInvalid: [InvalidCase]
    let moves: [MoveCase]
    let holds: [HoldCase]
}

private func load() throws -> ContainerWritesFixture {
    return try loadOrganizeFixture(ContainerWritesFixture.self, "container-writes.json")
}

/// `body` as the JSON it encodes to.
private func json(_ body: ContainerWriteBody) throws -> JSONValue {
    let data = try JSONEncoder().encode(body)
    return try JSONDecoder().decode(JSONValue.self, from: data)
}

/// The patch as the fixture writes it: a set field as its value, a cleared
/// one as null, one left alone absent. A season's and a goal's state are both
/// `state`; a project's glyph is `emoji`.
private func wire(_ patch: ContainerPatch) -> [String: JSONValue] {
    var out: [String: JSONValue] = [:]
    func put(_ key: String, _ write: ColumnWrite?) {
        switch write {
        case .set(let value)?: out[key] = .string(value)
        case .clear?: out[key] = .null
        case nil: break
        }
    }
    put("pausedAt", patch.pausedAt)
    put("pausedUntil", patch.pausedUntil)
    if let state = patch.state { out["state"] = .string(state.rawValue) }
    if let state = patch.goalState { out["state"] = .string(state.rawValue) }
    put("achievedAt", patch.achievedAt)
    put("usualTime", patch.usualTime)
    put("startsOn", patch.startsOn)
    put("endsOn", patch.endsOn)
    put("targetOn", patch.targetOn)
    put("notes", patch.notes)
    put("why", patch.why)
    if let name = patch.name { out["name"] = .string(name) }
    if let icon = patch.icon { out["icon"] = .string(icon) }
    if let emoji = patch.emoji { out["emoji"] = .string(emoji) }
    put("color", patch.color)
    return out
}

/// The intent a body means on `kind`'s route, read by shape as strictly as
/// the route's schema reads it: nil for any body no intent can carry (an
/// unknown key or action, a missing or mistyped value, a day that is no day,
/// a resume with a day, a state outside its kind's three, a null name or
/// icon). Values a well-shaped body can still get wrong (a blank name, a time
/// that is not "HH:mm", a token off the ramp, an inverted range) are left to
/// `ContainerIntent.isWellFormed`, and whether the kind takes the intent to
/// `ContainerWriteBody`: the tests ask the phone's own answer for both.
private func phoneIntent(_ body: JSONValue, kind: OrganizeKind) -> ContainerIntent? {
    guard case .object(let o) = body, case .string(let action)? = o["action"] else { return nil }
    let keys = Set(o.keys)
    /// The key's string, `.some(nil)` for null, `.none` for anything else.
    func text(_ key: String) -> String?? {
        switch o[key] {
        case .string(let s)?: return .some(s)
        case .null?: return .some(nil)
        default: return .none
        }
    }
    /// The key's day (the schema's DateStrSchema: yyyy-MM-dd and a real day),
    /// `.some(nil)` for null, `.none` for anything else.
    func day(_ key: String) -> DayString?? {
        switch o[key] {
        case .string(let s)?:
            guard s.utf8.count == 10, let d = DayString(s) else { return .none }
            return .some(d)
        case .null?: return .some(nil)
        default: return .none
        }
    }
    switch action {
    case "pause":
        guard keys.isSubset(of: ["action", "paused", "pausedUntil", "timeZone"]) else { return nil }
        guard case .bool(let paused)? = o["paused"] else { return nil }
        var zone: String? = nil
        if let raw = o["timeZone"] {
            guard case .string(let z) = raw, z.utf16.count <= 100 else { return nil }
            zone = z
        }
        var until: DayString? = nil
        if o["pausedUntil"] != nil {
            // Never null: the schema's `.optional()`.
            guard case .some(.some(let d)) = day("pausedUntil") else { return nil }
            until = d
        }
        if paused { return .pause(until: until, timeZone: zone) }
        return until == nil ? .resume(timeZone: zone) : nil
    case "state":
        guard keys == ["action", "state"], case .string(let raw)? = o["state"] else { return nil }
        if kind == .goal { return GoalState(rawValue: raw).map { .goalState($0) } }
        return SeasonState(rawValue: raw).map { .state($0) }
    case "usualTime":
        guard keys == ["action", "usualTime"], let time = text("usualTime") else { return nil }
        return .usualTime(time)
    case "dates":
        guard keys == ["action", "startsOn", "endsOn"], let start = day("startsOn"), let end = day("endsOn")
        else { return nil }
        return .dates(startsOn: start, endsOn: end)
    case "window":
        guard keys == ["action", "startsOn", "targetOn"], let start = day("startsOn"), let target = day("targetOn")
        else { return nil }
        return .window(startsOn: start, targetOn: target)
    case "notes":
        guard keys == ["action", "notes"], let notes = text("notes") else { return nil }
        return .notes(notes)
    case "why":
        guard keys == ["action", "why"], let why = text("why") else { return nil }
        return .why(why)
    case "rename":
        guard keys == ["action", "name"], case .string(let name)? = o["name"] else { return nil }
        return .rename(name)
    case "icon":
        guard keys == ["action", "icon"], case .string(let icon)? = o["icon"] else { return nil }
        return .icon(icon)
    case "color":
        guard keys == ["action", "color"], let color = text("color") else { return nil }
        return .color(color)
    case "delete":
        guard keys == ["action"] else { return nil }
        return .delete
    default:
        return nil
    }
}

/// The membership intent a body means (O12, O13), read by shape as strictly
/// as the route's schema reads it: nil for any body no membership intent can
/// carry (another action, a key the schema doesn't name, a missing `afterId`
/// or `hold`, a hold that is not a boolean, a step id that is no uuid). Which
/// kind takes it, a step after itself, and a routine id that is no uuid are
/// left to `MembershipWriteBody`'s own answer. A routine id is kept as sent
/// (the planner's ids are never parsed).
private func phoneMembership(_ body: JSONValue) -> MembershipIntent? {
    guard case .object(let o) = body, case .string(let action)? = o["action"] else { return nil }
    let keys = Set(o.keys)
    switch action {
    case "moveMember":
        guard keys == ["action", "itemId", "afterId"], case .string(let raw)? = o["itemId"],
              let item = UUID(uuidString: raw)
        else { return nil }
        switch o["afterId"] {
        case .null?: return .moveMember(item: item, after: nil)
        case .string(let after)?:
            guard let anchor = UUID(uuidString: after) else { return nil }
            return .moveMember(item: item, after: anchor)
        default: return nil
        }
    case "holdRoutine":
        guard keys == ["action", "routineId", "hold"], case .string(let routine)? = o["routineId"],
              case .bool(let hold)? = o["hold"]
        else { return nil }
        return .holdRoutine(routineId: routine, hold: hold)
    default:
        return nil
    }
}

/// A body's value at `key`, or nil when it has none (or is no object).
private func field(_ body: JSONValue, _ key: String) -> JSONValue? {
    guard case .object(let o) = body else { return nil }
    return o[key]
}

/// `body` as the JSON it encodes to.
private func json(_ body: MembershipWriteBody) throws -> JSONValue {
    let data = try JSONEncoder().encode(body)
    return try JSONDecoder().decode(JSONValue.self, from: data)
}

/// A membership body as the phone sends it: the route reads every id
/// lowercased, and the phone sends them lowercased, so a row that sends
/// capitals is the same write with its ids lowercased.
private func lowercasedIDs(_ body: JSONValue) -> JSONValue {
    guard case .object(var o) = body else { return body }
    for key in ["itemId", "afterId", "routineId"] {
        if case .string(let id)? = o[key] { o[key] = .string(id.lowercased()) }
    }
    return .object(o)
}

/// What a create body carries, read by shape as strictly as the route's
/// schema reads it: nil for a body no create can carry (not an object, a key
/// no create schema names, a missing or mistyped id or name, a null icon or
/// first day, a first day that is no day). Values a well-shaped body can still
/// get wrong (an id that is not a uuid, a blank name, an icon off the token
/// rule, a first day on a kind that takes none) are left to
/// `ContainerCreateBody`'s own answer.
private struct CreateShape: Sendable {
    let id: String
    let name: String
    let icon: String?
    let startsOn: DayString?
}

private func createShape(_ body: JSONValue) -> CreateShape? {
    guard case .object(let o) = body else { return nil }
    guard Set(o.keys).isSubset(of: ["id", "name", "icon", "startsOn"]) else { return nil }
    guard case .string(let id)? = o["id"], case .string(let name)? = o["name"] else { return nil }
    var icon: String? = nil
    if let raw = o["icon"] {
        guard case .string(let token) = raw else { return nil }
        icon = token
    }
    var startsOn: DayString? = nil
    if let raw = o["startsOn"] {
        guard case .string(let s) = raw, s.utf8.count == 10, let day = DayString(s) else { return nil }
        startsOn = day
    }
    return CreateShape(id: id, name: name, icon: icon, startsOn: startsOn)
}

/// The phone's body for a shape on `kind`'s route, or nil where it builds none.
private func phoneCreate(_ shape: CreateShape, kind: OrganizeKind) -> ContainerCreateBody? {
    return ContainerCreateBody(kind: kind, id: shape.id, name: shape.name, icon: shape.icon, startsOn: shape.startsOn)
}

/// `body` as the JSON it encodes to.
private func json(_ body: ContainerCreateBody) throws -> JSONValue {
    let data = try JSONEncoder().encode(body)
    return try JSONDecoder().decode(JSONValue.self, from: data)
}

/// A create body as the phone sends it: the route takes an id in any case as
/// its lowercase self, and `ContainerCreateBody` lowercases it at once, so a
/// row that sends capitals is the same create with its id lowercased.
private func lowercasedID(_ body: JSONValue) -> JSONValue {
    guard case .object(var o) = body, case .string(let id)? = o["id"] else { return body }
    o["id"] = .string(id.lowercased())
    return .object(o)
}

/// Every intent the phone could build out of the values the fixture names
/// (each day, zone, time, text, name, icon and colour, in every slot that
/// takes one, plus nil where a slot takes none): the nearest the phone could
/// come to each refused body.
private func buildable(from bodies: [JSONValue]) -> [ContainerIntent] {
    var days: [DayString?] = [nil]
    var zones: [String?] = [nil]
    var times: [String?] = [nil]
    var texts: [String?] = [nil]
    var names: [String] = []
    var icons: [String] = []
    var colors: [String?] = [nil]
    func add<T: Equatable>(_ value: T, to list: inout [T]) { if !list.contains(value) { list.append(value) } }
    for body in bodies {
        guard case .object(let o) = body else { continue }
        for (key, value) in o {
            guard case .string(let s) = value else { continue }
            switch key {
            case "pausedUntil", "startsOn", "endsOn", "targetOn":
                if s.utf8.count == 10, let d = DayString(s) { add(d, to: &days) }
            case "timeZone": add(s, to: &zones)
            case "usualTime": add(s, to: &times)
            case "notes", "why": add(s, to: &texts)
            case "name": add(s, to: &names)
            case "icon": add(s, to: &icons)
            case "color": add(s, to: &colors)
            default: break
            }
        }
    }
    var out: [ContainerIntent] = SeasonState.allCases.map { .state($0) } + GoalState.allCases.map { .goalState($0) }
    out.append(.delete)
    for zone in zones {
        out.append(.resume(timeZone: zone))
        for day in days { out.append(.pause(until: day, timeZone: zone)) }
    }
    for start in days {
        for end in days {
            out.append(.dates(startsOn: start, endsOn: end))
            out.append(.window(startsOn: start, targetOn: end))
        }
    }
    out += times.map { .usualTime($0) }
    out += texts.map { .notes($0) } + texts.map { .why($0) }
    out += names.map { .rename($0) } + icons.map { .icon($0) } + colors.map { .color($0) }
    return out
}

/// Every membership intent the phone could build out of the ids the fixture
/// names (each step id with every anchor and none; each routine id put in and
/// taken out): the nearest the phone could come to each refused body.
private func buildableMemberships(from bodies: [JSONValue]) -> [MembershipIntent] {
    var steps: [UUID] = []
    var routines: [String] = []
    func add<T: Equatable>(_ value: T, to list: inout [T]) { if !list.contains(value) { list.append(value) } }
    for body in bodies {
        guard case .object(let o) = body else { continue }
        for key in ["itemId", "afterId"] {
            if case .string(let s)? = o[key], let id = UUID(uuidString: s) { add(id, to: &steps) }
        }
        if case .string(let s)? = o["routineId"] { add(s, to: &routines) }
    }
    var out: [MembershipIntent] = []
    for item in steps {
        out.append(.moveMember(item: item, after: nil))
        for after in steps { out.append(.moveMember(item: item, after: after)) }
    }
    for routine in routines {
        out.append(.holdRoutine(routineId: routine, hold: true))
        out.append(.holdRoutine(routineId: routine, hold: false))
    }
    return out
}

@Suite struct ContainerWritesFixtureTests {
    /// Every action the phone has is in the fixture on every kind that takes
    /// it, and every state of each kind's Status.
    @Test func everyKindAndIntentHasCases() throws {
        let f = try load()
        for kind in OrganizeKind.allCases {
            #expect(f.cases.contains { $0.kind == kind }, "\(kind)")
        }
        #expect(f.cases.contains { $0.refused != nil })
        #expect(f.cases.contains { $0.patch == [:] })
        #expect(!f.invalid.isEmpty)
        let intents = f.cases.compactMap { c in phoneIntent(c.body, kind: c.kind).map { (c.kind, $0) } }
        #expect(intents.count == f.cases.count)
        // `cases` are the field intents; the delete and the create have their
        // own sections, each on every kind, and so do a move and a hold (O12,
        // O13), each on its one kind.
        let ownSections: Set<ContainerAction> = [.delete, .create, .moveMember, .holdRoutine]
        for action in ContainerAction.allCases where !ownSections.contains(action) {
            for kind in action.kinds {
                #expect(intents.contains { $0.0 == kind && $0.1.action == action }, "\(action) on \(kind)")
            }
        }
        #expect(!intents.contains { $0.1.action == .delete })
        for kind in ContainerAction.delete.kinds {
            #expect(f.deletes.contains { $0.kind == kind.rawValue }, "delete on \(kind)")
        }
        for kind in ContainerAction.create.kinds {
            #expect(f.creates.contains { $0.kind == kind }, "create on \(kind)")
            #expect(f.createInvalid.contains { $0.kind == kind.rawValue }, "an invalid create on \(kind)")
        }
        #expect(f.moves.allSatisfy { $0.kind == "routine" } && ContainerAction.moveMember.kinds == [.routine])
        #expect(f.holds.allSatisfy { $0.kind == "season" } && ContainerAction.holdRoutine.kinds == [.season])
        for code in ["member_gone", "anchor_gone"] {
            #expect(f.moves.contains { $0.expected.error == code }, "\(code)")
        }
        #expect(f.moves.contains { $0.expected.status == 200 && field($0.body, "afterId") == .null })
        #expect(f.holds.contains { $0.expected.error == "container_gone" })
        #expect(f.holds.contains { c in c.expected.status == 200 && field(c.body, "hold") == .bool(true) })
        #expect(f.holds.contains { c in c.expected.status == 200 && field(c.body, "hold") == .bool(false) })
        #expect(f.invalid.contains { phoneMembership($0.body) != nil })
        #expect(intents.contains { if case .pause = $0.1 { return true }; return false })
        #expect(intents.contains { if case .resume = $0.1 { return true }; return false })
        for state in SeasonState.allCases {
            #expect(intents.contains { $0.1 == .state(state) }, "state \(state.rawValue)")
        }
        for state in GoalState.allCases {
            #expect(intents.contains { $0.1 == .goalState(state) }, "goal state \(state.rawValue)")
        }
    }

    /// The phone's body for each case is the JSON the route took, key for
    /// key: a pause's day and zone only when sent, never null; both ends of a
    /// range always, null when open; a clear as null.
    @Test func eachBodyIsTheWireJSON() throws {
        for c in try load().cases {
            let intent = try #require(phoneIntent(c.body, kind: c.kind), "\(c.name): a body the phone can't mean")
            #expect(intent.isWellFormed, "\(c.name)")
            let body = try #require(ContainerWriteBody(intent, for: c.kind), "\(c.name): not one \(c.kind) takes")
            #expect(body.action == intent.action, "\(c.name)")
            #expect(try json(body) == c.body, "\(c.name)")
        }
    }

    /// `containerIntentPatch` answers as the route did: the same refusal and
    /// status, or the same patch, a cleared field as null and "already so" as
    /// nothing. `today` is the instant's day in the zone, as the server reads
    /// it.
    @Test func eachPatchIsTheWebsPatch() throws {
        for c in try load().cases {
            let intent = try #require(phoneIntent(c.body, kind: c.kind), "\(c.name)")
            let now = try #require(parseTimestamp(c.now), "\(c.name): bad instant \(c.now)")
            #expect(toDateStr(now, timeZone: c.timeZone)?.description == c.today, "\(c.name): today")
            let result = containerIntentPatch(intent, on: c.before, now: now, timeZone: c.timeZone, today: c.today)
            switch result {
            case .patch(let patch):
                #expect(c.refused == nil, "\(c.name): expected \(c.refused ?? "")")
                #expect(c.status == 200, "\(c.name)")
                #expect(wire(patch) == c.patch, "\(c.name): \(wire(patch))")
                #expect(patch.isEmpty == (c.patch == [:]), "\(c.name): isEmpty")
            case .refused(let code, let status):
                #expect(code == c.refused, "\(c.name): refused \(code)")
                #expect(status == c.status, "\(c.name)")
                #expect(c.patch == nil, "\(c.name)")
            case .removed:
                Issue.record("\(c.name): a field case answered as a delete")
            }
        }
    }

    /// The phone's step ends where the route's row ended: `after`, a cleared
    /// field gone, a refusal changing nothing, membership untouched.
    @Test func eachStepEndsWhereTheRowEnded() throws {
        for c in try load().cases {
            let intent = try #require(phoneIntent(c.body, kind: c.kind), "\(c.name)")
            let now = try #require(parseTimestamp(c.now), "\(c.name)")
            let after = applyingContainer(intent, to: c.before, at: now, timeZone: c.timeZone, today: c.today)
            #expect(after == c.after, "\(c.name): \(after)")
            // The patch path agrees with the step.
            if case .patch(let patch) = containerIntentPatch(
                intent, on: c.before, now: now, timeZone: c.timeZone, today: c.today
            ) {
                #expect(patch.applied(to: c.before) == c.after, "\(c.name): applied")
            } else {
                #expect(c.after == c.before, "\(c.name): a refusal changes nothing")
            }
            // A second identical request, at the same instant, leaves the
            // container as the first did (design §5.7): a retry never restamps.
            let again = applyingContainer(intent, to: after, at: now, timeZone: c.timeZone, today: c.today)
            #expect(again == after, "\(c.name): a retry moved it")
            // And never a member list.
            #expect(after.withMembership(of: c.before) == after, "\(c.name): membership moved")
        }
    }

    /// The zone pair the phone must get right: one instant, the 23rd in New
    /// York and the 24th in UTC, so the same "until the 24th" is taken in one
    /// and refused in the other.
    @Test func theZonePairIsCovered() throws {
        let cases = try load().cases
        let pairs = Dictionary(grouping: cases, by: \.now).values.filter { group in
            group.contains { $0.status == 200 && $0.patch?["pausedUntil"] != nil }
                && group.contains { $0.refused == "pause_refused" }
                && Set(group.map(\.today)).count > 1
        }
        #expect(!pairs.isEmpty)
    }

    /// The bodies the route refuses are bodies the phone never builds: each
    /// one either means no intent at all, or one the kind's route doesn't
    /// take or whose values its schema refuses; and no body the phone can
    /// build for that kind, out of every value the fixture names, is it.
    @Test func theRefusedBodiesAreNeverBuilt() throws {
        let f = try load()
        let intents = buildable(from: f.cases.map(\.body) + f.invalid.map(\.body))
        var built: [OrganizeKind: Set<JSONValue>] = [:]
        let memberships = buildableMemberships(
            from: f.cases.map(\.body) + f.invalid.map(\.body) + f.moves.map(\.body) + f.holds.map(\.body)
        )
        for kind in OrganizeKind.allCases {
            var bodies = Set<JSONValue>()
            for intent in intents {
                guard let body = ContainerWriteBody(intent, for: kind) else { continue }
                bodies.insert(try json(body))
            }
            for intent in memberships {
                guard let body = MembershipWriteBody(intent, for: kind) else { continue }
                bodies.insert(try json(body))
            }
            built[kind] = bodies
        }
        for c in f.invalid {
            #expect(c.expected.status == 400 && c.expected.error == "invalid", "\(c.name)")
            let kind = try #require(OrganizeKind(rawValue: c.kind), "\(c.name): kind \(c.kind)")
            if let membership = phoneMembership(c.body) {
                #expect(MembershipWriteBody(membership, for: kind) == nil, "\(c.name): the phone would build it")
            }
            if let intent = phoneIntent(c.body, kind: kind) {
                #expect(ContainerWriteBody(intent, for: kind) == nil, "\(c.name): the phone would build it")
                if let container = sample(kind) {
                    #expect(containerIntentPatch(intent, on: container, now: noon, timeZone: "UTC", today: "2026-10-23")
                        == .refused(code: "invalid", status: 400), "\(c.name): the step takes it")
                }
            }
            #expect(built[kind]?.contains(c.body) == false, "\(c.name): the phone builds it")
        }
    }

    /// O10: the phone's delete is the body the route took on every kind, the
    /// action alone; the rule answers it `.removed` and writes no field, and
    /// the step that honours it takes the container away.
    @Test func eachDeleteIsTheWireJSON() throws {
        let deletes = try load().deletes
        #expect(Set(deletes.map(\.kind)) == Set(OrganizeKind.allCases.map(\.rawValue)))
        for c in deletes {
            let kind = try #require(OrganizeKind(rawValue: c.kind), "\(c.name): kind \(c.kind)")
            #expect(c.expected.status == 200, "\(c.name)")
            let intent = try #require(phoneIntent(c.body, kind: kind), "\(c.name): a body the phone can't mean")
            #expect(intent == .delete, "\(c.name)")
            #expect(intent.isWellFormed && intent.applies(to: kind), "\(c.name)")
            let body = try #require(ContainerWriteBody(intent, for: kind), "\(c.name): not one \(kind) takes")
            #expect(body.action == .delete, "\(c.name)")
            #expect(try json(body) == c.body, "\(c.name)")
            let container = try #require(sample(kind))
            #expect(containerIntentPatch(intent, on: container, now: noon, timeZone: "UTC", today: "2026-10-23")
                == .removed, "\(c.name)")
            #expect(containerAfter(intent, on: container, at: noon, timeZone: "UTC", today: "2026-10-23") == nil,
                    "\(c.name)")
            // No field moves: the fields-only step hands it back as it was.
            #expect(applyingContainer(intent, to: container, at: noon, timeZone: "UTC", today: "2026-10-23")
                == container, "\(c.name)")
        }
    }

    /// O12: the phone's move is the body the route took, ids lowercased and
    /// `afterId` always (null for first); and its own answer over the order
    /// the route read is the route's: the order it wrote, or the refusal with
    /// nothing moved. A second send of a move that landed writes nothing.
    @Test func eachMoveIsTheRoutes() throws {
        let moves = try load().moves
        #expect(moves.count >= 10)
        // One row sends capitals; the route reads them lowercase.
        #expect(moves.contains { lowercasedIDs($0.body) != $0.body })
        for c in moves {
            let intent = try #require(phoneMembership(c.body), "\(c.name): a body the phone can't mean")
            guard case .moveMember(let item, let after) = intent else {
                Issue.record("\(c.name): not a move")
                continue
            }
            #expect(intent.action == .moveMember && intent.kind == .routine, "\(c.name)")
            let body = try #require(MembershipWriteBody(intent, for: .routine), "\(c.name): the phone builds none")
            #expect(body.action == .moveMember, "\(c.name)")
            #expect(try json(body) == lowercasedIDs(c.body), "\(c.name)")
            let before = try #require(organizeUUIDs(c.before.itemIds), "\(c.name): before")
            let expected = try #require(organizeUUIDs(c.expected.itemIds), "\(c.name): expected")
            switch memberMoveResult(before, item: item, after: after) {
            case .members(let order):
                #expect(c.expected.status == 200 && c.expected.error == nil, "\(c.name): expected \(c.expected.error ?? "")")
                #expect(order == expected, "\(c.name): \(order)")
                #expect(order == moveMemberAfter(before, item: item, after: after), "\(c.name): moveMemberAfter")
                #expect(memberMoveResult(order, item: item, after: after) == .members(order), "\(c.name): a retry")
            case .refused(let code, let status):
                #expect(code == c.expected.error && status == c.expected.status, "\(c.name): refused \(code)")
                #expect(expected == before, "\(c.name): a refusal moves nothing")
            }
        }
    }

    /// O13: the phone's hold is the body the route took, the routine id
    /// lowercased; and its own answer over the routines the route read is the
    /// route's: them with the routine in or out (the payload lists them by
    /// routine id, so as a set), or `container_gone` with nothing changed for
    /// a routine that is not live. A second send writes nothing.
    @Test func eachHoldIsTheRoutes() throws {
        let holds = try load().holds
        #expect(holds.count >= 6)
        #expect(holds.contains { lowercasedIDs($0.body) != $0.body })
        for c in holds {
            let intent = try #require(phoneMembership(c.body), "\(c.name): a body the phone can't mean")
            guard case .holdRoutine(let sent, let hold) = intent else {
                Issue.record("\(c.name): not a hold")
                continue
            }
            #expect(intent.action == .holdRoutine && intent.kind == .season, "\(c.name)")
            let body = try #require(MembershipWriteBody(intent, for: .season), "\(c.name): the phone builds none")
            #expect(body.action == .holdRoutine, "\(c.name)")
            #expect(try json(body) == lowercasedIDs(c.body), "\(c.name)")
            // The route reads the id lowercased; the phone's ids already are.
            let routineId = sent.lowercased()
            switch routineHoldResult(c.before.routineIds, routineId: routineId, hold: hold, routineLive: c.routineLive) {
            case .members(let held):
                #expect(c.expected.status == 200 && c.expected.error == nil, "\(c.name): expected \(c.expected.error ?? "")")
                #expect(Set(held) == Set(c.expected.routineIds) && held.count == c.expected.routineIds.count,
                        "\(c.name): \(held)")
                #expect(routineHoldResult(held, routineId: routineId, hold: hold, routineLive: true) == .members(held),
                        "\(c.name): a retry")
                // A hold or take-out already so is the list as it was, in its order.
                if Set(c.before.routineIds) == Set(c.expected.routineIds) {
                    #expect(held == c.before.routineIds, "\(c.name): already so")
                }
            case .refused(let code, let status):
                #expect(code == c.expected.error && status == c.expected.status, "\(c.name): refused \(code)")
                #expect(c.expected.routineIds == c.before.routineIds, "\(c.name): a refusal changes nothing")
            }
        }
    }

    /// O11: the phone's create is the body the route took, and the container
    /// it makes at once is the row the route read back: the name trimmed, a
    /// season `auto`, a goal `active` from its first day, a project's glyph in
    /// its `emoji` (empty with none), and nothing in any of them.
    @Test func eachCreateIsTheWireJSONAndTheRow() throws {
        let creates = try load().creates
        // One row sends its id in capitals; the id the route answers is lowercase.
        #expect(creates.contains { createShape($0.body).map { $0.id != $0.id.lowercased() } ?? false })
        for c in creates {
            #expect(c.status == 200, "\(c.name)")
            let shape = try #require(createShape(c.body), "\(c.name): a body no create carries")
            let body = try #require(phoneCreate(shape, kind: c.kind), "\(c.name): the phone builds none")
            #expect(body.kind == c.kind, "\(c.name)")
            #expect(try json(body) == lowercasedID(c.body), "\(c.name)")
            #expect(body.id == c.id, "\(c.name): id")
            #expect(body.ref == ContainerRef(kind: c.kind, id: c.id), "\(c.name): ref")
            #expect(body.storedName == c.after.name, "\(c.name): name")
            #expect(containerCreateRecord(body) == c.after, "\(c.name): \(containerCreateRecord(body))")
            #expect(ContainerRoutes.create(c.kind) == "/api/app/containers/\(c.kind.rawValue)", "\(c.name)")
            // The record is the planner's new container: its own id, nothing
            // in it, and every field intent steps it as any other.
            #expect(containerCreateRecord(body).ref == body.ref, "\(c.name)")
            #expect(containerCreateRecord(body).withMembership(of: c.after) == c.after, "\(c.name)")
        }
    }

    /// The bodies the create route refuses are bodies the phone never builds:
    /// each either carries no create at all, or one `ContainerCreateBody`
    /// refuses; and no body the phone can build for that kind, out of every
    /// value the fixture names, is it.
    @Test func theRefusedCreatesAreNeverBuilt() throws {
        let f = try load()
        let bodies = f.creates.map(\.body) + f.createInvalid.map(\.body)
        var ids: [String] = []
        var names: [String] = []
        var icons: [String?] = [nil]
        var days: [DayString?] = [nil]
        func add<T: Equatable>(_ value: T, to list: inout [T]) { if !list.contains(value) { list.append(value) } }
        for body in bodies {
            guard case .object(let o) = body else { continue }
            if case .string(let s)? = o["id"] { add(s, to: &ids); add(s.uppercased(), to: &ids) }
            if case .string(let s)? = o["name"] { add(s, to: &names) }
            if case .string(let s)? = o["icon"] { add(s, to: &icons) }
            if case .string(let s)? = o["startsOn"], s.utf8.count == 10, let d = DayString(s) { add(d, to: &days) }
        }
        var built: [OrganizeKind: Set<JSONValue>] = [:]
        for kind in OrganizeKind.allCases {
            var out = Set<JSONValue>()
            for id in ids {
                for name in names {
                    for icon in icons {
                        for day in days {
                            guard let body = ContainerCreateBody(kind: kind, id: id, name: name, icon: icon, startsOn: day)
                            else { continue }
                            out.insert(try json(body))
                        }
                    }
                }
            }
            built[kind] = out
        }
        for c in f.createInvalid {
            #expect(c.expected.status == 400 && c.expected.error == "invalid", "\(c.name)")
            let kind = try #require(OrganizeKind(rawValue: c.kind), "\(c.name): kind \(c.kind)")
            if let shape = createShape(c.body) {
                #expect(phoneCreate(shape, kind: kind) == nil, "\(c.name): the phone would build it")
            }
            #expect(built[kind]?.contains(c.body) == false, "\(c.name): the phone builds it")
        }
        // Every row the route took, the phone builds, on its kind alone where
        // the body names a first day.
        for c in f.creates {
            #expect(built[c.kind]?.contains(lowercasedID(c.body)) == true, "\(c.name)")
        }
    }

    /// The create sheet's own body: the kind's starting glyph, and for a goal
    /// a window that opens on the day given. Where the fixture sent the same,
    /// it is the same JSON.
    @Test func theCreateSheetSendsTheWebsDefaults() throws {
        let f = try load()
        let today = try #require(DayString("2026-10-23"))
        for kind in OrganizeKind.allCases {
            let id = "cccccccc-0000-4000-8000-0000000000f\(OrganizeKind.allCases.firstIndex(of: kind)!)"
            let body = try #require(ContainerCreateBody(kind, id: id, name: "Evening", today: today), "\(kind)")
            #expect(body.icon == OrganizeCopy.createCopy(kind).icon, "\(kind)")
            #expect(body.startsOn == (kind == .goal ? today : nil), "\(kind)")
        }
        var matched = 0
        for c in f.creates {
            guard let shape = createShape(c.body), shape.icon == OrganizeCopy.createCopy(c.kind).icon,
                  c.kind != .goal || shape.startsOn == today
            else { continue }
            let sheet = try #require(ContainerCreateBody(c.kind, id: shape.id, name: shape.name, today: today), "\(c.name)")
            #expect(try json(sheet) == lowercasedID(c.body), "\(c.name)")
            matched += 1
        }
        #expect(matched >= OrganizeKind.allCases.count)
    }
}

/// A container of `kind` with nothing set, to step a refused intent on.
private func sample(_ kind: OrganizeKind) -> ContainerSnapshot? {
    switch kind {
    case .routine: return .routine(Routine(id: "r", name: "Evening"))
    case .season: return .season(Season(id: "s", name: "Autumn"))
    case .goal: return .goal(Goal(id: "g", name: "Run"))
    case .project: return .project(Project(id: "p", name: "Home"))
    }
}

// MARK: - Hand-written cases

private let one = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
private let two = UUID(uuidString: "00000000-0000-4000-8000-000000000002")!
private let three = UUID(uuidString: "00000000-0000-4000-8000-000000000003")!
private let noon = parseTimestamp("2026-10-23T17:00:00.000Z")!
private let oct23 = DayString("2026-10-23")!

@Suite struct ContainerIntentTests {
    @Test func eachActionBelongsToItsKinds() {
        #expect(ContainerAction.pause.kinds == [.routine])
        #expect(ContainerAction.state.kinds == [.season, .goal])
        #expect(ContainerAction.usualTime.kinds == [.routine])
        #expect(ContainerAction.dates.kinds == [.season])
        #expect(ContainerAction.window.kinds == [.goal])
        #expect(ContainerAction.notes.kinds == [.routine, .season, .project])
        #expect(ContainerAction.why.kinds == [.goal])
        for action in [ContainerAction.rename, .icon, .color, .delete, .create] {
            #expect(action.kinds == [.routine, .season, .goal, .project])
        }
        #expect(ContainerAction.moveMember.kinds == [.routine])
        #expect(ContainerAction.holdRoutine.kinds == [.season])
        #expect(ContainerIntent.delete.action == .delete)
        for kind in OrganizeKind.allCases {
            #expect(ContainerIntent.delete.applies(to: kind))
        }
        #expect(ContainerIntent.delete.isWellFormed)
        #expect(ContainerIntent.delete.removesContainer)
        #expect(ContainerIntent.delete.timeZone == nil)
        #expect(ContainerIntent.delete.renamedTo == nil)
        #expect(!ContainerIntent.rename("x").removesContainer)
        #expect(!ContainerIntent.color(nil).removesContainer)
        #expect(ContainerIntent.pause(until: nil, timeZone: nil).action == .pause)
        #expect(ContainerIntent.resume(timeZone: "UTC").action == .pause)
        #expect(ContainerIntent.state(.active).action == .state)
        #expect(ContainerIntent.goalState(.achieved).action == .state)
        #expect(ContainerIntent.resume(timeZone: "UTC").applies(to: .routine))
        #expect(!ContainerIntent.resume(timeZone: "UTC").applies(to: .season))
        #expect(ContainerIntent.state(.auto).applies(to: .season))
        // A Status is its own kind's: a season's three on a season, a goal's on a goal.
        #expect(ContainerIntent.state(.auto).kinds == [.season])
        #expect(ContainerIntent.goalState(.active).kinds == [.goal])
        #expect(!ContainerIntent.goalState(.active).applies(to: .season))
        for kind in [OrganizeKind.goal, .project] {
            #expect(!ContainerIntent.state(.auto).applies(to: kind))
            #expect(!ContainerIntent.pause(until: nil, timeZone: nil).applies(to: kind))
        }
        #expect(!ContainerIntent.notes("x").applies(to: .goal))
        #expect(!ContainerIntent.why("x").applies(to: .project))
        #expect(ContainerIntent.rename("x").applies(to: .project))
        #expect(ContainerIntent.pause(until: oct23, timeZone: "UTC").timeZone == "UTC")
        #expect(ContainerIntent.state(.paused).timeZone == nil)
        #expect(ContainerIntent.rename("x").timeZone == nil)
    }

    /// The server's own order (each kind's fields, then notes or why, then
    /// rename, icon and colour): what `allCases` read per kind gives, so the
    /// sample's list matches a real one.
    @Test func theActionsReadInTheServersOrder() {
        func list(_ kind: OrganizeKind) -> [String] {
            ContainerAction.allCases.filter { $0.kinds.contains(kind) }.map(\.rawValue)
        }
        #expect(list(.routine) == [
            "pause", "usualTime", "notes", "rename", "icon", "color", "moveMember", "delete", "create",
        ])
        #expect(list(.season) == [
            "state", "dates", "notes", "rename", "icon", "color", "holdRoutine", "delete", "create",
        ])
        #expect(list(.goal) == ["state", "window", "why", "rename", "icon", "color", "delete", "create"])
        #expect(list(.project) == ["notes", "rename", "icon", "color", "delete", "create"])
    }

    /// A body goes only to a route whose union holds its action, and carries
    /// a zone only when there is one the schema takes.
    @Test func aBodyIsBuiltOnlyForItsKind() throws {
        #expect(ContainerWriteBody(.state(.active), for: .routine) == nil)
        #expect(ContainerWriteBody(.state(.active), for: .goal) == nil)
        #expect(ContainerWriteBody(.goalState(.active), for: .season) == nil)
        #expect(ContainerWriteBody(.pause(until: nil, timeZone: nil), for: .season) == nil)
        #expect(ContainerWriteBody(.resume(timeZone: nil), for: .goal) == nil)
        #expect(ContainerWriteBody(.state(.paused), for: .project) == nil)
        #expect(ContainerWriteBody(.usualTime("07:00"), for: .project) == nil)
        #expect(ContainerWriteBody(.notes("x"), for: .goal) == nil)
        #expect(ContainerWriteBody(.why("x"), for: .routine) == nil)
        #expect(ContainerWriteBody(.dates(startsOn: nil, endsOn: nil), for: .goal) == nil)
        #expect(ContainerWriteBody(.window(startsOn: nil, targetOn: nil), for: .season) == nil)

        let resume = try #require(ContainerWriteBody(.resume(timeZone: "Europe/London"), for: .routine))
        #expect(try json(resume) == .object([
            "action": .string("pause"), "paused": .bool(false), "timeZone": .string("Europe/London"),
        ]))
        let until = try #require(ContainerWriteBody(.pause(until: DayString("2026-11-02"), timeZone: ""), for: .routine))
        #expect(try json(until) == .object([
            "action": .string("pause"), "paused": .bool(true), "pausedUntil": .string("2026-11-02"),
        ]))
        let long = String(repeating: "x", count: 101)
        let tooLong = try #require(ContainerWriteBody(.pause(until: nil, timeZone: long), for: .routine))
        #expect(try json(tooLong) == .object(["action": .string("pause"), "paused": .bool(true)]))
        let atLimit = String(repeating: "y", count: 100)
        let fits = try #require(ContainerWriteBody(.resume(timeZone: atLimit), for: .routine))
        #expect(try json(fits) == .object([
            "action": .string("pause"), "paused": .bool(false), "timeZone": .string(atLimit),
        ]))
        let off = try #require(ContainerWriteBody(.state(.paused), for: .season))
        #expect(try json(off) == .object(["action": .string("state"), "state": .string("paused")]))
        #expect(off.action == .state)
        // O10: a delete goes to every kind's route, the action alone.
        for kind in OrganizeKind.allCases {
            let delete = try #require(ContainerWriteBody(.delete, for: kind), "\(kind)")
            #expect(try json(delete) == .object(["action": .string("delete")]), "\(kind)")
        }
    }

    /// From O8b and O9: a clear and an open end are explicit nulls, since
    /// the schema's keys are required; a glyph is never null.
    @Test func theFieldBodiesSendEveryKeyTheirSchemaWants() throws {
        func body(_ intent: ContainerIntent, _ kind: OrganizeKind) throws -> JSONValue {
            return try json(try #require(ContainerWriteBody(intent, for: kind), "\(intent) on \(kind)"))
        }
        #expect(try body(.usualTime(nil), .routine) == .object(["action": .string("usualTime"), "usualTime": .null]))
        #expect(try body(.dates(startsOn: oct23, endsOn: nil), .season) == .object([
            "action": .string("dates"), "startsOn": .string("2026-10-23"), "endsOn": .null,
        ]))
        #expect(try body(.window(startsOn: nil, targetOn: nil), .goal) == .object([
            "action": .string("window"), "startsOn": .null, "targetOn": .null,
        ]))
        #expect(try body(.goalState(.abandoned), .goal) == .object([
            "action": .string("state"), "state": .string("abandoned"),
        ]))
        #expect(try body(.notes(nil), .project) == .object(["action": .string("notes"), "notes": .null]))
        #expect(try body(.why("Because."), .goal) == .object(["action": .string("why"), "why": .string("Because.")]))
        #expect(try body(.rename("House"), .project) == .object(["action": .string("rename"), "name": .string("House")]))
        #expect(try body(.icon(ContainerLook.iconToken("Moon")), .season) == .object([
            "action": .string("icon"), "icon": .string("icon:Moon"),
        ]))
        #expect(try body(.color(nil), .goal) == .object(["action": .string("color"), "color": .null]))
        #expect(try body(.color("var(--accent-8)"), .routine) == .object([
            "action": .string("color"), "color": .string("var(--accent-8)"),
        ]))
    }

    /// The values the route's schema refuses are refused here too, at their
    /// edges: no body, and the step answers 400 and changes nothing.
    @Test func theSchemasValuesAreTheRoutes() {
        let routine = ContainerSnapshot.routine(Routine(id: "r", name: "Evening"))
        let goal = ContainerSnapshot.goal(Goal(id: "g", name: "Run"))
        let take: [(ContainerIntent, ContainerSnapshot)] = [
            (.usualTime("00:00"), routine), (.usualTime("23:59"), routine), (.usualTime("19:05"), routine),
            (.notes(String(repeating: "n", count: EditLimits.outerNotes)), routine),
            (.why(String(repeating: "w", count: EditLimits.outerNotes)), goal),
            (.rename(String(repeating: "a", count: EditLimits.outerTitle)), routine),
            (.rename("  " + String(repeating: "a", count: EditLimits.outerTitle) + "\n"), routine),
            (.rename("\u{1F3E0}"), routine),
            (.icon("icon:" + String(repeating: "A", count: 64)), goal), (.icon("icon:Z9"), routine),
            (.color("var(--accent-1)"), routine),
            (.window(startsOn: DayString("0100-01-01"), targetOn: DayString("9999-12-31")), goal),
            (.window(startsOn: oct23, targetOn: oct23), goal),
        ]
        let refuse: [(ContainerIntent, ContainerSnapshot)] = [
            (.usualTime("24:00"), routine), (.usualTime("7:15"), routine), (.usualTime("07:60"), routine),
            (.usualTime("07:15 "), routine), (.usualTime("\u{FF10}7:15"), routine), (.usualTime(""), routine),
            (.notes(String(repeating: "n", count: EditLimits.outerNotes + 1)), routine),
            (.why(String(repeating: "w", count: EditLimits.outerNotes + 1)), goal),
            (.rename(String(repeating: "a", count: EditLimits.outerTitle + 1)), routine),
            (.rename(" \n\t "), routine), (.rename(""), routine),
            (.icon("icon:" + String(repeating: "A", count: 65)), goal), (.icon("icon:"), routine),
            (.icon("Moon"), routine), (.icon("icon:Calendar-Range"), routine), (.icon("icon:Caf\u{E9}"), routine),
            (.icon("ICON:Moon"), routine),
            (.color("var(--accent-0)"), routine), (.color("var(--accent-9)"), routine),
            (.color("var(--habit-work)"), routine), (.color("#ff8800"), routine), (.color(""), routine),
            (.window(startsOn: DayString("0099-12-31"), targetOn: nil), goal),
            (.pause(until: DayString("0050-01-01"), timeZone: nil), routine),
            (.window(startsOn: DayString("2026-10-24"), targetOn: oct23), goal),
        ]
        for (intent, container) in take {
            #expect(intent.isWellFormed, "\(intent)")
            #expect(ContainerWriteBody(intent, for: container.kind) != nil, "\(intent)")
        }
        for (intent, container) in refuse {
            #expect(!intent.isWellFormed, "\(intent)")
            #expect(ContainerWriteBody(intent, for: container.kind) == nil, "\(intent)")
            #expect(containerIntentPatch(intent, on: container, now: noon, timeZone: "UTC", today: "2026-10-23")
                == .refused(code: "invalid", status: 400), "\(intent)")
            #expect(applyingContainer(intent, to: container, at: noon, timeZone: "UTC", today: "2026-10-23")
                == container, "\(intent)")
        }
    }

    @Test func theRouteIsTheKindAndTheLowercasedId() {
        let ref = ContainerRef(kind: .season, id: "4B1D3C2A-0000-4000-8000-00000000ABCD")
        #expect(ContainerRoutes.write(ref) == "/api/app/containers/season/4b1d3c2a-0000-4000-8000-00000000abcd")
        #expect(ContainerRoutes.write(ContainerRef(kind: .routine, id: "r1")) == "/api/app/containers/routine/r1")
        #expect(ContainerRoutes.write(ContainerRef(kind: .project, id: "p1")) == "/api/app/containers/project/p1")
    }

    /// The web compares the state as stored, so a value it reads as `auto`
    /// is still rewritten as `auto`; the same state is nothing.
    @Test func aSeasonsStateIsComparedAsStored() {
        let odd = ContainerSnapshot.season(Season(id: "s", name: "Odd", state: "someday"))
        #expect(containerIntentPatch(.state(.auto), on: odd, now: noon, timeZone: "UTC", today: "2026-10-23")
            == .patch(ContainerPatch(state: .auto)))
        let pinned = ContainerSnapshot.season(Season(id: "s", name: "Pinned", state: "active"))
        #expect(containerIntentPatch(.state(.active), on: pinned, now: noon, timeZone: "UTC", today: "2026-10-23")
            == .patch(ContainerPatch()))
    }

    /// lib/goals.ts `resolveGoalStateWrite`: the state it has is nothing (so
    /// a second Achieved keeps the first stamp), compared as stored; Achieved
    /// stamps, Active clears, Set aside keeps.
    @Test func aGoalsStateIsResolveGoalStateWrite() {
        let stamped = "2026-10-16T09:30:00.000Z"
        let active = Goal(id: "g", name: "Run")
        let achieved = Goal(id: "g", name: "Run", state: "achieved", achievedAt: stamped)
        let odd = Goal(id: "g", name: "Run", state: "someday", achievedAt: stamped)
        #expect(resolveGoalStateWrite(achieved, state: .achieved, nowISO: "x") == GoalStatePatch())
        #expect(resolveGoalStateWrite(achieved, state: .achieved, nowISO: "x").isEmpty)
        #expect(resolveGoalStateWrite(active, state: .achieved, nowISO: "now")
            == GoalStatePatch(state: .achieved, achievedAt: .set("now")))
        #expect(resolveGoalStateWrite(achieved, state: .active, nowISO: "now")
            == GoalStatePatch(state: .active, achievedAt: .clear))
        #expect(resolveGoalStateWrite(achieved, state: .abandoned, nowISO: "now") == GoalStatePatch(state: .abandoned))
        #expect(resolveGoalStateWrite(odd, state: .active, nowISO: "now")
            == GoalStatePatch(state: .active, achievedAt: .clear))

        // Through the step: achieved twice, at two instants, keeps the first.
        let later = parseTimestamp("2026-10-23T18:00:00.000Z")!
        let first = applyingContainer(.goalState(.achieved), to: .goal(active), at: noon, timeZone: "UTC",
                                      today: "2026-10-23")
        let second = applyingContainer(.goalState(.achieved), to: first, at: later, timeZone: "UTC",
                                       today: "2026-10-23")
        guard case .goal(let goal) = second else { Issue.record("not a goal"); return }
        #expect(goal.state == "achieved")
        #expect(goal.achievedAt == "2026-10-23T17:00:00.000Z")
        // A replay stamps the instant it was sent, whatever the zone.
        let late = parseTimestamp("2026-10-24T03:30:00.000Z")!
        let replayed = applyingContainer(.goalState(.achieved), to: .goal(active), at: late,
                                         timeZone: "America/New_York", today: "2026-10-23")
        guard case .goal(let replay) = replayed else { Issue.record("not a goal"); return }
        #expect(replay.achievedAt == "2026-10-24T03:30:00.000Z")
    }

    /// A project's glyph is its `emoji`, a project has no `icon`; a cleared
    /// field becomes nil; every other field and the member lists stay.
    @Test func aPatchWritesOnlyItsKindsFields() {
        let project = ContainerSnapshot.project(Project(id: "p", name: "Home", color: "var(--accent-6)", emoji: "\u{1F3E0}",
                                                        notes: "Chores."))
        #expect(containerIntentPatch(.icon("icon:House"), on: project, now: noon, timeZone: "UTC", today: "x")
            == .patch(ContainerPatch(emoji: "icon:House")))
        #expect(applyingContainer(.icon("icon:House"), to: project, at: noon, timeZone: "UTC", today: "x")
            == .project(Project(id: "p", name: "Home", color: "var(--accent-6)", emoji: "icon:House", notes: "Chores.")))
        #expect(applyingContainer(.color(nil), to: project, at: noon, timeZone: "UTC", today: "x")
            == .project(Project(id: "p", name: "Home", emoji: "\u{1F3E0}", notes: "Chores.")))
        // A patch's fields that a kind lacks are ignored.
        let everything = ContainerPatch(pausedAt: .set("t"), state: .paused, goalState: .achieved,
                                        usualTime: .set("07:00"), endsOn: .set("2026-12-01"), why: .set("w"),
                                        icon: "icon:Moon", emoji: "icon:Leaf")
        #expect(everything.applied(to: project)
            == .project(Project(id: "p", name: "Home", color: "var(--accent-6)", emoji: "icon:Leaf", notes: "Chores.")))
        let routine = Routine(id: "r", name: "Evening", icon: "icon:Sun", itemIds: [one, two])
        #expect(everything.applied(to: .routine(routine))
            == .routine(Routine(id: "r", name: "Evening", icon: "icon:Moon", usualTime: "07:00", pausedAt: "t",
                                itemIds: [one, two])))
        let season = Season(id: "s", name: "Autumn", state: "auto", endsOn: "2026-11-30", itemIds: [three],
                            routineIds: ["r"])
        #expect(everything.applied(to: .season(season))
            == .season(Season(id: "s", name: "Autumn", icon: "icon:Moon", state: "paused", endsOn: "2026-12-01",
                              itemIds: [three], routineIds: ["r"])))
        let goal = Goal(id: "g", name: "Run", milestoneIds: [one])
        #expect(everything.applied(to: .goal(goal))
            == .goal(Goal(id: "g", name: "Run", why: "w", icon: "icon:Moon", state: "achieved", milestoneIds: [one])))
        #expect(ContainerPatch().isEmpty)
        #expect(!ContainerPatch(color: .clear).isEmpty)
        #expect(!ContainerPatch(name: "x").isEmpty)
    }

    /// Notes and a why are stored trimmed, newlines inside kept; nil or blank
    /// clears them. A rename is stored trimmed.
    @Test func textIsStoredAsTheRouteStoresIt() {
        let season = ContainerSnapshot.season(Season(id: "s", name: "Autumn", notes: "Soup."))
        #expect(containerIntentPatch(.notes("\n  Leaves.\nSoup.  "), on: season, now: noon, timeZone: "UTC",
                                     today: "x") == .patch(ContainerPatch(notes: .set("Leaves.\nSoup."))))
        #expect(containerIntentPatch(.notes(" \u{3000}\n"), on: season, now: noon, timeZone: "UTC", today: "x")
            == .patch(ContainerPatch(notes: .clear)))
        #expect(containerIntentPatch(.notes(nil), on: season, now: noon, timeZone: "UTC", today: "x")
            == .patch(ContainerPatch(notes: .clear)))
        let goal = ContainerSnapshot.goal(Goal(id: "g", name: "Run", why: "Old."))
        #expect(containerIntentPatch(.why("\tNew. "), on: goal, now: noon, timeZone: "UTC", today: "x")
            == .patch(ContainerPatch(why: .set("New."))))
        #expect(containerIntentPatch(.rename("  Fall \n"), on: season, now: noon, timeZone: "UTC", today: "x")
            == .patch(ContainerPatch(name: "Fall")))
        #expect(ContainerIntent.rename("  Fall \n").renamedTo == "Fall")
        #expect(ContainerIntent.rename("   ").renamedTo == nil)
        #expect(ContainerIntent.icon("icon:Leaf").renamedTo == nil)
    }

    /// An intent the kind doesn't take is refused as the route's schema
    /// refuses it, and changes nothing.
    @Test func anIntentTheKindDoesNotTakeIsInvalid() {
        let routine = ContainerSnapshot.routine(Routine(id: "r", name: "Evening"))
        let season = ContainerSnapshot.season(Season(id: "s", name: "Autumn"))
        let goal = ContainerSnapshot.goal(Goal(id: "g", name: "Run"))
        let project = ContainerSnapshot.project(Project(id: "p", name: "Work"))
        let invalid = ContainerIntentResult.refused(code: "invalid", status: 400)
        #expect(containerIntentPatch(.state(.paused), on: routine, now: noon, timeZone: "UTC", today: "2026-10-23")
            == invalid)
        #expect(containerIntentPatch(.resume(timeZone: nil), on: season, now: noon, timeZone: "UTC",
                                     today: "2026-10-23") == invalid)
        #expect(containerIntentPatch(.goalState(.achieved), on: season, now: noon, timeZone: "UTC",
                                     today: "2026-10-23") == invalid)
        #expect(containerIntentPatch(.notes("x"), on: goal, now: noon, timeZone: "UTC", today: "2026-10-23")
            == invalid)
        #expect(containerIntentPatch(.why("x"), on: project, now: noon, timeZone: "UTC", today: "2026-10-23")
            == invalid)
        #expect(containerIntentPatch(.usualTime("07:00"), on: season, now: noon, timeZone: "UTC",
                                     today: "2026-10-23") == invalid)
        #expect(containerIntentPatch(.dates(startsOn: nil, endsOn: nil), on: goal, now: noon, timeZone: "UTC",
                                     today: "2026-10-23") == invalid)
        #expect(containerIntentPatch(.window(startsOn: nil, targetOn: nil), on: season, now: noon, timeZone: "UTC",
                                     today: "2026-10-23") == invalid)
        for container in [goal, project] {
            #expect(containerIntentPatch(.state(.auto), on: container, now: noon, timeZone: "UTC",
                                         today: "2026-10-23") == invalid)
            #expect(applyingContainer(.pause(until: nil, timeZone: nil), to: container, at: noon, timeZone: "UTC",
                                      today: "2026-10-23") == container)
        }
        #expect(applyingContainer(.state(.paused), to: routine, at: noon, timeZone: "UTC", today: "2026-10-23")
            == routine)
    }

    /// A zone that can't be read leaves the day to `today`, as the item
    /// pause's replay does; the stamp is still the instant.
    @Test func anUnreadableZoneReadsTodayAsGiven() {
        let live = ContainerSnapshot.routine(Routine(id: "r", name: "Evening"))
        let late = parseTimestamp("2026-10-24T03:30:00.000Z")!
        let until = DayString("2026-10-24")
        let taken = applyingContainer(.pause(until: until, timeZone: nil), to: live, at: late,
                                      timeZone: "Not/AZone", today: "2026-10-23")
        #expect(taken == .routine(Routine(id: "r", name: "Evening", pausedAt: "2026-10-24T03:30:00.000Z",
                                          pausedUntil: "2026-10-24")))
        #expect(containerIntentPatch(.pause(until: until, timeZone: nil), on: live, now: late,
                                     timeZone: "Not/AZone", today: "2026-10-24")
            == .refused(code: "pause_refused", status: 409))
    }

    /// The intent's own zone is what the body carries; the step reads the
    /// zone it is given, the one the server resolved with.
    @Test func theStepReadsTheZoneItIsGiven() {
        let live = ContainerSnapshot.routine(Routine(id: "r", name: "Evening"))
        let late = parseTimestamp("2026-10-24T03:30:00.000Z")!
        let intent = ContainerIntent.pause(until: DayString("2026-10-24"), timeZone: "UTC")
        let inNewYork = applyingContainer(intent, to: live, at: late, timeZone: "America/New_York", today: "x")
        #expect(inNewYork != live)
        #expect(applyingContainer(intent, to: live, at: late, timeZone: "UTC", today: "x") == live)
    }

    /// lib/app-http.ts `pauseZone`: the stored zone, else the device's, each
    /// trimmed and only when it is a zone; else UTC.
    @Test func thePauseZoneIsTheServers() {
        #expect(pauseZone(stored: "America/New_York", device: "Europe/London") == "America/New_York")
        #expect(pauseZone(stored: "  America/New_York\n", device: nil) == "America/New_York")
        #expect(pauseZone(stored: "", device: " Europe/London ") == "Europe/London")
        #expect(pauseZone(stored: "   ", device: "Europe/London") == "Europe/London")
        #expect(pauseZone(stored: "Mars/Olympus_Mons", device: "Europe/London") == "Europe/London")
        #expect(pauseZone(stored: nil, device: "Not/AZone") == "UTC")
        #expect(pauseZone(stored: nil, device: nil) == "UTC")
    }

    /// lib/gate-toggle.ts `setGateOn`: nothing when the container already is
    /// as asked; a routine's own switch, never what a season makes of it; a
    /// season through `seasonStateForSwitch`.
    @Test func theSwitchIsSetGateOns() {
        let zone = "America/New_York"
        let live = Routine(id: "r", name: "Evening")
        let paused = Routine(id: "r", name: "Evening", pausedAt: "2026-10-20T13:00:00.000Z", pausedUntil: "2026-10-30")
        let ended = Routine(id: "r", name: "Evening", pausedAt: "2026-10-01T13:00:00.000Z", pausedUntil: "2026-10-10")
        #expect(gateSwitchIntent(.routine(paused), on: true, today: oct23, timeZone: zone) == .resume(timeZone: zone))
        #expect(gateSwitchIntent(.routine(paused), on: false, today: oct23, timeZone: zone) == nil)
        #expect(gateSwitchIntent(.routine(live), on: true, today: oct23, timeZone: zone) == nil)
        #expect(gateSwitchIntent(.routine(ended), on: true, today: oct23, timeZone: zone) == nil)
        #expect(gateSwitchIntent(.routine(live), on: false, today: oct23, timeZone: zone)
            == .pause(until: nil, timeZone: zone))

        let autumn = Season(id: "s", name: "Autumn", state: "auto", startsOn: "2026-09-01", endsOn: "2026-11-30")
        var off = autumn
        off.state = "paused"
        let winter = Season(id: "w", name: "Winter", state: "paused", startsOn: "2026-11-01", endsOn: "2027-02-28")
        #expect(gateSwitchIntent(.season(autumn), on: true, today: oct23, timeZone: zone) == nil)
        #expect(gateSwitchIntent(.season(off), on: true, today: oct23, timeZone: zone) == .state(.auto))
        #expect(gateSwitchIntent(.season(winter), on: true, today: oct23, timeZone: zone) == .state(.active))
        #expect(gateSwitchIntent(.season(autumn), on: false, today: oct23, timeZone: zone) == .state(.paused))
        #expect(gateSwitchIntent(.goal(Goal(id: "g", name: "Run")), on: true, today: oct23, timeZone: zone) == nil)
        #expect(gateSwitchIntent(.project(Project(id: "p", name: "Work")), on: true, today: oct23, timeZone: zone)
            == nil)

        // Each switch, written, turns the container as asked.
        let switches: [(ContainerSnapshot, Bool)] = [
            (.routine(paused), true), (.routine(live), false),
            (.season(off), true), (.season(winter), true), (.season(autumn), false),
        ]
        for (snapshot, on) in switches {
            let intent = gateSwitchIntent(snapshot, on: on, today: oct23, timeZone: zone)!
            let after = applyingContainer(intent, to: snapshot, at: noon, timeZone: zone, today: "2026-10-23")
            switch after {
            case .routine(let r): #expect(!isPausedOn(r, on: oct23, timeZone: zone) == on, "\(r)")
            case .season(let s): #expect(isSeasonActiveOn(s, on: oct23) == on, "\(s)")
            default: Issue.record("not a gate")
            }
            #expect(gateSwitchIntent(after, on: on, today: oct23, timeZone: zone) == nil, "\(after): once more")
        }
    }

    /// A snapshot's fields over the live record's membership: what a failed
    /// field write puts back, never a list.
    @Test func aRevertKeepsTheLiveMembership() {
        let then = Routine(id: "r", name: "Evening", pausedAt: "2026-10-20T13:00:00.000Z", itemIds: [one])
        let now = Routine(id: "r", name: "Evening", itemIds: [one, two])
        #expect(ContainerSnapshot.routine(then).withMembership(of: .routine(now))
            == .routine(Routine(id: "r", name: "Evening", pausedAt: "2026-10-20T13:00:00.000Z", itemIds: [one, two])))

        let held = Season(id: "s", name: "Autumn", state: "paused", itemIds: [one], routineIds: ["r"])
        let live = Season(id: "s", name: "Autumn", state: "active", itemIds: [three], routineIds: ["r", "q"])
        #expect(ContainerSnapshot.season(held).withMembership(of: .season(live))
            == .season(Season(id: "s", name: "Autumn", state: "paused", itemIds: [three], routineIds: ["r", "q"])))

        let goalThen = Goal(id: "g", name: "Run", state: "active", memberIds: [one])
        let goalNow = Goal(id: "g", name: "Run", state: "achieved", memberIds: [two], milestoneIds: [three],
                           checkinIds: [one])
        #expect(ContainerSnapshot.goal(goalThen).withMembership(of: .goal(goalNow))
            == .goal(Goal(id: "g", name: "Run", state: "active", memberIds: [two], milestoneIds: [three],
                          checkinIds: [one])))

        let work = ContainerSnapshot.project(Project(id: "p", name: "Work"))
        #expect(work.withMembership(of: .project(Project(id: "p", name: "Play"))) == work)
        // Another container, or another kind: nothing taken.
        let other = Routine(id: "q", name: "Morning", itemIds: [three])
        #expect(ContainerSnapshot.routine(then).withMembership(of: .routine(other)) == .routine(then))
        #expect(ContainerSnapshot.routine(then).withMembership(of: .season(live)) == .routine(then))
    }

    @Test func aSnapshotNamesItself() {
        let routine = ContainerSnapshot.routine(Routine(id: "sample-morning-routine", name: "Morning"))
        #expect(routine.id == "sample-morning-routine")
        #expect(routine.name == "Morning")
        #expect(routine.ref == ContainerRef(kind: .routine, id: "sample-morning-routine"))
        #expect(ContainerSnapshot.goal(Goal(id: "g", name: "Run")).ref == ContainerRef(kind: .goal, id: "g"))
        #expect(ContainerSnapshot.project(Project(id: "p", name: "Work")).name == "Work")
        #expect(ContainerSnapshot.season(Season(id: "s", name: "Autumn")).ref.kind == .season)
    }

    /// The payload's list gates each intent: listed for the kind, and a
    /// member of its union.
    @Test func theListGatesEachIntent() {
        let writes = ContainerWrites(routine: ["pause"], season: ["state"], goal: [], project: [])
        #expect(writes.takes(.pause, on: .routine))
        #expect(writes.takes(.resume(timeZone: nil), on: .routine))
        #expect(writes.takes(.state(.auto), on: .season))
        #expect(!writes.takes(.state, on: .routine))
        #expect(!writes.takes(.pause, on: .season))
        #expect(!writes.takes(.state(.auto), on: .goal))
        #expect(!writes.takes(.goalState(.achieved), on: .goal))
        // Listed under the wrong kind is still not taken.
        let odd = ContainerWrites(routine: ["state"], season: ["pause"])
        #expect(!odd.takes(.state(.active), on: .routine))
        #expect(!odd.takes(.pause(until: nil, timeZone: nil), on: .season))
        // An older server's list (none) takes nothing.
        #expect(!ContainerWrites().takes(.resume(timeZone: nil), on: .routine))
        #expect(writes[.season] == ["state"])
        #expect(writes.takes("pause", on: .routine))
        // O8b and O9: a goal's `state` is its own Status, never a season's.
        let full = ContainerWrites(routine: ["pause", "usualTime", "notes", "rename", "icon", "color"],
                                   season: ["state", "dates", "notes", "rename", "icon", "color"],
                                   goal: ["state", "window", "why", "rename", "icon", "color"],
                                   project: ["notes", "rename", "icon", "color"])
        #expect(full.takes(.goalState(.achieved), on: .goal))
        #expect(!full.takes(.state(.active), on: .goal))
        #expect(!full.takes(.goalState(.active), on: .season))
        #expect(full.takes(.rename("House"), on: .project))
        #expect(full.takes(.notes(nil), on: .project))
        #expect(!full.takes(.why(nil), on: .project))
        #expect(!full.takes(.usualTime(nil), on: .project))
        #expect(!ContainerWrites(goal: ["state"]).takes(.window(startsOn: nil, targetOn: nil), on: .goal))
        // O10 and O11: a delete and a create each where listed, and only there.
        // (`.delete` names both the action and the intent, so a bare one is
        // ambiguous between the two `takes`; the intent asks the same list.)
        #expect(!full.takes(ContainerAction.delete, on: .routine))
        #expect(!full.takes(ContainerIntent.delete, on: .routine))
        #expect(!full.takes(.create, on: .season))
        let o11 = ContainerWrites(routine: ["delete", "create"], season: ["create"], goal: ["delete"], project: [])
        #expect(o11.takes(ContainerAction.delete, on: .routine))
        #expect(o11.takes(ContainerIntent.delete, on: .routine))
        #expect(o11.takes(.create, on: .routine))
        #expect(o11.takes(.create, on: .season))
        #expect(!o11.takes(ContainerAction.delete, on: .season))
        #expect(!o11.takes(ContainerIntent.delete, on: .season))
        #expect(o11.takes(ContainerIntent.delete, on: .goal))
        #expect(!o11.takes(.create, on: .goal))
        #expect(!o11.takes(ContainerAction.delete, on: .project))
        #expect(!o11.takes(.create, on: .project))
        // O12 and O13: a move on a routine and a hold on a season, each only
        // where listed, and only on its own kind.
        let move = MembershipIntent.moveMember(item: one, after: nil)
        let hold = MembershipIntent.holdRoutine(routineId: "r", hold: true)
        #expect(!full.takes(.moveMember, on: .routine))
        #expect(!full.takes(move, on: .routine))
        #expect(!full.takes(hold, on: .season))
        let o12 = ContainerWrites(routine: ["moveMember"], season: ["holdRoutine"], goal: ["moveMember"],
                                  project: ["holdRoutine"])
        #expect(o12.takes(.moveMember, on: .routine))
        #expect(o12.takes(move, on: .routine))
        #expect(o12.takes(.holdRoutine, on: .season))
        #expect(o12.takes(hold, on: .season))
        #expect(!o12.takes(.moveMember, on: .goal))
        #expect(!o12.takes(move, on: .goal))
        #expect(!o12.takes(.holdRoutine, on: .project))
        #expect(!o12.takes(hold, on: .project))
        #expect(!ContainerWrites(season: ["moveMember"]).takes(move, on: .season))
    }

    /// O12 and O13: each membership intent goes to its one kind's route, and a
    /// step placed after itself is no body at all.
    @Test func aMembershipBodyIsBuiltOnlyForItsKind() throws {
        let move = MembershipIntent.moveMember(item: one, after: two)
        let first = MembershipIntent.moveMember(item: three, after: nil)
        let hold = MembershipIntent.holdRoutine(routineId: "AAAAAAAA-0000-4000-8000-000000000001", hold: true)
        let out = MembershipIntent.holdRoutine(routineId: "aaaaaaaa-0000-4000-8000-000000000002", hold: false)
        #expect(move.action == .moveMember && move.kind == .routine)
        #expect(hold.action == .holdRoutine && hold.kind == .season)
        for kind in OrganizeKind.allCases {
            #expect((MembershipWriteBody(move, for: kind) != nil) == (kind == .routine), "\(kind)")
            #expect((MembershipWriteBody(hold, for: kind) != nil) == (kind == .season), "\(kind)")
            #expect(move.applies(to: kind) == (kind == .routine), "\(kind)")
            #expect(hold.applies(to: kind) == (kind == .season), "\(kind)")
        }
        #expect(try json(#require(MembershipWriteBody(move, for: .routine))) == .object([
            "action": .string("moveMember"), "itemId": .string("00000000-0000-4000-8000-000000000001"),
            "afterId": .string("00000000-0000-4000-8000-000000000002"),
        ]))
        // First: `afterId` is sent as null, never left out.
        #expect(try json(#require(MembershipWriteBody(first, for: .routine))) == .object([
            "action": .string("moveMember"), "itemId": .string("00000000-0000-4000-8000-000000000003"),
            "afterId": .null,
        ]))
        #expect(try json(#require(MembershipWriteBody(hold, for: .season))) == .object([
            "action": .string("holdRoutine"), "routineId": .string("aaaaaaaa-0000-4000-8000-000000000001"),
            "hold": .bool(true),
        ]))
        #expect(try json(#require(MembershipWriteBody(out, for: .season))) == .object([
            "action": .string("holdRoutine"), "routineId": .string("aaaaaaaa-0000-4000-8000-000000000002"),
            "hold": .bool(false),
        ]))
        // A step after itself names no place; a sample routine is no uuid.
        let itself = MembershipIntent.moveMember(item: one, after: one)
        #expect(!itself.isWellFormed)
        #expect(MembershipWriteBody(itself, for: .routine) == nil)
        #expect(move.isWellFormed && first.isWellFormed && hold.isWellFormed)
        let sample = MembershipIntent.holdRoutine(routineId: "sample-wind-down", hold: true)
        #expect(sample.isWellFormed)
        #expect(MembershipWriteBody(sample, for: .season) == nil)
        // The route is the container's, as for a field write.
        #expect(ContainerRoutes.write(ContainerRef(kind: .routine, id: "R1")) == "/api/app/containers/routine/r1")
    }

    /// The route's answers, by hand, at their edges: a step after itself is
    /// the body's 400 before anything is read; a gone step is named before a
    /// gone anchor; a routine not live is refused whichever way it was asked.
    @Test func theMembershipAnswersAreTheRoutes() {
        #expect(memberMoveResult([one, two], item: one, after: one) == .refused(code: "invalid", status: 400))
        #expect(memberMoveResult([one, two], item: three, after: three) == .refused(code: "invalid", status: 400))
        #expect(memberMoveResult([one, two], item: three, after: UUID()) == .refused(code: "member_gone", status: 409))
        #expect(memberMoveResult([one, two], item: two, after: three) == .refused(code: "anchor_gone", status: 409))
        #expect(memberMoveResult([one, two], item: two, after: nil) == .members([two, one]))
        #expect(memberMoveResult([one, two, three], item: one, after: three) == .members([two, three, one]))
        #expect(memberMoveResult([], item: one, after: nil) == .refused(code: "member_gone", status: 409))
        #expect(routineHoldResult(["a"], routineId: "b", hold: true, routineLive: true) == .members(["a", "b"]))
        #expect(routineHoldResult(["a", "b"], routineId: "a", hold: false, routineLive: true) == .members(["b"]))
        #expect(routineHoldResult(["a"], routineId: "a", hold: true, routineLive: true) == .members(["a"]))
        #expect(routineHoldResult(["a"], routineId: "b", hold: false, routineLive: true) == .members(["a"]))
        for hold in [true, false] {
            #expect(routineHoldResult(["a"], routineId: "a", hold: hold, routineLive: false)
                == .refused(code: "container_gone", status: 409))
        }
        // The sample's ids step the same way.
        #expect(routineHoldResult([], routineId: "sample-wind-down", hold: true, routineLive: true)
            == .members(["sample-wind-down"]))
    }

    /// The phone's revert of a step (design §6.4): after the anchor a landed
    /// move named while it is still there, first for none, else back at its
    /// old place; and the generic membership toggle over a season's routines.
    @Test func aStepIsPutBackAfterItsAnchorOrInItsPlace() {
        let four = UUID(uuidString: "00000000-0000-4000-8000-000000000004")!
        #expect(placingMember([one, two, three], item: one, after: three, orAt: 0) == [two, three, one])
        #expect(placingMember([one, two, three], item: three, after: nil, orAt: 2) == [three, one, two])
        // The anchor is gone: its old place.
        #expect(placingMember([one, two, three], item: three, after: four, orAt: 0) == [three, one, two])
        #expect(placingMember([one, two, three], item: three, after: four, orAt: nil) == [one, two, three])
        // The anchor is itself: its old place.
        #expect(placingMember([one, two, three], item: two, after: two, orAt: 0) == [two, one, three])
        // Not in the list: put back, after the anchor or at its place.
        #expect(placingMember([one, two], item: three, after: one, orAt: nil) == [one, three, two])
        #expect(placingMember([one, two], item: three, after: four, orAt: 1) == [one, three, two])
        #expect(placingMember([one, two], item: three, after: four, orAt: nil) == [one, two, three])
        // A season's routines, by the same toggle as a member's.
        #expect(settingMembership(["a", "b"], item: "c", member: true) == ["a", "b", "c"])
        #expect(settingMembership(["a", "b"], item: "a", member: false) == ["b"])
        #expect(settingMembership(["a", "b"], item: "b", member: true, at: 0) == ["b", "a"])
    }

    /// The membership refusals all say one thing, whatever was sent.
    @Test func aRefusedMembershipWriteSaysItChangedElsewhere() {
        let writes: [MembershipIntent] = [
            .moveMember(item: one, after: two), .moveMember(item: one, after: nil),
            .holdRoutine(routineId: "r", hold: true), .holdRoutine(routineId: "r", hold: false),
        ]
        for write in writes {
            for code in ["member_gone", "anchor_gone", "container_gone"] {
                #expect(OrganizeCopy.refusal(code: code, for: write) == OrganizeCopy.changedElsewhere, "\(code)")
            }
            #expect(OrganizeCopy.refusal(code: "not_found", for: write) == nil)
            #expect(OrganizeCopy.refusal(code: nil, for: write) == nil)
            #expect(OrganizeCopy.refusal(code: "name_taken", for: write) == nil)
        }
        #expect(OrganizeCopy.changedElsewhere == "It changed on another device. Showing the latest.")
    }

    @Test func aRefusedPauseIsWorded() {
        let pause = ContainerIntent.pause(until: DayString("2026-10-23"), timeZone: nil)
        #expect(OrganizeCopy.refusal(code: "pause_refused", for: pause) == OrganizeCopy.pauseRefused)
        #expect(OrganizeCopy.pauseRefused == "That day is no longer after today, so nothing was paused.")
        #expect(OrganizeCopy.refusal(code: nil, for: pause) == nil)
        #expect(OrganizeCopy.refusal(code: "not_found", for: .state(.active)) == nil)
        #expect(OrganizeCopy.refusal(code: "invalid", for: pause) == nil)
        #expect(!OrganizeCopy.pauseRefused.contains("\u{2014}"))
        #expect(!OrganizeCopy.pauseRefused.lowercased().contains("missed"))
    }

    /// A refused rename names the project by the name the phone sent, trimmed
    /// as the route read it; any other write has no name to give.
    @Test func aRefusedRenameNamesWhatWasSent() {
        #expect(OrganizeCopy.refusal(code: "name_taken", for: .rename("  work ")) ==
            "You already have a project called \u{201C}work\u{201D}.")
        #expect(OrganizeCopy.refusal(code: "name_in_trash", for: .rename("Errands")) ==
            "A deleted project called \u{201C}Errands\u{201D} still has that name. "
            + "Restore it from Trash, or pick a different one.")
        for intent in [ContainerIntent.notes("x"), .icon("icon:Moon"), .color(nil), .goalState(.active)] {
            #expect(OrganizeCopy.refusal(code: "name_taken", for: intent) == nil, "\(intent)")
            #expect(OrganizeCopy.refusal(code: "name_in_trash", for: intent) == nil, "\(intent)")
        }
        #expect(OrganizeCopy.refusal(code: "not_found", for: .rename("House")) == nil)
        #expect(OrganizeCopy.refusal(code: "pause_refused", for: .rename("House")) == OrganizeCopy.pauseRefused)
    }

    @Test func anIconTokenIsThePrefixAndTheName() {
        #expect(ContainerLook.iconToken("Moon") == "icon:Moon")
        for name in ContainerLook.featured {
            let token = ContainerLook.iconToken(name)
            #expect(ContainerIntent.icon(token).isWellFormed, "\(name)")
            #expect(resolveCategoryIconName(token, "anything") == name, "\(name)")
        }
        for token in ContainerLook.ramp {
            #expect(ContainerIntent.color(token).isWellFormed, "\(token)")
        }
    }
}

// MARK: - A new container (O11) and the step past a delete (O10)

@Suite struct ContainerCreateTests {
    private let id = "cccccccc-0000-4000-8000-000000000001"

    /// The schema's `Id`: a uuid in any case, taken lowercased, so the phone's
    /// new container and the row share one id. A sample id never builds.
    @Test func theIdIsAUuidTakenLowercased() throws {
        let upper = "4B1D3C2A-0000-4000-8000-00000000ABCD"
        let body = try #require(ContainerCreateBody(kind: .season, id: upper, name: "Autumn"))
        #expect(body.id == "4b1d3c2a-0000-4000-8000-00000000abcd")
        #expect(body.ref == ContainerRef(kind: .season, id: "4b1d3c2a-0000-4000-8000-00000000abcd"))
        #expect(try json(body) == .object([
            "id": .string("4b1d3c2a-0000-4000-8000-00000000abcd"), "name": .string("Autumn"),
        ]))
        #expect(containerCreateRecord(body).id == body.id)
        let minted = UUID().uuidString.lowercased()
        #expect(ContainerCreateBody(kind: .routine, id: minted, name: "Desk")?.id == minted)
        for bad in [
            "sample-morning-routine", "", "cccccccc-0000-4000-8000-00000000000", "cccccccc-0000-4000-8000-0000000000001",
            "{cccccccc-0000-4000-8000-000000000001}", "cccccccc00000-4000-8000-000000000001",
            "gccccccc-0000-4000-8000-000000000001", "cccccccc-0000-4000-8000-00000000000\u{FF11}",
            " cccccccc-0000-4000-8000-000000000001", "cccccccc-0000-4000-8000-000000000001\n",
        ] {
            #expect(ContainerCreateBody(kind: .routine, id: bad, name: "Desk") == nil, "\(bad)")
        }
    }

    /// The schema's `Name`: trimmed, 1 to the outer title's limit; sent as
    /// typed, stored trimmed.
    @Test func theNameIsSentAsTypedAndStoredTrimmed() throws {
        let padded = try #require(ContainerCreateBody(kind: .routine, id: id, name: "  Lunch walk \n"))
        #expect(padded.name == "  Lunch walk \n")
        #expect(padded.storedName == "Lunch walk")
        #expect(containerCreateRecord(padded).name == "Lunch walk")
        let limit = String(repeating: "a", count: EditLimits.outerTitle)
        #expect(ContainerCreateBody(kind: .project, id: id, name: limit) != nil)
        #expect(ContainerCreateBody(kind: .project, id: id, name: " \(limit)\t") != nil)
        #expect(ContainerCreateBody(kind: .project, id: id, name: limit + "a") == nil)
        for blank in ["", "   ", "\n\t", "\u{3000}"] {
            #expect(ContainerCreateBody(kind: .goal, id: id, name: blank) == nil, "\(blank)")
        }
    }

    /// The glyph is a token or nothing; a first day only a goal takes, and only
    /// a day the route's `DateStrSchema` reads. Neither is ever sent as null.
    @Test func theGlyphAndTheFirstDayAreTheSchemas() throws {
        #expect(ContainerCreateBody(kind: .routine, id: id, name: "Desk", icon: "icon:Moon") != nil)
        for bad in ["Moon", "icon:", "ICON:Moon", "icon:Calendar-Range", ""] {
            #expect(ContainerCreateBody(kind: .routine, id: id, name: "Desk", icon: bad) == nil, "\(bad)")
        }
        let oct23 = try #require(DayString("2026-10-23"))
        let goal = try #require(ContainerCreateBody(kind: .goal, id: id, name: "Run", startsOn: oct23))
        #expect(try json(goal) == .object([
            "id": .string(id), "name": .string("Run"), "startsOn": .string("2026-10-23"),
        ]))
        for kind in [OrganizeKind.routine, .season, .project] {
            #expect(ContainerCreateBody(kind: kind, id: id, name: "Run", startsOn: oct23) == nil, "\(kind)")
        }
        #expect(ContainerCreateBody(kind: .goal, id: id, name: "Run", startsOn: DayString("0099-12-31")) == nil)
        #expect(ContainerCreateBody(kind: .goal, id: id, name: "Run", startsOn: DayString("0100-01-01")) != nil)
        // No glyph and no first day: neither key at all.
        let bare = try #require(ContainerCreateBody(kind: .goal, id: id, name: "Read more"))
        #expect(try json(bare) == .object(["id": .string(id), "name": .string("Read more")]))
    }

    /// containerCreateRecord: the web's defaults, each kind empty.
    @Test func theRecordIsTheWebsDefaults() throws {
        let oct23 = try #require(DayString("2026-10-23"))
        func record(_ kind: OrganizeKind, icon: String? = nil, startsOn: DayString? = nil) throws -> ContainerSnapshot {
            let body = try #require(ContainerCreateBody(kind: kind, id: id, name: " Evening ", icon: icon, startsOn: startsOn))
            return containerCreateRecord(body)
        }
        #expect(try record(.routine, icon: "icon:Repeat") == .routine(Routine(id: id, name: "Evening", icon: "icon:Repeat")))
        #expect(try record(.season) == .season(Season(id: id, name: "Evening", state: "auto")))
        #expect(try record(.goal, icon: "icon:Target", startsOn: oct23)
            == .goal(Goal(id: id, name: "Evening", icon: "icon:Target", state: "active", startsOn: "2026-10-23")))
        #expect(try record(.project, icon: "icon:Briefcase") == .project(Project(id: id, name: "Evening", emoji: "icon:Briefcase")))
        #expect(try record(.project) == .project(Project(id: id, name: "Evening", emoji: "")))
        // A new routine is live, a new season is on today, a new goal active.
        guard case .routine(let routine) = try record(.routine) else { Issue.record("not a routine"); return }
        #expect(!isPausedOn(routine, on: oct23, timeZone: "UTC"))
        guard case .season(let season) = try record(.season) else { Issue.record("not a season"); return }
        #expect(isSeasonActiveOn(season, on: oct23))
        #expect(ContainerRoutes.create(.goal) == "/api/app/containers/goal")
        #expect(ContainerRoutes.create(.project) == "/api/app/containers/project")
    }

    /// A refused create names the project by the name it sent, trimmed as the
    /// route read it, never the answer's body.
    @Test func aRefusedCreateNamesWhatWasSent() throws {
        let work = try #require(ContainerCreateBody(kind: .project, id: id, name: " work\n"))
        #expect(OrganizeCopy.refusal(code: "name_taken", for: work) == "You already have a project called \u{201C}work\u{201D}.")
        #expect(OrganizeCopy.refusal(code: "name_in_trash", for: work) ==
            "A deleted project called \u{201C}work\u{201D} still has that name. Restore it from Trash, or pick a different one.")
        #expect(OrganizeCopy.refusal(code: "not_found", for: work) == nil)
        #expect(OrganizeCopy.refusal(code: nil, for: work) == nil)
        #expect(OrganizeCopy.refusal(code: "invalid", for: work) == nil)
    }

    /// `containerAfter`: a delete takes the container away, a container
    /// already gone stays gone, and any other write is `applyingContainer`.
    @Test func theStepPastADeleteIsNoContainer() {
        let routine = ContainerSnapshot.routine(Routine(id: "r", name: "Evening", itemIds: [one]))
        #expect(containerAfter(.delete, on: routine, at: noon, timeZone: "UTC", today: "2026-10-23") == nil)
        #expect(containerAfter(.delete, on: nil, at: noon, timeZone: "UTC", today: "2026-10-23") == nil)
        #expect(containerAfter(.rename("Night"), on: nil, at: noon, timeZone: "UTC", today: "2026-10-23") == nil)
        #expect(containerAfter(.rename("Night"), on: routine, at: noon, timeZone: "UTC", today: "2026-10-23")
            == .routine(Routine(id: "r", name: "Night", itemIds: [one])))
        let pause = ContainerIntent.pause(until: nil, timeZone: "UTC")
        #expect(containerAfter(pause, on: routine, at: noon, timeZone: "UTC", today: "2026-10-23")
            == applyingContainer(pause, to: routine, at: noon, timeZone: "UTC", today: "2026-10-23"))
        // A refused write leaves it as it was, still there.
        #expect(containerAfter(.state(.active), on: routine, at: noon, timeZone: "UTC", today: "2026-10-23") == routine)
        // A delete is `.removed` on every kind, and no refusal has words for it.
        for kind in OrganizeKind.allCases {
            #expect(containerIntentPatch(.delete, on: sample(kind)!, now: noon, timeZone: "UTC", today: "x") == .removed)
        }
        #expect(OrganizeCopy.refusal(code: "not_found", for: .delete) == nil)
        #expect(OrganizeCopy.refusal(code: "name_taken", for: .delete) == nil)
    }
}

// MARK: - A project rename's clash and re-file (O9)

private func item(_ id: UUID, project: String?, projectId: String?) -> Item {
    var item = Item(id: id, type: "task", title: "t\(id.uuidString.suffix(1))")
    item.project = project
    item.projectId = projectId
    return item
}

@Suite struct ProjectRenameTests {
    private let home = Project(id: "p-home", name: "Home")
    private let work = Project(id: "p-work", name: "Work")
    private let cafe = Project(id: "p-cafe", name: "\u{C9}T\u{C9}")

    /// lib/app-containers.ts `renameProject` step 1: a live project other
    /// than this one whose name folds to the typed name, trimmed.
    @Test func aClashFoldsCaseAndSkipsItself() {
        let projects = [home, work, cafe]
        #expect(projectNameClash("work", among: projects, except: home.id) == work)
        #expect(projectNameClash("  WORK\n", among: projects, except: home.id) == work)
        #expect(projectNameClash("Work", among: projects, except: work.id) == nil)
        #expect(projectNameClash("home", among: projects, except: home.id) == nil)
        #expect(projectNameClash("House", among: projects, except: home.id) == nil)
        #expect(projectNameClash("\u{E9}t\u{E9}", among: projects, except: home.id) == cafe)
        #expect(projectNameClash("   ", among: projects, except: home.id) == nil)
        #expect(projectNameClash("", among: projects) == nil)
        // The create sheet asks with no exception: its own name is a clash.
        #expect(projectNameClash("home", among: projects) == home)
        // A name that only trims to another's is not one: the stored name is
        // compared as stored, the typed one trimmed (the route's rule).
        let padded = Project(id: "p-pad", name: " Garden ")
        #expect(projectNameClash("garden", among: [padded]) == nil)
        #expect(projectNameClash(" garden ", among: [padded]) == nil)
    }

    /// renameContainerMembers: by project id, never by name.
    @Test func aRenameRefilesItsMembersById() {
        let a = UUID(uuidString: "00000000-0000-4000-8000-0000000000a1")!
        let b = UUID(uuidString: "00000000-0000-4000-8000-0000000000b2")!
        let c = UUID(uuidString: "00000000-0000-4000-8000-0000000000c3")!
        let d = UUID(uuidString: "00000000-0000-4000-8000-0000000000d4")!
        let items = [
            item(a, project: "Home", projectId: "p-home"),
            item(b, project: "Home", projectId: nil),        // filed by name only: stays
            item(c, project: "Work", projectId: "p-work"),
            item(d, project: "home", projectId: "p-home"),
        ]
        let ref = ContainerRef(kind: .project, id: "p-home")
        let rename = ContainerIntent.rename("  House ")
        #expect(refiledItems(rename, on: ref, items: items) == [a, d])
        #expect(refiledItems(.color(nil), on: ref, items: items) == [])
        #expect(refiledItems(.rename("   "), on: ref, items: items) == [])
        #expect(refiledItems(rename, on: ContainerRef(kind: .routine, id: "p-home"), items: items) == [])

        let moved = items.map { refiling($0, by: rename, on: ref) }
        #expect(moved.map(\.project) == ["House", "Home", "Work", "House"])
        #expect(moved.map(\.projectId) == items.map(\.projectId))
        #expect(refiling(items[0], by: .icon("icon:House"), on: ref) == items[0])
        #expect(refiling(items[0], by: .rename(""), on: ref) == items[0])
        #expect(refiling(items[0], by: rename, on: ContainerRef(kind: .season, id: "p-home")) == items[0])
        #expect(refiling(items[2], by: rename, on: ref) == items[2])
    }
}
