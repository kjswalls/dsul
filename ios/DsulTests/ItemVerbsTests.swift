import DsulCore
import Foundation
import Testing
@testable import Dsul

/// The item sheet's verbs on a signed-in planner, against PlannerSyncTests'
/// fake server and its Thursday 2026-10-01 payload: each verb's optimistic
/// step and the body it sends, the gates that refuse (sending nothing), an
/// older server's shorter list of writes, and the sheet's one slot.
@MainActor
@Suite struct ItemVerbsTests {
    private let ok = "{\"ok\":true}"

    private func loaded(_ server: FakeServer) async -> SamplePlanner {
        let planner = makeLivePlanner(server)
        await planner.refresh()
        return planner
    }

    private func drain(_ planner: SamplePlanner) async {
        if let sync = planner.sync { await sync.drain() }
    }

    /// The first POST to `id`'s route, as JSON.
    private func sentBody(_ server: FakeServer, _ id: UUID) async -> [String: Any]? {
        let requests = await server.requests
        return bodyJSON(requests.first { $0.route == itemRoute(id) })
    }

    private func postCount(_ server: FakeServer) async -> Int {
        let requests = await server.requests
        return requests.filter { $0.route.hasPrefix("POST") }.count
    }

    // MARK: Tick

    @Test func theSheetsTickActsOnTheDayItIsHanded() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.water), .status(200, ok))
        let planner = await loaded(server)
        let wednesday = planner.today.adding(days: -1)

        planner.toggle(PlannerJSON.water, on: wednesday)   // 0 of 3 → 1 of 3 that day
        #expect(planner.item(PlannerJSON.water)?.dailyCounts["2026-09-30"] == 1)
        #expect(planner.item(PlannerJSON.water)?.dailyCounts[PlannerJSON.today] == 1)
        await drain(planner)

        let body = await sentBody(server, PlannerJSON.water)
        #expect(body?["action"] as? String == "complete")
        #expect(body?["date"] as? String == "2026-09-30")
        #expect(body?["done"] as? Bool == false)
        #expect(body?["count"] as? Int == 1)
    }

    @Test func theSheetsTickRefusesADayTheItemDoesNotFallOn() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [PlannerJSON.plantsJSON])))
        let planner = await loaded(server)
        let before = try #require(planner.item(PlannerJSON.plants))
        // The series starts on September 1.
        let august31 = try #require(DayString("2026-08-31"))
        #expect(planner.verbContext(for: before, on: august31).occurrence == .absent)

        planner.toggle(PlannerJSON.plants, on: august31)
        #expect(planner.item(PlannerJSON.plants) == before)
        #expect(planner.sync?.pending == 0)
        await drain(planner)
        let posts = await postCount(server)
        #expect(posts == 0)
    }

    // MARK: Skip and unskip

    @Test func skipTodaySkipsAHabitAtOnceAndSendsTheDay() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.water), .status(200, ok))
        let planner = await loaded(server)

        planner.skip(PlannerJSON.water, on: planner.today)
        let water = planner.item(PlannerJSON.water)
        #expect(water?.skippedDates == [PlannerJSON.today])
        #expect(water?.status == "skipped")
        #expect(water?.dailyCounts[PlannerJSON.today] == 1)   // the tally stays
        #expect(water.map { planner.isSkipped($0) } == true)
        await drain(planner)

        let body = await sentBody(server, PlannerJSON.water)
        #expect(body?["action"] as? String == "skip")
        #expect(body?["date"] as? String == PlannerJSON.today)
        #expect(body?["skipped"] as? Bool == true)
        #expect(body?.count == 3)
        #expect(planner.banner == nil)
    }

    @Test func unskipTodayOpensTheDayAgain() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.stretch), .status(200, ok))
        let planner = await loaded(server)

        planner.unskip(PlannerJSON.stretch, on: planner.today)
        let stretch = planner.item(PlannerJSON.stretch)
        #expect(stretch?.skippedDates.isEmpty == true)
        #expect(stretch?.status == "pending")
        #expect(stretch.map { planner.isSkipped($0) } == false)
        await drain(planner)

        let body = await sentBody(server, PlannerJSON.stretch)
        #expect(body?["action"] as? String == "skip")
        #expect(body?["date"] as? String == PlannerJSON.today)
        #expect(body?["skipped"] as? Bool == false)
        #expect(body?.count == 3)
    }

    /// The task status words are an external contract with no skip in them.
    @Test func skippingARecurringTaskLeavesItsStatusAlone() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [PlannerJSON.plantsJSON])))
        await server.on(itemRoute(PlannerJSON.plants), .status(200, ok))
        let planner = await loaded(server)

        planner.skip(PlannerJSON.plants, on: planner.today)
        let plants = planner.item(PlannerJSON.plants)
        #expect(plants?.skippedDates == [PlannerJSON.today])
        #expect(plants?.status == "pending")
        await drain(planner)

        let body = await sentBody(server, PlannerJSON.plants)
        #expect(body?["action"] as? String == "skip")
        #expect(body?["skipped"] as? Bool == true)
    }

    // MARK: Tomorrow and Reschedule

    @Test func tomorrowCarriesAOneOffAndSendsTheDay() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.groceries), .status(200, ok))
        let planner = await loaded(server)
        let groceries = try #require(planner.item(PlannerJSON.groceries))
        let ctx = planner.verbContext(for: groceries, day: .selected)
        #expect(planner.offeredVerbs(for: groceries, day: .selected) == [.tick, .pause, .nextDay, .reschedule])
        let target = nextDayOf(groceries, ctx)
        #expect(target == "2026-10-02")
        #expect(verbLabel(.nextDay, groceries, ctx) == "Move to tomorrow")

        planner.move(PlannerJSON.groceries, to: target)
        let moved = planner.item(PlannerJSON.groceries)
        #expect(moved?.startDate == "2026-10-02")
        #expect(moved?.timeBucket == "anytime")
        #expect(moved?.isScheduled == true)
        #expect(!planner.dayItems.contains { $0.id == PlannerJSON.groceries })
        await drain(planner)

        let body = await sentBody(server, PlannerJSON.groceries)
        #expect(body?["action"] as? String == "move")
        #expect(body?["date"] as? String == "2026-10-02")
        #expect(body?.count == 2)
    }

    @Test func rescheduleGivesAnUndatedItemADay() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.bank), .status(200, ok))
        let planner = await loaded(server)

        planner.move(PlannerJSON.bank, to: "2026-10-05")
        let bank = planner.item(PlannerJSON.bank)
        #expect(bank?.startDate == "2026-10-05")
        #expect(bank?.timeBucket == "anytime")    // a day view lists only rows with a bucket
        #expect(bank?.isScheduled == false)
        await drain(planner)

        let body = await sentBody(server, PlannerJSON.bank)
        #expect(body?["action"] as? String == "move")
        #expect(body?["date"] as? String == "2026-10-05")
    }

    /// A series takes Reschedule (lib/row-moves.ts `canReschedule`) but not
    /// Tomorrow: the picked day becomes its start. The sheet keeps the bar for
    /// the day's verbs and puts Reschedule behind ⋯.
    @Test func rescheduleMovesASeriesStartAndWaitsBehindMore() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [PlannerJSON.plantsJSON])))
        await server.on(itemRoute(PlannerJSON.plants), .status(200, ok))
        let planner = await loaded(server)
        let plants = try #require(planner.item(PlannerJSON.plants))
        let ctx = planner.verbContext(for: plants, day: .selected)
        let offered = planner.offeredVerbs(for: plants, day: .selected)
        #expect(offered == [.tick, .skip, .pause, .reschedule])
        let verbs = ItemSheetModel.verbs(plants, ctx, offered: offered)
        #expect(verbs.bar == [.tick, .skip, .pause])
        #expect(verbs.menu == [.pauseUntil, .reschedule])

        planner.move(PlannerJSON.plants, to: "2026-10-05")
        let moved = planner.item(PlannerJSON.plants)
        #expect(moved?.startDate == "2026-10-05")
        #expect(moved?.timeBucket == "morning")
        #expect(moved?.repeatFrequency == "daily")
        await drain(planner)

        let body = await sentBody(server, PlannerJSON.plants)
        #expect(body?["action"] as? String == "move")
        #expect(body?["date"] as? String == "2026-10-05")
    }

    // MARK: Pause and resume

    /// The stored zone is given, so today and the stamp don't depend on the
    /// simulator's zone.
    @Test func pauseStampsTheClockAndHidesTheItemToday() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(timezone: "America/New_York")))
        await server.on(itemRoute(PlannerJSON.water), .status(200, ok))
        let planner = await loaded(server)
        #expect(planner.timeZoneID == "America/New_York")
        #expect(planner.today.description == PlannerJSON.today)

        planner.pause(PlannerJSON.water, until: nil)
        let water = planner.item(PlannerJSON.water)
        #expect(water?.pausedAt == "2026-10-01T12:00:00.000Z")
        #expect(water?.pausedUntil == nil)
        #expect(!planner.dayItems.contains { $0.id == PlannerJSON.water })
        await drain(planner)

        let body = await sentBody(server, PlannerJSON.water)
        #expect(body?["action"] as? String == "pause")
        #expect(body?["paused"] as? Bool == true)
        #expect(body?["timeZone"] as? String == "America/New_York")
        #expect(body?["pausedUntil"] == nil)
        #expect(body?.count == 3)
    }

    @Test func pauseUntilSendsTheResumeDay() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(timezone: "America/New_York")))
        await server.on(itemRoute(PlannerJSON.groceries), .status(200, ok))
        let planner = await loaded(server)

        planner.pause(PlannerJSON.groceries, until: "2026-10-08")
        let groceries = planner.item(PlannerJSON.groceries)
        #expect(groceries?.pausedAt == "2026-10-01T12:00:00.000Z")
        #expect(groceries?.pausedUntil == "2026-10-08")
        await drain(planner)

        let body = await sentBody(server, PlannerJSON.groceries)
        #expect(body?["action"] as? String == "pause")
        #expect(body?["paused"] as? Bool == true)
        #expect(body?["pausedUntil"] as? String == "2026-10-08")
        #expect(body?["timeZone"] as? String == "America/New_York")
        #expect(body?.count == 4)
    }

    @Test func resumeEndsThePauseTodayAndKeepsWhenItBegan() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(timezone: "America/New_York",
                                                                       extra: [PlannerJSON.readingJSON])))
        await server.on(itemRoute(PlannerJSON.reading), .status(200, ok))
        let planner = await loaded(server)
        let reading = try #require(planner.item(PlannerJSON.reading))
        #expect(planner.offeredVerbs(for: reading, day: .selected).contains(.resume))
        #expect(!planner.offeredVerbs(for: reading, day: .selected).contains(.pause))
        #expect(!planner.dayItems.contains { $0.id == PlannerJSON.reading })

        planner.resume(PlannerJSON.reading)
        let resumed = planner.item(PlannerJSON.reading)
        #expect(resumed?.pausedUntil == PlannerJSON.today)
        #expect(resumed?.pausedAt == "2026-09-20T15:00:00+00:00")
        #expect(planner.dayItems.contains { $0.id == PlannerJSON.reading })
        await drain(planner)

        let body = await sentBody(server, PlannerJSON.reading)
        #expect(body?["action"] as? String == "pause")
        #expect(body?["paused"] as? Bool == false)
        #expect(body?["timeZone"] as? String == "America/New_York")
        #expect(body?["pausedUntil"] == nil)
        #expect(body?.count == 3)
    }

    // MARK: Refusals

    @Test func aVerbItsGateRefusesChangesNothingAndSendsNothing() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(
            timezone: "America/New_York", extra: [PlannerJSON.plantsJSON, PlannerJSON.bagsJSON])))
        let planner = await loaded(server)
        let before = planner.items
        let today = planner.today

        planner.skip(PlannerJSON.groceries, on: today)          // a one-off has no occurrence to skip
        planner.unskip(PlannerJSON.water, on: today)            // not skipped
        planner.skip(PlannerJSON.stretch, on: today)            // already skipped
        planner.move(PlannerJSON.water, to: "2026-10-02")       // a habit has no day
        planner.move(PlannerJSON.bags, to: "2026-10-02")        // a subtask shows only in its parent
        planner.pause(PlannerJSON.bags, until: nil)             // and isn't paused on its own
        planner.resume(PlannerJSON.water)                       // not paused
        planner.pause(PlannerJSON.groceries, until: "2026-10-01")  // a pause over before it starts
        planner.pause(PlannerJSON.groceries, until: "someday")
        planner.move(PlannerJSON.groceries, to: "someday")

        #expect(planner.items == before)
        #expect(planner.sync?.pending == 0)
        await drain(planner)
        let posts = await postCount(server)
        #expect(posts == 0)
    }

    @Test func aSubtaskOffersTheTickAloneAndTicksAsAOneOff() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [PlannerJSON.bagsJSON])))
        await server.on(itemRoute(PlannerJSON.bags), .status(200, ok))
        let planner = await loaded(server)
        let bags = try #require(planner.item(PlannerJSON.bags))
        #expect(planner.subtasks(of: PlannerJSON.groceries).map(\.id) == [PlannerJSON.bags])
        #expect(planner.offeredVerbs(for: bags, day: .selected) == [.tick])

        planner.toggle(PlannerJSON.bags, on: planner.actingDay(.selected))
        #expect(planner.item(PlannerJSON.bags)?.status == "completed")
        await drain(planner)

        let body = await sentBody(server, PlannerJSON.bags)
        #expect(body?["action"] as? String == "complete")
        #expect(body?["done"] as? Bool == true)
    }

    // MARK: An older server

    @Test func anOlderServerOffersTheTickAloneAndTakesNothingElse() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(writes: nil)))
        let planner = await loaded(server)
        #expect(planner.writes == nil)
        #expect(planner.canWrite("complete"))
        #expect(planner.canWrite("schedule"))
        #expect(!planner.canWrite("skip"))
        #expect(!planner.canWrite("move"))
        #expect(!planner.canWrite("pause"))
        let water = try #require(planner.item(PlannerJSON.water))
        let groceries = try #require(planner.item(PlannerJSON.groceries))
        #expect(planner.offeredVerbs(for: water, day: .selected) == [.tick])
        #expect(planner.offeredVerbs(for: groceries, day: .selected) == [.tick])

        planner.skip(PlannerJSON.water, on: planner.today)
        planner.pause(PlannerJSON.water, until: nil)
        planner.move(PlannerJSON.groceries, to: "2026-10-02")
        #expect(planner.item(PlannerJSON.water) == water)
        #expect(planner.item(PlannerJSON.groceries) == groceries)
        #expect(planner.sync?.pending == 0)
        let posts = await postCount(server)
        #expect(posts == 0)
    }

    @Test func theCurrentServerListsEveryWrite() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        let planner = await loaded(server)
        #expect(planner.writes == PlannerJSON.allWrites)
        let water = try #require(planner.item(PlannerJSON.water))
        #expect(planner.offeredVerbs(for: water, day: .selected) == [.tick, .skip, .pause])
    }

    // MARK: The sheet

    @Test func aRefusedVerbShowsTheBannerOverTheOpenSheetAndTakesTheServersAnswer() async {
        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-1")),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2")))
        await server.on(itemRoute(PlannerJSON.groceries), .status(409, "{\"error\":\"not_movable\"}"))
        let planner = await loaded(server)

        planner.open(PlannerJSON.groceries, day: .selected)
        #expect(planner.activeSheet == .item(PlannerJSON.groceries, day: .selected))
        planner.move(PlannerJSON.groceries, to: "2026-10-02")
        #expect(planner.item(PlannerJSON.groceries)?.startDate == "2026-10-02")   // optimistic
        await drain(planner)

        #expect(planner.banner?.isError == true)
        #expect(planner.banner?.text == "That change didn't save. Checking with the server…")
        #expect(planner.activeSheet == .item(PlannerJSON.groceries, day: .selected))
        #expect(planner.sync?.lastAppliedFetchedAt == "fetch-2")
        #expect(planner.item(PlannerJSON.groceries)?.startDate == PlannerJSON.today)   // the server's answer
    }

    @Test func theSheetClosesWhenAFetchNoLongerHasItsItem() async {
        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-1")),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2")),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-3", omitting: [PlannerJSON.bank])))
        let planner = await loaded(server)

        planner.open(PlannerJSON.groceries, day: .selected)
        await planner.refresh()
        #expect(planner.activeSheet == .item(PlannerJSON.groceries, day: .selected))   // still there

        planner.open(PlannerJSON.bank, day: .selected)
        #expect(planner.activeSheet == .item(PlannerJSON.bank, day: .selected))
        await planner.refresh()
        #expect(planner.sync?.lastAppliedFetchedAt == "fetch-3")
        #expect(planner.item(PlannerJSON.bank) == nil)
        #expect(planner.activeSheet == nil)
    }

    @Test func theSheetClosesWhenACaptureIsUndone() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(captureRoute, .offline)
        let planner = await loaded(server)

        planner.capture("Buy milk")
        let id = try #require(planner.braindump.last?.id)
        planner.open(id, day: .selected)
        #expect(planner.activeSheet == .item(id, day: .selected))
        await drain(planner)

        #expect(planner.item(id) == nil)
        #expect(planner.activeSheet == nil)
    }

    @Test func aMissingItemOpensNothing() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        let planner = await loaded(server)
        planner.open(PlannerJSON.plants, day: .selected)
        #expect(planner.activeSheet == nil)
    }

    // MARK: The clock

    /// A stored zone arriving with the first fetch moves today by the planner's
    /// clock, not the simulator's: noon UTC on October 1 is already October 2
    /// in Auckland.
    @Test func todayIsReadOffThePlannersClock() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(timezone: "Pacific/Auckland")))
        let planner = await loaded(server)
        #expect(planner.now() == PlannerJSON.noon)
        #expect(planner.today.description == "2026-10-02")
        #expect(planner.selectedDayString == "2026-10-02")
    }
}
