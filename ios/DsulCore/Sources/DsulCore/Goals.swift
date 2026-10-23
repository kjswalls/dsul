import Foundation

// Port of lib/goals.ts, everything derived about a goal, stated once. Keep in
// step: a change there without the same change here is drift, and the phone
// says a goal is further along (or further behind) than the web does. Checked
// against the web by GoalsFixtureTests (tests/fixtures/organize/goals.json).
//
// From O1 (Organize's list): `isAchieved`, `goalProgress` and its words
// (`progressLabel`), `isGoalActive` and `sortGoalsForDisplay`. From O3 (the
// goal page): `nextMilestone`, `timeElapsed` and its words, `goalCountdown`,
// `milestoneState` and `milestoneTimeline`, `goalMemberGroups`,
// `windDownMembers` and `lastDoneOn`. From O8b (the goal's Status chip):
// `resolveGoalStateWrite`, the step ContainerIntent.swift takes for a goal's
// `state`, pinned through container-writes.json. Every word a date takes is
// `formatDay`'s ("Nov 4", Cadence.swift), and nothing is ever "overdue" in
// words: a late checkpoint is "still ahead of you" (the guilt-free law).
//
// Progress is derived on every read and never stored. "Done" is the item
// type's own terminal status (`caps(_:).doneStatus`, Registry.swift), so a
// custom type ticked "completed" counts and one marked "done" does not.

/// lib/goals.ts `GoalProgress`: milestones achieved out of milestones defined.
public struct GoalProgress: Sendable, Hashable {
    public var achieved: Int
    public var total: Int
    /// Nil when there is nothing to measure: never 0, which reads as "none done".
    public var fraction: Double?

    public init(achieved: Int, total: Int, fraction: Double?) {
        self.achieved = achieved
        self.total = total
        self.fraction = fraction
    }
}

/// lib/goals.ts `isAchieved`: has this one-shot item reached its type's
/// terminal status?
public func isAchieved(_ item: Item) -> Bool {
    return item.status == caps(item.typeName).doneStatus
}

/// lib/goals.ts `goalProgress`. `itemsById` holds the LIVE items only, so a
/// trashed milestone (its join row outlives the soft delete) leaves both
/// sides; a cancelled one leaves both sides too, a dropped checkpoint rather
/// than a failed one. Only `milestoneIds` count: check-ins and supporting
/// work are not progress.
public func goalProgress(_ goal: Goal, itemsById: [UUID: Item]) -> GoalProgress {
    var achieved = 0
    var total = 0
    for id in goal.milestoneIds {
        guard let item = itemsById[id] else { continue }
        if item.status == "cancelled" { continue }
        total += 1
        if isAchieved(item) { achieved += 1 }
    }
    return GoalProgress(achieved: achieved, total: total, fraction: total == 0 ? nil : Double(achieved) / Double(total))
}

/// `goalProgress` over a list of live items, indexed as the web's
/// `new Map(items.map(i => [i.id, i]))` would be (a repeated id keeps the
/// last).
public func goalProgress(_ goal: Goal, items: [Item]) -> GoalProgress {
    let byId = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    return goalProgress(goal, itemsById: byId)
}

/// lib/goals.ts `progressLabel`: "No milestones yet", "2/5", or "2/2 so far"
/// while the goal is still active (everything defined SO FAR is done, not
/// the goal); an ended goal's full fraction is bare.
public func progressLabel(_ goal: Goal, achieved: Int, total: Int) -> String {
    if total == 0 { return "No milestones yet" }
    let bare = "\(achieved)/\(total)"
    if !isGoalActive(goal) { return bare }
    return achieved == total ? "\(bare) so far" : bare
}

/// `progressLabel` for a computed `GoalProgress`.
public func progressLabel(_ goal: Goal, _ progress: GoalProgress) -> String {
    return progressLabel(goal, achieved: progress.achieved, total: progress.total)
}

/// lib/goals.ts `isGoalActive`: still live work, as opposed to a record of
/// finished work ('achieved', or 'abandoned', which the web words "Set
/// aside").
public func isGoalActive(_ goal: Goal) -> Bool {
    return goal.state == "active"
}

