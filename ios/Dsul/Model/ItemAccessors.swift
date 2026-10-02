import DsulCore
import Foundation

// The phone's names for a few of the web `Item`'s fields, read the way the
// views and the drag spike were written against before the real model landed.
// Read-only: every write goes through the planner, which writes the web's own
// fields (`startDate`, `startTime`, `timeBucket`, …) so what it sends and what
// it shows can't disagree. `isHabit` and `typeName` come from DsulCore.
extension Item {
    /// `startDate` as a day: the day a task is on (or a recurring task's
    /// anchor). Nil is the braindump, or a habit, which is never date-anchored.
    var day: DayString? {
        guard let start = startDate, !start.isEmpty else { return nil }
        return DayString(start)
    }

    /// `startTime` ("HH:mm") as minutes after midnight. Nil when untimed, or
    /// when the text isn't a time of day the grid can draw.
    var startMin: Int? {
        guard let time = startTime else { return nil }
        let parts = time.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 2, let h = Int(parts[0]), let m = Int(parts[1]),
              (0..<24).contains(h), (0..<60).contains(m)
        else { return nil }
        return h * 60 + m
    }

    /// The block length: `duration`, or the type's `defaultBlockMinutes`
    /// (lib/item-registry.ts), as day-schedule.tsx sizes a block.
    var durationMin: Int {
        return duration ?? caps(typeName).defaultBlockMinutes
    }

    /// `timeBucket` when it is one of the four; nil (shows in no bucket) for
    /// none, and for free text the web can't file either.
    var bucket: DayBucket? {
        guard let raw = timeBucket else { return nil }
        return DayBucket(rawValue: raw)
    }

    /// A one-off item's scalar status is its type's done status. Recurring
    /// rows are done per date: ask the planner's `isDone` (DsulCore
    /// `isRowDone`), never this.
    var done: Bool {
        return status == caps(typeName).doneStatus
    }

    /// Repeats (lib/recurrence.ts `isRecurring` over the repeat fields): done,
    /// skipped and ticked per date. False for a one-off, which is done once,
    /// by its status.
    var recurs: Bool {
        return isRecurring(RepeatRule(frequency: repeatFrequency, days: repeatDays, monthDay: repeatMonthDay))
    }

    /// A subtask: `parentItemId` set (JavaScript's truthiness, so "" is none).
    /// It shows only inside its parent, and is never skipped, carried or
    /// paused on its own.
    var isSubtask: Bool {
        guard let parent = parentItemId else { return false }
        return !parent.isEmpty
    }
}
