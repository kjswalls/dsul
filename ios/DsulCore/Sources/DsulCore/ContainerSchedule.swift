import Foundation

// Port of lib/container-schedule.ts, who a container answers for. Keep in
// step: a change there without the same change here is drift, and the
// phone's count of a container's items disagrees with the web's. Checked
// against the web by ScheduleFixtureTests
// (tests/fixtures/organize/schedule.json).
//
// From O1 (Organize's list): `containerMemberIds`, for the counts. From O2
// (the container pages): the schedule itself, `deriveContainerSchedule`, the
// grid's answer for each day narrowed to the members (DayItems.swift's
// `deriveDayItems` fed `inactiveItemIdsOn` for the same day), and the numbers
// a list or a strip says over it: `occurrencesByItem`, `weekTotals`,
// `todayCount`, `dayRollup` and `todayInOrder`. `weekStartOf` is already in
// Cadence.swift and day arithmetic is `DayString.adding(days:)`, so neither is
// repeated. Not ported: `weekBuckets` and `daysBetween`, which no phone
// surface asks.
//
// The guilt-free law lives here. The app stores no creation date and no
// membership dates, so a past day's "due and not done" is not knowable: the
// only honest past states are what was RECORDED (`done`, `skipped`), and
// everything else in the past is `open`, never "missed". A reader draws a
// past day from what was recorded, and only today as a share.
//
// A project holds items BY NAME (`items.project`), folded as every project
// lookup is (lib/container-registry.ts `sameContainerName`: `toLowerCase`, so
// `jsLowercased`, and never a trim), and compared code unit by code unit as
// JavaScript's `===` does.

/// The four container kinds Organize lists (lib/container-schedule.ts
/// `ScheduleContainer`'s `kind`, lib/container-registry.ts' kinds). Not the
/// item sheet's `ContainerKind` (ItemEdit.swift), which names only the two
/// membership kinds an item meets there.
public enum OrganizeKind: String, Hashable, CaseIterable, Sendable {
    case routine, season, goal, project
}

/// lib/container-schedule.ts `ScheduleContainer`: one container, whole.
public enum ScheduleContainer: Sendable, Hashable {
    case routine(Routine)
    case season(Season)
    case goal(Goal)
    case project(Project)

    public var kind: OrganizeKind {
        switch self {
        case .routine: return .routine
        case .season: return .season
        case .goal: return .goal
        case .project: return .project
        }
    }
}

/// lib/container-schedule.ts `containerMemberIds`: the item ids a container
/// answers for, ids of trashed items included (count them with `countLive`).
/// - a routine: its `itemIds`, in its own order;
/// - a season: its own `itemIds`, then each held routine's in `routineIds`
///   order (a routine not in `routines` is skipped), each id once, first
///   seen first;
/// - a goal: milestones, then check-ins, then supporting work, as stored;
/// - a project: the items in `items` whose `project` folds equal to its
///   name, in `items` order, done items and subtasks included. An empty
///   name is no project.
public func containerMemberIds(_ container: ScheduleContainer, items: [Item], routines: [Routine]) -> [UUID] {
    switch container {
    case .routine(let routine):
        return routine.itemIds
    case .season(let season):
        var seen = Set<UUID>()
        var ids: [UUID] = []
        func add(_ id: UUID) {
            if seen.insert(id).inserted { ids.append(id) }
        }
        season.itemIds.forEach(add)
        for routineId in season.routineIds {
            routines.first { $0.id == routineId }?.itemIds.forEach(add)
        }
        return ids
    case .goal(let goal):
        return goal.milestoneIds + goal.checkinIds + goal.memberIds
    case .project(let project):
        let folded = Array(jsLowercased(project.name).utf16)
        return items.filter { item in
            guard let name = item.project, !name.isEmpty else { return false }
            return jsLowercased(name).utf16.elementsEqual(folded)
        }.map(\.id)
    }
}

/* ── the derivation ─────────────────────────────────────────────────────── */

