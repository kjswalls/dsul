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

/// A clock a test moves by hand, for a planner's `now` (and so its sync's).
final class TestClock {
    var now: Date

    init(_ now: Date) {
        self.now = now
    }
}

/// Background time as a test sees it: each time asked for, by name, each
/// token given back, and iOS taking the time back early (`expire`).
@MainActor
final class FakeBackgroundTime {
    private(set) var begun: [String] = []
    private(set) var ended: [Int] = []
    private var expiry: (@MainActor @Sendable () -> Void)?

    var time: BackgroundTime {
        return BackgroundTime(
            begin: { [self] name, expired in
                begun.append(name)
                expiry = expired
                return begun.count
            },
            end: { [self] token in
                ended.append(token)
            }
        )
    }

    /// iOS ending the time before the writes drained.
    func expire() {
        expiry?()
    }
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
/// (`plants`, `bags`, `reading`, `book`) and `omitting` drops some. No stored
/// timezone unless one is given, so the pinned day stays put. `writes` is the
/// current server's list unless a test plays an older server (nil);
/// `itemTypes` names the user's own types, left out (an older server) unless
/// given.
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
    static let book = UUID(uuidString: "0d000000-0000-4000-8000-000000000009")!

    /// Every item write the server takes (lib/app-api.ts `ITEM_WRITES`), in
    /// its order.
    static let allWrites = ["complete", "schedule", "skip", "move", "pause", "title", "notes", "delete"]

    /// The user's own type that `book` is, as they named it.
    static let bookType = ItemTypeLabel(name: "book", label: "Book to read", labelPlural: "Books to read")

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

