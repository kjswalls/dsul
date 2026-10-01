import Testing
// A plain import, not @testable: this file only compiles if everything the app
// uses is public, so the Linux job catches a missing `public`.
import DsulCore

// Ports of tests/unit/recurrence.test.ts, plus edges the web file doesn't cover.

private func day(_ s: String) -> DayString { DayString(s)! }

// Mon 2025-01-13 … Sun 2025-01-19
private let week = ["2025-01-12", "2025-01-13", "2025-01-14", "2025-01-15",
                    "2025-01-16", "2025-01-17", "2025-01-18", "2025-01-19"]

@Suite struct RecurrenceTests {
    @Test(arguments: week)
    func dailyShowsEveryDay(_ d: String) {
        #expect(shouldShowOnDate(RepeatRule(frequency: "daily"), on: day(d)))
    }

    @Test func weekdaysSkipTheWeekend() {
        let rule = RepeatRule(frequency: "weekdays")
        let shown = week.filter { shouldShowOnDate(rule, on: day($0)) }
        #expect(shown == ["2025-01-13", "2025-01-14", "2025-01-15", "2025-01-16", "2025-01-17"])
    }

    @Test func weekendsOnlyTheWeekend() {
        let rule = RepeatRule(frequency: "weekends")
        let shown = week.filter { shouldShowOnDate(rule, on: day($0)) }
        #expect(shown == ["2025-01-12", "2025-01-18", "2025-01-19"])
    }

    @Test func customMonWedFri() {
        let rule = RepeatRule(frequency: "custom", days: [1, 3, 5])
        let shown = week.filter { shouldShowOnDate(rule, on: day($0)) }
        #expect(shown == ["2025-01-13", "2025-01-15", "2025-01-17"])
    }

    @Test(arguments: week)
    func weeklyReadsLikeCustom(_ d: String) {
        let weekly = RepeatRule(frequency: "weekly", days: [1, 3, 5])
        let custom = RepeatRule(frequency: "custom", days: [1, 3, 5])
        #expect(shouldShowOnDate(weekly, on: day(d)) == shouldShowOnDate(custom, on: day(d)))
    }

    @Test func noneUnknownAndEmptyShowNowhere() {
        for d in week {
            #expect(!shouldShowOnDate(RepeatRule(), on: day(d)))
            #expect(!shouldShowOnDate(RepeatRule(frequency: "none"), on: day(d)))
            #expect(!shouldShowOnDate(RepeatRule(frequency: "fortnightly"), on: day(d)))
            #expect(!shouldShowOnDate(RepeatRule(frequency: "custom", days: []), on: day(d)))
            #expect(!shouldShowOnDate(RepeatRule(frequency: "custom"), on: day(d)))
            #expect(!shouldShowOnDate(RepeatRule(frequency: "monthly"), on: day(d)))
        }
    }

    @Test func monthlyOnItsDay() {
        let rule = RepeatRule(frequency: "monthly", monthDay: 15)
        #expect(!shouldShowOnDate(rule, on: day("2025-01-14")))
        #expect(shouldShowOnDate(rule, on: day("2025-01-15")))
        #expect(!shouldShowOnDate(rule, on: day("2025-01-16")))
        #expect(shouldShowOnDate(rule, on: day("2025-02-15")))
    }

    @Test func monthlyClampsToTheLastDay() {
        let rule = RepeatRule(frequency: "monthly", monthDay: 31)
        #expect(shouldShowOnDate(rule, on: day("2025-02-28")))
        #expect(!shouldShowOnDate(rule, on: day("2025-02-27")))
        #expect(shouldShowOnDate(rule, on: day("2026-02-28")))
        #expect(shouldShowOnDate(rule, on: day("2028-02-29")))  // leap year
        #expect(!shouldShowOnDate(rule, on: day("2028-02-28")))
        #expect(shouldShowOnDate(rule, on: day("2026-04-30")))
        #expect(shouldShowOnDate(rule, on: day("2026-03-31")))
        #expect(!shouldShowOnDate(rule, on: day("2026-03-30")))
        let the29th = RepeatRule(frequency: "monthly", monthDay: 29)
        #expect(shouldShowOnDate(the29th, on: day("2027-02-28")))
    }

    @Test func completedAndSkippedReadPerDate() {
        #expect(isCompletedOnDate(["2025-01-13", "2025-01-15"], day("2025-01-13")))
        #expect(isCompletedOnDate(["2025-01-13", "2025-01-15"], day("2025-01-15")))
        #expect(!isCompletedOnDate(["2025-01-13"], day("2025-01-14")))
        #expect(!isCompletedOnDate([], day("2025-01-13")))
        #expect(!isCompletedOnDate(nil, day("2025-01-13")))
        #expect(isSkippedOnDate(["2025-01-13"], day("2025-01-13")))
        #expect(!isSkippedOnDate(["2025-01-13"], day("2025-01-14")))
        #expect(!isSkippedOnDate(nil, day("2025-01-13")))
    }

    @Test func recurringMeansAFrequencyOtherThanNone() {
        for f in ["daily", "weekdays", "weekends", "monthly", "custom"] {
            #expect(isRecurring(RepeatRule(frequency: f)))
        }
        #expect(!isRecurring(RepeatRule(frequency: "none")))
        #expect(!isRecurring(RepeatRule()))
    }
}

@Suite struct AnchoredSeriesTests {
    let thursdays = RepeatRule(frequency: "custom", days: [4])

    @Test func startCountsThenTheRepeatAndNothingBefore() {
        // 2026-09-25 is a Friday.
        #expect(anchoredSeriesOn(thursdays, start: day("2026-09-25"), on: day("2026-09-25")))
        #expect(!anchoredSeriesOn(thursdays, start: day("2026-09-25"), on: day("2026-09-24")))
        #expect(anchoredSeriesOn(thursdays, start: day("2026-09-25"), on: day("2026-10-01")))
        #expect(!anchoredSeriesOn(thursdays, start: day("2026-09-25"), on: day("2026-10-02")))
        // Legacy ISO start dates compare by day.
        #expect(anchoredSeriesOn(thursdays, start: day("2026-09-25T00:00:00Z"), on: day("2026-09-25")))
    }

    @Test func firstRepeatDayAcrossAMonthEnd() {
        #expect(firstRepeatDayFrom(thursdays, from: day("2026-09-24")) == day("2026-09-24"))
        #expect(firstRepeatDayFrom(thursdays, from: day("2026-09-25")) == day("2026-10-01"))
        let monthly31 = RepeatRule(frequency: "monthly", monthDay: 31)
        #expect(firstRepeatDayFrom(monthly31, from: day("2026-02-02")) == day("2026-02-28"))
        // A rule that falls on no day keeps the date it was given.
        let never = RepeatRule(frequency: "custom", days: [])
        #expect(firstRepeatDayFrom(never, from: day("2026-09-25")) == day("2026-09-25"))
    }
}
