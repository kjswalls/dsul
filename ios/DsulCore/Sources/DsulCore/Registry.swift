import Foundation

// Port of the slice of lib/item-registry.ts that the phone asks: what "done"
// is called, whether the type has a skip status of its own, its repeat when the
// column is NULL, the block length a timed item gets when it has none, and the
// capabilities the item sheet's verbs, chips and fields read (label, skippable,
// pausable, dated, remindable, collectible, subtasks, the counters, priority,
// notes), with the item-level questions built on them (`isSkippable`,
// `isPausable`, `isRemindable`, `isCollectible`), and the words the sheet
// borrows from the type's `form` (the title placeholder and Delete's
// confirm), with Delete's title from lib/item-verbs.ts `deleteConfirmTitle`.
// Keep in step with `ITEM_TYPES` and `buildCustomTypeConfig` there.
// Checked against the web by RegistryCapsFixtureTests
// (tests/fixtures/day/caps.json).
//
// Like the web, any slug that isn't 'task' or 'habit' answers with the custom
// template (`getItemTypeConfig` falls back to `buildCustomTypeConfig`), so a
// user-defined type needs no entry here, and neither does one whose
// item_types row was deleted. The template is labelled with the user's own
// words when the planner payload carries the type (`itemTypes`, as
// `ItemTypeLabel`), and with `capitalize(name)` when it doesn't. The labels are
// passed in (`caps(_:labels:)`), never read from a global: the web hydrates a
// module-level map (`hydrateCustomTypes`), which Swift 6 has no safe place
// for, and only the label changes; a custom type's capabilities are the
// template's whatever it is called.

/// The capabilities the phone reads off lib/item-registry.ts `ItemTypeConfig`.
public struct ItemCaps: Sendable, Hashable {
    /// `label`: the type's noun ("Task", "Habit"; a custom type's own label,
    /// else its slug capitalised).
    public var label: String
    /// `doneStatus`: the scalar status a one-off item takes when ticked.
    public var doneStatus: String
    /// `skipStatus`: the habit's own 'skipped' status; nil for task-shaped types,
    /// which skip through `skippedDates` alone.
    public var skipStatus: String?
    /// `defaultFrequency`: the repeat a NULL `repeat_frequency` reads as.
    public var defaultFrequency: String
    /// `schedule.defaultBlockMinutes`: a timed block's length when it has no
    /// `duration`.
    public var defaultBlockMinutes: Int
    /// `dateAnchored`: the item's `startDate` is a day it happens on (habits
    /// have none).
    public var dateAnchored: Bool
    /// `dateAddressable`: the item may be carried to another day.
    public var dateAddressable: Bool
    /// `skippable`: an occurrence may be skipped (`isSkippable` adds recurrence).
    public var skippable: Bool
    /// `pausable` (`isPausable` adds the subtask rule).
    public var pausable: Bool
    /// `remindable` (`isRemindable` adds the subtask rule).
    public var remindable: Bool
    /// `collectible`: may join routines, seasons and goals (`isCollectible`
    /// adds the subtask rule).
    public var collectible: Bool
    /// `braindumpEligible`.
    public var braindumpEligible: Bool
    /// `subtasks`: the type grows subtasks.
    public var subtasks: Bool
    /// `counters.streak`: the type keeps a streak.
    public var streakCounter: Bool
    /// `counters.dailyCounts`: the type keeps a per-day tally.
    public var dailyCounts: Bool
    /// `fields.includes('priority')`.
    public var hasPriority: Bool
    /// `fields.includes('notes')`: every shipped type today, so the server's
    /// `no_notes` is the answer a future type gets.
    public var hasNotes: Bool
    /// `form.titlePlaceholder`: the empty title field's prompt ("What needs to
    /// be done?"; "Add a side quest…" for a custom type).
    public var titlePlaceholder: String
    /// `form.deleteDescription`'s habit wording: Delete's confirm names the
    /// history (the done days, the streak) that goes to the Trash with it.
    public var deleteNamesHistory: Bool

    public init(
        label: String,
        doneStatus: String,
        skipStatus: String?,
        defaultFrequency: String,
        defaultBlockMinutes: Int,
        dateAnchored: Bool,
        dateAddressable: Bool,
        skippable: Bool,
        pausable: Bool,
        remindable: Bool,
        collectible: Bool,
        braindumpEligible: Bool,
        subtasks: Bool,
        streakCounter: Bool,
        dailyCounts: Bool,
        hasPriority: Bool,
        hasNotes: Bool = true,
        titlePlaceholder: String = "",
        deleteNamesHistory: Bool = false
    ) {
        self.label = label
        self.doneStatus = doneStatus
        self.skipStatus = skipStatus
        self.defaultFrequency = defaultFrequency
        self.defaultBlockMinutes = defaultBlockMinutes
        self.dateAnchored = dateAnchored
        self.dateAddressable = dateAddressable
        self.skippable = skippable
        self.pausable = pausable
        self.remindable = remindable
        self.collectible = collectible
        self.braindumpEligible = braindumpEligible
        self.subtasks = subtasks
        self.streakCounter = streakCounter
        self.dailyCounts = dailyCounts
        self.hasPriority = hasPriority
        self.hasNotes = hasNotes
        self.titlePlaceholder = titlePlaceholder
        self.deleteNamesHistory = deleteNamesHistory
    }

