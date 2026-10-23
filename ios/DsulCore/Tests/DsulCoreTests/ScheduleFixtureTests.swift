import Foundation
import Testing
import DsulCore

// The web's own answers for lib/container-schedule.ts, checked against
// ContainerSchedule.swift: tests/fixtures/organize/schedule.json. O1 pins
// `containerMemberIds`; O2 the schedule (`deriveContainerSchedule`) and the
// numbers over it (`dayRollup`, `weekTotals`, `todayCount`, `todayInOrder`).

private struct ScheduleWorld: Decodable, Sendable {
    let items: [Item]
    let routines: [Routine]
}

/// lib/container-schedule.ts `ScheduleContainer`, as the JSON writes it:
/// `{kind, <kind>: {...}}`.
private struct ContainerJSON: Decodable, Sendable {
    let container: ScheduleContainer

    enum CodingKeys: String, CodingKey {
        case kind, routine, season, goal, project
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "routine": container = .routine(try c.decode(Routine.self, forKey: .routine))
        case "season": container = .season(try c.decode(Season.self, forKey: .season))
        case "goal": container = .goal(try c.decode(Goal.self, forKey: .goal))
        case "project": container = .project(try c.decode(Project.self, forKey: .project))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown kind \(other)")
        }
    }
}

private struct MembersCase: Decodable, Sendable {
    let name: String
    let container: ContainerJSON
    let expected: [String]
    /// Project cases only: `expected` less subtasks, the count Organize's
    /// project row says ("N items").
    let listed: [String]?
}

/// The calendar every schedule case is derived against.
private struct ScheduleCalendar: Decodable, Sendable {
    let items: [Item]
    let routines: [Routine]
    let seasons: [Season]
    let projects: [Project]
}

private struct OccurrenceJSON: Decodable, Sendable {
    let itemId: String
    let state: String
    let once: Bool
}

private struct DayJSON: Decodable, Sendable {
    let date: String
    let occurrences: [OccurrenceJSON]
    let block: String?
}

private struct RollupJSON: Decodable, Sendable {
    let date: String
    let done: Int
    let due: Int
    let open: Int
    let skipped: Int
}

private struct TotalsJSON: Decodable, Sendable {
    let done: Int
    let total: Int
}

private struct RunRowJSON: Decodable, Sendable {
    let itemId: String
    let state: String
}

private struct RunJSON: Decodable, Sendable {
    let rows: [RunRowJSON]
    let done: Int
    let skipped: Int
    let nextId: String?
    let finished: Bool
}

private struct DeriveExpected: Decodable, Sendable {
    let days: [DayJSON]
    let unscheduled: [String]
    let rollup: [RollupJSON]
    let weekTotals: TotalsJSON
    let todayCount: String?
    let todayRun: RunJSON
}

private struct DeriveCase: Decodable, Sendable {
    let name: String
    let container: ContainerJSON
    let memberIds: [String]
    let from: String
    let days: Int
    let today: String
    let timeZone: String
    let away: [AwayPeriod]
    let blockProjectId: String?
    let expected: DeriveExpected
}

private struct ScheduleFixture: Decodable, Sendable {
    let world: ScheduleWorld
    let containerMemberIds: [MembersCase]
    let calendar: ScheduleCalendar
    let deriveContainerSchedule: [DeriveCase]
}

/// One case's schedule, derived as the fixture's writer derived it.
private func derive(_ c: DeriveCase, _ calendar: ScheduleCalendar) throws -> (schedule: ContainerSchedule, members: [UUID], today: DayString) {
    let members = try #require(organizeUUIDs(c.memberIds), "\(c.name): a member id is not a uuid")
    let from = try #require(DayString(c.from), "\(c.name): bad from")
    let today = try #require(DayString(c.today), "\(c.name): bad today")
    var block: Project? = nil
    if let id = c.blockProjectId {
        let found: Project = try #require(calendar.projects.first { $0.id == id }, "\(c.name): no project \(id)")
        block = found
    }
    let source = ScheduleSource(
        items: calendar.items, routines: calendar.routines, seasons: calendar.seasons, away: c.away,
        timeZone: c.timeZone
    )
    let schedule = deriveContainerSchedule(
        memberIds: members, source: source, from: from, days: c.days, today: today, block: block
    )
    return (schedule, members, today)
}

private func load() throws -> ScheduleFixture {
    return try loadOrganizeFixture(ScheduleFixture.self, "schedule.json")
}

