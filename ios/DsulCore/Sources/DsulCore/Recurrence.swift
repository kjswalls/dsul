import Foundation

// Port of lib/recurrence.ts. Keep in step: a change there without the same
// change here is drift, and the iPhone shows different days than the web.
// The web functions take a `userTimezone` they never read; it is dropped here.

/// The repeat fields of an item. `frequency` stays open text because the web
/// treats an unknown value as "shows nowhere", not as an error.
public struct RepeatRule: Sendable, Hashable {
    public var frequency: String?
    public var days: [Int]?
    public var monthDay: Int?

    public init(frequency: String? = nil, days: [Int]? = nil, monthDay: Int? = nil) {
        self.frequency = frequency
        self.days = days
        self.monthDay = monthDay
    }
}

/// lib/recurrence.ts `shouldShowOnDate`.
public func shouldShowOnDate(_ rule: RepeatRule, on day: DayString) -> Bool {
    let dayOfWeek = day.weekday
    switch rule.frequency {
    case nil, "none":
        return false
    case "daily":
        return true
    case "weekdays":
        return (1...5).contains(dayOfWeek)
    case "weekends":
        return dayOfWeek == 0 || dayOfWeek == 6
    case "weekly", "custom":
        // "weekly" is legacy and reads the same as custom.
        return rule.days?.contains(dayOfWeek) ?? false
    case "monthly":
        guard let target = rule.monthDay else { return false }
        return day.day == min(target, day.daysInMonth)
    default:
        return false
    }
}

/// lib/recurrence.ts `anchoredSeriesOn`: the start date always counts, then
/// the repeat decides, and nothing before the start does.
public func anchoredSeriesOn(_ rule: RepeatRule, start: DayString, on day: DayString) -> Bool {
    if start > day { return false }
    return start == day || shouldShowOnDate(rule, on: day)
}

/// lib/recurrence.ts `firstRepeatDayFrom`: the first day on or after `from`
/// the repeat falls on, or `from` itself when none does within a year.
public func firstRepeatDayFrom(_ rule: RepeatRule, from: DayString) -> DayString {
    for offset in 0..<366 {
        let day = from.adding(days: offset)
        if shouldShowOnDate(rule, on: day) { return day }
    }
    return from
}

/// lib/recurrence.ts `isCompletedOnDate`. Recurring items keep completion per
/// date; scalar status is never the truth for them.
public func isCompletedOnDate(_ completedDates: [String]?, _ day: DayString) -> Bool {
    completedDates?.contains(day.description) ?? false
}

/// lib/recurrence.ts `isSkippedOnDate`, the skip twin of `isCompletedOnDate`.
public func isSkippedOnDate(_ skippedDates: [String]?, _ day: DayString) -> Bool {
    skippedDates?.contains(day.description) ?? false
}

/// lib/recurrence.ts `isRecurring`.
public func isRecurring(_ rule: RepeatRule) -> Bool {
    guard let f = rule.frequency else { return false }
    return !f.isEmpty && f != "none"
}
