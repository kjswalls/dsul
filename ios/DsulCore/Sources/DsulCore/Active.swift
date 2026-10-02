import Foundation

// Port of lib/active.ts: the one definition of "is this item live on a day".
// Keep in step: a change there without the same change here is drift, and the
// phone shows an item the web has hidden (or hides one the web still shows).
// Checked against the web by ActiveFixtureTests (tests/fixtures/day/active.json).
//
// Three layers answer: the item's own pause, the routines holding it, and the
// seasons holding those (or holding it directly). An item is live when it is
// not itself paused AND it has no paths, or at least one path is live. What is
// HIDDEN is only an item that is not live and still an open loop: suppression
// hides open loops, never history.
//
// Day comparisons stay string comparisons of yyyy-MM-dd, as on the web, so a
// legacy timestamp (`toDateOnly`) compares the same way there and here.
// Not ported: the write side (`resolvePauseWrite`) and the explanations
// (`suppressionReason`, `routineStandingOn`, …), which no phone surface shows.

/// lib/active.ts `Pausable`: the pause columns of an item or a routine.
public protocol Pausable {
    /// The instant the pause began.
    var pausedAt: String? { get }
    /// The day it ends, exclusive.
    var pausedUntil: String? { get }
}

extension Item: Pausable {}
extension Routine: Pausable {}

/// A bare pause interval, for callers with no item or routine in hand.
public struct PauseWindow: Pausable, Sendable, Hashable {
    public var pausedAt: String?
    public var pausedUntil: String?

    public init(pausedAt: String? = nil, pausedUntil: String? = nil) {
        self.pausedAt = pausedAt
        self.pausedUntil = pausedUntil
    }
}

/// lib/overdue.ts `toDateOnly`: a legacy ISO timestamp reads as its day.
func toDateOnly(_ s: String) -> String {
    if let t = s.firstIndex(of: "T") { return String(s[..<t]) }
    return s
}

/// The instant an ISO-8601 timestamp names, or nil: the stand-in for the web's
/// `new Date(pausedAt)` on the strings Postgres and the app write.
///
/// Accepts `yyyy-MM-dd` (UTC midnight, as JavaScript reads a bare date) and
/// `yyyy-MM-ddTHH:mm[:ss[.fraction]]` followed by `Z` or `±hh:mm` (`±hhmm` too).
/// That covers load_planner's `to_jsonb` timestamptz, microseconds and
/// `+00:00` included, and the app's own `toISOString()`. A time with no zone is
/// refused: JavaScript would read it in the runtime's zone, which nothing here
/// can match. Hand-rolled because `ISO8601DateFormatter` treats fractional
/// seconds differently on Linux and Darwin.
public func parseTimestamp(_ string: String) -> Date? {
    let b: [UInt8] = Array(string.utf8)
    var i = 0
    func digits(_ n: Int) -> Int? {
        guard i + n <= b.count else { return nil }
        var value = 0
        for k in 0..<n {
            let c = b[i + k]
            guard c >= 48 && c <= 57 else { return nil }
            value = value * 10 + Int(c - 48)
        }
        i += n
        return value
    }
    func eat(_ ch: UInt8) -> Bool {
        if i < b.count && b[i] == ch {
            i += 1
            return true
        }
        return false
    }
    let dash: UInt8 = 45, colon: UInt8 = 58, plus: UInt8 = 43

    guard let year = digits(4), eat(dash), let month = digits(2), eat(dash), let dayOfMonth = digits(2),
          let day = DayString(year: year, month: month, day: dayOfMonth)
    else { return nil }
    if i == b.count { return day.date }

    guard eat(84) || eat(32) else { return nil }  // "T" or " "
    guard let hour = digits(2), eat(colon), let minute = digits(2) else { return nil }
    var second = 0
    var fraction = 0.0
    if eat(colon) {
        guard let s = digits(2) else { return nil }
        second = s
        if eat(46) {  // "."
            var scale = 0.1
            var count = 0
            while i < b.count && b[i] >= 48 && b[i] <= 57 {
                fraction += Double(Int(b[i] - 48)) * scale
                scale /= 10
                i += 1
                count += 1
            }
            guard count > 0 else { return nil }
        }
    }
    guard hour <= 23, minute <= 59, second <= 59 else { return nil }

    var offset = 0
    if eat(90) {  // "Z"
        offset = 0
    } else if i < b.count && (b[i] == plus || b[i] == dash) {
        let sign = b[i] == dash ? -1 : 1
        i += 1
        guard let oh = digits(2) else { return nil }
        _ = eat(colon)
        guard let om = digits(2), oh <= 23, om <= 59 else { return nil }
        offset = sign * (oh * 3600 + om * 60)
    } else {
        return nil
    }
    guard i == b.count else { return nil }
    let seconds = Double(hour * 3600 + minute * 60 + second - offset) + fraction
    return day.date.addingTimeInterval(seconds)
}

