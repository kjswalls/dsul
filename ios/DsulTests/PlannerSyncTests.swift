import DsulCore
import Foundation
import Testing
@testable import Dsul

// MARK: - Shared fakes (AuthStoreTests and ItemVerbsTests use them too)

/// The signed-in user every fake planner belongs to.
let testUserID = UUID(uuidString: "6f0c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f")!

func lowerID(_ id: UUID) -> String {
    return id.uuidString.lowercased()
}

/// A server in memory. Routes are keyed "METHOD /path?query", answered in
/// turn by the replies given to `on` (the last one repeats), and recorded in
/// the order they arrived. A closed route holds its requests until it opens;
/// a gated one lets them through one per `admit`.
actor FakeServer {
    enum Reply: Sendable {
        case status(Int, String)
        case offline
    }

    struct Request: Sendable {
        let route: String
        /// Header names lowercased.
        let headers: [String: String]
        let body: Data?
    }

    private var replies: [String: [Reply]] = [:]
    private var fallback: Reply = .status(404, "{\"error\":\"not_found\"}")
    private var closed: Set<String> = []
    private var gated: Set<String> = []
    private var tickets: [String: Int] = [:]
    private var delay: Duration = .zero
    private var inFlight = 0
    private(set) var requests: [Request] = []
    private(set) var maxInFlight = 0

    func on(_ route: String, _ answers: Reply...) {
        replies[route] = answers
    }

    func setFallback(_ reply: Reply) {
        fallback = reply
    }

    /// Every request takes this long to answer.
    func setDelay(_ value: Duration) {
        delay = value
    }

    func close(_ route: String) {
        closed.insert(route)
    }

    func open(_ route: String) {
        closed.remove(route)
    }

    /// Holds each request to `route` until `admit` lets exactly one through.
    func gate(_ route: String) {
        gated.insert(route)
    }

    func admit(_ route: String) {
        tickets[route, default: 0] += 1
    }

    func ungate(_ route: String) {
        gated.remove(route)
    }

    func count(_ route: String) -> Int {
        return requests.filter { $0.route == route }.count
    }

    func handle(_ request: URLRequest) async throws -> HTTPResult {
        let route = Self.route(of: request)
        var headers: [String: String] = [:]
        for (name, value) in request.allHTTPHeaderFields ?? [:] {
            headers[name.lowercased()] = value
        }
        requests.append(Request(route: route, headers: headers, body: request.httpBody))
        let name = registeredName(route)
        inFlight += 1
        maxInFlight = max(maxInFlight, inFlight)
        defer { inFlight -= 1 }
        if delay > .zero {
            try await Task.sleep(for: delay)
        }
        var waited = 0
        while closed.contains(name) && waited < 2000 {
            try await Task.sleep(for: .milliseconds(5))
            waited += 1
        }
        var waitedForTicket = 0
        while gated.contains(name) && (tickets[name] ?? 0) == 0 && waitedForTicket < 2000 {
            try await Task.sleep(for: .milliseconds(5))
            waitedForTicket += 1
        }
        if let left = tickets[name], left > 0 {
            tickets[name] = left - 1
        }
        let reply = nextReply(for: name)
        switch reply {
        case .offline:
            throw URLError(.notConnectedToInternet)
        case .status(let status, let body):
            return HTTPResult(status: status, data: Data(body.utf8))
        }
    }

    /// The name a test gave `route`: the route itself, or else its path without
    /// the query, for a request whose query carries something random (the
    /// nonce in /auth/v1/otp's redirect_to).
    private func registeredName(_ route: String) -> String {
        func known(_ name: String) -> Bool {
            return replies[name] != nil || closed.contains(name) || gated.contains(name)
        }
        if known(route) { return route }
        guard let mark = route.firstIndex(of: "?") else { return route }
        let bare = String(route[..<mark])
        return known(bare) ? bare : route
    }

    private func nextReply(for route: String) -> Reply {
        guard var queue = replies[route], !queue.isEmpty else { return fallback }
        let reply = queue.removeFirst()
        if queue.isEmpty { queue = [reply] }
        replies[route] = queue
        return reply
    }

    static func route(of request: URLRequest) -> String {
        let method = request.httpMethod ?? "GET"
        guard let url = request.url,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return method }
        var path = components.percentEncodedPath
        if let query = components.percentEncodedQuery { path += "?" + query }
        return method + " " + path
    }

    nonisolated var transport: Transport {
        return { request in
            return try await self.handle(request)
        }
    }
}

