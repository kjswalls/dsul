import Foundation

// The words a Schedule block and its gutter say, ported from where the web
// says them (Week and blocks PR 4, the web's block look):
// - components/views/day-schedule.tsx `formatClock`: a clock time from minutes
//   after midnight in the user's 12h or 24h preference ("1:00 pm", "13:00"),
//   wrapping past midnight either way, with the am/pm dropped for a block's
//   start–end range;
// - components/views/day-schedule.tsx `formatHourLabel`: the gutter's hour
//   mark ("9 am", "12 pm", "07:00");
// - components/primitives/pills.tsx `formatDuration`: a block's length ("30m",
//   "1h", "1h 30m");
// - lib/use-time-format.ts `timeFormatPattern`: the stored time format to the
//   pattern those formatters branch on. "24h" is the web's 'HH:mm' and every
//   other value its 'h:mm a', which is `TimeFormat` read leniently
//   (PlannerSettings decodes an unknown value as `.twelveHour`), so the Swift
//   takes the enum.
// Keep in step: a change there without the same change here is drift, and a
// block on the phone reads differently from the same block on the web.
// Checked against the web by ScheduleCopyFixtureTests
// (tests/fixtures/day/schedule-copy.json). The range (`formatClockRange`) is
// the web's JSX, not a function, so it is pinned by hand there.
//
// Everything is spelled by hand, the way the web spells it, so no locale or
// ICU difference between Linux and Darwin can move a character.

/// day-schedule.tsx `formatClock`: minutes after midnight as a clock time.
/// 12h: "9:00 am", "12:30 pm" (lowercase, one space; no leading zero), or
/// "9:00" with `meridiem: false`. 24h: "09:00", with or without `meridiem`.
/// The minutes wrap to one day either way (1440 is "12:00 am", -15 is
/// "11:45 pm"), as the web's `((m % 1440) + 1440) % 1440` does.
public func formatClock(_ totalMin: Int, timeFormat: TimeFormat, meridiem: Bool = true) -> String {
    let m = ((totalMin % 1440) + 1440) % 1440
    let hour = m / 60
    let mm = twoDigits(m % 60)
    switch timeFormat {
    case .twentyFourHour:
        return "\(twoDigits(hour)):\(mm)"
    case .twelveHour:
        let h12 = hour % 12 == 0 ? 12 : hour % 12
        return meridiem ? "\(h12):\(mm) \(hour < 12 ? "am" : "pm")" : "\(h12):\(mm)"
    }
}

/// A tall block's second line, "10:00–12:00": the start and the end through
/// `formatClock` with no am/pm, joined by an en dash (U+2013) with no spaces,
/// as day-schedule.tsx writes it in JSX. The end wraps past midnight: an hour
/// from 23:30 is "11:30–12:30" in 12h and "23:30–00:30" in 24h.
public func formatClockRange(startMin: Int, duration: Int, timeFormat: TimeFormat) -> String {
    formatClock(startMin, timeFormat: timeFormat, meridiem: false)
        + "\u{2013}"
        + formatClock(startMin + duration, timeFormat: timeFormat, meridiem: false)
}

/// day-schedule.tsx `formatHourLabel`: the gutter's mark for `hour` (0...23).
/// 12h drops the ":00" ("12 am", "9 am", "12 pm", "1 pm"); 24h keeps it
/// ("07:00"), since a bare "07" is not a time in that idiom.
public func formatHourLabel(_ hour: Int, timeFormat: TimeFormat) -> String {
    switch timeFormat {
    case .twentyFourHour:
        return "\(twoDigits(hour)):00"
    case .twelveHour:
        if hour == 0 { return "12 am" }
        if hour < 12 { return "\(hour) am" }
        if hour == 12 { return "12 pm" }
        return "\(hour - 12) pm"
    }
}

/// pills.tsx `formatDuration`: "0m", "45m", "1h", "1h 30m", "25h". Anything
/// under an hour (a negative length too) is minutes alone.
public func formatDuration(_ minutes: Int) -> String {
    if minutes < 60 { return "\(minutes)m" }
    let h = minutes / 60
    let m = minutes % 60
    return m != 0 ? "\(h)h \(m)m" : "\(h)h"
}

/// `String(n).padStart(2, '0')`.
private func twoDigits(_ n: Int) -> String {
    let s = String(n)
    return s.count < 2 ? "0" + s : s
}
