import Foundation

// Port of lib/organize.ts, the answers Organize needs that no one page owns:
// the summary cards' THIS WEEK (`organizeWeek`) and NEXT MILESTONE
// (`nextMilestoneAcross`), and from O12 and O13 a routine step's new place
// (`moveMemberAfter`) and what putting a routine in a season would hide
// (`wouldHideAttaching`). Keep in step: a change there without the same change
// here is drift, and the phone's week card counts a different week from the
// web's, its step lands somewhere the server's doesn't, or its attach confirm
// counts what the web's doesn't. Checked against the web by
// OrganizeFixtureTests (tests/fixtures/organize/organize.json). The cards'
// words are OrganizeCopy.swift's (`weekCardSentence`, `nextMilestoneLine`), and
// so are the attach confirm's (`attachConfirmTitle`, `attachConfirmDescription`).
//
// Nothing here re-derives "does this want doing". The week is the grid's own
// answer for each day (`deriveContainerSchedule`, ContainerSchedule.swift),
// counted by the rule every member list counts with (`weekTotals`): what is
// done, out of what is done or still ahead. A skip is a decision and a past day
// with nothing recorded is `open`, never a miss, so neither is on either side
// of the card (the guilt-free law). The next milestone is each goal's own
// `nextMilestone` (Goals.swift).
//
// The card's scope is design Q1's default, Kirby's to change: everything the
// grid shows this calendar week, however it is filed.
//
// A step's place is one id moved in a list: the order lib/app-containers.ts
// `moveMember` writes and the phone steps by, so the two agree on every move.
// What an attach hides is the resolver's own answer (`inactiveItemIdsOn`,
// Active.swift) asked with and without the join, never a member count.

/// lib/organize.ts `OrganizeWeek`: the week card's numbers.
public struct OrganizeWeek: Sendable, Hashable {
    /// The week's first day, from the user's Week starts on setting.
    public var from: DayString
    /// Its last day, six days on.
    public var through: DayString
    public var done: Int
    /// What the card's "of" counts: done, plus what is due today or later
    /// (`weekTotals`' `total`). Zero reads "Nothing on this week".
    public var counted: Int

    public init(from: DayString, through: DayString, done: Int, counted: Int) {
        self.from = from
        self.through = through
        self.done = done
        self.counted = counted
    }

    /// The bar's fill, `done / counted`, or nil when nothing is counted (the
    /// card then shows no bar).
    public var fraction: Double? {
        return counted > 0 ? Double(done) / Double(counted) : nil
    }
}

/// lib/organize.ts `organizeWeek`: how the week is going, across EVERYTHING
/// the grid shows this calendar week, however it is filed. Every task and
/// habit, from the week's first day for seven days, each day the grid's own
/// answer (so a paused item, an off season's items and a trip's rest are not
/// on it), counted done out of done-or-due.
///
/// Subtasks never count: `source.tasks` is the grid's projection, which leaves
/// them out (`ScheduleSource(items:routines:seasons:away:timeZone:)` builds
/// it). A finished one-off counts on its day whatever showCompletedTasks says,
/// as every container chart counts it.
public func organizeWeek(_ source: ScheduleSource, today: DayString, weekStartDay: WeekStartDay) -> OrganizeWeek {
    let from = weekStartOf(today, weekStartDay)
    let ids = source.items.map(\.id)
    let schedule = deriveContainerSchedule(memberIds: ids, source: source, from: from, days: 7, today: today)
    let totals = weekTotals(occurrencesByItem(schedule), ids: ids)
    return OrganizeWeek(
        from: from, through: schedule.days.last?.date ?? from, done: totals.done, counted: totals.total
    )
}

/// lib/organize.ts `MilestoneAcross`: the milestone the summary card points
/// at, and the goal it belongs to.
public struct MilestoneAcross: Sendable, Hashable {
    public var goal: Goal
    public var milestone: Item
    /// Its target day, yyyy-MM-dd (a whole ISO stamp reads as its day), or nil
    /// when it has none.
    public var date: String?

    public init(goal: Goal, milestone: Item, date: String? = nil) {
        self.goal = goal
        self.milestone = milestone
        self.date = date
    }
}

