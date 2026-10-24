import DsulCore
import Foundation
import Testing
#if canImport(UIKit)
import UIKit
#endif
@testable import Dsul

/// Week's words (design §4.1, §4.2, §4.3): the scope and the capsule, the
/// week's title and range, and a day's heading. Pinned to en_US. The range is
/// iOS's own interval format, whose spaces around the dash are thin ones
/// (U+2009) in current ICU, so a check reads them as plain spaces and pins
/// only the dash and the words. Runs in the Linux shim; the symbol check
/// needs UIKit and runs on the xcode-27 runner only.
@MainActor
@Suite struct TodayFormatTests {
    private let us = Locale(identifier: "en_US")
    /// A Wednesday. Its week is Oct 19 to 25 from Monday, Oct 18 to 24 from
    /// Sunday, and Oct 17 to 23 from Saturday.
    private let today = DayString("2026-10-21")!

    private func day(_ s: String) -> DayString { DayString(s)! }

    /// The interval formatter's spaces (thin, narrow no-break, no-break)
    /// read as plain ones.
    private func plain(_ s: String) -> String {
        return s.replacingOccurrences(of: "\u{2009}", with: " ")
            .replacingOccurrences(of: "\u{202F}", with: " ")
            .replacingOccurrences(of: "\u{00A0}", with: " ")
    }

    private func range(_ start: String, today: DayString? = nil) -> String {
        return plain(PlannerFormat.weekRange(start: day(start), today: today ?? self.today, locale: us))
    }

    // MARK: The scope

    /// The stored values are what @AppStorage keeps: add, never rename.
    @Test func theScopeKeepsItsStoredValues() {
        #expect(TodayScope.allCases == [.day, .week])
        #expect(TodayScope.day.rawValue == "day")
        #expect(TodayScope.week.rawValue == "week")
        #expect(TodayScope.storageKey == "today.scope")
        #expect(TodayLayout.storageKey == "today.layout")
        #expect(TodayLayout.allCases.map(\.rawValue) == ["list", "buckets", "schedule"])
        #expect(TodayScope(rawValue: "month") == nil)
    }

    /// Every layout has a week form since Week × Schedule (design PR 10): a
    /// stored Week draws Week on each, the Show section offers both, and Day
    /// stays Day.
    @Test func everyLayoutDrawsTheStoredScope() {
        for layout in TodayLayout.allCases {
            #expect(layout.hasWeek, "\(layout)")
            #expect(layout.effectiveScope(.week) == .week, "\(layout)")
            #expect(layout.effectiveScope(.day) == .day, "\(layout)")
            #expect(layout.scopes == [.day, .week], "\(layout)")
        }
    }

    @Test func theCapsuleSaysTheLayoutAndTheScope() {
        #expect(TodayScope.day.title == "Day")
        #expect(TodayScope.week.title == "Week")
        #expect(TodayScope.week.showActionName == "Show week")
        #expect(TodayScope.day.showActionName == "Show day")
        #expect(TodayLayout.list.spokenValue(.week) == "List, week")
        #expect(TodayLayout.buckets.spokenValue(.day) == "Buckets, day")
        #expect(TodayLayout.schedule.spokenValue(.week) == "Schedule, week")
        #expect(TodayLayout.schedule.spokenValue(.day) == "Schedule, day")
    }

    // MARK: The week's title

    @Test func theTitleNamesTheWeekFromTheUsersWeekStart() {
        func title(_ start: String, _ weekStart: WeekStartDay) -> String {
            return PlannerFormat.weekTitle(start: day(start), today: today, weekStart: weekStart, locale: us)
        }
        // Monday: Oct 19 to 25 holds today.
        #expect(title("2026-10-19", .monday) == "This week")
        #expect(title("2026-10-26", .monday) == "Next week")
        #expect(title("2026-10-12", .monday) == "Last week")
        #expect(title("2026-11-02", .monday) == "Week of Nov 2")
        #expect(title("2026-10-05", .monday) == "Week of Oct 5")
        // Sunday: Oct 18 to 24.
        #expect(title("2026-10-18", .sunday) == "This week")
        #expect(title("2026-10-25", .sunday) == "Next week")
        #expect(title("2026-10-11", .sunday) == "Last week")
        #expect(title("2026-11-01", .sunday) == "Week of Nov 1")
        // Saturday: Oct 17 to 23.
        #expect(title("2026-10-17", .saturday) == "This week")
        #expect(title("2026-10-24", .saturday) == "Next week")
        #expect(title("2026-10-10", .saturday) == "Last week")
        #expect(title("2026-10-31", .saturday) == "Week of Oct 31")
    }

