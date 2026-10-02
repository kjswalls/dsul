import DsulCore
import Foundation
import Testing
@testable import Dsul

/// The item sheet's words and slots (ItemSheetModel) and a row's VoiceOver
/// sentence, on the sample's Thursday 2026-10-01: which verbs sit in the bar
/// and which behind ⋯, the bar's short words, the "For …" caption and the
/// "Not due" line, the chips in the web panel's order, the streak chip's week,
/// and the time ranges.
@MainActor
@Suite struct ItemSheetTests {
    private func makePlanner() -> SamplePlanner {
        SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
    }

    private func named(_ planner: SamplePlanner, _ title: String) throws -> SampleItem {
        let found = planner.items.first(where: { $0.title == title })
        return try #require(found)
    }

    /// What the sheet works out for `item` on `day` (today when nil): the
    /// context, the verbs the planner offers, and where they go.
    private func sheet(_ planner: SamplePlanner, _ item: SampleItem,
                       on day: DayString? = nil) -> (ctx: VerbContext, offered: [VerbID], verbs: SheetVerbs) {
        let ctx = planner.verbContext(for: item, on: day ?? planner.today)
        let offered = VerbID.allCases.filter { planner.offers($0, item, ctx) }
        return (ctx, offered, ItemSheetModel.verbs(item, ctx, offered: offered))
    }

    // MARK: The bar

    @Test func aOneOffTaskOffersTheTickTomorrowAndReschedule() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")
        let (ctx, offered, verbs) = sheet(planner, roadmap)

