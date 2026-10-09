import Foundation
import Testing
import DsulCore

// The web's own answers for lib/reminders/due.ts, checked against
// ReminderDue.swift: the cue's parser and window, "does this want doing", the
// scan's own question (dueReminders), what the last call names, the streak and
// the snooze's maturity. tests/unit/day-fixtures.test.ts runs every case through
// the real TS and commits the results to tests/fixtures/day/due.json; `occursOn`
// is in occurs.json (OccursFixtureTests). Never edit the JSON by hand:
// regenerate it from the Vitest side (UPDATE_FIXTURES=1).

private struct MinutesCase: Decodable, Sendable {
    let name: String
    let input: String?
    let expected: Int?
}

private struct WindowCase: Decodable, Sendable {
    let name: String
    let target: Int
    let now: Int
    let grace: Int?
    let expected: Bool
}

private struct WantsCase: Decodable, Sendable {
    let name: String
    let timeZone: String
    let item: Item
    let routines: [Routine]
    let seasons: [Season]
    let dateStr: String
    let expected: Bool
}

private struct RowFixture: Decodable, Sendable {
    let item: Item
    let sentKey: String?
    let snoozeUntil: String?
    let snoozeDate: String?
}

private struct ClockFixture: Decodable, Sendable {
    let dateStr: String
    let nowMinutes: Int
    let nowIso: String
    let nowMs: Int
    let graceMinutes: Int?
    let latestOpening: Int?
}

/// A candidate as ids and words: `anchor` is absent when there is none.
private struct CandidateFixture: Decodable, Sendable, Equatable {
    let itemId: String
    let at: String
    let anchor: String?
    let snoozed: Bool
}

private struct DueCase: Decodable, Sendable {
    let name: String
    let timeZone: String
    let rows: [RowFixture]
    let clock: ClockFixture
    let expected: [CandidateFixture]
}

private struct LastCallCase: Decodable, Sendable {
    let name: String
    let timeZone: String
    let items: [Item]
    let dateStr: String
    let expected: [String]
}

private struct StreakCase: Decodable, Sendable {
    let name: String
    let item: Item
    let expected: Int
}

private struct MaturedCase: Decodable, Sendable {
    let name: String
    let snoozeUntil: String?
    let nowMs: Int
    let expected: Bool
}

private struct SentKeyCase: Decodable, Sendable {
    let name: String
    let dateStr: String
    let at: String
    let expected: String
}

private struct Fixture: Decodable, Sendable {
    let graceMinutes: Int
    let minutesOfDay: [MinutesCase]
    let isWithinWindow: [WindowCase]
    let wantsDoingOn: [WantsCase]
    let dueReminders: [DueCase]
    let lastCallItems: [LastCallCase]
    let streakOf: [StreakCase]
    let hasMatured: [MaturedCase]
    let sentKeyFor: [SentKeyCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/due.json"
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

private func wire(_ id: UUID) -> String {
    return id.uuidString.lowercased()
}

@Suite struct DueFixtureTests {
    @Test func everySectionHasCasesAndBothAnswers() throws {
        let f = try loadFixture()
        #expect(Set(f.minutesOfDay.map { $0.expected == nil }) == [true, false])
        #expect(Set(f.isWithinWindow.map(\.expected)) == [true, false])
        #expect(Set(f.wantsDoingOn.map(\.expected)) == [true, false])
        #expect(Set(f.hasMatured.map(\.expected)) == [true, false])
        #expect(f.dueReminders.contains { $0.expected.isEmpty })
        #expect(f.dueReminders.contains { $0.expected.count > 1 })
        #expect(f.dueReminders.contains { $0.expected.contains(where: \.snoozed) })
        #expect(!f.lastCallItems.isEmpty)
        #expect(!f.streakOf.isEmpty)
        #expect(!f.sentKeyFor.isEmpty)
    }

    @Test func theGraceIsTheWebs() throws {
        #expect(reminderGraceMinutes == (try loadFixture()).graceMinutes)
    }

    @Test func minutesOfDayMatchesTheWeb() throws {
        for c in try loadFixture().minutesOfDay {
            #expect(minutesOfDay(c.input) == c.expected, "\(c.name)")
        }
    }

    @Test func isWithinWindowMatchesTheWeb() throws {
        for c in try loadFixture().isWithinWindow {
            let got = c.grace.map { isWithinWindow(c.target, now: c.now, grace: $0) } ?? isWithinWindow(c.target, now: c.now)
            #expect(got == c.expected, "\(c.name)")
        }
    }

    @Test func wantsDoingOnMatchesTheWeb() throws {
        for c in try loadFixture().wantsDoingOn {
            let ctx = ActivationContext(timeZone: c.timeZone, routines: c.routines, seasons: c.seasons)
            #expect(wantsDoingOn(c.item, on: c.dateStr, ctx) == c.expected, "\(c.name)")
        }
    }

    @Test func dueRemindersMatchesTheWeb() throws {
        for c in try loadFixture().dueReminders {
            let rows = c.rows.map {
                ScanRow(item: $0.item, sentKey: $0.sentKey, snoozeUntil: $0.snoozeUntil, snoozeDate: $0.snoozeDate)
            }
            let clock = ScanClock(
                dateStr: c.clock.dateStr, nowMinutes: c.clock.nowMinutes, nowIso: c.clock.nowIso,
                nowMs: c.clock.nowMs, graceMinutes: c.clock.graceMinutes, latestOpening: c.clock.latestOpening
            )
            let got = dueReminders(rows, clock: clock, ActivationContext(timeZone: c.timeZone)).map {
                CandidateFixture(itemId: wire($0.item.id), at: $0.at, anchor: $0.anchor, snoozed: $0.snoozed)
            }
            #expect(got == c.expected, "\(c.name)")
        }
    }

    @Test func lastCallItemsMatchesTheWeb() throws {
        for c in try loadFixture().lastCallItems {
            let got = lastCallItems(c.items, on: c.dateStr, ActivationContext(timeZone: c.timeZone)).map { wire($0.id) }
            #expect(got == c.expected, "\(c.name)")
        }
    }

    @Test func streakOfMatchesTheWeb() throws {
        for c in try loadFixture().streakOf {
            #expect(streakOf(c.item) == c.expected, "\(c.name)")
        }
    }

    @Test func hasMaturedMatchesTheWeb() throws {
        for c in try loadFixture().hasMatured {
            #expect(hasMatured(c.snoozeUntil, nowMs: c.nowMs) == c.expected, "\(c.name)")
        }
    }

    @Test func sentKeyForMatchesTheWeb() throws {
        for c in try loadFixture().sentKeyFor {
            #expect(sentKeyFor(c.dateStr, c.at) == c.expected, "\(c.name)")
        }
    }

    /// `wantsDoingOn` is the three predicates it composes, never a fourth rule.
    @Test func wantsDoingOnIsTheThreePortedPredicates() throws {
        for c in try loadFixture().wantsDoingOn {
            let day = try #require(DayString(c.dateStr), "\(c.name)")
            let composed = occursOn(c.item, on: c.dateStr, timeZone: c.timeZone)
                && isOpenLoopOn(c.item, on: day)
                && isItemActiveOn(c.item, on: day, timeZone: c.timeZone, routines: c.routines, seasons: c.seasons)
            #expect(wantsDoingOn(c.item, on: day, ActivationContext(
                timeZone: c.timeZone, routines: c.routines, seasons: c.seasons
            )) == composed, "\(c.name)")
        }
    }
}