/// lib/goals.ts `sortGoalsForDisplay`: active goals first, then the ended
/// ones, each half in the order it came (the payload's `sort_order`). A
/// stable partition, never a re-sort by `sortOrder`.
public func sortGoalsForDisplay(_ goals: [Goal]) -> [Goal] {
    return goals.filter { isGoalActive($0) } + goals.filter { !isGoalActive($0) }
}

/* ── the state write (O8b) ─────────────────────────────────────────────── */

/// packages/types `GoalStateSchema`: the three values a goal's `state` is
/// written as. `Goal.state` stays a string, read as the web reads it; an
/// intent only ever sends one of these.
public enum GoalState: String, Sendable, Hashable, CaseIterable {
    /// Still live work ("Active").
    case active
    /// Reached ("Achieved"): stamps `achievedAt`.
    case achieved
    /// Set aside ("Set aside"): keeps whatever stamp it had.
    case abandoned
}

/// lib/goals.ts `resolveGoalStateWrite`'s answer: the goal columns a Status
/// pick writes. A field left nil is not written; `achievedAt` `.clear` writes
/// NULL. Empty means write nothing.
public struct GoalStatePatch: Sendable, Hashable {
    public var state: GoalState?
    public var achievedAt: ColumnWrite?

    public init(state: GoalState? = nil, achievedAt: ColumnWrite? = nil) {
        self.state = state
        self.achievedAt = achievedAt
    }

    public var isEmpty: Bool { state == nil && achievedAt == nil }
}

/// lib/goals.ts `resolveGoalStateWrite`: what picking `state` writes to
/// `goal` at the instant `nowISO`. The state it already has (compared as
/// stored) writes nothing, so a goal achieved twice keeps its first
/// `achievedAt`; Achieved stamps `nowISO`; Active clears the stamp; Set aside
/// keeps whatever stamp it had (a strange history, but the user's).
public func resolveGoalStateWrite(_ goal: Goal, state: GoalState, nowISO: String) -> GoalStatePatch {
    if goal.state == state.rawValue { return GoalStatePatch() }
    switch state {
    case .achieved: return GoalStatePatch(state: state, achievedAt: .set(nowISO))
    case .active: return GoalStatePatch(state: state, achievedAt: .clear)
    case .abandoned: return GoalStatePatch(state: state)
    }
}

/* ── the window and the countdown ───────────────────────────────────────── */

/// The day number JavaScript's `Date.parse(`${day}T00:00:00Z`)` gives `day`,
/// in whole days since 1970-01-01, or nil where it gives NaN. V8 takes
/// exactly "yyyy-MM-dd" with a month of 1 to 12 and a day of 1 to 31, and
/// rolls an overlong day into the next month ("2026-02-30" is Mar 2).
private func jsDayNumber(_ day: String) -> Int? {
    let b = Array(day.utf8)
    guard b.count == 10, b[4] == UInt8(ascii: "-"), b[7] == UInt8(ascii: "-") else { return nil }
    func number(_ range: Range<Int>) -> Int? {
        var n = 0
        for i in range {
            guard b[i] >= 48 && b[i] <= 57 else { return nil }
            n = n * 10 + Int(b[i] - 48)
        }
        return n
    }
    guard let year = number(0..<4), let month = number(5..<7), let dayOfMonth = number(8..<10),
          (1...12).contains(month), (1...31).contains(dayOfMonth)
    else { return nil }
    return daysFromCivil(year, month, dayOfMonth)
}

/// lib/goals.ts `timeElapsed`: how far through its own window the goal is,
/// 0...1, or nil with no window (a missing start or target, or a target not
/// after the start). The days compare as text first, as the web's do; a day
/// the web's `Date.parse` cannot read (it would answer NaN) is no window
/// here.
public func timeElapsed(_ goal: Goal, today: DayString) -> Double? {
    guard let starts = goal.startsOn, !starts.isEmpty, let target = goal.targetOn, !target.isEmpty else { return nil }
    let start = toDateOnly(starts)
    let end = toDateOnly(target)
    if end <= start { return nil }
    let now = today.description
    if now <= start { return 0 }
    if now >= end { return 1 }
    guard let s = jsDayNumber(start), let e = jsDayNumber(end), let t = jsDayNumber(now) else { return nil }
    // The web divides milliseconds; whole days give the same IEEE quotient.
    return Double(t - s) / Double(e - s)
}