    /// A custom item (`bookType`) in the braindump.
    static var bookJSON: String {
        return "{\"id\":\"\(lowerID(book))\",\"type\":\"custom\",\"customType\":\"book\","
            + "\"title\":\"Piranesi\",\"status\":\"pending\",\"isScheduled\":false,\"order\":5,"
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
                        itemTypes: [ItemTypeLabel]? = nil, omitting: Set<UUID> = [],
                        extra: [String] = []) -> String {
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
        if let itemTypes {
            let named: [String] = itemTypes.map {
                "{\"name\":\"\($0.name)\",\"label\":\"\($0.label)\",\"labelPlural\":\"\($0.labelPlural)\"}"
            }
            json += "\"itemTypes\":[" + named.joined(separator: ",") + "],"
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
/// arriving with a fetch, or a pause, reads the same day. It asks for no
/// background time unless a test hands it some.
@MainActor
func makeLivePlanner(_ server: FakeServer, tokens: FakeTokens? = nil,
                     isDragging: @escaping @MainActor () -> Bool = { false },
                     now: @escaping () -> Date = { PlannerJSON.noon },
                     backgroundTime: BackgroundTime = .foregroundOnly) -> SamplePlanner {
    let source: FakeTokens = tokens ?? FakeTokens()
    let api = APIClient(origin: URL(string: "https://dsul.test")!, tokens: source, transport: server.transport)
    return SamplePlanner(userId: testUserID, api: api, isDragging: isDragging, todayString: PlannerJSON.today,
                         now: now, backgroundTime: backgroundTime)
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

    /// Worked case 1 (design §3.5): the item goes back to before the carry
    /// that failed, with the tick that landed after it played again on top,
    /// so the tick is kept and the carry undone.
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

    /// The later tick that landed is played again on the day from before the
    /// failed one, so the day ends at the server's 3 of 3.
    @Test func aFailedTickGivesWayToALaterTickOnTheSameDayThatLanded() async {
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

    /// A carry keeps the time a drop set, so a carry that landed after a drop
    /// that didn't is played on the item from before the drop: the server
    /// carried an unscheduled row, which keeps no time and lands on Anytime.
    @Test func aFailedDropIsUndoneUnderACarryThatLanded() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(itemRoute(PlannerJSON.bank), .offline, .status(200, ok))
        let planner = await loaded(server)

        planner.schedule(PlannerJSON.bank, startMin: 9 * 60)   // never reaches the server
        planner.move(PlannerJSON.bank, to: "2026-10-02")       // lands
        #expect(planner.item(PlannerJSON.bank)?.startTime == "09:00")
        await drain(planner)

        let bank = planner.item(PlannerJSON.bank)
        #expect(bank?.isScheduled == false)
        #expect(bank?.startTime == nil)
        #expect(bank?.timeBucket == "anytime")
        #expect(bank?.startDate == "2026-10-02")
        let posts = await server.count(itemRoute(PlannerJSON.bank))
        #expect(posts == 2)
    }

    /// A one-off's tick sets its status, which is the whole item's, whatever
    /// day it was sent with: two failed ticks on different days go back to
    /// before the first, not to before the second.
    @Test func twoFailedTicksOfAOneOffOnDifferentDaysGoBackToTheFirst() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(itemRoute(PlannerJSON.groceries), .offline)
        let planner = await loaded(server)
        let friday = planner.today.adding(days: 1)

        planner.toggle(PlannerJSON.groceries, on: planner.today)   // done
        planner.toggle(PlannerJSON.groceries, on: friday)          // not done, from a sheet on Friday
        await drain(planner)

        #expect(planner.item(PlannerJSON.groceries)?.status == "pending")
        let posts = await server.count(itemRoute(PlannerJSON.groceries))
        #expect(posts == 2)
    }

    /// The ticks that landed after a one-off's failed tick are played again
    /// on its status from before it, whatever days they were sent with.
    @Test func aFailedTickOfAOneOffGivesWayToTicksThatLandedOnAnotherDay() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(itemRoute(PlannerJSON.groceries), .offline, .status(200, ok))
        let planner = await loaded(server)
        let friday = planner.today.adding(days: 1)

        planner.toggle(PlannerJSON.groceries, on: planner.today)   // done, never reaches the server
        planner.toggle(PlannerJSON.groceries, on: friday)          // not done, lands
        planner.toggle(PlannerJSON.groceries, on: friday)          // done, lands
        await drain(planner)

        #expect(planner.item(PlannerJSON.groceries)?.status == "completed")
        // Nothing on screen moved, so nothing says it was undone.
        #expect(planner.banner?.text == "Couldn't reach dsul. Pull down to try again.")
        let posts = await server.count(itemRoute(PlannerJSON.groceries))
        #expect(posts == 3)
    }

    /// The route answers 404 for a missing row, so a write on the new item
    /// that landed proves a capture whose answer was lost did land.
    @Test func aFailedCaptureStaysOnceALaterWriteOnItLands() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(captureRoute, .offline)
        await server.setFallback(.status(200, ok))   // the new item's own route
        let planner = await loaded(server)

        planner.capture("Buy milk")                    // never answered
        let milk = try #require(planner.items.last)
        #expect(milk.title == "Buy milk")
        planner.schedule(milk.id, startMin: 9 * 60)    // lands
        await drain(planner)

        let kept = planner.item(milk.id)
        #expect(kept?.isScheduled == true)
        #expect(kept?.startTime == "09:00")
        #expect(planner.isScheduled(milk.id))
        #expect(planner.banner?.text == "Couldn't reach dsul. Pull down to try again.")
        let posts = await server.count(itemRoute(milk.id))
        #expect(posts == 1)
    }

    /// A skip leaves the day's tally alone, so a skip that landed after a
    /// tally step that didn't is played on the tally from before the step.
    @Test func aFailedTallyStepIsUndoneUnderASkipThatLanded() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(itemRoute(PlannerJSON.water), .offline, .status(200, ok))
        let planner = await loaded(server)

        planner.toggle(PlannerJSON.water)                    // 1 of 3 → 2 of 3, never reaches the server
        planner.skip(PlannerJSON.water, on: planner.today)   // lands
        #expect(planner.item(PlannerJSON.water)?.dailyCounts[PlannerJSON.today] == 2)
        await drain(planner)

