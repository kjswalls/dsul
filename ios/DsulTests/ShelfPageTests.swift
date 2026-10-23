import DsulCore
import Foundation
import Testing
@testable import Dsul

/// Organize's summary cards and footer (OrganizeModel, O4, O5, O14) and the
/// footer's pages (ShelfPageModel), on Thursday 2026-10-01: when each card
/// and row shows, what it says and counts, and where it leads; the Paused
/// page's groups, rows and Resume gate; a paused routine's detail; the Item
/// types count by `typeName`; and the Trash's row words. The words under them
/// are DsulCore's ports, pinned against the web by their own fixtures; these
/// pin how the phone puts them together.
@MainActor
@Suite struct ShelfPageTests {
    private let today = DayString("2026-10-01")!
    private let zone = "America/New_York"
    private let pausedSince = "2026-09-20T15:00:00+00:00"

    private func uid(_ n: Int) -> UUID {
        return UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", n))!
    }

    private func habit(_ n: Int, _ title: String, pausedUntil: String? = nil, paused: Bool = false) -> Item {
        return Item(id: uid(n), type: "habit", title: title, status: "pending", timeBucket: "morning",
                    repeatFrequency: "daily", pausedAt: paused ? pausedSince : nil, pausedUntil: pausedUntil,
                    streak: 0)
    }

    private var bookType: ItemTypeLabel {
        ItemTypeLabel(name: "book", label: "Book to read", labelPlural: "Books to read")
    }

    /// Stretch, paused until tomorrow; Read and Floss, in Evening, a routine
    /// paused until Oct 30; Call the bank, a task paused with no end; Piranesi,
    /// a custom item (a book) paused with no end; and Meds, live.
    private var shelfItems: [Item] {
        return [
            habit(1, "Stretch", pausedUntil: "2026-10-02", paused: true),
            habit(2, "Read"),
            habit(3, "Floss"),
            Item(id: uid(4), type: "task", title: "Call the bank", status: "pending", pausedAt: pausedSince,
                 isScheduled: false),
            Item(id: uid(5), type: "custom", customType: "book", title: "Piranesi", status: "pending",
                 pausedAt: pausedSince, isScheduled: false),
            habit(6, "Meds"),
        ]
    }

    private var evening: Routine {
        Routine(id: "r-evening", name: "Evening", icon: "icon:Moon", color: "var(--accent-4)", sortOrder: 0,
                pausedAt: pausedSince, pausedUntil: "2026-10-30", itemIds: [uid(2), uid(3)])
    }

