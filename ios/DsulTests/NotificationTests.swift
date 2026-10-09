import DsulCore
import Foundation
import Testing
@testable import Dsul

// Phase 2c's hosted half (memory/plans/reminders-platforms.md §5.3): the
// scheduler against a fake center, the outbox, and the hub's Done, Snooze,
// willPresent and background paths against FakeServer.

/// UNUserNotificationCenter in memory: what is pending (by id, as added),
/// what is in the shade, and every add and removal in order.
@MainActor
final class FakeNotificationCenter: NotificationCenterPort {
    var allowed: NotificationPermission = .allowed
    var askedPermission = 0
    /// What a permission request turns into.
    var grants = true
    private(set) var pendingById: [String: ScheduledNotification] = [:]
    var shade: [DeliveredNotification] = []
    private(set) var added: [String] = []
    private(set) var removedPending: [String] = []
    private(set) var removedDelivered: [String] = []
    /// Requests from another app, never dsul's to touch.
    var foreign: [PendingNotification] = []
    let clock: TestClock

    init(clock: TestClock) {
        self.clock = clock
    }

    func permission() async -> NotificationPermission { allowed }

    func requestPermission() async -> Bool {
        askedPermission += 1
        if allowed == .notDetermined { allowed = grants ? .allowed : .denied }
        return allowed == .allowed
    }

    func pending() async -> [PendingNotification] {
        let ours = pendingById.values.sorted { $0.request.id < $1.request.id }.map { scheduled in
            let request = scheduled.request
            var weekday: Int? = nil
            var day: Int? = nil
            if case .calendar(_, _, let w, let d) = request.trigger {
                weekday = w
                day = d
            }
            return PendingNotification(id: request.id, signature: scheduled.signature, itemId: request.itemId,
                                       at: request.userInfo.at, nextFireMs: request.firesAt,
                                       repeats: request.trigger.repeats, weekday: weekday, day: day)
        }
        return foreign + ours
    }

    func delivered() async -> [DeliveredNotification] { shade }

    func add(_ notification: ScheduledNotification) async throws {
        added.append(notification.request.id)
        if case .now = notification.request.trigger {
            shade.removeAll { $0.id == notification.request.id }
            shade.append(DeliveredNotification(id: notification.request.id,
                                               deliveredAtMs: NotificationScheduler.epochMs(clock.now),
                                               dateStr: notification.request.dateStr,
                                               at: notification.request.userInfo.at))
            return
        }
        pendingById[notification.request.id] = notification
    }

    func removePending(_ ids: [String]) {
        removedPending += ids
        for id in ids { pendingById[id] = nil }
        foreign.removeAll { ids.contains($0.id) }
    }

    func removeDelivered(_ ids: [String]) {
        removedDelivered += ids
        shade.removeAll { ids.contains($0.id) }
    }

    /// Rings every pending one-off and calendar slot due by the clock: what
    /// iOS does between plans.
    func ringDue() {
        let nowMs = NotificationScheduler.epochMs(clock.now)
        for (id, scheduled) in pendingById where scheduled.request.firesAt <= nowMs {
            shade.append(DeliveredNotification(id: id, deliveredAtMs: scheduled.request.firesAt,
                                               dateStr: scheduled.request.dateStr, at: scheduled.request.userInfo.at))
            if !scheduled.request.trigger.repeats { pendingById[id] = nil }
        }
    }
}

/// The account, signed in as `testUserID` (or not).
@MainActor
final class FakeAccount: NotificationAccount {
    var signedInUserId: UUID? = testUserID
    let tokens = FakeTokens()

    func accessToken(rejecting rejected: String?) async throws -> String {
        return try await tokens.accessToken(rejecting: rejected)
    }
}

@MainActor
@Suite struct NotificationTests {
    private let ok = "{\"ok\":true}"
    private let origin = URL(string: "https://dsul.test")!

