import DsulCore
import Foundation
import Testing
@testable import Dsul

/// Leftovers on Today on the iPhone (ghost rows phase 3): what the fold
/// shows, the switch that hides it, the five verbs as the planner's own
/// writes, and "All sorted, you got this" only after the person's own verb.
@MainActor
@Suite struct GhostFoldTests {
    private let ok = "{\"ok\":true}"
    /// A one-off left from Tuesday afternoon, at 3 PM.
    private let parcel = UUID(uuidString: "0b000000-0000-4000-8000-0000000000a1")!
    private var parcelRow: String {
        "{\"id\":\"\(lowerID(parcel))\",\"type\":\"task\",\"title\":\"Post the parcel\",\"status\":\"pending\","
            + "\"startDate\":\"2026-09-29\",\"timeBucket\":\"afternoon\",\"startTime\":\"15:00\","
            + "\"isScheduled\":true,\"order\":3,\"completedDates\":[],\"skippedDates\":[],\"dailyCounts\":{}}"
    }

    private func loaded(_ server: FakeServer) async -> SamplePlanner {
        let planner = makeLivePlanner(server)
        await planner.refresh()
        return planner
    }

    private func drain(_ planner: SamplePlanner) async {
        if let sync = planner.sync { await sync.drain() }
    }

    /// The sample's two leftovers, yesterday's-ish first: Bike service (two
    /// days back) above Pick up the dry cleaning (three), as DsulCore picks
    /// them, and none on another day.
    @Test func theSampleShowsItsLeftoversNewestFirst() {
        let planner = SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
        #expect(planner.ghostRows.map(\.title) == ["Bike service", "Pick up the dry cleaning"])
        #expect(planner.showsGhostFold)
        planner.select(planner.today.adding(days: 1))
        #expect(!planner.showsGhostFold)
    }

    /// Keep for today on each: today's date, its time kept, and once the last
    /// goes, the sorted line, which clears itself.
    @Test func keepingTheLastOneSaysAllSorted() throws {
        let planner = SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
        let ghosts = planner.ghostRows
        let bike = try #require(ghosts.first)
        planner.settleGhost(bike.id, .keep)
        let kept = try #require(planner.item(bike.id))
        #expect(kept.startDate == "2026-10-01")
        #expect(kept.startTime == bike.startTime)
        #expect(planner.ghostsSortedAt == nil)
        #expect(planner.ghostRows.count == 1)

        planner.settleGhost(ghosts[1].id, .tomorrow)
        #expect(planner.item(ghosts[1].id)?.startDate == "2026-10-02")
        #expect(planner.ghostRows.isEmpty)
        #expect(planner.ghostsSortedAt == PlannerJSON.noon)
        #expect(planner.showsGhostsSorted)
    }

    /// Keep all is a Keep for each, and empties the fold in one tap.
    @Test func keepAllKeepsEveryOne() {
        let planner = SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
        let ids = planner.ghostRows.map(\.id)
        planner.settleAllGhosts(.keep)
        #expect(ids.allSatisfy { planner.item($0)?.startDate == "2026-10-01" })
        #expect(planner.ghostRows.isEmpty)
        #expect(planner.showsGhostsSorted)
    }

