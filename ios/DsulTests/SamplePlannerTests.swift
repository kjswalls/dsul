import DsulCore
import Foundation
import Testing
@testable import Dsul

@MainActor
@Suite struct SamplePlannerTests {
    /// A Thursday, so the weekday-only habit shows and the Sun/Wed one doesn't.
    /// The clock is noon UTC that day, so a pause, or a sheet opened from
    /// Search, reads the same day.
    private func makePlanner() -> SamplePlanner {
        SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
    }

    private func first(_ planner: SamplePlanner, _ title: String) -> SampleItem {
        planner.items.first { $0.title == title && $0.day != nil || $0.title == title && $0.isHabit }!
    }

    // MARK: The drag spike

    @Test func schedulingMovesAnItemOutOfTheBraindump() {
        let planner = makePlanner()
        let item = planner.braindump[0]
        let before = planner.scheduled.count
        planner.schedule(item.id, startMin: 9 * 60 + 15)
        #expect(!planner.braindump.contains { $0.id == item.id })
        #expect(planner.scheduled.count == before + 1)
        #expect(planner.item(item.id)?.startMin == 555)
        #expect(planner.isScheduled(item.id))
    }

    @Test func schedulingFilesTheItemUnderTheHoursBucket() {
        let planner = makePlanner()
        let item = planner.braindump[0]
        planner.schedule(item.id, startMin: 15 * 60)
        #expect(planner.buckets()[.afternoon]?.contains { $0.id == item.id } == true)
    }

    @Test func reschedulingMovesABlock() {
        let planner = makePlanner()
        let block = planner.scheduled[0]
        let count = planner.scheduled.count
        planner.schedule(block.id, startMin: 600)
        #expect(planner.item(block.id)?.startMin == 600)
        #expect(planner.scheduled.count == count)
    }

    /// The web's `addTask` appends (`order = tasks.length`), and the braindump
    /// is in stored order, so a capture lands at the end.
    @Test func captureAddsToTheEndAndIgnoresBlanks() {
        let planner = makePlanner()
        let count = planner.braindump.count
        planner.capture("  New thought ")
        planner.capture("   ")
        #expect(planner.braindump.count == count + 1)
        #expect(planner.braindump.last?.title == "New thought")
        #expect(planner.braindump.last?.day == nil)
    }

    @Test func theSampleIsLoadedAndNeverSyncs() {
        let planner = makePlanner()
        #expect(!planner.isLive)
        #expect(planner.hasLoaded)
        #expect(planner.sync == nil)
        #expect(planner.userId == nil)
    }

    @Test func stressFillsTheDayToFortyBlocks() {
        let planner = makePlanner()
        planner.stress()
        #expect(planner.scheduled.count == 40)
        #expect(planner.scheduled.allSatisfy { ($0.startMin ?? -1) >= 0 })
    }

    @Test func stressOnTwoDaysNeverRepeatsAnId() {
        let planner = makePlanner()
        planner.stress()
        planner.shiftDay(by: 1)
        planner.stress()
        #expect(planner.scheduled.count == 40)
        #expect(Set(planner.items.map(\.id)).count == planner.items.count)
    }

    @Test func sampleIdsAreStable() {
        #expect(makePlanner().braindump[0].id == makePlanner().braindump[0].id)
    }

    @Test func dragStateSnapsTheGhost() {
        let drag = ScheduleDrag()
        drag.begin(itemID: nil, durationMin: 60, detent: .medium)
        drag.setContentY(712.5)  // 09:30 at 75pt an hour
        #expect(drag.ghostStartMin == 540)
        drag.reset()
        #expect(drag.ghostStartMin == nil)
        #expect(drag.phase == "idle")
    }

    // MARK: Days

    @Test func habitsShowByTheirRepeatAndTasksOnTheirDay() {
        let planner = makePlanner()
        let titles = Set(planner.dayItems.map(\.title))
        #expect(titles.contains("Meds"))
        #expect(titles.contains("Plan tomorrow"))       // weekdays, and it's Thursday
        #expect(!titles.contains("Water the plants"))   // Sun and Wed
        #expect(titles.contains("Call the dentist"))

        planner.shiftDay(by: -1)                          // Wednesday
        let wednesday = Set(planner.dayItems.map(\.title))
        #expect(wednesday.contains("Water the plants"))
        #expect(!wednesday.contains("Call the dentist"))
        #expect(planner.scheduled.isEmpty)

        planner.goToToday()
        #expect(planner.isOnToday)
        #expect(planner.selectedDayString == "2026-10-01")
    }