    /// Meds (a daily habit on a 41-day streak) with a cue at `at`, Habit
    /// reminders on, the review at `eod` when given.
    private func payload(at: String = "07:30", medsDone: Bool = false, eod: String? = nil,
                         snoozes: String = "") -> String {
        var meds = PlannerJSON.medsJSON
        if medsDone {
            meds = meds.replacingOccurrences(of: "[\"2026-09-29\",\"2026-09-30\"]",
                                             with: "[\"2026-09-29\",\"2026-09-30\",\"\(PlannerJSON.today)\"]")
        }
        meds = meds.replacingOccurrences(of: "\"streak\":41,", with: "\"streak\":41,\"reminderTime\":\"\(at)\",")
        var json = PlannerJSON.payload(remindersEnabled: "true", extra: [meds])
        if let eod {
            json = json.replacingOccurrences(of: "\"remindersEnabled\":true",
                                             with: "\"remindersEnabled\":true,\"eodReviewEnabled\":true,"
                                                 + "\"eodReviewTime\":\"\(eod)\"")
        }
        if !snoozes.isEmpty {
            json = String(json.dropLast()) + ",\"snoozes\":[\(snoozes)]}"
        }
        return json
    }

    private func snapshot(_ json: String) throws -> PlanSnapshot {
        return PlanSnapshot(try JSONDecoder().decode(PlannerPayload.self, from: Data(json.utf8)))
    }

    private func at(_ hhmm: String) -> Date {
        let minutes = minutesOfDay(hhmm)!
        let ms = instantOf(PlannerJSON.today, minutes: minutes, timeZone: "UTC")!
        return Date(timeIntervalSince1970: Double(ms) / 1000)
    }

    private func makeScheduler(_ clock: TestClock, store: MemorySchedulerStore = MemorySchedulerStore())
        -> (NotificationScheduler, FakeNotificationCenter) {
        let center = FakeNotificationCenter(clock: clock)
        let scheduler = NotificationScheduler(center: center, store: store, now: { clock.now }, zone: { "UTC" })
        return (scheduler, center)
    }

    private func makeHub(_ server: FakeServer, clock: TestClock, account: FakeAccount? = FakeAccount(),
                         outbox: MemoryOutboxStorage = MemoryOutboxStorage())
        -> (NotificationHub, FakeNotificationCenter) {
        let (scheduler, center) = makeScheduler(clock)
        let hub = NotificationHub(scheduler: scheduler, outbox: ActionOutbox(storage: outbox),
                                  makeAPI: { [origin] tokens in
                                      APIClient(origin: origin, tokens: tokens, transport: server.transport)
                                  },
                                  now: { clock.now }, zone: { "UTC" })
        hub.account = account
        return (hub, center)
    }

    private func info(_ id: String, kind: PlannedKind = .cue, item: UUID? = PlannerJSON.meds,
                      dateStr: String? = PlannerJSON.today, at: String? = "07:30", date: Date) -> NotificationInfo {
        var userInfo = PlannedUserInfo(kind: kind, itemId: item, dateStr: dateStr, at: at).dictionary
        userInfo[NotificationKeys.signature] = "x"
        return NotificationInfo(id: id, userInfo: userInfo, date: date, title: "Meds", body: "Time for Meds")
    }

    private func bodies(_ server: FakeServer, _ route: String) async -> [[String: Any]] {
        let requests = await server.requests
        return requests.filter { $0.route == route }.compactMap { request in
            request.body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        }
    }

    private var medsBase: String { itemIdentifier(PlannerJSON.meds) }

    // MARK: The scheduler

    /// The plan's requests are what ends up pending, no more; a second plan
    /// with nothing changed adds nothing.
    @Test func reconcileAddsThePlanAndNothingTwice() async throws {
        let clock = TestClock(at("06:00"))
        let (scheduler, center) = makeScheduler(clock)
        let plan = try #require(await scheduler.reconcile(try snapshot(payload()), userId: testUserID))
        let ids = Set(plan.requests.map(\.id))
        #expect(ids == [medsBase])
        #expect(Set(center.pendingById.keys) == ids)
        #expect(center.pendingById.count <= notificationBudget)
        let addedOnce = center.added.count
        await scheduler.reconcile(try snapshot(payload()), userId: testUserID)
        #expect(center.added.count == addedOnce)
        #expect(center.removedPending.isEmpty)
    }