/// A token source that rotates its token when the server rejects it.
@MainActor
final class FakeTokens: AccessTokenSource {
    private(set) var current = "token-1"
    private(set) var refreshes = 0

    func accessToken(rejecting rejected: String?) async throws -> String {
        if let rejected, rejected == current {
            refreshes += 1
            current = "token-\(refreshes + 1)"
        }
        return current
    }
}

/// Polls `condition` for up to about five seconds.
@MainActor
func waitUntil(_ condition: @MainActor () async -> Bool) async -> Bool {
    for _ in 0..<1000 {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return false
}

/// A recorded request's JSON body.
func bodyJSON(_ request: FakeServer.Request?) -> [String: Any]? {
    guard let data = request?.body,
          let object = try? JSONSerialization.jsonObject(with: data, options: [])
    else { return nil }
    return object as? [String: Any]
}

/// GET /api/app/planner bodies (lib/app-api.ts), on Thursday 2026-10-01:
/// a one-off task on the day, a habit counted three times a day (once so
/// far), a habit skipped today, and a braindump thought; `extra` adds rows
/// (`plants`, `bags`, `reading`) and `omitting` drops some. No stored timezone
/// unless one is given, so the pinned day stays put. `writes` is the current
/// server's list unless a test plays an older server (nil).
enum PlannerJSON {
    static let today = "2026-10-01"
    /// Noon UTC on `today`: the live planner's clock. It is 2026-10-01 from
    /// UTC-12 to UTC+11, so the simulator's zone can't move the day.
    static let noon = Date(timeIntervalSince1970: 1_790_856_000)
    static let groceries = UUID(uuidString: "0d000000-0000-4000-8000-000000000001")!
    static let water = UUID(uuidString: "0d000000-0000-4000-8000-000000000002")!
    static let stretch = UUID(uuidString: "0d000000-0000-4000-8000-000000000003")!
    static let bank = UUID(uuidString: "0d000000-0000-4000-8000-000000000004")!
    static let plants = UUID(uuidString: "0d000000-0000-4000-8000-000000000005")!
    static let bags = UUID(uuidString: "0d000000-0000-4000-8000-000000000006")!
    static let reading = UUID(uuidString: "0d000000-0000-4000-8000-000000000007")!

    /// Every item write the server takes (lib/app-api.ts `ITEM_WRITES`).
    static let allWrites = ["complete", "schedule", "skip", "move", "pause"]

    /// A task that repeats daily from September, on the morning.
    static var plantsJSON: String {
        return "{\"id\":\"\(lowerID(plants))\",\"type\":\"task\",\"title\":\"Water the plants\","
            + "\"status\":\"pending\",\"startDate\":\"2026-09-01\",\"timeBucket\":\"morning\","
            + "\"isScheduled\":true,\"repeatFrequency\":\"daily\",\"order\":3,"
            + "\"completedDates\":[],\"skippedDates\":[],\"dailyCounts\":{}}"
    }

    /// A subtask of Groceries.
    static var bagsJSON: String {
        return "{\"id\":\"\(lowerID(bags))\",\"type\":\"task\",\"title\":\"Bring the bags\",\"status\":\"pending\","
            + "\"isScheduled\":false,\"order\":4,\"parentItemId\":\"\(lowerID(groceries))\","
            + "\"completedDates\":[],\"skippedDates\":[],\"dailyCounts\":{}}"
    }

    /// A daily habit paused since September 20, with no end.
    static var readingJSON: String {
        return "{\"id\":\"\(lowerID(reading))\",\"type\":\"habit\",\"title\":\"Read\",\"status\":\"pending\","
            + "\"timeBucket\":\"evening\",\"repeatFrequency\":\"daily\",\"streak\":5,"
            + "\"pausedAt\":\"2026-09-20T15:00:00+00:00\","
            + "\"completedDates\":[],\"skippedDates\":[],\"dailyCounts\":{}}"
    }

    static func payload(userId: UUID = testUserID, fetchedAt: String = "fetch-1", groceriesDone: Bool = false,
                        timezone: String? = nil, writes: [String]? = PlannerJSON.allWrites,
                        omitting: Set<UUID> = [], extra: [String] = []) -> String {
        let status = groceriesDone ? "completed" : "pending"
        let zone: String = timezone.map { "\"\($0)\"" } ?? "null"
        let groceriesRow: String =
            "{\"id\":\"\(lowerID(groceries))\",\"type\":\"task\",\"title\":\"Groceries\",\"status\":\"\(status)\","
                + "\"startDate\":\"\(today)\",\"timeBucket\":\"anytime\",\"isScheduled\":true,\"order\":1,"
                + "\"completedDates\":[],\"skippedDates\":[],\"dailyCounts\":{}}"
        let waterRow: String =
            "{\"id\":\"\(lowerID(water))\",\"type\":\"habit\",\"title\":\"Water\",\"status\":\"pending\","
                + "\"timeBucket\":\"anytime\",\"repeatFrequency\":\"daily\",\"timesPerDay\":3,\"streak\":2,"
                + "\"completedDates\":[],\"skippedDates\":[],\"dailyCounts\":{\"\(today)\":1}}"
        let stretchRow: String =
            "{\"id\":\"\(lowerID(stretch))\",\"type\":\"habit\",\"title\":\"Stretch\",\"status\":\"skipped\","
                + "\"timeBucket\":\"morning\",\"repeatFrequency\":\"daily\",\"streak\":0,"
                + "\"completedDates\":[],\"skippedDates\":[\"\(today)\"],\"dailyCounts\":{}}"
        let bankRow: String =
            "{\"id\":\"\(lowerID(bank))\",\"type\":\"task\",\"title\":\"Call the bank\",\"status\":\"pending\","
                + "\"isScheduled\":false,\"order\":2,\"completedDates\":[],\"skippedDates\":[],\"dailyCounts\":{}}"
        let rows: [(UUID, String)] = [(groceries, groceriesRow), (water, waterRow), (stretch, stretchRow),
                                      (bank, bankRow)]
        let kept: [String] = rows.filter { !omitting.contains($0.0) }.map { $0.1 }
        let items: [String] = kept + extra
        var json = "{\"v\":1,\"userId\":\"\(lowerID(userId))\",\"fetchedAt\":\"\(fetchedAt)\","
        json += "\"settings\":{\"timezone\":\(zone),\"showCompletedTasks\":true},"
        if let writes {
            let quoted: [String] = writes.map { "\"\($0)\"" }
            json += "\"writes\":[" + quoted.joined(separator: ",") + "],"
        }
        json += "\"items\":[" + items.joined(separator: ",") + "],"
        json += "\"projects\":[],\"routines\":[],\"seasons\":[]}"
        return json
    }
}

let plannerRoute = "GET /api/app/planner"
let captureRoute = "POST /api/app/items"

func itemRoute(_ id: UUID) -> String {
    return "POST /api/app/items/" + lowerID(id)
}

/// A signed-in planner talking to `server`, its day pinned to 2026-10-01 and
/// its clock to noon UTC that day (`PlannerJSON.noon`), so a stored zone
/// arriving with a fetch, or a pause, reads the same day.
@MainActor
func makeLivePlanner(_ server: FakeServer, tokens: FakeTokens? = nil,
                     isDragging: @escaping @MainActor () -> Bool = { false },
                     now: @escaping () -> Date = { PlannerJSON.noon }) -> SamplePlanner {
    let source: FakeTokens = tokens ?? FakeTokens()
    let api = APIClient(origin: URL(string: "https://dsul.test")!, tokens: source, transport: server.transport)
    return SamplePlanner(userId: testUserID, api: api, isDragging: isDragging, todayString: PlannerJSON.today,
                         now: now)
}

/// Whether a drag is on, for a planner's `isDragging`.
@MainActor
final class DragFlag {
    var on = false
}

// MARK: - PlannerSync

@MainActor
@Suite struct PlannerSyncTests {
    private let ok = "{\"ok\":true}"

    private func loaded(_ server: FakeServer, tokens: FakeTokens? = nil) async -> SamplePlanner {
        let planner = makeLivePlanner(server, tokens: tokens)
        await planner.refresh()
        return planner
    }

    private func drain(_ planner: SamplePlanner) async {
        if let sync = planner.sync { await sync.drain() }
    }

    private func isDone(_ planner: SamplePlanner, _ id: UUID) -> Bool {
        guard let item = planner.item(id) else { return false }
        return planner.isDone(item)
    }

    @Test func theFirstFetchFillsThePlanner() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        let planner = makeLivePlanner(server)
        #expect(!planner.hasLoaded)
        #expect(planner.isLive)
        await planner.refresh()
        #expect(planner.hasLoaded)
        #expect(planner.items.count == 4)
        #expect(planner.braindump.map(\.title) == ["Call the bank"])
        #expect(Set(planner.dayItems.map(\.title)) == ["Groceries", "Water", "Stretch"])
        let requests = await server.requests
        #expect(requests.count == 1)
        #expect(requests.first?.headers["authorization"] == "Bearer token-1")
    }

    @Test func writesGoOutOneAtATimeInTheOrderTheyWereMade() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.groceries), .status(200, ok))
        let planner = await loaded(server)
        await server.setDelay(.milliseconds(20))

        planner.toggle(PlannerJSON.groceries)
        planner.toggle(PlannerJSON.groceries)
        planner.toggle(PlannerJSON.groceries)
        #expect(planner.sync?.pending == 3)
        await drain(planner)

        let requests = await server.requests
        let posts = requests.filter { $0.route == itemRoute(PlannerJSON.groceries) }
        let dones: [Bool?] = posts.map { bodyJSON($0)?["done"] as? Bool }
        #expect(dones == [true, false, true])
        // A one-off task sends no count.
        #expect(posts.allSatisfy { bodyJSON($0)?["count"] == nil })
        let maxInFlight = await server.maxInFlight
        #expect(maxInFlight == 1)
        #expect(isDone(planner, PlannerJSON.groceries))
        #expect(planner.sync?.pending == 0)
    }

    @Test func aFetchAWriteRacedIsDiscardedAndMadeAgain() async {
        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-1")),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2-stale")),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-3", groceriesDone: true)))
        await server.on(itemRoute(PlannerJSON.groceries), .status(200, ok))
        let planner = await loaded(server)
        guard let sync = planner.sync else {
            Issue.record("a live planner has a sync")
            return
        }
        #expect(sync.lastAppliedFetchedAt == "fetch-1")

        // The GET leaves, the tick is made and lands, then the GET answers
        // with what the server held before the tick.
        await server.close(plannerRoute)
        let fetch = Task { await planner.refresh() }
        let sent = await waitUntil { await server.count(plannerRoute) == 2 }
        #expect(sent)
        planner.toggle(PlannerJSON.groceries)
        let landed = await waitUntil { sync.pending == 0 }
        #expect(landed)
        await server.open(plannerRoute)
        await fetch.value
        await sync.drain()

        #expect(sync.appliedFetches == 2)
        #expect(sync.lastAppliedFetchedAt == "fetch-3")
        let gets = await server.count(plannerRoute)
        #expect(gets == 3)
        #expect(isDone(planner, PlannerJSON.groceries))
    }

    @Test func aRefusedWriteShowsABannerAndTakesTheServersAnswer() async {
        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-1")),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2")))
        await server.on(itemRoute(PlannerJSON.groceries), .status(409, "{\"error\":\"conflict\"}"))
        let planner = await loaded(server)

        planner.toggle(PlannerJSON.groceries)
        #expect(isDone(planner, PlannerJSON.groceries))   // optimistic
        await drain(planner)

        #expect(planner.banner?.isError == true)
        #expect(planner.sync?.lastAppliedFetchedAt == "fetch-2")
        let gets = await server.count(plannerRoute)
        #expect(gets == 2)
        #expect(!isDone(planner, PlannerJSON.groceries))  // the server's answer
    }

    @Test func aFailedWriteIsUndoneWhenTheRefetchFailsToo() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(itemRoute(PlannerJSON.groceries), .offline)
        let planner = await loaded(server)

        planner.toggle(PlannerJSON.groceries)
        #expect(isDone(planner, PlannerJSON.groceries))
        await drain(planner)

        #expect(!isDone(planner, PlannerJSON.groceries))
        #expect(planner.banner?.text == "Couldn't reach dsul, so that change was undone.")
        #expect(planner.hasLoaded)
    }

    @Test func aCaptureThatNeverLandedLeavesTheBraindump() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(captureRoute, .offline)
        let planner = await loaded(server)

        planner.capture("Buy milk")
        #expect(planner.braindump.last?.title == "Buy milk")
        await drain(planner)
        #expect(!planner.braindump.contains { $0.title == "Buy milk" })
        #expect(planner.braindump.map(\.title) == ["Call the bank"])
    }

    /// A landed write moots a failure in its own slot only: the tick that
    /// landed says nothing about the carry that didn't, and the carry's
    /// revert leaves the tick alone.
    @Test func aFailedCarryIsUndoneThoughATickThatLandedCameAfterIt() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(itemRoute(PlannerJSON.groceries), .offline, .status(200, ok))
        let planner = await loaded(server)

        planner.move(PlannerJSON.groceries, to: "2026-10-02")   // never reaches the server
        planner.toggle(PlannerJSON.groceries)                  // lands
        #expect(planner.item(PlannerJSON.groceries)?.startDate == "2026-10-02")
        await drain(planner)

        let groceries = planner.item(PlannerJSON.groceries)
        #expect(groceries?.startDate == PlannerJSON.today)
        #expect(groceries?.status == "completed")
        #expect(planner.banner?.text == "Couldn't reach dsul, so that change was undone.")
        let posts = await server.count(itemRoute(PlannerJSON.groceries))
        #expect(posts == 2)
    }

    /// The same slot: the later tick's end state stands, so the earlier
    /// failure is not put back over it.
    @Test func aFailedTickIsMootOnceALaterTickOnTheSameDayLands() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(itemRoute(PlannerJSON.water), .offline, .status(200, ok))
        let planner = await loaded(server)

        planner.toggle(PlannerJSON.water)   // 1 of 3 → 2 of 3, never reaches the server
        planner.toggle(PlannerJSON.water)   // 2 of 3 → 3 of 3, done, lands
        await drain(planner)

        #expect(planner.item(PlannerJSON.water)?.dailyCounts[PlannerJSON.today] == 3)
        #expect(isDone(planner, PlannerJSON.water))
    }

    @Test func aSlotPutsBackItsOwnFieldsAndNoOthers() {
        let day = "2026-10-01"
        let before = SampleItem(id: PlannerJSON.water, type: "habit", title: "Water", status: "pending",
                                startDate: nil, timeBucket: "anytime", repeatFrequency: "daily", streak: 2,
                                currentDayCount: 1, dailyCounts: [day: 1])
        var now = before
        now.status = "done"
        now.completedDates = [day]
        now.streak = 3
        now.dailyCounts[day] = 3
        now.currentDayCount = 3
        now.pausedAt = "2026-10-01T12:00:00.000Z"

        let day1 = PlannerSync.WriteSlot.day(day).restoring(now, from: before)
        #expect(day1.completedDates.isEmpty)
        #expect(day1.streak == 2)
        #expect(day1.status == "pending")
        #expect(day1.dailyCounts[day] == 1)
        #expect(day1.currentDayCount == 1)
        #expect(day1.pausedAt == "2026-10-01T12:00:00.000Z")   // another slot's field

        let otherDay = PlannerSync.WriteSlot.day("2026-09-30").restoring(now, from: before)
        #expect(otherDay.completedDates == [day])
        #expect(otherDay.streak == 3)

        let pause = PlannerSync.WriteSlot.pause.restoring(now, from: before)
        #expect(pause.pausedAt == nil)
        #expect(pause.completedDates == [day])

        var moved = before
        moved.startDate = "2026-10-02"
        moved.timeBucket = "evening"
        moved.status = "done"
        let placement = PlannerSync.WriteSlot.placement.restoring(moved, from: before)
        #expect(placement.startDate == nil)
        #expect(placement.timeBucket == "anytime")
        #expect(placement.status == "done")

        #expect(PlannerSync.WriteSlot.create.restoring(now, from: before) == before)
    }

    @Test func eachWriteNamesItsSlot() {
        let id = PlannerJSON.groceries
        #expect(PlannerSync.Write.complete(id: id, date: "2026-10-01", done: true, count: nil).slot == .day("2026-10-01"))
        #expect(PlannerSync.Write.skip(id: id, date: "2026-10-01", skipped: true).slot == .day("2026-10-01"))
        #expect(PlannerSync.Write.schedule(id: id, date: "2026-10-01", startTime: "09:00").slot == .placement)
        #expect(PlannerSync.Write.move(id: id, date: "2026-10-02").slot == .placement)
        #expect(PlannerSync.Write.pause(id: id, paused: true, pausedUntil: nil, timeZone: "UTC").slot == .pause)
        #expect(PlannerSync.Write.capture(id: id, title: "Buy milk").slot == .create)
        #expect(PlannerSync.Write.move(id: id, date: "2026-10-02").itemId == id)
    }

    @Test func aCaptureSendsItsOwnIdLowercase() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(captureRoute, .status(201, ok))
        let planner = await loaded(server)

        planner.capture("  Buy milk ")
        await drain(planner)

        let requests = await server.requests
        let post = requests.first { $0.route == captureRoute }
        let body = bodyJSON(post)
        let sentID = body?["id"] as? String
        #expect(sentID != nil)
        #expect(sentID == sentID?.lowercased())
        #expect(sentID.flatMap { UUID(uuidString: $0) } == planner.braindump.last?.id)
        #expect(body?["title"] as? String == "Buy milk")
        #expect(body?.count == 2)
        #expect(post?.headers["content-type"] == "application/json")
        #expect(planner.banner == nil)
    }

    @Test func aCountedHabitSendsItsNewTally() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.water), .status(200, ok))
        let planner = await loaded(server)

        planner.toggle(PlannerJSON.water)   // 1 of 3 → 2 of 3, not yet done
        await drain(planner)

        let requests = await server.requests
        let post = requests.first { $0.route == itemRoute(PlannerJSON.water) }
        let body = bodyJSON(post)
        #expect(body?["action"] as? String == "complete")
        #expect(body?["date"] as? String == PlannerJSON.today)
        #expect(body?["done"] as? Bool == false)
        #expect(body?["count"] as? Int == 2)
        #expect(body?.count == 4)
        #expect(planner.item(PlannerJSON.water)?.dailyCounts[PlannerJSON.today] == 2)
        #expect(!isDone(planner, PlannerJSON.water))
    }

    @Test func aSkippedRowSendsNothing() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        let planner = await loaded(server)
        let before = planner.item(PlannerJSON.stretch)
        #expect(before.map { planner.isSkipped($0) } == true)

        planner.toggle(PlannerJSON.stretch)
        #expect(planner.sync?.pending == 0)
        await drain(planner)

        let requests = await server.requests
        #expect(requests.filter { $0.route.hasPrefix("POST") }.isEmpty)
        #expect(planner.item(PlannerJSON.stretch) == before)
    }

    @Test func aDropSendsTheDayAndTheTime() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.bank), .status(200, ok))
        let planner = await loaded(server)

        planner.schedule(PlannerJSON.bank, startMin: 9 * 60 + 30)
        #expect(!planner.braindump.contains { $0.id == PlannerJSON.bank })
        await drain(planner)

        let requests = await server.requests
        let body = bodyJSON(requests.first { $0.route == itemRoute(PlannerJSON.bank) })
        #expect(body?["action"] as? String == "schedule")
        #expect(body?["date"] as? String == PlannerJSON.today)
        #expect(body?["startTime"] as? String == "09:30")
        #expect(planner.isScheduled(PlannerJSON.bank))
    }

    @Test func anotherUsersPlannerIsNeverShown() async {
        let server = FakeServer()
        let someoneElse = UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(userId: someoneElse)))
        let planner = makeLivePlanner(server)
        await planner.refresh()

        #expect(!planner.hasLoaded)
        #expect(planner.items.isEmpty)
        #expect(planner.loadError != nil)
        #expect(planner.sync?.appliedFetches == 0)
    }

    @Test func a401RefreshesOnceAndRetries() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.groceries),
                        .status(401, "{\"error\":\"unauthorized\"}"), .status(200, ok))
        let tokens = FakeTokens()
        let planner = await loaded(server, tokens: tokens)

        planner.toggle(PlannerJSON.groceries)
        await drain(planner)

        let requests = await server.requests
        let auths: [String?] = requests.filter { $0.route == itemRoute(PlannerJSON.groceries) }
            .map { $0.headers["authorization"] }
        #expect(auths == ["Bearer token-1", "Bearer token-2"])
        #expect(tokens.refreshes == 1)
        #expect(planner.banner == nil)
        #expect(isDone(planner, PlannerJSON.groceries))
    }

    @Test func aFetchThatLandsMidDragWaitsForTheDrop() async {
        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-1")),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2")))
        let flag = DragFlag()
        let planner = makeLivePlanner(server, isDragging: { flag.on })
        await planner.refresh()
        guard let sync = planner.sync else {
            Issue.record("a live planner has a sync")
            return
        }
        #expect(sync.appliedFetches == 1)

        flag.on = true
        await planner.refresh()
        #expect(sync.appliedFetches == 1)

        flag.on = false
        let applied = await waitUntil { sync.appliedFetches == 2 }
        #expect(applied)
        #expect(sync.lastAppliedFetchedAt == "fetch-2")
    }

    @Test func nothingIsSentAfterSignOut() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        let planner = await loaded(server)

        planner.stopSync()
        planner.toggle(PlannerJSON.groceries)
        await drain(planner)

        let requests = await server.requests
        #expect(requests.filter { $0.route.hasPrefix("POST") }.isEmpty)
    }

    @Test func aFetchRacedOverAndOverStillLandsInTheEnd() async {
        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-1")),
                        .status(200, PlannerJSON.payload(fetchedAt: "stale-1")),
                        .status(200, PlannerJSON.payload(fetchedAt: "stale-2")),
                        .status(200, PlannerJSON.payload(fetchedAt: "stale-3")),
                        .status(200, PlannerJSON.payload(fetchedAt: "stale-4")),
                        .status(200, PlannerJSON.payload(fetchedAt: "final", groceriesDone: true)))
        await server.on(itemRoute(PlannerJSON.water), .status(409, "{\"error\":\"conflict\"}"))
        await server.on(itemRoute(PlannerJSON.groceries), .status(200, ok))
        let planner = await loaded(server)
        guard let sync = planner.sync else {
            Issue.record("a live planner has a sync")
            return
        }
        sync.racePause = .milliseconds(5)

        // Each GET from here waits to be let through, and a tick is made and
        // lands while each of the first four is out. The first tick is
        // refused, so its guess must still give way to the server's answer.
        await server.gate(plannerRoute)
        let fetch = Task { await planner.refresh() }
        for round in 0..<4 {
            let sent = await waitUntil { await server.count(plannerRoute) == 2 + round }
            #expect(sent)
            if round == 0 {
                planner.toggle(PlannerJSON.water)       // 1 of 3 → 2 of 3, refused
            } else {
                planner.toggle(PlannerJSON.groceries)   // done, undone, done
            }
            let landed = await waitUntil { sync.pending == 0 }
            #expect(landed)
            await server.admit(plannerRoute)
        }
        await server.ungate(plannerRoute)
        await fetch.value
        await sync.drain()

        #expect(sync.appliedFetches == 2)
        #expect(sync.lastAppliedFetchedAt == "final")
        let gets = await server.count(plannerRoute)
        #expect(gets == 6)
        #expect(planner.item(PlannerJSON.water)?.dailyCounts[PlannerJSON.today] == 1)
        #expect(isDone(planner, PlannerJSON.groceries))
    }

    @Test func aRetryAfterAFailedFirstLoadShowsTheSpinnerAgain() async {
        let server = FakeServer()
        await server.on(plannerRoute, .offline, .status(200, PlannerJSON.payload()))
        let planner = makeLivePlanner(server)
        await planner.refresh()
        #expect(!planner.hasLoaded)
        #expect(planner.loadError != nil)

        await server.close(plannerRoute)
        let retry = Task { await planner.refresh() }
        let sent = await waitUntil { await server.count(plannerRoute) == 2 }
        #expect(sent)
        #expect(planner.loadError == nil)   // the spinner, not the old error
        await server.open(plannerRoute)
        await retry.value

        #expect(planner.hasLoaded)
        #expect(planner.loadError == nil)
        #expect(planner.items.count == 4)
    }

    @Test func nowIsReadInTheStoredZone() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(timezone: "America/Los_Angeles")))
        let planner = makeLivePlanner(server)
        await planner.refresh()
        #expect(planner.timeZoneID == "America/Los_Angeles")

        // 13:00 UTC on 2026-10-02 is 6:00 in Los Angeles (PDT), whatever zone
        // the simulator is in.
        let instant = Date(timeIntervalSince1970: 1_790_946_000)
        #expect(planner.minuteOfDay(instant) == 6 * 60)
    }

    // MARK: The drag's hold on fetched data

    @Test func aDragHoldLapsesWhenItsEndNeverComes() async {
        let hold = DragHold(lease: .milliseconds(50))
        hold.hold()
        #expect(hold.isHeld)
        let lapsed = await waitUntil { !hold.isHeld }
        #expect(lapsed)
        // A late update can't take back a hold that lapsed or was let go.
        hold.renew()
        #expect(!hold.isHeld)
        hold.hold()
        hold.releaseNow()
        hold.renew()
        #expect(!hold.isHeld)
    }

    @Test func aDragHoldLastsWhileTheDragMoves() async {
        let hold = DragHold(lease: .milliseconds(1500))
        hold.hold()
        try? await Task.sleep(for: .milliseconds(900))
        hold.renew()
        try? await Task.sleep(for: .milliseconds(900))
        // Past the first lease, renewed inside it.
        #expect(hold.isHeld)

        // The end of the session lets go a moment later, and an update in
        // between doesn't renew it.
        hold.release(after: .milliseconds(20))
        hold.renew()
        let released = await waitUntil { !hold.isHeld }
        #expect(released)
    }
}
