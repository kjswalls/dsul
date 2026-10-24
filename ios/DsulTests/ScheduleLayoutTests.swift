import DsulCore
import Foundation
import Testing
@testable import Dsul

/// The Schedule's day as its views draw it (Week and blocks PRs 4 to 6):
/// `daySchedule(on:fieldWidth:)`'s blocks, their words, checks and overlap
/// plans, the Anytime band's rows and rules. Foundation only, so the shim
/// runs it; ScheduleRenderTests hosts the views themselves.
@MainActor
@Suite struct ScheduleLayoutTests {
    /// A Thursday (as SamplePlannerTests' planner), the clock noon UTC.
    private func makePlanner() -> SamplePlanner {
        SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
    }

    /// The phone's Day field at the default size: a 393pt screen less the
    /// 52pt gutter and the 8pt right margin.
    private let field = 333.0

    private func block(_ day: DaySchedule, _ title: String) -> ScheduleBlock {
        day.blocks.first { $0.item.title == title }!
    }

    private func thought(_ planner: SamplePlanner, _ title: String) -> SampleItem {
        planner.braindump.first { $0.title == title }!
    }

    // MARK: One derive, the grid's and the band's

    #if DEBUG
    /// The blocks and the band come from ONE derive of the day, so a render
    /// asks it once (design §5.1). That a ghost step derives nothing is a
    /// property of the views, proved on the runner by
    /// ScheduleRenderTests.aGhostStepDerivesNothing.
    @Test func aDayScheduleDerivesTheDayOnce() {
        let planner = makePlanner()
        let before = planner.derivations
        _ = planner.daySchedule(on: planner.today, fieldWidth: field)
        #expect(planner.derivations == before + 1)
    }
    #endif

    @Test func theBlocksAreTheScheduledCopiesAndTheBandIsAnytime() {
        let planner = makePlanner()
        let day = planner.daySchedule(on: planner.today, fieldWidth: field)
        #expect(day.day == planner.today)
        #expect(day.fieldWidth == field)
        #expect(day.blocks.map(\.item) == planner.scheduled(on: planner.today))
        #expect(day.blocks.map(\.id) == planner.scheduled(on: planner.today).map(\.id))
        #expect(day.untimed.map(\.id) == planner.anytime(on: planner.today).map(\.id))
        #expect(day.untimed.map(\.id) == deriveUntimedRows(planner.derive(on: planner.today)).map(\.id))
        #expect(day.blocks.allSatisfy { $0.startMin == $0.item.startMin && $0.duration == $0.item.durationMin })
    }

    /// Before the grid is measured the day still has its blocks (the column
    /// just doesn't draw them yet), each planned as if on a nominal field.
    @Test func anUnmeasuredDayStillHasItsBlocks() {
        let planner = makePlanner()
        let day = planner.daySchedule(on: planner.today, fieldWidth: nil)
        #expect(day.fieldWidth == nil)
        #expect(day.blocks.count == planner.scheduled(on: planner.today).count)
        #expect(!block(day, "Standup").isNarrow(fieldWidth: nil))
    }

    // MARK: A block's words (PR 4)

    @Test func aLongBlockSaysItsTitleTimeAndProjectAndAddsItsRange() {
        let planner = makePlanner()
        let draft = block(planner.daySchedule(on: planner.today, fieldWidth: field), "Draft Q4 roadmap")
        #expect(draft.spokenLabel == "Draft Q4 roadmap, 9 to 11 AM, Work")
        #expect(draft.spokenValue(nowMin: nil) == "")
        #expect(draft.durationText == "2h")
        #expect(draft.rangeText(.twelveHour) == "9:00\u{2013}11:00")
        #expect(draft.rangeText(.twentyFourHour) == "09:00\u{2013}11:00")
        #expect(draft.project == "Work")
        #expect(draft.hasCheck)
        #expect(draft.tickLabel == "Mark done")
        let frame = draft.frame(fieldWidth: field)
        #expect(frame.isTall)
        #expect(frame.startY == 9 * 75)
        #expect(frame.spanHeight == 150)
        #expect(frame.paneTop == 9 * 75 + 3)
        #expect(frame.paneHeight == 146)
        #expect(frame.paneX == 12)
        #expect(frame.paneWidth == field - 16)
        #expect(frame.railX == 5)
        #expect(frame.beadX == 3)
        #expect(!draft.isNarrow(fieldWidth: field))
    }

    /// A 15-minute block's pane is the web's PANE_MIN_H, 34pt, though its
    /// time is under 19: tall enough to read, and the rail stays time-true.
    @Test func aShortBlockIsFlooredAtThirtyFourPoints() {
        let planner = makePlanner()
        let standup = block(planner.daySchedule(on: planner.today, fieldWidth: field), "Standup")
        let frame = standup.frame(fieldWidth: field)
        #expect(frame.paneHeight == 34)
        #expect(frame.spanHeight == 18.75)
        #expect(!frame.isTall)
        #expect(standup.durationText == "15m")
        // Filed "work", lowercase: the label says the name as filed, and the
        // colour folds it to Work's.
        #expect(standup.spokenLabel == "Standup, 11:15 AM, work")
    }

