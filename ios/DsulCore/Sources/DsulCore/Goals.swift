import Foundation

// Port of lib/goals.ts, everything derived about a goal, stated once. Keep in
// step: a change there without the same change here is drift, and the phone
// says a goal is further along (or further behind) than the web does. Checked
// against the web by GoalsFixtureTests (tests/fixtures/organize/goals.json).
//
// From O1 (Organize's list): `isAchieved`, `goalProgress` and its words
// (`progressLabel`), `isGoalActive` and `sortGoalsForDisplay`. O3 adds the
// timeline, the next milestone, the time elapsed and the countdown.
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