        #expect(verbs.bar == [.tick, .nextDay, .reschedule])
        #expect(verbs.menu == [.pause, .pauseUntil])
        #expect(!verbs.notDue)
        #expect(ItemSheetModel.barLabel(.tick, roadmap, ctx) == "Done")
        #expect(ItemSheetModel.spokenLabel(.tick, roadmap, ctx) == "Mark done")
        #expect(ItemSheetModel.barLabel(.nextDay, roadmap, ctx) == "Tomorrow")
        #expect(ItemSheetModel.spokenValue(.nextDay, roadmap, ctx) == "Fri, Oct 2")
        #expect(ItemSheetModel.barLabel(.reschedule, roadmap, ctx) == "Reschedule")
        #expect(ItemSheetModel.dayCaption(roadmap, ctx, offered: offered) == nil)
    }

    @Test func aHabitOffersSkipAndThePauseFamilyAndNothingBehindMore() throws {
        let planner = makePlanner()
        let journal = try named(planner, "Journal")
        let (ctx, offered, verbs) = sheet(planner, journal)

        #expect(offered.contains(.tick))
        #expect(verbs.bar == [.skip, .pause, .pauseUntil])
        #expect(verbs.menu.isEmpty)
        #expect(ItemSheetModel.barLabel(.skip, journal, ctx) == "Skip today")
        #expect(ItemSheetModel.spokenLabel(.tick, journal, ctx) == "Done today")
        #expect(ItemSheetModel.dayCaption(journal, ctx, offered: offered) == nil)
    }

    /// The bar's words say "today" only on today; off it a caption names the
    /// day the tick and Skip act on.
    @Test func offTodayTheWordTodayGoesAndACaptionNamesTheDay() throws {
        let planner = makePlanner()
        let journal = try named(planner, "Journal")
        let friday = planner.today.adding(days: 1)
        let (ctx, offered, verbs) = sheet(planner, journal, on: friday)

        #expect(verbs.bar == [.skip, .pause, .pauseUntil])
        #expect(ItemSheetModel.barLabel(.skip, journal, ctx) == "Skip")
        #expect(ItemSheetModel.dayCaption(journal, ctx, offered: offered) == "For Fri, Oct 2")
    }

    @Test func aDayTheItemDoesNotFallOnHasANotDueLineInPlaceOfTheBar() throws {
        let planner = makePlanner()
        let weekdays = try named(planner, "Plan tomorrow")
        let saturday = try #require(DayString("2026-10-03"))
        let (ctx, offered, verbs) = sheet(planner, weekdays, on: saturday)

        #expect(ctx.occurrence == .absent)
        #expect(verbs.notDue)
        #expect(verbs.bar.isEmpty)
        #expect(verbs.menu == [.pause, .pauseUntil])
        #expect(ItemSheetModel.notDueLine(ctx) == "Not due Sat, Oct 3")
        #expect(ItemSheetModel.dayCaption(weekdays, ctx, offered: offered) == nil)
    }

    @Test func aSubtaskIsOfferedTheTickAlone() throws {
        let planner = makePlanner()
        let subtask = try named(planner, "Write the three bets")
        let (_, offered, verbs) = sheet(planner, subtask)

        #expect(offered == [.tick])
        #expect(verbs.bar == [.tick])
        #expect(verbs.menu.isEmpty)
    }

    /// Paused today, in the zone handed in: Resume alone, and the note says
    /// until when.
    @Test func aPausedItemOffersResumeAloneAndSaysUntilWhen() throws {
        let planner = makePlanner()
        var journal = try named(planner, "Journal")
        journal.pausedAt = "2026-09-30T12:00:00.000Z"
        journal.pausedUntil = "2026-10-08"
        let today = "2026-10-01"
        let ctx = VerbContext(dateStr: today, todayStr: today, timeZone: "UTC",
                              occurrence: occurrenceOn(journal, on: today, today: today, timeZone: "UTC"))
        let verbs = ItemSheetModel.verbs(journal, ctx, offered: eligibleVerbs(journal, ctx))

        #expect(verbs.bar == [.resume])
        #expect(verbs.menu.isEmpty)
        #expect(ItemSheetModel.pauseNote(journal, today: today, timeZone: "UTC") == "Paused until Oct 8")
        // Not yet begun the day before, and over on the day it ends: no note.
        #expect(ItemSheetModel.pauseNote(journal, today: "2026-09-29", timeZone: "UTC") == nil)
        #expect(ItemSheetModel.pauseNote(journal, today: "2026-10-08", timeZone: "UTC") == nil)

        journal.pausedUntil = nil
        #expect(ItemSheetModel.pauseNote(journal, today: today, timeZone: "UTC") == "Paused")
    }

    @Test func aSkipAndItsUnskipShareASlot() {
        #expect(SheetVerb.skip.slotID == SheetVerb.unskip.slotID)
        #expect(SheetVerb.pause.slotID == SheetVerb.resume.slotID)
        #expect(SheetVerb.pause.slotID != SheetVerb.pauseUntil.slotID)
        #expect(SheetVerb.pauseUntil.verb == .pause)
    }

    // MARK: The header and the chips

    @Test func theEyebrowNamesTheTypeAndTheFirstRoutine() throws {
        let planner = makePlanner()
        let meds = try named(planner, "Meds")
        let roadmap = try named(planner, "Draft Q4 roadmap")

        #expect(ItemSheetModel.eyebrow(meds, routineNames: planner.routineNames(for: meds.id))
                == "Habit \u{00B7} Morning routine")
        #expect(ItemSheetModel.eyebrow(roadmap, routineNames: planner.routineNames(for: roadmap.id)) == "Task")
    }

    @Test func aTasksChipsFollowTheWebPanelsOrder() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")
        let chips = ItemSheetModel.chips(roadmap, today: planner.today, timeFormat: .twelveHour,
                                         routineNames: [], seasonNames: [])

        #expect(chips.map(\.kind) == [.priority, .date, .time, .project])
        #expect(chips.map(\.text) == ["High", "Today", "9:00\u{2013}11:00 am", "Work"])
        #expect(chips[2].spoken == "Time: 9:00 to 11:00 am")
        #expect(chips[3].systemImage == nil)

        let dentist = try named(planner, "Call the dentist")
        let dentistChips = ItemSheetModel.chips(dentist, today: planner.today, timeFormat: .twelveHour,
                                                routineNames: [], seasonNames: [])
        #expect(dentistChips.map(\.text) == ["Medium", "Today", "3:00\u{2013}3:15 pm", "2:45 pm", "Home"])
    }

    /// An untimed task in Anytime has no Time chip: "Anytime" says nothing.
    @Test func anAnytimeTaskHasNoTimeChip() throws {
        let planner = makePlanner()
        let groceries = try named(planner, "Groceries")
        let chips = ItemSheetModel.chips(groceries, today: planner.today, timeFormat: .twelveHour,
                                         routineNames: [], seasonNames: [])
        #expect(chips.map(\.kind) == [.date, .project])
    }

    @Test func aHabitsChipsCarryItsBucketRepeatReminderAndRoutine() throws {
        let planner = makePlanner()
        let meds = try named(planner, "Meds")
        let chips = ItemSheetModel.chips(meds, today: planner.today, timeFormat: .twelveHour,
                                         routineNames: planner.routineNames(for: meds.id),
                                         seasonNames: planner.seasonNames(for: meds.id))

        #expect(chips.map(\.kind) == [.time, .repeats, .reminder, .routine])
        #expect(chips.map(\.text) == ["Morning", "Daily", "After I pour my coffee \u{00B7} 8:00 am", "Morning routine"])
        #expect(chips[2].spoken == "Reminder: After I pour my coffee, 8:00 am")
        #expect(chips[3].spoken == "Routine: Morning routine")
    }

    @Test func timeRangesReadAsTheUsersClockDoes() {
        #expect(ItemSheetModel.timeRange(startMin: 9 * 60, durationMin: 120, timeFormat: .twelveHour)
                == "9:00\u{2013}11:00 am")
        #expect(ItemSheetModel.timeRange(startMin: 11 * 60, durationMin: 120, timeFormat: .twelveHour)
                == "11:00 am\u{2013}1:00 pm")
        #expect(ItemSheetModel.timeRange(startMin: 23 * 60, durationMin: 120, timeFormat: .twelveHour)
                == "11:00 pm\u{2013}1:00 am")
        #expect(ItemSheetModel.timeRange(startMin: 9 * 60, durationMin: 120, timeFormat: .twentyFourHour)
                == "09:00\u{2013}11:00")
        #expect(ItemSheetModel.timeRange(startMin: 15 * 60, durationMin: 0, timeFormat: .twelveHour) == "3:00 pm")
    }

    // MARK: The streak chip

    @Test func theStreakChipDrawsThisWeek() throws {
        let planner = makePlanner()
        let meds = try named(planner, "Meds")   // done today and the two days before
        let sunday = ItemSheetModel.weekDots(meds, today: planner.today, weekStartDay: .sunday)
        #expect(sunday == [.rest, .rest, .done, .done, .done, .rest, .rest])
        #expect(ItemSheetModel.streakSpoken(streak: meds.streak ?? 0, dots: sunday) == "Streak 41; this week: 3 done")

        let monday = ItemSheetModel.weekDots(meds, today: planner.today, weekStartDay: .monday)
        #expect(monday == [.rest, .done, .done, .done, .rest, .rest, .rest])
    }

    @Test func todayIsARingUntilItIsTickedAndSkipsAreCounted() throws {
        let planner = makePlanner()
        var journal = try named(planner, "Journal")   // done the three days before today
        journal.skippedDates = ["2026-09-27"]
        let dots = ItemSheetModel.weekDots(journal, today: planner.today, weekStartDay: .sunday)

        #expect(dots == [.skipped, .done, .done, .done, .today, .rest, .rest])
        #expect(ItemSheetModel.streakSpoken(streak: 3, dots: dots) == "Streak 3; this week: 3 done, 1 skipped")
    }

    // MARK: A row to VoiceOver

    @Test func aRowsTimeIsSpokenAsItReads() {
        #expect(PlannerFormat.spokenRowTime(startMin: 9 * 60, durationMin: 120) == "9 to 11 AM")
        #expect(PlannerFormat.spokenRowTime(startMin: 11 * 60, durationMin: 120) == "11 AM to 1 PM")
        #expect(PlannerFormat.spokenRowTime(startMin: 15 * 60, durationMin: 15) == "3 PM")
        #expect(PlannerFormat.spokenRowTime(startMin: nil, durationMin: 30) == nil)
    }

    @Test func aRowIsOneSentence() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")
        let meds = try named(planner, "Meds")

        #expect(PlannerFormat.rowLabel(roadmap, isNow: false) == "Draft Q4 roadmap, 9 to 11 AM")
        #expect(PlannerFormat.rowLabel(roadmap, isNow: true) == "Draft Q4 roadmap, now, 9 to 11 AM")
        #expect(PlannerFormat.rowLabel(meds, isNow: false) == "Meds, streak 41")
    }
}
