import Foundation

// Port of lib/away.ts: vacation mode, the outermost layer of "is this item
// live". Keep in step: a change there without the same change here is drift,
// and the phone shows a habit the web is resting for the trip (or hides one
// the web brought back). Checked against the web by ActiveFixtureTests
// (tests/fixtures/day/active.json, its trip world) through `isItemActiveOn`
// and `inactiveItemIdsOn` (Active.swift), which ask `awayHoldOn` first.
//
// The layer is CONJUNCTIVE, unlike seasons: a trip is a reason for everything
// to rest, and only the keep list answers back. Three rules carry it
// (memory/plans/vacation-mode.md):
// - only what falls on a day rests: recurring items and dated tasks. An
//   undated braindump item is never held;
// - the end is EXCLUSIVE, like an item's pausedUntil: "until the 20th" is
//   back ON the 20th;
// - coming back is gentle: `returns` holds a later return day for some habits
//   (the easing waves), so a habit stays resting until its wave.
//
// Day comparisons stay string comparisons of yyyy-MM-dd, as on the web, with
// the web's `s.slice(0, 10)` (`awayDay`). The trip type itself, `AwayPeriod`,
// is decoded in Item.swift with the rest of the payload. Not ported: the
// banner's questions (`currentAway`, `upcomingAway`, `easingAway`,
// `lastReturnDay`) and the trip's writes (`planReturns`, `suggestKeeps`,
// `tripTasks`), which no phone surface asks yet.

/// lib/away.ts `day`: the first ten characters, a stamp's day.
func awayDay(_ s: String) -> String {
    return String(s.prefix(10))
}

/// lib/away.ts `isKeptOn`: does the trip list this item, its parent, its
/// project or a routine holding it? `routines` are the live ones.
public func isKeptOn(_ item: Item, _ period: AwayPeriod, routines: [Routine]) -> Bool {
    let keep = period.keep
    if keep.itemIds.contains(item.id) { return true }
    if let parent = item.parentItemId, !parent.isEmpty, let parentId = UUID(uuidString: parent),
       keep.itemIds.contains(parentId) {
        return true
    }
    if let projectId = item.projectId, !projectId.isEmpty, keep.projectIds.contains(projectId) { return true }
    if !keep.routineIds.isEmpty {
        for routine in routines where keep.routineIds.contains(routine.id) && routine.itemIds.contains(item.id) {
            return true
        }
    }
    return false
}

/// lib/away.ts `isDayBound`: only what falls on a day rests. An undated
/// one-shot (the braindump) never does.
public func isDayBound(_ item: Item) -> Bool {
    if isRecurring(item.rule) { return true }
    if let date = item.startDate, !date.isEmpty { return true }
    return false
}

/// lib/away.ts `returnDayOf`: the day `itemId` is back from `period`, its
/// wave if it has a later one, else the trip's end. Nil for an open-ended trip.
public func returnDayOf(_ itemId: UUID, _ period: AwayPeriod) -> String? {
    guard let endsOn = period.endsOn, !endsOn.isEmpty else { return nil }
    let end = awayDay(endsOn)
    if let wave = period.returns[itemId], !wave.isEmpty, awayDay(wave) > end { return awayDay(wave) }
    return end
}

/// lib/away.ts `awayHoldOn`: the trip holding `item` on `day`, or nil when no
/// trip does. Held means: the day is inside the trip (or inside the item's
/// easing wave after it), the item falls on days, and nothing on the keep list
/// claims it. The first trip that holds it answers, in the order given.
public func awayHoldOn(_ item: Item, on day: DayString, away: [AwayPeriod], routines: [Routine]) -> AwayPeriod? {
    if away.isEmpty { return nil }
    if !isDayBound(item) { return nil }
    let d = day.description
    for period in away {
        if d < awayDay(period.startsOn) { continue }
        if let back = returnDayOf(item.id, period), d >= back { continue }
        if isKeptOn(item, period, routines: routines) { continue }
        return period
    }
    return nil
}