    /// A changed cue time replaces the request; one no longer planned goes;
    /// another app's request is never touched.
    @Test func reconcileReplacesAndRemovesOnlyDsuls() async throws {
        let clock = TestClock(at("06:00"))
        let (scheduler, center) = makeScheduler(clock)
        center.foreign = [PendingNotification(id: "other-app-1")]
        await scheduler.reconcile(try snapshot(payload(at: "07:30")), userId: testUserID)
        await scheduler.reconcile(try snapshot(payload(at: "08:15")), userId: testUserID)
        #expect(center.added == [medsBase, medsBase])
        guard case .calendar(let hour, let minute, _, _)? = center.pendingById[medsBase]?.request.trigger else {
            Issue.record("no standing trigger")
            return
        }
        #expect(hour == 8 && minute == 15)
        // Habit reminders off: every cue goes, the other app's stays.
        let off = payload().replacingOccurrences(of: "\"remindersEnabled\":true", with: "\"remindersEnabled\":false")
        await scheduler.reconcile(try snapshot(off), userId: testUserID)
        #expect(center.pendingById.isEmpty)
        #expect(center.removedPending == [medsBase])
        #expect(center.foreign.count == 1)
    }

    /// Not allowed to notify: nothing is planned, added or removed.
    @Test func noPermissionPlansNothing() async throws {
        let clock = TestClock(at("06:00"))
        let (scheduler, center) = makeScheduler(clock)
        center.allowed = .denied
        #expect(await scheduler.reconcile(try snapshot(payload()), userId: testUserID) == nil)
        #expect(center.added.isEmpty)
        #expect(center.removedPending.isEmpty)
    }

    /// Opened inside a cue's window with nothing rung: the catch-up is
    /// delivered once, and the next plan doesn't deliver it again.
    @Test func aCatchUpRingsOnce() async throws {
        let clock = TestClock(at("07:40"))
        let (scheduler, center) = makeScheduler(clock)
        await scheduler.reconcile(try snapshot(payload()), userId: testUserID)
        #expect(center.added.filter { $0 == "\(medsBase)#now" }.count == 1)
        center.shade.removeAll()
        clock.now = at("07:45")
        await scheduler.reconcile(try snapshot(payload()), userId: testUserID)
        #expect(center.added.filter { $0 == "\(medsBase)#now" }.count == 1)
        #expect(scheduler.state?.sentKeys == [sentKeyFor(PlannerJSON.today, "07:30")])
    }

    /// A cue that rang at its own minute between two plans, then was swiped
    /// away: the armed record says it rang, so no catch-up.
    @Test func aCueThatRangIsNotCaughtUp() async throws {
        let clock = TestClock(at("07:00"))
        let (scheduler, center) = makeScheduler(clock)
        await scheduler.reconcile(try snapshot(payload()), userId: testUserID)
        clock.now = at("07:40")
        center.ringDue()
        center.shade.removeAll()
        await scheduler.reconcile(try snapshot(payload()), userId: testUserID)
        #expect(!center.added.contains("\(medsBase)#now"))
    }

    /// A repeating slot armed days ago that rang today too: today's ring
    /// counts, not only the first.
    @Test func aStandingSlotsRingTodayCounts() {
        let armed = ArmedCue(id: medsBase, at: "07:30", nextFireMs: instantOf("2026-09-28", minutes: 450,
                                                                            timeZone: "UTC")!,
                             repeats: true, weekday: nil, day: nil)
        let nowMs = NotificationScheduler.epochMs(at("08:00"))
        let keys = NotificationScheduler.rang([armed], nowMs: nowMs, today: PlannerJSON.today, zone: "UTC")
        #expect(keys == [sentKeyFor("2026-09-28", "07:30"), sentKeyFor(PlannerJSON.today, "07:30")])
        // A weekday slot for another weekday did not ring today (Thursday is 5).
        var friday = armed
        friday.weekday = 6
        let none = NotificationScheduler.rang([friday], nowMs: nowMs, today: PlannerJSON.today, zone: "UTC")
        #expect(none == [sentKeyFor("2026-09-28", "07:30")])
    }

    /// Ticked since a cue rang: the plan withdraws it from the shade.
    @Test func aDoneCueIsWithdrawn() async throws {
        let clock = TestClock(at("07:00"))
        let (scheduler, center) = makeScheduler(clock)
        await scheduler.reconcile(try snapshot(payload()), userId: testUserID)
        clock.now = at("07:35")
        center.ringDue()
        #expect(center.shade.map(\.id) == [medsBase])
        await scheduler.reconcile(try snapshot(payload(medsDone: true)), userId: testUserID)
        #expect(center.shade.isEmpty)
        #expect(center.removedDelivered == [medsBase])
    }

