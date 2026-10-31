import Foundation
import Testing
import DsulCore

// The web's own answers for lib/overdue.ts and lib/ghost-rows.ts, checked
// against Overdue.swift and GhostRows.swift. tests/unit/day-fixtures.test.ts
// runs `selectOverdue`, `selectGhostRows`, `daysOverdue`, `ghostWeekday` and
// `ghostFoldStartsCollapsed` through the real TS and writes
// tests/fixtures/day/ghost-rows.json. Never edit the JSON by hand: regenerate
// it from the Vitest side (UPDATE_FIXTURES=1).

private struct GhostDay: Decodable, Sendable {
    let name: String
    let today: String
    let inactiveIds: [UUID]
    let milestoneIds: [UUID]
    let overdue: [UUID]
    let ghosts: [UUID]
    let daysOverdue: [String: Int]
}

private struct GhostWorld: Decodable, Sendable {
    let name: String
    let items: [Item]
    let days: [GhostDay]
}

private struct VerbCase: Decodable, Sendable {
    let name: String
    let item: Item
    let milestoneIds: [UUID]
    /// Each `GhostVerb`'s raw value to the fold's answer.
    let expected: [String: Bool]
}

private struct WeekdayCase: Decodable, Sendable {
    let name: String
    let date: String
    let expected: String
}

private struct CollapsedCase: Decodable, Sendable {
    let name: String
    let count: Int
    let expected: Bool
}

private struct Fixture: Decodable, Sendable {
    let threshold: Int
    let worlds: [GhostWorld]
    let verbs: [VerbCase]
    let weekdays: [WeekdayCase]
    let collapsed: [CollapsedCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/ghost-rows.json"
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

@Suite struct GhostRowsFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try loadFixture()
        #expect(!f.worlds.isEmpty)
        #expect(f.worlds.allSatisfy { !$0.days.isEmpty })
        #expect(f.worlds.flatMap(\.days).contains { !$0.ghosts.isEmpty })
        #expect(!f.weekdays.isEmpty)
        #expect(!f.collapsed.isEmpty)
    }

    @Test func theThresholdIsTheWebs() throws {
        #expect(ghostPileThreshold == (try loadFixture()).threshold)
    }

    @Test func overdueMatchesTheWeb() throws {
        for world in try loadFixture().worlds {
            for day in world.days {
                let got = selectOverdue(world.items, today: day.today, inactiveIds: Set(day.inactiveIds))
                #expect(got.map(\.id) == day.overdue, "\(world.name) / \(day.name)")
            }
        }
    }

    @Test func ghostsMatchTheWeb() throws {
        for world in try loadFixture().worlds {
            for day in world.days {
                let got = selectGhostRows(world.items, today: day.today, inactiveIds: Set(day.inactiveIds),
                                          milestoneIds: Set(day.milestoneIds))
                #expect(got.map(\.id) == day.ghosts, "\(world.name) / \(day.name)")
            }
        }
    }

    @Test func daysOverdueMatchesTheWeb() throws {
        for world in try loadFixture().worlds {
            for day in world.days {
                for item in world.items {
                    let key = item.id.uuidString.lowercased()
                    #expect(daysOverdue(item, today: day.today) == day.daysOverdue[key],
                            "\(world.name) / \(day.name) / \(item.title)")
                }
            }
        }
    }

    @Test func eachVerbIsGatedAsTheFoldGatesIt() throws {
        let cases = try loadFixture().verbs
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(Set(c.expected.keys) == Set(GhostVerb.allCases.map(\.rawValue)), "\(c.name): every verb")
            for verb in GhostVerb.allCases {
                #expect(ghostVerbAllowed(verb, c.item, milestoneIds: Set(c.milestoneIds)) == c.expected[verb.rawValue],
                        "\(c.name): \(verb.rawValue)")
            }
        }
    }

    @Test func weekdaysMatchTheWeb() throws {
        for c in try loadFixture().weekdays {
            #expect(ghostWeekday(c.date) == c.expected, "\(c.name)")
        }
    }

    @Test func theFoldStartsCollapsedAsTheWebsDoes() throws {
        for c in try loadFixture().collapsed {
            #expect(ghostFoldStartsCollapsed(c.count) == c.expected, "\(c.name)")
        }
    }

    /// No ghost carries a date that names no day, but the weekday must not
    /// trap on one.
    @Test func aDateThatNamesNoDayHasNoWeekday() {
        #expect(ghostWeekday("") == "")
        #expect(ghostWeekday("soon") == "")
    }

    /// Let it go takes what `letGoItems` takes: a pending one-off of a type
    /// with a cancelled status. It writes the status and nothing else.
    @Test func lettingGoIsTheStoresPatch() {
        let id = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
        let open = Item(id: id, title: "Call the bank", status: "pending", startDate: "2026-10-13")
        let gone = lettingGo(open)
        #expect(canLetGo(open))
        #expect(gone.status == "cancelled")
        var rest = gone
        rest.status = "pending"
        #expect(rest == open)

        let errand = Item(id: id, type: "custom", customType: "errand", title: "Stamps", status: "pending")
        #expect(canLetGo(errand))
        var weekly = open
        weekly.repeatFrequency = "weekly"
        var none = open
        none.repeatFrequency = "none"
        #expect(canLetGo(none))
        var done = open
        done.status = "completed"
        let habit = Item(id: id, type: "habit", title: "Meds", status: "pending")
        for refused in [weekly, done, gone, habit] {
            #expect(!canLetGo(refused), "\(refused.title) \(refused.status ?? "nil")")
            #expect(lettingGo(refused) == refused)
        }
    }
}
