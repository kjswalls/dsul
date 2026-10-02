import Foundation
import Testing
import DsulCore

// The web store's own end states for the item sheet's three writes, checked
// against VerbWrites.swift. tests/unit/verb-writes-fixtures.test.ts drives the
// REAL planner store (`setItemSkipped`, `moveTaskToDate`, `setItemPaused`)
// over one item per case, with the database mocked and the clock pinned, and
// records the item as the store leaves it and the database calls it made to
// tests/fixtures/day/verb-writes.json. Never edit the JSON by hand: regenerate
// it from the Vitest side (UPDATE_FIXTURES=1).
//
// `gate: false` is the store's own refusal (not skippable, a habit moved, not
// pausable): nothing written, the item unchanged. The sheet's verb gates
// refuse first, but the ports refuse the same way, so those cases are checked
// too. A pause case is resolved through `resolvePauseWrite`, as the phone
// resolves it, and its patch is checked against the store's write.

extension KeyedDecodingContainer {
    /// Absent is nil, null is `.clear`, a string is `.set`.
    fileprivate func columnWrite(_ key: Key) throws -> ColumnWrite? {
        guard contains(key) else { return nil }
        if try decodeNil(forKey: key) { return .clear }
        return .set(try decode(String.self, forKey: key))
    }
}

/// The pause columns of an `updateItem` call's `updates`, each in its three
/// states. Any other column is ignored.
private struct PauseUpdates: Decodable, Sendable {
    let pausedAt: ColumnWrite?
    let pausedUntil: ColumnWrite?

    enum CodingKeys: String, CodingKey {
        case pausedAt, pausedUntil
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pausedAt = try c.columnWrite(.pausedAt)
        pausedUntil = try c.columnWrite(.pausedUntil)
    }
}

/// One database call the store made: `setItemCompletion`, `setItemSkip` or
/// `updateItem`.
private struct DbCall: Decodable, Sendable {
    let fn: String
    let updates: PauseUpdates?
}

private struct Outcome: Decodable, Sendable {
    let item: Item
    let calls: [DbCall]
}

private struct SkipCase: Decodable, Sendable {
    let name: String
    let now: String
    let timeZone: String
    let todayStr: String
    let item: Item
    let date: String
    let skipped: Bool
    let gate: Bool
    let expected: Outcome
}

private struct MoveCase: Decodable, Sendable {
    let name: String
    let now: String
    let timeZone: String
    let todayStr: String
    let item: Item
    let date: String
    let gate: Bool
    let expected: Outcome
}

private struct PauseCase: Decodable, Sendable {
    let name: String
    let now: String
    let timeZone: String
    let todayStr: String
    let item: Item
    let paused: Bool
    /// The resume day a pause is given; null for an open-ended pause (the
    /// store is handed no end), and always for a resume.
    let pausedUntil: String?
    let gate: Bool
    let expected: Outcome
}

