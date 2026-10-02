import Foundation

// The words the item sheet's chips say, ported from where the web says them:
// - lib/cadence.ts `cadenceLabel`: how often an item repeats ("Mon, Wed");
// - lib/item-bands.ts `membershipSummary`: "Wind down", or "Wind down +1";
// - lib/reminders/copy.ts `formatCueTime`: a reminder's "HH:mm" in the user's
//   12h or 24h preference;
// - lib/active.ts `formatDay`: "Sep 1";
// - lib/container-schedule.ts `weekStartOf`: the first day of a week, per the
//   user's Week starts on setting;
// with the two settings they read (`TimeFormat`, `WeekStartDay`) and the label
// tables of lib/planner-types.ts. Keep in step: a change there without the
// same change here is drift, and the phone words a chip differently from the
// web. Checked against the web by CadenceFixtureTests
// (tests/fixtures/day/cadence.json) and ChipsFixtureTests (chips.json).
//
// Everything is spelled by hand in English, the way the web spells it, so no
// locale or ICU difference between Linux and Darwin can move a word.

/// lib/planner-types.ts `WEEKDAY_LABELS`, indexed 0 = Sun … 6 = Sat.
let weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/// lib/active.ts `MONTHS` (and the en-US short month), indexed 0 = Jan.
let monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/// lib/planner-types.ts `REPEAT_FREQUENCY_LABELS`.
let repeatFrequencyLabels: [String: String] = [
    "none": "No repeat",
    "daily": "Daily",
    "weekdays": "Weekdays",
    "weekends": "Weekends",
    "monthly": "Monthly",
    "custom": "Custom days",
]

/// lib/reminders/copy.ts `TimeFormat`, the `user_settings.time_format` column.
public enum TimeFormat: String, Sendable, Hashable, CaseIterable {
    case twelveHour = "12h"
    case twentyFourHour = "24h"
}

/// lib/container-schedule.ts `WeekStartDay`, the `user_settings.week_start_day`
/// column.
public enum WeekStartDay: String, Sendable, Hashable, CaseIterable {
    case sunday, monday, saturday

    /// The day the week starts on, 0 = Sun … 6 = Sat (`DayString.weekday`).
    public var weekday: Int {
        switch self {
        case .sunday: 0
        case .monday: 1
        case .saturday: 6
        }
    }
}

/// lib/container-schedule.ts `weekStartOf`: the first day of `day`'s week.
public func weekStartOf(_ day: DayString, _ weekStartDay: WeekStartDay) -> DayString {
    return day.adding(days: -((day.weekday - weekStartDay.weekday + 7) % 7))
}

/// lib/cadence.ts `cadenceLabel`: a recurring item's repeat in a few words
/// ("Daily", "Mon, Wed, Fri", "Monthly · 12"; an unknown frequency is its own
/// word). A one-off answers its day ("Oct 2") or "No date"; that branch reads
/// the browser's locale on the web, so it is spelled here as en-US reads it and
/// the fixtures leave it out. The sheet shows the chip for recurring items only.
public func cadenceLabel(_ item: Item) -> String {
    if isRecurring(item.rule) {
        let f = item.repeatFrequency ?? ""
        if f == "custom" {
            let days = (item.repeatDays ?? []).sorted()
            if days.count == 7 { return "Daily" }
            // An index past the table is `undefined` on the web, which joins as "".
            let joined = days.map { (0...6).contains($0) ? weekdayLabels[$0] : "" }.joined(separator: ", ")
            return joined.isEmpty ? "Custom days" : joined
        }
        if f == "monthly" {
            if let monthDay = item.repeatMonthDay, monthDay != 0 { return "Monthly · \(monthDay)" }
            return "Monthly"
        }
        return repeatFrequencyLabels[f] ?? f
    }
    guard let start = item.startDate, !start.isEmpty else { return "No date" }
    return formatShort(start)
}

/// lib/collections.ts `formatShort` as en-US reads it: `2026-08-20` → `Aug 20`,
/// and anything that isn't a bare day back as it was.
private func formatShort(_ dateStr: String) -> String {
    guard dateStr.utf8.count == 10, let day = DayString(dateStr) else { return dateStr }
    return "\(monthLabels[day.month - 1]) \(day.day)"
}

/// lib/item-bands.ts `membershipSummary`: nil for none, the name for one, and
/// the first name with a count of the rest for more ("Wind down +2").
public func membershipSummary(_ names: [String]) -> String? {
    guard let first = names.first else { return nil }
    if names.count == 1 { return first }
    return "\(first) +\(names.count - 1)"
}

/// lib/reminders/copy.ts `formatCueTime`: "HH:mm" as the user reads it. 24h
/// keeps the text as stored ("07:05"); 12h drops the hour's leading zero and
/// adds am/pm ("7:05 am", "12:30 am"). An hour that isn't a number comes back
/// as given, where the web would print NaN.
public func formatCueTime(_ hhmm: String, timeFormat: TimeFormat = .twelveHour) -> String {
    let parts = hhmm.split(separator: ":", omittingEmptySubsequences: false)
    let rawHour = parts.first.map { String($0) } ?? ""
    let minute = parts.count > 1 ? String(parts[1]) : ""
    switch timeFormat {
    case .twentyFourHour:
        return "\(rawHour):\(minute)"
    case .twelveHour:
        guard let hour = Int(rawHour) else { return hhmm }
        let suffix = hour < 12 ? "am" : "pm"
        let hour12 = hour % 12 == 0 ? 12 : hour % 12
        return "\(hour12):\(minute) \(suffix)"
    }
}

/// lib/active.ts `formatDay`: `2026-09-01` → `Sep 1`, read as a plain calendar
/// day (a timestamp reads as its day). Anything else comes back as it was.
public func formatDay(_ dateStr: String) -> String {
    let parts = toDateOnly(dateStr).split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count >= 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
          y != 0, d != 0, (1...12).contains(m)
    else { return dateStr }
    return "\(monthLabels[m - 1]) \(d)"
}