    /// The server's snooze arms `#snooze`; one tapped here arms it before the
    /// server has it, and the later one wins on the same day.
    @Test func snoozesAreMerged() async throws {
        let clock = TestClock(at("09:00"))
        let (scheduler, center) = makeScheduler(clock)
        let server = "{\"itemId\":\"\(lowerID(PlannerJSON.meds))\",\"until\":\"2026-10-01T09:10:00+00:00\","
            + "\"date\":\"\(PlannerJSON.today)\"}"
        await scheduler.reconcile(try snapshot(payload(snoozes: server)), userId: testUserID)
        let armed = try #require(center.pendingById["\(medsBase)#snooze"])
        #expect(armed.request.firesAt == NotificationScheduler.epochMs(at("09:10")))
        #expect(armed.afterSeconds == 600)
        let later = NotificationScheduler.epochMs(at("09:20"))
        scheduler.noteSnooze(LocalSnooze(itemId: PlannerJSON.meds, date: PlannerJSON.today, untilMs: later),
                             userId: testUserID)
        await scheduler.reconcile(try snapshot(payload(snoozes: server)), userId: testUserID)
        #expect(center.pendingById["\(medsBase)#snooze"]?.request.firesAt == later)
        // Rung: the local one is forgotten.
        clock.now = at("09:30")
        await scheduler.reconcile(try snapshot(payload()), userId: testUserID)
        #expect(scheduler.state?.localSnoozes.isEmpty == true)
    }

    /// Signed out: every dsul request and notification goes, and the state.
    @Test func clearAllTakesOnlyDsuls() async throws {
        let clock = TestClock(at("07:40"))
        let store = MemorySchedulerStore()
        let (scheduler, center) = makeScheduler(clock, store: store)
        center.foreign = [PendingNotification(id: "other-app-1")]
        center.shade = [DeliveredNotification(id: "other-app-2", deliveredAtMs: 0)]
        await scheduler.reconcile(try snapshot(payload()), userId: testUserID)
        #expect(store.state != nil)
        await scheduler.clearAll()
        #expect(center.pendingById.isEmpty)
        #expect(center.shade.map(\.id) == ["other-app-2"])
        #expect(center.foreign.count == 1)
        #expect(store.state == nil)
    }

    /// Another user's remembered state is never read.
    @Test func anotherUsersStateIsDropped() async throws {
        let clock = TestClock(at("07:40"))
        var stale = SchedulerState(userId: lowerID(UUID()))
        stale.sentKeys = [sentKeyFor(PlannerJSON.today, "07:30")]
        let (scheduler, center) = makeScheduler(clock, store: MemorySchedulerStore(stale))
        await scheduler.reconcile(try snapshot(payload()), userId: testUserID)
        #expect(center.added.contains("\(medsBase)#now"))
        #expect(scheduler.state?.userId == lowerID(testUserID))
    }

    /// The signature leaves a calendar slot's `firesAt` out and keeps a
    /// one-off's.
    @Test func theSignatureIgnoresASlotsNextRing() async throws {
        let clock = TestClock(at("06:00"))
        let (scheduler, _) = makeScheduler(clock)
        let plan = try #require(await scheduler.reconcile(try snapshot(payload()), userId: testUserID))
        var request = try #require(plan.requests.first)
        let before = ScheduledNotification.signature(of: request)
        request.firesAt += 86_400_000
        #expect(ScheduledNotification.signature(of: request) == before)
        request.trigger = .at(dateStr: "2026-10-02", hhmm: "07:30")
        let oneOff = ScheduledNotification.signature(of: request)
        request.trigger = .at(dateStr: "2026-10-03", hhmm: "07:30")
        #expect(ScheduledNotification.signature(of: request) != oneOff)
    }

    // MARK: The outbox

