import DsulCore
import Foundation
import Testing
@testable import Dsul

/// The item sheet's title, notes and Delete on a signed-in planner, against
/// PlannerSyncTests' fake server and its Thursday 2026-10-01 payload: each
/// write's optimistic step and the body it sends, the gates that refuse
/// (sending nothing), an older server's shorter list of writes, what a
/// delete takes with it and which sheet it closes, a custom type's own words,
/// and the background time a write asks for. The rebase under a failed edit
/// or delete is PlannerSyncTests'; the sample's steps are SamplePlannerTests'.
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
