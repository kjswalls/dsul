import Foundation
import Testing
import DsulCore

// The web's own answers for what a day shows, checked against DayItems.swift:
// the task/habit split and `deriveDayItems` (day-items.json), the Schedule's
// timed entries (timed.json), braindump membership (braindump.json) and
// routine grouping (routine-groups.json). tests/unit/day-fixtures.test.ts runs
// every case through the real TS and commits the results under
// tests/fixtures/day/; never edit them by hand.

private struct DayWorld: Decodable, Sendable {
    let timeZone: String
    let items: [Item]
    let projects: [Project]
    let routines: [Routine]
    let seasons: [Season]
}

private struct DayExpected: Decodable, Sendable {
    let inactive: [String]
    let tasks: [String]
    let habits: [String]
    let tasksByBucket: [String: [String]]
    let habitsByBucket: [String: [String]]
    let recurringProjects: [String]
    let flat: [String]
}

private struct DayScenario: Decodable, Sendable {
    let name: String
    let world: String
    let date: String
    let showCompletedTasks: Bool
    let expected: DayExpected
}

private struct DayFixture: Decodable, Sendable {
    let worlds: [String: DayWorld]
    let scenarios: [DayScenario]
}

private struct TimedOut: Decodable, Sendable, Equatable {
    let id: String
    let startMin: Int
    let duration: Int
}

private struct TimedScenario: Decodable, Sendable {
    let name: String
    let world: String
    let date: String
    let showCompletedTasks: Bool
    let expected: [TimedOut]
}

private struct TimedFixture: Decodable, Sendable {
    let worlds: [String: DayWorld]
    let scenarios: [TimedScenario]
}

private struct BraindumpCase: Decodable, Sendable {
    let name: String
    let today: String
    let selectedDate: String
    let timeZone: String
    let items: [Item]
    let routines: [Routine]
    let seasons: [Season]
    let expected: [String]
    let atSelectedDate: [String]
}

private struct BraindumpFixture: Decodable, Sendable {
    let cases: [BraindumpCase]
}

private struct GroupOut: Decodable, Sendable, Equatable {
    let routineId: String
    let itemIds: [String]
}

private struct GroupsExpected: Decodable, Sendable {
    let groups: [GroupOut]
    let loose: [String]
}

private struct GroupsCase: Decodable, Sendable {
    let name: String
    let items: [Item]
    let routines: [Routine]
    let expected: GroupsExpected
}

