import Foundation
import Testing
import DsulCore

// The web's own answers for lib/container-schedule.ts, checked against
// ContainerSchedule.swift: tests/fixtures/organize/schedule.json. O1 pins
// `containerMemberIds`; the rollups come with O2.

private struct ScheduleWorld: Decodable, Sendable {
    let items: [Item]
    let routines: [Routine]
}

/// lib/container-schedule.ts `ScheduleContainer`, as the JSON writes it:
/// `{kind, <kind>: {...}}`.
private struct ContainerJSON: Decodable, Sendable {
    let container: ScheduleContainer

    enum CodingKeys: String, CodingKey {
        case kind, routine, season, goal, project
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "routine": container = .routine(try c.decode(Routine.self, forKey: .routine))
        case "season": container = .season(try c.decode(Season.self, forKey: .season))
        case "goal": container = .goal(try c.decode(Goal.self, forKey: .goal))
        case "project": container = .project(try c.decode(Project.self, forKey: .project))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown kind \(other)")
        }
    }
}

private struct MembersCase: Decodable, Sendable {
    let name: String
    let container: ContainerJSON
    let expected: [String]
    /// Project cases only: `expected` less subtasks, the count Organize's
    /// project row says ("N items").
    let listed: [String]?
}

private struct ScheduleFixture: Decodable, Sendable {
    let world: ScheduleWorld
    let containerMemberIds: [MembersCase]
}

private func load() throws -> ScheduleFixture {
    return try loadOrganizeFixture(ScheduleFixture.self, "schedule.json")
}

@Suite struct ScheduleFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try load()
        #expect(!f.world.items.isEmpty)
        #expect(!f.world.routines.isEmpty)
        #expect(!f.containerMemberIds.isEmpty)
        // Every kind is covered.
        let kinds = Set(f.containerMemberIds.map(\.container.container.kind))
        #expect(kinds == Set(OrganizeKind.allCases))
    }

    @Test func containerMemberIdsMatchesTheWeb() throws {
        let f = try load()
        for c in f.containerMemberIds {
            let expected = try #require(organizeUUIDs(c.expected), "\(c.name): an expected id is not a uuid")
            let got = containerMemberIds(c.container.container, items: f.world.items, routines: f.world.routines)
            #expect(got == expected, "\(c.name): \(got.map { $0.uuidString.lowercased() })")
        }
    }

    /// The project count leaves subtasks out (design §2 Q11): the rule is
    /// the console list's, restated here as the fixture's writer restates it,
    /// so the `listed` column is the members whose item has no parent.
    @Test func aProjectsListLeavesSubtasksOut() throws {
        let f = try load()
        let byId = Dictionary(f.world.items.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        var sawSubtask = false
        for c in f.containerMemberIds where c.container.container.kind == .project {
            let listed = try #require(c.listed.flatMap(organizeUUIDs), "\(c.name): no listed ids")
            let members = containerMemberIds(c.container.container, items: f.world.items, routines: f.world.routines)
            // `!parentItemId` on the web: an empty parent id is no parent.
            let topLevel = members.filter { (byId[$0]?.parentItemId ?? "").isEmpty }
            #expect(topLevel == listed, "\(c.name)")
            if topLevel.count < members.count { sawSubtask = true }
        }
        #expect(sawSubtask)
    }
}
