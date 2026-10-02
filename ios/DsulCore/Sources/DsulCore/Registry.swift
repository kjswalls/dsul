import Foundation

// Port of the slice of lib/item-registry.ts that the phone asks: what "done"
// is called, whether the type has a skip status of its own, its repeat when the
// column is NULL, the block length a timed item gets when it has none, and the
// capabilities the item sheet's verbs and chips read (label, skippable,
// pausable, dated, remindable, collectible, subtasks, the counters, priority),
// with the item-level questions built on them (`isSkippable`, `isPausable`,
// `isRemindable`, `isCollectible`). Keep in step with `ITEM_TYPES` and
// `buildCustomTypeConfig` there. Checked against the web by
// RegistryCapsFixtureTests (tests/fixtures/day/caps.json).
//
// Like the web, any slug that isn't 'task' or 'habit' answers with the custom
// template (`getItemTypeConfig` falls back to `buildCustomTypeConfig`), so a
// user-defined type needs no entry here, and neither does one whose
// item_types row was deleted. The phone has no item_types rows (the planner
// payload carries none), so a custom type's label is always the template's
// `capitalize(name)`, never the label the user gave it.

/// The capabilities the phone reads off lib/item-registry.ts `ItemTypeConfig`.
public struct ItemCaps: Sendable, Hashable {
    /// `label`: the type's noun ("Task", "Habit"; a custom slug capitalised).
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
        hasPriority: Bool
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
    }

    /// `ITEM_TYPES.task`.
    public static let task = ItemCaps(
        label: "Task", doneStatus: "completed", skipStatus: nil, defaultFrequency: "none", defaultBlockMinutes: 30,
        dateAnchored: true, dateAddressable: true, skippable: true, pausable: true, remindable: true,
        collectible: true, braindumpEligible: true, subtasks: true, streakCounter: false, dailyCounts: false,
        hasPriority: true
    )

    /// `ITEM_TYPES.habit`.
    public static let habit = ItemCaps(
        label: "Habit", doneStatus: "done", skipStatus: "skipped", defaultFrequency: "daily", defaultBlockMinutes: 30,
        dateAnchored: false, dateAddressable: false, skippable: true, pausable: true, remindable: true,
        collectible: true, braindumpEligible: false, subtasks: false, streakCounter: true, dailyCounts: true,
        hasPriority: false
    )

    /// `buildCustomTypeConfig({ name, label: capitalize(name) })`: task-shaped
    /// in every respect the phone reads, labelled with the slug.
    public static func forCustomType(_ name: String) -> ItemCaps {
        return ItemCaps(
            label: capitalizedFirst(name), doneStatus: "completed", skipStatus: nil, defaultFrequency: "none",
            defaultBlockMinutes: 30, dateAnchored: true, dateAddressable: true, skippable: true, pausable: true,
            remindable: true, collectible: true, braindumpEligible: true, subtasks: true, streakCounter: false,
            dailyCounts: false, hasPriority: true
        )
    }

    /// The custom template for the slug 'custom' itself.
    public static let custom = ItemCaps.forCustomType("custom")
}

/// lib/item-registry.ts `capitalize`: the first character upper-cased and the
/// rest left as they are ("side-quest" → "Side-quest", "book_club" →
/// "Book_club"), where `String.capitalized` would touch every word.
func capitalizedFirst(_ s: String) -> String {
    guard let first = s.first else { return s }
    return String(first).uppercased() + String(s.dropFirst())
}

/// lib/item-registry.ts `getItemTypeConfig`, for the fields above. Pass
/// `Item.typeName` (the custom slug, not 'custom').
public func caps(_ typeName: String) -> ItemCaps {
    switch typeName {
    case "task": return .task
    case "habit": return .habit
    default: return .forCustomType(typeName)
    }
}

/// The type's noun for the item sheet's eyebrow: `getItemTypeConfig(name).label`.
public func typeLabel(_ typeName: String) -> String {
    return caps(typeName).label
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
