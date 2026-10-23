import Foundation

// Port of lib/organize.ts, the answers Organize's summary cards need that no
// one page owns: THIS WEEK (`organizeWeek`) and NEXT MILESTONE
// (`nextMilestoneAcross`). Keep in step: a change there without the same
// change here is drift, and the phone's week card counts a different week
// from the web's. Checked against the web by OrganizeFixtureTests
// (tests/fixtures/organize/organize.json). The cards' words are
// OrganizeCopy.swift's (`weekCardSentence`, `nextMilestoneLine`).
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
