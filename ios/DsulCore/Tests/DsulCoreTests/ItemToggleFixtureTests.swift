import Foundation
import Testing
import DsulCore

// The web's own answers for lib/item-toggle.ts, checked against
// ItemToggle.swift. tests/unit/day-fixtures.test.ts ticks each case through
// the real `toggleRowDone` with a fake store, records the call it made, and
// writes the end state that call asks for (`intent`) to
// tests/fixtures/day/toggle.json. Never edit the JSON by hand.

private struct Intent: Decodable, Sendable {
    let done: Bool
    let count: Int?
}

private struct ToggleCase: Decodable, Sendable {
    let name: String
    let item: Item
    let date: String
    let isRowDone: Bool
    let isRowSkipped: Bool
    let intent: Intent?
}

private struct Fixture: Decodable, Sendable {
    let cases: [ToggleCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/toggle.json"
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            let data: Data = try Data(contentsOf: candidate)
            return try JSONDecoder().decode(Fixture.self, from: data)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw FixtureError.notFound("\(relative) above \(here)")
}

@Suite struct ItemToggleFixtureTests {
    @Test func hasCases() throws {
        let cases = try loadFixture().cases
        #expect(!cases.isEmpty)
        #expect(cases.contains { $0.intent == nil })
    }

    @Test func rowStateMatchesTheWeb() throws {
        for c in try loadFixture().cases {
            let day = try #require(DayString(c.date), "\(c.name): bad date \(c.date)")
            #expect(isRowDone(c.item, on: day) == c.isRowDone, "\(c.name): done")
            #expect(isRowSkipped(c.item, on: day) == c.isRowSkipped, "\(c.name): skipped")
        }
    }

    @Test func tickIntentMatchesTheWeb() throws {
        for c in try loadFixture().cases {
            let day = try #require(DayString(c.date), "\(c.name): bad date \(c.date)")
            let got = tickIntent(c.item, on: day)
            if let want = c.intent {
                #expect(got == TickIntent(done: want.done, count: want.count), "\(c.name)")
            } else {
                #expect(got == nil, "\(c.name): a skipped row sends nothing")
            }
        }
    }

    /// After the optimistic step the row reads as the intent says: done exactly
    /// when the intent is done (a counted habit below target stays open).
    @Test func applyingLandsWhereTheIntentSays() throws {
        for c in try loadFixture().cases {
            let day = try #require(DayString(c.date))
            guard let intent = tickIntent(c.item, on: day) else { continue }
            let next = applying(intent, to: c.item, on: day)
            #expect(isRowDone(next, on: day) == intent.done, "\(c.name)")
            #expect(next.id == c.item.id && next.title == c.item.title, "\(c.name)")
            if let count = intent.count {
                #expect(next.dailyCounts[c.date] == count, "\(c.name): count")
            }
        }
    }
}

/// The optimistic step, ported from lib/planner-store.ts `toggleTaskStatus`
/// and `toggleHabitStatus`.
@Suite struct ApplyingTests {
    private let day = DayString("2026-10-02")!
    private let id = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!

    @Test func aOneOffFlipsItsStatus() {
        let task = Item(id: id, title: "File taxes", status: "pending", startDate: "2026-10-02")
        let done = applying(TickIntent(done: true), to: task, on: day)
        #expect(done.status == "completed")
        #expect(done.completedDates.isEmpty)
        #expect(applying(TickIntent(done: false), to: done, on: day).status == "pending")
    }

    @Test func aCustomOneOffUsesItsTypesDoneStatus() {
        let errand = Item(id: id, type: "custom", customType: "errand", title: "Stamps", status: "cancelled")
        #expect(tickIntent(errand, on: day) == TickIntent(done: true))
        #expect(applying(TickIntent(done: true), to: errand, on: day).status == caps("errand").doneStatus)
    }

    @Test func aRecurringTaskWritesTheDateNeverTheStatus() {
        let task = Item(id: id, title: "Water", status: "pending", startDate: "2026-09-01", repeatFrequency: "daily")
        let done = applying(TickIntent(done: true), to: task, on: day)
        #expect(done.completedDates == ["2026-10-02"])
        #expect(done.status == "pending")
        let undone = applying(TickIntent(done: false), to: done, on: day)
        #expect(undone.completedDates.isEmpty)
        // A repeat of the same state changes nothing.
        #expect(applying(TickIntent(done: true), to: done, on: day) == done)
    }

    @Test func aHabitTickMovesTheStreakByOne() {
        let habit = Item(id: id, type: "habit", title: "Stretch", status: "pending", repeatFrequency: "daily", streak: 4)
        let done = applying(TickIntent(done: true), to: habit, on: day)
        #expect(done.status == "done")
        #expect(done.completedDates == ["2026-10-02"])
        #expect(done.streak == 5)
        let undone = applying(TickIntent(done: false), to: done, on: day)
        #expect(undone.status == "pending")
        #expect(undone.completedDates.isEmpty)
        #expect(undone.streak == 4)
    }

    @Test func theStreakNeverGoesBelowZero() {
        let habit = Item(
            id: id, type: "habit", title: "Stretch", status: "done", repeatFrequency: "daily", streak: 0,
            completedDates: ["2026-10-02"]
        )
        #expect(applying(TickIntent(done: false), to: habit, on: day).streak == 0)
    }

    @Test func aCountedHabitRecordsTheTally() {
        let habit = Item(
            id: id, type: "habit", title: "Water", status: "pending", repeatFrequency: "daily", streak: 2,
            timesPerDay: 3, dailyCounts: ["2026-10-02": 1]
        )
        let intent = tickIntent(habit, on: day)
        #expect(intent == TickIntent(done: false, count: 2))
        let stepped = applying(TickIntent(done: false, count: 2), to: habit, on: day)
        #expect(stepped.dailyCounts["2026-10-02"] == 2)
        #expect(stepped.completedDates.isEmpty)
        #expect(stepped.streak == 2)
        let full = applying(TickIntent(done: true, count: 3), to: stepped, on: day)
        #expect(full.dailyCounts["2026-10-02"] == 3)
        #expect(full.completedDates == ["2026-10-02"])
        #expect(full.streak == 3)
        // Unticking a full day clears it back to 0.
        #expect(tickIntent(full, on: day) == TickIntent(done: false, count: 0))
        let cleared = applying(TickIntent(done: false, count: 0), to: full, on: day)
        #expect(cleared.dailyCounts["2026-10-02"] == 0)
        #expect(cleared.completedDates.isEmpty)
    }

    @Test func aSkippedRowSendsNothing() {
        let habit = Item(
            id: id, type: "habit", title: "Stretch", status: "skipped", repeatFrequency: "daily",
            skippedDates: ["2026-10-02"]
        )
        #expect(isRowSkipped(habit, on: day))
        #expect(tickIntent(habit, on: day) == nil)
        let task = Item(id: id, title: "Water", status: "pending", startDate: "2026-09-01", repeatFrequency: "daily", skippedDates: ["2026-10-02"])
        #expect(tickIntent(task, on: day) == nil)
    }
}
