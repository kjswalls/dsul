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

/// A `canSendToBraindump` row: a carry row plus the milestone ids the gate
/// was handed (sorted; empty for the rows shared with `canMoveToNextDay`).
private struct BraindumpCase: Decodable, Sendable {
    let name: String
    let item: Item
    let kind: String
    let dateStr: String
    let milestoneIds: [String]
    let expected: Bool
}

private struct Fixture: Decodable, Sendable {
    let nextDayTarget: [TargetCase]
    let nextDayLabel: [LabelCase]
    let formatTargetDay: [DayCase]
    let canMoveToNextDay: [MoveCase]
    let canReschedule: [MoveCase]
    let canSendToBraindump: [BraindumpCase]
}

/// The case's milestone ids as the gate takes them; every one must be a uuid.
private func milestones(_ c: BraindumpCase) throws -> Set<UUID> {
    var ids = Set<UUID>()
    for raw in c.milestoneIds {
        ids.insert(try #require(UUID(uuidString: raw), "\(c.name): \(raw) is not a uuid"))
    }
    return ids
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
        #expect(f.canReschedule.contains { $0.expected })
        #expect(f.canReschedule.contains { !$0.expected })
        #expect(f.canSendToBraindump.contains { $0.expected })
        #expect(f.canSendToBraindump.contains { !$0.expected })
        // A refused milestone, and a row another item's milestone doesn't touch.
        #expect(f.canSendToBraindump.contains { c in
            !c.expected && c.milestoneIds.contains { UUID(uuidString: $0) == c.item.id }
        })
        #expect(f.canSendToBraindump.contains { c in
            c.expected && !c.milestoneIds.isEmpty && !c.milestoneIds.contains { UUID(uuidString: $0) == c.item.id }
        })
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

    @Test func canRescheduleMatchesTheWeb() throws {
        for c in try loadFixture().canReschedule {
            let kind = try #require(ItemKind(rawValue: c.kind), "\(c.name): unknown kind \(c.kind)")
            #expect(canReschedule(c.item, kind: kind, dateStr: c.dateStr) == c.expected, "\(c.name)")
        }
    }

    @Test func canSendToBraindumpMatchesTheWeb() throws {
        for c in try loadFixture().canSendToBraindump {
            let kind = try #require(ItemKind(rawValue: c.kind), "\(c.name): unknown kind \(c.kind)")
            let ids = try milestones(c)
            #expect(canSendToBraindump(c.item, kind: kind, dateStr: c.dateStr, milestoneIds: ids) == c.expected, "\(c.name)")
        }
    }

    /// Only the row's own id in the set decides: another item's milestone
    /// changes nothing, and a row that is one is always refused.
    @Test func onlyTheRowsOwnMilestoneCounts() throws {
        for c in try loadFixture().canSendToBraindump {
            let kind = try #require(ItemKind(rawValue: c.kind), "\(c.name): unknown kind \(c.kind)")
            let ids = try milestones(c)
            let own: Set<UUID> = ids.contains(c.item.id) ? [c.item.id] : []
            #expect(canSendToBraindump(c.item, kind: kind, dateStr: c.dateStr, milestoneIds: own) == c.expected, "\(c.name)")
            if !own.isEmpty { #expect(!c.expected, "\(c.name): a milestone stays on its day") }
        }
    }

    /// The projection the row came from is asked first, as on the web: a
    /// custom item read off the habit list is refused every move, though its
    /// own slug would allow each.
    @Test func aRowAskedAboutAsAHabitIsRefused() {
        let errand = Item(
            id: UUID(uuidString: "00000000-0000-4000-8000-0000000002be")!, type: "custom", customType: "errand",
            title: "post office", status: "pending", startDate: "2026-10-02", isScheduled: true
        )
        #expect(canSendToBraindump(errand, kind: .task, dateStr: "2026-10-02", milestoneIds: []))
        #expect(!canSendToBraindump(errand, kind: .habit, dateStr: "2026-10-02", milestoneIds: []))
        #expect(!canMoveToNextDay(errand, kind: .habit, dateStr: "2026-10-02"))
        #expect(!canReschedule(errand, kind: .habit, dateStr: "2026-10-02"))
    }

    /// Where the web would throw on a string that isn't a day, the port answers.
    @Test func aStringThatIsNotADayDoesNotTrap() {
        #expect(formatTargetDay("someday") == "Invalid Date")
        #expect(nextDayTarget("someday", today: "") == "someday")
    }
}