/// lib/active.ts `pauseStartDate`: the user-local day a pause began, or nil if
/// the stamp is junk (or the zone unknown, where the web would throw).
func pauseStartDate(_ pausedAt: String, timeZone: String) -> String? {
    guard let at = parseTimestamp(pausedAt) else { return nil }
    return toDateStr(at, timeZone: timeZone)?.description
}

/// lib/active.ts `isPausedOn`: inside `[day(pausedAt) in the user's zone,
/// pausedUntil)` on `day`. An unparseable `pausedAt` is not a pause: hiding
/// work is the costlier failure.
public func isPausedOn<P: Pausable>(_ x: P, on day: DayString, timeZone: String) -> Bool {
    guard let pausedAt = x.pausedAt, !pausedAt.isEmpty else { return false }
    let d = day.description
    guard let started = pauseStartDate(pausedAt, timeZone: timeZone), started <= d else { return false }
    if let until = x.pausedUntil, !until.isEmpty, d >= toDateOnly(until) { return false }
    return true
}

/// lib/active.ts `isSeasonActiveOn`. The manual states always win; only
/// 'auto' reads its dates, and its range is inclusive at both ends.
public func isSeasonActiveOn(_ season: Season, on day: DayString) -> Bool {
    if season.state == "active" { return true }
    if season.state == "paused" { return false }
    let d = day.description
    if let starts = season.startsOn, !starts.isEmpty, d < toDateOnly(starts) { return false }
    if let ends = season.endsOn, !ends.isEmpty, d > toDateOnly(ends) { return false }
    return true
}

/// lib/active.ts `routinesForItem`: the routines holding `itemId`.
public func routinesForItem(_ itemId: UUID, routines: [Routine]) -> [Routine] {
    return routines.filter { $0.itemIds.contains(itemId) }
}

/// lib/active.ts `seasonsForItem`: the seasons holding `itemId` DIRECTLY.
public func seasonsForItem(_ itemId: UUID, seasons: [Season]) -> [Season] {
    return seasons.filter { $0.itemIds.contains(itemId) }
}

/// lib/active.ts `ActivationPath`: a routine, a season, or a routine inside a
/// season. Never neither.
public struct ActivationPath: Sendable, Hashable {
    public var routine: Routine?
    public var season: Season?

    public init(routine: Routine? = nil, season: Season? = nil) {
        self.routine = routine
        self.season = season
    }
}

/// lib/active.ts `activationPathsFor`: item → season, item → routine → season
/// (one per season holding the routine), and item → routine only when the
/// routine belongs to no season. `routines` and `seasons` are the live ones.
public func activationPathsFor(_ itemId: UUID, routines: [Routine], seasons: [Season]) -> [ActivationPath] {
    var paths: [ActivationPath] = []
    for season in seasonsForItem(itemId, seasons: seasons) {
        paths.append(ActivationPath(season: season))
    }
    for routine in routinesForItem(itemId, routines: routines) {
        let holders = seasons.filter { $0.routineIds.contains(routine.id) }
        if holders.isEmpty {
            paths.append(ActivationPath(routine: routine))
        } else {
            for season in holders { paths.append(ActivationPath(routine: routine, season: season)) }
        }
    }
    return paths
}

/// lib/active.ts `isPathLiveOn`: every container on the path is switched on.
public func isPathLiveOn(_ path: ActivationPath, on day: DayString, timeZone: String) -> Bool {
    if let routine = path.routine, isPausedOn(routine, on: day, timeZone: timeZone) { return false }
    if let season = path.season, !isSeasonActiveOn(season, on: day) { return false }
    return true
}

