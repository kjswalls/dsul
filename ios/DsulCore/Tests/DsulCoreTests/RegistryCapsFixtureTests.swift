import Foundation
import Testing
import DsulCore

// The web's own answers for lib/item-registry.ts, checked against
// Registry.swift. tests/unit/day-fixtures.test.ts reads each type's config
// (task, habit, and custom slugs the registry builds from its template), a
// custom type hydrated from an item_types def (`buildCustomTypeConfig`), and
// the item-level predicates through the real TS, and writes them to
// tests/fixtures/day/caps.json. Never edit the JSON by hand: regenerate it from
// the Vitest side (UPDATE_FIXTURES=1).

/// `form.deleteDescription(title)` for one title.
private struct DeleteDescription: Decodable, Sendable {
    let title: String
    let text: String
}

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
    let hasNotes: Bool
    let titlePlaceholder: String
    /// lib/item-verbs.ts `deleteConfirmTitle(label)`.
    let deleteTitle: String
    let deleteDescriptions: [DeleteDescription]
}

/// A custom type built from the def a user saved: what the phone gets in the
/// payload's `itemTypes` (`name`, `label`, `labelPlural`), and the config's
/// answers for it.
private struct HydratedCase: Decodable, Sendable {
    let name: String
    let label: String?
    let labelPlural: String?
    /// The config's `label`.
    let typeLabel: String
    let titlePlaceholder: String
    /// lib/item-verbs.ts `deleteConfirmTitle` of the config's `label`.
    let deleteTitle: String
    let deleteDescriptions: [DeleteDescription]
}

private struct ItemCase: Decodable, Sendable {
    let name: String
    let item: Item
    let isSkippable: Bool
    let isPausable: Bool
    let isRemindable: Bool
    let isCollectible: Bool
    /// lib/bulk-edit.ts `reminderNeedsDate`.
    let reminderNeedsDate: Bool
}