    /// Any day of a week names that week: the title reads the week's start.
    @Test func anyDayOfTheWeekNamesIt() {
        #expect(PlannerFormat.weekTitle(start: day("2026-10-25"), today: today, weekStart: .monday, locale: us)
            == "This week")
        #expect(PlannerFormat.weekTitle(start: day("2026-10-25"), today: today, weekStart: .sunday, locale: us)
            == "Next week")
        #expect(PlannerFormat.weekTitle(start: day("2026-11-05"), today: today, weekStart: .monday, locale: us)
            == "Week of Nov 2")
    }

    /// The year shows when the week starts in another year than today's, as
    /// a day's title does.
    @Test func theTitleTakesTheYearOffTodaysYear() {
        let december = day("2026-12-30")
        #expect(PlannerFormat.weekTitle(start: day("2026-12-28"), today: december, weekStart: .monday, locale: us)
            == "This week")
        #expect(PlannerFormat.weekTitle(start: day("2027-01-04"), today: december, weekStart: .monday, locale: us)
            == "Next week")
        #expect(PlannerFormat.weekTitle(start: day("2027-01-11"), today: december, weekStart: .monday, locale: us)
            == "Week of Jan 11, 2027")
        #expect(PlannerFormat.weekTitle(start: day("2025-12-01"), today: december, weekStart: .monday, locale: us)
            == "Week of Dec 1, 2025")
    }

    // MARK: The week's range

    @Test func theRangeIsTheSystemsIntervalFormat() {
        #expect(range("2026-10-19") == "Oct 19 \u{2013} 25")
        #expect(range("2026-10-26") == "Oct 26 \u{2013} Nov 1")
        #expect(range("2026-10-18") == "Oct 18 \u{2013} 24")
        #expect(range("2026-10-31") == "Oct 31 \u{2013} Nov 6")
    }

    /// With the years when either end is off today's year.
    @Test func theRangeTakesTheYearsOffTodaysYear() {
        let december = day("2026-12-30")
        #expect(range("2026-12-28", today: december) == "Dec 28, 2026 \u{2013} Jan 3, 2027")
        #expect(range("2027-01-04", today: december) == "Jan 4 \u{2013} 10, 2027")
        #expect(range("2026-12-28", today: day("2027-01-06")) == "Dec 28, 2026 \u{2013} Jan 3, 2027")
        #expect(range("2026-12-21", today: december) == "Dec 21 \u{2013} 27")
    }

    @Test func theSubtitleIsTheRangeAndTheLayout() {
        let list = PlannerFormat.weekSubtitle(start: day("2026-10-19"), today: today, layout: .list, locale: us)
        #expect(plain(list) == "Oct 19 \u{2013} 25 \u{00B7} List")
        let buckets = PlannerFormat.weekSubtitle(start: day("2026-10-26"), today: today, layout: .buckets,
                                                 locale: us)
        #expect(plain(buckets) == "Oct 26 \u{2013} Nov 1 \u{00B7} Buckets")
    }

    @Test func theRangeIsSpokenInWords() {
        func spoken(_ start: String, _ today: DayString) -> String {
            return PlannerFormat.spokenWeekRange(start: day(start), today: today, locale: us)
        }
        #expect(spoken("2026-10-19", today) == "October 19 to 25")
        #expect(spoken("2026-10-26", today) == "October 26 to November 1")
        let december = day("2026-12-30")
        #expect(spoken("2026-12-28", december) == "December 28, 2026 to January 3, 2027")
        // A year shared by both ends is said once; two years are both said.
        #expect(spoken("2027-01-04", december) == "January 4 to January 10, 2027")
        #expect(spoken("2027-03-29", december) == "March 29 to April 4, 2027")
        #expect(spoken("2025-12-29", december) == "December 29, 2025 to January 4, 2026")
    }

    // MARK: A day's heading

    @Test func aHeadingIsTheWeekdayAndTheDate() {
        let thursday = day("2026-10-01")
        #expect(PlannerFormat.weekdayName(thursday, locale: us) == "Thursday")
        #expect(PlannerFormat.headingDate(thursday, locale: us) == "Oct 1")
        // Week × Schedule's column heading, a third of the screen wide.
        #expect(PlannerFormat.columnHeading(thursday, locale: us) == "Thu 1")
        #expect(PlannerFormat.columnHeading(day("2026-10-19"), locale: us) == "Mon 19")
        #expect(PlannerFormat.spokenHeading(thursday, isToday: false, locale: us) == "Thursday, October 1")
        #expect(PlannerFormat.spokenHeading(thursday, isToday: true, locale: us) == "Thursday, October 1, today")
        #expect(PlannerFormat.opensThisDay == "Opens this day")
        #expect(PlannerFormat.nothingPlanned == "Nothing planned.")
    }

    // MARK: Copy

    /// Never an em dash: the range's dash is the system's en dash.
    @Test func noWeekWordHasAnEmDash() {
        let december = day("2026-12-30")
        var words: [String] = [
            PlannerFormat.nothingPlanned, PlannerFormat.nothingMatches, PlannerFormat.opensThisDay,
            PlannerFormat.weekRange(start: day("2026-12-28"), today: december, locale: us),
            PlannerFormat.weekRange(start: day("2026-10-19"), today: today, locale: us),
            PlannerFormat.weekSubtitle(start: day("2026-10-26"), today: today, layout: .list, locale: us),
            PlannerFormat.spokenWeekRange(start: day("2026-12-28"), today: december, locale: us),
            PlannerFormat.weekTitle(start: day("2027-01-11"), today: december, weekStart: .monday, locale: us),
            PlannerFormat.spokenHeading(today, isToday: true, locale: us),
        ]
        words += TodayScope.allCases.flatMap { [$0.title, $0.showActionName] }
        words += TodayLayout.allCases.map { $0.spokenValue(.week) }
        for word in words {
            #expect(!word.contains("\u{2014}"), "\(word)")
        }
    }

    #if canImport(UIKit)
    /// Every symbol the capsule's menu draws exists on this iOS (xcode-27
    /// runner only: the shim has no UIKit).
    @Test func everyScopeAndLayoutSymbolExists() {
        for scope in TodayScope.allCases {
            #expect(UIImage(systemName: scope.systemImage) != nil, "\(scope.systemImage)")
        }
        for layout in TodayLayout.allCases {
            #expect(UIImage(systemName: layout.systemImage) != nil, "\(layout.systemImage)")
        }
    }
    #endif
}