/// lib/goals.ts `timeElapsedLabel`: "40% of the way to Mar 15", or nil with
/// no window. The caller shows it only beside at least one milestone.
/// Rounded half up, as `Math.round` does a non-negative number.
public func timeElapsedLabel(_ goal: Goal, today: DayString) -> String? {
    guard let elapsed = timeElapsed(goal, today: today), let target = goal.targetOn else { return nil }
    let percent = Int((elapsed * 100).rounded(.toNearestOrAwayFromZero))
    return "\(percent)% of the way to \(formatDay(target))"
}

/// lib/goals.ts `goalCountdown`: "12 days to Nov 4", "1 day to Oct 24",
/// "target is today" or "3 days past Oct 20"; nil unless the goal is active
/// with a target. Past the target is a count, never an alarm. A target the
/// web's `Date.parse` cannot read (it would print "NaN days past") is no
/// target here.
public func goalCountdown(_ goal: Goal, today: DayString) -> String? {
    guard let target = goal.targetOn, !target.isEmpty, isGoalActive(goal) else { return nil }
    guard let end = jsDayNumber(toDateOnly(target)), let now = jsDayNumber(today.description) else { return nil }
    let days = end - now
    func count(_ k: Int) -> String { return "\(k) \(k == 1 ? "day" : "days")" }
    if days > 0 { return "\(count(days)) to \(formatDay(target))" }
    if days == 0 { return "target is today" }
    return "\(count(-days)) past \(formatDay(target))"
}

/* ── the next milestone and the timeline ────────────────────────────────── */

/// lib/goals.ts `targetDayOf`: a milestone's target day (its `startDate`,
/// a legacy timestamp read as its day), or nil when it has none.
private func targetDayOf(_ item: Item) -> String? {
    guard let start = item.startDate, !start.isEmpty else { return nil }
    return toDateOnly(start)
}

/// lib/goals.ts `byTargetDay`, as a stable sort: dated first by date, then
/// the undated in their stored order. Equal dates keep their order too.
private func sortedByTargetDay(_ items: [Item]) -> [Item] {
    return items.enumerated().sorted { a, b in
        switch (targetDayOf(a.element), targetDayOf(b.element)) {
        case let (da?, db?):
            if da != db { return da < db }
        case (.some, nil):
            return true
        case (nil, .some):
            return false
        case (nil, nil):
            break
        }
        return a.offset < b.offset
    }.map(\.element)
}

/// lib/goals.ts `nextMilestone`: the checkpoint to aim at, the earliest
/// un-achieved milestone (dated first by date, then undated in stored
/// order). Cancelled and trashed (absent from `itemsById`) milestones are
/// not candidates. An ended goal still has one.
public func nextMilestone(_ goal: Goal, itemsById: [UUID: Item]) -> Item? {
    let open = goal.milestoneIds.compactMap { itemsById[$0] }.filter { item in
        item.status != "cancelled" && !isAchieved(item)
    }
    return sortedByTargetDay(open).first
}

/// lib/goals.ts `MilestoneState`: where one milestone stands.
public enum MilestoneState: String, Sendable, Hashable, CaseIterable {
    case achieved, next, overdue, dropped, ahead
}

/// lib/goals.ts `milestoneState`. Dropped (cancelled) first, then achieved,
/// then next, then overdue (dated before today), else ahead. `next` outranks
/// `overdue` on purpose: the earliest open checkpoint of a goal that has
/// slipped is both, and it must still be pointed at. Lateness shows in the
/// timeline's words instead.
public func milestoneState(_ item: Item, isNext: Bool, today: DayString) -> MilestoneState {
    if item.status == "cancelled" { return .dropped }
    if isAchieved(item) { return .achieved }
    if isNext { return .next }
    if let date = targetDayOf(item), date < today.description { return .overdue }
    return .ahead
}

