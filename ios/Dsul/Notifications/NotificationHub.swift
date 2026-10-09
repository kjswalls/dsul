import DsulCore
import Foundation
import Observation

// The one place the phone's notifications are run from
// (memory/plans/reminders-platforms.md §5.3, Phase 2c): it re-plans when the
// planner moves, drains the action outbox, answers the delegate, and does a
// background refresh's work. The UIKit and UserNotifications ends
// (AppDelegate, NotificationDelegate, LiveNotificationCenter,
// BackgroundRefresh) only translate into these calls, so everything that
// decides something here runs in the Linux test shim.
//
// Two ways in, because a button on the lock screen can wake the app with no
// window: with a signed-in planner up (AppGate attached it), writes go
// through its PlannerSync, in order with the rest, and the plan reads the
// planner. With none, the hub fetches the planner itself with the account's
// token, sends what the outbox holds straight to the item routes, and plans
// from that answer. Nothing it fetches is kept on disk (APIClient's rule);
// a background wake with no network plans nothing, and the standing triggers
// keep ringing.

/// The signed-in account, as far as the hub needs it: who, and a token.
/// AuthStore in the app.
@MainActor
protocol NotificationAccount: AccessTokenSource {
    var signedInUserId: UUID? { get }
}

/// A notification as the delegate saw it: its identifier, the userInfo the
/// plan wrote, when it was delivered, and its words (a Snooze rings again
/// with them before any plan can).
struct NotificationInfo: Sendable, Hashable {
    var id: String
    var userInfo: [String: String]
    var date: Date
    var title: String
    var body: String

    init(id: String, userInfo: [String: String], date: Date, title: String = "", body: String = "") {
        self.id = id
        self.userInfo = userInfo
        self.date = date
        self.title = title
        self.body = body
    }

    var kind: PlannedKind? { userInfo["kind"].flatMap(PlannedKind.init(rawValue:)) }
    var itemId: UUID? { userInfo["itemId"].flatMap(UUID.init(uuidString:)) }

    /// The day it is about: its own, or for a repeating trigger (which
    /// carries none) the local day it was delivered on.
    func day(in zone: String) -> String? {
        if let dateStr = userInfo["dateStr"], DayString(dateStr) != nil { return dateStr }
        return localClock(nowMs: NotificationScheduler.epochMs(date), timeZone: zone)?.dateStr
    }
}

/// What the user did with a notification.
enum NotificationAction: Sendable, Hashable {
    case done, snooze, open, dismiss
}

/// A notification's Done, as the web's /api/reminders/act reads it: the day
/// marked done, a counted habit at its full tally. Nil when it no longer
/// wants doing there (done elsewhere, skipped, paused, out of season, gone
/// from its cadence): a stale banner's Done is a no-op, never an untick.
func notificationDoneIntent(_ item: Item, on day: DayString, _ ctx: ActivationContext) -> TickIntent? {
    guard wantsDoingOn(item, on: day, ctx) else { return nil }
    let target = item.isHabit ? (item.timesPerDay ?? 0) : 0
    return TickIntent(done: true, count: target > 1 ? target : nil)
}

@Observable @MainActor
final class NotificationHub {
    /// What this iPhone lets dsul do, as last asked; nil until asked. The
    /// Remind sheet reads it.
    private(set) var permission: NotificationPermission? = nil

    @ObservationIgnored let scheduler: NotificationScheduler
    @ObservationIgnored let outbox: ActionOutbox
    @ObservationIgnored private let makeAPI: @MainActor (any AccessTokenSource) -> APIClient
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private let zone: () -> String
    @ObservationIgnored private(set) weak var planner: SamplePlanner?
    @ObservationIgnored var account: (any NotificationAccount)?

    /// Outbox entries handed to PlannerSync and not yet settled.
    @ObservationIgnored private var inFlight = Set<UUID>()
    @ObservationIgnored private var planning: Task<Void, Never>?
    @ObservationIgnored private var planAgain = false
    @ObservationIgnored private var headless: Task<Bool, Never>?
    /// The zone last sent to the server, so a mismatch is sent once a launch.
    @ObservationIgnored private var sentZone: String?
    /// A cue tapped before its planner had loaded: opened once it has.
    @ObservationIgnored private var pendingOpen: (id: UUID, day: String)?

