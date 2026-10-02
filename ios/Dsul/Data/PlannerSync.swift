import DsulCore
import Foundation

/// Keeps a signed-in planner in step with the server. The planner changes
/// first, at once (optimistic); this sends the change, and fetches.
///
/// The rules, each there because the obvious version was wrong:
/// - **One write at a time, in order.** `set_item_completion` moves the streak
///   only when the array changes, so a tick and an untick sent side by side
///   can land reversed and leave the server done while the phone shows not
///   done. Writes are chained Tasks; `drain()` awaits them.
/// - **A fetch lands only if nothing moved under it**: no write pending when
///   it started, none queued since (`writeGeneration`), and no braindump row in
///   the air (`isDragging`). A GET sent while a POST is in flight can be
///   answered before the POST commits, and applying it would undo the tick on
///   screen. A discarded fetch is made again once the writes drain (or the
///   drag's hold lets go), or, when they have already landed, after a short
///   pause that grows each time. It is never dropped: a refresh abandoned
///   under steady ticking would leave a failed write unchecked.
/// - **A failed write** shows a banner and refetches once the queue drains,
///   and the server's answer replaces the guess. If that refetch fails too,
///   each failed write's slot (`WriteSlot`) is rebased, unless a write for the
///   item is still queued: the slot goes back to the item before the earliest
///   failed write in it, with every write in it that landed after that one
///   played again on top, in order, through the planner's own steps. So the
///   slot ends where the server holds it, and every other slot is left as it
///   is: a tick that landed is never undone by a carry that failed.
/// - **A landed write doesn't moot a failed one.** Two writes in one slot need
///   not set the same fields (a carry keeps the time a failed drop set, a skip
///   leaves the tally a failed tick set, a resume of an item the server never
///   paused writes nothing), so the later one is replayed, never trusted.
/// - **A failed capture** takes its item with it, unless a later write on the
///   item landed: the route answers 404 for a missing row, so any write it
///   took proves the row is there.
/// - **No polling and no realtime** (the web has neither): a fetch on sign-in,
///   on returning to the app at most once a minute, and on pull to refresh.
@MainActor
final class PlannerSync {
    /// What the phone writes, each an intent (lib/app-api.ts): capture, and
    /// the item writes POST /api/app/items/:id takes, named by its `action`
    /// (tick, braindump row to an hour, Skip/Unskip today, Tomorrow and
    /// Reschedule, Pause/Pause until/Resume).
    enum Write: Sendable, Hashable {
        case complete(id: UUID, date: String, done: Bool, count: Int?)
        case schedule(id: UUID, date: String, startTime: String)
        case capture(id: UUID, title: String)
        /// `skipped` true skips the occurrence on `date`, false unskips it.
        case skip(id: UUID, date: String, skipped: Bool)
        /// The day to carry the item to.
        case move(id: UUID, date: String)
        /// `pausedUntil` is the exclusive resume day, with `paused` only; nil
        /// is no end. `timeZone` is the zone the phone read today in, which the
        /// server uses only when the account stores none.
        case pause(id: UUID, paused: Bool, pausedUntil: String?, timeZone: String?)

        var itemId: UUID {
            switch self {
            case .complete(let id, _, _, _), .schedule(let id, _, _), .capture(let id, _), .skip(let id, _, _),
                 .move(let id, _), .pause(let id, _, _, _):
                return id
            }
        }

        /// The fields this write sets, as a slot. `item` is the item before
        /// it: a tick on a one-off (neither a habit nor recurring) sets the
        /// item's status, whatever day it was sent with, so it is `.status`,
        /// never a day.
        func slot(for item: Item?) -> WriteSlot {
            switch self {
            case .complete(_, let date, _, _):
                if let item, !item.isHabit, !item.recurs { return .status }
                return .day(date)
            case .skip(_, let date, _):
                return .day(date)
            case .schedule, .move:
                return .placement
            case .pause:
                return .pause
            case .capture:
                return .create
            }
        }
    }

