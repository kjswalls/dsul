import Foundation

// Port of lib/active.ts's explanations: why a container is or isn't carrying
// its members, for the surfaces that must SAY so. Active.swift answers "is
// this live"; this file answers "and why not". Keep in step: a change there
// without the same change here is drift, and the phone names a different
// season as the one holding a routine than the web does. Checked against the
// web by StandingFixtureTests (tests/fixtures/organize/standing.json).
//
// From O1 (Organize's list): `seasonResumeDate` and `routineStandingOn`, which
// the routine pill (Collections.swift) reads. O2 adds `suppressionReason`,
// `suppressionLabel` and `membersRevealedByRemoving` here.

/// lib/active.ts `seasonResumeDate`: the day an off season switches itself
/// back on, or nil. Only an 'auto' season with a start still ahead has one: a
/// season paused by hand has no scheduled return, one past its end is over,
/// and an inverted range (start after end) is never live, so its start is no
/// return either. The answer is `startsOn` as stored.
public func seasonResumeDate(_ season: Season, on day: DayString) -> String? {
    guard season.state == "auto", let starts = season.startsOn, !starts.isEmpty else { return nil }
    if let ends = season.endsOn, !ends.isEmpty, toDateOnly(starts) > toDateOnly(ends) { return nil }
    return day.description < toDateOnly(starts) ? starts : nil
}

/// lib/active.ts `RoutineStanding`: where a routine stands on a day. Its own
/// switch (`localOn`, what a control shows and writes) and what the resolver
/// obeys (`effectiveOn`, what the rest of the screen must agree with) are two
/// answers on purpose.
public struct RoutineStanding: Sendable, Hashable {
    /// The routine's own switch: not paused on the day.
    public var localOn: Bool
    /// Its own switch is on, and it stands alone or at least one season
    /// holding it is on (disjunctive, as `isItemActiveOn`).
    public var effectiveOn: Bool
    /// Every season holding it, on or off, in `seasons` order.
    public var holders: [Season]
    /// The holders that are off on the day, in `seasons` order.
    public var blockers: [Season]
    /// The blocker that comes back first (`seasonResumeDate`), with "no
    /// return" last and ties to the earlier holder. Nil only when nothing
    /// blocks.
    public var soonestBlocker: Season?

    public init(localOn: Bool, effectiveOn: Bool, holders: [Season], blockers: [Season], soonestBlocker: Season?) {
        self.localOn = localOn
        self.effectiveOn = effectiveOn
        self.holders = holders
        self.blockers = blockers
        self.soonestBlocker = soonestBlocker
    }
}

/// lib/active.ts `routineStandingOn`. The web ranks the blockers with a
/// stable sort and takes the first; this takes the same element with one
/// scan (the first blocker no later blocker returns before), so no sort's
/// stability is relied on.
public func routineStandingOn(
    _ routine: Routine,
    seasons: [Season],
    on day: DayString,
    timeZone: String
) -> RoutineStanding {
    let localOn = !isPausedOn(routine, on: day, timeZone: timeZone)
    let holders = seasons.filter { $0.routineIds.contains(routine.id) }
    let blockers = holders.filter { !isSeasonActiveOn($0, on: day) }
    let effectiveOn = localOn && (holders.isEmpty || blockers.count < holders.count)

    /// The web's comparator, negative when `a` returns before `b`: equal
    /// answers tie, "no return" sorts last.
    func returnsBefore(_ a: Season, _ b: Season) -> Bool {
        let da = seasonResumeDate(a, on: day)
        let db = seasonResumeDate(b, on: day)
        if da == db { return false }
        guard let da else { return false }
        guard let db else { return true }
        return da < db
    }
    var soonest: Season? = nil
    for blocker in blockers {
        if let best = soonest, !returnsBefore(blocker, best) { continue }
        soonest = blocker
    }
    return RoutineStanding(
        localOn: localOn, effectiveOn: effectiveOn, holders: holders, blockers: blockers, soonestBlocker: soonest
    )
}