private struct Fixture: Decodable, Sendable {
    let skip: [SkipCase]
    let move: [MoveCase]
    let pause: [PauseCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/verb-writes.json"
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

/// The case's clock: `now` names an instant, `today` is that instant's day in
/// `timeZone`, and `toISOString` writes `now` back as the web wrote it.
private func checkClock(_ name: String, now: String, timeZone: String, today: String) throws {
    let instant = try #require(parseTimestamp(now), "\(name): bad now \(now)")
    #expect(toDateStr(instant, timeZone: timeZone)?.description == today, "\(name): today")
    #expect(toISOString(instant) == now, "\(name): stamp")
}

@Suite struct VerbWritesFixtureTests {
    @Test func everyVerbHasCasesBothWays() throws {
        let f = try loadFixture()
        #expect(Set(f.skip.map(\.gate)) == [true, false])
        #expect(Set(f.move.map(\.gate)) == [true, false])
        #expect(Set(f.pause.map(\.gate)) == [true, false])
    }

    /// The store's gate is the port's: `isSkippable`, task-like, `isPausable`.
    @Test func theGatesAreThePorts() throws {
        let f = try loadFixture()
        for c in f.skip { #expect(isSkippable(c.item) == c.gate, "\(c.name)") }
        for c in f.move { #expect(isTaskLike(c.item) == c.gate, "\(c.name)") }
        for c in f.pause { #expect(isPausable(c.item) == c.gate, "\(c.name)") }
    }

    /// Each case's today is what the phone reads off the same instant and zone,
    /// and its stamp is what `toISOString` writes for that instant.
    @Test func theClockReadsAsTheWebReadsIt() throws {
        let f = try loadFixture()
        for c in f.skip { try checkClock(c.name, now: c.now, timeZone: c.timeZone, today: c.todayStr) }
        for c in f.move { try checkClock(c.name, now: c.now, timeZone: c.timeZone, today: c.todayStr) }
        for c in f.pause { try checkClock(c.name, now: c.now, timeZone: c.timeZone, today: c.todayStr) }
    }

    @Test func skippingLandsWhereTheStoreDoes() throws {
        for c in try loadFixture().skip {
            #expect(skipping(c.item, on: c.date, skipped: c.skipped) == c.expected.item, "\(c.name)")
        }
    }

    /// A task-like skip never writes a status: the task words are an external
    /// contract.
    @Test func aTaskLikeSkipKeepsItsStatus() throws {
        for c in try loadFixture().skip where !c.item.isHabit {
            #expect(skipping(c.item, on: c.date, skipped: c.skipped).status == c.item.status, "\(c.name)")
        }
    }

    @Test func movingLandsWhereTheStoreDoes() throws {
        for c in try loadFixture().move {
            #expect(moving(c.item, to: c.date) == c.expected.item, "\(c.name)")
        }
    }

    @Test func pausingLandsWhereTheStoreDoes() throws {
        for c in try loadFixture().pause where c.gate {
            let result = resolvePauseWrite(
                current: c.item, paused: c.paused, pausedUntil: c.pausedUntil.map { ColumnWrite.set($0) },
                todayStr: c.todayStr, nowISO: c.now, timeZone: c.timeZone
            )
            guard case .patch(let patch) = result else {
                Issue.record("\(c.name): refused, \(result)")
                continue
            }
            #expect(pausing(c.item, patch: patch) == c.expected.item, "\(c.name)")

            // The patch is the store's write: one updateItem with exactly those
            // columns, or nothing at all for an empty patch.
            let updates = c.expected.calls.filter { $0.fn == "updateItem" }.compactMap(\.updates)
            if patch.isEmpty {
                #expect(c.expected.calls.isEmpty, "\(c.name): an empty patch writes nothing")
            } else {
                #expect(c.expected.calls.count == 1, "\(c.name): one write")
                let written = try #require(updates.first, "\(c.name): no updateItem")
                #expect(written.pausedAt == patch.pausedAt, "\(c.name): pausedAt")
                #expect(written.pausedUntil == patch.pausedUntil, "\(c.name): pausedUntil")
            }
        }
    }

    /// What a refused case leaves: the item exactly as it was.
    @Test func aRefusedCaseChangesNothing() throws {
        let f = try loadFixture()
        for c in f.skip where !c.gate {
            #expect(c.expected.item == c.item, "\(c.name): the fixture")
            #expect(skipping(c.item, on: c.date, skipped: c.skipped) == c.item, "\(c.name)")
        }
        for c in f.move where !c.gate {
            #expect(c.expected.item == c.item, "\(c.name): the fixture")
            #expect(moving(c.item, to: c.date) == c.item, "\(c.name)")
        }
    }
}

/// The two skip branches, on hand-written items.
@Suite struct SkippingTests {
    private let id = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
    private let day = "2026-10-02"

    @Test func aHabitSkipTakesTheDaysCompletionAndAStreakDay() {
        let habit = Item(
            id: id, type: "habit", title: "Stretch", status: "done", repeatFrequency: "daily", streak: 3,
            completedDates: ["2026-10-01", day]
        )
        let skipped = skipping(habit, on: day, skipped: true)
        #expect(skipped.status == "skipped")
        #expect(skipped.completedDates == ["2026-10-01"])
        #expect(skipped.skippedDates == [day])
        #expect(skipped.streak == 2)
        #expect(skipped.currentDayCount == 0)
        let unskipped = skipping(skipped, on: day, skipped: false)
        #expect(unskipped.status == "pending")
        #expect(unskipped.skippedDates.isEmpty)
        // Unskipping never gives the completion back.
        #expect(unskipped.completedDates == ["2026-10-01"])
        #expect(unskipped.streak == 2)
    }

    @Test func aRecurringTaskSkipMovesTheDatesOnly() {
        let task = Item(
            id: id, title: "Water", status: "pending", startDate: "2026-09-01", repeatFrequency: "daily",
            completedDates: [day]
        )
        let skipped = skipping(task, on: day, skipped: true)
        #expect(skipped.status == "pending")
        #expect(skipped.completedDates.isEmpty)
        #expect(skipped.skippedDates == [day])
        // Already skipped: nothing changes.
        #expect(skipping(skipped, on: day, skipped: true) == skipped)
    }

    @Test func aOneOffCannotBeSkippedOrAHabitMoved() {
        let oneOff = Item(id: id, title: "Buy milk", status: "pending", startDate: day)
        #expect(skipping(oneOff, on: day, skipped: true) == oneOff)
        let habit = Item(id: id, type: "habit", title: "Stretch", repeatFrequency: "daily")
        #expect(moving(habit, to: "2026-10-03") == habit)
    }

    @Test func aMoveKeepsTheBucketOrFilesUnderAnytime() {
        let timed = Item(id: id, title: "Call", startDate: day, startTime: "14:00", timeBucket: "afternoon", duration: 45)
        let moved = moving(timed, to: "2026-10-05")
        #expect(moved.startDate == "2026-10-05")
        #expect(moved.timeBucket == "afternoon")
        #expect(moved.startTime == "14:00")
        #expect(moved.duration == 45)
        #expect(moving(Item(id: id, title: "Undated"), to: day).timeBucket == "anytime")
    }
}