/// lib/goals.ts `MilestoneRow`: one row of a goal's timeline.
public struct MilestoneRow: Sendable, Hashable {
    public var item: Item
    public var state: MilestoneState
    /// The target day as stored (a legacy timestamp stays one), or nil.
    public var date: String?
    /// Dated before today, whatever the state: a reached row may be late too.
    public var late: Bool
    /// "Oct 4", or "No date yet".
    public var dateLabel: String
    /// The caption's notes after the date, each drawn "· {note}": "reached",
    /// "next up", "still ahead of you", "dropped". Never "overdue".
    public var annotations: [String]

    public init(item: Item, state: MilestoneState, date: String?, late: Bool, dateLabel: String, annotations: [String]) {
        self.item = item
        self.state = state
        self.date = date
        self.late = late
        self.dateLabel = dateLabel
        self.annotations = annotations
    }
}

/// lib/goals.ts `milestoneTimeline`: the checkpoints in the order they are
/// meant to happen (`nextMilestone`'s order). Trashed ones are left out; a
/// dropped one stays, as part of the record. "still ahead of you" goes on
/// an overdue row, and on the next row when it is late.
public func milestoneTimeline(_ goal: Goal, itemsById: [UUID: Item], today: DayString) -> [MilestoneRow] {
    let next = nextMilestone(goal, itemsById: itemsById)
    let now = today.description
    return sortedByTargetDay(goal.milestoneIds.compactMap { itemsById[$0] }).map { item in
        let state = milestoneState(item, isNext: item.id == next?.id, today: today)
        let date = item.startDate
        let dated = date.map { !$0.isEmpty } ?? false
        let late = dated && toDateOnly(date!) < now
        var annotations: [String] = []
        if state == .achieved { annotations.append("reached") }
        if state == .next { annotations.append("next up") }
        if state == .overdue || (state == .next && late) { annotations.append("still ahead of you") }
        if state == .dropped { annotations.append("dropped") }
        return MilestoneRow(
            item: item, state: state, date: date, late: late,
            dateLabel: dated ? formatDay(date!) : "No date yet", annotations: annotations
        )
    }
}

/* ── the supporting work, the wind-down, the check-ins ──────────────────── */

/// One heading of `goalMemberGroups`: a type and its members.
public struct GoalMemberGroup: Sendable, Hashable {
    /// `Item.typeName`: "task", "habit", or a custom slug. The heading is
    /// its plural (`typeLabelPlural`, Registry.swift).
    public var typeName: String
    public var items: [Item]

    public init(typeName: String, items: [Item]) {
        self.typeName = typeName
        self.items = items
    }
}

/// lib/goals.ts `goalMemberGroups`: members grouped by type, each group in
/// the order its first member appears and its members in `ids` order.
/// Trashed ids are skipped.
public func goalMemberGroups(_ ids: [UUID], itemsById: [UUID: Item]) -> [GoalMemberGroup] {
    var groups: [GoalMemberGroup] = []
    var index: [String: Int] = [:]
    for id in ids {
        guard let item = itemsById[id] else { continue }
        let name = item.typeName
        if let i = index[name] {
            groups[i].items.append(item)
        } else {
            index[name] = groups.count
            groups.append(GoalMemberGroup(typeName: name, items: [item]))
        }
    }
    return groups
}

/// lib/goals.ts `windDownMembers`: an ended goal's members that still come
/// round (check-ins, then supporting work, then milestones; recurring only;
/// trashed skipped). The goal changes none of them.
public func windDownMembers(_ goal: Goal, itemsById: [UUID: Item]) -> [Item] {
    return (goal.checkinIds + goal.memberIds + goal.milestoneIds)
        .compactMap { itemsById[$0] }
        .filter { isRecurring($0.rule) }
}

/// lib/goals.ts `lastDoneOn`: the latest day a recurring item was done
/// (yyyy-MM-dd sorts as text), or nil. An empty entry is replaced by the next
/// one, as JavaScript's falsy `!max` has it.
public func lastDoneOn(_ item: Item) -> String? {
    var latest: String? = nil
    for d in item.completedDates {
        if let current = latest, !current.isEmpty, !(d > current) { continue }
        latest = d
    }
    return latest
}
