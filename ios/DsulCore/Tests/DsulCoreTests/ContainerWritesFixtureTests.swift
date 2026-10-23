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

private struct ContainerWritesFixture: Decodable, Sendable {
    let cases: [WriteCase]
    let invalid: [InvalidCase]
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
/// one as null, one left alone absent.
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
    return out
}

/// The intent a body means, read as strictly as the route's schema reads it:
/// nil for any body the route would refuse whatever the kind (an unknown key
/// or action, a missing or mistyped value, a day that is no day, a resume
/// with a day). Whether the kind takes it is `ContainerWriteBody`'s question.
private func phoneIntent(_ body: JSONValue) -> ContainerIntent? {
    guard case .object(let o) = body, case .string(let action)? = o["action"] else { return nil }
    switch action {
    case "pause":
        guard Set(o.keys).isSubset(of: ["action", "paused", "pausedUntil", "timeZone"]) else { return nil }
        guard case .bool(let paused)? = o["paused"] else { return nil }
        var zone: String? = nil
        if let raw = o["timeZone"] {
            guard case .string(let z) = raw, z.utf16.count <= 100 else { return nil }
            zone = z
        }
        var until: DayString? = nil
        if let raw = o["pausedUntil"] {
            // The schema's DateStrSchema: yyyy-MM-dd and a real day, never null.
            guard case .string(let s) = raw, s.utf8.count == 10, let day = DayString(s) else { return nil }
            until = day
        }
        if paused { return .pause(until: until, timeZone: zone) }
        return until == nil ? .resume(timeZone: zone) : nil
    case "state":
        guard Set(o.keys) == ["action", "state"], case .string(let raw)? = o["state"],
              let state = SeasonState(rawValue: raw) else { return nil }
        return .state(state)
    default:
        return nil
    }
}

@Suite struct ContainerWritesFixtureTests {
    @Test func everyKindAndIntentHasCases() throws {
        let f = try load()
        #expect(f.cases.contains { $0.kind == .routine })
        #expect(f.cases.contains { $0.kind == .season })
        #expect(f.cases.contains { $0.refused != nil })
        #expect(f.cases.contains { $0.patch == [:] })
        #expect(!f.invalid.isEmpty)
        // Every intent the phone has is in the fixture.
        let intents = f.cases.compactMap { phoneIntent($0.body) }
        #expect(intents.contains { if case .pause = $0 { return true }; return false })
        #expect(intents.contains { if case .resume = $0 { return true }; return false })
        for state in SeasonState.allCases {
            #expect(intents.contains(.state(state)), "state \(state.rawValue)")
        }
    }

    /// The phone's body for each case is the JSON the route took, key for
    /// key: a pause's day and zone only when sent, never null.
    @Test func eachBodyIsTheWireJSON() throws {
        for c in try load().cases {
            let intent = try #require(phoneIntent(c.body), "\(c.name): a body the phone can't mean")
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
            let intent = try #require(phoneIntent(c.body), "\(c.name)")
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
            }
        }
    }

    /// The phone's step ends where the route's row ended: `after`, a cleared
    /// field gone, a refusal changing nothing, membership untouched.
    @Test func eachStepEndsWhereTheRowEnded() throws {
        for c in try load().cases {
            let intent = try #require(phoneIntent(c.body), "\(c.name)")
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
    /// take; and no body the phone can build for that kind is it.
    @Test func theRefusedBodiesAreNeverBuilt() throws {
        let f = try load()
        // Every day and zone the fixture names, so the bodies built below are
        // the nearest the phone could come to each refused one.
        var days: [DayString?] = [nil]
        var zones: [String?] = [nil]
        for body in f.cases.map(\.body) + f.invalid.map(\.body) {
            guard case .object(let o) = body else { continue }
            if case .string(let s)? = o["pausedUntil"], let d = DayString(s), !days.contains(d) { days.append(d) }
            if case .string(let z)? = o["timeZone"], !zones.contains(z) { zones.append(z) }
        }
        var buildable: [ContainerIntent] = SeasonState.allCases.map { .state($0) }
        for zone in zones {
            buildable.append(.resume(timeZone: zone))
            for day in days { buildable.append(.pause(until: day, timeZone: zone)) }
        }
        for c in f.invalid {
            #expect(c.expected.status == 400 && c.expected.error == "invalid", "\(c.name)")
            let kind = try #require(OrganizeKind(rawValue: c.kind), "\(c.name): kind \(c.kind)")
            if let intent = phoneIntent(c.body) {
                #expect(ContainerWriteBody(intent, for: kind) == nil, "\(c.name): the phone would build it")
            }
            for intent in buildable {
                guard let body = ContainerWriteBody(intent, for: kind) else { continue }
                #expect(try json(body) != c.body, "\(c.name): \(intent) builds it")
            }
        }
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
        #expect(ContainerAction.state.kinds == [.season])
        #expect(ContainerIntent.pause(until: nil, timeZone: nil).action == .pause)
        #expect(ContainerIntent.resume(timeZone: "UTC").action == .pause)
        #expect(ContainerIntent.state(.active).action == .state)
        #expect(ContainerIntent.resume(timeZone: "UTC").applies(to: .routine))
        #expect(!ContainerIntent.resume(timeZone: "UTC").applies(to: .season))
        #expect(ContainerIntent.state(.auto).applies(to: .season))
        for kind in [OrganizeKind.goal, .project] {
            #expect(!ContainerIntent.state(.auto).applies(to: kind))
            #expect(!ContainerIntent.pause(until: nil, timeZone: nil).applies(to: kind))
        }
        #expect(ContainerIntent.pause(until: oct23, timeZone: "UTC").timeZone == "UTC")
        #expect(ContainerIntent.state(.paused).timeZone == nil)
    }

    /// A body goes only to a route whose union holds its action, and carries
    /// a zone only when there is one the schema takes.
    @Test func aBodyIsBuiltOnlyForItsKind() throws {
        #expect(ContainerWriteBody(.state(.active), for: .routine) == nil)
        #expect(ContainerWriteBody(.pause(until: nil, timeZone: nil), for: .season) == nil)
        #expect(ContainerWriteBody(.resume(timeZone: nil), for: .goal) == nil)
        #expect(ContainerWriteBody(.state(.paused), for: .project) == nil)

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
    }

    @Test func theRouteIsTheKindAndTheLowercasedId() {
        let ref = ContainerRef(kind: .season, id: "4B1D3C2A-0000-4000-8000-00000000ABCD")
        #expect(ContainerRoutes.write(ref) == "/api/app/containers/season/4b1d3c2a-0000-4000-8000-00000000abcd")
        #expect(ContainerRoutes.write(ContainerRef(kind: .routine, id: "r1")) == "/api/app/containers/routine/r1")
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
        // Listed under the wrong kind is still not taken.
        let odd = ContainerWrites(routine: ["state"], season: ["pause"])
        #expect(!odd.takes(.state(.active), on: .routine))
        #expect(!odd.takes(.pause(until: nil, timeZone: nil), on: .season))
        // An older server's list (none) takes nothing.
        #expect(!ContainerWrites().takes(.resume(timeZone: nil), on: .routine))
        #expect(writes[.season] == ["state"])
        #expect(writes.takes("pause", on: .routine))
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
}
