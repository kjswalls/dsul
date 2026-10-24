import DsulCore
import Foundation

/// Today's three layouts, the desktop's day views. The raw value is what
/// @AppStorage keeps, so a rename loses the saved choice: add, never rename.
enum TodayLayout: String, CaseIterable, Identifiable, Sendable {
    case list, buckets, schedule

    var id: String { rawValue }

    var title: String {
        switch self {
        case .list: "List"
        case .buckets: "Buckets"
        case .schedule: "Schedule"
        }
    }

    var systemImage: String {
        switch self {
        case .list: "list.bullet"
        case .buckets: "square.grid.2x2"
        case .schedule: "calendar.day.timeline.left"
        }
    }

    /// The next layout, wrapping: a tap on the capsule.
    var next: TodayLayout { stepped(by: 1) }
    /// The previous layout, wrapping.
    var previous: TodayLayout { stepped(by: -1) }

    func stepped(by steps: Int) -> TodayLayout {
        let all = Self.allCases
        let i = all.firstIndex(of: self) ?? 0
        let n = all.count
        return all[((i + steps) % n + n) % n]
    }

    /// The AppStorage key, shared by Today and the capture bar's tray button.
    static let storageKey = "today.layout"

    /// Has this layout a week form? List and Buckets do. Schedule has none
    /// yet (design PR 10), so a stored Week draws Day there (W17).
    var hasWeek: Bool {
        switch self {
        case .list, .buckets: true
        case .schedule: false
        }
    }

    /// The scope Today draws on this layout for the `stored` one: the stored
    /// scope where the layout has a week form, Day where it has none. The
    /// title, the content and the capsule's VoiceOver value all read it, so
    /// "This week" never sits over a single day.
    func effectiveScope(_ stored: TodayScope) -> TodayScope {
        return hasWeek ? stored : .day
    }

    /// The capsule's Show section on this layout: Day and Week, or Day alone
    /// where Week would be a dead choice.
    var scopes: [TodayScope] {
        return hasWeek ? TodayScope.allCases : [.day]
    }

    /// The capsule's VoiceOver value: the layout, then the scope it draws,
    /// "List, week".
    func spokenValue(_ stored: TodayScope) -> String {
        return title + ", " + effectiveScope(stored).word
    }
}

/// Day or Week: how much of the calendar Today's layout shows (design §4.1).
/// A device-local choice beside the layout, kept in `@AppStorage`, and never
/// the web's synced `default_view`, which would change what the desktop opens
/// on (lib/planner-store.ts `setViewMode`); mobile web never writes it either.
/// The raw value is what @AppStorage keeps, so a rename loses the saved
/// choice: add, never rename.
enum TodayScope: String, CaseIterable, Identifiable, Sendable {
    case day, week

    var id: String { rawValue }

    var title: String {
        switch self {
        case .day: "Day"
        case .week: "Week"
        }
    }

    /// The scope inside a sentence, "week".
    var word: String {
        switch self {
        case .day: "day"
        case .week: "week"
        }
    }

    var systemImage: String {
        switch self {
        case .day: "calendar"
        case .week: "rectangle.split.3x1"
        }
    }

    /// The capsule's VoiceOver action that turns this scope on: "Show week".
    var showActionName: String { "Show " + word }

    /// The AppStorage key, beside the layout's.
    static let storageKey = "today.scope"
}

/// Row and title text. Pure, so the hosted tests can pin it.
enum PlannerFormat {
    /// "3 PM", "3:30 PM": an hour on the 12-hour clock, minutes only when there are some.
    static func clock(_ minutes: Int, meridiem: Bool = true) -> String {
        let h24 = (minutes / 60) % 24
        let m = minutes % 60
        let h12 = h24 % 12 == 0 ? 12 : h24 % 12
        let base = m == 0 ? "\(h12)" : String(format: "%d:%02d", h12, m)
        guard meridiem else { return base }
        return base + (h24 < 12 ? " AM" : " PM")
    }

    /// The time on a row: a range for a block of an hour or more ("9–11"),
    /// the start alone for anything shorter ("3 PM"), nothing when untimed.
    static func rowTime(startMin: Int?, durationMin: Int) -> String? {
        guard let start = startMin else { return nil }
        if durationMin >= 60 {
            return clock(start, meridiem: false) + "\u{2013}" + clock(start + durationMin, meridiem: false)
        }
        return clock(start)
    }

    /// Whether `nowMin` falls inside a timed block.
    static func isNow(startMin: Int?, durationMin: Int, nowMin: Int) -> Bool {
        guard let start = startMin else { return false }
        return nowMin >= start && nowMin < start + durationMin
    }

    /// "Tue, Sep 29".
    static func shortDate(_ day: DayString) -> String {
        day.localDate().formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
    }

    /// The big title: "Today" on today, otherwise the date.
    static func title(selected: DayString, today: DayString) -> String {
        if selected == today { return "Today" }
        if selected == today.adding(days: 1) { return "Tomorrow" }
        if selected == today.adding(days: -1) { return "Yesterday" }
        if selected.year == today.year {
            return selected.localDate().formatted(.dateTime.month(.abbreviated).day())
        }
        return selected.localDate().formatted(.dateTime.month(.abbreviated).day().year())
    }