    private func snapshot(organize: Bool = true, goalsOn: Bool = true, items: [Item] = [],
                          routines: [Routine] = [], goals: [Goal]? = nil, itemTypes: [ItemTypeLabel]? = [],
                          trash: Bool = false) -> OrganizeSnapshot {
        let labels = Dictionary((itemTypes ?? []).map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        return OrganizeSnapshot(settings: PlannerSettings(weekStartDay: .monday, organizeEnabled: organize,
                                                          goalsEnabled: goalsOn),
                                today: today, timeZone: zone, items: items, routines: routines, goals: goals,
                                typeLabels: labels, itemTypes: itemTypes, trashOffered: trash)
    }

    private var shelfSnapshot: OrganizeSnapshot {
        return snapshot(items: shelfItems, routines: [evening], itemTypes: [bookType])
    }

    // MARK: Summary cards (O4)

    @Test func theWeekCardSaysDoneOutOfDoneOrDue() throws {
        let water = Item(id: uid(1), type: "habit", title: "Water", status: "pending", startDate: "2026-09-01",
                         timeBucket: "anytime", repeatFrequency: "daily", streak: 1,
                         completedDates: ["2026-09-29", "2026-10-01"])
        let s = snapshot(goalsOn: false, items: [water])
        let numbers = organizeWeek(s.scheduleSource, today: today, weekStartDay: .monday)
        // Monday to Sunday: two done; Monday and Wednesday went unrecorded,
        // which is neither done nor due; Friday to Sunday are still ahead.
        #expect(numbers.from == DayString("2026-09-28")!)
        #expect(numbers.done == 2)
        #expect(numbers.counted == 5)

        let cards = try #require(OrganizeModel.summary(s))
        let week = try #require(cards.week)
        #expect(week.lead == "2")
        #expect(week.tail == "of 5 done")
        #expect(week.fraction == 0.4)
        #expect(week.spokenLabel == "This week, 2 of 5 done")
        // Goals off: no milestone card, so the week card spans the width.
        #expect(cards.milestone == nil)
        #expect(SummaryCards.weekEyebrow == "THIS WEEK")
    }

    @Test func aWeekWithNothingOnSaysSoWithNoBar() throws {
        let cards = try #require(OrganizeModel.summary(snapshot(goalsOn: false)))
        let week = try #require(cards.week)
        #expect(week.lead == nil)
        #expect(week.tail == "Nothing on this week")
        #expect(week.fraction == nil)
        #expect(week.spokenLabel == "Nothing on this week")
    }

    @Test func theMilestoneCardNamesTheMilestoneItsDayAndItsGoal() throws {
        let tenK = Item(id: uid(7), type: "task", title: "Run a 10K", status: "pending", startDate: "2026-10-04",
                        isScheduled: true)
        let half = Goal(id: "g-half", name: "Run a half marathon", targetOn: "2027-03-15", milestoneIds: [uid(7)])
        let s = snapshot(organize: false, items: [tenK], goals: [half])
        let cards = try #require(OrganizeModel.summary(s))
        // Organize off: no week card; Goals still on.
        #expect(cards.week == nil)
        let card = try #require(cards.milestone)
        #expect(card.title == "Run a 10K")
        #expect(card.line == "Oct 4 \u{00B7} Run a half marathon")
        #expect(card.spokenLabel == "Next milestone, Run a 10K, Oct 4, Run a half marathon")
        #expect(card.route == .container(.goal, id: "g-half"))
        #expect(SummaryCards.milestoneEyebrow == "NEXT MILESTONE")
        #expect(SummaryCards.milestoneHint == "Opens the goal")

        // Undated, the goal's name alone; no countdown either way.
        let undated = Item(id: uid(7), type: "task", title: "Run a 10K", status: "pending", isScheduled: false)
        let alone = try #require(OrganizeModel.summary(snapshot(organize: false, items: [undated], goals: [half])))
        #expect(alone.milestone?.line == "Run a half marathon")
    }

    @Test func theMilestoneCardHidesWithGoalsOffUnknownOrNothingOpen() {
        let tenK = Item(id: uid(7), type: "task", title: "Run a 10K", status: "pending", startDate: "2026-10-04",
                        isScheduled: true)
        let half = Goal(id: "g-half", name: "Run a half marathon", milestoneIds: [uid(7)])
        #expect(OrganizeModel.summary(snapshot(organize: false, goalsOn: false, items: [tenK], goals: [half])) == nil)
        #expect(OrganizeModel.summary(snapshot(organize: false, items: [tenK], goals: nil)) == nil)
        let reached = Item(id: uid(7), type: "task", title: "Run a 10K", status: "completed",
                           startDate: "2026-09-04", isScheduled: true)
        #expect(OrganizeModel.summary(snapshot(organize: false, items: [reached], goals: [half])) == nil)
        let ended = Goal(id: "g-half", name: "Run a half marathon", state: "achieved", milestoneIds: [uid(7)])
        #expect(OrganizeModel.summary(snapshot(organize: false, items: [tenK], goals: [ended])) == nil)
    }

    // MARK: The footer (O5, O14)

    @Test func theFooterFollowsTheSwitchesAndTheServer() {
        #expect(OrganizeModel.footer(snapshot()).map(\.kind) == [.itemTypes, .paused])
        // Paused rides no switch.
        #expect(OrganizeModel.footer(snapshot(organize: false, goalsOn: false)).map(\.kind) == [.paused])
        // Trash only against a server that takes its routes.
        #expect(OrganizeModel.footer(snapshot(trash: true)).map(\.kind) == [.itemTypes, .paused, .trash])
        #expect(OrganizeModel.footer(snapshot(organize: false, trash: true)).map(\.kind) == [.paused, .trash])

        let rows = OrganizeModel.footer(snapshot(trash: true))
        #expect(rows.map(\.title) == ["Item types", "Paused", "Trash"])
        #expect(rows.map(\.route) == [.itemTypes, .paused, .trash])
        #expect(rows.map(\.symbol) == ["square.on.circle", "moon", "trash"])
        #expect(rows.map(\.hint) == ["Opens Item types", "Opens Paused", "Opens Trash"])
        // Plum for Item types; Paused and Trash are muted, no hue.
        #expect(rows[0].accent == containerAccent("var(--accent-4)", name: "Item types"))
        #expect(rows[1].accent == nil)
        #expect(rows[2].accent == nil)
        // At none, no count and nothing under the title.
        #expect(rows.map(\.trailing) == [nil, nil, nil])
        #expect(rows.map(\.subtitle) == [nil, nil, nil])
        #expect(rows.map(\.spokenLabel) == ["Item types", "Paused", "Trash"])
    }

    @Test func pausedCountsItemsAndNamesTheSoonestReturn() throws {
        let rows = OrganizeModel.footer(shelfSnapshot)
        let paused = try #require(rows.first { $0.kind == .paused })
        // Five items: Evening's two count two, the laptop's moon's number.
        #expect(paused.trailing == "5")
        #expect(paused.subtitle == "Stretch back tomorrow")
        #expect(paused.spokenLabel == "Paused, 5 items, Stretch back tomorrow")
        #expect(pausedNote(ShelfPageModel.shelf(shelfSnapshot), today: today) == "5 \u{00B7} Stretch back tomorrow")

        let types = try #require(rows.first { $0.kind == .itemTypes })
        #expect(types.trailing == "1")
        #expect(types.spokenLabel == "Item types, 1 type")

        // Nothing with a day to come back: the count alone.
        let undated = snapshot(items: [shelfItems[3]])
        let alone = try #require(OrganizeModel.footer(undated).first { $0.kind == .paused })
        #expect(alone.trailing == "1")
        #expect(alone.subtitle == nil)
        #expect(alone.spokenLabel == "Paused, 1 item")
    }

    // MARK: Paused (O5)

    @Test func pausedGroupsByTheDayEachComesBack() {
        let page = ShelfPageModel.pausedPage(shelfSnapshot) { _ in true }
        #expect(page.welcome == PausedShelf.welcome)
        #expect(page.count == 5)
        #expect(page.empty == nil)
        #expect(page.groups.map(\.title) == ["Tomorrow", "Fri, Oct 30", "No date"])
        #expect(page.groups.map { $0.rows.map(\.name) } == [["Stretch"], ["Evening"], ["Call the bank", "Piranesi"]])
        #expect(page.groups.map { $0.rows.map(\.kindLine) }
            == [["Habit"], ["Routine \u{00B7} 2 habits"], ["Task", "Book to read"]])
        #expect(page.groups[1].rows[0].spokenLabel == "Evening, Routine, 2 habits")
        #expect(page.groups[0].rows[0].spokenLabel == "Stretch, Habit")
    }

