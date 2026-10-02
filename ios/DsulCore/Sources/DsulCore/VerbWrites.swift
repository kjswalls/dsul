import Foundation

// The optimistic step of the item sheet's three writes: the item as the web's
// store holds it right after the verb, before the server answers. Ports of
// lib/planner-store.ts:
// - `skipping`: `setItemSkipped`, which sends a habit through
//   `toggleHabitStatus('skipped' | 'pending')` and moves a task-like item's
//   `skippedDates` alone;
// - `moving`: `moveTaskToDate`;
// - `pausing`: `setItemPaused`, as the patch `resolvePauseWrite` (Active.swift)
//   resolves, which is the rule the server applies to the same request.
// Keep in step: a change there without the same change here is drift, and the
// phone shows a state the server never wrote until the next fetch replaces it.
// Checked against the web by VerbWritesFixtureTests
// (tests/fixtures/day/verb-writes.json), which drives the real store.
//
// Each refuses what the store refuses, leaving the item as it was: `skipping`
// an item that isn't `isSkippable`, `moving` a habit. What the phone SENDS is
// the intent (POST /api/app/items/:id `skip`, `move`, `pause`), never these
// arrays: the server owns the completion RPC and the streak.

/// The item after skipping (`skipped: true`) or unskipping its occurrence on
/// `date` (yyyy-MM-dd).
///
/// - A habit (a type with a `skipStatus`) takes the status 'skipped' or
///   'pending'. Either way the day's completion is cleared, and the streak
///   gives back a day only if the day was completed (HabitCompletion.swift's
///   rule); the skip joins or leaves `skippedDates`; `currentDayCount` keeps
///   its value (0 when it had none); the day's tally is left alone.
/// - A task-like item already in the asked-for state is unchanged. Otherwise
///   the date joins or leaves `skippedDates`, a skip clears that day's
///   completion, and the status is never touched (the task status words are an
///   external contract).
public func skipping(_ item: Item, on date: String, skipped: Bool) -> Item {
    guard isSkippable(item) else { return item }

    if let skipStatus = caps(item.typeName).skipStatus, !skipStatus.isEmpty {
        // `toggleHabitStatus` finds habits only.
        guard item.isHabit else { return item }
        let status = skipped ? skipStatus : "pending"
        var next = item
        if item.completedDates.contains(date) {
            // The status asked for is never 'done', so a completion goes.
            next.completedDates.removeAll { $0 == date }
            next.streak = max(0, (item.streak ?? 0) - 1)
        }
        let wasSkipped = item.skippedDates.contains(date)
        if status == "skipped" && !wasSkipped {
            next.skippedDates.append(date)
        } else if status != "skipped" && wasSkipped {
            next.skippedDates.removeAll { $0 == date }
        }
        next.status = status
        next.currentDayCount = item.currentDayCount ?? 0
        return next
    }

    if item.skippedDates.contains(date) == skipped { return item }
    var next = item
    if skipped {
        next.skippedDates.append(date)
        // A skipped occurrence is not a completed one.
        next.completedDates.removeAll { $0 == date }
    } else {
        next.skippedDates.removeAll { $0 == date }
    }
    return next
}

/// The item after the carry or a reschedule to `dateStr`: that start date, and
/// its bucket kept (Anytime when it had none). Its time, length and scheduled
/// flag stay as they were. A habit is unchanged: it has no day to move.
public func moving(_ item: Item, to dateStr: String) -> Item {
    guard !item.isHabit else { return item }
    var next = item
    next.startDate = dateStr
    next.timeBucket = item.timeBucket ?? "anytime"
    return next
}

/// The item with a resolved pause patch (`resolvePauseWrite`) applied: a column
/// the patch sets takes the value, one it clears becomes nil, and one it leaves
/// out stays. An empty patch changes nothing.
public func pausing(_ item: Item, patch: PauseWindowPatch) -> Item {
    var next = item
    if let pausedAt = patch.pausedAt { next.pausedAt = pausedAt.value }
    if let pausedUntil = patch.pausedUntil { next.pausedUntil = pausedUntil.value }
    return next
}