    @Test func refreshTodayCarriesASelectionThatWasOnToday() {
        let planner = makePlanner()
        planner.refreshToday(to: planner.today.adding(days: 1))
        #expect(planner.today.description == "2026-10-02")
        #expect(planner.selectedDayString == "2026-10-02")
        #expect(planner.isOnToday)
    }

    @Test func refreshTodayLeavesAPickedDayAlone() {
        let planner = makePlanner()
        planner.shiftDay(by: -3)
        planner.refreshToday(to: planner.today.adding(days: 1))
        #expect(planner.today.description == "2026-10-02")
        #expect(planner.selectedDayString == "2026-09-28")
        #expect(!planner.isOnToday)
    }

    @Test func refreshTodayOnTheSameDayChangesNothing() {
        let planner = makePlanner()
        planner.shiftDay(by: 2)
        planner.refreshToday(to: planner.today)
        #expect(planner.selectedDayString == "2026-10-03")
        #expect(planner.today.description == "2026-10-01")
    }

    @Test func refreshTodayReadsTheDeviceDayFromADate() {
        let planner = makePlanner()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let noon = calendar.date(from: DateComponents(year: 2026, month: 10, day: 5, hour: 12))!
        planner.refreshToday(now: noon, calendar: calendar)
        #expect(planner.selectedDayString == "2026-10-05")
    }

    // MARK: Sheets

    @Test func oneSheetShowsOverWhicheverHostIsOnTop() {
        let planner = makePlanner()
        planner.activeSheet = .capture
        #expect(planner.sheetOverApp == .capture)
        #expect(planner.sheetOverBraindump == nil)

        planner.activeSheet = nil
        planner.showBraindumpSheet = true
        planner.activeSheet = .datePicker
        #expect(planner.sheetOverApp == nil)
        #expect(planner.sheetOverBraindump == .datePicker)

        // A dismissal through either host clears the one flag.
        planner.sheetOverBraindump = nil
        #expect(planner.activeSheet == nil)
    }

    @Test func anItemSheetIsOneSlotLikeTheOthers() {
        let planner = makePlanner()
        let roadmap = first(planner, "Draft Q4 roadmap")
        planner.open(roadmap.id, day: .selected)
        #expect(planner.activeSheet == .item(roadmap.id, day: .selected))
        #expect(planner.sheetOverApp?.id == "item-" + roadmap.id.uuidString.lowercased())

        planner.showBraindumpSheet = true
        #expect(planner.sheetOverApp == nil)
        #expect(planner.sheetOverBraindump == .item(roadmap.id, day: .selected))
        planner.sheetOverBraindump = nil
        #expect(planner.activeSheet == nil)

        planner.open(UUID(), day: .selected)   // no such item
        #expect(planner.activeSheet == nil)
    }

    /// Search has no day of its own, so its sheet acts on today, whatever day
    /// Today is showing.
    @Test func searchOpensOnTodayWhateverDayIsSelected() {
        let planner = makePlanner()
        let journal = first(planner, "Journal")
        planner.shiftDay(by: 2)
        planner.open(journal.id, day: .today)
        #expect(planner.activeSheet == .item(journal.id, day: .today))
        #expect(planner.actingDay(.today).description == "2026-10-01")
        #expect(planner.actingDay(.selected).description == "2026-10-03")

        planner.toggle(journal.id, on: planner.actingDay(.today))
        let now = planner.item(journal.id)
        #expect(now?.completedDates.contains("2026-10-01") == true)
        #expect(now?.completedDates.contains("2026-10-03") == false)
        #expect(now?.streak == 4)
    }

    /// Opening from Search brings today up to the planner's clock first; a
    /// row's sheet acts on the day it was drawn on and moves nothing.
    @Test func openingFromSearchReadsTheClock() {
        let nextNoon = PlannerJSON.noon.addingTimeInterval(24 * 60 * 60)
        let planner = SamplePlanner(todayString: "2026-10-01", now: { nextNoon })
        let journal = first(planner, "Journal")

        planner.open(journal.id, day: .selected)
        #expect(planner.today.description == "2026-10-01")

        planner.open(journal.id, day: .today)
        #expect(planner.today.description == "2026-10-02")
        #expect(planner.actingDay(.today).description == "2026-10-02")
    }

