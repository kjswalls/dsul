import Foundation

/// A calendar day, the Swift twin of the web app's `YYYY-MM-DD` strings.
///
/// The web reads weekday and month length off `new Date(dateStr + 'T00:00:00')`
/// in the runtime's zone. Both depend only on the calendar date, so here all
/// arithmetic runs in a fixed UTC Gregorian calendar and no device zone can
/// shift a day.
public struct DayString: Hashable, Comparable, Sendable, CustomStringConvertible {
    public let year: Int
    public let month: Int
    public let day: Int

    static let utc: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(secondsFromGMT: 0)!
        return c
    }()

    /// Parses the first 10 characters (`slice(0, 10)` on the web), so a legacy
    /// ISO timestamp reads as its day. Returns nil for anything that isn't a
    /// real calendar day.
    public init?(_ string: String) {
        let head = string.prefix(10)
        let parts = head.split(separator: "-", omittingEmptySubsequences: false)
        guard head.count == 10, parts.count == 3,
              parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2])
        else { return nil }
        self.init(year: y, month: m, day: d)
    }

    public init?(year: Int, month: Int, day: Int) {
        guard (1...12).contains(month), day >= 1 else { return nil }
        self.year = year
        self.month = month
        self.day = day
        guard day <= daysInMonth else { return nil }
    }

    var date: Date {
        Self.utc.date(from: DateComponents(year: year, month: month, day: day))!
    }

    /// 0 = Sun … 6 = Sat, the convention of JS `getDay()` and `repeatDays`.
    public var weekday: Int {
        Self.utc.component(.weekday, from: date) - 1
    }

    public var daysInMonth: Int {
        let first = Self.utc.date(from: DateComponents(year: year, month: month, day: 1))!
        return Self.utc.range(of: .day, in: .month, for: first)!.count
    }

    public func adding(days: Int) -> DayString {
        let next = Self.utc.date(byAdding: .day, value: days, to: date)!
        let c = Self.utc.dateComponents([.year, .month, .day], from: next)
        return DayString(year: c.year!, month: c.month!, day: c.day!)!
    }

    public var description: String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    public static func < (a: DayString, b: DayString) -> Bool {
        (a.year, a.month, a.day) < (b.year, b.month, b.day)
    }
}

/// The calendar day `date` falls on in the IANA zone `timeZone`.
/// Mirrors `toDateStr` in lib/recurrence.ts. An unknown zone returns nil,
/// where the web throws a RangeError.
public func toDateStr(_ date: Date, timeZone id: String) -> DayString? {
    guard let zone = TimeZone(identifier: id) else { return nil }
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = zone
    let c = cal.dateComponents([.year, .month, .day], from: date)
    return DayString(year: c.year!, month: c.month!, day: c.day!)
}
