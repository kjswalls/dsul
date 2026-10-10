import DsulCore
import Foundation

// The hosted half of memory/plans/reminders-platforms.md §5.3: it asks
// DsulCore `planNotifications` what should be pending, and makes the center
// match. It decides nothing about a cue itself (ReminderPlan.swift's header
// has every rule); it diffs, adds, removes, withdraws, and remembers what this
// iPhone has already rung so the plan never rings a catch-up for a cue that
// rang at its own minute.
//
// Foundation-only, so it runs in the Linux test shim against a fake center.

/// What one plan reads: the planner as the phone holds it (a fetch, with the
/// phone's own writes on top), and the server's snoozes.
struct PlanSnapshot: Sendable, Hashable {
    var items: [Item]
    var routines: [Routine]
    var seasons: [Season]
    var settings: PlannerSettings
    var snoozes: [PlanSnooze]

    init(items: [Item], routines: [Routine] = [], seasons: [Season] = [], settings: PlannerSettings,
         snoozes: [PlanSnooze] = []) {
        self.items = items
        self.routines = routines
        self.seasons = seasons
        self.settings = settings
        self.snoozes = snoozes
    }

    init(_ payload: PlannerPayload) {
        self.init(items: payload.items, routines: payload.routines, seasons: payload.seasons,
                  settings: payload.settings, snoozes: payload.snoozes ?? [])
    }
}

/// What the scheduler keeps between plans, per user, on this iPhone. Holds
/// no item's words: ids, days and times.
struct SchedulerState: Codable, Sendable, Hashable {
    /// Whose state it is; another user's is dropped, never read.
    var userId: String
    /// `sentKeyFor(day, at)` of every cue rung or armed at its minute here,
    /// the last few days' only.
    var sentKeys: [String] = []
    /// When the last plan ran, epoch ms.
    var lastPlanMs: Int?
    /// The cue requests pending after the last plan, with their next ring:
    /// how the next plan learns which of them rang in between.
    var armed: [ArmedCue] = []
    /// Snoozes tapped on this iPhone, held until they ring, so one rings on
    /// time whether or not the server has taken it yet.
    var localSnoozes: [LocalSnooze] = []

    init(userId: String) {
        self.userId = userId
    }
}

/// One cue request as it was pending after a plan.
struct ArmedCue: Codable, Sendable, Hashable {
    var id: String
    var at: String
    var nextFireMs: Int
    var repeats: Bool
    var weekday: Int?
    var day: Int?
}

/// A snooze tapped here: the item, the day it is about, and when it rings.
struct LocalSnooze: Codable, Sendable, Hashable {
    var itemId: UUID
    var date: String
    var untilMs: Int
}

/// Where SchedulerState lives: UserDefaults in the app, memory in tests.
@MainActor
protocol SchedulerStateStore: AnyObject {
    func load() -> SchedulerState?
    func save(_ state: SchedulerState?)
}

@MainActor
final class UserDefaultsSchedulerStore: SchedulerStateStore {
    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults = .standard, key: String = "dsul.notifications.state") {
        self.defaults = defaults
        self.key = key
    }

    func load() -> SchedulerState? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(SchedulerState.self, from: data)
    }

    func save(_ state: SchedulerState?) {
        guard let state, let data = try? JSONEncoder().encode(state) else {
            defaults.removeObject(forKey: key)
            return
        }
        defaults.set(data, forKey: key)
    }
}

@MainActor
final class MemorySchedulerStore: SchedulerStateStore {
    var state: SchedulerState?

    init(_ state: SchedulerState? = nil) {
        self.state = state
    }

    func load() -> SchedulerState? { state }
    func save(_ state: SchedulerState?) { self.state = state }
}

@MainActor
final class NotificationScheduler {
    /// How many days of sent keys are kept: today's is all a plan reads, and
    /// two more cover a plan made just after midnight in a zone that moved.
    static let sentKeyDays = 3

    let center: any NotificationCenterPort
    private let store: any SchedulerStateStore
    private let now: () -> Date
    /// The device's IANA zone: a phone's cues ring where the phone is.
    private let zone: () -> String
    private(set) var state: SchedulerState?
    /// The last plan made, for tests and diagnostics.
    private(set) var lastPlan: NotificationPlan?

