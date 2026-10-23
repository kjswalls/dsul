import DsulCore
import Foundation
import Testing
@testable import Dsul

/// A container's page (ContainerPageModel, O2 and O3), on Thursday
/// 2026-10-01: the strip's law (a past day is never a share, and a member
/// added today moves no past cell), a routine's chips, notes, held note,
/// "Held by", today's checklist in its own order and its other days; a
/// season's chips, sentence and routines; a goal's ring, countdown, window,
/// ended note, wind-down, timeline, check-ins, groups and hidden notes; a
/// project's count, rows and time block; the switched-off and gone pages; and
/// the list's "2/3 today". The rules under them are DsulCore's ports, pinned
/// against the web by their fixtures; these pin how a page puts them
/// together, and that nothing it says is an em dash, "missed" or "overdue".
@MainActor
@Suite struct OrganizePageTests {
    private let today = DayString("2026-10-01")!
    private let zone = "America/New_York"

    private func uid(_ n: Int) -> UUID {
        return UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", n))!
    }

    /// The day `offset` days from today, as stored.
    private func day(_ offset: Int) -> String {
        return today.adding(days: offset).description
    }

    private func habit(_ n: Int, _ title: String, days: [Int]? = nil, done: [Int] = [], skipped: [Int] = [],
                       streak: Int = 0) -> Item {
        return Item(id: uid(n), type: "habit", title: title, timeBucket: "morning",
                    repeatFrequency: days == nil ? "daily" : "custom", streak: streak, repeatDays: days,
                    completedDates: done.map(day), skippedDates: skipped.map(day))
    }

    private func task(_ n: Int, _ title: String, status: String = "pending", project: String? = nil,
                      parent: UUID? = nil, on date: Int? = nil) -> Item {
        return Item(id: uid(n), type: "task", title: title, status: status, startDate: date.map(day),
                    startTime: date == nil ? nil : "09:00", timeBucket: date == nil ? nil : "morning",
                    project: project, parentItemId: parent.map(lowerID), duration: 30, isScheduled: date != nil)
    }

    private func snapshot(organize: Bool = true, goalsOn: Bool = true, streaks: Bool = true, items: [Item],
                          routines: [Routine] = [], seasons: [Season] = [], goals: [Goal]? = nil,
                          projects: [Project] = [], typeLabels: [String: ItemTypeLabel] = [:],
                          takes: ContainerWrites = ContainerWrites()) -> OrganizeSnapshot {
        return OrganizeSnapshot(settings: PlannerSettings(streaksEnabled: streaks, organizeEnabled: organize,
                                                          goalsEnabled: goalsOn),
                                today: today, timeZone: zone, items: items, routines: routines, seasons: seasons,
                                goals: goals, projects: projects, typeLabels: typeLabels, containerTakes: takes)
    }

    private struct PageMissing: Error {}

    // MARK: A routine's fixture

    /// Meds done today and on days -1 and -3; Stretch done on -1 and skipped
    /// on -2; Journal never; Long run on Sundays only (today is a Thursday).
    private var routineItems: [Item] {
        return [
            habit(1, "Meds", done: [0, -1, -3], streak: 41),
            habit(2, "Stretch", done: [-1], skipped: [-2]),
            habit(3, "Journal"),
            habit(4, "Long run", days: [0]),
        ]
    }

    /// Journal first: the routine's order, not the grid's. uid(99) is a
    /// trashed member whose join row outlived it.
    private var morning: Routine {
        return Routine(id: "r-morning", name: "Morning", icon: "icon:Sunrise", color: "var(--accent-6)",
                       sortOrder: 0, usualTime: "07:00", notes: "  Meds first.  ",
                       itemIds: [uid(3), uid(1), uid(2), uid(4), uid(99)])
    }

    private func routinePage(_ s: OrganizeSnapshot, _ id: String = "r-morning") throws -> RoutinePage {
        guard case .page(let page)? = ContainerPageModel.routinePage(id, s) else {
            Issue.record("no routine page")
            throw PageMissing()
        }
        return page
    }

    // MARK: The strip

    @Test func aPastDayIsNeverAShare() throws {
        let page = try routinePage(snapshot(items: routineItems, routines: [morning]))
        let strip = try #require(page.strip)
        #expect(strip.cells.count == 14)
        #expect(strip.firstLabel == "Sep 18")
        #expect(strip.cells.first?.date.description == day(-13))
        #expect(strip.cells.last?.date == today)
        let byDay = Dictionary(uniqueKeysWithValues: strip.cells.map { ($0.date.description, $0) })
        // One of three done is a full lime cell, as two of three is.
        #expect(byDay[day(-1)]?.mark == .done)
        #expect(byDay[day(-1)]?.spokenLabel == "Sep 30, 2 done")
        #expect(byDay[day(-3)]?.mark == .done)
        #expect(byDay[day(-3)]?.spokenLabel == "Sep 28, 1 done")
        // A skip outranks a member nothing was recorded for.
        #expect(byDay[day(-2)]?.mark == .skipped)
        #expect(byDay[day(-2)]?.spokenLabel == "Sep 29, skipped")
        #expect(byDay[day(-5)]?.mark == .nothingRecorded)
        #expect(byDay[day(-5)]?.spokenLabel == "Sep 26, nothing recorded")
        // Only today fills by share: Meds of Meds, Stretch and Journal.
        #expect(byDay[day(0)]?.mark == .today(done: 1, of: 3))
        #expect(byDay[day(0)]?.spokenLabel == "Today, 1 of 3 done")
    }