    init(scheduler: NotificationScheduler, outbox: ActionOutbox,
         makeAPI: @escaping @MainActor (any AccessTokenSource) -> APIClient,
         now: @escaping () -> Date = { Date() }, zone: @escaping () -> String = { TimeZone.current.identifier }) {
        self.scheduler = scheduler
        self.outbox = outbox
        self.makeAPI = makeAPI
        self.now = now
        self.zone = zone
    }

    // MARK: The planner

    /// AppGate's signed-in planner: plans, drains and opens through it from
    /// now on. Another user's taps still in the outbox are dropped.
    func attach(_ planner: SamplePlanner) {
        self.planner = planner
        inFlight = []
        planner.onChange = { [weak self] fetched in
            if fetched {
                self?.plannerChanged()
            } else {
                self?.requestPlan()
            }
        }
        if planner.hasLoaded { plannerChanged() }
    }

    /// Signed out, or the sample: no planner, and nothing of the last user's
    /// left pending, in the shade, in the outbox or remembered.
    func detach() async {
        planner?.onChange = nil
        planner = nil
        inFlight = []
        pendingOpen = nil
        planning?.cancel()
        planning = nil
        outbox.clear()
        await scheduler.clearAll()
    }

    /// A fetch landed (or the app came back): re-plan, drain what waited
    /// for the planner, and open a tapped cue. A write or a revert only
    /// re-plans: draining on a revert would send an unsent tap again at once,
    /// into the same failure, for as long as the phone is offline.
    func plannerChanged() {
        guard let planner, planner.isLive, planner.hasLoaded else { return }
        if let open = pendingOpen {
            pendingOpen = nil
            openItem(open.id, day: open.day)
        }
        drain()
        syncZone()
        requestPlan()
    }

    /// Back in front: the permission asked again (it may have changed in
    /// Settings), the outbox drained and a fresh plan.
    func foreground() async {
        await refreshPermission()
        plannerChanged()
    }

    /// Plans from the planner, once per burst of changes: a change while a
    /// plan runs plans again after it.
    func requestPlan() {
        if planning != nil {
            planAgain = true
            return
        }
        planning = Task { [weak self] in
            await Task.yield()
            while true {
                guard let self, !Task.isCancelled else { return }
                self.planAgain = false
                await self.planFromPlanner()
                if !self.planAgain {
                    self.planning = nil
                    return
                }
            }
        }
    }

    /// Waits for the plan under way, if any. Tests, and a background refresh.
    func settle() async {
        while let running = planning {
            await running.value
        }
        if let headless { _ = await headless.value }
    }

    private func planFromPlanner() async {
        guard let planner, let userId = planner.userId, planner.hasLoaded else { return }
        let snapshot = PlanSnapshot(items: planner.items, routines: planner.routines, seasons: planner.seasons,
                                    settings: planner.settings, snoozes: planner.snoozes)
        await scheduler.reconcile(snapshot, userId: userId)
        permission = await scheduler.center.permission()
    }

    /// The account stores a zone other than this iPhone's (or none): send
    /// this one, once a launch, as the web's useTimezoneSync does for a
    /// browser. The reminder scan and a snooze's day read it.
    private func syncZone() {
        guard let planner, planner.isLive, let account else { return }
        let device = zone()
        let stored = planner.settings.timezone?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard stored != device, sentZone != device, TimeZone(identifier: device) != nil else { return }
        sentZone = device
        let api = makeAPI(account)
        Task { try? await api.saveTimeZone(device) }
    }

    // MARK: Permission

    func refreshPermission() async {
        permission = await scheduler.center.permission()
    }

    /// The Remind sheet's Done with a time set: asks once, never at launch
    /// and never provisionally, then plans so the new cue is armed.
    func askPermissionIfNeeded() async {
        let current = await scheduler.center.permission()
        if current == .notDetermined {
            _ = await scheduler.center.requestPermission()
        }
        await refreshPermission()
        requestPlan()
    }

    // MARK: The delegate

