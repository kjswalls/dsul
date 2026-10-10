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
///   each subject a failed write touched (`Subject`: an item, or from 2f-b
///   one item's membership of one routine or season) is rebased on its own.
///   It goes back to what it was before its earliest failed write (`Before`:
///   the item and its place in the list, or absent for a capture or a new
///   subtask; for a membership, its place in the container's list or none),
///   every write that landed after that one and names it is played again on
///   top, in order, through the planner's own steps (`replaying`), and the
///   result is put back whole: the item replaced, removed, or reinserted
///   where it stood. So it ends where the server holds it, whatever fields
///   each write set: a tick that landed is never undone by a carry that
///   failed, a delete that failed brings the item back with its subtasks,
///   and an edit that failed under a delete that landed stays gone. It is
///   exact because a fetch is applied only with no write pending or queued,
///   so between a write's snapshot and its revert only the phone's own
///   writes changed the subject, and each of the planner's steps matches the
///   server's write (the fixtures check it). A subject with a write still
///   queued that names or proves it keeps its failures, and the landed writes
///   that name it, until that write is in, and the drain refetches.
/// - **A membership is its own subject** (2f-b). A routine or season toggle
///   changes no field of its item: it adds or removes one row of the
///   container's members (the route's `collect`). Its revert plays the
///   toggles of that membership that landed since its earliest failure
///   (`rebaseMember`) and puts the answer back through the planner
///   (`restoreMembership`): out, or in at the place it held before, since
///   the server keeps a member's place, and last when it wasn't in before.
///   Each place was measured against the list the toggles before it had
///   left, so several are put back newest failure first, as deletes are. A
///   landed toggle proves its item, as any landed write on it does.
/// - **A landed write doesn't moot a failed one.** Two writes need not set the
///   same fields (a carry keeps the time a failed drop set, a skip leaves the
///   tally a failed tick set, a resume of an item the server never paused
///   writes nothing), so the later one is replayed, never trusted. A pause is
///   replayed at its own `sentAt`, the instant it went out, because that is
///   when the server resolved it, not when the revert runs.
/// - **A failed capture, or a new subtask,** takes its item with it, unless a
///   later write that names or proves it landed: the route answers 404 for a
///   missing row, so any write it took proves the row is there, and a new
///   subtask under a captured item proves its parent. A new subtask answered
///   404 failed like any refusal: the 404 is its parent's, and it was never
///   made.
/// - **Delete cascades on the server, so its replay does too.** A landed
///   delete of anything but a habit also removes any subject whose replayed
///   state is one of its subtasks, matched as it replays rather than from the
///   list the delete recorded: the server deletes every live subtask it finds,
///   one the phone had already taken out on its own included. A delete
///   answered 404 `not_found` landed, since the row is gone either way; a 404
///   without that code is an edge's or a proxy's, and fails.
/// - **Writes ask iOS for background time** (`BackgroundTime`) whenever one
///   is queued and none is held, until the queue drains or the sync stops, so
///   a tick, a title saved on the way out or a delete just before a swipe
///   home gets the half minute or so iOS allows. Not only on the queue's
///   first write: once iOS has taken the time back with a write still out,
///   the next one asks again. A write still out when the time runs out fails
///   on resume and is handled as above.
/// - **No polling and no realtime** (the web has neither): a fetch on sign-in,
///   on returning to the app at most once a minute, and on pull to refresh.
@MainActor
final class PlannerSync {
    /// What the phone writes, each an intent (lib/app-api.ts): capture, and
    /// the item writes POST /api/app/items/:id takes, named by its `action`
    /// (tick, braindump row to an hour, Skip/Unskip today, Tomorrow and
    /// Reschedule, Pause/Pause until/Resume, the item sheet's title, notes,
    /// priority, times a day, reminder, time, repeat and project, Delete, Add
    /// a subtask, Reset streak, and its routine and season toggles), and a
    /// notification's Snooze.
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
        /// A typed edit, sent as its own action (`title`, `notes`, `priority`,
        /// `timesPerDay`, `reminder`, `time`, `repeat`, `project`).
        case edit(id: UUID, ItemEdit)
        /// Delete. `removed` is what the planner's step took out (DsulCore
        /// `deleting`): the item, then its subtasks, each with its place,
        /// recorded at enqueue. `cascades` is true unless the item is a habit:
        /// the server then deletes every live subtask it finds as well.
        case delete(id: UUID, removed: [PlacedItem], cascades: Bool)
        /// Add a subtask: `id` is the new subtask, made by the phone, sent to
        /// its `parent`'s route with `title`, already cleaned.
        case addSubtask(id: UUID, parent: UUID, title: String)
        /// Reset streak: the counter to 0, the completion history kept.
        case resetStreak(id: UUID)
        /// (2f-b) Join (`member`) or leave one routine or season: one
        /// membership row. Changes no item field.
        case collect(id: UUID, kind: ContainerKind, containerId: String, member: Bool)
        /// A notification's Snooze: rings again in `minutes`, on `date` only
        /// (read in `timeZone` when the account stores no zone). Writes the
        /// snooze columns, which the planner doesn't hold, so it changes
        /// nothing on screen and has nothing to revert.
        case snooze(id: UUID, date: String, minutes: Int, timeZone: String?)

