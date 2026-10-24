import Foundation
import Testing
import DsulCore

// The web's own answers for a week, checked against the phone's day pipeline
// run once per day (DayItems.swift, Active.swift, ItemToggle.swift) and the
// week's days (Cadence.swift `weekDays`). tests/unit/day-fixtures.test.ts runs
// one busy world through the real TS and commits tests/fixtures/day/week.json;
// never edit it by hand.
//
// - `dates`: every day any week holds, once, with what the day pipeline answers
//   there (lib/active.ts `inactiveItemIdsOn` with the world's trips,
//   lib/day-items.ts `deriveDayItems` and `flattenDayRows`, day-schedule.tsx
//   `deriveTimedEntries` and `deriveUntimedRows`, lib/item-toggle.ts
//   `isRowDone` / `isRowSkipped` at each row's own day). Nothing in a day's
//   answer depends on the week start, which is why a day is written once.
// - `weeks`: three week starts × six anchors (mid-week, on the week start, on
//   the last day, across a month end, across LA's DST change, across a year
//   end), each the seven days `addDaysStr(weekStartOf(anchor, start), i)`.

private struct WeekWorld: Decodable, Sendable {
    let timeZone: String
    let items: [Item]
    let projects: [Project]
    let routines: [Routine]
    let seasons: [Season]
    let away: [AwayPeriod]
}

private struct TimedOut: Decodable, Sendable, Equatable {
    let id: String
    let startMin: Int
    let duration: Int
}

private struct DateExpected: Decodable, Sendable {
    let inactive: [String]
    let tasksByBucket: [String: [String]]
    let habitsByBucket: [String: [String]]
    let recurringProjects: [String]
    let flat: [String]
    let timed: [TimedOut]
    let untimed: [String]
    let done: [String]
    let skipped: [String]
}

private struct DateCase: Decodable, Sendable {
    let name: String
    let world: String
    let date: String
    let showCompletedTasks: Bool
    let expected: DateExpected
}

private struct WeekCase: Decodable, Sendable {
    let name: String
    let world: String
    let anchor: String
    let weekStartDay: String
    let days: [String]
}

