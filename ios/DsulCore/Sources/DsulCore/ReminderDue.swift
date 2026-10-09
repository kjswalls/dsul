import Foundation

// Port of lib/reminders/due.ts: the one definition of "does dsul owe you a
// nudge right now?". Keep in step: a change there without the same change
// here is drift, and the phone rings about something the server would stay
// quiet about (or the other way round). Checked against the web by
// DueFixtureTests (tests/fixtures/day/due.json); `occursOn` itself is ported
// in ItemVerbs.swift and checked by OccursFixtureTests (occurs.json).
//
// Like the web, nothing here re-derives "still wants doing": `wantsDoingOn`
// composes `occursOn` (ItemVerbs.swift), `isOpenLoopOn` and `isItemActiveOn`
// (Active.swift), the ports the item sheet and Today already ask. A cue about
// a habit the grid has hidden is the app arguing with a decision the user made.
//
// Everything is pure: the day and the minute come in as arguments, never
// from the clock. Instants are epoch milliseconds (`Int`), as on the web.
//
// Where it differs from the TS, and why:
// - `hasMatured` reads a stamp through `parseTimestamp` (Active.swift), which
//   takes what Postgres and the app write (`Z`, `±hh:mm`, any fraction) and
//   refuses a time with no zone, where `Date.parse` would read it in the
//   runtime's zone. Refused reads as never matured, the web's answer for an
//   unparseable stamp.
// - `dueReminders` orders by `at` as bytes, where the web uses `localeCompare`.
//   They agree on every `HH:mm` and on the empty `at` of a snooze with no cue;
//   they could differ only between two malformed times on two matured snoozes.

/// lib/reminders/due.ts `REMINDER_GRACE_MINUTES`: how long after its stated
/// time a cue may still land.
public let reminderGraceMinutes = 30

/// Minutes in a day: the clamp that keeps a late cue from wrapping midnight.
let minutesPerDay = 1440

/// A non-empty string, or nil: JavaScript's truthiness for the optional text
/// columns the reminder rules test (`at ? … : …`, `reminderAnchor || undefined`).
func truthyText(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    return s
}

/// lib/active.ts `ActivationContext`: the zone and the live containers that
/// `isItemActiveOn` reads, bundled as the reminder rules pass them around.
public struct ActivationContext: Sendable, Hashable {
    /// The user's IANA zone (`userTimezone`).
    public var timeZone: String
    public var routines: [Routine]
    public var seasons: [Season]

    public init(timeZone: String, routines: [Routine] = [], seasons: [Season] = []) {
        self.timeZone = timeZone
        self.routines = routines
        self.seasons = seasons
    }
}

/// lib/reminders/due.ts `minutesOfDay`: strict "HH:mm" → minutes since local
/// midnight, or nil if it isn't a time ("7:30", "24:00" and "07:30:00" are not).
/// Nil rather than 0: "00:00" is a real time.
public func minutesOfDay(_ hhmm: String?) -> Int? {
    guard let hhmm, !hhmm.isEmpty else { return nil }
    // /^([01][0-9]|2[0-3]):([0-5][0-9])$/
    let b = Array(hhmm.utf8)
    guard b.count == 5, b[2] == UInt8(ascii: ":") else { return nil }
    func digit(_ c: UInt8) -> Int? {
        return c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9") ? Int(c - UInt8(ascii: "0")) : nil
    }
    guard let h1 = digit(b[0]), let h2 = digit(b[1]), let m1 = digit(b[3]), let m2 = digit(b[4]) else { return nil }
    let hour = h1 * 10 + h2
    guard hour <= 23, m1 <= 5 else { return nil }
    return hour * 60 + m1 * 10 + m2
}

/// lib/reminders/due.ts `isWithinWindow`: is `now` inside
/// [target, target + grace) on the SAME local day? Clamped to midnight, never
/// wrapped: a 23:50 cue's window closes at 24:00, so 00:05 is outside it.
public func isWithinWindow(_ targetMinutes: Int, now nowMinutes: Int, grace graceMinutes: Int = reminderGraceMinutes) -> Bool {
    let end = min(targetMinutes + graceMinutes, minutesPerDay)
    return nowMinutes >= targetMinutes && nowMinutes < end
}

/// lib/reminders/due.ts `wantsDoingOn`: does the item still want doing on
/// `dateStr`? It occurs that day, its loop is still open, and nothing
/// (its own pause, a paused routine, an inactive season) suppresses it.
/// Nil-safe: a string that isn't a day wants nothing.
public func wantsDoingOn(_ item: Item, on dateStr: String, _ ctx: ActivationContext) -> Bool {
    guard let day = DayString(dateStr) else { return false }
    return wantsDoingOn(item, on: day, ctx)
}

/// `wantsDoingOn` on a day already parsed.
public func wantsDoingOn(_ item: Item, on day: DayString, _ ctx: ActivationContext) -> Bool {
    return occursOn(item, on: day.description, timeZone: ctx.timeZone)
        && isOpenLoopOn(item, on: day)
        && isItemActiveOn(item, on: day, timeZone: ctx.timeZone, routines: ctx.routines, seasons: ctx.seasons)
}

/// lib/reminders/due.ts `ReminderCandidate`: one item that has earned a nudge,
/// with the copy inputs already resolved.
public struct ReminderCandidate: Sendable, Hashable {
    public var item: Item
    /// The cue's stated local time, "HH:mm"; empty for a snooze on an item
    /// with no cue of its own.
    public var at: String
    /// The implementation-intention phrase, when the user wrote one.
    public var anchor: String?
    /// This delivery is a matured snooze rather than the day's first cue.
    public var snoozed: Bool