        let water = planner.item(PlannerJSON.water)
        #expect(water?.dailyCounts[PlannerJSON.today] == 1)
        #expect(water?.skippedDates == [PlannerJSON.today])
        #expect(water?.status == "skipped")
        let posts = await server.count(itemRoute(PlannerJSON.water))
        #expect(posts == 2)
    }

    /// A resume of an item the server never paused writes nothing, so a
    /// resume that landed after a pause that didn't leaves no pause at all.
    @Test func aFailedPauseIsUndoneUnderAResumeThatLanded() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(timezone: "America/New_York")), .offline)
        await server.on(itemRoute(PlannerJSON.groceries), .offline, .status(200, ok))
        let planner = await loaded(server)

        planner.pause(PlannerJSON.groceries, until: nil)   // never reaches the server
        planner.resume(PlannerJSON.groceries)              // lands, and the server writes nothing
        #expect(planner.item(PlannerJSON.groceries)?.pausedUntil == PlannerJSON.today)
        await drain(planner)

        let groceries = planner.item(PlannerJSON.groceries)
        #expect(groceries?.pausedAt == nil)
        #expect(groceries?.pausedUntil == nil)
        let posts = await server.count(itemRoute(PlannerJSON.groceries))
        #expect(posts == 2)
    }

    /// A habit's status is the item's, not a day's: every day's tick writes
    /// it. So a failed tick yesterday puts back yesterday alone, and the
    /// status stays where today's tick, which landed, left it.
    @Test func aFailedTickYesterdayLeavesTheStatusATickTodaySet() async {
        let journal = UUID(uuidString: "0d000000-0000-4000-8000-000000000008")!
        let journalJSON = "{\"id\":\"\(lowerID(journal))\",\"type\":\"habit\",\"title\":\"Journal\","
            + "\"status\":\"pending\",\"timeBucket\":\"evening\",\"repeatFrequency\":\"daily\",\"streak\":0,"
            + "\"completedDates\":[],\"skippedDates\":[],\"dailyCounts\":{}}"
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [journalJSON])), .offline)
        await server.on(itemRoute(journal), .offline, .status(200, ok))
        let planner = await loaded(server)
        let yesterday = planner.today.adding(days: -1)

        planner.toggle(journal, on: yesterday)       // never reaches the server
        planner.toggle(journal, on: planner.today)   // lands
        #expect(planner.item(journal)?.completedDates == [yesterday.description, PlannerJSON.today])
        await drain(planner)

        let item = planner.item(journal)
        #expect(item?.completedDates == [PlannerJSON.today])
        #expect(item?.status == "done")
        #expect(item?.streak == 1)
        #expect(planner.banner?.text == "Couldn't reach dsul, so that change was undone.")
        let posts = await server.count(itemRoute(journal))
        #expect(posts == 2)
    }

    /// A fetch that fails while a write on the failed item is still out (a
    /// pull to refresh) leaves the failure for later, not forgotten: the
    /// write that lands is played on the rebase, and the drain refetches.
    @Test func aFailureWaitsForAWriteStillOutOnItsItem() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(itemRoute(PlannerJSON.bank), .offline, .status(200, ok))
        let planner = await loaded(server)
        await server.gate(itemRoute(PlannerJSON.bank))

        planner.schedule(PlannerJSON.bank, startMin: 9 * 60)   // never reaches the server
        planner.move(PlannerJSON.bank, to: "2026-10-02")       // held, then lands
        await server.admit(itemRoute(PlannerJSON.bank))
        // The carry is out only once the drop has failed.
        let carryOut = await waitUntil { await server.count(itemRoute(PlannerJSON.bank)) == 2 }
        #expect(carryOut)

        await planner.refresh()   // fails with the carry still out
        #expect(planner.item(PlannerJSON.bank)?.startTime == "09:00")
        #expect(planner.banner?.text == "Couldn't reach dsul. Pull down to try again.")

        await server.admit(itemRoute(PlannerJSON.bank))
        await drain(planner)

        let bank = planner.item(PlannerJSON.bank)
        #expect(bank?.isScheduled == false)
        #expect(bank?.startTime == nil)
        #expect(bank?.timeBucket == "anytime")
        #expect(bank?.startDate == "2026-10-02")
        #expect(planner.banner?.text == "Couldn't reach dsul, so that change was undone.")
        let gets = await server.count(plannerRoute)
        #expect(gets == 3)
    }

    /// For a failed write of one kind and a landed one after it on the same
    /// item, the revert is the item from before both with the landed write's
    /// step alone played on it: whatever fields each sets, nothing the server
    /// took is undone, and nothing it didn't take is left. A slot, part 1's
    /// unit, would have put back only the failed write's fields.
    @Test func aRevertKeepsEveryLandedWrite() async throws {
        typealias Act = @MainActor (SamplePlanner) -> Void
        typealias Step = (SampleItem) -> SampleItem
        let id = PlannerJSON.plants
        let today = try #require(DayString(PlannerJSON.today))
        let friday = today.adding(days: 1)
        // What the person does, through the planner.
        let tick: Act = { $0.toggle(id, on: today) }
        let skip: Act = { $0.skip(id, on: friday) }
        let move: Act = { $0.move(id, to: "2026-10-05") }
        let drop: Act = { $0.schedule(id, startMin: 9 * 60) }
        let pause: Act = { $0.pause(id, until: "2026-10-08") }
        let title: Act = { $0.edit(id, .title("Water the ferns")) }
        let retitle: Act = { $0.edit(id, .title("Water the ficus")) }
        let notes: Act = { $0.edit(id, .notes("Twice a week in winter")) }
        // What the server made of it, as DsulCore's steps play it.
        let ticked: Step = { applying(TickIntent(done: true), to: $0, on: today) }
        let unticked: Step = { applying(TickIntent(done: false), to: $0, on: today) }
        let skipped: Step = { skipping($0, on: friday.description, skipped: true) }
        let moved: Step = { moving($0, to: "2026-10-05") }
        let dropped: Step = { placing($0, on: PlannerJSON.today, startMin: 9 * 60) }
        let paused: Step = { item in
            var next = item
            next.pausedAt = "2026-10-01T12:00:00.000Z"
            next.pausedUntil = "2026-10-08"
            return next
        }
        let titled: Step = { editing($0, .title("Water the ferns")) }
        let retitled: Step = { editing($0, .title("Water the ficus")) }
        let noted: Step = { editing($0, .notes("Twice a week in winter")) }
        // The failed write, the landed one, and the server's end state.
        let pairs: [(String, Act, Act, Step)] = [
            ("tick, then title", tick, title, titled),
            ("title, then tick", title, tick, ticked),
            ("tick, then untick", tick, tick, unticked),
            ("skip, then tick", skip, tick, ticked),
            ("notes, then carry", notes, move, moved),
            ("carry, then notes", move, notes, noted),
            ("drop, then skip", drop, skip, skipped),
            ("skip, then drop", skip, drop, dropped),
            ("carry, then drop", move, drop, dropped),
            ("drop, then carry", drop, move, moved),
            ("pause, then title", pause, title, titled),
            ("title, then pause", title, pause, paused),
            ("title, then title", title, retitle, retitled),
        ]
        for (name, failed, landedAfter, step) in pairs {
            let server = FakeServer()
            await server.on(plannerRoute, .status(200, PlannerJSON.payload(timezone: "America/New_York",
                                                                           extra: [PlannerJSON.plantsJSON])),
                            .offline)
            await server.on(itemRoute(id), .offline, .status(200, ok))
            let planner = await loaded(server)
            let before = try #require(planner.item(id))

            failed(planner)        // never reaches the server
            landedAfter(planner)   // lands
            await drain(planner)

            #expect(planner.item(id) == step(before), "\(name)")
            let posts = await server.count(itemRoute(id))
            #expect(posts == 2, "\(name)")
        }
    }

    /// Every part 1 write and each edit names its own item and nothing else;
    /// a delete names its item and every subtask it took out with it, a
    /// habit's only itself. None proves a row yet: from 2b a new subtask
    /// proves its parent.
    @Test func eachWriteNamesWhatItTouches() {
        let id = PlannerJSON.groceries
        let own: Set<PlannerSync.Subject> = [.item(id)]
        let writes: [PlannerSync.Write] = [
            .complete(id: id, date: "2026-10-01", done: true, count: nil),
            .schedule(id: id, date: "2026-10-01", startTime: "09:00"),
            .capture(id: id, title: "Buy milk"),
            .skip(id: id, date: "2026-10-01", skipped: true),
            .move(id: id, date: "2026-10-02"),
            .pause(id: id, paused: true, pausedUntil: nil, timeZone: "UTC"),
            .edit(id: id, .title("Big shop")),
            .edit(id: id, .notes(nil)),
        ]
        for write in writes {
            #expect(write.itemId == id)
            #expect(write.subjects == own)
            #expect(write.proves.isEmpty)
        }

        let groceries = SampleItem(id: id, title: "Groceries", status: "pending")
        let bags = SampleItem(id: PlannerJSON.bags, title: "Bring the bags", status: "pending",
                              parentItemId: lowerID(id))
        let removed = [PlacedItem(place: Place(index: 0, after: nil), item: groceries),
                       PlacedItem(place: Place(index: 4, after: PlannerJSON.bank), item: bags)]
        let delete = PlannerSync.Write.delete(id: id, removed: removed, cascades: true)
        let both: Set<PlannerSync.Subject> = [.item(id), .item(PlannerJSON.bags)]
        #expect(delete.itemId == id)
        #expect(delete.subjects == both)
        #expect(delete.proves.isEmpty)

        let water = SampleItem(id: PlannerJSON.water, type: "habit", title: "Water")
        let alone = PlannerSync.Write.delete(id: PlannerJSON.water,
                                             removed: [PlacedItem(place: Place(index: 1, after: id), item: water)],
                                             cascades: false)
        let habit: Set<PlannerSync.Subject> = [.item(PlannerJSON.water)]
        #expect(alone.subjects == habit)
    }

    // MARK: The rebase's worked cases (design §3.5)

    // Case 1 is aFailedCarryIsUndoneThoughATickThatLandedCameAfterIt, above.
    // Cases 2, 3, 4, 7 and 10 need a repeat edit, Reset streak or Add a
    // subtask, and come with those writes.

    /// Case 5: an edit and then a delete, both failed. The item comes back
    /// from before the edit, with its old title, where the delete took it
    /// from, and its subtask comes back after the row it followed.
    @Test func aFailedEditThenAFailedDeleteBringsTheItemBackWhereItStood() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [PlannerJSON.bagsJSON])), .offline)
        await server.on(itemRoute(PlannerJSON.groceries), .offline)
        let planner = await loaded(server)
        let order = planner.items.map(\.id)
        let before = planner.item(PlannerJSON.groceries)

        planner.edit(PlannerJSON.groceries, .title("Big shop"))   // never reaches the server
        planner.deleteItem(PlannerJSON.groceries)                 // nor does this
        #expect(planner.item(PlannerJSON.groceries) == nil)
        #expect(planner.item(PlannerJSON.bags) == nil)
        await drain(planner)

        #expect(planner.items.map(\.id) == order)
        #expect(planner.item(PlannerJSON.groceries) == before)
        #expect(planner.subtasks(of: PlannerJSON.groceries).map(\.id) == [PlannerJSON.bags])
        #expect(planner.banner?.text == "Couldn't reach dsul, so that change was undone.")
        let posts = await server.count(itemRoute(PlannerJSON.groceries))
        #expect(posts == 2)
        // The server takes the subtask with its parent; the phone sends one delete.
        let bagPosts = await server.count(itemRoute(PlannerJSON.bags))
        #expect(bagPosts == 0)
    }

    /// Case 6: an edit that failed under a delete that landed stays deleted.
    @Test func aFailedEditUnderALandedDeleteStaysDeleted() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(itemRoute(PlannerJSON.groceries), .offline, .status(200, ok))
        let planner = await loaded(server)

        planner.edit(PlannerJSON.groceries, .title("Big shop"))   // never reaches the server
        planner.deleteItem(PlannerJSON.groceries)                 // lands
        await drain(planner)

        #expect(planner.item(PlannerJSON.groceries) == nil)
        // Nothing on screen moved, so nothing says it was undone.
        #expect(planner.banner?.text == "Couldn't reach dsul. Pull down to try again.")
    }

    /// Case 8: a capture whose answer was lost, then edits on it that landed.
    /// They prove the row, so the item is rebuilt from the capture with the
    /// edits played on it.
    @Test func aFailedCaptureIsRebuiltWithTheEditsThatLandedOnIt() async throws {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(captureRoute, .offline)
        await server.setFallback(.status(200, ok))   // the new item's own route
        let planner = await loaded(server)

        planner.capture("Buy milk")                        // never answered
        let milk = try #require(planner.items.last)
        planner.edit(milk.id, .title("Buy oat milk"))      // lands
        planner.edit(milk.id, .notes("The barista one"))   // lands
        await drain(planner)

        let kept = planner.item(milk.id)
        #expect(kept?.title == "Buy oat milk")
        #expect(kept?.notes == "The barista one")
        #expect(planner.braindump.last?.id == milk.id)
        #expect(planner.banner?.text == "Couldn't reach dsul. Pull down to try again.")
    }

    /// Case 9: a subtask's delete failed, then its parent's landed. The
    /// parent's delete didn't name the subtask, which the phone had already
    /// taken out, but the server deleted every live subtask it found, so the
    /// subtask stays gone.
    @Test func aSubtaskWhoseDeleteFailedStaysGoneUnderItsParentsDelete() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [PlannerJSON.bagsJSON])), .offline)
        await server.on(itemRoute(PlannerJSON.bags), .offline)
        await server.on(itemRoute(PlannerJSON.groceries), .status(200, ok))
        let planner = await loaded(server)

        planner.deleteItem(PlannerJSON.bags)        // never reaches the server
        planner.deleteItem(PlannerJSON.groceries)   // lands, and takes the bags with it there
        await drain(planner)

        #expect(planner.item(PlannerJSON.bags) == nil)
        #expect(planner.item(PlannerJSON.groceries) == nil)
        #expect(planner.banner?.text == "Couldn't reach dsul. Pull down to try again.")
    }

    /// Case 11: a delete answered 404 with the route's own `not_found` landed,
    /// since the row is gone either way, so the edit that failed before it
    /// stays deleted. A 404 without that code (an edge's page) failed, and
    /// the item comes back, title and all, where it stood.
    @Test func aDeleteAnswered404LandedOnlyWithTheRoutesCode() async {
        let answers: [(String, Bool)] = [("{\"error\":\"not_found\"}", true), ("<html>Not Found</html>", false)]
        for (body, gone) in answers {
            let server = FakeServer()
            await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
            await server.on(itemRoute(PlannerJSON.groceries), .offline, .status(404, body))
            let planner = await loaded(server)
            let before = planner.item(PlannerJSON.groceries)

            planner.edit(PlannerJSON.groceries, .title("Big shop"))   // never reaches the server
            planner.deleteItem(PlannerJSON.groceries)                 // 404
            await drain(planner)

            if gone {
                #expect(planner.item(PlannerJSON.groceries) == nil)
                #expect(planner.banner?.text == "Couldn't reach dsul. Pull down to try again.")
            } else {
                #expect(planner.item(PlannerJSON.groceries) == before)
                #expect(planner.items.first?.id == PlannerJSON.groceries)
                #expect(planner.banner?.text == "Couldn't reach dsul, so that change was undone.")
            }
        }
    }

    /// Case 12: a pause that landed is replayed at its own `sentAt`, the
    /// instant it went out, which is when the server resolved it. Here the
    /// refetch fails a day later: on October 2 a pause until the 2nd would be
    /// refused, but the server took it on the 1st.
    @Test func aReplayedPauseResolvesAtItsOwnSentAt() async {
        let clock = TestClock(PlannerJSON.noon)
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(timezone: "America/New_York")), .offline)
        await server.on(itemRoute(PlannerJSON.groceries), .offline, .status(200, ok))
        let planner = makeLivePlanner(server, now: { clock.now })
        await planner.refresh()
        await server.gate(plannerRoute)

        planner.edit(PlannerJSON.groceries, .title("Big shop"))     // never reaches the server
        planner.pause(PlannerJSON.groceries, until: "2026-10-02")   // lands at 8:00 in New York, Oct 1
        let refetching = await waitUntil { await server.count(plannerRoute) == 2 }
        #expect(refetching)
        // Noon in New York on October 2, before the refetch fails.
        clock.now = PlannerJSON.noon.addingTimeInterval(28 * 60 * 60)
        await server.admit(plannerRoute)
        await drain(planner)

        let groceries = planner.item(PlannerJSON.groceries)
        #expect(groceries?.title == "Groceries")
        #expect(groceries?.pausedAt == "2026-10-01T12:00:00.000Z")
        #expect(groceries?.pausedUntil == "2026-10-02")
        #expect(planner.banner?.text == "Couldn't reach dsul, so that change was undone.")
    }

    /// Case 13: two items fail and the refetch fails with a write still out
    /// on one of them. The other is reverted at once; the waiting one keeps
    /// its failure and the write that landed on it since, and is rebased with
    /// both once the write still out is in.
    @Test func oneSubjectWaitsWhileAnotherIsReverted() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()), .offline)
        await server.on(itemRoute(PlannerJSON.groceries), .offline)
        await server.on(itemRoute(PlannerJSON.bank), .offline, .status(200, ok))
        let planner = await loaded(server)
        await server.gate(itemRoute(PlannerJSON.bank))

        planner.edit(PlannerJSON.groceries, .title("Big shop"))               // never reaches the server
        planner.schedule(PlannerJSON.bank, startMin: 9 * 60)                  // nor this
        planner.move(PlannerJSON.bank, to: "2026-10-02")                      // lands
        planner.edit(PlannerJSON.bank, .title("Call the bank about the card"))  // held, then lands
        await server.admit(itemRoute(PlannerJSON.bank))
        await server.admit(itemRoute(PlannerJSON.bank))
        let titleOut = await waitUntil { await server.count(itemRoute(PlannerJSON.bank)) == 3 }
        #expect(titleOut)

        await planner.refresh()   // fails with the bank's title still out
        #expect(planner.item(PlannerJSON.groceries)?.title == "Groceries")
        #expect(planner.item(PlannerJSON.bank)?.startTime == "09:00")
        #expect(planner.banner?.text == "Couldn't reach dsul, so that change was undone.")

        await server.admit(itemRoute(PlannerJSON.bank))
        await drain(planner)

        let bank = planner.item(PlannerJSON.bank)
        #expect(bank?.isScheduled == false)
        #expect(bank?.startTime == nil)
        #expect(bank?.startDate == "2026-10-02")
        #expect(bank?.timeBucket == "anytime")
        #expect(bank?.title == "Call the bank about the card")
        #expect(planner.item(PlannerJSON.groceries)?.title == "Groceries")
        let gets = await server.count(plannerRoute)
        #expect(gets == 3)
    }

    // MARK: Background time

    /// iOS is asked for time when the queue goes from empty to busy, once
    /// however many writes join it, and it is given back when the queue
    /// drains. A fetch asks for none.
    @Test func backgroundTimeCoversTheQueueFromItsFirstWriteToItsDrain() async {
        let background = FakeBackgroundTime()
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.groceries), .status(200, ok))
        let planner = makeLivePlanner(server, backgroundTime: background.time)
        await planner.refresh()
        #expect(background.begun.isEmpty)

        planner.toggle(PlannerJSON.groceries)
        planner.toggle(PlannerJSON.groceries)
        #expect(background.begun == [PlannerSync.backgroundTaskName])
        #expect(background.ended.isEmpty)
        await drain(planner)
        #expect(background.ended == [1])

        planner.toggle(PlannerJSON.groceries)
        #expect(background.begun.count == 2)
        await drain(planner)
        #expect(background.ended == [1, 2])
    }

    /// When iOS takes the time back first, it is ended there and then, and
    /// the write still out goes on: nothing is ended twice.
    @Test func backgroundTimeEndsWhenIOSTakesItBack() async {
        let background = FakeBackgroundTime()
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload()))
        await server.on(itemRoute(PlannerJSON.groceries), .status(200, ok))
        let planner = makeLivePlanner(server, backgroundTime: background.time)
        await planner.refresh()
        await server.gate(itemRoute(PlannerJSON.groceries))

        planner.toggle(PlannerJSON.groceries)
        #expect(background.begun.count == 1)
        background.expire()
        #expect(background.ended == [1])
        await server.admit(itemRoute(PlannerJSON.groceries))
        await drain(planner)

        #expect(background.ended == [1])
        #expect(isDone(planner, PlannerJSON.groceries))
        #expect(planner.banner == nil)
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
