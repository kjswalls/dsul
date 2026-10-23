import Foundation
import Testing
import DsulCore

// The web's own answers for lib/goals.ts, checked against Goals.swift:
// tests/fixtures/organize/goals.json.

private struct GoalsWorld: Decodable, Sendable {
    let items: [Item]
}

private struct ProgressExpected: Decodable, Sendable {
    let achieved: Int
    let total: Int
    let fraction: Double?
    let label: String
}

private struct ProgressCase: Decodable, Sendable {
    let name: String
    let goal: Goal
    let expected: ProgressExpected
}

private struct LabelCase: Decodable, Sendable {
    let name: String
    let goal: Goal
    let achieved: Int
    let total: Int
    let expected: String
}

private struct ActiveCase: Decodable, Sendable {
    let name: String
    let goal: Goal
    let expected: Bool
}

private struct SortCase: Decodable, Sendable {
    let name: String
    let goals: [Goal]
    let expected: [String]
}

private struct GoalsFixture: Decodable, Sendable {
    let world: GoalsWorld
    let goalProgress: [ProgressCase]
    let progressLabel: [LabelCase]
    let isGoalActive: [ActiveCase]
    let sortGoalsForDisplay: [SortCase]
}

private func load() throws -> GoalsFixture {
    return try loadOrganizeFixture(GoalsFixture.self, "goals.json")
}

@Suite struct GoalsFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try load()
        #expect(!f.world.items.isEmpty)
        #expect(!f.goalProgress.isEmpty)
        #expect(!f.progressLabel.isEmpty)
        #expect(!f.isGoalActive.isEmpty)
        #expect(!f.sortGoalsForDisplay.isEmpty)
    }

    @Test func goalProgressMatchesTheWeb() throws {
        let f = try load()
        let byId = Dictionary(f.world.items.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        for c in f.goalProgress {
            let got = goalProgress(c.goal, itemsById: byId)
            #expect(got.achieved == c.expected.achieved, "\(c.name): achieved")
            #expect(got.total == c.expected.total, "\(c.name): total")
            // The same IEEE division as JavaScript's, so equal exactly.
            #expect(got.fraction == c.expected.fraction, "\(c.name): fraction \(String(describing: got.fraction))")
            #expect(progressLabel(c.goal, got) == c.expected.label, "\(c.name): label")
            // The list overload indexes the same way.
            #expect(goalProgress(c.goal, items: f.world.items) == got, "\(c.name): over items")
        }
    }

    @Test func progressLabelMatchesTheWeb() throws {
        for c in try load().progressLabel {
            #expect(progressLabel(c.goal, achieved: c.achieved, total: c.total) == c.expected, "\(c.name)")
        }
    }

    @Test func isGoalActiveMatchesTheWeb() throws {
        for c in try load().isGoalActive {
            #expect(isGoalActive(c.goal) == c.expected, "\(c.name)")
        }
    }

    @Test func sortGoalsForDisplayMatchesTheWeb() throws {
        for c in try load().sortGoalsForDisplay {
            #expect(sortGoalsForDisplay(c.goals).map(\.id) == c.expected, "\(c.name)")
        }
    }

    /// A custom type's done word is the registry's: "completed" counts and
    /// "done" does not.
    @Test func doneIsTheTypesOwnStatus() throws {
        let items = try load().world.items
        let dune = try #require(items.first { $0.title == "Read Dune" })
        let neruda = try #require(items.first { $0.title == "Read Neruda" })
        #expect(isAchieved(dune))
        #expect(!isAchieved(neruda))
    }
}
