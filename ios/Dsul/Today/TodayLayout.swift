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