    /// The sample sends nothing, but every verb still takes its optimistic
    /// step, as a signed-in one does before the server answers.
    @Test func theSampleTakesEveryVerbWithoutSending() throws {
        let planner = makePlanner()
        #expect(planner.sync == nil)
        #expect(planner.canWrite("skip"))
        #expect(planner.canWrite("move"))
        #expect(planner.canWrite("pause"))
        let today = planner.today

        let journal = first(planner, "Journal")
        #expect(planner.offeredVerbs(for: journal, day: .selected) == [.tick, .skip, .pause])
        planner.skip(journal.id, on: today)
        #expect(planner.item(journal.id)?.skippedDates == ["2026-10-01"])
        #expect(planner.item(journal.id)?.status == "skipped")
        planner.unskip(journal.id, on: today)
        #expect(planner.item(journal.id)?.skippedDates.isEmpty == true)

        let groceries = first(planner, "Groceries")
        let target = nextDayOf(groceries, planner.verbContext(for: groceries, day: .selected))
        planner.move(groceries.id, to: target)
        #expect(planner.item(groceries.id)?.startDate == "2026-10-02")
        #expect(!planner.dayItems.contains { $0.id == groceries.id })

        let plan = first(planner, "Plan tomorrow")
        planner.pause(plan.id, until: nil)
        #expect(planner.item(plan.id)?.pausedAt == "2026-10-01T12:00:00.000Z")
        #expect(!planner.dayItems.contains { $0.id == plan.id })
        let paused = try #require(planner.item(plan.id))
        #expect(planner.offeredVerbs(for: paused, day: .selected).contains(.resume))
        planner.resume(plan.id)
        #expect(planner.item(plan.id)?.pausedUntil == "2026-10-01")
        #expect(planner.dayItems.contains { $0.id == plan.id })
    }

    @Test func nextWeekStartsOnTheUsersWeekStart() {
        let planner = makePlanner()
        // Thursday 2026-10-01; the sample's week starts on Sunday (the default).
        #expect(planner.nextWeekStart.description == "2026-10-04")
    }

    // MARK: The sample's details

    @Test func theSampleCarriesWhatTheSheetShows() {
        let planner = makePlanner()
        let roadmap = first(planner, "Draft Q4 roadmap")
        #expect(roadmap.notes?.isEmpty == false)
        #expect(roadmap.priority == "high")
        let meds = first(planner, "Meds")
        #expect(meds.reminderTime == "08:00")
        #expect(meds.reminderAnchor == "I pour my coffee")
        #expect(planner.routineNames(for: meds.id) == ["Morning routine"])
        #expect(planner.seasonNames(for: meds.id).isEmpty)

        let subtasks = planner.subtasks(of: roadmap.id)
        #expect(subtasks.map(\.title) == ["Pull the September numbers", "Write the three bets"])
        #expect(subtasks.allSatisfy { $0.isSubtask })
        #expect(!roadmap.isSubtask)
        // Only in their parent's sheet: never on a day or in the braindump.
        let ids = Set(subtasks.map(\.id))
        #expect(!planner.dayItems.contains { ids.contains($0.id) })
        #expect(!planner.braindump.contains { ids.contains($0.id) })
        #expect(subtasks.allSatisfy { planner.offeredVerbs(for: $0, day: .selected) == [.tick] })
    }

    // MARK: Completion

    @Test func tickingATaskFlipsItsFlag() {
        let planner = makePlanner()
        let task = first(planner, "Groceries")
        #expect(!planner.isDone(task))
        planner.toggle(task.id)
        #expect(planner.isDone(planner.item(task.id)!))
        planner.toggle(task.id)
        #expect(!planner.isDone(planner.item(task.id)!))
    }

    @Test func tickingAHabitMovesItsStreakByOne() {
        let planner = makePlanner()
        let journal = first(planner, "Journal")
        #expect(!planner.isDone(journal))
        #expect(journal.streak == 3)

        planner.toggle(journal.id)
        var now = planner.item(journal.id)!
        #expect(planner.isDone(now))
        #expect(now.streak == 4)
        #expect(now.completedDates.contains("2026-10-01"))

        planner.toggle(journal.id)
        now = planner.item(journal.id)!
        #expect(!planner.isDone(now))
        #expect(now.streak == 3)
        #expect(!now.completedDates.contains("2026-10-01"))
    }