    public init(item: Item, at: String, anchor: String? = nil, snoozed: Bool = false) {
        self.item = item
        self.at = at
        self.anchor = anchor
        self.snoozed = snoozed
    }
}

/// lib/reminders/due.ts `ScanClock`: one tick, as the user's day and minute
/// and as the instant.
public struct ScanClock: Sendable, Hashable {
    /// The user's local day, yyyy-MM-dd.
    public var dateStr: String
    /// Minutes since the user's local midnight.
    public var nowMinutes: Int
    /// The same moment as an ISO instant.
    public var nowIso: String
    /// The same instant in epoch milliseconds.
    public var nowMs: Int
    /// The window's length; `reminderGraceMinutes` when nil.
    public var graceMinutes: Int?
    /// The latest minute a cue's window may open at, for a clock that does not
    /// tick every minute (the server's 23:55). Nil for one that does.
    public var latestOpening: Int?

    public init(
        dateStr: String, nowMinutes: Int, nowIso: String, nowMs: Int,
        graceMinutes: Int? = nil, latestOpening: Int? = nil
    ) {
        self.dateStr = dateStr
        self.nowMinutes = nowMinutes
        self.nowIso = nowIso
        self.nowMs = nowMs
        self.graceMinutes = graceMinutes
        self.latestOpening = latestOpening
    }
}

/// lib/reminders/due.ts `ScanRow`: the item, plus the scan's bookkeeping that
/// is not part of the item.
public struct ScanRow: Sendable, Hashable {
    public var item: Item
    /// items.reminder_sent_key, "yyyy-MM-ddTHH:mm" (`sentKeyFor`).
    public var sentKey: String?
    /// items.reminder_snooze_until, an ISO instant.
    public var snoozeUntil: String?
    /// items.reminder_snooze_date, the local day the snooze belongs to.
    public var snoozeDate: String?

    public init(item: Item, sentKey: String? = nil, snoozeUntil: String? = nil, snoozeDate: String? = nil) {
        self.item = item
        self.sentKey = sentKey
        self.snoozeUntil = snoozeUntil
        self.snoozeDate = snoozeDate
    }
}

/// lib/reminders/due.ts `sentKeyFor`: the dedupe stamp for one cue, the
/// user's local day AND the time it was for ("2026-08-10T07:30").
public func sentKeyFor(_ dateStr: String, _ at: String) -> String {
    return "\(dateStr)T\(at)"
}

/// lib/reminders/due.ts `dueReminders`: every item whose cue is due in this
/// tick and has not already been sent, earliest cue first. A matured snooze
/// for today overrides the stamp and the window (and needs no cue time); a
/// snooze for another day never fires.
public func dueReminders(_ rows: [ScanRow], clock: ScanClock, _ ctx: ActivationContext) -> [ReminderCandidate] {
    var out: [ReminderCandidate] = []
    for row in rows {
        let item = row.item
        if !isRemindable(item) { continue }
        let at = item.reminderTime
        let target = minutesOfDay(at)
        let anchor = truthyText(item.reminderAnchor)

        let snoozed = row.snoozeDate == clock.dateStr && hasMatured(row.snoozeUntil, nowMs: clock.nowMs)
        if snoozed {
            if !wantsDoingOn(item, on: clock.dateStr, ctx) { continue }
            out.append(ReminderCandidate(item: item, at: at ?? "", anchor: anchor, snoozed: true))
            continue
        }

        guard let target, let at else { continue }
        if row.sentKey == sentKeyFor(clock.dateStr, at) { continue }
        let opens = min(target, clock.latestOpening ?? target)
        if !isWithinWindow(opens, now: clock.nowMinutes, grace: clock.graceMinutes ?? reminderGraceMinutes) { continue }
        if !wantsDoingOn(item, on: clock.dateStr, ctx) { continue }
        out.append(ReminderCandidate(item: item, at: at, anchor: anchor, snoozed: false))
    }
    // Stable, as JavaScript's sort is: equal times keep row order.
    return out.enumerated()
        .sorted { a, b in
            if a.element.at != b.element.at { return a.element.at.utf8.lexicographicallyPrecedes(b.element.at.utf8) }
            return a.offset < b.offset
        }
        .map(\.element)
}

/// lib/reminders/due.ts `lastCallItems`: what the streak-at-risk last call may
/// name. Remindable, streak-bearing types (`counters.streak`) that still want
/// doing on `dateStr`, biggest streak first (stable among equals).
public func lastCallItems(_ items: [Item], on dateStr: String, _ ctx: ActivationContext) -> [Item] {
    return items
        .filter { item in
            isRemindable(item) && caps(item.typeName).streakCounter && wantsDoingOn(item, on: dateStr, ctx)
        }
        .enumerated()
        .sorted { a, b in
            let sa = streakOf(a.element), sb = streakOf(b.element)
            return sa != sb ? sa > sb : a.offset < b.offset
        }
        .map(\.element)
}

/// lib/reminders/due.ts `streakOf`: the stored streak, or 0 for a type that
/// has none.
public func streakOf(_ item: Item) -> Int {
    return item.streak ?? 0
}

/// lib/reminders/due.ts `hasMatured`: has a stored snooze instant arrived?
/// Parsed, never string-compared (`+00:00` and `Z` are the same instant). An
/// absent or unreadable stamp answers false: a snooze nobody can read never
/// fires, which is the safe direction.
public func hasMatured(_ snoozeUntil: String?, nowMs: Int) -> Bool {
    guard let snoozeUntil, let at = parseEpochMs(snoozeUntil) else { return false }
    return at <= nowMs
}
