import Foundation
import Testing
import DsulCore

// The web's own answers for lib/row-moves.ts, checked against RowMoves.swift.
// tests/unit/day-fixtures.test.ts runs every case through the real TS and
// commits the results to tests/fixtures/day/row-moves.json. Never edit the
// JSON by hand: regenerate it from the Vitest side (UPDATE_FIXTURES=1).

private struct TargetCase: Decodable, Sendable {
    let name: String
    let rowDateStr: String
    let todayStr: String
    let expected: String
}

private struct LabelCase: Decodable, Sendable {
    let name: String
    let target: String
    let todayStr: String
    let expected: String
}

private struct DayCase: Decodable, Sendable {
    let name: String
    let dateStr: String
    let expected: String
}

private struct MoveCase: Decodable, Sendable {
    let name: String
    let item: Item
    let kind: String
    let dateStr: String
    let expected: Bool
}

private struct Fixture: Decodable, Sendable {
    let nextDayTarget: [TargetCase]
    let nextDayLabel: [LabelCase]
    let formatTargetDay: [DayCase]
    let canMoveToNextDay: [MoveCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/row-moves.json"
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

@Suite struct RowMovesFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try loadFixture()
        #expect(!f.nextDayTarget.isEmpty)
        #expect(!f.nextDayLabel.isEmpty)
        #expect(!f.formatTargetDay.isEmpty)
        #expect(f.canMoveToNextDay.contains { $0.expected })
        #expect(f.canMoveToNextDay.contains { !$0.expected })
    }

    @Test func nextDayTargetMatchesTheWeb() throws {
        for c in try loadFixture().nextDayTarget {
            #expect(nextDayTarget(c.rowDateStr, today: c.todayStr) == c.expected, "\(c.name)")
        }
    }

    @Test func nextDayLabelMatchesTheWeb() throws {
        for c in try loadFixture().nextDayLabel {
            #expect(nextDayLabel(c.target, today: c.todayStr) == c.expected, "\(c.name)")
        }
    }

    @Test func formatTargetDayMatchesTheWeb() throws {
        for c in try loadFixture().formatTargetDay {
            #expect(formatTargetDay(c.dateStr) == c.expected, "\(c.name)")
        }
    }

    @Test func canMoveToNextDayMatchesTheWeb() throws {
        for c in try loadFixture().canMoveToNextDay {
            let kind = try #require(ItemKind(rawValue: c.kind), "\(c.name): unknown kind \(c.kind)")
            #expect(canMoveToNextDay(c.item, kind: kind, dateStr: c.dateStr) == c.expected, "\(c.name)")
        }
    }

    /// Where the web would throw on a string that isn't a day, the port answers.
    @Test func aStringThatIsNotADayDoesNotTrap() {
        #expect(formatTargetDay("someday") == "Invalid Date")
        #expect(nextDayTarget("someday", today: "") == "someday")
    }
}