/// lib/active.ts `isItemActiveOn`: not itself paused, and no paths or at least
/// one live path. Disjunctive: a second container is another reason to show,
/// never a new way to vanish.
public func isItemActiveOn(
    _ item: Item,
    on day: DayString,
    timeZone: String,
    routines: [Routine] = [],
    seasons: [Season] = []
) -> Bool {
    if isPausedOn(item, on: day, timeZone: timeZone) { return false }
    let paths = activationPathsFor(item.id, routines: routines, seasons: seasons)
    if paths.isEmpty { return true }
    return paths.contains { isPathLiveOn($0, on: day, timeZone: timeZone) }
}

/// lib/active.ts `isOpenLoopOn`: does it still want doing on `day`? A recurring
/// item is discharged by a completion, a skip, or a tally at its target
/// (`max(1, timesPerDay ?? 1)`); a one-shot item by leaving 'pending'.
public func isOpenLoopOn(_ item: Item, on day: DayString) -> Bool {
    if isRecurring(item.rule) {
        if isCompletedOnDate(item.completedDates, day) { return false }
        if isSkippedOnDate(item.skippedDates, day) { return false }
        // The web skips this when the item has no `dailyCounts` at all; an empty
        // map answers the same, since a missing count is 0 and the bar is ≥ 1.
        let target = item.timesPerDay ?? 1
        if (item.dailyCounts[day.description] ?? 0) >= max(1, target) { return false }
        return true
    }
    return item.status == "pending"
}

/// lib/active.ts `isOpenLoopSuppressedOn`: not live AND still an open loop.
public func isOpenLoopSuppressedOn(
    _ item: Item,
    on day: DayString,
    timeZone: String,
    routines: [Routine] = [],
    seasons: [Season] = []
) -> Bool {
    return !isItemActiveOn(item, on: day, timeZone: timeZone, routines: routines, seasons: seasons)
        && isOpenLoopOn(item, on: day)
}

/// lib/active.ts `inactiveItemIdsOn`: the ids every Today surface hides on
/// `date`. The same answer as asking `isOpenLoopSuppressedOn` per item, with
/// the memberships inverted once instead of walked per item.
public func inactiveItemIdsOn(
    items: [Item],
    date: DayString,
    timeZone: String,
    routines: [Routine] = [],
    seasons: [Season] = []
) -> Set<UUID> {
    // Per item: how many paths it has, and how many are live on `date`.
    var total: [UUID: Int] = [:]
    var live: [UUID: Int] = [:]
    func bump(_ itemId: UUID, _ t: Int, _ l: Int) {
        total[itemId, default: 0] += t
        live[itemId, default: 0] += l
    }

    var seasonLive: [String: Bool] = [:]
    for season in seasons { seasonLive[season.id] = isSeasonActiveOn(season, on: date) }

    // Direct item → season paths.
    for season in seasons {
        let l = seasonLive[season.id] == true ? 1 : 0
        for itemId in season.itemIds { bump(itemId, 1, l) }
    }

    var holdersByRoutine: [String: [String]] = [:]
    for season in seasons {
        for routineId in season.routineIds { holdersByRoutine[routineId, default: []].append(season.id) }
    }

    // Routine paths. No holder means standalone: one path, the routine's own.
    for routine in routines {
        let holders: [String]? = holdersByRoutine[routine.id]
        let routinePaused = isPausedOn(routine, on: date, timeZone: timeZone)
        let t = holders?.count ?? 1
        let l: Int
        if routinePaused {
            l = 0
        } else if let holders = holders {
            l = holders.filter { seasonLive[$0] == true }.count
        } else {
            l = 1
        }
        for itemId in routine.itemIds { bump(itemId, t, l) }
    }

    var ids = Set<UUID>()
    for item in items {
        let t = total[item.id] ?? 0
        let l = live[item.id] ?? 0
        let active = !isPausedOn(item, on: date, timeZone: timeZone) && (t == 0 || l > 0)
        if !active && isOpenLoopOn(item, on: date) { ids.insert(item.id) }
    }
    return ids
}