private struct GroupsFixture: Decodable, Sendable {
    let cases: [GroupsCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture<T: Decodable>(_ name: String, as type: T.Type, _ here: String = #filePath) throws -> T {
    let relative = "tests/fixtures/day/\(name).json"
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            let data: Data = try Data(contentsOf: candidate)
            return try JSONDecoder().decode(T.self, from: data)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw FixtureError.notFound("\(relative) above \(here)")
}

private func ids(_ items: [Item]) -> [String] {
    return items.map { $0.id.uuidString.lowercased() }
}

/// The phone's Today pipeline for one day, as the fixture generator runs the web's.
private func run(_ world: DayWorld, date: DayString, showCompletedTasks: Bool) -> (inactive: Set<UUID>, tasks: [Item], habits: [Item], day: DayItems) {
    let inactive = inactiveItemIdsOn(
        items: world.items, date: date, timeZone: world.timeZone,
        routines: world.routines, seasons: world.seasons
    )
    let split = project(world.items)
    let day = deriveDayItems(
        tasks: split.tasks, habits: split.habits, projects: world.projects,
        date: date, timeZone: world.timeZone, showCompletedTasks: showCompletedTasks, inactive: inactive
    )
    return (inactive: inactive, tasks: split.tasks, habits: split.habits, day: day)
}

@Suite struct DayItemsFixtureTests {
    @Test func everyFileHasCases() throws {
        #expect(try !loadFixture("day-items", as: DayFixture.self).scenarios.isEmpty)
        #expect(try !loadFixture("timed", as: TimedFixture.self).scenarios.isEmpty)
        #expect(try !loadFixture("braindump", as: BraindumpFixture.self).cases.isEmpty)
        #expect(try !loadFixture("routine-groups", as: GroupsFixture.self).cases.isEmpty)
    }

    @Test func deriveDayItemsMatchesTheWeb() throws {
        let f = try loadFixture("day-items", as: DayFixture.self)
        for s in f.scenarios {
            let world = try #require(f.worlds[s.world], "\(s.name): no world \(s.world)")
            let date = try #require(DayString(s.date), "\(s.name): bad date \(s.date)")
            let got = run(world, date: date, showCompletedTasks: s.showCompletedTasks)
            let e = s.expected
            #expect(got.inactive.map { $0.uuidString.lowercased() }.sorted() == e.inactive, "\(s.name): inactive")
            #expect(ids(got.tasks) == e.tasks, "\(s.name): tasks projection")
            #expect(ids(got.habits) == e.habits, "\(s.name): habits projection")
            for bucket in bucketOrder {
                #expect(ids(got.day.tasksByBucket[bucket] ?? []) == (e.tasksByBucket[bucket.rawValue] ?? []), "\(s.name): \(bucket) tasks")
                #expect(ids(got.day.habitsByBucket[bucket] ?? []) == (e.habitsByBucket[bucket.rawValue] ?? []), "\(s.name): \(bucket) habits")
            }
            #expect(got.day.recurringProjects.map(\.id) == e.recurringProjects, "\(s.name): project blocks")
            #expect(ids(flattenDayRows(got.day)) == e.flat, "\(s.name): flat rows")
            let total = e.tasksByBucket.values.reduce(0) { $0 + $1.count } + e.habitsByBucket.values.reduce(0) { $0 + $1.count }
            #expect(got.day.totalCount == total, "\(s.name): total")
        }
    }

    @Test func deriveTimedEntriesMatchesTheWeb() throws {
        let f = try loadFixture("timed", as: TimedFixture.self)
        for s in f.scenarios {
            let world = try #require(f.worlds[s.world], "\(s.name): no world \(s.world)")
            let date = try #require(DayString(s.date), "\(s.name): bad date \(s.date)")
            let entries = deriveTimedEntries(run(world, date: date, showCompletedTasks: s.showCompletedTasks).day)
            let got = entries.map { TimedOut(id: $0.item.id.uuidString.lowercased(), startMin: $0.startMin, duration: $0.duration) }
            #expect(got == s.expected, "\(s.name)")
        }
    }

    @Test func braindumpMembersMatchTheWeb() throws {
        for c in try loadFixture("braindump", as: BraindumpFixture.self).cases {
            let split = project(c.items)
            func members(at dateString: String) throws -> [String] {
                let date = try #require(DayString(dateString), "\(c.name): bad date \(dateString)")
                let suppressed = inactiveItemIdsOn(
                    items: c.items, date: date, timeZone: c.timeZone, routines: c.routines, seasons: c.seasons
                )
                return ids(braindumpMembers(tasks: split.tasks, habits: split.habits, suppressed: suppressed))
            }
            // Resolved at today, never the selected day.
            #expect(try members(at: c.today) == c.expected, "\(c.name)")
            #expect(try members(at: c.selectedDate) == c.atSelectedDate, "\(c.name): at the selected day")
        }
    }

    @Test func routineGroupsMatchTheWeb() throws {
        for c in try loadFixture("routine-groups", as: GroupsFixture.self).cases {
            let got = routineGroups(c.items, routines: c.routines)
            let groups = got.groups.map { GroupOut(routineId: $0.0.id, itemIds: ids($0.1)) }
            #expect(groups == c.expected.groups, "\(c.name): groups")
            #expect(ids(got.loose) == c.expected.loose, "\(c.name): loose")
        }
    }
}

/// Rows the web can't read: it throws on an unknown bucket and sorts a
/// malformed time as NaN. The phone leaves the row out instead of failing.
@Suite struct DayItemsEdgeTests {
    private let day = DayString("2026-10-02")!

    private func task(_ n: Int, bucket: String?, time: String? = nil) -> Item {
        let id = UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", n))!
        return Item(id: id, title: "t\(n)", status: "pending", startDate: "2026-10-02", startTime: time, timeBucket: bucket, isScheduled: true)
    }

    @Test func anUnknownBucketIsLeftOut() {
        let rows = [task(1, bucket: "noon"), task(2, bucket: "morning")]
        let out = deriveDayItems(
            tasks: rows, habits: [], projects: [], date: day, timeZone: "UTC", showCompletedTasks: true, inactive: []
        )
        #expect(out.totalCount == 1)
        #expect(out.tasksByBucket[.morning]?.map(\.title) == ["t2"])
    }

    @Test func aMalformedTimeIsLeftOffTheGrid() {
        let rows = [task(1, bucket: "morning", time: "9am"), task(2, bucket: "morning", time: "09:15")]
        let out = deriveDayItems(
            tasks: rows, habits: [], projects: [], date: day, timeZone: "UTC", showCompletedTasks: true, inactive: []
        )
        let entries = deriveTimedEntries(out)
        #expect(entries.map(\.item.title) == ["t2"])
        #expect(entries.first?.startMin == 9 * 60 + 15)
    }
}