    /// willPresent: show a dsul notification in front only if it still wants
    /// doing as the planner holds it now (a habit ticked on the Mac since the
    /// plan, a review already done). With no planner, it shows.
    func shouldPresent(_ info: NotificationInfo) -> Bool {
        guard NotificationKeys.isDsul(info.id), let planner, planner.isLive, planner.hasLoaded,
              let day = info.day(in: zone())
        else { return true }
        if info.kind == .eod {
            if planner.settings.eodReviewEnabled == false { return false }
            if let last = planner.settings.lastEodReviewDate, last >= day { return false }
            return true
        }
        guard let id = info.itemId else { return true }
        guard let item = planner.item(id), let dayString = DayString(day) else { return false }
        let ctx = ActivationContext(timeZone: zone(), routines: planner.routines, seasons: planner.seasons)
        return wantsDoingOn(item, on: dayString, ctx)
    }

    /// didReceive: Done and Snooze go to the outbox first, then out; a tap
    /// on the notification opens its item.
    func handle(_ action: NotificationAction, _ info: NotificationInfo) async {
        guard NotificationKeys.isDsul(info.id) else { return }
        switch action {
        case .dismiss:
            return
        case .open:
            guard let id = info.itemId, let day = info.day(in: zone()) else { return }
            if let planner, planner.isLive, planner.hasLoaded {
                openItem(id, day: day)
            } else {
                pendingOpen = (id, day)
            }
        case .done, .snooze:
            guard let userId = planner?.userId ?? account?.signedInUserId, let itemId = info.itemId,
                  let day = info.day(in: zone())
            else { return }
            let tapped = NotificationScheduler.epochMs(now())
            var entry = OutboxEntry(id: UUID(), userId: userId, kind: action == .done ? .done : .snooze,
                                    itemId: itemId, dateStr: day, tappedAtMs: tapped)
            if action == .snooze {
                // Held to its day as the server holds it: one past midnight
                // is "not tonight", and nothing is sent or armed.
                guard let until = snoozeFireInstant(nowMs: tapped, minutes: NotificationKeys.snoozeMinutes,
                                                    zone: zone(), dayStr: day)
                else { return }
                entry.untilMs = until
                scheduler.noteSnooze(LocalSnooze(itemId: itemId, date: day, untilMs: until), userId: userId)
                await armSnooze(info, itemId: itemId, day: day, untilMs: until)
            }
            outbox.append(entry)
            await send()
        }
    }

    /// Rings a snooze again at once with the tapped notification's words,
    /// before any plan: a plan replaces it under the same id, and with no
    /// network and no planner none may run before it is due.
    private func armSnooze(_ info: NotificationInfo, itemId: UUID, day: String, untilMs: Int) async {
        guard await scheduler.center.permission().canNotify else { return }
        let nowMs = NotificationScheduler.epochMs(now())
        let request = PlannedRequest(
            id: "\(itemIdentifier(itemId))#snooze", kind: .snoozed, itemId: itemId, dateStr: day,
            trigger: .afterMs(untilMs - nowMs), firesAt: untilMs, title: info.title, body: info.body,
            threadId: cueThread, summaryArgument: info.title, categoryId: cueCategory, relevance: 0,
            userInfo: PlannedUserInfo(kind: .snoozed, itemId: itemId, dateStr: day, at: info.userInfo["at"])
        )
        let left = Double(untilMs - nowMs) / 1000
        try? await scheduler.center.add(ScheduledNotification(request: request, afterSeconds: max(1, left)))
    }

    /// Sends what the outbox holds: through the planner when one is up and
    /// loaded, else on its own (`runHeadless`).
    private func send() async {
        if let planner, planner.isLive {
            if planner.hasLoaded { drain() }
            return
        }
        _ = await runHeadless()
    }

    private func openItem(_ id: UUID, day: String) {
        guard let planner, planner.item(id) != nil else { return }
        // The sheet's verbs act on today or the selected day: a cue from
        // another day opens on that day.
        if day != planner.today.description, let picked = DayString(day) { planner.select(picked) }
        planner.open(id, day: day == planner.today.description ? .today : .selected)
    }

    // MARK: Draining through the planner