    /// "Tue, Sep 29 · List".
    static func subtitle(selected: DayString, layout: TodayLayout) -> String {
        shortDate(selected) + " \u{00B7} " + layout.title
    }
}

// MARK: Week (design §4.2 to §4.4)

extension PlannerFormat {
    /// The big title in Week: "This week", "Next week", "Last week", else
    /// "Week of Oct 26", with the year when the week starts in another year
    /// ("Week of Dec 27, 2026"), as `title` does for a day. "Week of" is the
    /// web's noun for a week (components/shell/day-tabs.tsx `weekName`): the
    /// noun only, not a port; the web's tab writes its date "26 Oct".
    /// `start` is any day of the week; the week is read from `weekStart`, the
    /// user's Week starts on.
    static func weekTitle(start: DayString, today: DayString, weekStart: WeekStartDay,
                          locale: Locale = .autoupdatingCurrent) -> String {
        let first = weekStartOf(start, weekStart)
        let thisWeek = weekStartOf(today, weekStart)
        if first == thisWeek { return "This week" }
        if first == thisWeek.adding(days: 7) { return "Next week" }
        if first == thisWeek.adding(days: -7) { return "Last week" }
        var style = dayStyle(locale).month(.abbreviated).day()
        if first.year != today.year { style = style.year() }
        return "Week of " + style.format(noon(first))
    }

    /// The week's seven days as one range, "Oct 26 – Nov 1" or "Oct 19 – 25",
    /// in iOS's own interval format (`Date.IntervalFormatStyle`), so the dash
    /// and its spacing are the system's, never typed here. With the years when
    /// the week isn't all in today's year. `start` is the week's first day.
    static func weekRange(start: DayString, today: DayString, locale: Locale = .autoupdatingCurrent) -> String {
        let last = start.adding(days: 6)
        var style = Date.IntervalFormatStyle(locale: locale, calendar: calendar(locale), timeZone: utc)
            .month(.abbreviated).day()
        if start.year != today.year || last.year != today.year { style = style.year() }
        return style.format(noon(start)..<noon(last))
    }

    /// Week's subtitle: the range and the layout, "Oct 26 – Nov 1 · List".
    static func weekSubtitle(start: DayString, today: DayString, layout: TodayLayout,
                             locale: Locale = .autoupdatingCurrent) -> String {
        return weekRange(start: start, today: today, locale: locale) + " \u{00B7} " + layout.title
    }

    /// The range as VoiceOver should say it: "October 26 to November 1",
    /// "October 19 to 25", with the years as `weekRange` shows them, each said
    /// once: "January 4 to January 10, 2027" when both ends share it,
    /// "December 28, 2026 to January 3, 2027" when they don't.
    static func spokenWeekRange(start: DayString, today: DayString, locale: Locale = .autoupdatingCurrent) -> String {
        let last = start.adding(days: 6)
        let withYear = start.year != today.year || last.year != today.year
        let monthDay = dayStyle(locale).month(.wide).day()
        if !withYear {
            let tail = start.month == last.month ? dayStyle(locale).day() : monthDay
            return monthDay.format(noon(start)) + " to " + tail.format(noon(last))
        }
        let head = start.year == last.year ? monthDay : monthDay.year()
        return head.format(noon(start)) + " to " + monthDay.year().format(noon(last))
    }

    /// A week day's heading, its first line: "Thursday".
    static func weekdayName(_ day: DayString, locale: Locale = .autoupdatingCurrent) -> String {
        return dayStyle(locale).weekday(.wide).format(noon(day))
    }

    /// A week day's heading, beside the weekday: "Oct 1".
    static func headingDate(_ day: DayString, locale: Locale = .autoupdatingCurrent) -> String {
        return dayStyle(locale).month(.abbreviated).day().format(noon(day))
    }

    /// A week day's heading as VoiceOver hears it: "Thursday, October 1", and
    /// ", today" on today, whose mark is a dot no one can hear.
    static func spokenHeading(_ day: DayString, isToday: Bool, locale: Locale = .autoupdatingCurrent) -> String {
        let words = dayStyle(locale).weekday(.wide).month(.wide).day().format(noon(day))
        return isToday ? words + ", today" : words
    }

    /// A week day with nothing on it (week-list.tsx's words).
    static let nothingPlanned = "Nothing planned."
    /// A week day whose rows the filter chip hides: Day's own words.
    static let nothingMatches = "Nothing matches this filter"
    /// A week day's heading, to VoiceOver: a tap opens the day in Day.
    static let opensThisDay = "Opens this day"

    // The week's dates are formatted at noon UTC in a UTC formatter: a
    // `DayString` is a calendar day, not an instant, so no device zone or
    // clock change can move one to the day before.
    private static let utc = TimeZone(secondsFromGMT: 0)!

    private static func noon(_ day: DayString) -> Date {
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = utc
        return gregorian.date(from: DateComponents(year: day.year, month: day.month, day: day.day, hour: 12))
            ?? Date(timeIntervalSince1970: 0)
    }

    /// The locale's own calendar, read in UTC.
    private static func calendar(_ locale: Locale) -> Calendar {
        var calendar = locale.calendar
        calendar.timeZone = utc
        return calendar
    }

    private static func dayStyle(_ locale: Locale) -> Date.FormatStyle {
        return Date.FormatStyle(locale: locale, calendar: calendar(locale), timeZone: utc)
    }
}
