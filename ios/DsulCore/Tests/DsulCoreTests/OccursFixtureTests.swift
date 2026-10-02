import Foundation
import Testing
import DsulCore

// The web's own answers for lib/reminders/due.ts `occursOn` and
// lib/item-verbs.ts `occurrenceOn`, checked against ItemVerbs.swift: does the
// item fall on the day, and what the item sheet then knows about it there.
// tests/unit/day-fixtures.test.ts runs every case through the real TS and
// commits the results to tests/fixtures/day/occurs.json. Never edit the JSON
// by hand: regenerate it from the Vitest side (UPDATE_FIXTURES=1).

private struct OccursCase: Decodable, Sendable {
    let name: String
    let item: Item
    let dateStr: String
    let todayStr: String
    let timeZone: String
    let occursOn: Bool
    /// An occurrence, "absent", or null for a one-off.
    let occurrence: String?
}

private struct Fixture: Decodable, Sendable {
    let cases: [OccursCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/occurs.json"
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

@Suite struct OccursFixtureTests {
    @Test func hasCasesForEveryAnswer() throws {
        let cases = try loadFixture().cases
        #expect(cases.contains { $0.occursOn })
        #expect(cases.contains { !$0.occursOn })
        #expect(cases.contains { $0.occurrence == nil })
        for state in Occurrence.allCases {
            #expect(cases.contains { $0.occurrence == state.rawValue }, "\(state.rawValue)")
        }
    }

    @Test func occursOnMatchesTheWeb() throws {
        for c in try loadFixture().cases {
            #expect(occursOn(c.item, on: c.dateStr, timeZone: c.timeZone) == c.occursOn, "\(c.name)")
        }
    }

    @Test func occurrenceOnMatchesTheWeb() throws {
        for c in try loadFixture().cases {
            let got = occurrenceOn(c.item, on: c.dateStr, today: c.todayStr, timeZone: c.timeZone)
            #expect(got?.rawValue == c.occurrence, "\(c.name)")
        }
    }

    /// `occurrenceOn` is `drawnState` wherever the item falls on the day.
    @Test func aDayTheItemFallsOnIsItsDrawnState() throws {
        for c in try loadFixture().cases where c.occursOn {
            let drawn = drawnState(c.item, on: c.dateStr, today: c.todayStr)
            #expect(occurrenceOn(c.item, on: c.dateStr, today: c.todayStr, timeZone: c.timeZone) == drawn, "\(c.name)")
        }
    }
}
