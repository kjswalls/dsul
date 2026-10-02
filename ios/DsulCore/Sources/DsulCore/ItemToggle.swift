import Foundation

// Port of lib/item-toggle.ts, what a tick MEANS, plus the store's resolution
// of it (lib/planner-store.ts `toggleTaskStatus` and `toggleHabitStatus`).
// Keep in step: a change there without the same change here is drift, and a
// tick on the phone writes something different from the same tick on the web.
// Checked against the web by ItemToggleFixtureTests (tests/fixtures/day/toggle.json).
//
// - A one-off task flips its scalar status between its type's done status and
//   'pending' (a cancelled one ticks to done).
// - A recurring task flips that date's completion and never its status.
// - A habit flips that date's completion; with `timesPerDay > 1` it counts up
//   instead, done only at the target, and a tick on a done day clears it to 0.
// - A SKIPPED occurrence is refused outright: ticking it would leave a row
//   skipped and completed at once, or turn a deliberate skip back into an open
//   loop that the nightly stake settlement counts as a miss.
//
// `tickIntent` is what the phone sends (POST /api/app/items/:id `complete`);
// `applying` is the optimistic step the store takes before the server answers.

/// lib/item-toggle.ts `isRowDone`: is this row ticked on `day`? A habit and a
/// recurring task read the date; a one-off task reads its status.
public func isRowDone(_ item: Item, on day: DayString) -> Bool {
    if item.isHabit { return item.completedDates.contains(day.description) }
    if isRecurring(item.rule) { return isCompletedOnDate(item.completedDates, day) }
    return item.status == "completed"
}

/// lib/item-toggle.ts `isRowSkipped`: was this occurrence skipped? A third
/// state, drawn without a checkbox.
public func isRowSkipped(_ item: Item, on day: DayString) -> Bool {
    return item.skippedDates.contains(day.description)
}

/// The end state one tick asks for on one date: done or not, and for a
/// counted habit the day's new tally.
public struct TickIntent: Sendable, Hashable {
    public var done: Bool
    public var count: Int?

    public init(done: Bool, count: Int? = nil) {
        self.done = done
        self.count = count
    }
}

/// lib/item-toggle.ts `toggleRowDone`, resolved the way the store resolves the
/// action it calls. Nil when the date is skipped: nothing is sent.
public func tickIntent(_ item: Item, on day: DayString) -> TickIntent? {
    if isRowSkipped(item, on: day) { return nil }
    let key = day.description

    if !item.isHabit {
        // `toggleTaskDone`: a recurring task is handed the date and flips it;
        // a one-off flips 'completed' ↔ 'pending' on its status.
        if isRecurring(item.rule) { return TickIntent(done: !isCompletedOnDate(item.completedDates, day)) }
        return TickIntent(done: item.status != "completed")
    }

    // `toggleHabitDone`.
    let doneOnDate = item.completedDates.contains(key)
    let skipped = item.skippedDates.contains(key)
    let status = skipped ? "skipped" : doneOnDate ? "done" : "pending"

    let timesPerDay = item.timesPerDay ?? 0
    let multiTarget = timesPerDay > 1 ? timesPerDay : 0
    if multiTarget == 0 {
        // Binary. Reads `status`, not `doneOnDate`: a skipped habit's box would
        // take it back to pending, never jump it to done.
        return TickIntent(done: status == "pending")
    }

    // Counted. A day marked done with no tally still counts as a full day.
    let count = item.dailyCounts[key] ?? 0
    let effectiveCount: Int
    if doneOnDate {
        effectiveCount = count != 0 ? count : (timesPerDay != 0 ? timesPerDay : 1)
    } else {
        effectiveCount = count
    }
    if status == "done" {
        // Unticking means "I didn't do this": it clears the day rather than
        // stepping down to target-1.
        return TickIntent(done: false, count: 0)
    }
    let next = effectiveCount + 1
    if next >= multiTarget { return TickIntent(done: true, count: multiTarget) }
    return TickIntent(done: false, count: next)
}

/// The optimistic step: `item` as the store holds it after the tick, before
/// the server answers (lib/planner-store.ts `toggleTaskStatus` and the
/// optimistic half of `toggleHabitStatus`).
///
/// - One-off: the status becomes the type's `doneStatus` or 'pending'.
/// - Recurring task: the date joins or leaves `completedDates`; status untouched.
/// - Habit: status 'done' or 'pending'; the date joins or leaves
///   `completedDates` with the streak moving by one (HabitCompletion.swift);
///   a skip on that date is cleared; a count, when given, is that day's tally.
public func applying(_ intent: TickIntent, to item: Item, on day: DayString) -> Item {
    var next = item
    let key = day.description

    if !item.isHabit {
        if isRecurring(item.rule) {
            let already = isCompletedOnDate(item.completedDates, day)
            if intent.done && !already {
                next.completedDates.append(key)
            } else if !intent.done && already {
                next.completedDates.removeAll { $0 == key }
            }
        } else {
            next.status = intent.done ? caps(item.typeName).doneStatus : "pending"
        }
        return next
    }

    next.status = intent.done ? "done" : "pending"
    let mark = settingHabitCompletion(
        HabitMark(completedDates: item.completedDates, streak: item.streak ?? 0),
        done: intent.done,
        on: day
    )
    next.completedDates = mark.completedDates
    if mark.completedDates != item.completedDates { next.streak = mark.streak }
    // The status asked for is never 'skipped', so a skip on that day clears.
    next.skippedDates.removeAll { $0 == key }
    if let count = intent.count { next.dailyCounts[key] = count }
    return next
}

// The same three spelled positionally, as the PR 3 design writes them
// (`tickIntent(item, date)`), so either spelling compiles.

public func isRowDone(_ item: Item, _ day: DayString) -> Bool {
    return isRowDone(item, on: day)
}

public func isRowSkipped(_ item: Item, _ day: DayString) -> Bool {
    return isRowSkipped(item, on: day)
}

public func tickIntent(_ item: Item, _ day: DayString) -> TickIntent? {
    return tickIntent(item, on: day)
}