    @Test func anItemRowOpensItsSheetAndResumesOnlyWhereTheSheetWould() throws {
        let page = ShelfPageModel.pausedPage(shelfSnapshot) { $0.id == self.uid(1) }
        let stretch = try #require(page.groups.first?.rows.first)
        #expect(stretch.key == "item:" + lowerID(uid(1)))
        #expect(stretch.itemId == uid(1))
        #expect(stretch.route == nil)
        #expect(stretch.mark == .item(habit: true))
        #expect(stretch.resumable)
        #expect(stretch.resumeLabel == "Resume Stretch")

        let bank = try #require(page.groups.last?.rows.first)
        #expect(bank.mark == .item(habit: false))
        #expect(!bank.resumable)
    }

    @Test func aRoutineRowPushesItsDetailAndHasNoResumeYet() throws {
        let page = ShelfPageModel.pausedPage(shelfSnapshot) { _ in true }
        let row = try #require(page.groups.dropFirst().first?.rows.first)
        #expect(row.key == "routine:r-evening")
        #expect(row.itemId == nil)
        #expect(row.route == .pausedEntry("routine:r-evening"))
        // A container resumes from O8a; until then the gate is never asked.
        #expect(!row.resumable)
        #expect(row.mark == .container(symbol: containerSymbol(glyph: "icon:Moon", name: "Evening", kind: .routine),
                                       accent: containerAccent("var(--accent-4)", name: "Evening")))
    }

    @Test func nothingPausedSaysSo() {
        let page = ShelfPageModel.pausedPage(snapshot(items: [habit(6, "Meds")])) { _ in true }
        #expect(page.groups.isEmpty)
        #expect(page.count == 0)
        #expect(page.empty == "Nothing is paused.")
    }

    @Test func aPausedRoutinesDetailListsWhatComesBackWithIt() throws {
        let content = try #require(ShelfPageModel.pausedEntryPage("routine:r-evening", shelfSnapshot))
        guard case .page(let page) = content else {
            Issue.record("a paused routine's detail is a page")
            return
        }
        #expect(page.header.title == "Evening")
        #expect(page.header.eyebrow == "ROUTINE")
        #expect(page.kindLine == "Routine \u{00B7} 2 habits")
        // Asked of its first member, so it says what the grid would.
        #expect(page.stateLine == "Hidden with your Evening routine until Oct 30.")
        #expect(page.members.map(\.item.title) == ["Read", "Floss"])
        #expect(page.members.allSatisfy { !$0.tickable })
        #expect(page.openIn == PausedEntryPage.OpenIn(title: "Open in Routines",
                                                      route: .container(.routine, id: "r-evening")))

        // With Organize off the detail stays, but not the way to the page
        // Organize off would blank.
        var off = shelfSnapshot
        off.settings = PlannerSettings(organizeEnabled: false)
        guard case .page(let offPage)? = ShelfPageModel.pausedEntryPage("routine:r-evening", off) else {
            Issue.record("Paused rides no switch")
            return
        }
        #expect(offPage.openIn == nil)
        #expect(offPage.members.count == 2)
    }

    @Test func aDetailOffTheShelfIsGone() {
        // An item's key never pushes a detail, and a resumed routine is gone.
        #expect(ShelfPageModel.pausedEntryPage("item:" + lowerID(uid(1)), shelfSnapshot) == nil)
        var resumed = shelfSnapshot
        resumed.routines = [Routine(id: "r-evening", name: "Evening", itemIds: [uid(2), uid(3)])]
        #expect(ShelfPageModel.pausedEntryPage("routine:r-evening", resumed) == nil)
    }

    @Test func aSamplePauseShowsOnPausedAndResumeTakesItOff() throws {
        let planner = SamplePlanner(todayString: PlannerJSON.today, now: { PlannerJSON.noon })
        #expect(planner.pausedPage.count == 0)
        #expect(!planner.isGone(.paused))
        let journal = try #require(planner.items.first { $0.title == "Journal" })
        planner.pause(journal.id, until: "2026-10-03")

        let page = planner.pausedPage
        #expect(page.count == 1)
        #expect(page.groups.map(\.title) == ["Sat, Oct 3"])
        let row = try #require(page.groups.first?.rows.first)
        #expect(row.itemId == journal.id)
        #expect(row.resumable)
        #expect(planner.organizeFooter.first { $0.kind == .paused }?.trailing == "1")

        planner.resume(journal.id)
        #expect(planner.pausedPage.empty == "Nothing is paused.")
    }

    // MARK: Item types (O5)

    @Test func aTypeCountsItsItemsByTypeName() throws {
        // A custom item arrives as "custom" with its slug beside it, so the
        // count asks `typeName`; `type == slug` would count none.
        let items = [
            Item(id: uid(1), type: "custom", customType: "book", title: "Piranesi", isScheduled: false),
            Item(id: uid(2), type: "custom", customType: "book", title: "Circe", isScheduled: false),
            Item(id: uid(3), type: "custom", customType: "film", title: "Heat", isScheduled: false),
            Item(id: uid(4), type: "task", title: "Groceries", isScheduled: false),
        ]
        let film = ItemTypeLabel(name: "film", label: "Film", labelPlural: "Films")
        let page = try #require(ShelfPageModel.itemTypesPage(snapshot(items: items, itemTypes: [bookType, film])))
        #expect(page.empty == nil)
        #expect(page.rows.map(\.title) == ["Book to read", "Film"])
        #expect(page.rows.map(\.subtitle) == ["2 items", "1 item"])
        #expect(page.rows.map(\.symbol) == ["square.on.circle", "square.on.circle"])
        #expect(page.rows[0].accent == containerAccent(nil, name: "book"))
        #expect(page.rows[0].spokenLabel == "Book to read, item type, 2 items")
        #expect(ShelfPageModel.typeCount("book", items) == 2)
    }

    @Test func noTypesAndUnreadableTypesEachSayWhy() {
        #expect(ShelfPageModel.itemTypesPage(snapshot())?.empty == "No custom types yet. You make them on the web.")
        #expect(ShelfPageModel.itemTypesPage(snapshot(itemTypes: nil))?.empty
            == "Custom types aren\u{2019}t available on this account yet.")
    }

    /// The web hides its types section while Organize is off, so the page is
    /// gone (it pops), never a sentence about routines and seasons.
    @Test func itemTypesIsGoneWhileOrganizeIsOff() async {
        #expect(ShelfPageModel.itemTypesPage(snapshot(organize: false, itemTypes: [bookType])) == nil)
        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload()),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2", organizeEnabled: false)))
        let planner = makeLivePlanner(server)
        await planner.refresh()
        #expect(!planner.isGone(.itemTypes))
        await planner.refresh()
        #expect(planner.itemTypesPage == nil)
        #expect(planner.isGone(.itemTypes))
        #expect(!planner.isGone(.paused))
        #expect(!planner.organizeFooter.contains { $0.kind == .itemTypes })
    }

    // MARK: Trash (O14)

    @Test func aTrashRowSaysWhatComesBackWithItAndWhenItWent() {
        let now = PlannerJSON.noon
        let project = TrashRow(kind: .project, id: "p-work", name: "Work", deletedAt: "2026-09-28T12:00:00.000Z",
                               memberCount: 3)
        let row = ShelfPageModel.trashRow(project, now: now)
        #expect(row.meta == "Project \u{00B7} 3 items refile \u{00B7} 3d ago")
        #expect(row.spokenLabel == "Work, Project, 3 items refile, 3d ago")
        #expect(row.restoreLabel == "Restore project Work")
        #expect(row.symbol == containerSymbol(glyph: nil, name: "Work", kind: .project))
        #expect(row.accent == containerAccent(nil, name: "Work"))
        #expect(row.id == "project:p-work")

        let item = TrashRow(kind: .item, id: lowerID(uid(9)), name: "Reading", deletedAt: "2026-10-01T07:00:00.000Z",
                            childCount: 2)
        let itemRow = ShelfPageModel.trashRow(item, now: now)
        #expect(itemRow.meta == "Item \u{00B7} 2 subtasks \u{00B7} 5h ago")
        #expect(itemRow.restoreLabel == "Restore item Reading")
        #expect(itemRow.symbol == (ContainerLook.lucideToSymbol[resolveCategoryIconName(nil, "Reading")] ?? "circle"))
    }

    @Test func theFootersRoutesAreNotGoneWithOrganizeOn() {
        let planner = SamplePlanner(todayString: PlannerJSON.today, now: { PlannerJSON.noon })
        #expect(!planner.isGone(.paused))
        #expect(!planner.isGone(.itemTypes))
        #expect(!planner.isGone(.trash))
        #expect(planner.isGone(.pausedEntry("routine:nowhere")))
        // The sample has no server bin.
        #expect(!planner.offersTrash)
        #expect(!planner.organizeFooter.contains { $0.kind == .trash })
    }
}