    @Test func aBlockWithNoProjectWearsLime() {
        let planner = makePlanner()
        let walk = block(planner.daySchedule(on: planner.today, fieldWidth: field), "Lunch walk")
        #expect(walk.project == nil)
        #expect(walk.spokenLabel == "Lunch walk, 12:30 PM")
    }

    @Test func nowIsTheValueWhileABlockRuns() {
        let planner = makePlanner()
        let draft = block(planner.daySchedule(on: planner.today, fieldWidth: field), "Draft Q4 roadmap")
        #expect(draft.isNow(nowMin: 10 * 60))
        #expect(draft.spokenValue(nowMin: 10 * 60) == "now")
        #expect(!draft.isNow(nowMin: 11 * 60))
        #expect(!draft.isNow(nowMin: nil))
    }

    // MARK: The check (PR 4)

    /// A block's check ticks it on the column's day, as the List's circle
    /// does, and its name follows (lib/item-verbs.ts). `tickBlock` is the
    /// call ScheduleColumn's check makes.
    @Test func aBlocksCheckTicksItsDay() {
        let planner = makePlanner()
        let today = planner.daySchedule(on: planner.today, fieldWidth: field)
        let standup = block(today, "Standup")
        #expect(!standup.done)
        planner.tickBlock(standup, in: today)
        let after = block(planner.daySchedule(on: planner.today, fieldWidth: field), "Standup")
        #expect(after.done)
        #expect(after.tickLabel == "Mark not done")
        #expect(after.spokenValue(nowMin: 11 * 60 + 20) == "done")
    }

    /// A column ticks its own day, not the selected one: Monday's
    /// occurrence of a daily timed task is done on Monday, while the
    /// selected day (today) stays open. A one-off could not tell the two
    /// apart, since its tick is the same on every day.
    @Test func anotherDaysCheckTicksThatDay() {
        let planner = makePlanner()
        let monday = planner.today.adding(days: -3)
        planner.items.append(Item(id: UUID(), type: "task", title: "Water the ferns", status: "pending",
                                  startDate: planner.today.adding(days: -10).description, startTime: "08:00",
                                  timeBucket: DayBucket.morning.rawValue, repeatFrequency: "daily", duration: 15))
        #expect(planner.selectedDay == planner.today)
        let mondays = planner.daySchedule(on: monday, fieldWidth: field)
        let ferns = block(mondays, "Water the ferns")
        #expect(ferns.hasCheck && !ferns.done)
        planner.tickBlock(ferns, in: mondays)
        #expect(block(planner.daySchedule(on: monday, fieldWidth: field), "Water the ferns").done)
        #expect(!block(planner.daySchedule(on: planner.today, fieldWidth: field), "Water the ferns").done)
    }

    /// A habit's block has no check, as on the web (day-schedule.tsx
    /// `isTask`); VoiceOver has no tick action on it either.
    @Test func aTimedHabitHasNoCheck() {
        let planner = makePlanner()
        planner.items.append(Item(id: UUID(), type: "habit", title: "Evening walk", status: "pending",
                                  startTime: "20:00", timeBucket: DayBucket.evening.rawValue,
                                  repeatFrequency: "daily", duration: 30, streak: 0))
        let walk = block(planner.daySchedule(on: planner.today, fieldWidth: field), "Evening walk")
        #expect(!walk.hasCheck)
        #expect(walk.tickLabel == nil)
        #expect(walk.project == nil)
        #expect(walk.durationText == "30m")
    }

    /// A skipped occurrence is a strip with no check, and says so.
    @Test func aSkippedOccurrenceIsAStripWithNoCheck() {
        let planner = makePlanner()
        let id = UUID()
        planner.items.append(Item(id: id, type: "habit", title: "Evening walk", status: "pending",
                                  startTime: "20:00", timeBucket: DayBucket.evening.rawValue,
                                  repeatFrequency: "daily", duration: 30, streak: 0))
        planner.skip(id, on: planner.today)
        let walk = block(planner.daySchedule(on: planner.today, fieldWidth: field), "Evening walk")
        #expect(walk.skipped)
        #expect(!walk.done)
        #expect(!walk.hasCheck)
        #expect(walk.spokenValue(nowMin: 20 * 60 + 5) == "skipped")
    }

    // MARK: Overlap (PR 6)