/// lib/container-schedule.ts `OccurrenceState`.
/// - `done` / `skipped`: recorded on that day;
/// - `due`: today or later, not yet marked;
/// - `open`: an earlier day with nothing recorded. NOT a claim that it was
///   missed: a reader never counts it as owed.
public enum OccurrenceState: String, Sendable, Hashable, CaseIterable {
    case done, skipped, due, open
}

/// lib/container-schedule.ts `ScheduleOccurrence`: one member on one day.
public struct ScheduleOccurrence: Sendable, Hashable {
    public var itemId: UUID
    public var date: DayString
    public var state: OccurrenceState
    /// A one-off (non-recurring) item.
    public var once: Bool

    public init(itemId: UUID, date: DayString, state: OccurrenceState, once: Bool) {
        self.itemId = itemId
        self.date = date
        self.state = state
        self.once = once
    }
}

/// lib/container-schedule.ts `ScheduleDay`: one day, its members in the
/// grid's order (habits, then tasks, each by bucket and time).
public struct ScheduleDay: Sendable, Hashable {
    public var date: DayString
    public var occurrences: [ScheduleOccurrence]
    /// A project's recurring time block, on the days it lands, when the
    /// container is that project (`block` was passed).
    public var block: Project?

    public init(date: DayString, occurrences: [ScheduleOccurrence], block: Project? = nil) {
        self.date = date
        self.occurrences = occurrences
        self.block = block
    }
}

/// lib/container-schedule.ts `ContainerSchedule`.
public struct ContainerSchedule: Sendable, Hashable {
    public var days: [ScheduleDay]
    /// Members with no date at all: one-off work waiting in the braindump.
    public var unscheduled: [Item]

    public init(days: [ScheduleDay], unscheduled: [Item]) {
        self.days = days
        self.unscheduled = unscheduled
    }
}

/// lib/container-schedule.ts `ScheduleSource`: everything activation and the
/// grid resolve against. `routines`, `seasons` and `away` are the live ones,
/// and a draft container may be among them.
public struct ScheduleSource: Sendable, Hashable {
    public var items: [Item]
    /// `project(items).tasks`: task-like and not a subtask.
    public var tasks: [Item]
    /// `project(items).habits`.
    public var habits: [Item]
    public var routines: [Routine]
    public var seasons: [Season]
    public var away: [AwayPeriod]
    public var timeZone: String

    /// The projections derived from `items`, as the web's store derives them.
    public init(items: [Item], routines: [Routine], seasons: [Season], away: [AwayPeriod] = [], timeZone: String) {
        let split = project(items)
        self.init(
            items: items, tasks: split.tasks, habits: split.habits, routines: routines, seasons: seasons,
            away: away, timeZone: timeZone
        )
    }

    public init(
        items: [Item],
        tasks: [Item],
        habits: [Item],
        routines: [Routine],
        seasons: [Season],
        away: [AwayPeriod] = [],
        timeZone: String
    ) {
        self.items = items
        self.tasks = tasks
        self.habits = habits
        self.routines = routines
        self.seasons = seasons
        self.away = away
        self.timeZone = timeZone
    }
}

/// lib/container-schedule.ts `MAX_SCHEDULE_DAYS`: the longest range a chart
/// may ask for.
public let maxScheduleDays = 400

/// lib/container-schedule.ts `stateOn`: per date for a recurring item, never
/// its scalar status; for a one-off, the type's own done word, and
/// `cancelled` as a recorded decision (skipped), never as due.
private func occurrenceState(_ item: Item, on day: DayString, today: DayString) -> OccurrenceState {
    if isRecurring(item.rule) {
        if isCompletedOnDate(item.completedDates, day) { return .done }
        if isSkippedOnDate(item.skippedDates, day) { return .skipped }
    } else {
        if item.status == caps(item.typeName).doneStatus { return .done }
        if item.status == "cancelled" { return .skipped }
    }
    return day >= today ? .due : .open
}

