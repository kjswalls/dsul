import Foundation

// Port of the slice of lib/item-registry.ts that Today asks: what "done" is
// called, whether the type has a skip status of its own, its repeat when the
// column is NULL, and the block length a timed item gets when it has none.
// Keep in step with `ITEM_TYPES` and `buildCustomTypeConfig` there.
//
// Like the web, any slug that isn't 'task' or 'habit' answers with the custom
// template (`getItemTypeConfig` falls back to `buildCustomTypeConfig`), so a
// user-defined type needs no entry here, and neither does one whose
// item_types row was deleted.

/// The capabilities Today reads off lib/item-registry.ts `ItemTypeConfig`.
public struct ItemCaps: Sendable, Hashable {
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

    public init(doneStatus: String, skipStatus: String?, defaultFrequency: String, defaultBlockMinutes: Int) {
        self.doneStatus = doneStatus
        self.skipStatus = skipStatus
        self.defaultFrequency = defaultFrequency
        self.defaultBlockMinutes = defaultBlockMinutes
    }

    /// `ITEM_TYPES.task`.
    public static let task = ItemCaps(doneStatus: "completed", skipStatus: nil, defaultFrequency: "none", defaultBlockMinutes: 30)
    /// `ITEM_TYPES.habit`.
    public static let habit = ItemCaps(doneStatus: "done", skipStatus: "skipped", defaultFrequency: "daily", defaultBlockMinutes: 30)
    /// `buildCustomTypeConfig`: task-shaped in every respect Today reads.
    public static let custom = ItemCaps(doneStatus: "completed", skipStatus: nil, defaultFrequency: "none", defaultBlockMinutes: 30)
}

/// lib/item-registry.ts `getItemTypeConfig`, for the fields above. Pass
/// `Item.typeName` (the custom slug, not 'custom').
public func caps(_ typeName: String) -> ItemCaps {
    switch typeName {
    case "task": return .task
    case "habit": return .habit
    default: return .custom
    }
}
