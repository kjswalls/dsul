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

    // MARK: Organize

    /// Without signing in, Organize shows every section (Goals is on in the
    /// sample), each container with its own tile, glyph and subtitle.
    @Test func theSampleShowsEveryOrganizeSection() throws {
        let planner = makePlanner()
        #expect(planner.settings.goalsEnabled)
        #expect(planner.settings.organizeEnabled)
        guard case .list(let sections, let nothingYet, let switchedOff) = planner.organize else {
            Issue.record("The sample is loaded")
            return
        }
        #expect(sections.map(\.kind) == [.routines, .seasons, .goals, .projects])
        #expect(sections.map(\.count) == ["2", "1 on", "1", "5"])
        #expect(nothingYet == nil)
        #expect(switchedOff == nil)

        let routines = sections[0].rows
        #expect(routines.map(\.title) == ["Morning routine", "Wind down"])
        #expect(routines.map(\.subtitle) == ["7:00 am \u{00B7} 3 items", "9:30 pm \u{00B7} Nothing in it yet"])
        #expect(routines.map(\.symbol) == ["sunrise", "moon"])
        #expect(routines.map(\.accent.token) == ["var(--accent-6)", "var(--accent-4)"])
        // Meds and Stretch are ticked today and Journal isn't; Wind down has
        // nothing on, so no count.
        #expect(routines.map(\.trailing) == ["2/3 today", nil])

        let autumn = try #require(sections[1].rows.first)
        #expect(autumn.title == "Autumn")
        #expect(autumn.subtitle == "1 item")
        #expect(autumn.symbol == "leaf")
        #expect(autumn.accent.token == "var(--accent-1)")

        let goal = try #require(sections[2].rows.first)
        #expect(goal.title == "Run a half marathon")
        #expect(goal.subtitle == "Jan 29 \u{00B7} 1/3")
        #expect(goal.symbol == "target")

        // By folded name, done and Standup's "work" included; the roadmap's
        // subtasks are filed under no project.
        let projects = sections[3].rows
        #expect(projects.map(\.title) == ["Work", "Home", "Writing", "dsul", "Health"])
        #expect(projects.map(\.subtitle) == ["4 items", "4 items", "1 item \u{00B7} Weekdays \u{00B7} 6:30am\u{2013}7:30am",
                                              "1 item", "1 item"])
        #expect(projects.allSatisfy { $0.accent.source == .name })
    }

    /// The goal's own items were made after Pay rent and off the anchor day:
    /// no pinned id moves, nothing lands on the day or in the braindump.
    @Test func theSampleGoalsItemsStayOffTheDay() throws {
        let planner = makePlanner()
        let goal = try #require(planner.goals?.first)
        let own = Set(goal.milestoneIds + goal.checkinIds)
        #expect(own.count == 4)
        #expect(planner.item(SampleData.uuid(50))?.title == "Pay rent")
        #expect(own == Set((51...54).map(SampleData.uuid)))
        #expect(!planner.dayItems.contains { own.contains($0.id) })
        #expect(!planner.braindump.contains { own.contains($0.id) })
        #expect(!planner.scheduled.contains { own.contains($0.id) })
        #expect(goal.memberIds == [first(planner, "Gym").id])
        #expect(goalProgress(goal, items: planner.items) == GoalProgress(achieved: 1, total: 3, fraction: 1.0 / 3.0))
    }

    // MARK: Container writes (O8a)

    /// The sample takes every container write and sends nothing: a routine
    /// pauses until a day and resumes, a season switches state as picked,
    /// and Paused's Turn on now brings a switched-off season back the web's
    /// way, so Autumn, which follows no dates, goes back to Dates.
    @Test func theSampleSwitchesRoutinesAndSeasonsWithoutSending() throws {
        let planner = makePlanner()
        #expect(planner.sync == nil)
        #expect(planner.containerWrites == nil)
        #expect(planner.containerTakes == OrganizeModel.everyContainerWrite)
        #expect(planner.canWrite(kind: .routine, action: .pause))
        #expect(planner.canWrite(kind: .season, action: .state))
        let morning = "sample-morning-routine"
        let autumn = ContainerRef(kind: .season, id: "sample-autumn")
        let members = planner.routines.first { $0.id == morning }?.itemIds

        planner.pauseRoutine(morning, until: DayString("2026-10-08"))
        var routine = try #require(planner.routines.first { $0.id == morning })
        #expect(routine.pausedAt == "2026-10-01T12:00:00.000Z")
        #expect(routine.pausedUntil == "2026-10-08")
        #expect(routine.itemIds == members)
        guard case .page(let page)? = planner.routinePage(morning) else {
            Issue.record("the sample's routine has a page")
            return
        }
        #expect(page.chips.last?.text == "Paused until Oct 8")
        #expect(page.statusMenu?.choices.first?.action == .resume)

        // Journal is in Morning routine and in Autumn: with both off it is
        // set aside, and Paused offers its way back.
        planner.setSeasonState(autumn.id, .paused)
        #expect(planner.seasons.first?.state == "paused")
        let containers = planner.pausedPage.groups.flatMap(\.rows).filter { $0.container != nil }
        #expect(!containers.isEmpty)
        #expect(containers.allSatisfy { $0.resumable })

        planner.resumeRoutine(morning)
        routine = try #require(planner.routines.first { $0.id == morning })
        #expect(routine.pausedAt == "2026-10-01T12:00:00.000Z")
        #expect(routine.pausedUntil == "2026-10-01")

        planner.turnOn(autumn)
        #expect(planner.seasons.first?.state == "auto")
        // Already on: nothing to send, nothing changes.
        planner.turnOn(autumn)
        #expect(planner.seasons.first?.state == "auto")
        #expect(planner.pausedPage.empty == "Nothing is paused.")
    }

    /// A revert puts back a container's fields and never its member lists
    /// (`withMembership(of:)`); one that is gone comes back whole at its
    /// place; nil takes it away.
    @Test func restoringAContainerKeepsItsMembers() throws {
        let planner = makePlanner()
        let ref = ContainerRef(kind: .routine, id: "sample-morning-routine")
        let before = try #require(planner.container(ref))
        guard case .routine(var original) = before else {
            Issue.record("a routine's snapshot")
            return
        }
        planner.pauseRoutine(ref.id, until: nil)
        planner.collect(SampleData.uuid(50), kind: .routine, containerId: ref.id, member: true)
        let grown = try #require(planner.routines.first { $0.id == ref.id }?.itemIds)
        #expect(grown.last == SampleData.uuid(50))

        planner.restoreContainer(ref, to: before, index: 0)
        let back = try #require(planner.routines.first { $0.id == ref.id })
        #expect(back.pausedAt == nil)
        #expect(back.itemIds == grown)

        planner.restoreContainer(ref, to: nil, index: nil)
        #expect(planner.container(ref) == nil)
        #expect(planner.routines.map(\.id) == ["sample-wind-down"])

        original.itemIds = []
        planner.restoreContainer(ref, to: .routine(original), index: 0)
        #expect(planner.routines.map(\.id) == ["sample-morning-routine", "sample-wind-down"])
        #expect(planner.containerIndex(ref) == 0)
        #expect(planner.routines.first?.itemIds == [])
    }

    // MARK: Container edits (O8b, O9)

    /// The sample takes every O8b field and sends nothing, each on its page
    /// at once: a routine's usual time set and cleared, a season's Runs, a
    /// goal's window and Status (achieved twice, it keeps its first stamp;
    /// Set aside keeps it; Active clears it), the notes and the why.
    @Test func theSampleEditsEveryContainerFieldWithoutSending() throws {
        let clock = TestClock(PlannerJSON.noon)
        let planner = SamplePlanner(todayString: "2026-10-01", now: { clock.now })
        #expect(planner.sync == nil)
        let morning = "sample-morning-routine"
        let goalId = "sample-half-marathon"
        func routine() -> Routine? { planner.routines.first { $0.id == morning } }
        func goal() -> Goal? { planner.goals?.first { $0.id == goalId } }

        planner.setUsualTime(morning, "06:45")
        #expect(routine()?.usualTime == "06:45")
        guard case .page(let routinePage)? = planner.routinePage(morning) else {
            Issue.record("the sample's routine has a page")
            return
        }
        #expect(routinePage.chips.first?.text == "Usually 6:45 am")
        #expect(routinePage.chips.first?.edits == true)
        planner.setUsualTime(morning, nil)
        #expect(routine()?.usualTime == nil)

        planner.setSeasonDates("sample-autumn", startsOn: DayString("2026-09-22"), endsOn: DayString("2026-12-20"))
        #expect(planner.seasons.first?.startsOn == "2026-09-22")
        #expect(planner.seasons.first?.endsOn == "2026-12-20")
        guard case .page(let seasonPage)? = planner.seasonPage("sample-autumn") else {
            Issue.record("the sample's season has a page")
            return
        }
        #expect(seasonPage.chips.last?.text == "Sep 22 to Dec 20")
        #expect(seasonPage.runs?.end == DayString("2026-12-20"))

        planner.setGoalWindow(goalId, startsOn: nil, targetOn: DayString("2027-04-01"))
        #expect(goal()?.startsOn == nil)
        #expect(goal()?.targetOn == "2027-04-01")

        planner.setGoalState(goalId, .achieved)
        #expect(goal()?.state == "achieved")
        #expect(goal()?.achievedAt == "2026-10-01T12:00:00.000Z")
        clock.now = PlannerJSON.noon.addingTimeInterval(60 * 60)
        planner.setGoalState(goalId, .achieved)
        #expect(goal()?.achievedAt == "2026-10-01T12:00:00.000Z")
        guard case .page(let goalPage)? = planner.goalPage(goalId) else {
            Issue.record("the sample's goal has a page")
            return
        }
        #expect(goalPage.statusMenu?.selected == .goalState(.achieved))
        #expect(goalPage.chips.first?.text == "Achieved")
        #expect(goalPage.endedNote?.hasPrefix("Achieved on Oct 1.") == true)
        planner.setGoalState(goalId, .abandoned)
        #expect(goal()?.state == "abandoned")
        #expect(goal()?.achievedAt == "2026-10-01T12:00:00.000Z")
        planner.setGoalState(goalId, .active)
        #expect(goal()?.achievedAt == nil)

        planner.setNotes(ContainerRef(kind: .routine, id: morning), "  Kettle first. \n")
        #expect(routine()?.notes == "Kettle first.")
        planner.setNotes(ContainerRef(kind: .goal, id: goalId), "")
        #expect(goal()?.why == nil)
        #expect(planner.banner == nil)
    }

    /// Rename re-files a project's items by id at once, so the page and every
    /// row say the new name; Standup, filed "work" with no id, stays put, as on
    /// the server, and so leaves the page. A rename onto another project's
    /// name, folding case, is refused with the route's words and changes
    /// nothing. A routine renames and takes an icon and Auto; a
    /// project's icon is its emoji.
    @Test func theSampleRenamesAndRecoloursWithoutSending() throws {
        let planner = makePlanner()
        let work = ContainerRef(kind: .project, id: "sample-work")
        let filed = planner.items.filter { $0.projectId == "sample-work" }.map(\.id)
        #expect(filed.count == 3)
        #expect(planner.canWrite(kind: .project, action: .rename))

        planner.rename(work, to: " Office ")
        #expect(planner.projectRecords.first?.name == "Office")
        #expect(filed.allSatisfy { planner.item($0)?.project == "Office" })
        #expect(!planner.items.contains { $0.project == "Work" })
        #expect(first(planner, "Standup").project == "work")
        guard case .page(let page)? = planner.projectPage("sample-work") else {
            Issue.record("the renamed project keeps its page")
            return
        }
        #expect(page.header.title == "Office")
        #expect(page.items.count == 3)
        #expect(page.edits?.rename?.name == "Office")

        planner.rename(work, to: "HEALTH")
        #expect(planner.banner?.text == "You already have a project called \u{201C}HEALTH\u{201D}.")
        #expect(planner.projectRecords.first?.name == "Office")
        #expect(filed.allSatisfy { planner.item($0)?.project == "Office" })

        let morning = ContainerRef(kind: .routine, id: "sample-morning-routine")
        planner.rename(morning, to: "Mornings")
        planner.editContainer(morning, .icon("icon:Coffee"))
        planner.editContainer(morning, .color(nil))
        let routine = try #require(planner.routines.first)
        #expect(routine.name == "Mornings")
        #expect(routine.icon == "icon:Coffee")
        #expect(routine.color == nil)
        planner.editContainer(work, .icon("icon:Briefcase"))
        #expect(planner.projectRecords.first?.emoji == "icon:Briefcase")
        guard case .page(let routinePage)? = planner.routinePage(morning.id) else {
            Issue.record("the routine's page")
            return
        }
        #expect(routinePage.header.title == "Mornings")
        #expect(routinePage.header.symbol == ContainerLook.lucideToSymbol["Coffee"])
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

    // MARK: Week: the day-keyed twins (design §4.6, PR 1)

    private func day(_ s: String) -> DayString { DayString(s)! }

    /// The sample's week from Thursday 2026-10-01: Sunday Sep 27 to Saturday
    /// Oct 3, the sample keeping the default Week starts on.
    private var sampleWeek: [DayString] {
        return ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02",
                "2026-10-03"].map(day)
    }

    @Test func theSelectedWeekStartsOnTheUsersWeekStart() {
        let planner = makePlanner()
        #expect(planner.settings.weekStartDay == .sunday)
        #expect(planner.selectedWeek == sampleWeek)
        #expect(planner.isOnTodaysWeek)
        planner.shiftDay(by: 2)                           // Saturday, its last day
        #expect(planner.selectedWeek == sampleWeek)
        #expect(planner.isOnTodaysWeek)
        planner.shiftDay(by: 1)                           // Sunday, the next week
        #expect(!planner.isOnTodaysWeek)
        #expect(planner.selectedWeek.first == day("2026-10-04"))
        planner.shiftDay(by: -7)                          // Sunday Sep 27, its first day
        #expect(planner.isOnTodaysWeek)
        planner.shiftDay(by: -1)
        #expect(!planner.isOnTodaysWeek)
    }

    /// `week(of:)` is seven `derive(on:)`s over one split, and `weekRows(of:)`
    /// is each day's `dayItems(on:)`: a week can never say something a day
    /// wouldn't.
    @Test func aWeekIsSevenDaysEachAsItsDayDerivesIt() {
        let planner = makePlanner()
        let week = planner.week(of: planner.selectedDay)
        #expect(Set(week.keys) == Set(sampleWeek))
        for date in sampleWeek {
            #expect(week[date] == planner.derive(on: date), "\(date)")
        }
        // Any day of the week answers the same week.
        #expect(planner.week(of: day("2026-09-27")) == week)
        #expect(planner.week(of: day("2026-10-03")) == week)

        let rows = planner.weekRows(of: planner.selectedDay)
        #expect(rows.map(\.day) == sampleWeek)
        for date in rows {
            #expect(date.rows == planner.dayItems(on: date.day), "\(date.day)")
        }
    }

    /// The selected-day forms are their day-keyed twins at `selectedDay`, on
    /// every day of the week.
    @Test func theSelectedDaysFormsAreTheirTwins() {
        let planner = makePlanner()
        for date in sampleWeek {
            planner.select(date)
            #expect(planner.dayItems == planner.dayItems(on: date), "\(date)")
            #expect(planner.listSections(.all) == planner.listSections(.all, on: date), "\(date)")
            #expect(planner.listSections(.habits) == planner.listSections(.habits, rows: planner.dayItems,
                                                                          on: date), "\(date)")
            #expect(planner.buckets() == planner.buckets(on: date), "\(date)")
            #expect(planner.buckets() == planner.buckets(planner.dayItems(on: date)), "\(date)")
            #expect(planner.scheduled == planner.scheduled(on: date), "\(date)")
            #expect(planner.count(.habits) == planner.count(.habits, on: [date]), "\(date)")
            #expect(planner.count(.all) == planner.count(.all, in: planner.dayItems(on: date)), "\(date)")
            #expect(planner.dayProjects == planner.dayProjects(on: [date]), "\(date)")
        }
    }

    /// A twin reads its own day, never the selected one: from Thursday,
    /// Wednesday's rows have Water the plants and no blocks, and its routine
    /// counts Wednesday's ticks.
    @Test func aTwinReadsItsOwnDay() throws {
        let planner = makePlanner()
        let wednesday = day("2026-09-30")
        #expect(planner.selectedDay == day("2026-10-01"))
        #expect(planner.dayItems(on: wednesday).contains { $0.title == "Water the plants" })
        #expect(!planner.dayItems.contains { $0.title == "Water the plants" })
        #expect(planner.scheduled(on: wednesday).isEmpty)
        #expect(!planner.scheduled.isEmpty)
        let journal = first(planner, "Journal")
        #expect(planner.isDone(journal, on: wednesday))   // done one day back
        #expect(!planner.isDone(journal))
        // Wednesday: Meds, Stretch and Journal all done a day back.
        let routine = try #require(planner.listSections(.all, on: wednesday).first)
        #expect(routine.kind == .routine)
        #expect(routine.doneCount == 3)
        #expect(planner.listSections(.all).first?.doneCount == 2)
        #expect(planner.anytime(on: wednesday).map(\.title).contains("Water the plants"))
    }

    /// A week row's tick lands on its own day and no other.
    @Test func aRowTicksOnlyItsOwnDay() throws {
        let planner = makePlanner()
        let journal = first(planner, "Journal")
        let saturday = day("2026-10-03")
        planner.toggleRow(journal.id, on: saturday)
        let after = try #require(planner.item(journal.id))
        #expect(planner.isDone(after, on: saturday))
        #expect(!planner.isDone(after))                   // Thursday, the selected day
        #expect(!planner.isDone(after, on: day("2026-10-02")))
        #expect(after.completedDates.contains("2026-10-03"))
        #expect(!after.completedDates.contains("2026-10-01"))
        #expect(planner.selectedDay == day("2026-10-01"))
        planner.toggleRow(journal.id, on: saturday)
        #expect(try !planner.isDone(#require(planner.item(journal.id)), on: saturday))
        #expect(planner.sync == nil)
    }

    /// A sheet opened from a week row acts on that row's day (`SheetDay.on`),
    /// whatever Today has selected: its Skip skips that day alone.
    @Test func aSheetOpenedOnADayActsOnIt() throws {
        let planner = makePlanner()
        let meds = first(planner, "Meds")
        let friday = day("2026-10-02")
        planner.open(meds.id, day: .on(friday))
        #expect(planner.activeSheet == .item(meds.id, day: .on(friday)))
        #expect(planner.actingDay(.on(friday)) == friday)
        #expect(planner.actingDay(.selected) == planner.selectedDay)
        #expect(planner.verbContext(for: meds, day: .on(friday)) == planner.verbContext(for: meds, on: friday))
        planner.skip(meds.id, on: planner.actingDay(.on(friday)))
        let after = try #require(planner.item(meds.id))
        #expect(planner.isSkipped(after, on: friday))
        #expect(!planner.isSkipped(after))
        #expect(planner.isDone(after))                    // Thursday keeps its tick
        #expect(planner.selectedDay == day("2026-10-01"))
    }

    // MARK: Week: the sample's week (PR 2)

    /// The rest of the week's four tasks: made after every other id (55 to
    /// 58), none on the anchor or on Wednesday, all inside the anchor's week
    /// from Sunday or Monday.
    @Test func theSamplesRestOfTheWeek() throws {
        let planner = makePlanner()
        let titles = ["Pick up the dry cleaning", "Bike service", "Coffee with Priya", "Post the birthday card"]
        let days = ["2026-09-28", "2026-09-29", "2026-10-02", "2026-10-03"]
        for (n, (title, date)) in zip(55...58, zip(titles, days)) {
            let task = try #require(planner.item(SampleData.uuid(n)), "\(n)")
            #expect(task.title == title)
            #expect(task.type == "task")
            #expect(task.startDate == date)
            #expect(task.project == nil)
            #expect(planner.dayItems(on: day(date)).contains { $0.id == task.id }, "\(title)")
        }
        #expect(planner.item(SampleData.uuid(59)) == nil)
        let mondayWeek = weekDays(of: planner.selectedDay, .monday).map(\.description)
        #expect(days.allSatisfy { sampleWeek.map(\.description).contains($0) && mondayWeek.contains($0) })
        let own = Set((55...58).map(SampleData.uuid))
        #expect(!planner.dayItems.contains { own.contains($0.id) })
        #expect(!planner.dayItems(on: day("2026-09-30")).contains { own.contains($0.id) })
        #expect(!planner.braindump.contains { own.contains($0.id) })
        // Two afternoon blocks, a morning block, and one untimed.
        #expect(planner.scheduled(on: day("2026-09-28")).map(\.title) == ["Pick up the dry cleaning"])
        #expect(planner.buckets(on: day("2026-09-29"))[.afternoon]?.map(\.title) == ["Bike service"])
        #expect(planner.buckets(on: day("2026-10-02"))[.morning]?.map(\.title).contains("Coffee with Priya") == true)
        #expect(planner.anytime(on: day("2026-10-03")).map(\.title).contains("Post the birthday card"))
    }

    /// The chips over a week count every occurrence (design W16): a daily
    /// habit counts seven.
    @Test func theWeeksChipsCountEveryOccurrence() {
        let planner = makePlanner()
        let rows = planner.weekRows(of: planner.selectedDay).flatMap(\.rows)
        // Three daily routine habits, Plan tomorrow on the five weekdays,
        // Water the plants on Sunday and Wednesday.
        #expect(planner.count(.habits, in: rows) == 3 * 7 + 5 + 2)
        // Thursday's twelve, the four around it, and the run review, done
        // on Sunday.
        #expect(planner.count(.tasks, in: rows) == 12 + 4 + 1)
        #expect(planner.count(.all, in: rows) == 45)
        #expect(planner.weekRows(of: planner.selectedDay).map(\.rows.count) == [5, 5, 5, 5, 16, 5, 4])
        // Home: three of Thursday's tasks and Water the plants twice.
        #expect(planner.count(.project("Home"), in: rows) == 5)
        #expect(planner.count(.all, in: rows) == planner.count(.tasks, in: rows) + planner.count(.habits, in: rows))
        #expect(planner.count(.all, in: rows) == planner.count(.all, on: sampleWeek))
        #expect(planner.count(.project("Work"), in: rows) == planner.count(.project("Work")))
        #expect(planner.chipProjects(in: rows) == planner.dayProjects(on: sampleWeek))
        #expect(planner.chipProjects(in: rows).first == "Work")
        // From Monday the week is Sep 28 to Oct 4: the same habits (Water the
        // plants on Wednesday and on Sunday Oct 4), the four tasks still in
        // it, and the run review on its Sunday.
        let monday = weekDays(of: planner.selectedDay, .monday)
        #expect(monday.first == day("2026-09-28"))
        #expect(monday.last == day("2026-10-04"))
        #expect(planner.count(.habits, on: monday) == 3 * 7 + 5 + 2)
        #expect(planner.count(.all, on: monday) == 45)
        #expect(planner.dayItems(on: day("2026-10-04")).contains { $0.title == "Weekly run review" })
    }

    /// Week groups each day on its own, as Day does: Monday's one task is a
    /// No project section of one, and its routine counts Monday's ticks.
    @Test func aWeekDayGroupsAsItsDayDoes() throws {
        let planner = makePlanner()
        let week = planner.weekRows(of: planner.selectedDay)
        let monday = try #require(week.first { $0.day == day("2026-09-28") })
        let sections = planner.listSections(.all, rows: monday.rows, on: monday.day)
        #expect(sections == planner.listSections(.all, on: monday.day))
        #expect(sections.first?.kind == .routine)
        #expect(sections.first?.doneCount == 1)          // Journal, three days back
        #expect(sections.last?.kind == .loose)
        #expect(sections.last?.title == ContainerWords.noProject)
        #expect(sections.last?.items.map(\.title).contains("Pick up the dry cleaning") == true)
        #expect(planner.listSections(.tasks, rows: monday.rows, on: monday.day).flatMap(\.items).map(\.title)
            == ["Pick up the dry cleaning"])
        #expect(planner.listSections(.project("Home"), rows: monday.rows, on: monday.day).isEmpty)
    }
}
