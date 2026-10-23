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

private struct NextCase: Decodable, Sendable {
    let name: String
    let goal: Goal
    let expected: String?
}

private struct StateCase: Decodable, Sendable {
    let name: String
    let item: Item
    let isNext: Bool
    let today: String
    let expected: String
}

private struct TimelineRowJSON: Decodable, Sendable {
    let itemId: String
    let state: String
    let date: String?
    let late: Bool
    let dateLabel: String
    let annotations: [String]
}

private struct TimelineCase: Decodable, Sendable {
    let name: String
    let goal: Goal
    let today: String
    let expected: [TimelineRowJSON]
}

private struct ElapsedExpected: Decodable, Sendable {
    let fraction: Double?
    let label: String?
}

private struct ElapsedCase: Decodable, Sendable {
    let name: String
    let goal: Goal
    let today: String
    let expected: ElapsedExpected
}

private struct CountdownCase: Decodable, Sendable {
    let name: String
    let goal: Goal
    let today: String
    let expected: String?
}

private struct WindDownCase: Decodable, Sendable {
    let name: String
    let goal: Goal
    let expected: [String]
}

private struct GroupJSON: Decodable, Sendable {
    let typeName: String
    let labelPlural: String
    let ids: [String]
}

private struct GroupsCase: Decodable, Sendable {
    let name: String
    let ids: [String]
    let expected: [GroupJSON]
}

private struct LastDoneCase: Decodable, Sendable {
    let name: String
    let item: Item
    let expected: String?
}

private struct GoalsFixture: Decodable, Sendable {
    let world: GoalsWorld
    let goalProgress: [ProgressCase]
    let progressLabel: [LabelCase]
    let isGoalActive: [ActiveCase]
    let sortGoalsForDisplay: [SortCase]
    let nextMilestone: [NextCase]
    let milestoneState: [StateCase]
    let milestoneTimeline: [TimelineCase]
    let timeElapsed: [ElapsedCase]
    let goalCountdown: [CountdownCase]
    let windDownMembers: [WindDownCase]
    let goalMemberGroups: [GroupsCase]
    let lastDoneOn: [LastDoneCase]
}

