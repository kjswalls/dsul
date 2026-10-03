import DsulCore
import Foundation
import Testing
@testable import Dsul

/// The item sheet's title, notes, Delete, Add a subtask and Reset streak on a
/// signed-in planner, against PlannerSyncTests' fake server and its Thursday
/// 2026-10-01 payload: each write's optimistic step and the body it sends,
/// the gates that refuse (sending nothing), an older server's shorter list of
/// writes, what a delete takes with it and which sheet it closes, a pasted
/// list sent offline, the Streaks switch, a custom type's own words, the
/// banner said once, and the background time a write asks for. The rebase
/// under a failed write is PlannerSyncTests'; the sample's steps are
/// SamplePlannerTests'.
@MainActor
@Suite struct ItemEditTests {
    private let ok = "{\"ok\":true}"

    private func loaded(_ server: FakeServer) async -> SamplePlanner {
        let planner = makeLivePlanner(server)
        await planner.refresh()
        return planner
    }

    private func drain(_ planner: SamplePlanner) async {
        if let sync = planner.sync { await sync.drain() }
    }

    /// Every POST to `id`'s route, as JSON, in the order it arrived.
    private func sentBodies(_ server: FakeServer, _ id: UUID) async -> [[String: Any]] {
        let requests = await server.requests
        return requests.filter { $0.route == itemRoute(id) }.compactMap { bodyJSON($0) }
    }

    private func postCount(_ server: FakeServer) async -> Int {
        let requests = await server.requests
        return requests.filter { $0.route.hasPrefix("POST") }.count
    }

    // MARK: Title