    /// `ITEM_TYPES.task`.
    public static let task = ItemCaps(
        label: "Task", doneStatus: "completed", skipStatus: nil, defaultFrequency: "none", defaultBlockMinutes: 30,
        dateAnchored: true, dateAddressable: true, skippable: true, pausable: true, remindable: true,
        collectible: true, braindumpEligible: true, subtasks: true, streakCounter: false, dailyCounts: false,
        hasPriority: true, hasNotes: true, titlePlaceholder: "What needs to be done?", deleteNamesHistory: false
    )

    /// `ITEM_TYPES.habit`.
    public static let habit = ItemCaps(
        label: "Habit", doneStatus: "done", skipStatus: "skipped", defaultFrequency: "daily", defaultBlockMinutes: 30,
        dateAnchored: false, dateAddressable: false, skippable: true, pausable: true, remindable: true,
        collectible: true, braindumpEligible: false, subtasks: false, streakCounter: true, dailyCounts: true,
        hasPriority: false, hasNotes: true, titlePlaceholder: "What habit to track?", deleteNamesHistory: true
    )

    /// `buildCustomTypeConfig({ name, label })`: task-shaped in every respect
    /// the phone reads, labelled with `label`, or with `capitalize(name)` when
    /// it is nil or empty (`def.label || capitalize(def.name)`). The label
    /// reaches the placeholder too, lower-cased as JavaScript does
    /// (`jsLowercased`: "Add a side quest…").
    public static func forCustomType(_ name: String, label: String? = nil) -> ItemCaps {
        let noun: String
        if let label, !label.isEmpty {
            noun = label
        } else {
            noun = capitalizedFirst(name)
        }
        return ItemCaps(
            label: noun, doneStatus: "completed", skipStatus: nil, defaultFrequency: "none",
            defaultBlockMinutes: 30, dateAnchored: true, dateAddressable: true, skippable: true, pausable: true,
            remindable: true, collectible: true, braindumpEligible: true, subtasks: true, streakCounter: false,
            dailyCounts: false, hasPriority: true, hasNotes: true,
            titlePlaceholder: "Add a \(jsLowercased(noun))\u{2026}", deleteNamesHistory: false
        )
    }

    /// The custom template for the slug 'custom' itself.
    public static let custom = ItemCaps.forCustomType("custom")

    /// `form.deleteDescription(title)`: the body of Delete's confirm, true to
    /// what Delete does on every surface. The item goes to the Trash, which
    /// restores it for 30 days (on the web; the phone has no Trash), and is
    /// then deleted for good. A habit's history goes with it.
    public func deleteDescription(_ title: String) -> String {
        if deleteNamesHistory {
            return "Moves \"\(title)\" and its history to Trash for 30 days, then deletes them for good."
        }
        return "Moves \"\(title)\" to Trash for 30 days, then deletes it for good."
    }
}

/// lib/item-verbs.ts `deleteConfirmTitle(label)`: the title of Delete's
/// confirm in the type's own noun, "Delete task?", "Delete side quest?".
/// Pass the type's `label` (`ItemCaps.label`).
public func deleteConfirmTitle(_ label: String) -> String {
    return "Delete \(jsLowercased(label))?"
}

/// One of the user's own item types (an `item_types` row), as the planner
/// payload names it: `itemTypes[]` from lib/app-api.ts, the def's `name`,
/// `label` and `labelPlural` and nothing of its config. The phone's
/// capabilities for it come from the custom template, never from the row.
public struct ItemTypeLabel: Codable, Sendable, Hashable {
    /// The slug, as `items.type` stores it (`Item.typeName`).
    public var name: String
    /// The user's noun ("Side quest"); empty reads as the slug capitalised.
    public var label: String
    /// Its plural ("Side quests"). Carried for the views; the template's
    /// fallback when empty is `label + "s"`.
    public var labelPlural: String

    public init(name: String, label: String, labelPlural: String) {
        self.name = name
        self.label = label
        self.labelPlural = labelPlural
    }

    enum CodingKeys: String, CodingKey {
        case name, label, labelPlural
    }