/// lib/organize.ts `nextMilestoneAcross`: the next milestone across every
/// active goal. The earliest DATED one (each goal's own `nextMilestone`), and
/// failing that the first undated one in `sortGoalsForDisplay` order. A tie on
/// the day goes to the goal listed first. Ended goals are passed over, and so
/// is a goal with nothing open. Nil when no active goal has an open milestone,
/// which hides the card.
///
/// A late milestone keeps its date and nothing more, as the goal page's own
/// "next:" line does: there is no countdown to a milestone, only to a goal.
public func nextMilestoneAcross(_ goals: [Goal], itemsById: [UUID: Item]) -> MilestoneAcross? {
    var dated: MilestoneAcross? = nil
    var undated: MilestoneAcross? = nil
    for goal in sortGoalsForDisplay(goals) {
        if !isGoalActive(goal) { continue }
        guard let milestone = nextMilestone(goal, itemsById: itemsById) else { continue }
        // `'startDate' in m && m.startDate ? toDateOnly(m.startDate) : undefined`,
        // then JavaScript's truthiness on the day: empty is undated.
        let date: String? = milestone.startDate.flatMap { $0.isEmpty ? nil : toDateOnly($0) }
        if let date, !date.isEmpty {
            if dated == nil || date < (dated?.date ?? "") {
                dated = MilestoneAcross(goal: goal, milestone: milestone, date: date)
            }
        } else if undated == nil {
            undated = MilestoneAcross(goal: goal, milestone: milestone)
        }
    }
    return dated ?? undated
}

/* ── a routine's steps (O12) ──────────────────────────────────────────── */

/// lib/organize.ts `moveMemberAfter`: a routine's member order with `item`
/// moved to sit right after `after`, or first when `after` is nil. The order
/// a routine page's drag (and its Move up and Move down) asks for, one item
/// placed after another, never a list sent whole; the route writes exactly
/// this order (lib/app-containers.ts `moveMember`), so the phone's step and
/// the server agree.
///
/// Every other member keeps its order relative to the rest. An `item` that
/// is not in `ids`, an `after` that is not (once `item` is taken out), or an
/// `after` that is `item` itself changes nothing: the answer is `ids` as it
/// was. Every copy of `item` is taken out and it goes back once, as the web's
/// filter does.
///
/// Pure, over ids only: a member whose item is in the Trash (its join row
/// outlives the item's soft delete) keeps its place among the rest, so the
/// order the phone draws, which skips it, is the order it asked for.
/// Generic so the fixture's strings and a routine's `itemIds` both ask it.
public func moveMemberAfter<ID: Equatable>(_ ids: [ID], item: ID, after: ID?) -> [ID] {
    if after == item || !ids.contains(item) { return ids }
    let rest = ids.filter { $0 != item }
    guard let after else { return [item] + rest }
    guard let at = rest.firstIndex(of: after) else { return ids }
    var moved = rest
    moved.insert(item, at: at + 1)
    return moved
}

/* ── a season's routines (O13) ────────────────────────────────────────── */

/// lib/organize.ts `wouldHideAttaching`: how many items putting routine
/// `routineId` in season `seasonId` would ACTUALLY take off `day`, the attach
/// confirm's count ("This will hide 3 items for now",
/// `OrganizeCopy.attachConfirmTitle`). Zero means no confirm: the routine
/// goes straight in.
///
/// A routine that belongs to NO season answers for itself. Put it in its
/// first season and the season answers too, so attaching a live routine to a
/// season that is off makes its items leave today as a side effect of a join
/// write. Only that first season rescopes it: a routine another season
/// already holds is purely added to (the paths are disjunctive), so it hides
/// nothing and is never asked about, which keeps the one prompt with
/// something to say from being dismissed unread.
///
/// The count is the resolver's DELTA (`inactiveItemIdsOn` before and after
/// the join is simulated), never a member count: a member already hidden (its
/// own pause, the routine's), one a second live path still carries (another
/// routine, the season's own items) and one with nothing left to do today
/// would all move nothing. A season not in `seasons` hides nothing.
///
/// `routines` and `seasons` are the live ones; asked with no trips, as the
/// web's pane asks it: a trip's rest is a hold of its own, and the season
/// would still be holding the item when the trip ends.
public func wouldHideAttaching(
    seasonId: String,
    routineId: String,
    items: [Item],
    on day: DayString,
    timeZone: String,
    routines: [Routine],
    seasons: [Season]
) -> Int {
    if seasons.contains(where: { $0.id != seasonId && $0.routineIds.contains(routineId) }) { return 0 }
    let before = inactiveItemIdsOn(items: items, date: day, timeZone: timeZone, routines: routines, seasons: seasons)
    let joined = seasons.map { season -> Season in
        guard season.id == seasonId else { return season }
        var held = season
        held.routineIds.append(routineId)
        return held
    }
    let after = inactiveItemIdsOn(items: items, date: day, timeZone: timeZone, routines: routines, seasons: joined)
    return after.subtracting(before).count
}
