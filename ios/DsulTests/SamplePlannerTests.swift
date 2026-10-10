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
        #expect(planner.offeredVerbs(for: journal, day: .selected) == [.tick, .skip, .pause, .resetStreak, .delete])
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

    /// The sample's title, notes and Delete take their steps and send
    /// nothing, as its verbs do. Delete takes the roadmap's two subtasks with
    /// it and closes its sheet; a habit goes alone.
    @Test func theSampleTakesEveryEditAndDeleteWithoutSending() throws {
        let planner = makePlanner()
        #expect(planner.sync == nil)
        #expect(planner.canWrite("title"))
        #expect(planner.canWrite("notes"))
        #expect(planner.canWrite("delete"))

        let roadmap = first(planner, "Draft Q4 roadmap")
        #expect(planner.caps(for: roadmap).label == "Task")
        #expect(planner.typeLabel(for: roadmap) == "Task")
        planner.edit(roadmap.id, .title("  Draft the Q4 roadmap "))
        #expect(planner.item(roadmap.id)?.title == "Draft the Q4 roadmap")
        planner.edit(roadmap.id, .notes(nil))
        #expect(planner.item(roadmap.id)?.notes == nil)
        planner.edit(roadmap.id, .notes("Bets first, then numbers"))
        #expect(planner.item(roadmap.id)?.notes == "Bets first, then numbers")

        let children = planner.subtasks(of: roadmap.id).map(\.id)
        #expect(children.count == 2)
        planner.open(roadmap.id, day: .selected)
        planner.deleteItem(roadmap.id)
        #expect(planner.item(roadmap.id) == nil)
        #expect(children.allSatisfy { planner.item($0) == nil })
        #expect(planner.activeSheet == nil)
        #expect(!planner.dayItems.contains { $0.id == roadmap.id })

        let journal = first(planner, "Journal")
        let count = planner.items.count
        planner.deleteItem(journal.id)
        #expect(planner.item(journal.id) == nil)
        #expect(planner.items.count == count - 1)
    }

    /// The sample adds a subtask and resets a streak too, sending nothing: a
    /// subtask under a task that had none (but not under it in turn, nor
    /// under a habit), and Meds' 41 days to 0 with the days ticked kept.
    @Test func theSampleAddsASubtaskAndResetsAStreakWithoutSending() throws {
        let planner = makePlanner()
        #expect(planner.sync == nil)
        #expect(planner.canWrite("addSubtask"))
        #expect(planner.canWrite("resetStreak"))

        let dentist = first(planner, "Call the dentist")
        #expect(planner.subtasks(of: dentist.id).isEmpty)
        #expect(planner.canAddSubtask(to: dentist))
        let id = try #require(planner.addSubtask(dentist.id, title: "Ask about the crown"))
        #expect(planner.subtasks(of: dentist.id).map(\.title) == ["Ask about the crown"])
        #expect(!planner.dayItems.contains { $0.id == id })
        let child = try #require(planner.item(id))
        #expect(!planner.canAddSubtask(to: child))
        #expect(planner.addSubtask(id, title: "Bring the X-rays") == nil)

        let meds = first(planner, "Meds")
        #expect(planner.showsStreak(for: meds))
        #expect(!planner.canAddSubtask(to: meds))
        #expect(planner.offeredVerbs(for: meds, day: .selected).contains(.resetStreak))
        planner.resetStreak(meds.id)
        let reset = try #require(planner.item(meds.id))
        #expect(reset.streak == 0)
        #expect(reset.completedDates == meds.completedDates)
        #expect(planner.isDone(reset))
        #expect(!planner.offeredVerbs(for: reset, day: .selected).contains(.resetStreak))
    }

    /// The sample takes every chip edit too, sending nothing: a priority, a
    /// habit's times a day, and a reminder's time alone, which keeps its cue
    /// words. It knows no Habit reminders switch and stores no zone, and isn't
    /// live, so the Remind sheet shows neither settings line over it.
    @Test func theSampleTakesEveryChipEditWithoutSending() throws {
        let planner = makePlanner()
        #expect(planner.sync == nil)
        #expect(!planner.isLive)
        #expect(planner.settings.remindersEnabled == nil)
        #expect(!planner.hasStoredZone)

        let dentist = first(planner, "Call the dentist")
        #expect(dentist.priority == "medium")
        #expect(planner.canEdit("priority", dentist))
        planner.edit(dentist.id, .priority("low"))
        #expect(planner.item(dentist.id)?.priority == "low")

        let meds = first(planner, "Meds")
        #expect(meds.timesPerDay == nil)
        #expect(planner.canEdit("timesPerDay", meds))
        #expect(!planner.canEdit("priority", meds))
        planner.edit(meds.id, .timesPerDay(3))
        #expect(planner.item(meds.id)?.timesPerDay == 3)

        #expect(planner.canEdit("reminder", meds))
        planner.edit(meds.id, .reminder(time: "07:30", anchor: nil))
        let retimed = try #require(planner.item(meds.id))
        #expect(retimed.reminderTime == "07:30")
        #expect(retimed.reminderAnchor == "I pour my coffee")
    }

    /// The sample takes the date and time chips' writes too, sending
    /// nothing: Call the bank dated today, which files it on Anytime; Draft
    /// Q4 roadmap's time moved to 3:00 pm, which files it in Afternoon; and
    /// Meds' part of day to Evening.
    @Test func theSampleTakesADateAndATimeWithoutSending() throws {
        let planner = makePlanner()
        #expect(planner.sync == nil)

        let bank = try #require(planner.items.first { $0.title == "Call the bank" })
        #expect(bank.startDate == nil)
        #expect(!planner.canEdit("time", bank))
        planner.move(bank.id, to: planner.today.description)
        let dated = try #require(planner.item(bank.id))
        #expect(dated.startDate == "2026-10-01")
        #expect(dated.timeBucket == "anytime")
        #expect(!planner.braindump.contains { $0.id == bank.id })
        #expect(planner.buckets()[.anytime]?.contains { $0.id == bank.id } == true)
        #expect(planner.canEdit("time", dated))

        let roadmap = first(planner, "Draft Q4 roadmap")
        #expect(roadmap.timeBucket == "morning")
        #expect(roadmap.startTime == "09:00")
        planner.edit(roadmap.id, .time(bucket: nil, startTime: .set("15:00"), duration: nil))
        let afternoon = try #require(planner.item(roadmap.id))
        #expect(afternoon.timeBucket == "afternoon")
        #expect(afternoon.startTime == "15:00")
        #expect(afternoon.duration == 120)
        #expect(planner.buckets()[.afternoon]?.contains { $0.id == roadmap.id } == true)

        let meds = first(planner, "Meds")
        #expect(meds.timeBucket == "morning")
        planner.edit(meds.id, .time(bucket: .set("evening"), startTime: nil, duration: nil))
        let evening = try #require(planner.item(meds.id))
        #expect(evening.timeBucket == "evening")
        #expect(evening.startTime == nil)
        #expect(planner.buckets()[.evening]?.contains { $0.id == meds.id } == true)
    }

    /// The sample takes the Repeat chip's writes too, sending nothing:
    /// Groceries made Weekdays, which keeps it on Thursday; Water the plants
    /// given Friday beside its Sunday and Wednesday; Pay rent moved to the
    /// 31st; and Call the bank made Daily, which leaves it undated in the
    /// braindump, as the web's panel does.
    @Test func theSampleTakesARepeatWithoutSending() throws {
        let planner = makePlanner()
        #expect(planner.sync == nil)

        let groceries = first(planner, "Groceries")
        #expect(groceries.repeatFrequency == nil)
        #expect(planner.canEdit("repeat", groceries))
        planner.edit(groceries.id, .repeats(frequency: "weekdays", days: nil, monthDay: nil))
        #expect(planner.item(groceries.id)?.repeatFrequency == "weekdays")
        #expect(planner.dayItems.contains { $0.id == groceries.id })

        let plants = first(planner, "Water the plants")
        #expect(plants.repeatDays == [0, 3])
        planner.edit(plants.id, .repeats(frequency: "custom", days: [0, 3, 5], monthDay: nil))
        let watered = try #require(planner.item(plants.id))
        #expect(watered.repeatDays == [0, 3, 5])
        #expect(cadenceLabel(watered) == "Sun, Wed, Fri")
        #expect(watered.streak == plants.streak)

        let rent = try #require(planner.item(SampleData.uuid(50)))
        planner.edit(rent.id, .repeats(frequency: "monthly", days: nil, monthDay: 31))
        let paid = try #require(planner.item(rent.id))
        #expect(paid.repeatMonthDay == 31)
        #expect(paid.startDate == nil)
        #expect(planner.braindump.last?.id == rent.id)

        let bank = try #require(planner.items.first { $0.title == "Call the bank" })
        #expect(bank.repeatFrequency == nil)
        planner.edit(bank.id, .repeats(frequency: "daily", days: nil, monthDay: nil))
        let daily = try #require(planner.item(bank.id))
        #expect(daily.repeatFrequency == "daily")
        #expect(daily.startDate == nil)
        #expect(planner.braindump.contains { $0.id == bank.id })
        #expect(!planner.dayItems.contains { $0.id == bank.id })
        #expect(planner.sync == nil)
    }

    /// The sample takes the project chip's write too, sending nothing: every
    /// row filed under a project carries its id, as a payload's row does, so
    /// Groceries (Home) moved to Work reads Work's name and id. Standup is
    /// filed "work" with no link, which the List layout already reads as
    /// Work; picking Work relinks it under Work's own name, and it stays in
    /// Work's section.
    @Test func theSampleTakesAProjectWithoutSending() throws {
        let planner = makePlanner()
        #expect(planner.sync == nil)
        #expect(first(planner, "Draft Q4 roadmap").projectId == "sample-work")

        let groceries = first(planner, "Groceries")
        #expect(groceries.project == "Home")
        #expect(groceries.projectId == "sample-home")
        #expect(planner.canEdit("project", groceries))
        planner.edit(groceries.id, .project(id: "sample-work", name: "Work"))
        let filed = try #require(planner.item(groceries.id))
        #expect(filed.project == "Work")
        #expect(filed.projectId == "sample-work")

        let standup = first(planner, "Standup")
        #expect(standup.project == "work")
        #expect(standup.projectId == nil)
        planner.edit(standup.id, .project(id: "sample-work", name: "Work"))
        let relinked = try #require(planner.item(standup.id))
        #expect(relinked.project == "Work")
        #expect(relinked.projectId == "sample-work")
        let work = try #require(planner.listSections(.all).first { $0.title == "Work" })
        #expect(work.items.contains { $0.id == standup.id })
        #expect(planner.sync == nil)
    }

    /// The sample has a second routine, Wind down, empty, after Morning
    /// routine, and one season, Autumn, holding Journal. Autumn follows no
    /// dates, so it hides nothing, and an empty routine forms no List group:
    /// the day, the boards and the sections read as they did without them.
    @Test func theSampleHasASeasonAndASecondRoutine() {
        let planner = makePlanner()
        #expect(planner.routines.map(\.name) == ["Morning routine", "Wind down"])
        #expect(planner.routines.last?.itemIds.isEmpty == true)
        #expect(planner.seasons.map(\.name) == ["Autumn"])
        let journal = first(planner, "Journal")
        #expect(planner.seasons.first?.itemIds == [journal.id])
        #expect(planner.seasonNames(for: journal.id) == ["Autumn"])
        #expect(planner.routineNames(for: journal.id) == ["Morning routine"])
        #expect(planner.dayItems.contains { $0.id == journal.id })
        #expect(!planner.listSections(.all).contains { $0.title == "Wind down" })
    }

    /// The sample takes the routine and season toggles too, sending nothing:
    /// Groceries into Wind down and out again, and Journal out of Autumn.
    @Test func theSampleTogglesAMembershipWithoutSending() throws {
        let planner = makePlanner()
        #expect(planner.sync == nil)
        let windDown = try #require(planner.routines.first { $0.name == "Wind down" })
        let autumn = try #require(planner.seasons.first)

        let groceries = first(planner, "Groceries")
        #expect(planner.canEdit("collect", groceries))
        planner.collect(groceries.id, kind: .routine, containerId: windDown.id, member: true)
        #expect(planner.routineNames(for: groceries.id) == ["Wind down"])
        #expect(planner.listSections(.all).contains { $0.title == "Wind down" && $0.kind == .routine })
        planner.collect(groceries.id, kind: .routine, containerId: windDown.id, member: false)
        #expect(planner.routineNames(for: groceries.id).isEmpty)
        #expect(planner.routines.first { $0.id == windDown.id }?.itemIds.isEmpty == true)

        let journal = first(planner, "Journal")
        planner.collect(journal.id, kind: .season, containerId: autumn.id, member: false)
        #expect(planner.seasonNames(for: journal.id).isEmpty)
        #expect(planner.seasons.first?.itemIds.isEmpty == true)
        #expect(planner.sync == nil)
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
        #expect(subtasks.allSatisfy { planner.offeredVerbs(for: $0, day: .selected) == [.tick, .delete] })
    }

    /// Pay rent, made last so no other id moves: a task repeating monthly
    /// on the 1st with no day, the braindump's last row, and on no day, not
    /// even the 1st it repeats on (the sample's Thursday is October 1), since
    /// an undated task never shows on one.
    @Test func payRentRepeatsMonthlyAndWaitsInTheBraindump() throws {
        let planner = makePlanner()
        let rent = try #require(planner.item(SampleData.uuid(50)))
        #expect(rent.title == "Pay rent")
        #expect(rent.type == "task")
        #expect(rent.repeatFrequency == "monthly")
        #expect(rent.repeatMonthDay == 1)
        #expect(rent.startDate == nil)
        #expect(rent.timeBucket == nil)
        #expect(rent.isScheduled == false)
        #expect(planner.braindump.last?.id == rent.id)
        #expect(cadenceLabel(rent) == "Monthly \u{00B7} 1")
        #expect(!planner.scheduled.contains { $0.id == rent.id })
        #expect(!planner.dayItems.contains { $0.id == rent.id })
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