    @Test func theOutboxOutlivesItsProcess() {
        let storage = MemoryOutboxStorage()
        let entry = OutboxEntry(id: UUID(), userId: testUserID, kind: .snooze, itemId: PlannerJSON.meds,
                                dateStr: PlannerJSON.today, tappedAtMs: 1, untilMs: 900_001)
        ActionOutbox(storage: storage).append(entry)
        let reopened = ActionOutbox(storage: storage)
        #expect(reopened.entries == [entry])
        reopened.remove([entry.id])
        #expect(storage.data == nil)
        #expect(ActionOutbox(storage: storage).entries.isEmpty)
    }

    // MARK: Done and Snooze through the planner

    private func loadedPlanner(_ server: FakeServer, clock: TestClock, json: String) async -> SamplePlanner {
        await server.on(plannerRoute, .status(200, json))
        let planner = makeLivePlanner(server, now: { clock.now })
        await planner.refresh()
        return planner
    }

    /// Done ticks the item through the planner's sync, as a row's tick, and
    /// the tap leaves the outbox once the server has it.
    @Test func doneTicksThroughThePlanner() async throws {
        let server = FakeServer()
        let clock = TestClock(at("07:31"))
        await server.on(itemRoute(PlannerJSON.meds), .status(200, ok))
        let planner = await loadedPlanner(server, clock: clock, json: payload())
        let (hub, _) = makeHub(server, clock: clock)
        hub.attach(planner)
        await hub.handle(.done, info(medsBase, dateStr: nil, date: at("07:30")))
        await planner.sync?.drain()
        let sent = await bodies(server, itemRoute(PlannerJSON.meds))
        #expect(sent.count == 1)
        #expect(sent.first?["action"] as? String == "complete")
        #expect(sent.first?["date"] as? String == PlannerJSON.today)
        #expect(sent.first?["done"] as? Bool == true)
        #expect(planner.item(PlannerJSON.meds)?.completedDates.contains(PlannerJSON.today) == true)
        #expect(hub.outbox.entries.isEmpty)
    }

    /// Done on a habit already done that day sends nothing: a stale banner's
    /// Done never unticks.
    @Test func doneOnADoneDaySendsNothing() async throws {
        let server = FakeServer()
        let clock = TestClock(at("07:31"))
        let planner = await loadedPlanner(server, clock: clock, json: payload(medsDone: true))
        let (hub, _) = makeHub(server, clock: clock)
        hub.attach(planner)
        await hub.handle(.done, info(medsBase, date: at("07:30")))
        await planner.sync?.drain()
        #expect(await server.count(itemRoute(PlannerJSON.meds)) == 0)
        #expect(hub.outbox.entries.isEmpty)
    }

    /// A counted habit's Done marks the day at its full tally.
    @Test func doneOnACountedHabitFillsItsTally() throws {
        let water = try #require(try snapshot(payload()).items.first { $0.id == PlannerJSON.water })
        let ctx = ActivationContext(timeZone: "UTC")
        let intent = notificationDoneIntent(water, on: DayString(PlannerJSON.today)!, ctx)
        #expect(intent == TickIntent(done: true, count: 3))
        let stretch = try #require(try snapshot(payload()).items.first { $0.id == PlannerJSON.stretch })
        #expect(notificationDoneIntent(stretch, on: DayString(PlannerJSON.today)!, ctx) == nil)
    }

    /// Snooze rings again in fifteen minutes on this iPhone at once, and the
    /// server is sent the minutes left.
    @Test func snoozeArmsAtOnceAndTellsTheServer() async throws {
        let server = FakeServer()
        let clock = TestClock(at("07:31"))
        await server.on(itemRoute(PlannerJSON.meds), .status(200, "{\"ok\":true,\"snoozedUntil\":null}"))
        let planner = await loadedPlanner(server, clock: clock, json: payload())
        let (hub, center) = makeHub(server, clock: clock)
        hub.attach(planner)
        await hub.handle(.snooze, info(medsBase, date: at("07:30")))
        await planner.sync?.drain()
        await hub.settle()
        let armed = try #require(center.pendingById["\(medsBase)#snooze"])
        #expect(armed.request.firesAt == NotificationScheduler.epochMs(at("07:46")))
        let sent = await bodies(server, itemRoute(PlannerJSON.meds))
        #expect(sent.first?["action"] as? String == "snooze")
        #expect(sent.first?["minutes"] as? Int == 15)
        #expect(sent.first?["date"] as? String == PlannerJSON.today)
        #expect(hub.outbox.entries.isEmpty)
    }

