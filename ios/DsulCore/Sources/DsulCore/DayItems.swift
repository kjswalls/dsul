import Foundation

// Port of what decides a day's rows on the web, over the real `Item`:
// - the task/habit split (lib/planner-store.ts `projectItems`);
// - `deriveDayItems` and `flattenDayRows` (lib/day-items.ts), with the phone's
//   defaults: no canvas filters, `typeFilter` 'all', no goal clause;
// - `deriveTimedEntries` (components/views/day-schedule.tsx);
// - braindump membership (lib/braindump-members.ts `braindumpMembers`);
// - routine grouping (lib/grouping.ts `routineGroups`, via `groupRows`).
// Keep in step: a change there without the same change here is drift. Checked
// against the web by DayItemsFixtureTests (tests/fixtures/day/day-items.json,
// timed.json, braindump.json, routine-groups.json).
//
// Where the two must differ: a `timeBucket` or `startTime` the web can't read
// (free text like "noon", or not "HH:mm") throws or sorts as NaN there; here
// the row is left out of the bucket or the grid instead.
// DayBuckets.swift is the older, id-only port of the bucket filing.

/// lib/planner-store.ts `projectItems`: `tasks` is every task-LIKE item
/// (custom types included) that is not a subtask; `habits` is every habit.
/// Today reads these two, never `items` directly.
public func project(_ items: [Item]) -> (tasks: [Item], habits: [Item]) {
    let tasks = items.filter { !$0.isHabit && ($0.parentItemId ?? "").isEmpty }
    let habits = items.filter { $0.isHabit }
    return (tasks: tasks, habits: habits)
}

/// lib/day-items.ts `DayItems`: one day's rows, filed by bucket.
public struct DayItems: Sendable, Hashable {
    /// Every bucket has an entry, empty or not.
    public var tasksByBucket: [DayBucket: [Item]]
    public var habitsByBucket: [DayBucket: [Item]]
    /// Projects with a recurring time block that lands on this day.
    public var recurringProjects: [Project]

    public init(tasksByBucket: [DayBucket: [Item]], habitsByBucket: [DayBucket: [Item]], recurringProjects: [Project]) {
        self.tasksByBucket = tasksByBucket
        self.habitsByBucket = habitsByBucket
        self.recurringProjects = recurringProjects
    }

    /// lib/day-items.ts `DayItems.totalCount`.
    public var totalCount: Int {
        return bucketOrder.reduce(0) { n, b in n + (tasksByBucket[b]?.count ?? 0) + (habitsByBucket[b]?.count ?? 0) }
    }
}

/// A non-empty string, or nil: JavaScript's truthiness for the optional text
/// columns these rules test (`if (!task.startDate)`, `.filter(t => t.timeBucket)`).
private func nonEmpty(_ s: String?) -> String? {
    guard let s = s, !s.isEmpty else { return nil }
    return s
}

/// lib/day-items.ts `byTimeThenOrder`, stable as JavaScript's sort is: timed
/// rows first by `startTime` ("HH:mm" compares as text), then untimed by `order`.
private func sortedItemsByTimeThenOrder(_ rows: [Item]) -> [Item] {
    let indexed = Array(rows.enumerated())
    let sorted = indexed.sorted { a, b in
        let x = a.element
        let y = b.element
        switch (nonEmpty(x.startTime), nonEmpty(y.startTime)) {
        case let (s?, t?):
            if s != t { return s < t }
        case (.some, nil):
            return true
        case (nil, .some):
            return false
        case (nil, nil):
            let ox = x.order ?? 0
            let oy = y.order ?? 0
            if ox != oy { return ox < oy }
        }
        return a.offset < b.offset
    }
    return sorted.map(\.element)
}