    /// The sample's day has no two blocks at once: every block is lone.
    @Test func theSampleDayHasNoOverlaps() {
        let planner = makePlanner()
        let day = planner.daySchedule(on: planner.today, fieldWidth: field)
        #expect(day.blocks.allSatisfy { $0.plan == .lone })
    }

    /// Two 15-minute thoughts dropped at 4 PM are a genuine double booking:
    /// they tile, half the field each, and on the phone's Day field each
    /// half is narrow, so the title keeps the width.
    @Test func twoBlocksAtOnceTileSideBySide() {
        let planner = makePlanner()
        let bank = thought(planner, "Call the bank")
        let sam = thought(planner, "Email Sam back")
        planner.schedule(bank.id, startMin: 16 * 60)
        planner.schedule(sam.id, startMin: 16 * 60)
        let day = planner.daySchedule(on: planner.today, fieldWidth: field)
        let a = block(day, "Call the bank")
        let b = block(day, "Email Sam back")
        #expect(a.plan.widthFraction == 0.5)
        #expect(b.plan.widthFraction == 0.5)
        // One band, two lanes: each pane and its rail start at its own share.
        #expect(a.plan.left == b.plan.left)
        #expect(a.plan.paneLeft != b.plan.paneLeft)
        #expect(a.plan.railX != b.plan.railX)
        let fa = a.frame(fieldWidth: field)
        let fb = b.frame(fieldWidth: field)
        // Side by side: one ends where the other begins, give or take the gap.
        #expect(min(fa.paneX + fa.paneWidth, fb.paneX + fb.paneWidth) <= max(fa.paneX, fb.paneX))
        #expect(a.isNarrow(fieldWidth: field))
        #expect(!a.isNarrow(fieldWidth: 500))
        // Everything else on the day is still alone.
        #expect(day.blocks.filter { $0.plan != .lone }.count == 2)
    }

    /// A 30-minute thought at 9:30 sits inset in Draft Q4 roadmap (9 to 11),
    /// one level down; the host keeps the field.
    @Test func aShortBlockInsideALongOneNestsInIt() {
        let planner = makePlanner()
        let passport = thought(planner, "Renew passport")
        #expect(passport.durationMin == 30)
        planner.schedule(passport.id, startMin: 9 * 60 + 30)
        let day = planner.daySchedule(on: planner.today, fieldWidth: field)
        let host = block(day, "Draft Q4 roadmap")
        let child = block(day, "Renew passport")
        #expect(host.plan.depth == 0)
        #expect(child.plan.depth == 1)
        #expect(child.plan.z > host.plan.z)
        let fh = host.frame(fieldWidth: field)
        let fc = child.frame(fieldWidth: field)
        #expect(fc.paneX > fh.paneX)
        #expect(fc.paneX + fc.paneWidth <= fh.paneX + fh.paneWidth)
        // The plan is the web's pass over the day's entries, nothing of the
        // phone's own.
        var seen = Set<UUID>()
        let entries = deriveTimedEntries(planner.derive(on: planner.today))
            .filter { seen.insert($0.item.id).inserted }
        let plans = planOverlaps(entries.map { OverlapEntry($0) }, fieldWidth: field)
        #expect(day.blocks.allSatisfy { $0.plan == plans.plan(for: $0.id) })
    }

    /// Crossing blocks, neither inside the other, take a column each: an
    /// hour from 6 PM crosses Gym (5:30 to 6:30). Both clear the web's
    /// 140pt channel on the phone's field, so neither is squeezed.
    @Test func crossingBlocksTakeAColumnEach() {
        let planner = makePlanner()
        planner.schedule(thought(planner, "Fix the bike light").id, startMin: 18 * 60)
        let day = planner.daySchedule(on: planner.today, fieldWidth: field)
        let gym = block(day, "Gym")
        let bike = block(day, "Fix the bike light")
        #expect(gym.plan.depth == 0 && bike.plan.depth == 0)
        #expect(gym.plan.widthFraction == 0.5 && bike.plan.widthFraction == 0.5)
        let fg = gym.frame(fieldWidth: field)
        let fb = bike.frame(fieldWidth: field)
        #expect(fg.paneX + fg.paneWidth <= fb.paneX)
        #expect(fb.paneWidth >= ScheduleMetrics.minChannelPx)
    }

    /// Two 15-minute blocks back to back: their 34pt panes would overlap, so
    /// they sit side by side and neither hides the other's title.
    @Test func backToBackShortBlocksSitSideBySide() {
        let planner = makePlanner()
        planner.schedule(thought(planner, "Book a haircut").id, startMin: 20 * 60)
        planner.schedule(thought(planner, "Look into a standing desk").id, startMin: 20 * 60 + 15)
        let day = planner.daySchedule(on: planner.today, fieldWidth: field)
        let first = block(day, "Book a haircut").frame(fieldWidth: field)
        let second = block(day, "Look into a standing desk").frame(fieldWidth: field)
        #expect(first.paneTop + first.paneHeight > second.paneTop)
        #expect(first.paneX + first.paneWidth <= second.paneX)
    }