/// lib/container-schedule.ts `deriveContainerSchedule`: every day from `from`
/// for `days` days (clamped to 0...`maxScheduleDays`), as the grid would draw
/// it, narrowed to `memberIds`. Activation is resolved for the members only,
/// against the whole routine and season lists, with completed one-offs always
/// shown (a finished one-off still happened on its day). `today` is the
/// USER's today.
///
/// `unscheduled` is the braindump's own rule over the members' task
/// projection (so never a subtask): no `isScheduled`, no bucket, not
/// recurring, not done by its type's word, not cancelled, and not held off
/// today.
public func deriveContainerSchedule(
    memberIds: [UUID],
    source: ScheduleSource,
    from: DayString,
    days: Int,
    today: DayString,
    block: Project? = nil
) -> ContainerSchedule {
    let members = Set(memberIds)
    let n = max(0, min(days, maxScheduleDays))
    let tasks = source.tasks.filter { members.contains($0.id) }
    let habits = source.habits.filter { members.contains($0.id) }
    let memberItems = source.items.filter { members.contains($0.id) }
    let projects = block.map { [$0] } ?? []

    func inactive(on day: DayString) -> Set<UUID> {
        return inactiveItemIdsOn(
            items: memberItems, date: day, timeZone: source.timeZone, routines: source.routines,
            seasons: source.seasons, away: source.away
        )
    }

    var out: [ScheduleDay] = []
    out.reserveCapacity(n)
    for i in 0..<n {
        let date = from.adding(days: i)
        let day = deriveDayItems(
            tasks: tasks, habits: habits, projects: projects, date: date, timeZone: source.timeZone,
            showCompletedTasks: true, inactive: inactive(on: date)
        )
        let occurrences = flattenDayRows(day).map { item in
            ScheduleOccurrence(
                itemId: item.id, date: date, state: occurrenceState(item, on: date, today: today),
                once: !isRecurring(item.rule)
            )
        }
        out.append(ScheduleDay(date: date, occurrences: occurrences, block: day.recurringProjects.first))
    }

    let heldToday = inactive(on: today)
    let unscheduled = tasks.filter { t in
        if t.isScheduled == true { return false }
        if let bucket = t.timeBucket, !bucket.isEmpty { return false }
        if isRecurring(t.rule) { return false }
        if t.status == caps(t.typeName).doneStatus || t.status == "cancelled" { return false }
        return !heldToday.contains(t.id)
    }
    return ContainerSchedule(days: out, unscheduled: unscheduled)
}

/* ── the numbers a list or a strip says ─────────────────────────────────── */

/// lib/container-schedule.ts `OccurrencesByItem`: item id → day → occurrence.
/// A dictionary, so it keeps no order (the web's Map iterates in the
/// container's order; nothing here reads that order).
public typealias OccurrencesByItem = [UUID: [DayString: ScheduleOccurrence]]

/// lib/container-schedule.ts `occurrencesByItem`: the schedule's occurrences
/// grouped per member. `memberIds`, when given, seeds an empty row for each,
/// so a member with nothing in range still has one.
public func occurrencesByItem(_ schedule: ContainerSchedule, memberIds: [UUID]? = nil) -> OccurrencesByItem {
    var byItem: OccurrencesByItem = [:]
    for id in memberIds ?? [] { byItem[id] = [:] }
    for day in schedule.days {
        for o in day.occurrences { byItem[o.itemId, default: [:]][o.date] = o }
    }
    return byItem
}

/// lib/container-schedule.ts `weekTotals`' answer.
public struct WeekTotals: Sendable, Hashable {
    public var done: Int
    public var total: Int

    public init(done: Int, total: Int) {
        self.done = done
        self.total = total
    }
}

/// lib/container-schedule.ts `weekTotals`: of the span's occurrences among
/// `ids`, how many count and how many are done. Only `done` and `due` count:
/// a past day with nothing recorded (`open`) is not a miss, and a skip is a
/// decision, not work. An id listed twice counts twice.
public func weekTotals(_ byItem: OccurrencesByItem, ids: [UUID]) -> WeekTotals {
    var done = 0
    var total = 0
    for id in ids {
        for o in (byItem[id] ?? [:]).values {
            if o.state == .skipped || o.state == .open { continue }
            total += 1
            if o.state == .done { done += 1 }
        }
    }
    return WeekTotals(done: done, total: total)
}