    @Test func aHabitIsDonePerDate() {
        let planner = makePlanner()
        let meds = first(planner, "Meds")
        #expect(planner.isDone(meds))        // done today
        planner.shiftDay(by: 5)
        #expect(!planner.isDone(meds))       // not on a later day
    }

    // MARK: List layout

    @Test func chipsCountTheDay() {
        let planner = makePlanner()
        let all = planner.count(.all)
        #expect(all == planner.count(.tasks) + planner.count(.habits))
        #expect(planner.count(.habits) == 4)  // three routine habits and Plan tomorrow
        #expect(planner.count(.project("Work")) == 4)
        #expect(planner.dayProjects.first == "Work")
    }

    @Test func listSectionsPutTheRoutineFirstWithDoneOverTotal() {
        let planner = makePlanner()
        let sections = planner.listSections(.all)
        let routine = sections[0]
        #expect(routine.kind == .routine)
        #expect(routine.title == "Morning routine")
        #expect(routine.items.map(\.title) == ["Meds", "Stretch 10 min", "Journal"])
        #expect(routine.doneCount == 2)
        #expect(sections[1].title == "Work")
        // Timed rows lead, then untimed by order.
        #expect(sections[1].items.map(\.title) == ["Draft Q4 roadmap", "Standup", "Reply to Avery about pricing",
                                                   "Review design PR"])
        #expect(sections.last?.kind == .loose)
        // Every day item lands in exactly one section.
        #expect(sections.reduce(0) { $0 + $1.items.count } == planner.count(.all))
    }

    @Test func filteringNarrowsTheSections() {
        let planner = makePlanner()
        #expect(planner.listSections(.habits).allSatisfy { $0.items.allSatisfy(\.isHabit) })
        let home = planner.listSections(.project("Home"))
        #expect(home.map(\.title) == ["Home"])
        #expect(planner.listSections(.tasks).allSatisfy { $0.kind != .routine })
    }

    // MARK: Buckets layout

    @Test func bucketsMatchTheBoards() {
        let planner = makePlanner()
        let buckets = planner.buckets()
        let morning = buckets[.morning]?.map(\.title) ?? []
        #expect(Array(morning.prefix(3)) == ["Meds", "Stretch 10 min", "Journal"])
        #expect(morning.contains("Draft Q4 roadmap"))
        #expect(buckets[.afternoon]?.contains { $0.title == "Call the dentist" } == true)
        #expect(buckets[.anytime]?.map(\.title) == ["Reply to Avery about pricing", "Review design PR", "Groceries"])
        #expect(buckets.values.reduce(0) { $0 + $1.count } == planner.count(.all))
    }

    // MARK: Layout and formatting

    @Test func layoutsStepAndWrap() {
        #expect(TodayLayout.list.next == .buckets)
        #expect(TodayLayout.schedule.next == .list)
        #expect(TodayLayout.list.previous == .schedule)
        #expect(TodayLayout.buckets.stepped(by: -4) == .list)
        #expect(TodayLayout.list.stepped(by: 5) == .schedule)
    }

    @Test func rowTimes() {
        #expect(PlannerFormat.rowTime(startMin: 15 * 60, durationMin: 15) == "3 PM")
        #expect(PlannerFormat.rowTime(startMin: 9 * 60, durationMin: 120) == "9\u{2013}11")
        #expect(PlannerFormat.rowTime(startMin: 11 * 60 + 15, durationMin: 15) == "11:15 AM")
        #expect(PlannerFormat.rowTime(startMin: 0, durationMin: 30) == "12 AM")
        #expect(PlannerFormat.rowTime(startMin: nil, durationMin: 30) == nil)
        #expect(PlannerFormat.isNow(startMin: 540, durationMin: 120, nowMin: 600))
        #expect(!PlannerFormat.isNow(startMin: 540, durationMin: 120, nowMin: 660))
    }

    @Test func titleSaysTodayOnlyOnToday() {
        let planner = makePlanner()
        #expect(PlannerFormat.title(selected: planner.selectedDay, today: planner.today) == "Today")
        planner.shiftDay(by: 1)
        #expect(PlannerFormat.title(selected: planner.selectedDay, today: planner.today) == "Tomorrow")
        planner.shiftDay(by: 3)
        #expect(PlannerFormat.title(selected: planner.selectedDay, today: planner.today) != "Today")
        #expect(PlannerFormat.subtitle(selected: planner.selectedDay, layout: .buckets).hasSuffix("\u{00B7} Buckets"))
    }
}