    /// Throws only without a name, which leaves nothing to match an item on;
    /// a missing, null or mistyped label reads as empty, so the slug answers.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name = try c.decode(String.self, forKey: .name)
        self.label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? ""
        self.labelPlural = (try? c.decodeIfPresent(String.self, forKey: .labelPlural)) ?? ""
    }
}

/// lib/item-registry.ts `capitalize`: the first character upper-cased and the
/// rest left as they are ("side-quest" → "Side-quest", "book_club" →
/// "Book_club"), where `String.capitalized` would touch every word.
func capitalizedFirst(_ s: String) -> String {
    guard let first = s.first else { return s }
    return String(first).uppercased() + String(s.dropFirst())
}

/// `String.prototype.toLowerCase`. Swift's `lowercased()` maps each scalar on
/// its own; JavaScript also applies Unicode's one context-dependent rule,
/// Final_Sigma: a capital sigma that ends a word (a cased letter before it, and
/// none after it, skipping case-ignorable scalars such as an apostrophe or an
/// accent) becomes the final form, U+03C2, so "ΣΤΟΧΟΣ" is "στοχος", not
/// "στοχοσ". Skipping before testing, as ICU does, so a scalar that is both
/// cased and case-ignorable (U+0345) is skipped.
public func jsLowercased(_ s: String) -> String {
    let sigma: Unicode.Scalar = "\u{03A3}"
    let scalars = Array(s.unicodeScalars)
    guard scalars.contains(sigma) else { return s.lowercased() }
    /// Is the first scalar along `indices` that isn't case-ignorable cased?
    func casedNext(_ indices: some Sequence<Int>) -> Bool {
        for i in indices where !scalars[i].properties.isCaseIgnorable {
            return scalars[i].properties.isCased
        }
        return false
    }
    var out = String.UnicodeScalarView()
    for (i, scalar) in scalars.enumerated() {
        if scalar == sigma, casedNext((0..<i).reversed()), !casedNext((i + 1)..<scalars.count) {
            out.append("\u{03C2}")
        } else {
            out.append(contentsOf: scalar.properties.lowercaseMapping.unicodeScalars)
        }
    }
    return String(out)
}

/// lib/item-registry.ts `getItemTypeConfig`, for the fields above, with no
/// custom types hydrated: a custom slug is labelled `capitalize(name)`. Pass
/// `Item.typeName` (the custom slug, not 'custom').
public func caps(_ typeName: String) -> ItemCaps {
    return caps(typeName, labels: [:])
}

/// `getItemTypeConfig` after `hydrateCustomTypes`: a custom slug the payload
/// names (`labels`, keyed by `ItemTypeLabel.name`) takes its label, and one it
/// doesn't falls back to `capitalize(name)`. 'task' and 'habit' are the
/// built-ins whatever `labels` says, as on the web.
public func caps(_ typeName: String, labels: [String: ItemTypeLabel]) -> ItemCaps {
    switch typeName {
    case "task": return .task
    case "habit": return .habit
    default: return .forCustomType(typeName, label: labels[typeName]?.label)
    }
}

/// The type's noun for the item sheet's eyebrow: `getItemTypeConfig(name).label`.
public func typeLabel(_ typeName: String) -> String {
    return caps(typeName).label
}

/// The same noun with the payload's custom labels applied (`caps(_:labels:)`).
public func typeLabel(_ typeName: String, labels: [String: ItemTypeLabel]) -> String {
    return caps(typeName, labels: labels).label
}

/// lib/item-registry.ts `isSkippable`: the capability AND recurrence. A skip is
/// a date in `skippedDates`, which only means something when there is another
/// occurrence. No subtask rule: a recurring subtask passes, as on the web.
public func isSkippable(_ item: Item) -> Bool {
    return caps(item.typeName).skippable && isRecurring(item.rule)
}

/// A non-empty `parentItemId`: JavaScript's truthiness, which the subtask rule
/// below tests.
private func isSubtask(_ item: Item) -> Bool {
    guard let parent = item.parentItemId else { return false }
    return !parent.isEmpty
}

/// lib/item-registry.ts `isPausable`: the capability AND not a subtask (a
/// subtask shows only inside its parent, so pausing it would hide nothing).
/// Not AND-ed with recurrence: a one-off may pause.
public func isPausable(_ item: Item) -> Bool {
    if isSubtask(item) { return false }
    return caps(item.typeName).pausable
}

/// lib/item-registry.ts `isRemindable`: the capability AND not a subtask.
public func isRemindable(_ item: Item) -> Bool {
    if isSubtask(item) { return false }
    return caps(item.typeName).remindable
}

/// lib/item-registry.ts `isCollectible`: the capability AND not a subtask.
public func isCollectible(_ item: Item) -> Bool {
    if isSubtask(item) { return false }
    return caps(item.typeName).collectible
}