/// lib/container-schedule.ts `todayCount`: "1/3 today", of the members on
/// `today`, how many are done; nil when none is on. A member skipped today
/// counts on neither side.
public func todayCount(_ byItem: OccurrencesByItem, ids: [UUID], today: DayString) -> String? {
    var done = 0
    var on = 0
    for id in ids {
        guard let state = byItem[id]?[today]?.state, state != .skipped else { continue }
        on += 1
        if state == .done { done += 1 }
    }
    return on > 0 ? "\(done)/\(on) today" : nil
}

/// lib/container-schedule.ts `DayRollup`: one day of a schedule, counted by
/// state.
public struct DayRollup: Sendable, Hashable {
    public var date: DayString
    public var done: Int
    public var due: Int
    public var open: Int
    public var skipped: Int

    public init(date: DayString, done: Int = 0, due: Int = 0, open: Int = 0, skipped: Int = 0) {
        self.date = date
        self.done = done
        self.due = due
        self.open = open
        self.skipped = skipped
    }
}

/// lib/container-schedule.ts `dayRollup`: each day's occurrences counted by
/// state, in the schedule's day order (the "Last 14 days" strip). Counts,
/// never a share: a past day's `open` is what was never recorded, not what
/// was due, so a reader draws a past day from `done` (or nothing) and only
/// today as `done / (done + due)`. A past day's `due` is always 0.
public func dayRollup(_ schedule: ContainerSchedule) -> [DayRollup] {
    return schedule.days.map { day in
        var r = DayRollup(date: day.date)
        for o in day.occurrences {
            switch o.state {
            case .done: r.done += 1
            case .due: r.due += 1
            case .open: r.open += 1
            case .skipped: r.skipped += 1
            }
        }
        return r
    }
}

/// lib/container-schedule.ts `TodayRun`: today's members of a container, in
/// its own order, and how far through they are.
public struct TodayRun: Sendable, Hashable {
    /// One member on today.
    public struct Row: Sendable, Hashable {
        public var itemId: UUID
        public var state: OccurrenceState

        public init(itemId: UUID, state: OccurrenceState) {
            self.itemId = itemId
            self.state = state
        }
    }

    /// The members on today, ordered by their place in `order`.
    public var rows: [Row]
    public var done: Int
    public var skipped: Int
    /// The first row still `due`: the one a checklist calls "next".
    public var nextId: UUID?
    /// Something is on today and nothing is left due.
    public var finished: Bool

    public init(rows: [Row], done: Int, skipped: Int, nextId: UUID?, finished: Bool) {
        self.rows = rows
        self.done = done
        self.skipped = skipped
        self.nextId = nextId
        self.finished = finished
    }
}

/// lib/container-schedule.ts `todayInOrder`: a routine run top to bottom.
/// The schedule's occurrences on `today`, stably sorted by each member's
/// position in `order` (the routine's `itemIds`). An id listed twice takes
/// its LAST position, and one missing from `order` takes position 0, as the
/// web's `Map` and `?? 0` have it; ties keep the grid's order.
public func todayInOrder(_ schedule: ContainerSchedule, order: [UUID], today: DayString) -> TodayRun {
    var position: [UUID: Int] = [:]
    for (i, id) in order.enumerated() { position[id] = i }
    let occurrences = schedule.days.first { $0.date == today }?.occurrences ?? []
    let rows = occurrences.enumerated().sorted { a, b in
        let pa = position[a.element.itemId] ?? 0
        let pb = position[b.element.itemId] ?? 0
        if pa != pb { return pa < pb }
        return a.offset < b.offset
    }.map { TodayRun.Row(itemId: $0.element.itemId, state: $0.element.state) }
    let done = rows.filter { $0.state == .done }.count
    let skipped = rows.filter { $0.state == .skipped }.count
    let nextId = rows.first { $0.state == .due }?.itemId
    return TodayRun(rows: rows, done: done, skipped: skipped, nextId: nextId, finished: !rows.isEmpty && nextId == nil)
}