    /// Hands each waiting tap to the planner's sync, once. A tap that turns
    /// out to need nothing (already done) leaves at once; one sent leaves when
    /// it landed or was refused, and stays for the next drain when it never
    /// got there.
    func drain() {
        guard let planner, planner.isLive, planner.hasLoaded, let userId = planner.userId else { return }
        var drop = Set<UUID>()
        for entry in outbox.entries where !inFlight.contains(entry.id) {
            guard entry.userId == userId else {
                drop.insert(entry.id)
                continue
            }
            let settled: @MainActor (PlannerSync.Settled) -> Void = { [weak self] outcome in
                guard let self else { return }
                self.inFlight.remove(entry.id)
                if outcome != .unsent { self.outbox.remove([entry.id]) }
            }
            // In flight before it is handed over: queuing the write tells the
            // planner it changed, which drains again.
            inFlight.insert(entry.id)
            let sent: Bool
            switch entry.kind {
            case .done:
                sent = planner.notificationDone(entry.itemId, on: entry.dateStr, timeZone: zone(), settled: settled)
            case .snooze:
                guard let minutes = minutesLeft(entry) else {
                    inFlight.remove(entry.id)
                    drop.insert(entry.id)
                    continue
                }
                sent = planner.notificationSnooze(entry.itemId, on: entry.dateStr, minutes: minutes,
                                                  timeZone: zone(), settled: settled)
            }
            if !sent {
                inFlight.remove(entry.id)
                drop.insert(entry.id)
            }
        }
        if !drop.isEmpty { outbox.remove(drop) }
    }

    /// A snooze's whole minutes left to its ring, at least one; nil once it
    /// has rung (this iPhone rang it; the server needn't).
    private func minutesLeft(_ entry: OutboxEntry) -> Int? {
        guard let until = entry.untilMs else { return nil }
        let left = until - NotificationScheduler.epochMs(now())
        guard left > 0 else { return nil }
        return max(1, (left + 59_999) / 60_000)
    }

    // MARK: With no planner

    /// A background refresh (BGAppRefreshTask): with a planner up, a fetch
    /// through it and a plan; with none, `runHeadless`. Answers whether it
    /// planned.
    func backgroundRefresh() async -> Bool {
        if let planner, planner.isLive {
            await planner.refresh()
            drain()
            requestPlan()
            await settle()
            return scheduler.lastPlan != nil
        }
        return await runHeadless()
    }

    /// No planner: fetch the planner with the account's token, send the
    /// outbox's taps for this user (each Done only if the fetched item still
    /// wants doing), and plan from the fetched planner with those taps on it.
    /// Signed out, it clears everything. Offline, it keeps the taps and plans
    /// nothing. One at a time.
    @discardableResult
    func runHeadless() async -> Bool {
        if let running = headless { return await running.value }
        let task = Task { [weak self] () -> Bool in
            guard let self else { return false }
            return await self.headlessPass()
        }
        headless = task
        let planned = await task.value
        headless = nil
        return planned
    }

    private func headlessPass() async -> Bool {
        guard let account, let userId = account.signedInUserId else {
            outbox.clear()
            await scheduler.clearAll()
            return false
        }
        let api = makeAPI(account)
        guard var payload = try? await api.fetchPlanner(), payload.userId == userId else { return false }
        let ctx = ActivationContext(timeZone: zone(), routines: payload.routines, seasons: payload.seasons)
        var done = Set<UUID>()
        sending: for entry in outbox.entries {
            guard entry.userId == userId else {
                done.insert(entry.id)
                continue
            }
            do {
                switch entry.kind {
                case .done:
                    guard let i = payload.items.firstIndex(where: { $0.id == entry.itemId }),
                          let day = DayString(entry.dateStr),
                          let intent = notificationDoneIntent(payload.items[i], on: day, ctx)
                    else {
                        done.insert(entry.id)
                        continue
                    }
                    try await api.complete(id: entry.itemId, date: entry.dateStr, done: intent.done,
                                           count: intent.count)
                    payload.items[i] = applying(intent, to: payload.items[i], on: day)
                case .snooze:
                    if let minutes = minutesLeft(entry) {
                        _ = try await api.snooze(id: entry.itemId, date: entry.dateStr, minutes: minutes,
                                                 timeZone: zone())
                    }
                }
                done.insert(entry.id)
            } catch {
                if PlannerSync.settled(error) == .refused {
                    done.insert(entry.id)
                    continue
                }
                // Offline or signed out: the rest wait for the next pass.
                break sending
            }
        }
        if !done.isEmpty { outbox.remove(done) }
        return await scheduler.reconcile(PlanSnapshot(payload), userId: userId) != nil
    }
}