/// lib/day-items.ts `deriveDayItems`, with no filters and `typeFilter` 'all'.
///
/// - `tasks`/`habits`: the two halves of `project(_:)`.
/// - `date`: the selected day, already resolved in the user's zone.
/// - `timeZone`: the user's zone. Unused by the rules themselves, as on the web
///   (the recurrence functions take it and never read it).
/// - `inactive`: `inactiveItemIdsOn` for the same `date`.
///
/// A task shows when it is not suppressed, not hidden as done
/// (`showCompletedTasks` off hides 'completed', never 'cancelled'), has a start
/// date, and either starts that day or, recurring, has its series on that day
/// (`anchoredSeriesOn`). A habit shows when it is not suppressed and its repeat
/// falls on that day; a habit is never hidden for being done or skipped. Rows
/// with no bucket are dropped.
public func deriveDayItems(
    tasks: [Item],
    habits: [Item],
    projects: [Project],
    date: DayString,
    timeZone: String,
    showCompletedTasks: Bool,
    inactive: Set<UUID>
) -> DayItems {
    let dateStr = date.description
    let hideDoneTasks = !showCompletedTasks

    let dayTasks: [Item] = tasks.filter { task in
        if inactive.contains(task.id) { return false }
        if hideDoneTasks && task.status == "completed" { return false }
        guard let startDate = nonEmpty(task.startDate) else { return false }
        // startDate is yyyy-MM-dd; tolerate legacy ISO strings.
        let start = toDateOnly(startDate)
        if isRecurring(task.rule) {
            // lib/recurrence.ts `anchoredSeriesOn`, on the strings as given.
            let anchor = String(start.prefix(10))
            if anchor > dateStr { return false }
            if anchor != dateStr && !shouldShowOnDate(task.rule, on: date) { return false }
            if hideDoneTasks && isCompletedOnDate(task.completedDates, date) { return false }
            return true
        }
        return start == dateStr
    }

    let dayHabits: [Item] = habits.filter { habit in
        if inactive.contains(habit.id) { return false }
        return shouldShowOnDate(habit.rule, on: date)
    }

    var tasksByBucket: [DayBucket: [Item]] = [:]
    var habitsByBucket: [DayBucket: [Item]] = [:]
    for bucket in bucketOrder {
        tasksByBucket[bucket] = []
        habitsByBucket[bucket] = []
    }
    for task in sortedItemsByTimeThenOrder(dayTasks.filter { nonEmpty($0.timeBucket) != nil }) {
        if let bucket = DayBucket(rawValue: task.timeBucket ?? "") { tasksByBucket[bucket, default: []].append(task) }
    }
    for habit in sortedItemsByTimeThenOrder(dayHabits.filter { nonEmpty($0.timeBucket) != nil }) {
        if let bucket = DayBucket(rawValue: habit.timeBucket ?? "") { habitsByBucket[bucket, default: []].append(habit) }
    }

    // Projects whose recurring time block lands on this day. The weekday and
    // month-day rule lives on the project row and is NOT shouldShowOnDate: a
    // monthly block with no month day reads `|| 1` (the 1st), where a monthly
    // item with none shows nowhere. Both rules, as the web writes them.
    let weekday = date.weekday
    let recurringProjects: [Project] = projects.filter { p in
        guard nonEmpty(p.startTime) != nil, nonEmpty(p.timeBucket) != nil,
              let frequency = nonEmpty(p.repeatFrequency)
        else { return false }
        switch frequency {
        case "daily":
            return true
        case "weekdays":
            return weekday >= 1 && weekday <= 5
        case "weekends":
            return weekday == 0 || weekday == 6
        case "monthly":
            let target = (p.repeatMonthDay ?? 0) == 0 ? 1 : (p.repeatMonthDay ?? 1)
            return date.day == min(target, date.daysInMonth)
        default:
            // 'custom', and 'weekly' (legacy free text on some rows), and anything else.
            return p.repeatDays?.contains(weekday) ?? false
        }
    }

    return DayItems(tasksByBucket: tasksByBucket, habitsByBucket: habitsByBucket, recurringProjects: recurringProjects)
}

/// lib/day-items.ts `flattenDayRows`: habits first, then tasks, each in bucket
/// order and time order within a bucket. The order grouping starts from.
public func flattenDayRows(_ day: DayItems) -> [Item] {
    let habits = bucketOrder.flatMap { day.habitsByBucket[$0] ?? [] }
    let tasks = bucketOrder.flatMap { day.tasksByBucket[$0] ?? [] }
    return habits + tasks
}

/// components/views/day-schedule.tsx `TimedEntry`: one block on the grid.
public struct TimedEntry: Sendable, Hashable {
    public var item: Item
    /// Minutes after midnight.
    public var startMin: Int
    /// Minutes.
    public var duration: Int

    public init(item: Item, startMin: Int, duration: Int) {
        self.item = item
        self.startMin = startMin
        self.duration = duration
    }
}

/// day-schedule.tsx `toMin`: "HH:mm" → minutes. Nil where the web would get NaN.
func minutesOf(_ time: String) -> Int? {
    let parts = time.split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count >= 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
    return h * 60 + m
}