    init(center: any NotificationCenterPort, store: any SchedulerStateStore, now: @escaping () -> Date = { Date() },
         zone: @escaping () -> String = { TimeZone.current.identifier }) {
        self.center = center
        self.store = store
        self.now = now
        self.zone = zone
        self.state = store.load()
    }

    /// Plans for `userId` from `snapshot` and makes the center match: every
    /// planned request pending (one already pending with the same signature
    /// is left alone), every other dsul request removed, the plan's stale
    /// notifications withdrawn from the shade, and a catch-up delivered and
    /// remembered. Nothing at all while this iPhone doesn't allow dsul to
    /// notify: nothing would ring, and a user who allows it later gets a plan
    /// on the next return to the app. Answers the plan, or nil when none ran.
    @discardableResult
    func reconcile(_ snapshot: PlanSnapshot, userId: UUID) async -> NotificationPlan? {
        let owner = userId.uuidString.lowercased()
        var current = (state?.userId == owner ? state : nil) ?? SchedulerState(userId: owner)
        guard await center.permission().canNotify else {
            lastPlan = nil
            return nil
        }
        let nowMs = Self.epochMs(now())
        let tz = zone()
        guard let clock = localClock(nowMs: nowMs, timeZone: tz) else { return nil }
        let today = clock.dateStr

        let pendingBefore = await center.pending()
        let shade = await center.delivered()

        // What rang since the last plan: each armed cue whose next ring has
        // passed, and today's ring of a slot that kept repeating, and every
        // cue still in the shade.
        var sent = Set(current.sentKeys)
        sent.formUnion(Self.rang(current.armed, nowMs: nowMs, today: today, zone: tz))
        for note in shade where NotificationKeys.isDsul(note.id) {
            guard let at = note.at else { continue }
            if let day = note.dateStr ?? localClock(nowMs: note.deliveredAtMs, timeZone: tz)?.dateStr {
                sent.insert(sentKeyFor(day, at))
            }
        }

        current.localSnoozes.removeAll { $0.untilMs <= nowMs }
        let input = PlanInput(
            nowMs: nowMs,
            timeZone: tz,
            items: snapshot.items,
            routines: snapshot.routines,
            seasons: snapshot.seasons,
            timeFormat: snapshot.settings.timeFormat,
            remindersEnabled: snapshot.settings.remindersEnabled == true,
            eod: snapshot.settings.planEod,
            snoozes: Self.merged(snapshot.snoozes, current.localSnoozes),
            localSentKeys: sent,
            delivered: shade.map { PlanDelivered(id: $0.id, deliveredAtMs: $0.deliveredAtMs, dateStr: $0.dateStr) },
            graceMinutes: snapshot.settings.reminderGraceMinutes ?? reminderGraceMinutes
        )
        let plan = planNotifications(input)

        let wanted = Set(plan.requests.map(\.id))
        let stale = pendingBefore.map(\.id).filter { NotificationKeys.isDsul($0) && !wanted.contains($0) }
        if !stale.isEmpty { center.removePending(stale) }
        let signatures = Dictionary(pendingBefore.map { ($0.id, $0.signature) }, uniquingKeysWith: { first, _ in first })
        for request in plan.requests {
            var scheduled = ScheduledNotification(request: request)
            if case .now = request.trigger {
                // Delivered at once, so remembered at once: the next plan
                // must not ring it again.
                if let at = request.userInfo.at { sent.insert(sentKeyFor(request.dateStr ?? today, at)) }
            } else if let existing = signatures[request.id], existing == scheduled.signature {
                continue
            }
            if case .afterMs = request.trigger {
                let left = Double(request.firesAt - Self.epochMs(now())) / 1000
                scheduled.afterSeconds = max(1, left)
            }
            try? await center.add(scheduled)
        }
        if !plan.withdraw.isEmpty { center.removeDelivered(plan.withdraw) }

        let pendingAfter = await center.pending()
        current.armed = pendingAfter.compactMap(Self.armed)
        let oldest = addDays(today, -(Self.sentKeyDays - 1)) ?? today
        current.sentKeys = sent.filter { String($0.prefix(10)) >= oldest }.sorted()
        current.lastPlanMs = nowMs
        state = current
        store.save(current)
        lastPlan = plan
        return plan
    }

