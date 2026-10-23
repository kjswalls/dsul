import Foundation

// Port of lib/active.ts's explanations: why a container is or isn't carrying
// its members, for the surfaces that must SAY so. Active.swift answers "is
// this live"; this file answers "and why not". Keep in step: a change there
// without the same change here is drift, and the phone names a different
// season as the one holding a routine than the web does. Checked against the
// web by StandingFixtureTests (tests/fixtures/organize/standing.json).
//
// From O1 (Organize's list): `seasonResumeDate` and `routineStandingOn`, which
// the routine pill (Collections.swift) reads. From O2 (the container pages):
// `suppressionReason` and its words, `suppressionLabel`, which a goal page's
// rows wear when something hides them, and `membersRevealedByRemoving`, the
// resolver delta a routine's hidden count is built on. From O8a (the writes):
// lib/scope-rail.ts `seasonStateForSwitch`, the state a binary switch writes
// (Paused's "Turn on now"), checked against the same fixture. The trip layer
// is Away.swift's (`awayHoldOn`, `returnDayOf`).

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

/// lib/scope-rail.ts `seasonStateForSwitch`: the state a binary switch over
/// the tri-state writes to turn `season` on (`on` true) or off on `today`.
/// `auto` whenever the dates alone already give that answer, so a switch
/// never destroys date-following; a manual `active` or `paused` only when the
/// user is overruling the calendar. For a switch only (Paused's "Turn on
/// now", `gateSwitchIntent`): the season's Status chip sends what was picked.
public func seasonStateForSwitch(_ season: Season, on: Bool, today: DayString) -> SeasonState {
    var dated = season
    dated.state = SeasonState.auto.rawValue
    if isSeasonActiveOn(dated, on: today) == on { return .auto }
    return on ? .active : .paused
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

/// lib/active.ts `SuppressionReason`: why an item is held off a day, for the
/// surfaces that must SAY so. Kept as a value rather than words, because the
/// words differ per surface (`suppressionLabel` short or long). `until` is
/// the value as the web carries it (a pause's `pausedUntil` as stored, a
/// season's `seasonResumeDate`, a trip's `returnDayOf`); empty or nil is no
/// return day.
public enum SuppressionReason: Sendable, Hashable {
    /// A trip (vacation mode) holds it.
    case away(until: String?)
    /// Its own pause.
    case paused(until: String?)
    /// A paused routine holding it.
    case routine(Routine, until: String?)
    /// A season that is off, holding it directly (`routine` nil) or through
    /// `routine`, the routine on that path.
    case season(Season, routine: Routine?, until: String?)

    /// The web's discriminant.
    public enum Kind: String, Sendable, Hashable, CaseIterable {
        case away, paused, routine, season
    }

    public var kind: Kind {
        switch self {
        case .away: return .away
        case .paused: return .paused
        case .routine: return .routine
        case .season: return .season
        }
    }

    /// The return day as carried, or nil.
    public var until: String? {
        switch self {
        case .away(let until), .paused(let until), .routine(_, let until), .season(_, _, let until):
            return until
        }
    }

    /// The routine named (`.routine`), or the one a season holds the item
    /// through (`.season`); nil otherwise.
    public var routine: Routine? {
        switch self {
        case .routine(let routine, _): return routine
        case .season(_, let routine, _): return routine
        case .away, .paused: return nil
        }
    }

    /// The season named, for `.season` only.
    public var season: Season? {
        if case .season(let season, _, _) = self { return season }
        return nil
    }
}

/// A non-empty string, or nil: JavaScript's truthiness for the optional day
/// strings these rules test.
private func present(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    return s
}

/// lib/active.ts `deadPathExplanation`: for a path NOT carrying the item,
/// when it would and which of its containers to name. Blocked twice (a
/// paused routine in an off season), the binding constraint is named:
/// whichever clears last, an unknown return counting as latest of all. The
/// path clears only when both do, so an unknown on either side makes its
/// return unknown.
private func deadPathExplanation(
    _ path: ActivationPath,
    on day: DayString,
    timeZone: String
) -> (returnsOn: String?, reason: SuppressionReason) {
    let routineBlocks = path.routine.map { isPausedOn($0, on: day, timeZone: timeZone) } ?? false
    let seasonBlocks = path.season.map { !isSeasonActiveOn($0, on: day) } ?? false
    let routineReturns: String? = routineBlocks ? path.routine?.pausedUntil : nil
    let seasonReturns: String? = seasonBlocks ? path.season.flatMap { seasonResumeDate($0, on: day) } : nil
    let routineBack = present(routineReturns)
    let seasonBack = present(seasonReturns)

    let nameSeason = seasonBlocks
        && (!routineBlocks || seasonBack == nil || (routineBack.map { seasonBack! >= $0 } ?? false))

    // `[routineReturns, seasonReturns].filter(Boolean).sort().pop()`: the later.
    let returnsOn: String?
    if (routineBlocks && routineBack == nil) || (seasonBlocks && seasonBack == nil) {
        returnsOn = nil
    } else {
        returnsOn = [routineBack, seasonBack].compactMap { $0 }.max()
    }

    if nameSeason, let season = path.season {
        return (returnsOn, .season(season, routine: path.routine, until: seasonReturns))
    }
    if let routine = path.routine {
        return (returnsOn, .routine(routine, until: routineReturns))
    }
    // A dead path with no routine is a season path, named above; unreachable.
    return (returnsOn, .season(path.season!, routine: nil, until: seasonReturns))
}

/// lib/active.ts `suppressionReason`: why `item` is held off `day`, or nil
/// when it is live (so nil doubles as the liveness answer).
/// - its own pause first: it is the one the row's own Resume undoes;
/// - then a trip, which holds it whatever its containers say;
/// - then, when every path is dead, the path that comes back first (the
///   paths are disjunctive), with "no return" last and ties to the earlier
///   path (`activationPathsFor`'s order).
///
/// `routines`, `seasons` and `away` are the live ones, as for
/// `isItemActiveOn`.
public func suppressionReason(
    _ item: Item,
    on day: DayString,
    timeZone: String,
    routines: [Routine] = [],
    seasons: [Season] = [],
    away: [AwayPeriod] = []
) -> SuppressionReason? {
    if isPausedOn(item, on: day, timeZone: timeZone) {
        return .paused(until: item.pausedUntil)
    }
    if let trip = awayHoldOn(item, on: day, away: away, routines: routines) {
        return .away(until: returnDayOf(item.id, trip))
    }
    let paths = activationPathsFor(item.id, routines: routines, seasons: seasons)
    if paths.isEmpty { return nil }
    if paths.contains(where: { isPathLiveOn($0, on: day, timeZone: timeZone) }) { return nil }

    // The web sorts by `returnsOn`, unknown last, stably, and takes the
    // first: the first path no later path returns before.
    var best: (returnsOn: String?, reason: SuppressionReason)? = nil
    for path in paths {
        let explanation = deadPathExplanation(path, on: day, timeZone: timeZone)
        guard let current = best else {
            best = explanation
            continue
        }
        if let candidate = explanation.returnsOn, current.returnsOn.map({ candidate < $0 }) ?? true {
            best = explanation
        }
    }
    return best?.reason
}

/// lib/active.ts `suppressionLabel`: the one place suppression is put into
/// words. `long` has room for the article-and-noun rule ("your Winter
/// season") and a return day; the short form is for a chip or a row's meta.
/// Never a warning, never an apology (the guilt-free law): it says where the
/// work went. Days through `formatDay` ("Nov 1").
public func suppressionLabel(_ reason: SuppressionReason, long: Bool = false) -> String {
    let until = present(reason.until)
    let back = until.map { " until \(formatDay($0))" } ?? ""
    switch reason {
    case .away:
        if long {
            return until.map { "Resting for vacation mode until \(formatDay($0))" } ?? "Resting for vacation mode"
        }
        return until.map { "Back \(formatDay($0))" } ?? "On vacation"
    case .paused:
        return until.map { "Paused until \(formatDay($0))" } ?? "Paused"
    case .routine(let routine, _):
        return long ? "Hidden with your \(routine.name) routine\(back)" : "Hidden with \(routine.name)"
    case .season(let season, _, _):
        return long ? "Hidden with your \(season.name) season\(back)" : "Hidden with \(season.name)"
    }
}

/// lib/active.ts `membersRevealedByRemoving`: of `memberIds`, the ones that
/// would come back onto `day` if routine `routineId` did not exist. The
/// resolver DELTA, not the routine's own state: a member another live path
/// carries is not hidden by it, so it is never named. Two
/// `inactiveItemIdsOn` passes, before and without the routine; `memberIds`
/// keeps its order (and its repeats).
///
/// The routine pane asks it with no trips (`away` empty), as the web's does.
public func membersRevealedByRemoving(
    _ routineId: String,
    memberIds: [UUID],
    items: [Item],
    on day: DayString,
    timeZone: String,
    routines: [Routine] = [],
    seasons: [Season] = [],
    away: [AwayPeriod] = []
) -> [UUID] {
    let before = inactiveItemIdsOn(
        items: items, date: day, timeZone: timeZone, routines: routines, seasons: seasons, away: away
    )
    let after = inactiveItemIdsOn(
        items: items, date: day, timeZone: timeZone, routines: routines.filter { $0.id != routineId },
        seasons: seasons, away: away
    )
    return memberIds.filter { before.contains($0) && !after.contains($0) }
}
