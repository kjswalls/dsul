import Foundation

// Port of lib/reminders/clock.ts: a zone's wall clock, read both ways.
// Keep in step: a change there without the same change here is drift, and the
// phone arms a cue at a different instant than the web's plan says. Checked
// against the web through NotificationPlanFixtureTests and SnoozeFixtureTests
// (tests/fixtures/day/notification-plan.json), whose every instant passes
// through here, and pinned directly by ReminderClockTests.
//
// - `localClock`: what day and minute it is in a zone at an instant (the
//   scan's question, and the plan's "today").
// - `instantOf`: when a zone's wall clock reads a minute on a day, or nil on a
//   spring-forward night that skips it; on a fall-back night, the earlier of
//   the two.
// - `addDays`, `weekdayOf`: label arithmetic on yyyy-MM-dd, in UTC, never in a
//   zone (DayString's own calendar).
//
// Instants are epoch milliseconds (`Int`), as on the web, so the plan's numbers
// compare with the fixtures' exactly. The zone's offset comes from
// `TimeZone.secondsFromGMT(for:)` and everything else is integer arithmetic:
// never `Calendar.date(from:)`, which silently moves a time a spring-forward
// skips to an hour later, where the web's answer is "no such instant".
//
// Where it differs from the TS, and why it doesn't matter to a caller:
// - an unknown zone is nil, where the web throws a RangeError (the plan and
//   the snooze catch it and answer the same way either way);
// - `addDays`, `weekdayOf` and `instantOf` take a real calendar day and are nil
//   for anything else (`2026-02-30`), where JavaScript's Date.UTC rolls it
//   over into March. Every day the plan asks about is one this file made.

/// lib/reminders/clock.ts `LocalClock`: one instant, as the user's day and
/// minute and as the instant itself.
public struct LocalClock: Sendable, Hashable {
    /// The zone's day, yyyy-MM-dd.
    public var dateStr: String
    /// Minutes since the zone's midnight, 0...1439.
    public var nowMinutes: Int
    /// The instant as `toISOString()` writes it ("2026-10-05T10:00:00.000Z").
    public var nowIso: String
    /// The instant, epoch milliseconds.
    public var nowMs: Int

    public init(dateStr: String, nowMinutes: Int, nowIso: String, nowMs: Int) {
        self.dateStr = dateStr
        self.nowMinutes = nowMinutes
        self.nowIso = nowIso
        self.nowMs = nowMs
    }
}

/// Milliseconds in a day.
let msPerDay = 86_400_000

/// Integer division rounding toward negative infinity (`Math.floor(a / b)`).
func floorDiv(_ a: Int, _ b: Int) -> Int {
    let q = a / b
    return (a % b != 0) && ((a < 0) != (b < 0)) ? q - 1 : q
}

/// The remainder that goes with `floorDiv`: always in 0..<b for b > 0.
func floorMod(_ a: Int, _ b: Int) -> Int {
    return a - floorDiv(a, b) * b
}

/// Days from 1970-01-01 to a proleptic Gregorian day, as `Date.UTC` counts
/// them (Howard Hinnant's `days_from_civil`).
func daysFromCivil(_ year: Int, _ month: Int, _ day: Int) -> Int {
    let y = month <= 2 ? year - 1 : year
    let era = floorDiv(y, 400)
    let yoe = y - era * 400
    let mp = (month + 9) % 12
    let doy = (153 * mp + 2) / 5 + day - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
}

/// The day `days` after 1970-01-01 (`civil_from_days`, the inverse above).
func civilFromDays(_ days: Int) -> (year: Int, month: Int, day: Int) {
    let z = days + 719_468
    let era = floorDiv(z, 146_097)
    let doe = z - era * 146_097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let day = doy - (153 * mp + 2) / 5 + 1
    let month = mp < 10 ? mp + 3 : mp - 9
    let year = yoe + era * 400 + (month <= 2 ? 1 : 0)
    return (year, month, day)
}

/// `n` in at least `width` digits, zero-padded (`padStart(width, '0')`).
func zeroPadded(_ n: Int, _ width: Int) -> String {
    let digits = String(n)
    return digits.count >= width ? digits : String(repeating: "0", count: width - digits.count) + digits
}

/// The zone's offset from UTC at `ms`, in milliseconds (wall minus UTC), read
/// at the whole second as the web's formatter reads it.
func offsetMs(_ ms: Int, _ zone: TimeZone) -> Int {
    let seconds = floorDiv(ms, 1000)
    return zone.secondsFromGMT(for: Date(timeIntervalSince1970: TimeInterval(seconds))) * 1000
}

/// The zone's wall clock at `ms`: its day, and minutes since its midnight.
func wallClock(_ ms: Int, _ zone: TimeZone) -> (day: DayString, minutes: Int) {
    let wall = ms + offsetMs(ms, zone)
    let civil = civilFromDays(floorDiv(wall, msPerDay))
    // A civil day is always a real one, so the validating init cannot fail.
    let day = DayString(year: civil.year, month: civil.month, day: civil.day)!
    return (day, floorMod(wall, msPerDay) / 60_000)
}