    /// A snooze that would ring past its day's midnight is no snooze.
    @Test func aSnoozePastMidnightIsNothing() async throws {
        let server = FakeServer()
        let clock = TestClock(at("23:50"))
        let planner = await loadedPlanner(server, clock: clock, json: payload())
        let (hub, center) = makeHub(server, clock: clock)
        hub.attach(planner)
        await hub.handle(.snooze, info(medsBase, date: at("23:40")))
        #expect(center.pendingById["\(medsBase)#snooze"] == nil)
        #expect(hub.outbox.entries.isEmpty)
    }

    /// Offline: the tap stays in the outbox, and the next drain sends it.
    @Test func anUnsentTapWaitsForTheNextDrain() async throws {
        let server = FakeServer()
        let clock = TestClock(at("07:31"))
        let planner = await loadedPlanner(server, clock: clock, json: payload())
        await server.on(itemRoute(PlannerJSON.meds), .offline)
        await server.on(plannerRoute, .offline)
        let (hub, _) = makeHub(server, clock: clock)
        hub.attach(planner)
        await hub.handle(.done, info(medsBase, date: at("07:30")))
        await planner.sync?.drain()
        #expect(hub.outbox.entries.count == 1)
        await server.on(itemRoute(PlannerJSON.meds), .status(200, ok))
        await server.on(plannerRoute, .status(200, payload()))
        await planner.refresh()
        await planner.sync?.drain()
        #expect(hub.outbox.entries.isEmpty)
        #expect(await server.count(itemRoute(PlannerJSON.meds)) == 2)
    }

    /// A tap waiting from another user is dropped, never sent.
    @Test func anotherUsersTapIsDropped() async throws {
        let server = FakeServer()
        let clock = TestClock(at("07:31"))
        let storage = MemoryOutboxStorage()
        ActionOutbox(storage: storage).append(OutboxEntry(id: UUID(), userId: UUID(), kind: .done,
                                                         itemId: PlannerJSON.meds, dateStr: PlannerJSON.today,
                                                         tappedAtMs: 0))
        let planner = await loadedPlanner(server, clock: clock, json: payload())
        let (hub, _) = makeHub(server, clock: clock, outbox: storage)
        hub.attach(planner)
        await planner.sync?.drain()
        #expect(await server.count(itemRoute(PlannerJSON.meds)) == 0)
        #expect(hub.outbox.entries.isEmpty)
    }

    // MARK: willPresent

    @Test func onlyWhatStillWantsDoingIsShownInFront() async throws {
        let server = FakeServer()
        let clock = TestClock(at("07:31"))
        let planner = await loadedPlanner(server, clock: clock, json: payload(medsDone: true, eod: "21:00"))
        let (hub, _) = makeHub(server, clock: clock)
        hub.attach(planner)
        #expect(!hub.shouldPresent(info(medsBase, date: at("07:30"))))
        let water = info(itemIdentifier(PlannerJSON.water), item: PlannerJSON.water, date: at("07:30"))
        #expect(hub.shouldPresent(water))
        let gone = info(itemIdentifier(UUID()), item: UUID(), date: at("07:30"))
        #expect(!hub.shouldPresent(gone))
        let review = info(eodIdentifier, kind: .eod, item: nil, dateStr: nil, at: nil, date: at("21:00"))
        #expect(hub.shouldPresent(review))
        #expect(hub.shouldPresent(info("other-app", date: at("07:30"))))
    }

    // MARK: With no planner

    /// A lock-screen Done with no window: the hub fetches, ticks, and plans
    /// from what it fetched with the tick on it.
    @Test func headlessDoneFetchesTicksAndPlans() async throws {
        let server = FakeServer()
        let clock = TestClock(at("07:31"))
        await server.on(plannerRoute, .status(200, payload()))
        await server.on(itemRoute(PlannerJSON.meds), .status(200, ok))
        let (hub, center) = makeHub(server, clock: clock)
        await hub.handle(.done, info(medsBase, date: at("07:30")))
        let sent = await bodies(server, itemRoute(PlannerJSON.meds))
        #expect(sent.count == 1)
        #expect(sent.first?["action"] as? String == "complete")
        #expect(hub.outbox.entries.isEmpty)
        // Planned from the ticked planner: today's ring is held, no catch-up.
        #expect(!center.added.contains("\(medsBase)#now"))
        #expect(hub.scheduler.lastPlan != nil)
    }

