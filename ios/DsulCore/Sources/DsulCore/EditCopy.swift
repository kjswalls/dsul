import Foundation

// The words the item sheet shares with the web's, from lib/item-edit.ts
// `EDIT_COPY` and `streakRunText`, which the web's own surfaces read too:
// Reset streak's confirm and Remind's Right after field, its hint and its
// needs-a-date note (components/planner/item-dialog.tsx), the Subtasks
// section's placeholder and its capped-paste toast
// (components/planner/item-detail-sections.tsx), and the streak flame's
// tooltip (components/primitives/pills.tsx `StreakFlame`). Keep in step: a
// change there without the same change here is drift, and the phone says
// something the web no longer does. Checked against the web by
// EditWritesFixtureTests (edit-writes.json's `copy` and `streakRun`).
//
// From 2d, the Time sheet's lengths and their words too: lib/item-edit.ts
// `DURATION_ORDER` (`durationPresets`) and `durationLabel`, which the dialog's
// Duration rows and its time chip read (checked by edit-writes.json's
// `durations`).
//
// From 2e, the Repeat sheet's two sentences: Custom days' "Select at least one
// day" and Monthly's note on short months (the dialog's Repeat chip). The
// frequency and weekday words are lib/planner-types.ts's, in Cadence.swift.
//
// From 2f, the container nouns (`ContainerWords`): "Project", "Routine",
// "Season", their plurals and "No project", from lib/container-registry.ts
// `CONTAINER_KINDS`, the one place the web keeps them. The fixture's
// `containers` carries them here (checked by EditWritesFixtureTests'
// `theContainerWordsAreTheWebs`), so the phone never spells a container's noun
// on its own.
//
// The phone's own words (the "Add a subtask" row, the confirm's title) are
// the app's, in ItemSheetModel.

/// lib/item-edit.ts `EDIT_COPY`, and from 2d the lengths and their words
/// (`DURATION_ORDER`, `durationLabel`).
public enum EditCopy {
    /// Reset streak's confirm: what goes (the counter) and what stays (the
    /// days already ticked), as lib/planner-store.ts `resetHabitStreak` writes it.
    public static let resetStreakMessage = "This will reset your streak counter to 0 days. "
        + "Your completion history stays, so days you already checked off remain checked."
    /// The new-subtask field's placeholder.
    public static let subtaskPlaceholder = "Add subtask\u{2026}"
    /// Said when a paste held more lines than one paste adds (`maxBulkItems`).
    public static let subtaskPasteCapped = "Added the first \(maxBulkItems) subtasks. The paste had more."
    /// The Right after field's placeholder: the cue words of a reminder.
    public static let reminderAnchorPlaceholder = "I pour my coffee"
    /// Under Right after: what the words are for.
    public static let reminderAnchorHint = "Optional, and worth it. Something you already do beats a time. "
        + "The reminder will say what you write here."
    /// Under the time, for a dated type with no date (`reminderNeedsDate`).
    public static let reminderNeedsDate = "Give this a date and it will fire. "
        + "Without one there is no day for the reminder to land on."
    /// Under Custom days' keys while none is picked.
    public static let selectAtLeastOneDay = "Select at least one day"
    /// Under Monthly's days: a day past a short month's end lands on its last.
    public static let monthlyNote = "For months with fewer days, it will occur on the last day."

    /// lib/item-edit.ts `DURATION_ORDER`: the lengths the Time sheet offers,
    /// in minutes, in the dialog's order.
    public static let durationPresets: [Int] = [15, 30, 45, 60, 90, 120]

    /// lib/item-edit.ts `DURATION_LABELS`, keyed by minutes.
    private static let durationLabels: [Int: String] = [
        15: "15 min", 30: "30 min", 45: "45 min", 60: "1 hour", 90: "1.5 hours", 120: "2 hours",
    ]

    /// lib/item-edit.ts `durationLabel`: a length as the web names it, its
    /// preset's words ("1 hour", "1.5 hours"), else "N min" (the time chip's
    /// fallback, so 75 is "75 min").
    public static func durationLabel(_ minutes: Int) -> String {
        return durationLabels[minutes] ?? "\(minutes) min"
    }
}

/// lib/container-registry.ts `CONTAINER_KINDS`' words for the three kinds an
/// item meets (edit-writes.json `containers`): each kind's `label` and
/// `labelPlural`, and the project's `unsetLabel`, the "carries the axis,
/// value unset" heading (the Display menu's unset row and the list's
/// grouping heading). The item dialog's picker spells the same words from
/// `form.containerLabel` (`No {containerLabel.toLowerCase()}`).
public enum ContainerWords {
    /// `CONTAINER_KINDS.project.label`.
    public static let project = "Project"
    /// `CONTAINER_KINDS.project.labelPlural`.
    public static let projects = "Projects"
    /// `CONTAINER_KINDS.project.unsetLabel`.
    public static let noProject = "No project"
    /// `CONTAINER_KINDS.routine.label`.
    public static let routine = "Routine"
    /// `CONTAINER_KINDS.routine.labelPlural`.
    public static let routines = "Routines"
    /// `CONTAINER_KINDS.season.label`.
    public static let season = "Season"
    /// `CONTAINER_KINDS.season.labelPlural`.
    public static let seasons = "Seasons"
}

/// lib/item-edit.ts `streakRunText`, the streak flame's tooltip: "No streak
/// yet" at 0 (or below), "1 day in a row", else "N days in a row".
public func streakRunText(_ streak: Int) -> String {
    return streak > 0 ? "\(streak) \(streak == 1 ? "day" : "days") in a row" : "No streak yet"
}