    /// Keep all drops a stale clock time, as the web's `moveTasksToDate`
    /// does: the 3 PM parcel lands today in its afternoon, untimed. On the
    /// wire, the `move`, then the Time chip's write clearing the time. Keep
    /// for today on one keeps the time (above).
    @Test func keepAllDropsAStaleTime() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [parcelRow], goals: [])))
        await server.on(itemRoute(parcel), .status(200, ok))
        let planner = await loaded(server)
        #expect(planner.ghostRows.map(\.id) == [parcel])
        #expect(planner.ghostBulkEmptiesFold(.keep))

        planner.settleAllGhosts(.keep)
        let kept = try #require(planner.item(parcel))
        #expect(kept.startDate == planner.today.description)
        #expect(kept.timeBucket == "afternoon")
        #expect(kept.startTime == nil)
        #expect(planner.ghostRows.isEmpty)
        #expect(planner.showsGhostsSorted)
        await drain(planner)

        let posts = await server.requests.filter { $0.route == itemRoute(parcel) }
        var actions: [String] = []
        for post in posts {
            let body = try #require(post.body)
            let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
            actions.append(try #require(json["action"] as? String))
        }
        #expect(actions == ["move", "time"])
    }

    /// A dated row that is neither scheduled nor in a part of day still
    /// ghosts, and Send to sidebar takes it: its date cleared, the action
    /// alone on the wire, as the web's `unscheduleTask`. Move to Braindump's
    /// "already a braindump row" check is not the fold's.
    @Test func sendingALooseLeftoverToTheSidebarClearsItsDate() async throws {
        let loose = parcelRow
            .replacingOccurrences(of: "\"timeBucket\":\"afternoon\",\"startTime\":\"15:00\",", with: "")
            .replacingOccurrences(of: "\"isScheduled\":true", with: "\"isScheduled\":false")
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [loose], goals: [])))
        await server.on(itemRoute(parcel), .status(200, ok))
        let planner = await loaded(server)
        let ghost = try #require(planner.ghostRows.first)
        #expect(ghost.id == parcel)
        #expect(ghost.isScheduled != true && ghost.timeBucket == nil)
        #expect(planner.ghostOffers(.sidebar, ghost))
        #expect(planner.ghostVerbEmptiesFold(.sidebar, parcel))

        planner.settleGhost(parcel, .sidebar)
        #expect(planner.item(parcel)?.startDate == nil)
        #expect(planner.ghostRows.isEmpty)
        #expect(planner.showsGhostsSorted)
        await drain(planner)

        let posts = await server.requests.filter { $0.route == itemRoute(parcel) }
        #expect(posts.count == 1)
        let body = try #require(posts.first?.body)
        #expect(String(decoding: body, as: UTF8.self) == "{\"action\":\"unschedule\"}")
    }

    /// Only the verb that takes the last ghost empties the fold, which is
    /// when the views send the change unanimated.
    @Test func onlyTheLastGhostEmptiesTheFold() throws {
        let planner = SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
        let ghosts = planner.ghostRows
        #expect(ghosts.count == 2)
        #expect(!planner.ghostVerbEmptiesFold(.keep, ghosts[0].id))
        #expect(planner.ghostBulkEmptiesFold(.keep))
        planner.settleGhost(ghosts[0].id, .keep)
        #expect(planner.ghostVerbEmptiesFold(.keep, ghosts[1].id))
        #expect(!planner.ghostVerbEmptiesFold(.keep, ghosts[0].id))
    }

    /// Off (`leftoversOnToday` false, the account's `morning_check_enabled`):
    /// no fold. On, or a server too old to say: the leftover.
    @Test func theSwitchHidesTheFold() async {
        let off = FakeServer()
        await off.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [parcelRow], goals: [],
                                                                   leftoversOnToday: false)))
        #expect(await loaded(off).ghostRows.isEmpty)

        let on = FakeServer()
        await on.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [parcelRow], goals: [],
                                                                  leftoversOnToday: true)))
        #expect(await loaded(on).ghostRows.map(\.id) == [parcel])

        let older = FakeServer()
        await older.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [parcelRow], goals: [])))
        #expect(await loaded(older).ghostRows.map(\.id) == [parcel])
    }

    /// Goals unread (a server that couldn't read them): no fold, since a
    /// milestone must never ghost.
    @Test func noFoldWhileTheGoalsAreUnread() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [parcelRow])))
        let planner = await loaded(server)
        #expect(planner.milestoneIds == nil)
        #expect(planner.ghostRows.isEmpty)
    }

    /// Let it go: cancelled at once, kept in history, the action alone on the
    /// wire, and the fold empty with the sorted line.
    @Test func lettingGoSendsTheActionAlone() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [parcelRow], goals: [])))
        await server.on(itemRoute(parcel), .status(200, ok))
        let planner = await loaded(server)
        let before = try #require(planner.item(parcel))
        #expect(planner.ghostOffers(.letGo, before))

        planner.settleGhost(parcel, .letGo)
        #expect(planner.item(parcel) == lettingGo(before))
        #expect(planner.item(parcel)?.status == "cancelled")
        #expect(planner.ghostRows.isEmpty)
        #expect(planner.showsGhostsSorted)
        await drain(planner)

        let posts = await server.requests.filter { $0.route == itemRoute(parcel) }
        #expect(posts.count == 1)
        let body = try #require(posts.first?.body)
        #expect(String(decoding: body, as: UTF8.self) == "{\"action\":\"letGo\"}")
        #expect(planner.banner == nil)
    }

    /// The box marks a ghost done where it was: a `complete` on its own day,
    /// the status flipped at once, and the fold empty with the sorted line.
    @Test func theBoxMarksItDone() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [parcelRow], goals: [])))
        await server.on(itemRoute(parcel), .status(200, ok))
        let planner = await loaded(server)
        let before = try #require(planner.item(parcel))
        #expect(planner.ghostDoneEmptiesFold(parcel))

        planner.markGhostDone(parcel)
        #expect(planner.item(parcel)?.status == "completed")
        #expect(planner.item(parcel)?.startDate == before.startDate)
        #expect(planner.ghostRows.isEmpty)
        #expect(planner.showsGhostsSorted)
        await drain(planner)

        let posts = await server.requests.filter { $0.route == itemRoute(parcel) }
        #expect(posts.count == 1)
        let body = try #require(posts.first?.body)
        let sent = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(sent["action"] as? String == "complete")
        #expect(sent["date"] as? String == ghostDay(before))
    }

    /// A server older than `letGo` never offers it; the other verbs stay.
    @Test func anOlderServerOffersNoLetGo() async throws {
        let server = FakeServer()
        let writes = PlannerJSON.allWrites.filter { $0 != "letGo" }
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(writes: writes, extra: [parcelRow],
                                                                      goals: [])))
        let planner = await loaded(server)
        let ghost = try #require(planner.ghostRows.first)
        #expect(!planner.ghostOffers(.letGo, ghost))
        #expect(planner.ghostOffers(.keep, ghost))
        #expect(planner.ghostOffers(.sidebar, ghost))
        planner.letGo(parcel)
        #expect(planner.item(parcel) == ghost)
    }

    /// Send to sidebar is Move to Braindump's write, and a leftover moved
    /// some other way (here, a fetch) goes quietly: no sorted line.
    @Test func aPileEmptiedElsewhereGoesQuietly() async throws {
        let server = FakeServer()
        let gone = parcelRow.replacingOccurrences(of: "\"status\":\"pending\"", with: "\"status\":\"completed\"")
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-1", extra: [parcelRow], goals: [])),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2", extra: [gone], goals: [])))
        let planner = await loaded(server)
        #expect(planner.ghostRows.count == 1)
        await planner.refresh()
        #expect(planner.ghostRows.isEmpty)
        #expect(planner.ghostsSortedAt == nil)
        #expect(!planner.showsGhostsSorted)
    }

    /// The fold's words, the web's exactly.
    @Test func theWordsAreTheWebs() {
        #expect(GhostCopy.caption == "From earlier")
        #expect(GhostCopy.keepAll == "Keep all")
        #expect(GhostCopy.sendAll == "Send all to sidebar")
        #expect(GhostVerb.allCases.map(GhostCopy.word)
            == ["Keep for today", "Move to tomorrow", "Reschedule", "Send to sidebar", "Let it go"])
        #expect(GhostCopy.keptInHistory == "Kept in history")
        #expect(GhostCopy.sorted == "All sorted, you got this")
        #expect(GhostCopy.plannedFor("2026-10-15") == "Planned for Thu, Oct 15")
        #expect(GhostCopy.doneSeconds == 4)
    }
}
