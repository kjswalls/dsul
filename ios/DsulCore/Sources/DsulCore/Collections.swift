import Foundation

// Port of lib/collections.ts, the container surfaces' shared rules: counting
// only the members that still resolve (`countLive`) and the one-line state
// pills a routine or a season wears when it is not carrying its members
// (`routinePillLabel`, `seasonPillLabel`). Keep in step: a change there
// without the same change here is drift, and the phone's Organize list words
// a container's state differently from the web's console. Checked against the
// web by CollectionsFixtureTests (tests/fixtures/organize/labels.json).
//
// The pills word their dates with `formatDay` (fixed English months, "Oct 30",
// Cadence.swift), as the web's now do. A live container wears no pill: only
// the exception is labelled, never with a warning (the guilt-free law).

/// lib/collections.ts `countLive`: how many of `ids` still resolve in `live`.
/// Member arrays may name trashed items (their join rows outlive the soft
/// delete), and a season may name a trashed routine, so a count is never a
/// raw `count`. Each entry counts, so a repeated id counts each time, as the
/// web's `reduce` does. Item ids (`UUID`) and routine ids (`String`) alike.
public func countLive<ID: Hashable>(_ ids: [ID], live: Set<ID>) -> Int {
    return ids.reduce(0) { n, id in n + (live.contains(id) ? 1 : 0) }
}

/// lib/collections.ts `routinePillLabel`: why a routine is not carrying its
/// members on `today`, or nil when it is.
/// - its own pause: "Until Oct 30", or "Paused" with no return day;
/// - otherwise held off by the seasons holding it (`routineStandingOn`):
///   "Held · Nov 1" when the soonest of them comes back on a date
///   (`seasonResumeDate`), else "Held".
/// `seasons` is every season; the web takes it optional and answers the pause
/// alone without it, which an empty list does here too.
public func routinePillLabel(_ routine: Routine, today: DayString, timeZone: String, seasons: [Season]) -> String? {
    if isPausedOn(routine, on: today, timeZone: timeZone) {
        if let until = routine.pausedUntil, !until.isEmpty { return "Until \(formatDay(until))" }
        return "Paused"
    }
    if seasons.isEmpty { return nil }
    let standing = routineStandingOn(routine, seasons: seasons, on: today, timeZone: timeZone)
    guard !standing.effectiveOn, let blocker = standing.soonestBlocker else { return nil }
    if let back = seasonResumeDate(blocker, on: today) { return "Held \u{00B7} \(formatDay(back))" }
    return "Held"
}

/// lib/collections.ts `seasonPillLabel`: a season's three ways of being off on
/// `today`, or nil while it is on. "Paused" (switched off by hand), "From
/// Nov 1" (an 'auto' season whose start is ahead) or "Ended". The start is
/// compared as stored, as the web compares it.
public func seasonPillLabel(_ season: Season, today: DayString) -> String? {
    if isSeasonActiveOn(season, on: today) { return nil }
    if season.state == "paused" { return "Paused" }
    if let starts = season.startsOn, !starts.isEmpty, today.description < starts { return "From \(formatDay(starts))" }
    return "Ended"
}