@Suite struct ScheduleFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try load()
        #expect(!f.world.items.isEmpty)
        #expect(!f.world.routines.isEmpty)
        #expect(!f.containerMemberIds.isEmpty)
        // Every kind is covered.
        let kinds = Set(f.containerMemberIds.map(\.container.container.kind))
        #expect(kinds == Set(OrganizeKind.allCases))
        #expect(!f.calendar.items.isEmpty)
        #expect(!f.deriveContainerSchedule.isEmpty)
        #expect(Set(f.deriveContainerSchedule.map(\.container.container.kind)) == Set(OrganizeKind.allCases))
    }

    @Test func containerMemberIdsMatchesTheWeb() throws {
        let f = try load()
        for c in f.containerMemberIds {
            let expected = try #require(organizeUUIDs(c.expected), "\(c.name): an expected id is not a uuid")
            let got = containerMemberIds(c.container.container, items: f.world.items, routines: f.world.routines)
            #expect(got == expected, "\(c.name): \(got.map { $0.uuidString.lowercased() })")
        }
    }

    /// The project count leaves subtasks out (design §2 Q11): the rule is
    /// the console list's, restated here as the fixture's writer restates it,
    /// so the `listed` column is the members whose item has no parent.
    @Test func aProjectsListLeavesSubtasksOut() throws {
        let f = try load()
        let byId = Dictionary(f.world.items.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        var sawSubtask = false
        for c in f.containerMemberIds where c.container.container.kind == .project {
            let listed = try #require(c.listed.flatMap(organizeUUIDs), "\(c.name): no listed ids")
            let members = containerMemberIds(c.container.container, items: f.world.items, routines: f.world.routines)
            // `!parentItemId` on the web: an empty parent id is no parent.
            let topLevel = members.filter { (byId[$0]?.parentItemId ?? "").isEmpty }
            #expect(topLevel == listed, "\(c.name)")
            if topLevel.count < members.count { sawSubtask = true }
        }
        #expect(sawSubtask)
    }

    /// The member ids each case carries are `containerMemberIds`' answer.
    @Test func theCasesMembersAreTheContainers() throws {
        let f = try load()
        for c in f.deriveContainerSchedule {
            let expected = try #require(organizeUUIDs(c.memberIds), "\(c.name)")
            let got = containerMemberIds(c.container.container, items: f.calendar.items, routines: f.calendar.routines)
            #expect(got == expected, "\(c.name)")
        }
    }

    @Test func deriveContainerScheduleMatchesTheWeb() throws {
        let f = try load()
        for c in f.deriveContainerSchedule {
            let (schedule, _, _) = try derive(c, f.calendar)
            #expect(schedule.days.count == c.expected.days.count, "\(c.name): day count")
            for (got, want) in zip(schedule.days, c.expected.days) {
                #expect(got.date.description == want.date, "\(c.name): day")
                let gotRows = got.occurrences.map { "\($0.itemId.uuidString.lowercased()) \($0.state.rawValue) \($0.once)" }
                let wantRows = want.occurrences.map { "\($0.itemId) \($0.state) \($0.once)" }
                #expect(gotRows == wantRows, "\(c.name) \(want.date): occurrences")
                #expect(got.occurrences.allSatisfy { $0.date == got.date }, "\(c.name) \(want.date): dates")
                #expect(got.block?.id == want.block, "\(c.name) \(want.date): block")
            }
            let unscheduled = schedule.unscheduled.map { $0.id.uuidString.lowercased() }
            #expect(unscheduled == c.expected.unscheduled, "\(c.name): unscheduled")
        }
    }

    @Test func theNumbersOverTheScheduleMatchTheWeb() throws {
        let f = try load()
        for c in f.deriveContainerSchedule {
            let (schedule, members, today) = try derive(c, f.calendar)
            let rollup = dayRollup(schedule).map {
                RollupKey(date: $0.date.description, done: $0.done, due: $0.due, open: $0.open, skipped: $0.skipped)
            }
            let want = c.expected.rollup.map {
                RollupKey(date: $0.date, done: $0.done, due: $0.due, open: $0.open, skipped: $0.skipped)
            }
            #expect(rollup == want, "\(c.name): rollup")

            let byItem = occurrencesByItem(schedule)
            let totals = weekTotals(byItem, ids: members)
            #expect(totals == WeekTotals(done: c.expected.weekTotals.done, total: c.expected.weekTotals.total), "\(c.name): totals")
            #expect(todayCount(byItem, ids: members, today: today) == c.expected.todayCount, "\(c.name): todayCount")
            // Seeding rows with the members changes no number.
            let seeded = occurrencesByItem(schedule, memberIds: members)
            #expect(weekTotals(seeded, ids: members) == totals, "\(c.name): seeded totals")
            #expect(Set(members).isSubset(of: Set(seeded.keys)), "\(c.name): seeded rows")

            let run = todayInOrder(schedule, order: members, today: today)
            let rows = run.rows.map { "\($0.itemId.uuidString.lowercased()) \($0.state.rawValue)" }
            #expect(rows == c.expected.todayRun.rows.map { "\($0.itemId) \($0.state)" }, "\(c.name): run rows")
            #expect(run.done == c.expected.todayRun.done, "\(c.name): run done")
            #expect(run.skipped == c.expected.todayRun.skipped, "\(c.name): run skipped")
            #expect(run.nextId?.uuidString.lowercased() == c.expected.todayRun.nextId, "\(c.name): next")
            #expect(run.finished == c.expected.todayRun.finished, "\(c.name): finished")
        }
    }

    /// The guilt-free law, as the strip reads it: no past day is ever `due`
    /// (an unrecorded past day is `open`, never owed), in every case.
    @Test func aPastDayIsNeverDue() throws {
        let f = try load()
        for c in f.deriveContainerSchedule {
            let (schedule, _, today) = try derive(c, f.calendar)
            for r in dayRollup(schedule) where r.date < today {
                #expect(r.due == 0, "\(c.name) \(r.date): due \(r.due)")
            }
            for r in dayRollup(schedule) where r.date >= today {
                #expect(r.open == 0, "\(c.name) \(r.date): open \(r.open)")
            }
        }
    }

    /// A member added today changes no recorded past cell: done, skipped and
    /// due stay as they were, and only `open` (nothing recorded) grows.
    @Test func aMemberAddedTodayChangesNoRecordedPastCell() throws {
        let f = try load()
        let before = try #require(f.deriveContainerSchedule.first { $0.name == "a routine, in its own order" })
        let after = try #require(f.deriveContainerSchedule.first { $0.name.hasPrefix("the same routine with a member added today") })
        let (a, _, today) = try derive(before, f.calendar)
        let (b, _, _) = try derive(after, f.calendar)
        for (x, y) in zip(dayRollup(a), dayRollup(b)) where x.date < today {
            #expect(x.done == y.done && x.skipped == y.skipped && x.due == y.due, "\(x.date)")
            #expect(y.open >= x.open, "\(x.date)")
        }
    }

    /// The range is clamped to 0...maxScheduleDays, as the web's is.
    @Test func theRangeIsClamped() throws {
        let f = try load()
        let c = try #require(f.deriveContainerSchedule.first)
        let members = try #require(organizeUUIDs(c.memberIds))
        let from = try #require(DayString(c.from))
        let source = ScheduleSource(items: f.calendar.items, routines: f.calendar.routines, seasons: f.calendar.seasons, timeZone: c.timeZone)
        #expect(deriveContainerSchedule(memberIds: members, source: source, from: from, days: -3, today: from).days.isEmpty)
        let long = deriveContainerSchedule(memberIds: members, source: source, from: from, days: 1000, today: from)
        #expect(long.days.count == maxScheduleDays)
    }

    /// `todayInOrder`'s two web edges: an id listed twice takes its LAST
    /// place, and one missing from the order takes place 0.
    @Test func todayInOrderKeepsTheWebsPositions() throws {
        let day = try #require(DayString("2026-10-23"))
        let a = UUID(uuidString: "00000000-0000-4000-8000-0000000000a1")!
        let b = UUID(uuidString: "00000000-0000-4000-8000-0000000000b2")!
        let stray = UUID(uuidString: "00000000-0000-4000-8000-0000000000c3")!
        let schedule = ContainerSchedule(days: [ScheduleDay(date: day, occurrences: [
            ScheduleOccurrence(itemId: a, date: day, state: .due, once: false),
            ScheduleOccurrence(itemId: b, date: day, state: .done, once: false),
            ScheduleOccurrence(itemId: stray, date: day, state: .due, once: true),
        ])], unscheduled: [])
        // a sits at 0 and 2 (the last wins: 2), b at 1, the stray at 0.
        let run = todayInOrder(schedule, order: [a, b, a], today: day)
        #expect(run.rows.map(\.itemId) == [stray, b, a])
        #expect(run.nextId == stray)
        #expect(!run.finished)
    }
}

private struct RollupKey: Hashable {
    let date: String
    let done: Int
    let due: Int
    let open: Int
    let skipped: Int
}
