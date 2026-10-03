import Foundation
import Testing
import DsulCore

// The web's own answers for lib/cadence.ts, checked against Cadence.swift.
// tests/unit/day-fixtures.test.ts runs every recurring case through the real
// `cadenceLabel` and commits the results to tests/fixtures/day/cadence.json
// (the one-off branch reads the browser's locale, so it has no cases). Never
// edit the JSON by hand: regenerate it from the Vitest side (UPDATE_FIXTURES=1).

private struct CadenceCase: Decodable, Sendable {
    let name: String
    let item: Item
    let expected: String
}

private struct Fixture: Decodable, Sendable {
    let cases: [CadenceCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/cadence.json"
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

@Suite struct CadenceFixtureTests {
    @Test func hasCases() throws {
        let cases = try loadFixture().cases
        #expect(!cases.isEmpty)
    }

    @Test func cadenceLabelMatchesTheWeb() throws {
        for c in try loadFixture().cases {
            #expect(cadenceLabel(c.item) == c.expected, "\(c.name)")
        }
    }

    /// The Repeat chip's words, read from the same table `cadenceLabel`
    /// reads. The fixture's `repeats` (`theRepeatWordsAreTheWebs`) is what
    /// pins them to the web.
    @Test func eachFrequencyHasItsWord() {
        #expect(repeatFrequencyOrder == ["none", "daily", "weekdays", "weekends", "monthly", "custom"])
        #expect(repeatFrequencyOrder.map(repeatFrequencyLabel)
            == ["No repeat", "Daily", "Weekdays", "Weekends", "Monthly", "Custom days"])
        // An unknown frequency is its own word.
        #expect(repeatFrequencyLabel("weekly") == "weekly")
    }

    /// The one-off branch, as en-US reads it.
    @Test func aOneOffSaysItsDayOrNoDate() {
        let id = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
        #expect(cadenceLabel(Item(id: id, title: "T", startDate: "2026-10-02")) == "Oct 2")
        #expect(cadenceLabel(Item(id: id, title: "T")) == "No date")
        #expect(cadenceLabel(Item(id: id, title: "T", startDate: "")) == "No date")
        #expect(cadenceLabel(Item(id: id, title: "T", repeatFrequency: "none")) == "No date")
    }
}

/// lib/container-schedule.ts `weekStartOf`, worked by hand: 2026-10-02 is a
/// Friday.
@Suite struct WeekStartTests {
    private let friday = DayString("2026-10-02")!

    @Test func eachSettingStartsTheWeekOnItsDay() {
        #expect(weekStartOf(friday, .sunday).description == "2026-09-27")
        #expect(weekStartOf(friday, .monday).description == "2026-09-28")
        #expect(weekStartOf(friday, .saturday).description == "2026-09-26")
    }

    @Test func theFirstDayIsItsOwnStart() {
        let sunday = DayString("2026-09-27")!
        let monday = DayString("2026-09-28")!
        let saturday = DayString("2026-09-26")!
        #expect(weekStartOf(sunday, .sunday) == sunday)
        #expect(weekStartOf(monday, .monday) == monday)
        #expect(weekStartOf(saturday, .saturday) == saturday)
        // A Sunday is the end of a Monday week.
        #expect(weekStartOf(sunday, .monday).description == "2026-09-21")
    }

    @Test func aWeekCrossesAYear() {
        #expect(weekStartOf(DayString("2027-01-01")!, .sunday).description == "2026-12-27")
    }

    @Test func theWeekdaysAreTheWebs() {
        #expect(WeekStartDay.sunday.weekday == 0)
        #expect(WeekStartDay.monday.weekday == 1)
        #expect(WeekStartDay.saturday.weekday == 6)
    }

    /// The Repeat sheet's Custom days keys run in the user's week, each day
    /// once; a day past the table has no word, as the web's `undefined` joins.
    @Test func theWeekRunsFromWeekStartsOn() {
        #expect(weekdayOrder(.sunday) == [0, 1, 2, 3, 4, 5, 6])
        #expect(weekdayOrder(.monday) == [1, 2, 3, 4, 5, 6, 0])
        #expect(weekdayOrder(.saturday) == [6, 0, 1, 2, 3, 4, 5])
        for start in WeekStartDay.allCases {
            #expect(weekdayOrder(start).first == start.weekday && Set(weekdayOrder(start)) == Set(0...6), "\(start)")
        }
        #expect((0...6).map(weekdayLabel) == ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
        #expect(weekdayLabel(7) == "")
        #expect(weekdayLabel(-1) == "")
    }
}