    /// Which of an item's fields a write sets. Writes in different slots never
    /// touch each other's fields, so a revert puts back one slot and leaves
    /// the rest. Writes in one slot need not set the same fields, so a write
    /// that landed after a failed one in its slot is replayed on the revert,
    /// not taken as the slot's end state (`revertFailures`).
    enum WriteSlot: Sendable, Hashable {
        /// One day's tick or skip of a habit or a recurring item: that day's
        /// completion, skip and tally, and the streak and the status snapshot
        /// they move.
        case day(String)
        /// A one-off's tick: its status, which is the whole item's, not a day's.
        case status
        /// Where the item sits: its day, time, bucket, scheduled flag and block.
        case placement
        /// Its pause window.
        case pause
        /// The item itself: a capture.
        case create
    }

    private struct Failure {
        let itemId: UUID
        let slot: WriteSlot
        /// The item before the write; nil for a capture (it didn't exist).
        let snapshot: Item?
        let seq: Int
    }

    /// One slot of one item.
    private struct SlotKey: Hashable {
        let itemId: UUID
        let slot: WriteSlot
    }

    /// A write that landed, kept for a revert to replay.
    private struct Landed {
        let write: Write
        let slot: WriteSlot
        let seq: Int
    }

    private enum Outcome {
        case applied, raced, failed, waitingForDrag
    }

    /// Returning to the app fetches at most this often.
    static let foregroundInterval: TimeInterval = 60
    /// The longest pause between fetches that writes keep racing.
    static let racePauseCap: Duration = .seconds(4)

    let userId: UUID
    private weak var planner: SamplePlanner?
    private let api: APIClient
    private let isDragging: @MainActor () -> Bool
    private let now: () -> Date

    /// Bumped by every write queued: a fetch that sees it move knows a write
    /// raced it. Also each write's sequence number.
    private(set) var writeGeneration = 0
    /// Writes queued or in flight.
    private(set) var pending = 0
    /// How many fetches landed, and the `fetchedAt` of the last: how a test
    /// tells a discarded fetch from one that was applied.
    private(set) var appliedFetches = 0
    private(set) var lastAppliedFetchedAt: String?
    /// The pause before fetching again after a fetch raced by writes that
    /// have all landed; it doubles each time, up to `racePauseCap`. A test
    /// shortens it.
    var racePause: Duration = .milliseconds(500)

    private var tail: Task<Void, Never>?
    private var fetching: Task<Void, Never>?
    private var dragWaiter: Task<Void, Never>?
    private var queuedByItem: [UUID: Int] = [:]
    /// The writes that landed while a failure was held, in order: what a
    /// revert replays. Writes run in order, so only a failure older than a
    /// write can need it, and none is kept while no failure is.
    private var landed: [Landed] = []
    private var failures: [Failure] = []
    private var refetchWhenDrained = false
    private var lastFetchStarted: Date?
    private var stopped = false

    init(planner: SamplePlanner, api: APIClient, userId: UUID, isDragging: @escaping @MainActor () -> Bool,
         now: @escaping () -> Date = { Date() }) {
        self.planner = planner
        self.api = api
        self.userId = userId
        self.isDragging = isDragging
        self.now = now
    }

    // MARK: Writes

    /// Queues `write` behind every earlier one. `snapshot` is the item as it
    /// was before the planner's optimistic step, for the revert; it also
    /// decides the write's slot.
    func enqueue(_ write: Write, snapshot: Item?) {
        guard !stopped else { return }
        writeGeneration += 1
        let seq = writeGeneration
        let slot = write.slot(for: snapshot)
        queuedByItem[write.itemId, default: 0] += 1
        pending += 1
        let previous = tail
        tail = Task { [weak self] in
            await previous?.value
            await self?.run(write, slot: slot, snapshot: snapshot, seq: seq)
        }
    }