/// `new Date(ms).toISOString()`: UTC to the millisecond with a `Z`, spelled
/// from the integer, so no floating-point step can move the last digit.
func isoString(ms: Int) -> String {
    let civil = civilFromDays(floorDiv(ms, msPerDay))
    let inDay = floorMod(ms, msPerDay)
    let hours = inDay / 3_600_000
    let minutes = inDay / 60_000 % 60
    let seconds = inDay / 1000 % 60
    let millis = inDay % 1000
    return "\(zeroPadded(civil.year, 4))-\(zeroPadded(civil.month, 2))-\(zeroPadded(civil.day, 2))"
        + "T\(zeroPadded(hours, 2)):\(zeroPadded(minutes, 2)):\(zeroPadded(seconds, 2)).\(zeroPadded(millis, 3))Z"
}

/// `date.getTime()`: a Date as epoch milliseconds, rounded down.
func epochMs(_ date: Date) -> Int {
    return Int((date.timeIntervalSince1970 * 1000).rounded(.down))
}

/// The instant an ISO-8601 stamp names, in epoch milliseconds: `Date.parse`
/// on the strings Postgres and the app write (`parseTimestamp`), with anything
/// below the millisecond dropped, as a JavaScript Date drops it. Nil for what
/// `parseTimestamp` refuses, where the web's answer is NaN (or, for a time
/// with no zone, the runtime's own zone, which nothing here can match).
func parseEpochMs(_ stamp: String) -> Int? {
    guard let date = parseTimestamp(stamp) else { return nil }
    // Round to the microsecond first, so a fraction like .123 that Double holds
    // as .12299999… still floors to 123.
    let micros = (date.timeIntervalSince1970 * 1_000_000).rounded()
    guard micros.isFinite, abs(micros) < 9.0e18 else { return nil }
    return floorDiv(Int(micros), 1000)
}

/// lib/reminders/clock.ts `localClock`: the zone's day and minute at `nowMs`.
/// Nil for a zone Foundation does not know (the web throws).
public func localClock(nowMs: Int, timeZone: String) -> LocalClock? {
    guard let zone = TimeZone(identifier: timeZone) else { return nil }
    let wall = wallClock(nowMs, zone)
    return LocalClock(
        dateStr: wall.day.description, nowMinutes: wall.minutes, nowIso: isoString(ms: nowMs), nowMs: nowMs
    )
}

/// `localClock` from a Date, for a caller holding one (the delegate's
/// `notification.date`, the app's `Date()`).
public func localClock(_ now: Date, timeZone: String) -> LocalClock? {
    return localClock(nowMs: epochMs(now), timeZone: timeZone)
}

/// lib/reminders/clock.ts `addDays`: yyyy-MM-dd plus `days`, as calendar
/// arithmetic with no zone in sight. Nil for a string that isn't a real day.
public func addDays(_ dateStr: String, _ days: Int) -> String? {
    return DayString(dateStr)?.adding(days: days).description
}

/// lib/reminders/clock.ts `weekdayOf`: 0 = Sunday … 6 = Saturday, the
/// convention `repeatDays` uses. Nil for a string that isn't a real day.
public func weekdayOf(_ dateStr: String) -> Int? {
    return DayString(dateStr)?.weekday
}

/// lib/reminders/clock.ts `instantOf`: the epoch milliseconds at which the
/// zone's wall clock reads `minutes` past midnight on `dateStr`, or nil when it
/// never does (Los Angeles at 02:30 on 2026-03-08), or the zone or the day is
/// not one this can read. On a fall-back night, the earlier of the two
/// instants (Los Angeles at 01:30 on 2026-11-01 is 08:30Z, not 09:30Z).
public func instantOf(_ dateStr: String, minutes: Int, timeZone: String) -> Int? {
    guard let zone = TimeZone(identifier: timeZone), let day = DayString(dateStr) else { return nil }
    return instantOf(day, minutes, zone)
}

/// `instantOf` on a day and a zone already in hand: the offsets in force a day
/// either side of the naive guess (a zone changes its offset at most once in
/// two days) give the candidates, and only an instant whose wall clock really
/// reads the time asked for is kept. The earliest of those, or nil.
func instantOf(_ day: DayString, _ minutes: Int, _ zone: TimeZone) -> Int? {
    let naive = daysFromCivil(day.year, day.month, day.day) * msPerDay + minutes * 60_000
    var offsets: [Int] = []
    for probe in [naive - msPerDay, naive, naive + msPerDay] {
        let offset = offsetMs(probe, zone)
        if !offsets.contains(offset) { offsets.append(offset) }
    }
    return offsets
        .map { naive - $0 }
        .filter { $0 + offsetMs($0, zone) == naive }
        .min()
}