/// components/views/day-schedule.tsx `deriveTimedEntries`: timed habits, timed
/// tasks not in a project block, then each task in a project block at its
/// project's `startTime` for the project's `duration ?? 60`. An item's own
/// length is `duration ?? defaultBlockMinutes` (so a 0 stays 0). Sorted by
/// start, stably.
public func deriveTimedEntries(_ day: DayItems) -> [TimedEntry] {
    let allTasks = bucketOrder.flatMap { day.tasksByBucket[$0] ?? [] }
    let allHabits = bucketOrder.flatMap { day.habitsByBucket[$0] ?? [] }
    var entries: [TimedEntry] = []
    for habit in allHabits {
        guard let time = nonEmpty(habit.startTime), let start = minutesOf(time) else { continue }
        entries.append(TimedEntry(item: habit, startMin: start, duration: habit.duration ?? caps(habit.typeName).defaultBlockMinutes))
    }
    for task in allTasks where task.inProjectBlock != true {
        guard let time = nonEmpty(task.startTime), let start = minutesOf(time) else { continue }
        entries.append(TimedEntry(item: task, startMin: start, duration: task.duration ?? caps(task.typeName).defaultBlockMinutes))
    }
    for p in day.recurringProjects {
        guard let time = nonEmpty(p.startTime), let start = minutesOf(time) else { continue }
        for task in allTasks where task.inProjectBlock == true && task.project == p.name {
            entries.append(TimedEntry(item: task, startMin: start, duration: p.duration ?? 60))
        }
    }
    let indexed = Array(entries.enumerated())
    return indexed.sorted { a, b in
        if a.element.startMin != b.element.startMin { return a.element.startMin < b.element.startMin }
        return a.offset < b.offset
    }.map(\.element)
}

/// lib/braindump-members.ts `braindumpMembers`: tasks with no `isScheduled`
/// and no bucket, then habits with no bucket and no repeat, minus `suppressed`.
/// The caller resolves `suppressed` at TODAY, never the selected day: the
/// braindump has no date of its own, so a paused row must not come and go as
/// the user walks the week. `startDate` is not consulted.
public func braindumpMembers(tasks: [Item], habits: [Item], suppressed: Set<UUID>) -> [Item] {
    let unscheduledTasks = tasks.filter { task in
        if suppressed.contains(task.id) { return false }
        if task.isScheduled == true || nonEmpty(task.timeBucket) != nil { return false }
        return true
    }
    let unscheduledHabits = habits.filter { habit in
        if suppressed.contains(habit.id) { return false }
        if nonEmpty(habit.timeBucket) != nil { return false }
        if let f = nonEmpty(habit.repeatFrequency), f != "none" { return false }
        return true
    }
    return unscheduledTasks + unscheduledHabits
}

/// lib/grouping.ts `routineGroups` (`groupRows(rows, 'routine', …)`): ONE row,
/// ONE group. An item in several routines lands in the first that claims it, in
/// `routines` order; inside a group, rows follow the routine's own sequence.
/// Routines that claim none of `rows` are left out; `loose` keeps the input
/// order. Grouped by routine id, so two routines sharing a name stay two groups.
public func routineGroups(_ rows: [Item], routines: [Routine]) -> (groups: [(Routine, [Item])], loose: [Item]) {
    var claimed: [UUID: (routineId: String, rank: Int)] = [:]
    for (i, routine) in routines.enumerated() {
        for (rank, id) in routine.itemIds.enumerated() where claimed[id] == nil {
            claimed[id] = (routineId: routine.id, rank: i * 1_000_000 + rank)
        }
    }

    var members: [String: [(offset: Int, item: Item)]] = [:]
    var loose: [Item] = []
    for (offset, row) in rows.enumerated() {
        if let claim = claimed[row.id] {
            members[claim.routineId, default: []].append((offset: offset, item: row))
        } else {
            loose.append(row)
        }
    }

    var groups: [(Routine, [Item])] = []
    for routine in routines {
        guard let list = members[routine.id], !list.isEmpty else { continue }
        let ordered = list.sorted { a, b in
            let ra = claimed[a.item.id]?.rank ?? 0
            let rb = claimed[b.item.id]?.rank ?? 0
            if ra != rb { return ra < rb }
            return a.offset < b.offset
        }
        groups.append((routine, ordered.map { $0.item }))
    }
    return (groups: groups, loose: loose)
}