    @Test func aMemberAddedTodayMovesNoPastCell() throws {
        let before = try #require(try routinePage(snapshot(items: routineItems, routines: [morning])).strip)
        var routine = morning
        routine.itemIds.append(uid(5))
        let after = try #require(try routinePage(snapshot(items: routineItems + [habit(5, "Floss")],
                                                          routines: [routine])).strip)
        #expect(Array(after.cells.dropLast()) == Array(before.cells.dropLast()))
        #expect(after.cells.last?.mark == .today(done: 1, of: 4))
    }

    @Test func aStripCellRanksDoneThenSkippedThenNothingRecorded() {
        let past = today.adding(days: -4)
        func mark(_ r: DayRollup) -> DayStrip.Cell.Mark { ContainerPageModel.stripCell(r, today: today).mark }
        #expect(mark(DayRollup(date: past, done: 1, open: 5, skipped: 2)) == .done)
        #expect(mark(DayRollup(date: past, open: 5, skipped: 1)) == .skipped)
        #expect(mark(DayRollup(date: past, open: 1)) == .nothingRecorded)
        #expect(mark(DayRollup(date: past)) == .nothingOn)
        #expect(ContainerPageModel.stripCell(DayRollup(date: past), today: today).spokenLabel == "Sep 27, nothing on")
        // Today: done over done and still due; a skip is neither.
        #expect(mark(DayRollup(date: today, done: 2, due: 1, skipped: 4)) == .today(done: 2, of: 3))
        #expect(ContainerPageModel.stripCell(DayRollup(date: today, skipped: 1), today: today).spokenLabel
            == "Today, skipped")
        #expect(ContainerPageModel.stripCell(DayRollup(date: today), today: today).spokenLabel == "Today, nothing on")
    }

    @Test func aRangeOfNothingShowsNoStrip() {
        let empty = deriveContainerSchedule(memberIds: [], source: snapshot(items: []).scheduleSource,
                                            from: today.adding(days: -13), days: 14, today: today)
        #expect(ContainerPageModel.dayStrip(empty, today: today) == nil)
    }

    // MARK: A routine's page

    @Test func aRoutinesHeaderChipsAndNotes() throws {
        let page = try routinePage(snapshot(items: routineItems, routines: [morning]))
        #expect(page.header.title == "Morning")
        #expect(page.header.eyebrow == "ROUTINE")
        #expect(page.header.symbol == "sunrise")
        #expect(page.header.accent.token == "var(--accent-6)")
        #expect(page.notes == "Meds first.")
        #expect(page.chips.map(\.text) == ["Usually 7:00 am", "Active"])
        #expect(page.chips.map(\.systemImage) == ["clock", "play.circle"])
        #expect(page.chips.map(\.spoken) == ["Usual time: 7:00 am", "Status: Active"])
        #expect(page.statusNote == nil)
        #expect(page.heldBy.isEmpty)
        #expect(page.heldByEmpty == "No season. It answers for itself.")
        #expect(page.empty == nil)
    }

    @Test func todaysChecklistRunsInTheRoutinesOrder() throws {
        let page = try routinePage(snapshot(items: routineItems, routines: [morning]))
        let checklist = try #require(page.today)
        #expect(checklist.rows.map(\.item.title) == ["Journal", "Meds", "Stretch"])
        // The first one still due is "next"; only today's rows tick.
        #expect(checklist.rows.map(\.meta) == ["next", nil, nil])
        #expect(checklist.rows.map(\.done) == [false, true, false])
        #expect(checklist.rows.allSatisfy { $0.tickable })
        #expect(checklist.summary == "1 of 3 done")
        #expect(checklist.empty == nil)
        #expect(checklist.finished == nil)
        #expect(checklist.rows[1].spokenLabel == "Meds, streak 41")
        #expect(checklist.rows[0].spokenLabel == "Journal, next, streak 0")

        let longRun = routineItems[3]
        #expect(page.otherDays.map(\.item.title) == ["Long run"])
        #expect(page.otherDays.map(\.meta) == [cadenceLabel(longRun)])
        #expect(page.otherDays.allSatisfy { !$0.tickable })
        // Merely off today, so no hidden note: only its cadence says when.
        #expect(page.otherDays.allSatisfy { $0.hiddenNote == nil })
    }

    /// The schedule's own word for today decides a row: a cancelled one-off
    /// is skipped, on the row as in the summary, and never offered a tick the
    /// `tick` gate would refuse.
    @Test func aCancelledOneOffOnTodayIsSkippedNotTickable() throws {
        var routine = morning
        routine.itemIds.append(uid(6))
        let items = routineItems + [task(6, "Call the vet", status: "cancelled", on: 0)]
        let checklist = try #require(try routinePage(snapshot(items: items, routines: [routine])).today)
        let vet = try #require(checklist.rows.first { $0.item.title == "Call the vet" })
        #expect(vet.skipped)
        #expect(!vet.tickable)
        #expect(!vet.done)
        #expect(checklist.summary == "1 of 4 done \u{00B7} 1 skipped")
        #expect(checklist.rows.filter(\.skipped).map(\.item.title) == ["Call the vet"])
    }

    @Test func aFinishedRoutineSaysSoAndCountsItsSkip() throws {
        var items = routineItems
        items[1].completedDates.append(day(0))
        items[2].skippedDates.append(day(0))
        let checklist = try #require(try routinePage(snapshot(items: items, routines: [morning])).today)
        #expect(checklist.summary == "2 of 3 done \u{00B7} 1 skipped")
        #expect(checklist.finished == "All through for today.")
        // A skipped row has no tick; the sheet is where it unskips.
        let journal = try #require(checklist.rows.first { $0.item.title == "Journal" })
        #expect(journal.skipped)
        #expect(!journal.tickable)
        #expect(checklist.rows.allSatisfy { $0.meta == nil })
    }

    @Test func aRoutineWithNothingOnTodaySaysSo() throws {
        let sundays = Routine(id: "r-sun", name: "Sundays", itemIds: [uid(4)])
        let page = try routinePage(snapshot(items: routineItems, routines: [sundays]), "r-sun")
        let checklist = try #require(page.today)
        #expect(checklist.rows.isEmpty)
        #expect(checklist.summary == nil)
        #expect(checklist.empty == "Nothing from Sundays is on today.")
        #expect(page.otherDays.map(\.item.title) == ["Long run"])
    }

    @Test func anEmptyRoutineSaysNothingIsInIt() throws {
        let empty = Routine(id: "r-empty", name: "Wind down", itemIds: [uid(99)])
        let page = try routinePage(snapshot(items: routineItems, routines: [empty]), "r-empty")
        #expect(page.today == nil)
        #expect(page.otherDays.isEmpty)
        #expect(page.strip == nil)
        #expect(page.empty == "Nothing is in it yet.")
        #expect(page.chips.map(\.kind) == [.status])
    }

    @Test func aPausedRoutineSaysWhenItComesBack() throws {
        var paused = morning
        paused.pausedAt = "2026-09-20T15:00:00+00:00"
        paused.pausedUntil = "2026-10-30"
        let page = try routinePage(snapshot(items: routineItems, routines: [paused]))
        #expect(page.chips.last?.text == "Paused until Oct 30")
        #expect(page.chips.last?.systemImage == "pause.circle")
        #expect(page.statusNote == OrganizeCopy.routinePausedNote(paused))
        #expect(page.statusNote?.hasPrefix("Its items come back on Oct 30") == true)
        // Its open members leave today for "Other days", and each says why
        // beside its cadence, so "Daily" never stands there unexplained.
        let journal = try #require(page.otherDays.first { $0.item.title == "Journal" })
        #expect(journal.meta == cadenceLabel(routineItems[2]))
        #expect(journal.hiddenNote == "Hidden with Morning")
        #expect(journal.spokenLabel.contains("Hidden with Morning"))
        #expect(page.otherDays.allSatisfy { $0.hiddenNote != nil })
    }

    @Test func aRoutineHeldOffByASeasonSaysWhyUnderActive() throws {
        let winter = Season(id: "s-winter", name: "Winter", state: "paused", routineIds: ["r-morning"])
        let page = try routinePage(snapshot(items: routineItems, routines: [morning], seasons: [winter]))
        // Its own switch is on, so Status says Active, and the note says why
        // nothing shows.
        #expect(page.chips.last?.text == "Active")
        let note = try #require(page.statusNote)
        #expect(note.hasPrefix("\u{201C}Winter\u{201D} is off, so this routine isn\u{2019}t carrying anything"))
        #expect(page.heldBy.map(\.title) == ["Winter"])
        #expect(page.heldBy.map(\.trailing) == ["off"])
        #expect(page.heldBy.map(\.route) == [.container(.season, id: "s-winter")])
        #expect(page.heldByEmpty == nil)
        // Held off, what is still open leaves the day; what was done today
        // stays, as on the grid.
        #expect(page.today?.rows.map(\.item.title) == ["Meds"])
        #expect(page.today?.finished == "All through for today.")
    }

    @Test func heldByListsEveryHolderWithItsState() throws {
        let autumn = Season(id: "s-autumn", name: "Autumn", sortOrder: 0, routineIds: ["r-morning"])
        let ski = Season(id: "s-ski", name: "Ski", sortOrder: 1, startsOn: "2026-12-01", routineIds: ["r-morning"])
        let page = try routinePage(snapshot(items: routineItems, routines: [morning], seasons: [autumn, ski]))
        #expect(page.heldBy.map(\.title) == ["Autumn", "Ski"])
        #expect(page.heldBy.map(\.trailing) == ["on", "off until Dec 1"])
        #expect(page.heldBy.map(\.spokenLabel) == ["Autumn, season, on", "Ski, season, off until Dec 1"])
        #expect(page.statusNote == nil)
    }

    // MARK: The list's "2/3 today"

    @Test func aLiveRoutineRowCountsToday() throws {
        let s = snapshot(items: routineItems, routines: [morning])
        let row = OrganizeModel.routineRow(morning, s, liveItems: Set(s.items.map(\.id)))
        #expect(row.trailing == "1/3 today")
        #expect(row.spokenLabel.hasSuffix("1 of 3 done today"))
        // The tally is the checklist's: done over what is on, skips out.
        let checklist = try #require(try routinePage(s).today)
        #expect(row.trailing == "\(checklist.rows.filter(\.done).count)/\(checklist.rows.count) today")
    }

    @Test func aRoutineRowHasNoCountWhenNothingIsOnOrItIsOff() {
        let s = snapshot(items: routineItems, routines: [morning])
        let live = Set(s.items.map(\.id))
        let sundays = Routine(id: "r-sun", name: "Sundays", itemIds: [uid(4)])
        #expect(OrganizeModel.routineRow(sundays, s, liveItems: live).trailing == nil)
        var paused = morning
        paused.pausedAt = "2026-09-20T15:00:00+00:00"
        #expect(OrganizeModel.routineRow(paused, snapshot(items: routineItems, routines: [paused]),
                                         liveItems: live).trailing == nil)
        let winter = Season(id: "s-winter", name: "Winter", state: "paused", routineIds: ["r-morning"])
        let held = snapshot(items: routineItems, routines: [morning], seasons: [winter])
        #expect(OrganizeModel.routineRow(morning, held, liveItems: live).trailing == nil)
    }

    // MARK: A season's page

    private func seasonPage(_ s: OrganizeSnapshot, _ id: String) throws -> SeasonPage {
        guard case .page(let page)? = ContainerPageModel.seasonPage(id, s) else {
            Issue.record("no season page")
            throw PageMissing()
        }
        return page
    }

    @Test func aSeasonWithNoDatesIsAlwaysOn() throws {
        let evening = Routine(id: "r-evening", name: "Evening", sortOrder: 1, itemIds: [])
        // The payload's order puts Evening first and names a routine the
        // planner doesn't hold: the page keeps the routines' own order.
        let autumn = Season(id: "s-autumn", name: "Autumn", icon: "icon:Leaf", itemIds: [uid(3), uid(98)],
                            routineIds: ["r-evening", "r-gone", "r-morning"])
        let page = try seasonPage(snapshot(items: routineItems, routines: [morning, evening], seasons: [autumn]),
                                  "s-autumn")
        #expect(page.header.eyebrow == "SEASON")
        #expect(page.chips.map(\.text) == ["Dates"])
        #expect(page.chips.map(\.systemImage) == ["calendar.badge.clock"])
        #expect(page.stateNote == "Always on. Give it a start or an end to make it follow the calendar.")
        #expect(page.routines.map(\.title) == ["Morning", "Evening"])
        #expect(page.routines.map(\.route) == [.container(.routine, id: "r-morning"),
                                              .container(.routine, id: "r-evening")])
        #expect(page.routines.first?.trailing == "1/3 today")
        // Its own items, a trashed one skipped.
        #expect(page.items.map(\.item.title) == ["Journal"])
        #expect(page.items.map(\.meta) == ["Daily"])
        #expect(page.empty == nil)
        // Over its items and its routines' items.
        #expect(page.strip?.cells.last?.mark == .today(done: 1, of: 3))
    }

    @Test func aDatedSeasonShowsWhenItRuns() throws {
        let dated = Season(id: "s-dated", name: "Base", startsOn: "2026-09-01", endsOn: "2027-03-15")
        let page = try seasonPage(snapshot(items: [], seasons: [dated]), "s-dated")
        #expect(page.chips.map(\.text) == ["Dates", "Sep 1 to Mar 15"])
        #expect(page.chips.map(\.systemImage) == ["calendar.badge.clock", "calendar"])
        #expect(page.chips.last?.spoken == "Runs: Sep 1 to Mar 15")
        #expect(page.stateNote == "Runs Sep 1 to Mar 15, inclusive. On now.")
        #expect(page.empty == "Nothing is in it yet.")
        #expect(page.strip == nil)
    }

    @Test func onAndOffHideTheRange() throws {
        let on = Season(id: "s-on", name: "On", state: "active", startsOn: "2026-09-01", endsOn: "2026-09-10")
        let off = Season(id: "s-off", name: "Off", state: "paused", startsOn: "2026-09-01")
        let s = snapshot(items: [], seasons: [on, off])
        let onPage = try seasonPage(s, "s-on")
        #expect(onPage.chips.map(\.text) == ["On"])
        #expect(onPage.chips.map(\.systemImage) == ["play.circle"])
        let offPage = try seasonPage(s, "s-off")
        #expect(offPage.chips.map(\.text) == ["Off"])
        #expect(offPage.chips.map(\.systemImage) == ["pause.circle"])
        #expect(offPage.stateNote.hasPrefix("Off. Everything it holds is hidden"))
    }

    // MARK: Status menus (O8a)

    /// A routine's Status is a menu of verbs, as the item sheet's are: Pause
    /// and Pause until… while its own switch is on (a season holding it off
    /// included), Resume and Pause until… while it is paused. Pause until's
    /// picker starts tomorrow, on the routine's own return day when it has
    /// one.
    @Test func aRoutinesStatusIsAMenuOfVerbs() throws {
        let every = OrganizeModel.everyContainerWrite
        let live = try routinePage(snapshot(items: routineItems, routines: [morning], takes: every))
        let menu = try #require(live.statusMenu)
        #expect(menu.choices.map(\.label) == ["Pause", "Pause until\u{2026}"])
        #expect(menu.choices.map(\.action) == [.pause, .pauseUntil])
        #expect(menu.choices.map(\.systemImage) == ["pause", "calendar.badge.clock"])
        #expect(menu.selected == nil)
        #expect(menu.pauseUntil == PauseUntilPick(earliest: DayString("2026-10-02")!,
                                                  initial: DayString("2026-10-02")!))
        // The chip keeps saying the status; the menu is what it opens.
        #expect(live.chips.last?.text == "Active")

        var paused = morning
        paused.pausedAt = "2026-09-20T15:00:00+00:00"
        paused.pausedUntil = "2026-10-30"
        let away = try #require(try routinePage(snapshot(items: routineItems, routines: [paused], takes: every))
            .statusMenu)
        #expect(away.choices.map(\.label) == ["Resume", "Pause until\u{2026}"])
        #expect(away.choices.first?.systemImage == "play")
        #expect(away.pauseUntil?.initial == DayString("2026-10-30"))
        #expect(away.pauseUntil?.earliest == DayString("2026-10-02"))

        // Paused with no end: the picker starts tomorrow.
        paused.pausedUntil = nil
        let open = try #require(try routinePage(snapshot(items: routineItems, routines: [paused], takes: every))
            .statusMenu)
        #expect(open.pauseUntil?.initial == DayString("2026-10-02"))

        // Held off by a season, its own switch is on: Pause, not Resume.
        let winter = Season(id: "s-winter", name: "Winter", state: "paused", routineIds: ["r-morning"])
        let held = try #require(try routinePage(snapshot(items: routineItems, routines: [morning], seasons: [winter],
                                                         takes: every)).statusMenu)
        #expect(held.choices.first?.action == .pause)
    }

    /// The menu shows only where the server takes the write: none from a
    /// server older than the route, and none from one that lists only the
    /// other kind's action.
    @Test func aStatusMenuNeedsTheServersWrite() throws {
        let autumn = Season(id: "s-autumn", name: "Autumn", itemIds: [uid(3)])
        let none = snapshot(items: routineItems, routines: [morning], seasons: [autumn])
        #expect(try routinePage(none).statusMenu == nil)
        #expect(try seasonPage(none, "s-autumn").statusMenu == nil)

        let seasonOnly = snapshot(items: routineItems, routines: [morning], seasons: [autumn],
                                  takes: ContainerWrites(season: ["state"]))
        #expect(try routinePage(seasonOnly).statusMenu == nil)
        #expect(try seasonPage(seasonOnly, "s-autumn").statusMenu != nil)

        // The gate's switches: Organize for a routine or season, Goals for a
        // goal, asked beside the server's list.
        let every = OrganizeModel.everyContainerWrite
        let on = PlannerSettings(organizeEnabled: true, goalsEnabled: false)
        #expect(OrganizeModel.canEdit(.pause, on: .routine, takes: every, settings: on))
        #expect(OrganizeModel.canEdit(.state, on: .season, takes: every, settings: on))
        #expect(!OrganizeModel.canEdit(.pause, on: .season, takes: every, settings: on))
        #expect(!OrganizeModel.canEdit(.state, on: .goal, takes: ContainerWrites(goal: ["state"]), settings: on))
        let off = PlannerSettings(organizeEnabled: false, goalsEnabled: true)
        #expect(!OrganizeModel.canEdit(.pause, on: .routine, takes: every, settings: off))
        // Every write the phone sends, under each kind the route takes it on,
        // in the server's own order (lib/app-containers.ts CONTAINER_WRITES).
        #expect(OrganizeModel.everyContainerWrite == ContainerWrites(
            routine: ["pause", "usualTime", "notes", "rename", "icon", "color"],
            season: ["state", "dates", "notes", "rename", "icon", "color"],
            goal: ["state", "window", "why", "rename", "icon", "color"],
            project: ["notes", "rename", "icon", "color"]))
    }

    /// A season's Status is its three states, On, Off and Dates, the one it
    /// is in checked, each sent as picked. A stored state that is none of the
    /// three follows its dates, so Dates is checked.
    @Test func aSeasonsStatusIsItsThreeStates() throws {
        let every = OrganizeModel.everyContainerWrite
        let seasons = [Season(id: "s-on", name: "On", state: "active"), Season(id: "s-off", name: "Off", state: "paused"),
                       Season(id: "s-dates", name: "Dates", state: "auto"),
                       Season(id: "s-odd", name: "Odd", state: "someday")]
        let s = snapshot(items: [], seasons: seasons, takes: every)
        let on = try #require(try seasonPage(s, "s-on").statusMenu)
        #expect(on.choices.map(\.label) == ["On", "Off", "Dates"])
        #expect(on.choices.map(\.action) == [.state(.active), .state(.paused), .state(.auto)])
        #expect(on.choices.map(\.systemImage) == ["play.circle", "pause.circle", "calendar.badge.clock"])
        #expect(on.selected == .state(.active))
        #expect(on.pauseUntil == nil)
        #expect(try seasonPage(s, "s-off").statusMenu?.selected == .state(.paused))
        #expect(try seasonPage(s, "s-dates").statusMenu?.selected == .state(.auto))
        #expect(try seasonPage(s, "s-odd").statusMenu?.selected == .state(.auto))
    }

    // MARK: A goal's page

    /// Run a half: one milestone reached (Sep 20), the next one late (Sep
    /// 25), one ahead (Nov 1) and in an Off season, one dropped with no
    /// date; a Sunday check-in last done Sep 27; a habit and a book as
    /// supporting work.
    private var goalItems: [Item] {
        var reached = task(10, "Run 5K", status: "completed")
        reached.startDate = "2026-09-20"
        var late = task(11, "Run a 10K")
        late.startDate = "2026-09-25"
        var ahead = task(12, "Run 16K")
        ahead.startDate = "2026-11-01"
        let dropped = task(13, "Run a trail race", status: "cancelled")
        var checkin = habit(14, "Weekly review", days: [0])
        checkin.completedDates = ["2026-09-20", "2026-09-27"]
        let gym = habit(15, "Gym", done: [0], streak: 7)
        let book = Item(id: uid(16), type: "custom", customType: "book", title: "Born to Run", status: "pending")
        return [reached, late, ahead, dropped, checkin, gym, book]
    }

    private var half: Goal {
        return Goal(id: "g-half", name: "Run a half", why: "  The long runs are the best part.  ",
                    icon: "icon:Target", startsOn: "2026-09-01", targetOn: "2027-03-15",
                    memberIds: [uid(15), uid(16)], milestoneIds: [uid(12), uid(10), uid(13), uid(11)],
                    checkinIds: [uid(14)])
    }

    private var winter: Season {
        return Season(id: "s-winter", name: "Winter", state: "paused", itemIds: [uid(12)])
    }

    private var bookLabels: [String: ItemTypeLabel] {
        return ["book": ItemTypeLabel(name: "book", label: "Book", labelPlural: "Books")]
    }

    private func goalPage(_ s: OrganizeSnapshot, _ id: String = "g-half") throws -> GoalPage {
        guard case .page(let page)? = ContainerPageModel.goalPage(id, s) else {
            Issue.record("no goal page")
            throw PageMissing()
        }
        return page
    }

    @Test func aGoalsRingWhyCountdownAndChips() throws {
        let page = try goalPage(snapshot(items: goalItems, seasons: [winter], goals: [half], typeLabels: bookLabels))
        #expect(page.header.eyebrow == "GOAL")
        #expect(page.header.symbol == "target")
        // A dropped milestone leaves both sides.
        let ring = try #require(page.ring)
        #expect(abs(ring.fraction - 1.0 / 3.0) < 1e-9)
        #expect(ring.spokenLabel == "1 of 3 milestones reached")
        #expect(page.progress == "1/3")
        #expect(page.progressSpoken == "1 of 3 milestones reached")
        #expect(page.why == "The long runs are the best part.")
        #expect(page.countdown == "165 days to Mar 15")
        #expect(page.chips.map(\.text) == ["Active", "Started Sep 1 \u{00B7} Target Mar 15"])
        #expect(page.chips.map(\.systemImage) == ["play.circle", "calendar"])
        #expect(page.chips.last?.spoken == "Started Sep 1, Target Mar 15")
        #expect(page.elapsed == "15% of the way to Mar 15")
        #expect(page.endedNote == nil)
        #expect(page.windDown == nil)
    }

    @Test func theTimelineSaysWhereEachCheckpointStands() throws {
        let page = try goalPage(snapshot(items: goalItems, seasons: [winter], goals: [half], typeLabels: bookLabels))
        #expect(page.milestones.map(\.item.title) == ["Run 5K", "Run a 10K", "Run 16K", "Run a trail race"])
        #expect(page.milestones.map(\.state) == [.achieved, .next, .ahead, .dropped])
        #expect(page.milestones.map(\.caption) == [
            "Sep 20 \u{00B7} reached",
            "Sep 25 \u{00B7} next up \u{00B7} still ahead of you",
            "Nov 1",
            "No date yet \u{00B7} dropped",
        ])
        #expect(page.milestones.map(\.tickLabel) == [
            "Mark Run 5K not reached", "Mark Run a 10K reached", "Mark Run 16K reached",
            "Mark Run a trail race reached",
        ])
        // Hidden by an Off season, and said so: a quiet lie otherwise.
        #expect(page.milestones.map(\.hiddenNote) == [nil, nil, "Hidden with Winter", nil])
        #expect(page.milestones[1].spokenLabel == "Run a 10K, Sep 25, next up, still ahead of you")
        #expect(page.milestones[2].spokenLabel == "Run 16K, Nov 1, Hidden with Winter")
        #expect(page.milestonesEmpty == nil)
    }

    @Test func checkinsAndSupportingWork() throws {
        let page = try goalPage(snapshot(items: goalItems, seasons: [winter], goals: [half], typeLabels: bookLabels))
        #expect(page.checkins.map(\.item.title) == ["Weekly review"])
        #expect(page.checkins.map(\.meta) == ["Sun \u{00B7} last Sep 27"])
        // Not on a Thursday: it opens, it doesn't tick.
        #expect(page.checkins.map(\.tickable) == [false])
        #expect(page.checkinsEmpty == nil)
        #expect(page.groups.map(\.title) == ["Habits", "Books"])
        #expect(page.groups.map { $0.rows.map(\.item.title) } == [["Gym"], ["Born to Run"]])
        let gym = try #require(page.groups.first?.rows.first)
        #expect(gym.tickable)
        #expect(gym.done)
        #expect(gym.flame)
        #expect(gym.spokenLabel == "Gym, Daily, streak 7")
        #expect(page.groups.last?.rows.first?.meta == "No date")
        #expect(page.supportingEmpty == nil)
    }

    @Test func streaksOffHidesTheFlame() throws {
        let s = snapshot(streaks: false, items: goalItems, goals: [half])
        let gym = try #require(try goalPage(s).groups.first?.rows.first)
        #expect(!gym.flame)
        #expect(gym.spokenLabel == "Gym, Daily")
    }

    @Test func aGoalWithNothingUnderItSaysSo() throws {
        let bare = Goal(id: "g-bare", name: "Learn Spanish", startsOn: "2026-09-01", targetOn: "2027-03-15")
        let page = try goalPage(snapshot(items: [], goals: [bare]), "g-bare")
        #expect(page.ring == nil)
        #expect(page.progress == "No milestones yet")
        // Both dates, but nothing to measure: no time-elapsed line.
        #expect(page.elapsed == nil)
        #expect(page.milestonesEmpty == OrganizeCopy.noMilestonesYet)
        #expect(page.checkinsEmpty == OrganizeCopy.noCheckinYet)
        #expect(page.supportingEmpty == "Nothing else is filed under this goal yet.")
        #expect(page.chips.map(\.text) == ["Active", "Started Sep 1 \u{00B7} Target Mar 15"])
    }

    @Test func anEndedGoalShowsItsNoteAndWhatStillRepeats() throws {
        var achieved = half
        achieved.state = "achieved"
        achieved.achievedAt = "2026-09-30T12:00:00Z"
        let page = try goalPage(snapshot(items: goalItems, goals: [achieved]))
        #expect(page.countdown == nil)
        #expect(page.chips.first?.text == "Achieved")
        #expect(page.chips.first?.systemImage == "checkmark.circle")
        #expect(page.endedNote == "Achieved on Sep 30. Everything below is the record of how it went.")
        #expect(page.progress == "1/3")
        let windDown = try #require(page.windDown)
        #expect(windDown.sentence.hasPrefix("2 of its items still repeat on their own schedules."))
        #expect(windDown.rows.map(\.item.title) == ["Weekly review", "Gym"])
        // Display only: each opens its sheet, none ticks here.
        #expect(windDown.rows.allSatisfy { !$0.tickable })

        var setAside = half
        setAside.state = "abandoned"
        let aside = try goalPage(snapshot(items: goalItems, goals: [setAside]))
        #expect(aside.chips.first?.text == "Set aside")
        #expect(aside.endedNote?.hasPrefix("Set aside.") == true)
    }

    // MARK: A project's page

    private func projectPage(_ s: OrganizeSnapshot, _ id: String = "p-work") throws -> ProjectPage {
        guard case .page(let page)? = ContainerPageModel.projectPage(id, s) else {
            Issue.record("no project page")
            throw PageMissing()
        }
        return page
    }

    /// Filed under Work: one done under "work" lowercase, one open, a
    /// subtask (left out), and one dated today.
    private var projectItems: [Item] {
        return [
            task(20, "Standup", status: "completed", project: "work"),
            task(21, "Draft the plan", project: "Work"),
            task(22, "Pull the numbers", project: "Work", parent: uid(21)),
            task(23, "Ship it", project: "Work", on: 0),
            task(24, "Groceries", project: "Home"),
        ]
    }

    @Test func aProjectListsWhatItCountsOpenFirst() throws {
        let work = Project(id: "p-work", name: "Work", notes: " The day job. ")
        let page = try projectPage(snapshot(items: projectItems, projects: [work]))
        #expect(page.header.eyebrow == "PROJECT")
        #expect(page.items.map(\.item.title) == ["Draft the plan", "Ship it", "Standup"])
        #expect(page.chips.first?.text == "\(page.items.count) items")
        #expect(page.chips.map(\.kind) == [.items, .timeBlock])
        #expect(page.chips.last?.text == "No time block")
        #expect(page.notes == "The day job.")
        // Only Ship it is on a day in range: today, still due.
        #expect(page.items.map(\.tickable) == [false, true, false])
        #expect(page.strip?.cells.last?.mark == .today(done: 0, of: 1))
        #expect(page.empty == nil)
    }

    @Test func aProjectsTimeBlockIsReadOnly() throws {
        let block = Project(id: "p-work", name: "Work", repeatFrequency: "weekdays", timeBucket: "evening",
                            startTime: "18:00", duration: 60)
        let page = try projectPage(snapshot(items: projectItems, projects: [block]))
        #expect(page.chips.last?.text == "Weekdays \u{00B7} 6pm\u{2013}7pm")
        #expect(page.chips.last?.spoken == "Time block: Weekdays, 6pm to 7pm")
        #expect(page.chips.last?.systemImage == "clock")
    }

    @Test func anEmptyProjectHasNoStrip() throws {
        let garden = Project(id: "p-empty", name: "Garden")
        let page = try projectPage(snapshot(items: projectItems, projects: [garden]), "p-empty")
        #expect(page.items.isEmpty)
        #expect(page.chips.first?.text == "0 items")
        #expect(page.strip == nil)
        #expect(page.empty == "Nothing is in it yet.")
    }

    // MARK: Edits (O8b, O9)

    /// A routine's usual time chip opens its sheet where the page may write
    /// it. With none stored it says so there, and says nothing where it may
    /// not. The wheel starts on the stored time, else 9:00 am.
    @Test func aRoutinesUsualTimeChipOpensItsSheet() throws {
        let every = OrganizeModel.everyContainerWrite
        let page = try routinePage(snapshot(items: routineItems, routines: [morning], takes: every))
        #expect(page.chips.map(\.text) == ["Usually 7:00 am", "Active"])
        #expect(page.chips.map(\.edits) == [true, false])
        #expect(page.usualTime == UsualTimeEdit(stored: "07:00", initial: "07:00"))
        #expect(try routinePage(snapshot(items: routineItems, routines: [morning])).chips.first?.edits == false)

        var bare = morning
        bare.usualTime = nil
        let unset = try routinePage(snapshot(items: routineItems, routines: [bare], takes: every))
        #expect(unset.chips.map(\.text) == ["No usual time", "Active"])
        #expect(unset.chips.first?.spoken == "No usual time")
        #expect(unset.chips.first?.edits == true)
        #expect(unset.usualTime == UsualTimeEdit(stored: nil, initial: "09:00"))
        let readOnly = try routinePage(snapshot(items: routineItems, routines: [bare]))
        #expect(readOnly.chips.map(\.text) == ["Active"])
        #expect(readOnly.usualTime == nil)
    }

    /// A season's Runs chip opens its sheet under Dates alone, reading "Runs"
    /// with no dates; On and Off still hide it. A goal's window chip reads
    /// "Target" with none. Neither shows where it may not be set.
    @Test func aRangeChipOpensItsSheetWhereItMayBeSet() throws {
        let every = OrganizeModel.everyContainerWrite
        let bare = Season(id: "s-bare", name: "Bare")
        let dated = Season(id: "s-dated", name: "Base", startsOn: "2026-09-01", endsOn: "2027-03-15")
        let on = Season(id: "s-on", name: "On", state: "active", startsOn: "2026-09-01")
        let s = snapshot(items: [], seasons: [bare, dated, on], takes: every)
        let barePage = try seasonPage(s, "s-bare")
        #expect(barePage.chips.map(\.text) == ["Dates", "Runs"])
        #expect(barePage.chips.map(\.edits) == [false, true])
        #expect(barePage.runs == RangeEdit(ref: ContainerRef(kind: .season, id: "s-bare"),
                                           words: ContainerEditModel.runsWords, start: nil, end: nil))
        let datedPage = try seasonPage(s, "s-dated")
        #expect(datedPage.chips.last?.text == "Sep 1 to Mar 15")
        #expect(datedPage.chips.last?.edits == true)
        #expect(datedPage.runs?.draft == RangeDraft(start: DayString("2026-09-01"), end: DayString("2027-03-15")))
        let onPage = try seasonPage(s, "s-on")
        #expect(onPage.chips.map(\.text) == ["On"])
        #expect(onPage.runs == nil)
        #expect(try seasonPage(snapshot(items: [], seasons: [bare]), "s-bare").chips.map(\.text) == ["Dates"])

        var open = half
        open.startsOn = nil
        open.targetOn = nil
        let goal = try goalPage(snapshot(items: goalItems, goals: [open], takes: every))
        #expect(goal.chips.map(\.text) == ["Active", "Target"])
        #expect(goal.chips.last?.edits == true)
        #expect(goal.window?.words == ContainerEditModel.windowWords)
        #expect(goal.window?.draft == RangeDraft(start: nil, end: nil))
        #expect(try goalPage(snapshot(items: goalItems, goals: [open])).chips.map(\.text) == ["Active"])
        let window = try #require(try goalPage(snapshot(items: goalItems, goals: [half], takes: every)).window)
        #expect(window.draft == RangeDraft(start: DayString("2026-09-01"), end: DayString("2027-03-15")))
        #expect(ContainerEditModel.chipHint(.usualTime) == "Edits the usual time")
        #expect(ContainerEditModel.chipHint(.runs) == "Edits when it runs")
        #expect(ContainerEditModel.chipHint(.window) == "Edits the window")
        #expect(ContainerEditModel.chipHint(.items) == nil)
    }

    /// A goal's Status is its three states, the one it is in checked, behind
    /// Goals and the server's `state`. A stored state that is none of the
    /// three is ended, as the web's ended note reads it, so Set aside is
    /// checked.
    @Test func aGoalsStatusIsItsThreeStates() throws {
        let every = OrganizeModel.everyContainerWrite
        let menu = try #require(try goalPage(snapshot(items: goalItems, goals: [half], takes: every)).statusMenu)
        #expect(menu.choices.map(\.label) == ["Active", "Achieved", "Set aside"])
        #expect(menu.choices.map(\.action) == [.goalState(.active), .goalState(.achieved), .goalState(.abandoned)])
        #expect(menu.choices.map(\.systemImage) == ["play.circle", "checkmark.circle", "pause.circle"])
        #expect(menu.selected == .goalState(.active))
        #expect(menu.pauseUntil == nil)
        var achieved = half
        achieved.state = "achieved"
        var odd = half
        odd.state = "someday"
        #expect(try goalPage(snapshot(items: goalItems, goals: [achieved], takes: every)).statusMenu?.selected
            == .goalState(.achieved))
        #expect(try goalPage(snapshot(items: goalItems, goals: [odd], takes: every)).statusMenu?.selected
            == .goalState(.abandoned))
        #expect(try goalPage(snapshot(items: goalItems, goals: [half])).statusMenu == nil)
        #expect(try goalPage(snapshot(items: goalItems, goals: [half], takes: ContainerWrites(goal: ["window"])))
            .statusMenu == nil)
    }

    /// Each page carries its notes sheet (a goal's why) and its ⋯ menu where
    /// the server takes the writes and the kind's switch is on; none from an
    /// older server. A project's glyph is its `emoji`, and its rename knows
    /// the other live projects.
    @Test func eachPageCarriesItsNotesAndMenu() throws {
        let every = OrganizeModel.everyContainerWrite
        let work = Project(id: "p-work", name: "Work", color: "var(--accent-2)", emoji: "icon:Briefcase",
                           notes: "The day job.")
        let home = Project(id: "p-home", name: "Home")
        let autumn = Season(id: "s-autumn", name: "Autumn", icon: "icon:Leaf", notes: "Leaves")
        let s = snapshot(items: routineItems + projectItems, routines: [morning], seasons: [autumn], goals: [half],
                         projects: [work, home], takes: every)

        let routine = try #require(try routinePage(s).edits)
        let ref = ContainerRef(kind: .routine, id: "r-morning")
        #expect(routine.ref == ref)
        #expect(routine.notes == NotesEdit(ref: ref, stored: "  Meds first.  ", title: "Routine note",
                                           placeholder: "Add a note\u{2026}", hint: "Edits the note", tooLong: false))
        #expect(routine.rename == RenameEdit(ref: ref, name: "Morning", title: "Rename routine", siblings: []))
        #expect(routine.hasMenu)
        let look = try #require(routine.look)
        #expect(look.glyph == "icon:Sunrise")
        #expect(look.color == "var(--accent-6)")
        #expect(look.menuLabel == "Icon and color\u{2026}")
        #expect(look.title == "Icon and color")
        #expect(look.icons.map(\.name) == ContainerLook.featured)
        #expect(look.icons.allSatisfy { ContainerLook.lucideToSymbol[$0.name] == $0.symbol })
        #expect(look.colors.map(\.label) == ["Moss", "Teal", "Indigo", "Plum", "Coral", "Honey", "Slate", "Lime",
                                             "Auto"])
        #expect(look.colors.map(\.token) == ContainerLook.ramp + [nil])

        let season = try #require(try seasonPage(s, "s-autumn").edits)
        #expect(season.notes?.title == "Season note")
        #expect(season.notes?.stored == "Leaves")
        #expect(season.rename?.title == "Rename season")
        #expect(season.look?.glyph == "icon:Leaf")

        let goal = try #require(try goalPage(s).edits)
        #expect(goal.notes?.title == "Why this goal matters")
        #expect(goal.notes?.placeholder == "Why this matters\u{2026}")
        #expect(goal.notes?.hint == "Edits why this goal matters")
        #expect(goal.notes?.stored == "  The long runs are the best part.  ")
        #expect(goal.rename?.title == "Rename goal")

        let project = try #require(try projectPage(s).edits)
        #expect(project.notes?.title == "Project note")
        #expect(project.rename?.siblings == [work, home])
        #expect(project.look?.glyph == "icon:Briefcase")
        #expect(project.look?.color == "var(--accent-2)")

        let none = snapshot(items: routineItems + projectItems, routines: [morning], seasons: [autumn],
                            goals: [half], projects: [work])
        let pages: [PageEdits?] = [try routinePage(none).edits, try seasonPage(none, "s-autumn").edits,
                                   try goalPage(none).edits, try projectPage(none).edits]
        for edits in pages {
            #expect(edits?.notes == nil)
            #expect(edits?.rename == nil)
            #expect(edits?.look == nil)
            #expect(edits?.hasMenu == false)
        }

        // A server that takes one half of the look: the row and the sheet
        // say which.
        let colourOnly = try #require(try projectPage(snapshot(items: [], projects: [work],
                                                               takes: ContainerWrites(project: ["color"]))).edits?.look)
        #expect(colourOnly.icons.isEmpty)
        #expect(colourOnly.menuLabel == "Color\u{2026}")
        #expect(colourOnly.title == "Color")
        let iconOnly = try #require(try projectPage(snapshot(items: [], projects: [work],
                                                             takes: ContainerWrites(project: ["icon"]))).edits?.look)
        #expect(iconOnly.colors.isEmpty)
        #expect(iconOnly.menuLabel == "Icon\u{2026}")
        #expect(iconOnly.title == "Icon")

        // Too long to send: shown, and never edited.
        var long = morning
        long.notes = String(repeating: "a", count: EditLimits.outerNotes + 1)
        let tooLong = try routinePage(snapshot(items: routineItems, routines: [long], takes: every))
        #expect(tooLong.edits?.notes?.tooLong == true)
    }

    /// Done on the notes sheet sends them cleaned (`cleanNotes`), as `notes`
    /// or a goal's `why`, and nothing when that is what is stored; typing past
    /// what one request may carry is cut from what was put in.
    @Test func notesSendCleanedAndOnlyWhenMoved() {
        #expect(ContainerEditModel.notesIntent("  Kettle first. \n", kind: .routine, stored: nil)
            == .notes("Kettle first."))
        #expect(ContainerEditModel.notesIntent("To finish one", kind: .goal, stored: nil) == .why("To finish one"))
        #expect(ContainerEditModel.notesIntent("   ", kind: .project, stored: "Old") == .notes(nil))
        #expect(ContainerEditModel.notesIntent(" Same ", kind: .season, stored: "Same") == nil)
        #expect(ContainerEditModel.notesIntent("", kind: .season, stored: nil) == nil)
        let full = String(repeating: "a", count: EditLimits.outerNotes)
        #expect(ContainerEditModel.notesEntry(previous: full, next: full + "b") == full)
        #expect(ContainerEditModel.notesEntry(previous: "a", next: "ab") == "ab")
        #expect(ContainerEditModel.notesTitle(.project) == "Project note")
    }

    /// Rename's Save: off while the name cleans to nothing and, on a project,
    /// while another live project's name folds to it; a project changing only
    /// its own case may save. An unchanged name sends nothing, and other
    /// kinds' names may repeat.
    @Test func renameSavesACleanNameNoOtherProjectHolds() {
        let work = Project(id: "p-work", name: "Work")
        let home = Project(id: "p-home", name: "Home")
        let project = RenameEdit(ref: ContainerRef(kind: .project, id: "p-work"), name: "Work",
                                 title: "Rename project", siblings: [work, home])
        #expect(!ContainerEditModel.canSaveRename("   ", project))
        #expect(!ContainerEditModel.canSaveRename("\n", project))
        #expect(!ContainerEditModel.canSaveRename(" home ", project))
        #expect(ContainerEditModel.canSaveRename("WORK", project))
        #expect(ContainerEditModel.renameIntent("WORK", stored: "Work") == .rename("WORK"))
        #expect(ContainerEditModel.renameIntent(" Work ", stored: "Work") == nil)
        #expect(ContainerEditModel.renameIntent("\n", stored: "Work") == nil)
        #expect(ContainerEditModel.renameIntent("Day\njob", stored: "Work") == .rename("Day job"))
        #expect(ContainerEditModel.renamedName("  Office  ") == "Office")

        let routine = RenameEdit(ref: ContainerRef(kind: .routine, id: "r-morning"), name: "Morning",
                                 title: "Rename routine", siblings: [])
        #expect(ContainerEditModel.canSaveRename("Home", routine))
        #expect(ContainerEditModel.renameTitle(.season) == "Rename season")
        #expect(ContainerEditModel.renameTitle(.goal) == "Rename goal")
        #expect(ContainerEditModel.renameTitle(.project) == "Rename project")
    }

    /// The look sheet checks the stored token exactly, draws the draft, and
    /// sends only what moved: the icon, then the colour. Auto clears the
    /// colour. A half the server doesn't take is never sent.
    @Test func theLookSheetSendsOnlyWhatMoved() {
        let icons = ContainerLook.featured.map { ContainerEditModel.iconChoice($0, kind: .routine) }
        let edit = LookEdit(ref: ContainerRef(kind: .routine, id: "r-morning"), name: "Morning",
                            glyph: "icon:Sunrise", color: "var(--accent-6)", icons: icons,
                            colors: ContainerEditModel.colorChoices)
        let stored = LookDraft(glyph: edit.glyph, color: edit.color)
        #expect(ContainerEditModel.lookIntents(edit, stored).isEmpty)
        // Sunrise isn't a featured icon, so no cell is checked.
        #expect(!edit.icons.contains { ContainerEditModel.isPicked($0, stored) })
        #expect(edit.colors.filter { ContainerEditModel.isPicked($0, stored) }.map(\.label) == ["Honey"])

        var draft = stored
        draft.glyph = ContainerLook.iconToken("Leaf")
        draft.color = nil
        #expect(ContainerEditModel.lookIntents(edit, draft) == [.icon("icon:Leaf"), .color(nil)])
        #expect(edit.icons.filter { ContainerEditModel.isPicked($0, draft) }.map(\.name) == ["Leaf"])
        #expect(edit.colors.filter { ContainerEditModel.isPicked($0, draft) }.map(\.label) == ["Auto"])
        let preview = ContainerEditModel.preview(edit, draft)
        #expect(preview.symbol == ContainerLook.lucideToSymbol["Leaf"])
        #expect(preview.accent.token == containerAccent(nil, name: "Morning").token)

        let colourOnly = LookEdit(ref: edit.ref, name: "Morning", glyph: "icon:Sunrise", color: "var(--accent-6)",
                                  icons: [], colors: ContainerEditModel.colorChoices)
        #expect(ContainerEditModel.lookIntents(colourOnly, draft) == [.color(nil)])
        #expect(ContainerEditModel.spokenIconName("HeartPulse") == "Heart pulse")
        #expect(ContainerEditModel.spokenIconName("Gamepad2") == "Gamepad 2")
        #expect(ContainerEditModel.spokenIconName("Leaf") == "Leaf")
        #expect(ContainerEditModel.iconChoice("Leaf", kind: .season).spoken == "Leaf")
    }

    /// A range's draft never inverts: an end switched on starts at today or at
    /// the start, a start at today or at the end, and a pick past the other
    /// end stops there. The Runs sheet says what the draft will do.
    @Test func aRangeDraftNeverInverts() {
        let end = DayString("2026-10-20")!
        var draft = ContainerEditModel.settingEnd(RangeDraft(start: nil, end: nil), on: true, today: today)
        #expect(draft == RangeDraft(start: nil, end: today))
        draft = ContainerEditModel.pickingEnd(draft, end)
        draft = ContainerEditModel.settingStart(draft, on: true, today: today)
        #expect(draft == RangeDraft(start: today, end: end))
        draft = ContainerEditModel.pickingStart(draft, DayString("2026-10-25")!)
        #expect(draft.start == end)
        draft = ContainerEditModel.pickingEnd(draft, DayString("2026-10-05")!)
        #expect(draft.end == end)
        #expect(ContainerEditModel.settingStart(draft, on: false, today: today) == RangeDraft(start: nil, end: end))
        #expect(ContainerEditModel.settingEnd(draft, on: false, today: today) == RangeDraft(start: end, end: nil))
        let early = RangeDraft(start: nil, end: DayString("2026-09-15"))
        #expect(ContainerEditModel.settingStart(early, on: true, today: today).start == DayString("2026-09-15"))
        let late = RangeDraft(start: DayString("2026-11-01"), end: nil)
        #expect(ContainerEditModel.settingEnd(late, on: true, today: today).end == DayString("2026-11-01"))

        let autumn = Season(id: "s-autumn", name: "Autumn", state: "paused")
        let runs = RangeEdit(ref: ContainerRef(kind: .season, id: "s-autumn"), words: ContainerEditModel.runsWords,
                             start: nil, end: nil)
        #expect(ContainerEditModel.rangeNote(runs, runs.draft, season: autumn, today: today)
            == "Always on. Give it a start or an end to make it follow the calendar.")
        let dated = RangeDraft(start: DayString("2026-09-01"), end: DayString("2027-03-15"))
        #expect(ContainerEditModel.rangeNote(runs, dated, season: autumn, today: today)
            == "Runs Sep 1 to Mar 15, inclusive. On now.")
        #expect(ContainerEditModel.rangeNote(runs, late, season: autumn, today: today)?
            .hasSuffix("Off right now. Nothing it holds is showing.") == true)
        let window = RangeEdit(ref: ContainerRef(kind: .goal, id: "g-half"), words: ContainerEditModel.windowWords,
                               start: nil, end: nil)
        #expect(ContainerEditModel.rangeNote(window, dated, season: autumn, today: today) == nil)
    }

    // MARK: Switched off, and gone

    @Test func switchedOffPagesSayTheWebsSentence() {
        let s = snapshot(organize: false, goalsOn: false, items: routineItems, routines: [morning],
                         seasons: [Season(id: "s-a", name: "A")], goals: [half],
                         projects: [Project(id: "p-work", name: "Work")])
        #expect(ContainerPageModel.routinePage("r-morning", s) == .switchedOff(OrganizeCopy.organizeOff))
        #expect(ContainerPageModel.seasonPage("s-a", s) == .switchedOff(OrganizeCopy.organizeOff))
        #expect(ContainerPageModel.goalPage("g-half", s) == .switchedOff(OrganizeCopy.goalsOff))
        #expect(ContainerPageModel.routinePage("r-morning", s)?.title == nil)
        // A project's page is ungated, as on the web.
        #expect(ContainerPageModel.projectPage("p-work", s)?.title == "Work")
    }

    @Test func aGoneContainerHasNoPage() {
        let s = snapshot(items: routineItems, routines: [morning], goals: nil)
        #expect(ContainerPageModel.routinePage("r-gone", s) == nil)
        #expect(ContainerPageModel.seasonPage("s-gone", s) == nil)
        #expect(ContainerPageModel.goalPage("g-half", s) == nil)
        #expect(ContainerPageModel.projectPage("p-gone", s) == nil)
        // The one lookup a route's page and a container write share.
        let planner = makePlanner()
        let morningRef = ContainerRef(kind: .routine, id: "sample-morning-routine")
        #expect(planner.container(morningRef)?.id == "sample-morning-routine")
        #expect(planner.container(.routine, id: "sample-morning-routine") == planner.container(morningRef))
        #expect(planner.container(ContainerRef(kind: .routine, id: "r-gone")) == nil)
    }

    // MARK: The sample planner

    private func makePlanner() -> SamplePlanner {
        SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
    }

    @Test func theSamplesMorningRoutineTicksFromItsPage() throws {
        let planner = makePlanner()
        guard case .page(let page)? = planner.routinePage("sample-morning-routine") else {
            Issue.record("no page")
            return
        }
        #expect(page.notes == "Before the phone. Meds first, then the rest in order.")
        let checklist = try #require(page.today)
        #expect(checklist.rows.map(\.item.title) == ["Meds", "Stretch 10 min", "Journal"])
        #expect(checklist.summary == "2 of 3 done")
        let journal = try #require(checklist.rows.last)
        #expect(journal.meta == "next")

        planner.toggle(journal.item.id, on: planner.today)
        guard case .page(let after)? = planner.routinePage("sample-morning-routine") else {
            Issue.record("no page")
            return
        }
        #expect(after.today?.summary == "3 of 3 done")
        #expect(after.today?.finished == "All through for today.")
        #expect(after.strip?.cells.last?.mark == .today(done: 3, of: 3))
        // Today's tab agrees: the same write.
        #expect(isRowDone(try #require(planner.item(journal.item.id)), on: planner.today))
    }

    @Test func theSamplesNextMilestoneTicksFromItsNode() throws {
        let planner = makePlanner()
        guard case .page(let page)? = planner.goalPage("sample-half-marathon") else {
            Issue.record("no page")
            return
        }
        let next = try #require(page.milestones.first { $0.state == .next })
        #expect(next.item.title == "Run a 10K")
        // A milestone is one-shot: its node ticks on today, whatever its date.
        #expect(planner.canTick(next.item.id, on: planner.today))
        planner.toggle(next.item.id, on: planner.today)
        guard case .page(let after)? = planner.goalPage("sample-half-marathon") else {
            Issue.record("no page")
            return
        }
        #expect(after.milestones.first { $0.item.id == next.item.id }?.state == .achieved)
        #expect(after.progress == "2/3")
    }

    @Test func theSamplesProjectsAndGonePages() throws {
        let planner = makePlanner()
        let writing = try #require(planner.projectRecords.first { $0.name == "Writing" })
        guard case .page(let writingPage)? = planner.projectPage(writing.id) else {
            Issue.record("no Writing page")
            return
        }
        #expect(writingPage.chips.map(\.text) == ["1 item", "Weekdays \u{00B7} 6:30am\u{2013}7:30am"])
        let work = try #require(planner.projectRecords.first { $0.name == "Work" })
        guard case .page(let workPage)? = planner.projectPage(work.id) else {
            Issue.record("no Work page")
            return
        }
        #expect(workPage.notes == "The day job. Anything with a deadline from someone else goes here.")
        #expect(workPage.items.count == 4)
        #expect(workPage.chips.first?.text == "4 items")
        #expect(!planner.isGone(.container(.routine, id: "sample-morning-routine")))
        #expect(!planner.isGone(.container(.goal, id: "sample-half-marathon")))
        #expect(planner.isGone(.container(.season, id: "s-gone")))
    }

    /// A fetch that could not read goals (`goals` nil) is a lost read, not a
    /// delete: the goal's page stays, drawing what it last showed. A fetch
    /// that read goals without it is a delete, and the page goes.
    @Test func aFetchWithoutGoalsKeepsAGoalsPage() {
        let planner = makePlanner()
        let goal = OrganizeRoute.container(.goal, id: "sample-half-marathon")
        func fetched(goals: [Goal]?) {
            planner.apply(PlannerPayload(userId: UUID(), fetchedAt: "now", settings: planner.settings,
                                         items: planner.items, projects: planner.projectRecords,
                                         routines: planner.routines, seasons: planner.seasons, goals: goals))
        }
        fetched(goals: nil)
        #expect(planner.goalPage("sample-half-marathon") == nil)
        #expect(!planner.isGone(goal))
        fetched(goals: [])
        #expect(planner.isGone(goal))
    }

    // MARK: Words

    @Test func noPageSaysMissedOverdueOrAnEmDash() throws {
        var words: [String] = []
        func row(_ r: MemberRow) { words += [r.meta, r.hiddenNote, r.spokenLabel].compactMap { $0 } }
        func strip(_ s: DayStrip?) {
            guard let s else { return }
            words += s.cells.map(\.spokenLabel) + [s.firstLabel]
        }
        func chips(_ c: [PageChip]) { words += c.flatMap { [$0.text, $0.spoken] } }

        let routine = try routinePage(snapshot(items: routineItems, routines: [morning],
                                               takes: OrganizeModel.everyContainerWrite))
        chips(routine.chips)
        words += (routine.statusMenu?.choices ?? []).map(\.label)
        words += [routine.statusNote, routine.heldByEmpty, routine.empty, routine.today?.summary,
                  routine.today?.empty, routine.today?.finished].compactMap { $0 }
        routine.today?.rows.forEach(row)
        routine.otherDays.forEach(row)
        strip(routine.strip)

        let base = Season(id: "s", name: "S", startsOn: "2026-09-01", routineIds: ["r-morning"])
        let season = try seasonPage(snapshot(items: routineItems, routines: [morning], seasons: [base],
                                             takes: OrganizeModel.everyContainerWrite), "s")
        chips(season.chips)
        words += (season.statusMenu?.choices ?? []).map(\.label)
        words += [season.stateNote] + [season.empty].compactMap { $0 }
        strip(season.strip)

        var ended = half
        ended.state = "achieved"
        for goal in [half, ended] {
            let page = try goalPage(snapshot(items: goalItems, seasons: [winter], goals: [goal]))
            chips(page.chips)
            words += [page.why, page.countdown, page.endedNote, page.elapsed, page.progress, page.progressSpoken,
                      page.ring?.spokenLabel, page.windDown?.sentence, page.milestonesEmpty, page.checkinsEmpty,
                      page.supportingEmpty].compactMap { $0 }
            words += page.milestones.flatMap { [$0.caption, $0.spokenLabel, $0.tickLabel] }
            page.checkins.forEach(row)
            page.groups.flatMap(\.rows).forEach(row)
            page.windDown?.rows.forEach(row)
        }

        let project = try projectPage(snapshot(items: projectItems, projects: [Project(id: "p-work", name: "Work")]))
        chips(project.chips)
        project.items.forEach(row)
        strip(project.strip)

        words += [ContainerPageModel.heldByTitle, ContainerPageModel.todayTitle, ContainerPageModel.otherDaysTitle,
                  ContainerPageModel.itemsTitle, ContainerPageModel.milestonesTitle,
                  ContainerPageModel.checkinsTitle, ContainerPageModel.supportingTitle,
                  ContainerPageModel.stripTitle, ContainerPageModel.legendDone,
                  ContainerPageModel.legendNothingRecorded, ContainerPageModel.legendToday,
                  ContainerPageModel.noTimeBlock, ContainerPageModel.openHint,
                  ContainerPageModel.tickName(done: true), ContainerPageModel.tickName(done: false),
                  ContainerPageModel.statusHint, ContainerPageModel.routinePauseUntilWords.title,
                  ContainerPageModel.routinePauseUntilWords.confirmVerb,
                  ContainerPageModel.routinePauseUntilWords.note ?? "", OrganizeCopy.pauseRefused,
                  ShelfPageModel.resumeNow, ShelfPageModel.turnOnNow]

        // O8b and O9: the editors' words, the goal's Status, and the rename
        // refusals.
        let goalMenu = try goalPage(snapshot(items: goalItems, goals: [half],
                                             takes: OrganizeModel.everyContainerWrite)).statusMenu
        words += (goalMenu?.choices ?? []).map(\.label)
        var unset = morning
        unset.usualTime = nil
        chips(try routinePage(snapshot(items: routineItems, routines: [unset],
                                       takes: OrganizeModel.everyContainerWrite)).chips)
        words += [ContainerEditModel.moreLabel, ContainerEditModel.renameWord, ContainerEditModel.lookBoth,
                  ContainerEditModel.lookIconOnly, ContainerEditModel.lookColorOnly, ContainerEditModel.lookTitle,
                  ContainerEditModel.iconSection, ContainerEditModel.colorSection, ContainerEditModel.automatic,
                  ContainerEditModel.nameField, ContainerEditModel.saveWord, ContainerEditModel.notePlaceholder,
                  ContainerEditModel.whyPlaceholder, ContainerEditModel.notesHint, ContainerEditModel.whyHint,
                  ContainerEditModel.usualTimeTitle, ContainerEditModel.clearTime, ContainerEditModel.noUsualTime,
                  ContainerEditModel.usualTimeHint, ContainerEditModel.usualTimeNote,
                  OrganizeCopy.nameTakenSentence(noun: "project", name: "Work"),
                  OrganizeCopy.nameInTrashSentence(noun: "project", name: "Work")]
        for range in [ContainerEditModel.runsWords, ContainerEditModel.windowWords] {
            words += [range.title, range.startLabel, range.endLabel, range.empty, range.hint]
        }
        words += OrganizeKind.allCases.flatMap { [ContainerEditModel.renameTitle($0), ContainerEditModel.notesTitle($0)] }
        words += ContainerEditModel.colorChoices.map(\.label)
        words += ContainerLook.featured.map { ContainerEditModel.spokenIconName($0) }

        #expect(words.count > 50)
        for word in words {
            #expect(!word.contains("\u{2014}"), "em dash in \(word)")
            #expect(!word.lowercased().contains("missed"), "missed in \(word)")
            #expect(!word.lowercased().contains("overdue"), "overdue in \(word)")
        }
    }
}