    @Test func aTitleShowsAtOnceAndSendsItsOwnAction() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.groceries), .status(200, ok))
        let planner = await loaded(server)

        planner.edit(PlannerJSON.groceries, .title("Big shop"))
        #expect(planner.item(PlannerJSON.groceries)?.title == "Big shop")
        #expect(planner.dayItems.contains { $0.title == "Big shop" })
        await drain(planner)

        let bodies = await sentBodies(server, PlannerJSON.groceries)
        #expect(bodies.count == 1)
        #expect(bodies.first?["action"] as? String == "title")
        #expect(bodies.first?["title"] as? String == "Big shop")
        #expect(bodies.first?.count == 2)
        #expect(planner.banner == nil)
    }

    /// A subtask's own page edits its title (design Q7).
    @Test func aSubtaskTakesItsOwnTitle() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [PlannerJSON.bagsJSON])))
        await server.on(itemRoute(PlannerJSON.bags), .status(200, ok))
        let planner = await loaded(server)

        planner.edit(PlannerJSON.bags, .title("Bring the big bags"))
        #expect(planner.subtasks(of: PlannerJSON.groceries).map(\.title) == ["Bring the big bags"])
        await drain(planner)

        let bodies = await sentBodies(server, PlannerJSON.bags)
        #expect(bodies.first?["action"] as? String == "title")
        #expect(bodies.first?["title"] as? String == "Bring the big bags")
    }

    // MARK: Notes

    /// Clearing sends `"notes": null`, never a missing key: the route's
    /// schema is nullable, not optional, so a body without it is refused.
    @Test func notesAreSetAndThenClearedWithAnExplicitNull() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.groceries), .status(200, ok))
        let planner = await loaded(server)

        planner.edit(PlannerJSON.groceries, .notes("Oat milk, not dairy"))
        #expect(planner.item(PlannerJSON.groceries)?.notes == "Oat milk, not dairy")
        planner.edit(PlannerJSON.groceries, .notes(nil))
        #expect(planner.item(PlannerJSON.groceries)?.notes == nil)
        await drain(planner)

        let bodies = await sentBodies(server, PlannerJSON.groceries)
        #expect(bodies.count == 2)
        #expect(bodies.first?["action"] as? String == "notes")
        #expect(bodies.first?["notes"] as? String == "Oat milk, not dairy")
        #expect(bodies.last?["action"] as? String == "notes")
        #expect(bodies.last?["notes"] is NSNull)
        #expect(bodies.last?.count == 2)
        #expect(planner.banner == nil)
    }

    // MARK: Delete

    /// The phone sends one delete; the server takes the subtasks with their
    /// parent, as the planner's step already did.
    @Test func deleteTakesTheSubtasksAndClosesTheSheet() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [PlannerJSON.bagsJSON])))
        await server.on(itemRoute(PlannerJSON.groceries), .status(200, ok))
        let planner = await loaded(server)

        planner.open(PlannerJSON.groceries, day: .selected)
        planner.deleteItem(PlannerJSON.groceries)
        #expect(planner.item(PlannerJSON.groceries) == nil)
        #expect(planner.item(PlannerJSON.bags) == nil)
        #expect(planner.activeSheet == nil)
        #expect(!planner.dayItems.contains { $0.id == PlannerJSON.groceries })
        await drain(planner)

        let bodies = await sentBodies(server, PlannerJSON.groceries)
        #expect(bodies.count == 1)
        #expect(bodies.first?["action"] as? String == "delete")
        #expect(bodies.first?.count == 1)
        let bagPosts = await server.count(itemRoute(PlannerJSON.bags))
        #expect(bagPosts == 0)
        #expect(planner.banner == nil)
    }

    /// A subtask deleted from its page (or its row) leaves the parent's sheet,
    /// which the page was pushed on, where it is.
    @Test func deletingASubtaskLeavesItsParentsSheetUp() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [PlannerJSON.bagsJSON])))
        await server.on(itemRoute(PlannerJSON.bags), .status(200, ok))
        let planner = await loaded(server)

        planner.open(PlannerJSON.groceries, day: .selected)
        planner.deleteItem(PlannerJSON.bags)
        #expect(planner.item(PlannerJSON.bags) == nil)
        #expect(planner.item(PlannerJSON.groceries) != nil)
        #expect(planner.subtasks(of: PlannerJSON.groceries).isEmpty)
        #expect(planner.activeSheet == .item(PlannerJSON.groceries, day: .selected))
        await drain(planner)

        let bodies = await sentBodies(server, PlannerJSON.bags)
        #expect(bodies.count == 1)
        #expect(bodies.first?["action"] as? String == "delete")
    }

    /// The route's own 404 means the row is gone already (a delete from
    /// another device): the delete landed, so nothing is said and nothing is
    /// fetched again.
    @Test func aDeleteAnswered404NotFoundHasLanded() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.groceries), .status(404, "{\"error\":\"not_found\"}"))
        let planner = await loaded(server)

        planner.open(PlannerJSON.groceries, day: .selected)
        planner.deleteItem(PlannerJSON.groceries)
        await drain(planner)

        #expect(planner.item(PlannerJSON.groceries) == nil)
        #expect(planner.activeSheet == nil)
        #expect(planner.banner == nil)
        let gets = await server.count(plannerRoute)
        #expect(gets == 1)
    }

    // MARK: Refusals

    @Test func anEditOrDeleteItsGateRefusesChangesNothingAndSendsNothing() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        let planner = await loaded(server)
        let before = planner.items

        planner.edit(PlannerJSON.plants, .title("Water the ferns"))   // no such item here
        planner.edit(PlannerJSON.groceries, .title("Groceries"))      // already so
        planner.edit(PlannerJSON.groceries, .title("   "))            // trims to nothing, which the route refuses
        planner.edit(PlannerJSON.bank, .notes(nil))                   // no notes to clear
        planner.deleteItem(PlannerJSON.plants)                        // no such item here

        #expect(planner.items == before)
        #expect(planner.sync?.pending == 0)
        await drain(planner)
        let posts = await postCount(server)
        #expect(posts == 0)
    }

    /// Part 1's server lists its five writes, and one older still lists none
    /// (`complete` and `schedule` alone): neither takes an edit or a delete,
    /// so the sheet offers neither and the planner sends neither.
    @Test func anOlderServerTakesNoEditAndNoDelete() async throws {
        let partOne = ["complete", "schedule", "skip", "move", "pause"]
        for writes in [partOne, nil] {
            let server = FakeServer()
            await server.on(plannerRoute, .status(200, PlannerJSON.payload(writes: writes)))
            let planner = await loaded(server)
            #expect(!planner.canWrite("title"))
            #expect(!planner.canWrite("notes"))
            #expect(!planner.canWrite("delete"))
            #expect(!planner.canWrite("addSubtask"))
            #expect(!planner.canWrite("resetStreak"))
            let groceries = try #require(planner.item(PlannerJSON.groceries))
            #expect(!planner.offeredVerbs(for: groceries, day: .selected).contains(.delete))

            planner.edit(PlannerJSON.groceries, .title("Big shop"))
            planner.edit(PlannerJSON.groceries, .notes("Oat milk"))
            planner.deleteItem(PlannerJSON.groceries)
            #expect(planner.item(PlannerJSON.groceries) == groceries)
            #expect(planner.sync?.pending == 0)
            let posts = await postCount(server)
            #expect(posts == 0)
        }
    }

    // MARK: Add a subtask

    /// A new subtask shows at once under its parent, as the web's `addTask`
    /// makes it (a pending, unscheduled task after every task-like row), and
    /// is sent to the parent's route under the phone's own id, lowercase.
    @Test func aSubtaskShowsAtOnceAndGoesToItsParentsRoute() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [PlannerJSON.bagsJSON])))
        await server.on(itemRoute(PlannerJSON.groceries), .status(201, "{\"ok\":true,\"id\":\"x\"}"))
        let planner = await loaded(server)
        let order = DsulCore.project(planner.items).tasks.count
        #expect(order == 2)   // Groceries and the bank; the bags are a subtask

        let id = try #require(planner.addSubtask(PlannerJSON.groceries, title: "Eggs"))
        let eggs = try #require(planner.items.last)
        #expect(eggs.id == id)
        #expect(eggs.title == "Eggs")
        #expect(eggs.type == "task")
        #expect(eggs.status == "pending")
        #expect(eggs.isScheduled == false)
        #expect(eggs.order == order)
        #expect(eggs.parentItemId == lowerID(PlannerJSON.groceries))
        #expect(planner.subtasks(of: PlannerJSON.groceries).map(\.id) == [PlannerJSON.bags, id])
        #expect(!planner.dayItems.contains { $0.id == id })
        #expect(!planner.braindump.contains { $0.id == id })
        await drain(planner)

        let bodies = await sentBodies(server, PlannerJSON.groceries)
        #expect(bodies.count == 1)
        #expect(bodies.first?["action"] as? String == "addSubtask")
        #expect(bodies.first?["id"] as? String == lowerID(id))
        #expect(bodies.first?["title"] as? String == "Eggs")
        #expect(bodies.first?.count == 3)
        let childPosts = await server.count(itemRoute(id))
        #expect(childPosts == 0)
        #expect(planner.item(id) == eggs)
        #expect(planner.banner == nil)
    }

    /// New text is cleaned as the web's field sends it: one line, trimmed,
    /// and at most 500 UTF-16 units, cut by whole characters, so an emoji at
    /// the limit goes whole. Blank adds nothing and sends nothing.
    @Test func aSubtasksTitleIsCleanedBeforeItIsSent() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.groceries), .status(201, ok))
        let planner = await loaded(server)

        let oneLine = try #require(planner.addSubtask(PlannerJSON.groceries, title: "  Eggs\nand milk \n"))
        #expect(planner.item(oneLine)?.title == "Eggs and milk")
        let plain = try #require(planner.addSubtask(PlannerJSON.groceries, title: String(repeating: "x", count: 600)))
        #expect(planner.item(plain)?.title == String(repeating: "x", count: 500))
        // 600 characters: 499 units, then an egg of two that would end at 501.
        let long = String(repeating: "a", count: 499) + "\u{1F95A}" + String(repeating: "b", count: 100)
        #expect(long.count == 600)
        let cut = try #require(planner.addSubtask(PlannerJSON.groceries, title: long))
        let cutTitle = try #require(planner.item(cut)?.title)
        #expect(cutTitle == String(repeating: "a", count: 499))
        #expect(planner.addSubtask(PlannerJSON.groceries, title: " \n\t ") == nil)
        #expect(planner.subtasks(of: PlannerJSON.groceries).count == 3)
        await drain(planner)

        let bodies = await sentBodies(server, PlannerJSON.groceries)
        let titles: [String?] = bodies.map { $0["title"] as? String }
        #expect(titles == ["Eggs and milk", String(repeating: "x", count: 500), cutTitle])
    }

    /// The server's gate, asked again whatever the sheet drew: a habit grows
    /// no subtasks (`no_subtasks`), a subtask none of its own (`nested`), and
    /// a server that doesn't list `addSubtask` (2a's) takes none. Each returns
    /// nil, changes nothing and sends nothing. A custom item takes one, as its
    /// template, a task, does.
    @Test func aSubtaskItsGateRefusesIsNeitherAddedNorSent() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(
            itemTypes: [PlannerJSON.bookType], extra: [PlannerJSON.bagsJSON, PlannerJSON.bookJSON])))
        let planner = await loaded(server)
        let before = planner.items
        let water = try #require(planner.item(PlannerJSON.water))
        let bags = try #require(planner.item(PlannerJSON.bags))
        let groceries = try #require(planner.item(PlannerJSON.groceries))
        let book = try #require(planner.item(PlannerJSON.book))
        #expect(!planner.canAddSubtask(to: water))
        #expect(!planner.canAddSubtask(to: bags))
        #expect(planner.canAddSubtask(to: groceries))
        #expect(planner.canAddSubtask(to: book))

        #expect(planner.addSubtask(PlannerJSON.water, title: "A glass by the bed") == nil)   // a habit
        #expect(planner.addSubtask(PlannerJSON.bags, title: "The big ones") == nil)         // a subtask
        #expect(planner.addSubtask(PlannerJSON.plants, title: "The ferns") == nil)          // no such item here
        #expect(planner.items == before)
        #expect(planner.sync?.pending == 0)
        await drain(planner)
        let posts = await postCount(server)
        #expect(posts == 0)

        let partTwoA = ["complete", "schedule", "skip", "move", "pause", "title", "notes", "delete"]
        let older = FakeServer()
        await older.on(plannerRoute, .status(200, PlannerJSON.payload(writes: partTwoA)))
        let olderPlanner = await loaded(older)
        let olderGroceries = try #require(olderPlanner.item(PlannerJSON.groceries))
        #expect(!olderPlanner.canAddSubtask(to: olderGroceries))
        #expect(olderPlanner.addSubtask(PlannerJSON.groceries, title: "Eggs") == nil)
        #expect(olderPlanner.subtasks(of: PlannerJSON.groceries).isEmpty)
        #expect(olderPlanner.sync?.pending == 0)
        await drain(olderPlanner)
        let olderPosts = await postCount(older)
        #expect(olderPosts == 0)
    }

    /// A pasted list is what SubtaskField makes of it: one `addSubtask` a
    /// line, each to the parent's route, in order, all with the same `order`,
    /// the task count (`tasks.length`), which no subtask counts toward: 2
    /// here, Groceries and the bank, never Groceries' own 1. Sent offline,
    /// each fails, and once the refetch fails too every one is taken back.
    @Test func aPasteSentOfflineIsTakenBackLineByLine() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(itemRoute(PlannerJSON.groceries), .offline)
        let planner = await loaded(server)
        let groceries = planner.item(PlannerJSON.groceries)

        let ids = ["Eggs", "Milk", "Bread"].compactMap { planner.addSubtask(PlannerJSON.groceries, title: $0) }
        #expect(ids.count == 3)
        let children = planner.subtasks(of: PlannerJSON.groceries)
        #expect(children.map(\.id) == ids)
        #expect(children.map(\.title) == ["Eggs", "Milk", "Bread"])
        #expect(Set(children.map(\.order)).count == 1)
        #expect(children.allSatisfy { $0.order == 2 })
        #expect(groceries?.order == 1)
        await drain(planner)

        let bodies = await sentBodies(server, PlannerJSON.groceries)
        let titles: [String?] = bodies.map { $0["title"] as? String }
        #expect(titles == ["Eggs", "Milk", "Bread"])
        for id in ids {
            let childPosts = await server.count(itemRoute(id))
            #expect(childPosts == 0)
        }
        #expect(planner.subtasks(of: PlannerJSON.groceries).isEmpty)
        #expect(ids.allSatisfy { planner.item($0) == nil })
        #expect(planner.item(PlannerJSON.groceries) == groceries)
        #expect(planner.banner?.text == "Couldn't reach dsul, so that change was undone.")
    }

    // MARK: Reset streak

    /// Reset streak puts the counter to 0 and leaves the days already ticked
    /// and a counted habit's tally alone; the server is sent the action
    /// alone. At 0 it is offered no more.
    @Test func resetStreakZeroesTheCounterAndKeepsTheHistory() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [PlannerJSON.medsJSON])))
        await server.on(itemRoute(PlannerJSON.meds), .status(200, ok))
        await server.on(itemRoute(PlannerJSON.water), .status(200, ok))
        let planner = await loaded(server)
        let meds = try #require(planner.item(PlannerJSON.meds))
        let water = try #require(planner.item(PlannerJSON.water))
        #expect(planner.offeredVerbs(for: meds, day: .selected).contains(.resetStreak))

        planner.resetStreak(PlannerJSON.meds)
        planner.resetStreak(PlannerJSON.water)
        let reset = try #require(planner.item(PlannerJSON.meds))
        #expect(reset.streak == 0)
        #expect(reset.completedDates == ["2026-09-29", "2026-09-30"])
        #expect(reset == resettingStreak(meds))
        let waterReset = try #require(planner.item(PlannerJSON.water))
        #expect(waterReset.streak == 0)
        #expect(waterReset.dailyCounts == water.dailyCounts)
        #expect(waterReset.dailyCounts[PlannerJSON.today] == 1)
        #expect(!planner.offeredVerbs(for: reset, day: .selected).contains(.resetStreak))
        await drain(planner)

        for id in [PlannerJSON.meds, PlannerJSON.water] {
            let bodies = await sentBodies(server, id)
            #expect(bodies.count == 1)
            #expect(bodies.first?["action"] as? String == "resetStreak")
            #expect(bodies.first?.count == 1)
        }
        #expect(planner.banner == nil)
    }

    /// Reset streak is offered, and sent, only for a habit with a streak,
    /// while Streaks is on, by a server that takes it. At 0, on a task, with
    /// Streaks off, or on 2a's server, nothing is offered and nothing is sent.
    @Test func resetStreakIsRefusedAtZeroWithStreaksOffAndOnAnOlderServer() async throws {
        let partTwoA = ["complete", "schedule", "skip", "move", "pause", "title", "notes", "delete"]
        let cases: [(String, String, UUID)] = [
            ("at 0", PlannerJSON.payload(), PlannerJSON.stretch),
            ("a task", PlannerJSON.payload(), PlannerJSON.groceries),
            ("Streaks off", PlannerJSON.payload(streaksEnabled: false, extra: [PlannerJSON.medsJSON]),
             PlannerJSON.meds),
            ("an older server", PlannerJSON.payload(writes: partTwoA, extra: [PlannerJSON.medsJSON]),
             PlannerJSON.meds),
        ]
        for (name, payload, id) in cases {
            let server = FakeServer()
            await server.on(plannerRoute, .status(200, payload))
            let planner = await loaded(server)
            let before = try #require(planner.item(id), "\(name)")
            #expect(!planner.offeredVerbs(for: before, day: .selected).contains(.resetStreak), "\(name)")

            planner.resetStreak(id)
            #expect(planner.item(id) == before, "\(name)")
            #expect(planner.sync?.pending == 0, "\(name)")
            await drain(planner)
            let posts = await postCount(server)
            #expect(posts == 0, "\(name)")
        }
    }

    // MARK: Streaks

    /// The sheet's streak chip shows for a type that keeps a streak while
    /// Streaks is on: the payload's switch, which reads on when a server
    /// sends none, and the sample's, which is on.
    @Test func theStreakShowsForAHabitWhileStreaksIsOn() async throws {
        let sample = SamplePlanner(todayString: PlannerJSON.today, now: { PlannerJSON.noon })
        let sampleMeds = try #require(sample.items.first { $0.title == "Meds" })
        #expect(sample.showsStreak(for: sampleMeds))

        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload()),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2", streaksEnabled: false)),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-3", streaksEnabled: true)))
        let planner = await loaded(server)
        let water = try #require(planner.item(PlannerJSON.water))
        let groceries = try #require(planner.item(PlannerJSON.groceries))
        #expect(planner.settings.streaksEnabled)
        #expect(planner.showsStreak(for: water))
        #expect(!planner.showsStreak(for: groceries))

        await planner.refresh()
        #expect(!planner.settings.streaksEnabled)
        #expect(!planner.showsStreak(for: water))
        #expect(!planner.offeredVerbs(for: water, day: .selected).contains(.resetStreak))

        await planner.refresh()
        #expect(planner.showsStreak(for: water))
        #expect(planner.offeredVerbs(for: water, day: .selected).contains(.resetStreak))
    }

    // MARK: The banner

    /// A banner is said aloud unless the one up already says the same words
    /// as the same kind, so a paste that fails line by line is said once. It
    /// is still put up again each time, so its five seconds start over.
    @Test func aBannerIsSaidOnceWhileTheSameOneIsUp() {
        let text = "Couldn't reach dsul. Checking what was saved\u{2026}"
        let up = PlannerBanner(text, isError: true)
        #expect(SamplePlanner.speaks(text, isError: true, over: nil))
        #expect(!SamplePlanner.speaks(text, isError: true, over: up))
        #expect(SamplePlanner.speaks(text, isError: false, over: up))
        #expect(SamplePlanner.speaks("That change didn't save. Checking with the server\u{2026}", isError: true,
                                     over: up))

        let planner = SamplePlanner(todayString: PlannerJSON.today, now: { PlannerJSON.noon })
        planner.show(text, isError: true)
        let first = planner.banner
        planner.show(text, isError: true)
        #expect(planner.banner?.text == text)
        #expect(planner.banner?.id != first?.id)
    }

    // MARK: Words

    /// A custom item reads with the user's own noun once the payload names its
    /// type (lib/item-registry.ts `buildCustomTypeConfig`), and with its slug,
    /// capitalised, from a payload that doesn't.
    @Test func aCustomTypeTakesTheUsersOwnLabel() async throws {
        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload(itemTypes: [PlannerJSON.bookType],
                                                         extra: [PlannerJSON.bookJSON])),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2", extra: [PlannerJSON.bookJSON])))
        let planner = await loaded(server)
        let book = try #require(planner.item(PlannerJSON.book))
        let groceries = try #require(planner.item(PlannerJSON.groceries))

        #expect(planner.typeLabels["book"]?.label == "Book to read")
        let named = planner.caps(for: book)
        #expect(named.label == "Book to read")
        #expect(named.titlePlaceholder == "Add a book to read\u{2026}")
        #expect(named.deleteDescription("Piranesi")
            == "Moves \"Piranesi\" to Trash for 30 days, then deletes it for good.")
        #expect(planner.typeLabel(for: book) == "Book to read")
        #expect(planner.typeLabel(for: groceries) == "Task")

        await planner.refresh()
        #expect(planner.typeLabels.isEmpty)
        #expect(planner.typeLabel(for: book) == "Book")
        #expect(planner.caps(for: book).titlePlaceholder == "Add a book\u{2026}")
    }

    // MARK: Background time

    /// A title saved on the way out asks iOS for time until it lands.
    @Test func anEditAsksForBackgroundTimeUntilItLands() async {
        let background = FakeBackgroundTime()
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.groceries), .status(200, ok))
        let planner = makeLivePlanner(server, backgroundTime: background.time)
        await planner.refresh()

        planner.edit(PlannerJSON.groceries, .title("Big shop"))
        #expect(background.begun == [PlannerSync.backgroundTaskName])
        #expect(background.ended.isEmpty)
        await drain(planner)

        #expect(background.ended == [1])
    }
}