    // MARK: The Anytime band (PR 5)

    @Test func theBandsHeaderCountsItsRows() {
        #expect(AnytimeBandRules.header(count: 0) == "Anytime")
        #expect(AnytimeBandRules.header(count: 4) == "Anytime \u{00B7} 4")
        #expect(AnytimeBandRules.spokenHeader(count: 0) == "Anytime")
        #expect(AnytimeBandRules.spokenHeader(count: 1) == "Anytime, 1 item")
        #expect(AnytimeBandRules.spokenHeader(count: 4) == "Anytime, 4 items")
    }

    /// Folded or not is stored under a key that is never renamed, open until
    /// the person folds it; three rows show before the band scrolls, and one
    /// at the accessibility text sizes, so the hours keep their room.
    @Test func theBandsFoldIsStoredOpenByDefault() {
        #expect(AnytimeBandRules.storageKey == "schedule.anytimeOpen")
        #expect(AnytimeBandRules.defaultOpen)
        #expect(AnytimeBandRules.visibleRows == 3)
        #expect(AnytimeBandRules.visibleRows(accessibilitySize: false) == 3)
        #expect(AnytimeBandRules.visibleRows(accessibilitySize: true) == 1)
    }

    /// The sheet folds the band to its header without touching the stored
    /// choice, and a tap while it is up stores nothing new, so closing the
    /// sheet brings back the rows the person had open.
    @Test func theSheetFoldsTheBandWithoutWritingTheChoice() {
        #expect(AnytimeBandRules.showsRows(open: true, sheetUp: false))
        #expect(!AnytimeBandRules.showsRows(open: true, sheetUp: true))
        #expect(!AnytimeBandRules.showsRows(open: false, sheetUp: false))
        #expect(!AnytimeBandRules.showsRows(open: false, sheetUp: true))
        #expect(AnytimeBandRules.afterTap(open: true, sheetUp: false) == false)
        #expect(AnytimeBandRules.afterTap(open: false, sheetUp: false) == true)
        #expect(AnytimeBandRules.afterTap(open: true, sheetUp: true) == true)
        #expect(AnytimeBandRules.afterTap(open: false, sheetUp: true) == false)
    }

    @Test func theBandListsTheDaysUntimedRows() {
        let planner = makePlanner()
        let day = planner.daySchedule(on: planner.today, fieldWidth: field)
        let titles = day.untimed.map(\.title)
        // Untimed habits first, then untimed tasks not in a project block:
        // seven on the sample's Thursday (README, Checking the Anytime band).
        #expect(titles == ["Meds", "Stretch 10 min", "Journal", "Plan tomorrow",
                           "Reply to Avery about pricing", "Review design PR", "Groceries"])
        let firstTask = day.untimed.firstIndex { !$0.isHabit } ?? day.untimed.count
        #expect(day.untimed[..<firstTask].allSatisfy { $0.isHabit })
        #expect(day.untimed[firstTask...].allSatisfy { !$0.isHabit })
        #expect(!titles.contains("Draft Q4 roadmap"))
        #expect(!day.untimed.contains { planner.braindump.map(\.id).contains($0.id) })
    }

    /// A band row ticks on the band's day, and only there, though another
    /// day is selected. `tickAnytimeRow` is the call AnytimeBand makes.
    @Test func aBandRowTicksOnItsDay() {
        let planner = makePlanner()
        let monday = planner.today.adding(days: -3)
        #expect(planner.selectedDay == planner.today)
        // Stretch was done today and yesterday, not on Monday.
        let mondays = planner.daySchedule(on: monday, fieldWidth: field)
        let stretch = mondays.untimed.first { $0.title == "Stretch 10 min" }!
        #expect(planner.isDone(stretch, on: planner.today))
        #expect(!planner.isDone(stretch, on: monday))
        planner.tickAnytimeRow(stretch, in: mondays)
        #expect(planner.isDone(planner.item(stretch.id)!, on: monday))
        #expect(planner.isDone(planner.item(stretch.id)!, on: planner.today))
    }

    /// Scheduling a band row's task takes it off the band and onto the grid,
    /// from the same derive.
    @Test func aScheduledRowLeavesTheBandForTheGrid() {
        let planner = makePlanner()
        let groceries = planner.daySchedule(on: planner.today, fieldWidth: field).untimed
            .first { $0.title == "Groceries" }!
        planner.schedule(groceries.id, startMin: 18 * 60)
        let day = planner.daySchedule(on: planner.today, fieldWidth: field)
        #expect(!day.untimed.contains { $0.id == groceries.id })
        #expect(day.blocks.contains { $0.id == groceries.id && $0.startMin == 18 * 60 })
    }
}
