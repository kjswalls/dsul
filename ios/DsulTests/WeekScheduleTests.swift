import DsulCore
import Foundation
import Testing
@testable import Dsul

/// Week × Schedule (Week and blocks PR 10, design §4.5): the week laid out
/// once from a kept `week(of:)`, the drops a column and a strip take, the
/// drop sessions of two columns in either order, the hours under the pinned
/// head, the sideways autoscroll, and the week's own rules. Foundation only,
/// so the shim runs it; ScheduleRenderTests hosts the view itself.
@MainActor
@Suite struct WeekScheduleTests {
    /// A Thursday (as SamplePlannerTests' planner), the clock noon UTC. Its
    /// week runs Sunday Sep 27 to Saturday Oct 3.
    private func makePlanner() -> SamplePlanner {
        SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
    }

    private func day(_ s: String) -> DayString { DayString(s)! }

    private let sampleWeek = ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02",
                              "2026-10-03"].map { DayString($0)! }

    /// A column on a 393pt phone: the columns' viewport (393 less the 52pt
    /// gutter and the 8pt margin) in thirds.
    private let column = 111.0
    private let hour = ScheduleMetrics.hourPx

    private func id(_ planner: SamplePlanner, _ title: String) -> UUID {
        planner.items.first { $0.title == title }!.id
    }

    private func titles(_ planner: SamplePlanner, on day: DayString) -> [String] {
        planner.scheduled(on: day).map(\.title)
    }

    // MARK: One week, kept

    #if DEBUG
    /// The design's proof for the week (§4.5 "Cost", §4.6): Week × Schedule
    /// asks for its week on every render, and the planner derives the seven
    /// days once, then hands the kept week back until something it reads
    /// changes. So a ghost step, which writes nothing, derives nothing, and a
    /// write derives the seven again.
    @Test func aGhostStepDoesNotDeriveTheWeekAgain() {
        let planner = makePlanner()
        let before = planner.derivations
        let week = planner.weekSchedule(of: planner.today, columnWidth: column)
        #expect(planner.derivations == before + 7)
        _ = planner.weekSchedule(of: planner.today, columnWidth: column)
        _ = planner.week(of: day("2026-09-27"))
        _ = planner.weekRows(of: day("2026-10-03"))
        #expect(planner.derivations == before + 7, "Asked again with nothing changed")

        // A ghost walked down a column and across to the next, each step
        // followed by the render it causes.
        let drag = ScheduleDrag()
        drag.hoursTop = 120
        let lunch = id(planner, "Lunch walk")
        drag.beginMove(itemID: lunch, durationMin: 45, source: .block(day: planner.today), anchor: 0.5,
                       confinedTo: planner.confinedDay(lunch, from: planner.today))
        for (i, y) in stride(from: 300.0, through: 900.0, by: 20).enumerated() {
            let over = sampleWeek[4 + (i / 16)]
            drag.columnUpdate(day: over, phase: .active, y: y)
            _ = planner.weekSchedule(of: planner.today, columnWidth: column)
        }
        #expect(drag.ghostStartMin != nil)
        #expect(planner.derivations == before + 7, "A ghost step re-derived the week")
        drag.reset()
        DragHold.shared.releaseNow()

        // A change to anything the week reads derives it again, once.
        planner.toggleRow(id(planner, "Standup"), on: planner.today)
        let after = planner.weekSchedule(of: planner.today, columnWidth: column)
        #expect(planner.derivations == before + 14)
        #expect(after != week)
        _ = planner.weekSchedule(of: planner.today, columnWidth: column)
        #expect(planner.derivations == before + 14)
        // Another week is another key.
        _ = planner.weekSchedule(of: planner.today.adding(days: 7), columnWidth: column)
        #expect(planner.derivations == before + 21)
    }
    #endif

    /// Each column is its day as Day lays it out, in the week's order, with
    /// the web's week overlap pass (no width cap) at the column's width.
    @Test func eachColumnIsItsDayWithTheWeeksOverlapPass() {
        let planner = makePlanner()
        let week = planner.weekSchedule(of: planner.today, columnWidth: column)
        #expect(week.map(\.day) == sampleWeek)
        for column in week {
            let alone = planner.daySchedule(on: column.day, fieldWidth: self.column)
            #expect(column.blocks.map(\.id) == alone.blocks.map(\.id), "\(column.day)")
            #expect(column.blocks.map(\.startMin) == alone.blocks.map(\.startMin), "\(column.day)")
            #expect(column.untimed.map(\.id) == alone.untimed.map(\.id), "\(column.day)")
            #expect(column.fieldWidth == self.column)
            let entries = drawnTimedEntries(planner.derive(on: column.day)).map { OverlapEntry($0) }
            let plans = planOverlaps(entries, variant: .week)
            for block in column.blocks {
                #expect(block.plan == plans.plan(for: block.id), "\(column.day) \(block.item.title)")
            }
        }
        // The blocks read in time order, as VoiceOver reads them.
        for column in week {
            #expect(column.blocks.map(\.startMin) == column.blocks.map(\.startMin).sorted(), "\(column.day)")
        }
        // The sample's week: Monday's errand, Friday's coffee, Saturday's card.
        #expect(week[1].blocks.contains { $0.item.title == "Pick up the dry cleaning" })
        #expect(week[5].blocks.contains { $0.item.title == "Coffee with Priya" })
        #expect(week[6].untimed.contains { $0.title == "Post the birthday card" })
    }

    // MARK: Drops on a column's hours

    /// A one-off let go on another column takes that column's day and the
    /// hour it was let go at, through the drop rule's `schedule`.
    @Test func aOneOffDroppedOnAnotherColumnMovesDayAndTime() {
        let planner = makePlanner()
        let thursday = planner.today
        let saturday = day("2026-10-03")
        let lunch = id(planner, "Lunch walk")
        let drag = ScheduleDrag()
        drag.hoursTop = 120
        drag.beginMove(itemID: lunch, durationMin: 45, source: .block(day: thursday), anchor: 0,
                       confinedTo: planner.confinedDay(lunch, from: thursday))
        #expect(drag.confinedTo == nil)
        // Held by its top: the ghost's top is the finger, on Saturday.
        let y = drag.hoursTop + 10 * hour
        drag.columnUpdate(day: saturday, phase: .entering, y: y)
        #expect(drag.ghostDay == saturday)
        #expect(drag.ghostStartMin == 10 * 60)
        let start = drag.dropStart(contentY: y, durationMin: 45)
        #expect(start == 10 * 60)

        planner.dropOnHour(lunch, said: drag.source(of: lunch), on: saturday, startMin: start)
        #expect(planner.item(lunch)?.startDate == saturday.description)
        #expect(planner.item(lunch)?.startTime == "10:00")
        #expect(titles(planner, on: saturday).contains("Lunch walk"))
        #expect(!titles(planner, on: thursday).contains("Lunch walk"))
        drag.reset()
        DragHold.shared.releaseNow()
    }

    /// A habit or a series moves in time only (B18): its ghost keeps to its
    /// own column whatever column the finger crosses, and the drop lands the
    /// time on its own day, every day it falls on, its start date untouched.
    @Test func aRepeatingItemsDropOnAnotherColumnLandsTheTimeOnItsOwnDay() {
        let planner = makePlanner()
        let thursday = planner.today
        let saturday = day("2026-10-03")
        let walk = SampleData.uuid(59)
        let drag = ScheduleDrag()
        drag.beginMove(itemID: walk, durationMin: 20, source: .block(day: thursday), anchor: 0,
                       confinedTo: planner.confinedDay(walk, from: thursday))
        #expect(drag.confinedTo == thursday)
        drag.columnUpdate(day: saturday, phase: .entering, y: 8 * hour + 15 * hour / 60)
        #expect(drag.ghostDay == thursday, "The ghost stays in its own column")
        #expect(drag.ghostStartMin == 8 * 60 + 15)

        planner.dropOnHour(walk, said: drag.source(of: walk), on: saturday, startMin: 8 * 60 + 15)
        #expect(planner.item(walk)?.startTime == "08:15")
        for date in sampleWeek {
            let walkBlock = planner.daySchedule(on: date, fieldWidth: column).blocks.first { $0.id == walk }
            #expect(walkBlock?.startMin == 8 * 60 + 15, "\(date)")
        }

        // Team sync, a weekly series on Thursdays: retimed, its start date
        // kept, and still on Thursday, not Saturday.
        let teamSync = SampleData.uuid(60)
        let start = planner.item(teamSync)?.startDate
        planner.dropOnHour(teamSync, said: .block(day: thursday), on: saturday, startMin: 17 * 60 + 15)
        #expect(planner.item(teamSync)?.startDate == start)
        #expect(planner.item(teamSync)?.startTime == "17:15")
        #expect(titles(planner, on: thursday).contains("Team sync"))
        #expect(!titles(planner, on: saturday).contains("Team sync"))
        drag.reset()
        DragHold.shared.releaseNow()
    }

    /// A braindump row let go on a column's hour is scheduled on that
    /// column's day, never the selected one, and sends the hour drop's
    /// `schedule` with that date.
    @Test func aBraindumpRowDroppedOnAColumnSchedulesOnThatDay() async {
        let planner = makePlanner()
        let friday = day("2026-10-02")
        let bank = planner.braindump.first { $0.title == "Call the bank" }!.id
        #expect(planner.selectedDay == planner.today)
        planner.dropOnHour(bank, said: .braindump, on: friday, startMin: 14 * 60)
        #expect(planner.item(bank)?.startDate == friday.description)
        #expect(planner.item(bank)?.startTime == "14:00")
        #expect(!planner.braindump.contains { $0.id == bank })
        #expect(titles(planner, on: friday).contains("Call the bank"))
        #expect(!titles(planner, on: planner.today).contains("Call the bank"))

        // Signed in, the write is the column's date.
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.setFallback(.status(200, "{\"ok\":true}"))
        let live = makeLivePlanner(server)
        await live.refresh()
        let before = await server.requests.count
        live.dropOnHour(PlannerJSON.bank, said: .braindump, on: friday, startMin: 14 * 60)
        if let sync = live.sync { await sync.drain() }
        let made = await server.requests.dropFirst(before).filter { $0.route.hasPrefix("POST") }
        #expect(made.count == 1)
        #expect(made.first?.route == itemRoute(PlannerJSON.bank))
        let body = bodyJSON(made.first)
        #expect(body?["action"] as? String == "schedule")
        #expect(body?["date"] as? String == friday.description)
        #expect(body?["startTime"] as? String == "14:00")
        #expect(live.item(PlannerJSON.bank)?.startDate == friday.description)
    }

    // MARK: The strips

    /// Another day's Anytime strip refuses a block or an Anytime row in v1
    /// (B22), with the forbidden badge and no write; its own day's takes it.
    /// A braindump row goes on any day's strip, through the Date chip's gate.
    @Test func anotherDaysStripRefusesABlock() {
        let planner = makePlanner()
        let thursday = planner.today
        let friday = day("2026-10-02")
        let lunch = id(planner, "Lunch walk")
        let walk = SampleData.uuid(59)
        let groceries = planner.anytime(on: thursday).first { $0.title == "Groceries" }!.id

        #expect(planner.refusesAnytimeDrop(lunch, source: .block(day: thursday), on: friday))
        #expect(planner.refusesAnytimeDrop(walk, source: .block(day: thursday), on: friday))
        #expect(planner.refusesAnytimeDrop(groceries, source: .anytime(day: thursday), on: friday))
        #expect(!planner.refusesAnytimeDrop(lunch, source: .block(day: thursday), on: thursday))
        #expect(!planner.refusesAnytimeDrop(walk, source: .block(day: thursday), on: thursday))
        #expect(planner.refusesAnytimeDrop(nil, source: .block(day: thursday), on: thursday))

        let before = planner.item(lunch)
        planner.dropOnAnytime(lunch, said: .block(day: thursday), on: friday)
        #expect(planner.item(lunch) == before, "Refused: nothing moves")
        planner.dropOnAnytime(groceries, said: .anytime(day: thursday), on: friday)
        #expect(planner.item(groceries)?.startDate == thursday.description)

        // Its own day's strip takes it: the day kept, the time dropped.
        planner.dropOnAnytime(lunch, said: .block(day: thursday), on: thursday)
        #expect(planner.item(lunch)?.startDate == thursday.description)
        #expect(planner.item(lunch)?.startTime == nil)
        #expect(planner.anytime(on: thursday).contains { $0.id == lunch })

        // A braindump row on Friday's strip.
        let bank = planner.braindump.first { $0.title == "Call the bank" }!.id
        #expect(!planner.refusesAnytimeDrop(bank, source: .braindump, on: friday))
        planner.dropOnAnytime(bank, said: .braindump, on: friday)
        #expect(planner.anytime(on: friday).contains { $0.id == bank })
        DragHold.shared.releaseNow()
    }

    // MARK: Two columns' drop sessions

    /// Leaving one column for the next delivers the old column's `.exiting`
    /// and the new one's `.entering` in either order (design §4.5, F4): the
    /// ghost survives both, for a drag that follows the finger and one kept
    /// to its own column.
    @Test func twoColumnsUpdatesInEitherOrderKeepTheGhost() {
        let monday = day("2026-09-28")
        let tuesday = day("2026-09-29")
        let y = 10 * hour
        for confined in [nil, monday] {
            // Enter, then exit.
            let drag = ScheduleDrag()
            drag.beginMove(itemID: UUID(), durationMin: 30, source: .block(day: monday), anchor: 0,
                           confinedTo: confined)
            drag.columnUpdate(day: monday, phase: .entering, y: y)
            drag.columnUpdate(day: monday, phase: .active, y: y)
            drag.columnUpdate(day: tuesday, phase: .entering, y: y + hour)
            drag.columnUpdate(day: monday, phase: .exiting, y: y)
            #expect(drag.ghostStartMin == 11 * 60, "enter then exit, confined \(confined != nil)")
            #expect(drag.ghostDay == (confined ?? tuesday))
            #expect(drag.overDay == tuesday)

            // Exit, then enter.
            drag.columnUpdate(day: tuesday, phase: .exiting, y: y + hour)
            #expect(drag.ghostStartMin == nil)
            drag.columnUpdate(day: monday, phase: .entering, y: y)
            #expect(drag.ghostStartMin == 10 * 60, "exit then enter, confined \(confined != nil)")
            #expect(drag.ghostDay == (confined ?? monday))

            // The finger leaves the hours for good: its own column's exit
            // clears the ghost, and a late one from elsewhere changes nothing.
            drag.columnUpdate(day: monday, phase: .exiting, y: y)
            #expect(drag.ghostStartMin == nil)
            #expect(drag.contentY == nil)
            drag.columnUpdate(day: tuesday, phase: .exiting, y: y)
            #expect(drag.ghostStartMin == nil)
            drag.reset()
            #expect(drag.overDay == nil)
        }
        DragHold.shared.releaseNow()
    }

    // MARK: The hours under the pinned head

    /// The hours start `hoursTop` down the grid's content in Week (0 on
    /// Day): the ghost and a drop read the hours at `y - hoursTop`, and the
    /// top edge's autoscroll zone starts below the strips.
    @Test func theHoursStartAtHoursTop() {
        let drag = ScheduleDrag()
        #expect(drag.hoursTop == 0)
        drag.beginMove(itemID: UUID(), durationMin: 60, source: .block(day: day("2026-10-01")), anchor: 0,
                       confinedTo: nil)
        drag.setContentY(10 * hour)
        #expect(drag.ghostStartMin == 10 * 60)
        drag.hoursTop = 130
        drag.setContentY(10 * hour)
        #expect(drag.ghostStartMin == 8 * 60 + 15, "The head's 130pt above the hours")
        drag.setContentY(130 + 10 * hour)
        #expect(drag.ghostStartMin == 10 * 60)
        #expect(drag.dropStart(contentY: 130 + 10 * hour, durationMin: 60) == 10 * 60)
        // The head itself is no hour: a finger over it reads midnight.
        #expect(drag.dropStart(contentY: 40, durationMin: 60) == 0)
        drag.reset()
        DragHold.shared.releaseNow()

        // The top edge: driven by hand under the pinned heads, from below the
        // strips; left to the system on Day (device check M3).
        let frame = 1.0 / 60
        let edge = ScheduleMetrics.edgeZone
        #expect(ScheduleAutoscroll.drivesTopEdge(hoursTop: 0) == ScheduleAutoscroll.handDrivesTopEdge)
        #expect(ScheduleAutoscroll.handDrivesWeekTopEdge, "Week's top edge is the phone's until W-S3 says not")
        #expect(ScheduleAutoscroll.drivesTopEdge(hoursTop: 130))
        func step(_ fingerY: Double) -> Double {
            ScheduleAutoscroll.step(fingerY: fingerY, viewportH: 600, coveredBottom: 0, dt: frame,
                                    topEdge: ScheduleAutoscroll.drivesTopEdge(hoursTop: 130), visibleTop: 130)
        }
        #expect(step(130 + edge / 2) < 0)
        #expect(step(130 + edge + 10) == 0)
        #expect(step(600 - edge / 2) > 0)
        // Day's zone is the viewport's top.
        #expect(ScheduleAutoscroll.step(fingerY: 130 + edge / 2, viewportH: 600, coveredBottom: 0, dt: frame,
                                        topEdge: true) == 0)
    }

    // MARK: Sideways

    /// The columns scroll one day at a time once the finger has rested in a
    /// side edge for the dwell, and the ghost moves to the column the still
    /// finger is now over. A drag kept to its own column (B18) never steps:
    /// it lands on its own day wherever it is let go, and a step would only
    /// carry its ghost off the screen.
    @Test func theColumnsStepADayAfterTheFingerRestsAtAnEdge() {
        #expect(ScheduleAutoscroll.handDrivesSideEdges)
        var side = SideAutoscroll()
        let frames = Int((SideAutoscroll.dwell * 10).rounded(.up))
        // Mid-viewport: nothing.
        for _ in 0..<20 { #expect(side.step(fingerX: 160, viewportW: 333, dt: 0.1) == 0) }
        // The trailing edge: a step once the dwell has passed, then another
        // dwell before the next.
        var steps: [Int] = []
        for _ in 0..<(2 * frames) { steps.append(side.step(fingerX: 320, viewportW: 333, dt: 0.1)) }
        #expect(steps.filter { $0 != 0 } == [1, 1])
        #expect(steps.firstIndex(of: 1) == frames - 1)
        // Leaving the zone starts the dwell over.
        _ = side.step(fingerX: 320, viewportW: 333, dt: 0.5)
        _ = side.step(fingerX: 160, viewportW: 333, dt: 0.1)
        #expect(side.held == 0)
        #expect(side.step(fingerX: 320, viewportW: 333, dt: 0.5) == 0)
        // The leading edge steps back.
        side.reset()
        #expect(side.step(fingerX: 10, viewportW: 333, dt: SideAutoscroll.dwell) == -1)
        #expect(SideAutoscroll.zone < ScheduleMetrics.edgeZone)

        let sunday = sampleWeek[0]
        let drag = ScheduleDrag()
        drag.columnDays = sampleWeek
        drag.columnWidth = column
        drag.viewportW = 3 * column
        drag.offsetX = 0
        drag.beginMove(itemID: UUID(), durationMin: 30, source: .block(day: sunday), anchor: 0, confinedTo: nil)
        // Over Tuesday (the third column), near its right edge.
        drag.columnUpdate(day: sampleWeek[2], phase: .active, y: 10 * hour, x: 2 * column + 100)
        #expect(drag.sideStep(dt: SideAutoscroll.dwell / 2) == nil)
        #expect(drag.sideStep(dt: SideAutoscroll.dwell / 2) == sampleWeek[1], "Monday to the leading edge")
        #expect(drag.offsetX == column)
        #expect(drag.fingerX == 3 * column + 100)
        #expect(drag.overDay == sampleWeek[3])
        #expect(drag.ghostDay == sampleWeek[3])
        #expect(drag.ghostStartMin == 10 * 60)
        // Tuesday's late exit leaves the ghost on Wednesday.
        drag.columnUpdate(day: sampleWeek[2], phase: .exiting, y: 10 * hour)
        #expect(drag.ghostStartMin == 10 * 60)
        // The week's end: Thursday leads, and nothing scrolls past it.
        drag.offsetX = 4 * column
        drag.columnUpdate(day: sampleWeek[6], phase: .active, y: 10 * hour, x: 6 * column + 100)
        #expect(drag.sideStep(dt: SideAutoscroll.dwell) == nil)
        #expect(drag.offsetX == 4 * column)
        // Off the hours, nothing scrolls sideways.
        drag.columnUpdate(day: sampleWeek[6], phase: .exiting, y: 10 * hour)
        #expect(drag.sideStep(dt: SideAutoscroll.dwell) == nil)
        drag.reset()

        // Kept to Sunday's column: resting at either edge, however long,
        // steps nothing, and the ghost stays on Sunday, which still shows.
        let kept = ScheduleDrag()
        kept.columnDays = sampleWeek
        kept.columnWidth = column
        kept.viewportW = 3 * column
        kept.offsetX = 0
        kept.beginMove(itemID: UUID(), durationMin: 30, source: .block(day: sunday), anchor: 0, confinedTo: sunday)
        kept.columnUpdate(day: sampleWeek[2], phase: .active, y: 10 * hour, x: 2 * column + 100)
        for _ in 0..<5 { #expect(kept.sideStep(dt: SideAutoscroll.dwell) == nil) }
        kept.offsetX = column
        kept.columnUpdate(day: sampleWeek[1], phase: .active, y: 10 * hour, x: column + 10)
        for _ in 0..<5 { #expect(kept.sideStep(dt: SideAutoscroll.dwell) == nil) }
        #expect(kept.offsetX == column)
        #expect(kept.overDay == sampleWeek[1])
        #expect(kept.ghostDay == sunday)
        #expect(kept.ghostStartMin == 10 * 60)
        kept.reset()
        // Day has no columns to scroll.
        let day = ScheduleDrag()
        day.beginMove(itemID: UUID(), durationMin: 30, source: .block(day: sampleWeek[4]), anchor: 0, confinedTo: nil)
        day.columnUpdate(day: sampleWeek[4], phase: .active, y: 10 * hour)
        #expect(day.sideStep(dt: 1) == nil)
        day.reset()
        DragHold.shared.releaseNow()
    }

    // MARK: The week's rules

    @Test func threeColumnsAcrossOrTwoAtAccessibilitySizes() {
        #expect(WeekScheduleRules.across(accessibilitySize: false) == 3)
        #expect(WeekScheduleRules.across(accessibilitySize: true) == 2)
        #expect(WeekScheduleRules.columnWidth(viewportW: 333, across: 3) == 111)
        #expect(WeekScheduleRules.columnWidth(viewportW: 380, across: 2) == 190)
        #expect(WeekScheduleRules.columnWidth(viewportW: 333, across: 0) == 0)
        #expect(WeekScheduleRules.trailingMargin == 8)
        #expect(WeekScheduleRules.across(viewportW: 333, columnWidth: 111) == 3)
        #expect(WeekScheduleRules.across(viewportW: 380, columnWidth: 190) == 2)
        #expect(WeekScheduleRules.across(viewportW: 333, columnWidth: 0) == 1)
        #expect(WeekScheduleRules.leadingIndex(offsetX: 0, columnWidth: 111, count: 7, across: 3) == 0)
        #expect(WeekScheduleRules.leadingIndex(offsetX: 230, columnWidth: 111, count: 7, across: 3) == 2)
        #expect(WeekScheduleRules.leadingIndex(offsetX: 9999, columnWidth: 111, count: 7, across: 3) == 4)
        #expect(WeekScheduleRules.columnIndex(atContentX: 110, columnWidth: 111, count: 7) == 0)
        #expect(WeekScheduleRules.columnIndex(atContentX: 111, columnWidth: 111, count: 7) == 1)
        #expect(WeekScheduleRules.columnIndex(atContentX: 9999, columnWidth: 111, count: 7) == 6)
        #expect(WeekScheduleRules.columnIndex(atContentX: -5, columnWidth: 111, count: 7) == 0)
    }

    /// The selected day leads, as far as the week's end allows (W15).
    @Test func theWeekOpensOnTheSelectedDay() {
        let opening = sampleWeek.map { WeekScheduleRules.openingIndex(selected: $0, days: sampleWeek, across: 3) }
        #expect(opening == [0, 1, 2, 3, 4, 4, 4])
        let two = sampleWeek.map { WeekScheduleRules.openingIndex(selected: $0, days: sampleWeek, across: 2) }
        #expect(two == [0, 1, 2, 3, 4, 5, 5])
        #expect(WeekScheduleRules.openingIndex(selected: day("2026-10-09"), days: sampleWeek, across: 3) == 0)
        #expect(WeekScheduleRules.openingDay(selected: day("2026-10-02"), days: sampleWeek, across: 3)
                == day("2026-10-01"))
        #expect(WeekScheduleRules.openingDay(selected: day("2026-10-02"), days: [], across: 3) == nil)
    }

    /// One head height for the week: the tallest strip's rows, at most
    /// three, and a "+N more" line if any day has one; one row at least.
    @Test func everyStripTakesTheWeeksTallest() {
        /// "2" for two rows, "3+" for three and a "+N more" line.
        func lines(_ counts: [Int]) -> String {
            let lines = WeekScheduleRules.stripLines(counts: counts)
            return "\(lines.rows)" + (lines.more ? "+" : "")
        }
        #expect(lines([0, 0, 0, 0, 0, 0, 0]) == "1")
        #expect(lines([2, 0, 1, 0, 0, 0, 0]) == "2")
        #expect(lines([3, 0, 0, 0, 0, 0, 0]) == "3")
        #expect(lines([1, 5, 0, 0, 0, 0, 0]) == "3+")
        #expect(lines([]) == "1")
        #expect(WeekScheduleRules.shownRows(5) == 3)
        #expect(WeekScheduleRules.shownRows(2) == 2)
        #expect(WeekScheduleRules.overflow(5) == 2)
        #expect(WeekScheduleRules.overflow(3) == 0)
        #expect(WeekScheduleRules.moreLine(5) == "+2 more")
        #expect(WeekScheduleRules.moreLine(3) == nil)
        #expect(WeekScheduleRules.emptyStrip == "Anytime")

        // One row from the first accessibility size up, the rest "+N more".
        #expect(WeekScheduleRules.stripRows(accessibilitySize: false) == 3)
        #expect(WeekScheduleRules.stripRows(accessibilitySize: true) == 1)
        let one = WeekScheduleRules.stripLines(counts: [0, 2, 0, 0, 0, 0, 0], limit: 1)
        #expect(one.rows == 1)
        #expect(one.more)
        #expect(WeekScheduleRules.shownRows(2, limit: 1) == 1)
        #expect(WeekScheduleRules.moreLine(2, limit: 1) == "+1 more")
        #expect(WeekScheduleRules.moreLine(1, limit: 1) == nil)

        // The sample's week.
        let planner = makePlanner()
        let week = planner.weekSchedule(of: planner.today, columnWidth: column)
        let lines = WeekScheduleRules.stripLines(counts: week.map(\.untimed.count))
        #expect(lines.rows == min(3, week.map(\.untimed.count).max() ?? 0))

        // Today's strip as the README's W-S2 reads it: the morning habits
        // first, three rows, then "+4 more", Journal among them.
        let todays = week[4].untimed
        #expect(week[4].day == planner.today)
        #expect(todays.prefix(3).map(\.title) == ["Meds", "Stretch 10 min", "Journal"])
        #expect(WeekScheduleRules.moreLine(todays.count) == "+4 more")
    }

    /// A Week block says its start under its title from 45 minutes up, in
    /// the user's clock.
    @Test func aCompactBlockSaysItsStartFromFortyFiveMinutes() {
        let planner = makePlanner()
        let today = planner.daySchedule(on: planner.today, fieldWidth: column)
        func block(_ title: String) -> ScheduleBlock { today.blocks.first { $0.item.title == title }! }
        #expect(WeekScheduleRules.startLineFromMin == 45)
        #expect(WeekScheduleRules.startLine(block("Lunch walk"), timeFormat: .twelveHour) == "12:30 pm")
        #expect(WeekScheduleRules.startLine(block("Lunch walk"), timeFormat: .twentyFourHour) == "12:30")
        #expect(WeekScheduleRules.startLine(block("Walk"), timeFormat: .twelveHour) == nil)
        #expect(WeekScheduleRules.startLine(block("Draft Q4 roadmap"), timeFormat: .twelveHour) == "9:00 am")
    }

    /// A braindump row's hour drop on Day stays the selected day's: the
    /// old entry is the new one at `selectedDay`.
    @Test func daysHourDropIsTheSelectedDays() {
        let planner = makePlanner()
        planner.select(day("2026-09-30"))
        let bank = planner.braindump.first { $0.title == "Call the bank" }!.id
        planner.schedule(bank, startMin: 9 * 60)
        #expect(planner.item(bank)?.startDate == "2026-09-30")
        #expect(planner.item(bank)?.startTime == "09:00")
        DragHold.shared.releaseNow()
    }
}