        /// The item the write is about: for a new subtask the subtask, not
        /// the parent whose route it goes to.
        var itemId: UUID {
            switch self {
            case .complete(let id, _, _, _), .schedule(let id, _, _), .capture(let id, _), .skip(let id, _, _),
                 .move(let id, _), .pause(let id, _, _, _), .edit(let id, _), .delete(let id, _, _),
                 .addSubtask(let id, _, _), .resetStreak(let id), .collect(let id, _, _, _),
                 .snooze(let id, _, _, _):
                return id
            }
        }

        /// What this write changes: its item (a new subtask's is the
        /// subtask), for a delete each subtask it took out with it, and for a
        /// toggle the one membership, never the item.
        var subjects: Set<Subject> {
            switch self {
            case .delete(let id, let removed, _):
                var named = Set(removed.map { Subject.item($0.item.id) })
                named.insert(.item(id))
                return named
            case .collect(let id, let kind, let containerId, _):
                return [.member(kind, containerId: containerId, item: id)]
            case .snooze:
                return []
            case .complete, .schedule, .capture, .skip, .move, .pause, .edit, .addSubtask, .resetStreak:
                return [.item(itemId)]
            }
        }

        /// The rows a 200 to this write proves exist without changing them,
        /// as a later write proves a capture whose answer was lost: a new
        /// subtask proves its parent, since the route answers 404 for a parent
        /// that isn't there, and a toggle its item, for the same reason. No
        /// other write proves anything it doesn't name.
        var proves: Set<Subject> {
            switch self {
            case .addSubtask(_, let parent, _):
                return [.item(parent)]
            case .collect(let id, _, _, _):
                return [.item(id)]
            case .complete, .schedule, .capture, .skip, .move, .pause, .edit, .delete, .resetStreak, .snooze:
                return []
            }
        }
    }

    /// One thing a write changes and a revert puts back on its own: an item,
    /// its fields and whether it exists at all; or whether one item is in one
    /// routine or season.
    enum Subject: Hashable, Sendable {
        case item(UUID)
        /// (2f-b) Whether `item` is in one routine or season: the one row a
        /// `collect` writes.
        case member(ContainerKind, containerId: String, item: UUID)

        /// The item it is about: its own id, or the member's.
        var itemId: UUID {
            switch self {
            case .item(let id): id
            case .member(_, _, let item): item
            }
        }
    }

    /// A subject as it was before a write, for that write's revert.
    enum Before: Sendable, Hashable {
        /// It existed: the item, and where it stood in the planner's list.
        case item(Item, Place)
        /// It didn't yet: a capture or a new subtask, which made `created`.
        case absent(created: Item)
        /// (2f-b) Where the item stood in the container's `itemIds` before
        /// the toggle; nil when it wasn't in it.
        case member(index: Int?)

        /// The item it holds, made yet or not; nil for a membership.
        var snapshot: Item? {
            switch self {
            case .item(let item, _): item
            case .absent(let created): created
            case .member: nil
            }
        }
    }

    /// A write the server didn't take, and every subject it touched as it was
    /// before it.
    private struct Failure {
        let seq: Int
        var before: [Subject: Before]
    }

    /// A write that landed, kept for a revert to replay.
    private struct Landed {
        let seq: Int
        let write: Write
        /// What it changed.
        let subjects: Set<Subject>
        /// What its 200 proves exists, unchanged.
        let proves: Set<Subject>
        /// The instant its `perform` started, when the server resolved it.
        let sentAt: Date

        /// Would the server's cascade, deleting this write's item, take any
        /// of `items` with it?
        func cascades(onto items: [Item]) -> Bool {
            guard case .delete(let parent, _, true) = write else { return false }
            return items.contains { isDeletedWith($0, parent: parent) }
        }
    }

    /// One subject's rebase: what to put back, and where if it is gone.
    private struct Target {
        let subject: Subject
        let item: Item?
        let place: Place?
        /// The failed write that recorded `place`, which is the list the
        /// place was measured against.
        let placeSeq: Int?
        /// Its earliest failure.
        let seq: Int
    }

    /// (2f-b) One membership's rebase: whether the item goes back in, and at
    /// what place in the container's list, nil for last.
    private struct MemberTarget {
        let subject: Subject
        let member: Bool
        let index: Int?
        /// Its earliest failure, which recorded `index`.
        let seq: Int
    }

    private enum Outcome {
        case applied, raced, failed, waitingForDrag
    }

    /// How a write ended, for a caller that asked (`enqueue`'s `settled`):
    /// the notification outbox, which keeps a tap until the server has it.
    enum Settled: Sendable, Equatable {
        /// The server took it.
        case landed
        /// The server said no (a 4xx, or an answer that couldn't be read):
        /// sending it again would get the same.
        case refused
        /// It never reached the server, or no one can tell: offline, signed
        /// out, cancelled, or the sync stopped first. Worth sending again.
        case unsent
    }

    /// Returning to the app fetches at most this often.
    static let foregroundInterval: TimeInterval = 60
    /// The longest pause between fetches that writes keep racing.
    static let racePauseCap: Duration = .seconds(4)
    /// The name iOS is given for the time the queue asks for.
    static let backgroundTaskName = "dsul.writes"

    let userId: UUID
    private weak var planner: SamplePlanner?
    private let api: APIClient
    private let isDragging: @MainActor () -> Bool
    private let now: () -> Date
    private let backgroundTime: BackgroundTime

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
    /// Writes queued or in flight, by every subject each names or proves.
    private var queuedBySubject: [Subject: Int] = [:]
    /// Who asked to hear how each write ended, by its sequence number.
    private var settlers: [Int: @MainActor (Settled) -> Void] = [:]
    /// Deletes queued or in flight that cascade, by the item deleted: a
    /// subtask one of them may take holds its revert back too.
    private var queuedCascades: [UUID: Int] = [:]
    /// The writes that landed while a failure was held, in order: what a
    /// revert replays. Writes run in order, so only a failure older than a
    /// write can need it, and none is kept while no failure is.
    private var landed: [Landed] = []
    private var failures: [Failure] = []
    private var refetchWhenDrained = false
    private var lastFetchStarted: Date?
    private var stopped = false
    /// The background time held while writes are out, from `begin`.
    private var backgroundToken: Int?

    /// `now` is the planner's clock: a pause's `sentAt`, and how long since
    /// the last fetch.
    init(planner: SamplePlanner, api: APIClient, userId: UUID, isDragging: @escaping @MainActor () -> Bool,
         now: @escaping () -> Date = { Date() }, backgroundTime: BackgroundTime = .foregroundOnly) {
        self.planner = planner
        self.api = api
        self.userId = userId
        self.isDragging = isDragging
        self.now = now
        self.backgroundTime = backgroundTime
    }

    // MARK: Writes

    /// Queues `write` behind every earlier one. `before` is each subject the
    /// write touches as it was before the planner's optimistic step, for the
    /// revert. `settled`, when given, hears how it ended, once.
    func enqueue(_ write: Write, before: [Subject: Before], settled: (@MainActor (Settled) -> Void)? = nil) {
        guard !stopped else {
            settled?(.unsent)
            return
        }
        writeGeneration += 1
        let seq = writeGeneration
        if let settled { settlers[seq] = settled }
        planner?.noteChanged()
        for subject in write.subjects.union(write.proves) {
            queuedBySubject[subject, default: 0] += 1
        }
        if case .delete(let id, _, true) = write {
            queuedCascades[id, default: 0] += 1
        }
        beginBackgroundTime()
        pending += 1
        let previous = tail
        tail = Task { [weak self] in
            await previous?.value
            await self?.run(write, before: before, seq: seq)
        }
    }

    /// A write that changes one item where it stands (every write but
    /// capture, delete and a new subtask): `snapshot` is the item before the
    /// planner's step, at its place in the list now, which the step didn't
    /// move.
    func enqueue(_ write: Write, snapshot: Item, settled: (@MainActor (Settled) -> Void)? = nil) {
        let items = planner?.items ?? []
        let place = Place(of: snapshot.id, in: items) ?? Place(index: items.count, after: items.last?.id)
        enqueue(write, before: [.item(snapshot.id): .item(snapshot, place)], settled: settled)
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
    /// flight reaches the planner. The background time goes back now: what is
    /// still queued will never be sent, and the queued writes hold the sync
    /// weakly, so once AppGate lets go of the planner they may never run to
    /// the drain that would give it back.
    func stop() {
        stopped = true
        let waiting = settlers
        settlers = [:]
        for seq in waiting.keys.sorted() { waiting[seq]?(.unsent) }
        dragWaiter?.cancel()
        dragWaiter = nil
        endBackgroundTime()
    }

    private func run(_ write: Write, before: [Subject: Before], seq: Int) async {
        var outcome = Settled.unsent
        if !stopped {
            let sentAt = now()
            do {
                try await perform(write)
                outcome = .landed
                if !failures.isEmpty {
                    landed.append(Landed(seq: seq, write: write, subjects: write.subjects, proves: write.proves,
                                         sentAt: sentAt))
                }
            } catch is CancellationError {
                // Signed out while it was out: nothing to say.
            } catch {
                outcome = Self.settled(error)
                // A snooze changed nothing on screen, so there is nothing to
                // revert or to say: the phone's own copy rings regardless.
                if case .snooze = write {} else {
                    failed(before: before, seq: seq, error: error)
                }
            }
        }
        settlers.removeValue(forKey: seq)?(outcome)
        for subject in write.subjects.union(write.proves) {
            let left = (queuedBySubject[subject] ?? 1) - 1
            queuedBySubject[subject] = left > 0 ? left : nil
        }
        if case .delete(let id, _, true) = write {
            let left = (queuedCascades[id] ?? 1) - 1
            queuedCascades[id] = left > 0 ? left : nil
        }
        pending -= 1
        if pending == 0 {
            endBackgroundTime()
            drained()
        }
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
        case .edit(let id, let edit):
            try await api.edit(id: id, edit)
        case .delete(let id, _, _):
            do {
                try await api.delete(id: id)
            } catch let error as APIError where error == .rejected(status: 404, code: "not_found") {
                // The route's own answer for no such row of this user's, live
                // or in the Trash: a capture that never committed, or a delete
                // from another device. Gone either way, so it landed.
            }
        case .addSubtask(let id, let parent, let title):
            // No 404 exception here: the 404 is the parent's, gone or never
            // committed, and the subtask was never made. So are 409 `nested`,
            // `conflict` and `parent_gone`; each fails, and takes it back.
            try await api.addSubtask(parent: parent, id: id, title: title)
        case .resetStreak(let id):
            try await api.resetStreak(id: id)
        case .collect(let id, let kind, let containerId, let member):
            try await api.collect(id: id, kind: kind, containerId: containerId, member: member)
        case .snooze(let id, let date, let minutes, let timeZone):
            _ = try await api.snooze(id: id, date: date, minutes: minutes, timeZone: timeZone)
        }
    }

    /// A failed write's end, for its settler: a refusal is final, anything
    /// that may never have reached the server is not.
    static func settled(_ error: Error) -> Settled {
        switch error as? APIError {
        case .rejected?, .badResponse?:
            return .refused
        case .signedOut?, .unauthorized?, .unavailable?, nil:
            return .unsent
        }
    }

    private func failed(before: [Subject: Before], seq: Int, error: Error) {
        // Auth already moved to the sign-in screen; this planner is going.
        if (error as? APIError) == .signedOut { return }
        failures.append(Failure(seq: seq, before: before))
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

    // MARK: Background time

    /// A write was queued: ask iOS to keep the app running until the queue
    /// drains, unless time is held already. Its expiry gives the time back at
    /// once, as iOS requires; whatever is still out then fails on resume, and
    /// the next write queued asks again.
    private func beginBackgroundTime() {
        guard backgroundToken == nil else { return }
        backgroundToken = backgroundTime.begin(Self.backgroundTaskName) { [weak self] in
            self?.endBackgroundTime()
        }
    }

    private func endBackgroundTime() {
        guard let token = backgroundToken else { return }
        backgroundToken = nil
        backgroundTime.end(token)
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
        // Only a revert that moved something says so; one that left the
        // screen as it was (a capture kept, a replay that ends where it
        // stood, a failure waiting on a queued write) says what any failed
        // fetch says.
        if !failures.isEmpty, revertFailures() {
            planner?.show("Couldn't reach dsul, so that change was undone.", isError: true)
            return
        }
        let text = Self.fetchFailureText(error)
        planner?.noteLoadFailure(text)
        if planner?.hasLoaded == true {
            planner?.show(text, isError: true)
        }
    }

    // MARK: The rebase

    /// Rebases each subject with a failure: what it was before its earliest
    /// failed write, with every write that landed after that one and names it
    /// played on it in order (`replaying`), and gone if a landed delete's
    /// cascade takes it. A later failure on the subject adds nothing, since
    /// the server never took it. A capture or a new subtask whose own answer
    /// was lost starts from nothing unless a later write that names or proves
    /// it landed. A membership is rebased in its own pass (`rebaseMember`) and
    /// put back after the items, newest failure first.
    ///
    /// A subject with a write still queued that names or proves it, or that a
    /// queued delete may take with its parent, waits: its failures are kept,
    /// with the writes that land meanwhile, and the drain refetches, so a
    /// failed fetch then rebases it with those writes in. Everything reverted
    /// is dropped. Returns whether anything on screen moved.
    @discardableResult
    private func revertFailures() -> Bool {
        let ordered = failures.sorted { $0.seq < $1.seq }
        // Each subject's earliest failure: where its rebase starts.
        var firsts: [Subject: Failure] = [:]
        for failure in ordered {
            for subject in failure.before.keys where firsts[subject] == nil {
                firsts[subject] = failure
            }
        }
        var waiting = Set<Subject>()
        for (subject, first) in firsts where waits(subject, first.before[subject]) {
            waiting.insert(subject)
        }
        var changed = false
        if let planner {
            var targets: [Target] = []
            var memberships: [MemberTarget] = []
            for (subject, first) in firsts where !waiting.contains(subject) {
                guard let start = first.before[subject] else { continue }
                switch subject {
                case .item:
                    targets.append(rebase(subject, from: start, after: first.seq, ordered: ordered,
                                          planner: planner))
                case .member:
                    let (member, index) = rebaseMember(subject, from: start, after: first.seq)
                    memberships.append(MemberTarget(subject: subject, member: member, index: index,
                                                    seq: first.seq))
                }
            }
            let routines = planner.routines
            let seasons = planner.seasons
            changed = put(targets, on: planner)
            // Each index was measured against the list the toggles before it
            // had left (`firsts` is in hash order), so the newest failure goes
            // back first, each onto the list it was measured against, as
            // `put` undoes deletes: Morning [a, b, c] with a taken out (at 0)
            // and then b (at 0 of [b, c]) is [b, c] and then [a, b, c], where
            // oldest first would give [b, a, c].
            for target in memberships.sorted(by: { $0.seq > $1.seq }) {
                guard case .member(let kind, let containerId, let item) = target.subject else { continue }
                planner.restoreMembership(kind, containerId, item: item, member: target.member, at: target.index)
            }
            changed = changed || planner.routines != routines || planner.seasons != seasons
        }
        // Reverted subjects are done with; a failure goes with its last one,
        // and a landed write once nothing waiting needs it replayed.
        for i in failures.indices {
            failures[i].before = failures[i].before.filter { waiting.contains($0.key) }
        }
        failures.removeAll { $0.before.isEmpty }
        let held: [Item] = waiting.compactMap { firsts[$0]?.before[$0]?.snapshot }
        landed.removeAll { write in
            write.subjects.union(write.proves).isDisjoint(with: waiting) && !write.cascades(onto: held)
        }
        if !waiting.isEmpty { refetchWhenDrained = true }
        return changed
    }

    /// Part 1's rule, per subject: a write still queued that names or proves
    /// it holds its revert back until it is in. So does a queued delete whose
    /// cascade would take it, since that delete need not name a subtask the
    /// phone had already taken out.
    private func waits(_ subject: Subject, _ start: Before?) -> Bool {
        if (queuedBySubject[subject] ?? 0) > 0 { return true }
        guard let item = start?.snapshot else { return false }
        return queuedCascades.keys.contains { isDeletedWith(item, parent: $0) }
    }

    /// `subject` from `start`, its state before the failure numbered `seq`,
    /// with what landed since replayed on it.
    private func rebase(_ subject: Subject, from start: Before, after seq: Int, ordered: [Failure],
                        planner: SamplePlanner) -> Target {
        let later = landed.filter { $0.seq > seq }
        var state: Item?
        switch start {
        case .item(let item, _):
            state = item
        case .absent(let created):
            // The route answers 404 for a missing row, so a later write it
            // took on this row, or a new subtask under it, proves the capture
            // (or the new subtask) landed after all.
            let proven = later.contains { $0.subjects.contains(subject) || $0.proves.contains(subject) }
            state = proven ? created : nil
        case .member:
            // Never reached: a membership goes to `rebaseMember`.
            break
        }
        let zone = planner.timeZoneID
        let today = planner.today.description
        for write in later {
            guard let current = state else { break }
            if write.subjects.contains(subject) {
                state = replaying(write.write, on: current, at: write.sentAt, timeZone: zone, today: today)
            } else if case .delete(let parent, _, true) = write.write, isDeletedWith(current, parent: parent) {
                // The server's cascade: a subtask the phone had already taken
                // out of the list, so the delete doesn't name it.
                state = nil
            }
        }
        let recorded = placeOf(subject, in: ordered)
        return Target(subject: subject, item: state, place: recorded?.place, placeSeq: recorded?.seq, seq: seq)
    }

    /// (2f-b) A membership from before its earliest failed toggle, with every
    /// toggle of it that landed since played in order: out on a remove; in on
    /// an add, at its old place when it was in before (the server keeps a
    /// member's place) and else last. `revertFailures` puts the answers back
    /// through the planner, newest failure first.
    private func rebaseMember(_ subject: Subject, from start: Before, after seq: Int) -> (member: Bool, index: Int?) {
        var index: Int? = nil
        if case .member(let at) = start { index = at }
        var member = index != nil
        for write in landed where write.seq > seq && write.subjects.contains(subject) {
            guard case .collect(_, _, _, let landedMember) = write.write else { continue }
            member = landedMember
            // A remove that landed took its place with it: an add after it
            // goes last, as the server's does.
            if !landedMember { index = nil }
        }
        return (member, index)
    }

    /// Where `subject` goes back if it is gone: the place the latest failed
    /// write naming it recorded, which is the delete that took it out, and
    /// that write's number.
    private func placeOf(_ subject: Subject, in ordered: [Failure]) -> (place: Place, seq: Int)? {
        for failure in ordered.reversed() {
            if case .item(_, let place)? = failure.before[subject] { return (place, failure.seq) }
        }
        return nil
    }

    /// Puts each target back through the planner (`restore`): updates and
    /// removals first, then what comes back. Each delete recorded its places
    /// against the list the deletes before it had left, so the deletes are
    /// undone newest first, each onto the list it was measured against: two
    /// rows deleted one after the other both stood after the same row, and
    /// oldest first would put them back swapped. Within one delete, front to
    /// back by recorded place, so a subtask that stood after its parent finds
    /// the parent back already. Returns whether the list changed.
    private func put(_ targets: [Target], on planner: SamplePlanner) -> Bool {
        let shown = planner.items
        let present = Set(shown.map(\.id))
        let returning: (Target) -> Bool = { $0.item != nil && !present.contains($0.subject.itemId) }
        let back = targets.filter(returning).sorted { a, b in
            let (aSeq, bSeq) = (a.placeSeq ?? Int.min, b.placeSeq ?? Int.min)
            if aSeq != bSeq { return aSeq > bSeq }
            return (a.place?.index ?? Int.max, a.seq) < (b.place?.index ?? Int.max, b.seq)
        }
        for target in targets.filter({ !returning($0) }) + back {
            guard planner.item(target.subject.itemId) != target.item else { continue }
            planner.restore(target.subject, to: target.item, place: target.place)
        }
        return planner.items != shown
    }

    /// `item` with `write`, which landed, played on it through the planner's
    /// own optimistic step for that write, so a rebase ends where the server
    /// holds the item; nil once a delete took it. A pause is resolved against
    /// `item`, as the server resolved it against its row, at `sentAt`, on the
    /// day that instant falls on in the write's zone (or `timeZone`); one
    /// already satisfied, or refused, changes nothing. `today` stands in for a
    /// zone that can't be read.
    private func replaying(_ write: Write, on item: Item, at sentAt: Date, timeZone: String,
                           today: String) -> Item? {
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
            let readIn = zone ?? timeZone
            let day = toDateStr(sentAt, timeZone: readIn)?.description ?? today
            let result = resolvePauseWrite(current: item, paused: paused,
                                           pausedUntil: pausedUntil.map { ColumnWrite.set($0) }, todayStr: day,
                                           nowISO: toISOString(sentAt), timeZone: readIn)
            guard case .patch(let patch) = result, !patch.isEmpty else { return item }
            return pausing(item, patch: patch)
        case .edit(_, let edit):
            return editing(item, edit)
        case .resetStreak:
            return resettingStreak(item)
        case .delete:
            return nil
        case .capture, .addSubtask:
            // It made the item, so there is nothing to play: a rebase already
            // starts from what it made (`created`).
            return item
        case .collect, .snooze:
            // Never asked: a toggle names a membership, not its item, and a
            // snooze names nothing; neither changes a field of the item.
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

/// Time iOS gives the app to finish its writes once it leaves the screen
/// (`UIApplication.beginBackgroundTask`, about half a minute). PlannerSync
/// begins it when a write is queued and it holds none, and ends it at the
/// drain, on `stop()`, or when `expired` says iOS is taking it back. Two
/// closures rather than UIKit itself, so the data layer and its tests never
/// touch UIApplication: AppGate passes the real pair (`uiApplication`), and
/// everything else asks for nothing (`foregroundOnly`).
struct BackgroundTime: Sendable {
    /// Asks for time under `name`; `expired` runs on the main actor if iOS
    /// takes it back first, and ends it. Answers a token for `end`. An
    /// adapter ends the time itself after `expired` if its owner didn't (the
    /// owner may be gone), and never ends one token twice.
    let begin: @MainActor @Sendable (_ name: String, _ expired: @escaping @MainActor @Sendable () -> Void) -> Int
    /// Gives back the time `begin` answered `token` for.
    let end: @MainActor @Sendable (_ token: Int) -> Void

    /// Asks for nothing: the sample, the tests, and anything else that only
    /// writes while it is on screen.
    static let foregroundOnly = BackgroundTime(begin: { _, _ in 0 }, end: { _ in })
}