    /// Offline with no planner: the tap waits, nothing is planned.
    @Test func headlessOfflineKeepsTheTap() async throws {
        let server = FakeServer()
        let clock = TestClock(at("07:31"))
        await server.on(plannerRoute, .offline)
        let (hub, _) = makeHub(server, clock: clock)
        await hub.handle(.done, info(medsBase, date: at("07:30")))
        #expect(hub.outbox.entries.count == 1)
        #expect(await hub.backgroundRefresh() == false)
        await server.on(plannerRoute, .status(200, payload()))
        await server.on(itemRoute(PlannerJSON.meds), .status(200, ok))
        #expect(await hub.backgroundRefresh() == true)
        #expect(hub.outbox.entries.isEmpty)
    }

    /// Signed out with no planner: everything of dsul's is cleared.
    @Test func headlessSignedOutClears() async throws {
        let server = FakeServer()
        let clock = TestClock(at("07:31"))
        let account = FakeAccount()
        account.signedInUserId = nil
        let (hub, center) = makeHub(server, clock: clock, account: account)
        try await center.add(ScheduledNotification(request: PlannedRequest(
            id: medsBase, kind: .cue, itemId: PlannerJSON.meds, dateStr: nil,
            trigger: .calendar(hour: 7, minute: 30, weekday: nil, day: nil), firesAt: 0, title: "Meds", body: "",
            threadId: cueThread, summaryArgument: "Meds", categoryId: cueCategory, relevance: 0,
            userInfo: PlannedUserInfo(kind: .cue, itemId: PlannerJSON.meds, at: "07:30"))))
        #expect(await hub.backgroundRefresh() == false)
        #expect(center.pendingById.isEmpty)
        #expect(await server.count(plannerRoute) == 0)
    }

    // MARK: Permission and the zone

    /// The Remind sheet's Done asks once, and only while undetermined.
    @Test func permissionIsAskedOnlyWhenUndetermined() async {
        let server = FakeServer()
        let clock = TestClock(at("07:31"))
        let (hub, center) = makeHub(server, clock: clock)
        center.allowed = .notDetermined
        await hub.askPermissionIfNeeded()
        await hub.askPermissionIfNeeded()
        #expect(center.askedPermission == 1)
        #expect(hub.permission == .allowed)
    }

    /// A stored zone other than this iPhone's is sent, once.
    @Test func theDevicesZoneIsSentWhenItDiffers() async throws {
        let server = FakeServer()
        let clock = TestClock(at("07:31"))
        await server.on("POST /api/app/timezone", .status(200, "{\"ok\":true,\"unchanged\":false}"))
        let planner = await loadedPlanner(server, clock: clock, json: payload())
        let (hub, _) = makeHub(server, clock: clock)
        hub.attach(planner)
        hub.plannerChanged()
        #expect(await waitUntil { await server.count("POST /api/app/timezone") == 1 })
        let sent = await bodies(server, "POST /api/app/timezone")
        #expect(sent.first?["timezone"] as? String == "UTC")
    }

    // MARK: The writes

    /// The snooze write names nothing the planner holds, and its body is the
    /// route's.
    @Test func theSnoozeWrite() async throws {
        let write = PlannerSync.Write.snooze(id: PlannerJSON.meds, date: PlannerJSON.today, minutes: 15,
                                             timeZone: "UTC")
        #expect(write.subjects.isEmpty)
        #expect(write.proves.isEmpty)
        let server = FakeServer()
        await server.on(itemRoute(PlannerJSON.meds), .status(200, "{\"ok\":true,\"snoozedUntil\":\"x\"}"))
        let api = APIClient(origin: origin, tokens: FakeTokens(), transport: server.transport)
        let until = try await api.snooze(id: PlannerJSON.meds, date: PlannerJSON.today, minutes: 15, timeZone: nil)
        #expect(until == "x")
        let requests = await server.requests
        let body = try #require(requests.first?.body)
        #expect(String(decoding: body, as: UTF8.self)
                == "{\"action\":\"snooze\",\"date\":\"\(PlannerJSON.today)\",\"minutes\":15}")
    }
}
