import Foundation

// Port of the optimistic completion step in `toggleHabitStatus` (and the habit
// branch of `setItemsCompleted`), lib/planner-store.ts.
// The rest of that step lives with its callers: a tick (`applying`,
// ItemToggle.swift) also clears that day's skip and records the tally, and a
// skip or unskip (`skipping`, VerbWrites.swift) clears the day's completion by
// the same streak rule and moves `skippedDates`.
// The streak is an opaque stored counter: it moves +1 or -1 only when the day's
// completion actually changes, never recomputed from `completedDates`, and never
// below 0. On the web the server RPC owns the real transition; this is the
// value the UI shows until the server answers.

/// A habit's completion history and its stored streak.
public struct HabitMark: Sendable, Hashable {
    public var completedDates: [String]
    public var streak: Int

    public init(completedDates: [String], streak: Int) {
        self.completedDates = completedDates
        self.streak = streak
    }
}

/// Marks `day` done or not done. A request that matches the current state
/// changes nothing, so a double tap can't count twice.
public func settingHabitCompletion(_ mark: HabitMark, done: Bool, on day: DayString) -> HabitMark {
    let key = day.description
    let wasCompleted = isCompletedOnDate(mark.completedDates, day)
    var next = mark
    if done && !wasCompleted {
        next.completedDates.append(key)
        next.streak += 1
    } else if !done && wasCompleted {
        next.completedDates.removeAll { $0 == key }
        next.streak = max(0, next.streak - 1)
    }
    return next
}
