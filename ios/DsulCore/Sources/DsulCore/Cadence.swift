import Foundation

// The words the item sheet's chips say, ported from where the web says them:
// - lib/cadence.ts `cadenceLabel`: how often an item repeats ("Mon, Wed");
// - lib/planner-types.ts `REPEAT_FREQUENCY_LABELS` and `WEEKDAY_LABELS`, from
//   2e read by the Repeat chip's menu and the Repeat sheet's keys too
//   (`repeatFrequencyOrder`, `repeatFrequencyLabel`, `weekdayLabel`), with the
//   keys' order in the user's week (`weekdayOrder`);
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
// (tests/fixtures/day/cadence.json), ChipsFixtureTests (chips.json) and, for
// the repeat words, EditWritesFixtureTests (edit-writes.json's `repeats`).
//
// Everything is spelled by hand in English, the way the web spells it, so no
// locale or ICU difference between Linux and Darwin can move a word.

/// lib/planner-types.ts `WEEKDAY_LABELS`, indexed 0 = Sun … 6 = Sat
/// (`weekdayLabel` reads it with the web's answer outside the table).
let weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/// lib/active.ts `MONTHS` (and the en-US short month), indexed 0 = Jan.
let monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/// lib/planner-types.ts `REPEAT_FREQUENCY_LABELS`. Read through
/// `repeatFrequencyLabel`, so there is one lookup.
let repeatFrequencyLabels: [String: String] = [
    "none": "No repeat",
    "daily": "Daily",
    "weekdays": "Weekdays",
    "weekends": "Weekends",
    "monthly": "Monthly",
    "custom": "Custom days",
]

/// lib/planner-types.ts `REPEAT_FREQUENCY_LABELS`' keys, in their order, which
/// is the order the web's Repeat chip lists them in (and the registry's
/// `allowedFrequencies` keeps). Checked by edit-writes.json's `repeats`.
public let repeatFrequencyOrder: [String] = ["none", "daily", "weekdays", "weekends", "monthly", "custom"]

/// lib/planner-types.ts `REPEAT_FREQUENCY_LABELS`: "No repeat", "Daily",
/// "Weekdays", "Weekends", "Monthly", "Custom days". An unknown frequency is
/// its own word, as `cadenceLabel` has it.
public func repeatFrequencyLabel(_ frequency: String) -> String {
    return repeatFrequencyLabels[frequency] ?? frequency
}

/// lib/planner-types.ts `WEEKDAY_LABELS`: 0 "Sun" … 6 "Sat"; "" outside 0...6,
/// as the web's `undefined` joins.
public func weekdayLabel(_ day: Int) -> String {
    return (0...6).contains(day) ? weekdayLabels[day] : ""
}

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

/// The seven weekdays (0 = Sun … 6 = Sat) in the week's own order, starting on
/// `weekStartDay`: Monday gives [1, 2, 3, 4, 5, 6, 0]. The Repeat sheet's
/// Custom days keys run in it, as the phone's week dots do; the web's keys
/// always run from Sunday (`WEEKDAY_LABELS`).
public func weekdayOrder(_ weekStartDay: WeekStartDay) -> [Int] {
    return (0..<7).map { (weekStartDay.weekday + $0) % 7 }
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
            let joined = days.map(weekdayLabel).joined(separator: ", ")
            return joined.isEmpty ? "Custom days" : joined
        }
        if f == "monthly" {
            if let monthDay = item.repeatMonthDay, monthDay != 0 { return "Monthly · \(monthDay)" }
            return "Monthly"
        }
        return repeatFrequencyLabel(f)
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