private struct Fixture: Decodable, Sendable {
    let types: [TypeCase]
    let hydrated: [HydratedCase]
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
        #expect(!f.hydrated.isEmpty)
        #expect(f.types.allSatisfy { !$0.deleteDescriptions.isEmpty })
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
            #expect(c.hasNotes == t.hasNotes, "\(t.name): hasNotes")
            #expect(c.titlePlaceholder == t.titlePlaceholder, "\(t.name): titlePlaceholder")
            #expect(deleteConfirmTitle(c.label) == t.deleteTitle, "\(t.name): deleteConfirmTitle")
            for d in t.deleteDescriptions {
                #expect(c.deleteDescription(d.title) == d.text, "\(t.name): deleteDescription(\(d.title))")
            }
        }
    }

    /// A type the payload names takes the user's label, and its placeholder
    /// and delete words follow; every capability stays the template's.
    @Test func aHydratedTypeAnswersWithItsOwnLabel() throws {
        for h in try loadFixture().hydrated {
            let labels = [h.name: ItemTypeLabel(name: h.name, label: h.label ?? "", labelPlural: h.labelPlural ?? "")]
            let c = caps(h.name, labels: labels)
            #expect(c.label == h.typeLabel, "\(h.name): label")
            #expect(typeLabel(h.name, labels: labels) == h.typeLabel, "\(h.name): typeLabel")
            #expect(c.titlePlaceholder == h.titlePlaceholder, "\(h.name): titlePlaceholder")
            #expect(deleteConfirmTitle(c.label) == h.deleteTitle, "\(h.name): deleteConfirmTitle")
            for d in h.deleteDescriptions {
                #expect(c.deleteDescription(d.title) == d.text, "\(h.name): deleteDescription(\(d.title))")
            }

            var template = caps(h.name)
            template.label = c.label
            template.titlePlaceholder = c.titlePlaceholder
            #expect(c == template, "\(h.name): only the words change")
        }
    }

    @Test func theItemPredicatesMatchTheWeb() throws {
        for c in try loadFixture().items {
            #expect(isSkippable(c.item) == c.isSkippable, "\(c.name): isSkippable")
            #expect(isPausable(c.item) == c.isPausable, "\(c.name): isPausable")
            #expect(isRemindable(c.item) == c.isRemindable, "\(c.name): isRemindable")
            #expect(isCollectible(c.item) == c.isCollectible, "\(c.name): isCollectible")
            let itemCaps = caps(c.item.typeName)
            #expect(isRemindable(c.item, caps: itemCaps) == c.isRemindable, "\(c.name): isRemindable(caps:)")
            #expect(reminderNeedsDate(c.item, caps: itemCaps) == c.reminderNeedsDate, "\(c.name): reminderNeedsDate")
        }
    }

    /// A reminder needs a day only on a dated type with none; an empty
    /// date is none, as JavaScript's truthiness reads it. A habit never
    /// needs one.
    @Test func aReminderNeedsADateOnlyOnADatedTypeWithout() {
        let id = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
        #expect(reminderNeedsDate(Item(id: id, title: "Call the bank"), caps: .task))
        #expect(reminderNeedsDate(Item(id: id, title: "Call the bank", startDate: ""), caps: .task))
        #expect(!reminderNeedsDate(Item(id: id, title: "Call the bank", startDate: "2026-10-01"), caps: .task))
        #expect(reminderNeedsDate(Item(id: id, type: "custom", customType: "errand", title: "Stamps"),
                                  caps: caps("errand")))
        #expect(!reminderNeedsDate(Item(id: id, type: "habit", title: "Meds"), caps: .habit))
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

    /// The labels never rename a built-in, an empty label falls back to the
    /// slug (`def.label || capitalize(def.name)`), and a slug the payload
    /// doesn't name is the template's.
    @Test func labelsReachOnlyTheTypesTheyName() {
        let labels = [
            "task": ItemTypeLabel(name: "task", label: "Chore", labelPlural: "Chores"),
            "side_quest": ItemTypeLabel(name: "side_quest", label: "Side quest", labelPlural: "Side quests"),
            "errand": ItemTypeLabel(name: "errand", label: "", labelPlural: ""),
        ]
        #expect(caps("task", labels: labels) == .task)
        #expect(caps("habit", labels: labels) == .habit)
        #expect(typeLabel("side_quest", labels: labels) == "Side quest")
        #expect(caps("side_quest", labels: labels).titlePlaceholder == "Add a side quest\u{2026}")
        #expect(typeLabel("errand", labels: labels) == "Errand")
        #expect(typeLabel("book_club", labels: labels) == "Book_club")
        #expect(caps("book_club", labels: labels) == caps("book_club"))
    }

    /// Delete's confirm says what Delete does: to the Trash for 30 days, then
    /// gone. A habit's history goes too.
    @Test func theDeleteWordsSayTrash() {
        #expect(ItemCaps.task.deleteDescription("Buy milk")
            == "Moves \"Buy milk\" to Trash for 30 days, then deletes it for good.")
        #expect(ItemCaps.habit.deleteDescription("Meds")
            == "Moves \"Meds\" and its history to Trash for 30 days, then deletes them for good.")
        #expect(caps("errand").deleteDescription("Stamps")
            == "Moves \"Stamps\" to Trash for 30 days, then deletes it for good.")
        #expect(ItemCaps.task.titlePlaceholder == "What needs to be done?")
        #expect(ItemCaps.habit.titlePlaceholder == "What habit to track?")
        #expect(caps("errand").titlePlaceholder == "Add a errand\u{2026}")
        #expect(deleteConfirmTitle(ItemCaps.task.label) == "Delete task?")
        #expect(deleteConfirmTitle(ItemCaps.habit.label) == "Delete habit?")
    }

    /// `jsLowercased` is `String.prototype.toLowerCase` (Node's answers):
    /// a capital sigma that ends a word takes the final form, skipping an
    /// apostrophe, a full stop or an accent either side, and one that doesn't
    /// end a word, or stands alone, doesn't. Everything else is `lowercased()`.
    @Test func lowerCasingIsJavaScripts() {
        let cases: [(String, String)] = [
            ("ΣΤΟΧΟΣ", "στοχος"),
            ("ΟΔΟΣ ΣΤΟΧΟΣ", "οδος στοχος"),
            ("ΣΑΣ", "σας"),
            ("Σ", "σ"),
            ("ΑΣΑ", "ασα"),
            ("ΑΣ Β", "ας β"),
            ("Α.Σ", "α.ς"),
            ("ΑΣ.Α", "ασ.α"),
            ("ΑΣ'", "ας'"),
            ("Α\u{0301}Σ", "α\u{0301}ς"),
            ("\u{0345}Σ", "\u{0345}σ"),
            ("İSTANBUL", "i\u{0307}stanbul"),
            ("Book Club", "book club"),
            ("", ""),
        ]
        for (input, expected) in cases {
            // By scalar: String's == would call some different strings equal.
            #expect(Array(jsLowercased(input).unicodeScalars) == Array(expected.unicodeScalars),
                    "\(input.debugDescription)")
        }
        let labels = ["stochos": ItemTypeLabel(name: "stochos", label: "ΣΤΟΧΟΣ", labelPlural: "ΣΤΟΧΟΙ")]
        let greek = caps("stochos", labels: labels)
        #expect(greek.titlePlaceholder == "Add a στοχος\u{2026}")
        #expect(deleteConfirmTitle(greek.label) == "Delete στοχος?")
    }
}
