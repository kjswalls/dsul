import Foundation

// The words the item sheet shares with the web's, from lib/item-edit.ts
// `EDIT_COPY` and `streakRunText`, which the web's own surfaces read too:
// Reset streak's confirm (components/planner/item-dialog.tsx), the Subtasks
// section's placeholder and its capped-paste toast
// (components/planner/item-detail-sections.tsx), and the streak flame's
// tooltip (components/primitives/pills.tsx `StreakFlame`). Keep in step: a
// change there without the same change here is drift, and the phone says
// something the web no longer does. Checked against the web by
// EditWritesFixtureTests (edit-writes.json's `copy` and `streakRun`).
//
// The phone's own words (the "Add a subtask" row, the confirm's title) are
// the app's, in ItemSheetModel.

/// lib/item-edit.ts `EDIT_COPY`.
public enum EditCopy {
    /// Reset streak's confirm: what goes (the counter) and what stays (the
    /// days already ticked), as lib/planner-store.ts `resetHabitStreak` writes it.
    public static let resetStreakMessage = "This will reset your streak counter to 0 days. "
        + "Your completion history stays, so days you already checked off remain checked."
    /// The new-subtask field's placeholder.
    public static let subtaskPlaceholder = "Add subtask\u{2026}"
    /// Said when a paste held more lines than one paste adds (`maxBulkItems`).
    public static let subtaskPasteCapped = "Added the first \(maxBulkItems) subtasks. The paste had more."
}

/// lib/item-edit.ts `streakRunText`, the streak flame's tooltip: "No streak
/// yet" at 0 (or below), "1 day in a row", else "N days in a row".
public func streakRunText(_ streak: Int) -> String {
    return streak > 0 ? "\(streak) \(streak == 1 ? "day" : "days") in a row" : "No streak yet"
}