    /// Waits until every queued write has been sent and any fetch they set off
    /// has landed. Tests, and pull to refresh, use it.
    func drain() async {
        for _ in 0..<100 {
            if let tail { await tail.value }
            if let fetching { await fetching.value }
            if pending == 0 && fetching == nil { return }
        }
    }

    /// Sign-out or an account switch: nothing queued is sent, and nothing in
    /// flight reaches the planner.
    func stop() {
        stopped = true
        dragWaiter?.cancel()
        dragWaiter = nil
    }

    private func run(_ write: Write, slot: WriteSlot, snapshot: Item?, seq: Int) async {
        let id = write.itemId
        if !stopped {
            do {
                try await perform(write)
                if !failures.isEmpty {
                    landed.append(Landed(write: write, slot: slot, seq: seq))
                }
            } catch is CancellationError {
                // Signed out while it was out: nothing to say.
            } catch {
                failed(write, slot: slot, snapshot: snapshot, seq: seq, error: error)
            }
        }
        queuedByItem[id, default: 1] -= 1
        pending -= 1
        if pending == 0 { drained() }
    }

    private func perform(_ write: Write) async throws {
        switch write {
        case .complete(let id, let date, let done, let count):
            try await api.complete(id: id, date: date, done: done, count: count)
        case .schedule(let id, let date, let startTime):
            try await api.schedule(id: id, date: date, startTime: startTime)
        case .capture(let id, let title):
            try await api.capture(id: id, title: title)
        case .skip(let id, let date, let skipped):
            try await api.skip(id: id, date: date, skipped: skipped)
        case .move(let id, let date):
            try await api.move(id: id, date: date)
        case .pause(let id, let paused, let pausedUntil, let timeZone):
            try await api.pause(id: id, paused: paused, pausedUntil: pausedUntil, timeZone: timeZone)
        }
    }

    private func failed(_ write: Write, slot: WriteSlot, snapshot: Item?, seq: Int, error: Error) {
        // Auth already moved to the sign-in screen; this planner is going.
        if (error as? APIError) == .signedOut { return }
        failures.append(Failure(itemId: write.itemId, slot: slot, snapshot: snapshot, seq: seq))
        refetchWhenDrained = true
        planner?.show(Self.writeFailureText(error), isError: true)
    }

    /// The queue just emptied. A fetch in flight now started before these
    /// writes landed, so it will be discarded and fetch again itself.
    private func drained() {
        guard refetchWhenDrained, !stopped, fetching == nil else { return }
        refetchWhenDrained = false
        startFetch()
    }

    // MARK: Fetching

    /// Fetches now, or joins the fetch already out.
    func refresh() async {
        guard !stopped else { return }
        await startFetch().value
    }

    /// Returning to the app: a fetch, unless one started under a minute ago.
    func refreshIfStale() {
        guard !stopped else { return }
        if let last = lastFetchStarted, now().timeIntervalSince(last) < Self.foregroundInterval { return }
        startFetch()
    }

    @discardableResult
    private func startFetch() -> Task<Void, Never> {
        if let running = fetching { return running }
        let task = Task { [weak self] in
            guard let self else { return }
            await self.fetchLoop()
            self.fetching = nil
        }
        fetching = task
        return task
    }

    /// Fetches until one lands or there is a reason to stop. A fetch raced by
    /// writes that have all landed is made again after a pause that grows
    /// (`racePause`, doubling to `racePauseCap`), so steady ticking costs
    /// about one GET a pause and the loop ends after the first round trip
    /// no write lands in. One raced by writes still queued waits for the
    /// drain, which refetches. The retry stays inside this loop, so `drain()`
    /// (which awaits `fetching`) waits for it.
    private func fetchLoop() async {
        var pause: Duration = racePause
        while !stopped {
            // This pass is the refetch: a write that fails during it sets the
            // flag again, and the next pass (or the drain) checks it.
            refetchWhenDrained = false
            let outcome = await fetchOnce()
            switch outcome {
            case .applied, .failed, .waitingForDrag:
                return
            case .raced:
                break
            }
            if pending > 0 {
                refetchWhenDrained = true
                return
            }
            try? await Task.sleep(for: pause)
            pause = min(pause * 2, Self.racePauseCap)
            if pending > 0 {
                refetchWhenDrained = true
                return
            }
        }
    }