private func ids(_ items: [Item]) -> [String] {
    return items.map { $0.id.uuidString.lowercased() }
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
        #expect(!f.nextMilestone.isEmpty)
        #expect(!f.milestoneState.isEmpty)
        #expect(!f.milestoneTimeline.isEmpty)
        #expect(!f.timeElapsed.isEmpty)
        #expect(!f.goalCountdown.isEmpty)
        #expect(!f.windDownMembers.isEmpty)
        #expect(!f.goalMemberGroups.isEmpty)
        #expect(!f.lastDoneOn.isEmpty)
        // Every state is some case's answer.
        #expect(Set(f.milestoneState.map(\.expected)) == Set(MilestoneState.allCases.map(\.rawValue)))
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

    @Test func nextMilestoneMatchesTheWeb() throws {
        let f = try load()
        let byId = Dictionary(f.world.items.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        for c in f.nextMilestone {
            let got = nextMilestone(c.goal, itemsById: byId)
            #expect(got?.id.uuidString.lowercased() == c.expected, "\(c.name)")
        }
    }

    @Test func milestoneStateMatchesTheWeb() throws {
        for c in try load().milestoneState {
            let today = try #require(DayString(c.today), "\(c.name): bad today")
            #expect(milestoneState(c.item, isNext: c.isNext, today: today).rawValue == c.expected, "\(c.name)")
        }
    }

    @Test func milestoneTimelineMatchesTheWeb() throws {
        let f = try load()
        let byId = Dictionary(f.world.items.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        for c in f.milestoneTimeline {
            let today = try #require(DayString(c.today), "\(c.name): bad today")
            let rows = milestoneTimeline(c.goal, itemsById: byId, today: today)
            #expect(ids(rows.map(\.item)) == c.expected.map(\.itemId), "\(c.name): order")
            for (got, want) in zip(rows, c.expected) {
                let at = "\(c.name) \(want.itemId)"
                #expect(got.state.rawValue == want.state, "\(at): state")
                #expect(got.date == want.date, "\(at): date")
                #expect(got.late == want.late, "\(at): late")
                #expect(got.dateLabel == want.dateLabel, "\(at): dateLabel")
                #expect(got.annotations == want.annotations, "\(at): annotations")
            }
        }
    }

    @Test func timeElapsedMatchesTheWeb() throws {
        for c in try load().timeElapsed {
            let today = try #require(DayString(c.today), "\(c.name): bad today")
            // The same IEEE division as JavaScript's, so equal exactly.
            #expect(timeElapsed(c.goal, today: today) == c.expected.fraction, "\(c.name): fraction")
            #expect(timeElapsedLabel(c.goal, today: today) == c.expected.label, "\(c.name): label")
        }
    }

    @Test func goalCountdownMatchesTheWeb() throws {
        for c in try load().goalCountdown {
            let today = try #require(DayString(c.today), "\(c.name): bad today")
            #expect(goalCountdown(c.goal, today: today) == c.expected, "\(c.name)")
        }
    }

    /// Where the web would print NaN (a day `Date.parse` cannot read), the
    /// phone says nothing; and V8's roll-over of an overlong day is kept.
    @Test func anUnreadableDayIsNoDay() throws {
        let today = try #require(DayString("2026-10-23"))
        let bad = Goal(id: "g", name: "G", startsOn: "2026-10-01", targetOn: "2026-11-0x")
        #expect(goalCountdown(bad, today: today) == nil)
        #expect(timeElapsed(bad, today: today) == nil)
        #expect(timeElapsedLabel(bad, today: today) == nil)
        // "2026-02-30" is Mar 2 to V8: 130 days from Oct 23, 2026 to Mar 2, 2027.
        let rolled = Goal(id: "g", name: "G", targetOn: "2027-02-30")
        #expect(goalCountdown(rolled, today: today) == "130 days to Feb 30")
    }

    @Test func windDownMembersMatchesTheWeb() throws {
        let f = try load()
        let byId = Dictionary(f.world.items.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        for c in f.windDownMembers {
            #expect(ids(windDownMembers(c.goal, itemsById: byId)) == c.expected, "\(c.name)")
        }
    }

    @Test func goalMemberGroupsMatchesTheWeb() throws {
        let f = try load()
        let byId = Dictionary(f.world.items.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        for c in f.goalMemberGroups {
            let members = try #require(organizeUUIDs(c.ids), "\(c.name): an id is not a uuid")
            let got = goalMemberGroups(members, itemsById: byId)
            #expect(got.map(\.typeName) == c.expected.map(\.typeName), "\(c.name): types")
            #expect(got.map { typeLabelPlural($0.typeName) } == c.expected.map(\.labelPlural), "\(c.name): headings")
            #expect(got.map { ids($0.items) } == c.expected.map(\.ids), "\(c.name): members")
        }
    }

    /// A custom type's plural follows its own row when the payload names it,
    /// and the built-ins ignore the rows.
    @Test func typeLabelPluralReadsTheRows() {
        let rows = [
            "book": ItemTypeLabel(name: "book", label: "Novel", labelPlural: "Novels"),
            "quest": ItemTypeLabel(name: "quest", label: "Side quest", labelPlural: ""),
            "task": ItemTypeLabel(name: "task", label: "Chore", labelPlural: "Chores"),
        ]
        #expect(typeLabelPlural("book", labels: rows) == "Novels")
        #expect(typeLabelPlural("quest", labels: rows) == "Side quests")
        #expect(typeLabelPlural("task", labels: rows) == "Tasks")
        #expect(typeLabelPlural("habit") == "Habits")
        #expect(typeLabelPlural("errand") == "Errands")
    }

    @Test func lastDoneOnMatchesTheWeb() throws {
        for c in try load().lastDoneOn {
            #expect(lastDoneOn(c.item) == c.expected, "\(c.name)")
        }
    }
}
