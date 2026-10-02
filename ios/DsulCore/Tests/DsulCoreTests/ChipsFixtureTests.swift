import Foundation
import Testing
import DsulCore

// The web's own answers for the item sheet's chip words, checked against
// Cadence.swift: lib/item-bands.ts `membershipSummary`, lib/reminders/copy.ts
// `formatCueTime` (12h and 24h) and lib/active.ts `formatDay`.
// tests/unit/day-fixtures.test.ts runs every case through the real TS and
// commits the results to tests/fixtures/day/chips.json. Never edit the JSON by
// hand: regenerate it from the Vitest side (UPDATE_FIXTURES=1).

private struct SummaryCase: Decodable, Sendable {
    let name: String
    let names: [String]
    let expected: String?
}

private struct CueTimeCase: Decodable, Sendable {
    let name: String
    let hhmm: String
    let timeFormat: String
    let expected: String
}

private struct DayCase: Decodable, Sendable {
    let name: String
    let dateStr: String
    let expected: String
}

private struct Fixture: Decodable, Sendable {
    let membershipSummary: [SummaryCase]
    let formatCueTime: [CueTimeCase]
    let formatDay: [DayCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/chips.json"
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

@Suite struct ChipsFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try loadFixture()
        #expect(f.membershipSummary.contains { $0.expected == nil })
        #expect(f.formatCueTime.contains { $0.timeFormat == "12h" })
        #expect(f.formatCueTime.contains { $0.timeFormat == "24h" })
        #expect(!f.formatDay.isEmpty)
    }

    @Test func membershipSummaryMatchesTheWeb() throws {
        for c in try loadFixture().membershipSummary {
            #expect(membershipSummary(c.names) == c.expected, "\(c.name)")
        }
    }

    @Test func formatCueTimeMatchesTheWeb() throws {
        for c in try loadFixture().formatCueTime {
            let format = try #require(TimeFormat(rawValue: c.timeFormat), "\(c.name): unknown format \(c.timeFormat)")
            #expect(formatCueTime(c.hhmm, timeFormat: format) == c.expected, "\(c.name)")
        }
    }

    @Test func formatDayMatchesTheWeb() throws {
        for c in try loadFixture().formatDay {
            #expect(formatDay(c.dateStr) == c.expected, "\(c.name)")
        }
    }

    @Test func twelveHourIsTheDefault() {
        #expect(formatCueTime("18:05") == "6:05 pm")
    }
}