    private func fetchOnce() async -> Outcome {
        let startGeneration = writeGeneration
        let startedIdle = pending == 0
        lastFetchStarted = now()
        // A retry of a failed first load shows the spinner again, not the
        // old error, until it lands or fails.
        planner?.noteLoadStarted()
        let payload: PlannerPayload
        do {
            payload = try await api.fetchPlanner()
        } catch {
            fetchFailed(error)
            return .failed
        }
        guard !stopped else { return .failed }
        // Someone else's planner never reaches the screen, whatever sent it.
        guard payload.userId == userId else {
            fetchFailed(APIError.badResponse)
            return .failed
        }
        guard startedIdle, writeGeneration == startGeneration else { return .raced }
        if isDragging() {
            waitForDragThenFetch()
            return .waitingForDrag
        }
        planner?.apply(payload)
        appliedFetches += 1
        lastAppliedFetchedAt = payload.fetchedAt
        // The server's answer replaced every guess, failed ones included.
        failures.removeAll()
        landed.removeAll()
        return .applied
    }

    private func fetchFailed(_ error: Error) {
        if error is CancellationError || (error as? APIError) == .signedOut { return }
        if !failures.isEmpty {
            revertFailures()
            planner?.show("Couldn't reach dsul, so that change was undone.", isError: true)
            return
        }
        let text = Self.fetchFailureText(error)
        planner?.noteLoadFailure(text)
        if planner?.hasLoaded == true {
            planner?.show(text, isError: true)
        }
    }

    /// Rebases each failed slot, unless a write for the item is still queued:
    /// the item before the earliest failed write in the slot, with every write
    /// in the slot that landed after that one played on it in order
    /// (`replaying`), put back over that slot's fields alone. A later failure
    /// in the slot adds nothing, since the server never took it, and a landed
    /// write in another slot keeps its own fields. A capture undone takes the
    /// item, and every other failure on it, with it; it is undone only when no
    /// later write on the item landed.
    private func revertFailures() {
        defer {
            failures.removeAll()
            landed.removeAll()
        }
        guard let planner else { return }
        let today = planner.today.description
        let zone = planner.timeZoneID
        var rebased = Set<SlotKey>()
        var removed = Set<UUID>()
        for failure in failures.sorted(by: { $0.seq < $1.seq }) {
            let id = failure.itemId
            let key = SlotKey(itemId: id, slot: failure.slot)
            if rebased.contains(key) || removed.contains(id) { continue }
            if (queuedByItem[id] ?? 0) > 0 { continue }
            rebased.insert(key)
            let since = landed.filter { $0.write.itemId == id && $0.seq > failure.seq }
            guard let snapshot = failure.snapshot else {
                // A capture.
                if since.isEmpty {
                    planner.restore(id, slot: failure.slot, from: nil)
                    removed.insert(id)
                }
                continue
            }
            var item = snapshot
            for later in since where later.slot == failure.slot {
                item = replaying(later.write, on: item, today: today, timeZone: zone)
            }
            planner.restore(id, slot: failure.slot, from: item)
        }
    }