/// The Trash's two calls through PlannerSync (O14): the bin read for the page,
/// and a restore, which is not a queued write but moves the generation like
/// one, so a fetch out across it comes back raced and is made again.
@MainActor
@Suite struct TrashSyncTests {
    private let trashRoute = "GET /api/app/trash"
    private let restoreRoute = "POST /api/app/trash/restore"
    private let allTrash = ["list", "restore"]

    private let bin = "{\"entries\":["
        + "{\"kind\":\"project\",\"id\":\"0d000000-0000-4000-8000-0000000000aa\",\"name\":\"Work\","
        + "\"deletedAt\":\"2026-09-28T12:00:00.000Z\",\"childCount\":0,\"memberCount\":3},"
        + "{\"kind\":\"item\",\"id\":\"0d000000-0000-4000-8000-0000000000ab\",\"name\":\"Reading\","
        + "\"deletedAt\":\"2026-10-01T07:00:00.000Z\",\"childCount\":2,\"memberCount\":0}]}"

    private func loaded(_ server: FakeServer) async -> SamplePlanner {
        let planner = makeLivePlanner(server)
        await planner.refresh()
        planner.sync?.racePause = .milliseconds(20)
        return planner
    }

    private var work: TrashRow {
        TrashRow(kind: .project, id: "0D000000-0000-4000-8000-0000000000AA", name: "Work",
                 deletedAt: "2026-09-28T12:00:00.000Z", memberCount: 3)
    }

