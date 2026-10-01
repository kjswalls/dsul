import Foundation
import Testing
import DsulCore

// The web's own answers, checked against the port. tests/unit/recurrence-fixtures.test.ts
// runs every case through lib/recurrence.ts and commits the results to
// tests/fixtures/recurrence/cases.json; this file reads the same JSON, so the
// two can't drift without CI going red. Never edit the JSON by hand: regenerate
// it from the Vitest side (UPDATE_FIXTURES=1).

/// A rule as the web spells it: the item's repeat fields. A missing key and an
/// explicit null both decode as nil, which is what `undefined` and null are there.
private struct FixtureRule: Decodable, Sendable {
    let repeatFrequency: String?
    let repeatDays: [Int]?
    let repeatMonthDay: Int?

    var rule: RepeatRule {
        RepeatRule(frequency: repeatFrequency, days: repeatDays, monthDay: repeatMonthDay)
    }
}

private struct ShowCase: Decodable, Sendable {
    let name: String
    let rule: FixtureRule
    let day: String
    let expected: Bool
}

private struct AnchoredCase: Decodable, Sendable {
    let name: String
    let rule: FixtureRule
    let start: String
    let day: String
    let expected: Bool
}

private struct FirstCase: Decodable, Sendable {
    let name: String
    let rule: FixtureRule
    let from: String
    let expected: String
}

private struct DatesCase: Decodable, Sendable {
    let name: String
    let dates: [String]?
    let day: String
    let expected: Bool
}

private struct RecurringCase: Decodable, Sendable {
    let name: String
    let rule: FixtureRule
    let expected: Bool
}

private struct Fixture: Decodable, Sendable {
    let shouldShowOnDate: [ShowCase]
    let anchoredSeriesOn: [AnchoredCase]
    let firstRepeatDayFrom: [FirstCase]
    let isCompletedOnDate: [DatesCase]
    let isSkippedOnDate: [DatesCase]
    let isRecurring: [RecurringCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root, the first directory that
/// holds the fixture. The whole repo is checked out in both CI jobs (the Linux
/// container and the macOS runner), and locally too.
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/recurrence/cases.json"
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

@Suite struct RecurrenceFixtureTests {
    @Test func everyFunctionHasCases() throws {
        let f = try loadFixture()
        #expect(!f.shouldShowOnDate.isEmpty)
        #expect(!f.anchoredSeriesOn.isEmpty)
        #expect(!f.firstRepeatDayFrom.isEmpty)
        #expect(!f.isCompletedOnDate.isEmpty)
        #expect(!f.isSkippedOnDate.isEmpty)
        #expect(!f.isRecurring.isEmpty)
    }

    @Test func shouldShowOnDateMatchesTheWeb() throws {
        for c in try loadFixture().shouldShowOnDate {
            let day = try #require(DayString(c.day), "\(c.name): bad day \(c.day)")
            #expect(shouldShowOnDate(c.rule.rule, on: day) == c.expected, "\(c.name)")
        }
    }

    @Test func anchoredSeriesOnMatchesTheWeb() throws {
        for c in try loadFixture().anchoredSeriesOn {
            let start = try #require(DayString(c.start), "\(c.name): bad start \(c.start)")
            let day = try #require(DayString(c.day), "\(c.name): bad day \(c.day)")
            #expect(anchoredSeriesOn(c.rule.rule, start: start, on: day) == c.expected, "\(c.name)")
        }
    }

    @Test func firstRepeatDayFromMatchesTheWeb() throws {
        for c in try loadFixture().firstRepeatDayFrom {
            let from = try #require(DayString(c.from), "\(c.name): bad from \(c.from)")
            #expect(firstRepeatDayFrom(c.rule.rule, from: from).description == c.expected, "\(c.name)")
        }
    }

    @Test func isCompletedOnDateMatchesTheWeb() throws {
        for c in try loadFixture().isCompletedOnDate {
            let day = try #require(DayString(c.day), "\(c.name): bad day \(c.day)")
            #expect(isCompletedOnDate(c.dates, day) == c.expected, "\(c.name)")
        }
    }

    @Test func isSkippedOnDateMatchesTheWeb() throws {
        for c in try loadFixture().isSkippedOnDate {
            let day = try #require(DayString(c.day), "\(c.name): bad day \(c.day)")
            #expect(isSkippedOnDate(c.dates, day) == c.expected, "\(c.name)")
        }
    }

    @Test func isRecurringMatchesTheWeb() throws {
        for c in try loadFixture().isRecurring {
            #expect(isRecurring(c.rule.rule) == c.expected, "\(c.name)")
        }
    }
}
