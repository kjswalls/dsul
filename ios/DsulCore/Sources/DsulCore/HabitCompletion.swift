import Foundation

// Port of the optimistic completion step in `toggleHabitStatus` (and the habit
// branch of `setItemsCompleted`), lib/planner-store.ts.
// Not yet ported: the TS also clears that day's skip (`skippedDates`) when it
// completes the habit. Port that once iOS has `skippedDates`.
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