    /// A snooze tapped here: kept until it rings, so the next plan arms it
    /// whatever the server has.
    func noteSnooze(_ snooze: LocalSnooze, userId: UUID) {
        let owner = userId.uuidString.lowercased()
        var current = (state?.userId == owner ? state : nil) ?? SchedulerState(userId: owner)
        current.localSnoozes.removeAll { $0.itemId == snooze.itemId }
        current.localSnoozes.append(snooze)
        state = current
        store.save(current)
    }

    /// Sign-out, an account switch, or the sample: every dsul request and
    /// notification goes, and so does what was remembered.
    func clearAll() async {
        let pending = await center.pending().map(\.id).filter(NotificationKeys.isDsul)
        if !pending.isEmpty { center.removePending(pending) }
        let shade = await center.delivered().map(\.id).filter(NotificationKeys.isDsul)
        if !shade.isEmpty { center.removeDelivered(shade) }
        state = nil
        lastPlan = nil
        store.save(nil)
    }

    // MARK: Pieces

    nonisolated static func epochMs(_ date: Date) -> Int {
        return Int((date.timeIntervalSince1970 * 1000).rounded(.down))
    }

    /// The server's snoozes with this iPhone's on top: one per item, the
    /// later ring when both name the same day, this iPhone's for any other
    /// day (it was tapped since the server's).
    nonisolated static func merged(_ server: [PlanSnooze], _ local: [LocalSnooze]) -> [PlanSnooze] {
        var byItem: [UUID: PlanSnooze] = [:]
        var order: [UUID] = []
        for snooze in server {
            if byItem[snooze.itemId] == nil { order.append(snooze.itemId) }
            byItem[snooze.itemId] = snooze
        }
        for snooze in local {
            let mine = PlanSnooze(itemId: snooze.itemId, until: isoString(ms: snooze.untilMs), date: snooze.date)
            if let theirs = byItem[snooze.itemId] {
                if theirs.date == snooze.date, let theirMs = parseEpochMs(theirs.until), theirMs >= snooze.untilMs {
                    continue
                }
            } else {
                order.append(snooze.itemId)
            }
            byItem[snooze.itemId] = mine
        }
        return order.compactMap { byItem[$0] }
    }

    /// The sent keys of the armed cues that rang by `nowMs`: a one-off at its
    /// ring; a repeating slot at its first ring after the plan, and today's
    /// too when the slot rings today and that minute has passed.
    nonisolated static func rang(_ armed: [ArmedCue], nowMs: Int, today: String, zone: String) -> Set<String> {
        var keys = Set<String>()
        for cue in armed where cue.nextFireMs <= nowMs {
            if let day = localClock(nowMs: cue.nextFireMs, timeZone: zone)?.dateStr {
                keys.insert(sentKeyFor(day, cue.at))
            }
            guard cue.repeats, let minutes = minutesOfDay(cue.at),
                  let ring = instantOf(today, minutes: minutes, timeZone: zone),
                  ring >= cue.nextFireMs, ring <= nowMs, ringsOn(today, weekday: cue.weekday, day: cue.day)
            else { continue }
            keys.insert(sentKeyFor(today, cue.at))
        }
        return keys
    }

    /// Does a calendar slot with this weekday (1 = Sunday … 7 = Saturday) or
    /// day of the month ring on `dateStr`? Neither: every day.
    nonisolated static func ringsOn(_ dateStr: String, weekday: Int?, day: Int?) -> Bool {
        if let weekday {
            guard let dow = weekdayOf(dateStr) else { return false }
            return dow + 1 == weekday
        }
        if let day {
            return Int(dateStr.suffix(2)) == day
        }
        return true
    }

    /// A pending request worth remembering: a cue at its own minute (not a
    /// snooze, which rings at another, and not the review).
    nonisolated static func armed(_ pending: PendingNotification) -> ArmedCue? {
        guard NotificationKeys.isDsul(pending.id), !pending.id.hasSuffix("#snooze"), pending.itemId != nil,
              let at = pending.at, let next = pending.nextFireMs
        else { return nil }
        return ArmedCue(id: pending.id, at: at, nextFireMs: next, repeats: pending.repeats, weekday: pending.weekday,
                        day: pending.day)
    }
}