    private var subtask: TrashRow {
        TrashRow(kind: .item, id: "0d000000-0000-4000-8000-0000000000ac", name: "Bring the bags",
                 deletedAt: "2026-10-01T07:00:00.000Z")
    }

    @Test func theRowShowsOnlyAgainstAServerThatTakesBothRoutes() async {
        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload()),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2", trashWrites: ["list"])),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-3", trashWrites: allTrash)))
        let planner = await loaded(server)
        // An older server sends no key: no Trash row.
        #expect(planner.trashWrites == nil)
        #expect(!planner.offersTrash)
        #expect(!planner.organizeFooter.contains { $0.kind == .trash })
        await planner.refresh()
        #expect(!planner.offersTrash)
        await planner.refresh()
        #expect(planner.offersTrash)
        #expect(planner.organizeFooter.map(\.kind) == [.itemTypes, .paused, .trash])
    }

    @Test func theBinIsReadForThePageAndAFailureIsNeverAnEmptyBin() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(trashWrites: allTrash)))
        await server.on(trashRoute, .status(200, bin), .status(200, "{}"), .status(500, "{\"error\":\"internal\"}"))
        let planner = await loaded(server)
        let list = try await planner.fetchTrash()
        #expect(list.entries.map(\.name) == ["Work", "Reading"])
        #expect(list.entries.map(\.kind) == [.project, .item])
        // The bin never enters the planner.
        #expect(!planner.items.contains { $0.title == "Reading" })

        await #expect(throws: APIError.badResponse) { _ = try await planner.fetchTrash() }
        await #expect(throws: APIError.rejected(status: 500, code: "internal")) { _ = try await planner.fetchTrash() }
        // A GET writes nothing: no device header.
        let reads = await server.requests.filter { $0.route == trashRoute }
        #expect(reads.allSatisfy { $0.headers["x-dsul-device"] == nil })
    }

    @Test func aRestoreThatLandsFetchesAndSendsTheStrictBody() async throws {
        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload(trashWrites: allTrash)),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2", trashWrites: allTrash)))
        await server.on(restoreRoute, .status(200, "{\"ok\":true}"))
        let planner = await loaded(server)
        let sync = try #require(planner.sync)
        let before = sync.writeGeneration

        let restored = await planner.restoreFromTrash(work)
        #expect(restored)
        #expect(planner.banner == nil)
        // Bumped when sent and when answered.
        #expect(sync.writeGeneration == before + 2)
        await sync.drain()
        #expect(sync.lastAppliedFetchedAt == "fetch-2")

        let sent = await server.requests.first { $0.route == restoreRoute }
        let body = try #require(bodyJSON(sent))
        #expect(body.count == 2)
        #expect(body["kind"] as? String == "project")
        #expect(body["id"] as? String == "0d000000-0000-4000-8000-0000000000aa")
    }

    @Test func aFetchStartedBeforeARestoreComesBackRacedAndIsMadeAgain() async throws {
        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-1", trashWrites: allTrash)),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2-stale", trashWrites: allTrash)),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-3", projects: [PlannerJSON.workJSON],
                                                         trashWrites: allTrash)))
        await server.on(restoreRoute, .status(200, "{\"ok\":true}"))
        let planner = await loaded(server)
        let sync = try #require(planner.sync)
        #expect(sync.lastAppliedFetchedAt == "fetch-1")

        // The GET leaves, the restore is made and lands, then the GET answers
        // with what the server held before the restore.
        await server.close(plannerRoute)
        let fetch = Task { await planner.refresh() }
        let out = await waitUntil { await server.count(plannerRoute) == 2 }
        #expect(out)
        let restored = await planner.restoreFromTrash(work)
        #expect(restored)
        await server.open(plannerRoute)
        await fetch.value
        await sync.drain()

        // The stale answer was never applied; the one after the restore was.
        #expect(sync.appliedFetches == 2)
        #expect(sync.lastAppliedFetchedAt == "fetch-3")
        #expect(planner.projectRecords.map(\.name) == ["Work"])
        let gets = await server.count(plannerRoute)
        #expect(gets == 3)
    }

    @Test func aRefusedRestoreSaysWhyAndKeepsTheRow() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(trashWrites: allTrash)))
        await server.on(restoreRoute,
                        .status(409, "{\"error\":\"name_taken\",\"project\":{\"id\":\"p-2\",\"name\":\"work\"}}"),
                        .status(409, "{\"error\":\"parent_gone\"}"),
                        .status(500, "{\"error\":\"failed\"}"))
        let planner = await loaded(server)
        let sync = try #require(planner.sync)

        #expect(await planner.restoreFromTrash(work) == false)
        // The LIVE project's name, as the server spells it.
        #expect(planner.banner?.text
            == "You already have a project called \u{201C}work\u{201D}. Rename that one, then restore this one.")
        #expect(planner.banner?.isError == true)

        #expect(await planner.restoreFromTrash(subtask) == false)
        #expect(planner.banner?.text == "Its parent is in the Trash too. Restore that instead.")

        #expect(await planner.restoreFromTrash(subtask) == false)
        #expect(planner.banner?.text == "Couldn't restore it. Check your connection and try again.")

        #expect(await sync.restoreFromTrash(subtask) == .refused(OrganizeCopy.restoreFailed))
        // An answered refusal starts no fetch: the server took nothing.
        await sync.drain()
        #expect(sync.appliedFetches == 1)
    }

    /// A 404: the row was purged after the list was read. No retry can land,
    /// so the row goes, and the banner says why.
    @Test func aRowNoLongerInTheBinLeavesTheList() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(trashWrites: allTrash)))
        await server.on(restoreRoute, .status(404, "{\"error\":\"not_found\"}"))
        let planner = await loaded(server)
        let sync = try #require(planner.sync)

        #expect(await planner.restoreFromTrash(subtask) == true)
        #expect(planner.banner?.text == "It's no longer in the Trash.")
        #expect(planner.banner?.isError == true)
        #expect(await sync.restoreFromTrash(subtask) == .gone(OrganizeCopy.restoreGone))
        await sync.drain()
        #expect(sync.appliedFetches == 1)
    }

    /// Offline mid-request, or a 502 to 504 after the route ran: the server
    /// may have taken it, so the phone asks what it holds, as a failed queued
    /// write does, and the row stays until that says otherwise.
    @Test func aRestoreWhoseAnswerIsLostAsksTheServer() async throws {
        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-1", trashWrites: allTrash)),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2", projects: [PlannerJSON.workJSON],
                                                         trashWrites: allTrash)))
        await server.on(restoreRoute, .offline)
        let planner = await loaded(server)
        let sync = try #require(planner.sync)
        let before = sync.writeGeneration

        #expect(await planner.restoreFromTrash(work) == false)
        #expect(planner.banner?.text == "Couldn't restore it. Check your connection and try again.")
        #expect(sync.writeGeneration == before + 2)
        await sync.drain()
        #expect(sync.lastAppliedFetchedAt == "fetch-2")
        #expect(planner.projectRecords.map(\.name) == ["Work"])
    }

    @Test func theSampleHasNoBin() async {
        let planner = SamplePlanner(todayString: PlannerJSON.today, now: { PlannerJSON.noon })
        await #expect(throws: APIError.signedOut) { _ = try await planner.fetchTrash() }
        let row = TrashRow(kind: .item, id: "x", name: "Reading", deletedAt: "")
        #expect(await planner.restoreFromTrash(row) == false)
        #expect(planner.banner == nil)
    }

    @Test func aStoppedSyncSendsNothing() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(trashWrites: allTrash)))
        let planner = await loaded(server)
        let sync = try #require(planner.sync)
        planner.stopSync()
        #expect(await sync.restoreFromTrash(work) == .unsent)
        await #expect(throws: APIError.signedOut) { _ = try await sync.fetchTrash() }
        let sent = await server.count(restoreRoute)
        #expect(sent == 0)
    }
}
