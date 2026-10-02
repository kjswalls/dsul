import Foundation
import Testing
import DsulCore

// The web's own answers for lib/item-registry.ts, checked against
// Registry.swift. tests/unit/day-fixtures.test.ts reads each type's config
// (task, habit, and custom slugs the registry builds from its template) and
// the item-level predicates through the real TS, and writes them to
// tests/fixtures/day/caps.json. Never edit the JSON by hand: regenerate it from
// the Vitest side (UPDATE_FIXTURES=1).

private struct TypeCase: Decodable, Sendable {
    let name: String
    let label: String
    let doneStatus: String
    let skipStatus: String?
    let defaultFrequency: String
    let defaultBlockMinutes: Int
    let dateAnchored: Bool
    let dateAddressable: Bool
    let skippable: Bool
    let pausable: Bool
    let remindable: Bool
    let collectible: Bool
    let braindumpEligible: Bool
    let subtasks: Bool
    let streakCounter: Bool
    let dailyCounts: Bool
    let hasPriority: Bool
}

private struct ItemCase: Decodable, Sendable {
    let name: String
    let item: Item
    let isSkippable: Bool
    let isPausable: Bool
    let isRemindable: Bool
    let isCollectible: Bool
}

private struct Fixture: Decodable, Sendable {
    let types: [TypeCase]
    let items: [ItemCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/caps.json"
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

@Suite struct RegistryCapsFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try loadFixture()
        #expect(f.types.contains { $0.name == "task" })
        #expect(f.types.contains { $0.name == "habit" })
        #expect(f.types.count > 2)
        #expect(!f.items.isEmpty)
    }

    @Test func eachTypeAnswersAsTheRegistryDoes() throws {
        for t in try loadFixture().types {
            let c = caps(t.name)
            #expect(c.label == t.label, "\(t.name): label")
            #expect(typeLabel(t.name) == t.label, "\(t.name): typeLabel")
            #expect(c.doneStatus == t.doneStatus, "\(t.name): doneStatus")
            #expect(c.skipStatus == t.skipStatus, "\(t.name): skipStatus")
            #expect(c.defaultFrequency == t.defaultFrequency, "\(t.name): defaultFrequency")
            #expect(c.defaultBlockMinutes == t.defaultBlockMinutes, "\(t.name): defaultBlockMinutes")
            #expect(c.dateAnchored == t.dateAnchored, "\(t.name): dateAnchored")
            #expect(c.dateAddressable == t.dateAddressable, "\(t.name): dateAddressable")
            #expect(c.skippable == t.skippable, "\(t.name): skippable")
            #expect(c.pausable == t.pausable, "\(t.name): pausable")
            #expect(c.remindable == t.remindable, "\(t.name): remindable")
            #expect(c.collectible == t.collectible, "\(t.name): collectible")
            #expect(c.braindumpEligible == t.braindumpEligible, "\(t.name): braindumpEligible")
            #expect(c.subtasks == t.subtasks, "\(t.name): subtasks")
            #expect(c.streakCounter == t.streakCounter, "\(t.name): streakCounter")
            #expect(c.dailyCounts == t.dailyCounts, "\(t.name): dailyCounts")
            #expect(c.hasPriority == t.hasPriority, "\(t.name): hasPriority")
        }
    }

    @Test func theItemPredicatesMatchTheWeb() throws {
        for c in try loadFixture().items {
            #expect(isSkippable(c.item) == c.isSkippable, "\(c.name): isSkippable")
            #expect(isPausable(c.item) == c.isPausable, "\(c.name): isPausable")
            #expect(isRemindable(c.item) == c.isRemindable, "\(c.name): isRemindable")
            #expect(isCollectible(c.item) == c.isCollectible, "\(c.name): isCollectible")
        }
    }

    /// A custom label capitalises the first letter and nothing else, where
    /// Foundation's `capitalized` would touch every word.
    @Test func aCustomLabelIsTheSlugWithItsFirstLetterUp() {
        #expect(typeLabel("side-quest") == "Side-quest")
        #expect(typeLabel("book_club") == "Book_club")
        #expect(typeLabel("") == "")
        #expect(caps("errand").label == "Errand")
        #expect(ItemCaps.custom.label == "Custom")
    }
}