private struct WeekFixture: Decodable, Sendable {
    let worlds: [String: WeekWorld]
    let dates: [DateCase]
    let weeks: [WeekCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> WeekFixture {
    let relative = "tests/fixtures/day/week.json"
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            let data: Data = try Data(contentsOf: candidate)
            return try JSONDecoder().decode(WeekFixture.self, from: data)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw FixtureError.notFound("\(relative) above \(here)")
}

private func ids(_ items: [Item]) -> [String] {
    return items.map { $0.id.uuidString.lowercased() }
}

/// One day of the phone's Today pipeline, with the world's trips, as the
/// fixture generator runs the web's: `project(items)`, `inactiveItemIdsOn`,
/// `deriveDayItems` with the phone's defaults.
private func run(_ world: WeekWorld, on date: DayString, showCompletedTasks: Bool) -> (inactive: Set<UUID>, day: DayItems) {
    let inactive = inactiveItemIdsOn(
        items: world.items, date: date, timeZone: world.timeZone,
        routines: world.routines, seasons: world.seasons, away: world.away
    )
    let split = project(world.items)
    let day = deriveDayItems(
        tasks: split.tasks, habits: split.habits, projects: world.projects,
        date: date, timeZone: world.timeZone, showCompletedTasks: showCompletedTasks, inactive: inactive
    )
    return (inactive: inactive, day: day)
}

/// Every field of one day's answer, labelled with where it was read from.
private func check(_ world: WeekWorld, _ c: DateCase, _ label: String) throws {
    let date = try #require(DayString(c.date), "\(label): bad date \(c.date)")
    let got = run(world, on: date, showCompletedTasks: c.showCompletedTasks)
    let e = c.expected
    #expect(got.inactive.map { $0.uuidString.lowercased() }.sorted() == e.inactive, "\(label): inactive")
    for bucket in bucketOrder {
        #expect(ids(got.day.tasksByBucket[bucket] ?? []) == (e.tasksByBucket[bucket.rawValue] ?? []), "\(label): \(bucket) tasks")
        #expect(ids(got.day.habitsByBucket[bucket] ?? []) == (e.habitsByBucket[bucket.rawValue] ?? []), "\(label): \(bucket) habits")
    }
    #expect(got.day.recurringProjects.map(\.id) == e.recurringProjects, "\(label): project blocks")
    let flat = flattenDayRows(got.day)
    #expect(ids(flat) == e.flat, "\(label): flat rows")
    let timed = deriveTimedEntries(got.day).map {
        TimedOut(id: $0.item.id.uuidString.lowercased(), startMin: $0.startMin, duration: $0.duration)
    }
    #expect(timed == e.timed, "\(label): timed")
    #expect(ids(deriveUntimedRows(got.day)) == e.untimed, "\(label): untimed")
    #expect(ids(flat.filter { isRowDone($0, on: date) }) == e.done, "\(label): done")
    #expect(ids(flat.filter { isRowSkipped($0, on: date) }) == e.skipped, "\(label): skipped")
}

@Suite struct WeekFixtureTests {
    @Test func theFileHoldsEveryWeekStartAndAnchor() throws {
        let f = try loadFixture()
        #expect(!f.dates.isEmpty)
        #expect(f.weeks.count == 18)
        // Every week start the setting has, each over the same six anchors.
        let starts = Set(f.weeks.map(\.weekStartDay))
        #expect(starts == Set(WeekStartDay.allCases.map(\.rawValue)))
        for start in starts {
            #expect(f.weeks.filter { $0.weekStartDay == start }.count == 6, "\(start)")
        }
        // Each day is written once, in order.
        let names = f.dates.map(\.date)
        #expect(names == names.sorted())
        #expect(Set(names).count == names.count)
    }

    @Test func weekDaysAreTheWebsSevenDays() throws {
        for w in try loadFixture().weeks {
            let start = try #require(WeekStartDay(rawValue: w.weekStartDay), "\(w.name): week start \(w.weekStartDay)")
            let anchor = try #require(DayString(w.anchor), "\(w.name): bad anchor \(w.anchor)")
            let days = weekDays(of: anchor, start)
            #expect(days.map(\.description) == w.days, "\(w.name)")
            #expect(days.first.map { weekStartOf(anchor, start) == $0 } == true, "\(w.name): the first day is the week's start")
            #expect(days.first?.weekday == start.weekday, "\(w.name): starts on \(start)")
            #expect(days.contains(anchor), "\(w.name): holds its anchor")
            // Any of the seven days gives the same week back.
            for day in days {
                #expect(weekDays(of: day, start) == days, "\(w.name): from \(day)")
            }
        }
    }

    @Test func everyDayMatchesTheWeb() throws {
        let f = try loadFixture()
        for c in f.dates {
            let world = try #require(f.worlds[c.world], "\(c.name): no world \(c.world)")
            try check(world, c, c.name)
        }
    }

    @Test func everyDayOfEveryWeekMatchesTheWeb() throws {
        let f = try loadFixture()
        let byDate = Dictionary(f.dates.map { ($0.date, $0) }, uniquingKeysWith: { first, _ in first })
        var used = Set<String>()
        for w in f.weeks {
            let world = try #require(f.worlds[w.world], "\(w.name): no world \(w.world)")
            let start = try #require(WeekStartDay(rawValue: w.weekStartDay), "\(w.name): week start \(w.weekStartDay)")
            let anchor = try #require(DayString(w.anchor), "\(w.name): bad anchor \(w.anchor)")
            for day in weekDays(of: anchor, start) {
                let c = try #require(byDate[day.description], "\(w.name): no answer for \(day)")
                try check(world, c, "\(w.name), \(day)")
                used.insert(day.description)
            }
        }
        // Every day written is a day some week holds.
        #expect(used == Set(byDate.keys))
    }

    /// The grid and the rows off it split a day between them: a row is in
    /// exactly one, except a task in a project block whose block is not on
    /// that day, which is in neither.
    @Test func aDaysRowsAreOnTheGridOrOffItOnce() throws {
        let f = try loadFixture()
        for c in f.dates {
            let world = try #require(f.worlds[c.world], "\(c.name): no world \(c.world)")
            let date = try #require(DayString(c.date), "\(c.name): bad date \(c.date)")
            let day = run(world, on: date, showCompletedTasks: c.showCompletedTasks).day
            let timed = Set(deriveTimedEntries(day).map(\.item.id))
            let untimed = Set(deriveUntimedRows(day).map(\.id))
            #expect(timed.isDisjoint(with: untimed), "\(c.name)")
            let blocks = Set(day.recurringProjects.map(\.name))
            for row in flattenDayRows(day) {
                let inOffBlock = !row.isHabit && row.inProjectBlock == true && !blocks.contains(row.project ?? "")
                let placed = (timed.contains(row.id) ? 1 : 0) + (untimed.contains(row.id) ? 1 : 0)
                #expect(placed == (inOffBlock ? 0 : 1), "\(c.name): \(row.title)")
            }
        }
    }
}
