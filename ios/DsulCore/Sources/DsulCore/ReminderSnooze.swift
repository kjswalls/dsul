import Foundation

// Port of lib/reminders/snooze.ts: when a snooze tapped on this device rings
// again, if at all. Keep in step: a change there without the same change here
// is drift, and the phone rings a snooze the server would refuse. Checked
// against the web by SnoozeFixtureTests (tests/fixtures/day/notification-plan.json,
// `snoozeFireInstant`).
//
// The server fires a matured snooze only while its day (reminder_snooze_date)
// is still today (habit-reminders.md decision 8, `dueReminders`' day gate). The
// phone schedules its own snooze, a one-off under `dsul-item-<id>#snooze`
// (ReminderPlan.swift), so it holds the same gate: a 15-minute snooze tapped
// at 23:55 is "not tonight", never 00:10 about a day that is over.
//
// Pure: the tap's instant comes in as `nowMs`, never from the clock. The
// length is the caller's, the one the notification's button promises
// (SNOOZE_MINUTES, 15, in lib/reminders/channels/push.ts), never a second
// number picked here. It is an Int of minutes, where the web takes any number
// and refuses one that isn't finite: Swift's Int has no such value, and an
// arithmetic overflow answers nil instead.

/// lib/reminders/snooze.ts `snoozeFireInstant`: the instant (epoch
/// milliseconds) a snooze of `minutes`, tapped at `nowMs` on a notification
/// about `dayStr`, should ring, or nil when it should not ring at all.
///
/// Nil whenever that instant is not on `dayStr` in `zone` (past its local
/// midnight a snooze expires rather than misfires, and yesterday's
/// notification snoozes to nothing), and for anything it cannot place: a zone
/// Foundation does not know, a `dayStr` not shaped yyyy-MM-dd, or a length
/// that is not a positive number of minutes.
public func snoozeFireInstant(nowMs: Int, minutes: Int, zone: String, dayStr: String) -> Int? {
    guard minutes > 0, isDayShaped(dayStr) else { return nil }
    let (length, lengthOverflow) = minutes.multipliedReportingOverflow(by: 60_000)
    guard !lengthOverflow else { return nil }
    let (fireMs, fireOverflow) = nowMs.addingReportingOverflow(length)
    guard !fireOverflow, let fireDay = localClock(nowMs: fireMs, timeZone: zone)?.dateStr else { return nil }
    return fireDay == dayStr ? fireMs : nil
}

/// `/^\d{4}-\d{2}-\d{2}$/`: the shape alone, as the web tests it. A shaped
/// string that is no real day (2026-02-30) passes here and then matches no
/// zone's day, so it is nil all the same.
private func isDayShaped(_ s: String) -> Bool {
    let b = Array(s.utf8)
    guard b.count == 10 else { return false }
    for (i, c) in b.enumerated() {
        if i == 4 || i == 7 {
            if c != UInt8(ascii: "-") { return false }
        } else if c < UInt8(ascii: "0") || c > UInt8(ascii: "9") {
            return false
        }
    }
    return true
}