    /// `item` with `write`, which landed, played on it through the planner's
    /// own optimistic step for that write, so a rebase ends where the server
    /// holds the item. A pause is resolved against `item`, as the server
    /// resolved it against its row, on `today` in the write's zone (or
    /// `timeZone`) at the clock's now; one already satisfied, or refused,
    /// changes nothing.
    private func replaying(_ write: Write, on item: Item, today: String, timeZone: String) -> Item {
        switch write {
        case .complete(_, let date, let done, let count):
            guard let day = DayString(date) else { return item }
            return applying(TickIntent(done: done, count: count), to: item, on: day)
        case .schedule(_, let date, let startTime):
            // The phone sent the time as `minutesToTime` wrote it.
            guard let startMin = minutesAfterMidnight(startTime) else { return item }
            return placing(item, on: date, startMin: startMin)
        case .skip(_, let date, let skipped):
            return skipping(item, on: date, skipped: skipped)
        case .move(_, let date):
            return moving(item, to: date)
        case .pause(_, let paused, let pausedUntil, let zone):
            let result = resolvePauseWrite(current: item, paused: paused,
                                           pausedUntil: pausedUntil.map { ColumnWrite.set($0) }, todayStr: today,
                                           nowISO: toISOString(now()), timeZone: zone ?? timeZone)
            guard case .patch(let patch) = result, !patch.isEmpty else { return item }
            return pausing(item, patch: patch)
        case .capture:
            return item
        }
    }

    /// A fetch held back by a drag is made again once the hold lets go (the
    /// drop, half a second after the drag ends, or its lease running out if
    /// the end never came). Polls the hold, not the network; two minutes
    /// outlasts the lease, and a hold renewed longer than that just waits
    /// again.
    private func waitForDragThenFetch() {
        guard dragWaiter == nil else { return }
        dragWaiter = Task { [weak self] in
            for _ in 0..<240 {
                guard let strong = self else { return }
                if !strong.isDragging() { break }
                try? await Task.sleep(for: .milliseconds(500))
            }
            guard let strong = self else { return }
            strong.dragWaiter = nil
            guard !strong.stopped else { return }
            strong.startFetch()
        }
    }

    // MARK: Words

    private static func writeFailureText(_ error: Error) -> String {
        if (error as? APIError) == .unavailable {
            return "Couldn't reach dsul. Checking what was saved…"
        }
        return "That change didn't save. Checking with the server…"
    }

    private static func fetchFailureText(_ error: Error) -> String {
        if (error as? APIError) == .unavailable {
            return "Couldn't reach dsul. Pull down to try again."
        }
        return "Couldn't load your day. Pull down to try again."
    }
}

extension PlannerSync.WriteSlot {
    /// `current` with this slot's fields as they were in `snapshot`, and every
    /// other field as it is now: what a revert puts back for a write the server
    /// never took, so it can't take a landed write in another slot with it.
    ///
    /// A day puts back that day's completion, moving the streak back by one
    /// the way the completion moved it (HabitCompletion.swift; a task keeps
    /// none), its skip and its tally, and the status snapshot and day count the
    /// web writes beside them. A one-off's status is the status alone. A
    /// capture is the snapshot whole.
    func restoring(_ current: Item, from snapshot: Item) -> Item {
        var next = current
        switch self {
        case .create:
            return snapshot
        case .status:
            next.status = snapshot.status
        case .placement:
            next.startDate = snapshot.startDate
            next.startTime = snapshot.startTime
            next.timeBucket = snapshot.timeBucket
            next.isScheduled = snapshot.isScheduled
            next.inProjectBlock = snapshot.inProjectBlock
        case .pause:
            next.pausedAt = snapshot.pausedAt
            next.pausedUntil = snapshot.pausedUntil
        case .day(let date):
            let wasDone = snapshot.completedDates.contains(date)
            if current.completedDates.contains(date) != wasDone {
                if wasDone {
                    next.completedDates.append(date)
                } else {
                    next.completedDates.removeAll { $0 == date }
                }
                if current.isHabit {
                    let streak = current.streak ?? 0
                    next.streak = wasDone ? streak + 1 : max(0, streak - 1)
                }
            }
            if snapshot.skippedDates.contains(date) {
                if !current.skippedDates.contains(date) { next.skippedDates.append(date) }
            } else {
                next.skippedDates.removeAll { $0 == date }
            }
            next.dailyCounts[date] = snapshot.dailyCounts[date]
            next.status = snapshot.status
            next.currentDayCount = snapshot.currentDayCount
        }
        return next
    }
}
