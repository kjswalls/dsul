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
/// - **A container's own fields are a subject too** (O8a, `.container`): a
///   routine's pause and usual time, a season's state and Runs, a goal's
///   status and window, notes or a why, and from O9 any container's name,
///   icon and colour. Never its member lists, which belong
///   to the `.member` toggles: a failed pause put back onto a routine that is
///   still there takes its fields only (`withMembership(of:)`), so it can't
///   undo a toggle that landed. Its rebase replays the landed container
///   writes that name it through DsulCore `applyingContainer`, the planner's
///   own step, each at its `sentAt` and in the zone the server read it in
///   (`rebaseContainer`). Put back after the items and before the
///   memberships, so a membership never goes back into a container that
///   isn't back yet: field restores and removals, then re-inserts newest
///   failure first. A refusal the route words (`pause_refused`, and a project
///   rename's `name_taken` and `name_in_trash`) shows its own sentence
///   (`OrganizeCopy.refusal`), never the item words.
/// - **A container delete is a container write** (O10, `.delete`): its
///   Before is the container whole and its place, so a failed one comes back
///   whole, newest failure first, with the member lists the latest failed
///   write naming it recorded, which hold every toggle that landed before the
///   delete (the membership pass then takes out the toggles that failed). A
///   landed one replays as the container's end (DsulCore `containerAfter`),
///   so a failed rename under a landed delete stays gone. A delete answered
///   404 `not_found` landed, as an item delete's does: the row was never
///   made, was purged or was deleted elsewhere, and is gone either way. A 404
///   on any other container write fails and reverts.
/// - **A create is its own write** (O11, `createContainer`), to the kind's
///   route with the phone's own id. Its Before is `.containerAbsent`: a
///   failed create takes its container with it, as a failed capture takes its
///   item, unless a later write that names or proves it landed. A landed
///   toggle into it proves it (`collect` proves its container from O11: the
///   route refuses one it doesn't hold, 409 `container_gone`, so a 200 proves
///   it is there), which settles a create whose answer was lost.
/// - **A routine's steps and a season's routines are membership writes, not
///   field writes** (O12, O13: `moveMember`, `holdRoutine`). Each names ONE
///   membership, never a list: a step placed after another step (the `.member`
///   subject the toggles already own), or one `season_routines` row (`.hold`,
///   its own subject). So a container's failed field write can never put back
///   an order or a hold that landed, and a failed move or hold never puts a
///   field back. A failed move's revert puts the step back after the step a
///   landed move left it after (`rebaseMember`, DsulCore `placingMember`), or
///   at the place it held before its earliest failure; a failed hold goes back
///   in or out at its old place (`rebaseHold`), put back after the containers
///   and before the memberships, so a hold never goes into a season that isn't
///   back yet. Each refusal the route words (`member_gone`, `anchor_gone`,
///   `container_gone`) reads "It changed on another device. Showing the
///   latest.", and the drain refetches.
/// - **A project rename re-files its items** (O9). The route renames the
///   project, then gives every item filed under it by `projectId` the new
///   name. The write can't name those items later, so the planner records
///   them at enqueue (`refiled`, DsulCore `refiledItems`), as a delete records
///   what it took out. Each is a subject, with its own Before, so a failed
///   rename puts every member's name back, and an item write that fails after
///   a landed rename rebases onto the new name (`replaying`, DsulCore
///   `refiling`).
/// - **A landed write doesn't moot a failed one.** Two writes need not set the
///   same fields (a carry keeps the time a failed drop set, a skip leaves the
///   tally a failed tick set, a resume of an item the server never paused
///   writes nothing), so the later one is replayed, never trusted. A pause is
///   replayed at its own `sentAt`, the instant it went out, because that is
///   when the server resolved it, not when the revert runs.
/// - **A failed capture, or a new subtask,** takes its item with it, unless a
///   later write that names or proves it landed: the route answers 404 for a
///   missing row, so any write it took proves the row is there, and a new
///   subtask under a captured item proves its parent. A project rename that
///   re-filed it is no proof: its route answers 200 whatever it re-filed. A
///   new subtask answered 404 failed like any refusal: the 404 is its
///   parent's, and it was never made.
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
/// - **A restore from the Trash is not a queued write, but it moves the
///   generation like one** (O14). It is sent at once, beside the queue, since
///   nothing on the phone changes until it lands (the bin never enters the
///   planner's state, the web's law). It bumps `writeGeneration` when it is
///   sent and again when its answer arrives, so a fetch that started before
///   the restore committed comes back raced and is made again, rather than
///   applied without the restored row; and a restore that lands starts a
///   fetch, which brings the row back. So does one whose answer may have been
///   lost (`unavailable`), as a failed queued write's drain does.
/// - **No polling and no realtime** (the web has neither): a fetch on sign-in,
///   on returning to the app at most once a minute, and on pull to refresh.
@MainActor
final class PlannerSync {
    /// What the phone writes, each an intent (lib/app-api.ts): capture, and
    /// the item writes POST /api/app/items/:id takes, named by its `action`
    /// (tick, braindump row to an hour, Skip/Unskip today, Tomorrow and
    /// Reschedule, Pause/Pause until/Resume, the item sheet's title, notes,
    /// priority, times a day, reminder, time, repeat and project, Delete, Add
    /// a subtask, Reset streak, its routine and season toggles, and from Week
    /// and blocks PR 3 Move to Braindump), a
    /// notification's Snooze, and from O8a one field of a routine, a season,
    /// a goal or a project (POST /api/app/containers/:kind/:id), from O10 its
    /// delete, from O11 a new one (POST /api/app/containers/:kind), and from
    /// O12 and O13 one membership of one container (a routine's step moved, a
    /// season's routine put in or taken out), to a field write's own route.
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
        /// (Week and blocks PR 3) Move to Braindump: off every day, back to
        /// the braindump. The body is the action alone (DsulCore
        /// `ItemWriteBody.unschedule`); the server asks its own copy of the
        /// web's gate and writes the store's `UNSCHEDULE_TASK_PATCH`, so the
        /// planner's step (`unscheduling`) is what it holds after.
        case unschedule(id: UUID)
        /// (2f-b) Join (`member`) or leave one routine or season: one
        /// membership row. Changes no item field.
        case collect(id: UUID, kind: ContainerKind, containerId: String, member: Bool)
        /// A notification's Snooze: rings again in `minutes`, on `date` only
        /// (read in `timeZone` when the account stores no zone). Writes the
        /// snooze columns, which the planner doesn't hold, so it changes
        /// nothing on screen and has nothing to revert.
        case snooze(id: UUID, date: String, minutes: Int, timeZone: String?)
        /// (O8a, O8b, O9) One field write to one container (DsulCore
        /// `ContainerIntent`): a routine's Pause, Pause until, Resume and
        /// usual time, a season's state and Runs, a goal's status and window,
        /// notes or a why, and a rename, icon or colour. `refiled` is the items
        /// the write changes besides the container, recorded at enqueue as a
        /// delete records `removed` (DsulCore `refiledItems`): a project
        /// rename's members, filed under it by `projectId`, and empty for
        /// every other write. From O10 the intent may be `.delete`, which
        /// takes the container to the Trash and refiles nothing.
        case container(ContainerRef, ContainerIntent, refiled: [UUID])
        /// (O11) A new routine, season, goal or project from the + menu: the
        /// body whole (DsulCore `ContainerCreateBody`, the phone's own id
        /// lowercased, the name as typed, the kind's starting glyph and a
        /// goal's first day), sent to the kind's route.
        case createContainer(ContainerCreateBody)
        /// (O12) One step of one routine moved: `item` placed right after the
        /// step `after`, or first when that is nil (DsulCore
        /// `MembershipIntent.moveMember`), to the routine's own route. It
        /// changes the routine's `itemIds` and nothing else: no field of the
        /// routine, and no field of any item.
        case moveMember(routineId: String, item: UUID, after: UUID?)
        /// (O13) One routine put into one season (`hold`) or taken out of it:
        /// one `season_routines` row (DsulCore
        /// `MembershipIntent.holdRoutine`), to the season's own route. It
        /// changes the season's `routineIds` and nothing else.
        case holdRoutine(seasonId: String, routineId: String, hold: Bool)

        /// (O12, O13) What a membership write asks, and of which container's
        /// route; nil for every other write.
        var membership: (ref: ContainerRef, intent: MembershipIntent)? {
            switch self {
            case .moveMember(let routineId, let item, let after):
                return (ContainerRef(kind: .routine, id: routineId), .moveMember(item: item, after: after))
            case .holdRoutine(let seasonId, let routineId, let hold):
                return (ContainerRef(kind: .season, id: seasonId), .holdRoutine(routineId: routineId, hold: hold))
            case .complete, .schedule, .capture, .skip, .move, .pause, .edit, .delete, .addSubtask, .resetStreak,
                 .unschedule, .collect, .snooze, .container, .createContainer:
                return nil
            }
        }

        /// What this write changes: its item (a new subtask's is the
        /// subtask, not the parent whose route it goes to), for a delete each
        /// subtask it took out with it, for a toggle the one membership,
        /// never the item, and for a container write the container's own
        /// fields, never its member lists, and each item it refiles.
        var subjects: Set<Subject> {
            switch self {
            case .delete(let id, let removed, _):
                var named = Set(removed.map { Subject.item($0.item.id) })
                named.insert(.item(id))
                return named
            case .collect(let id, let kind, let containerId, _):
                return [.member(kind, containerId: containerId, item: id)]
            case .container(let ref, _, let refiled):
                var named = Set(refiled.map { Subject.item($0) })
                named.insert(.container(ref))
                return named
            case .createContainer(let body):
                return [.container(body.ref)]
            case .moveMember(let routineId, let item, _):
                return [.member(.routine, containerId: routineId, item: item)]
            case .holdRoutine(let seasonId, let routineId, _):
                return [.hold(seasonId: seasonId, routineId: routineId)]
            case .snooze:
                return []
            case .complete(let id, _, _, _), .schedule(let id, _, _), .capture(let id, _), .skip(let id, _, _),
                 .move(let id, _), .pause(let id, _, _, _), .edit(let id, _), .addSubtask(let id, _, _),
                 .resetStreak(let id), .unschedule(let id):
                return [.item(id)]
            }
        }

        /// The rows a 200 to this write proves exist without changing them,
        /// as a later write proves a capture whose answer was lost: a new
        /// subtask proves its parent, since the route answers 404 for a parent
        /// that isn't there, and a toggle its item (404 for a missing one) and
        /// (O11) its container (409 `container_gone` for one the route doesn't
        /// hold live): what settles a create whose answer was lost. From O12 a
        /// step's move proves its step (409 `member_gone` for one the routine
        /// no longer holds, so a 200 says the join row, and with it the item,
        /// is there) and its routine (404 for one the user doesn't hold live);
        /// from O13 a hold proves both its season (404) and its routine (409
        /// `container_gone`). No other write proves anything it doesn't name.
        var proves: Set<Subject> {
            switch self {
            case .addSubtask(_, let parent, _):
                return [.item(parent)]
            case .collect(let id, let kind, let containerId, _):
                return [.item(id), .container(ContainerRef(kind: OrganizeKind(kind), id: containerId))]
            case .moveMember(let routineId, let item, _):
                return [.item(item), .container(ContainerRef(kind: .routine, id: routineId))]
            case .holdRoutine(let seasonId, let routineId, _):
                return [.container(ContainerRef(kind: .season, id: seasonId)),
                        .container(ContainerRef(kind: .routine, id: routineId))]
            case .complete, .schedule, .capture, .skip, .move, .pause, .edit, .delete, .resetStreak, .unschedule,
                 .snooze, .container, .createContainer:
                return []
            }
        }

        /// (O9) The items among `subjects` a 200 says nothing about: a
        /// project rename's `refiled`. The route re-files them in one
        /// statement by `project_id` and answers 200 whatever it matched, so
        /// unlike a write on the item's own route, the rename landing proves
        /// none of them exists. Empty for every other write.
        var refiledSubjects: Set<Subject> {
            guard case .container(_, _, let refiled) = self else { return [] }
            return Set(refiled.map { Subject.item($0) })
        }
    }

    /// One thing a write changes and a revert puts back on its own: an item,
    /// its fields and whether it exists at all; whether one item is in one
    /// routine or season; or one container's own fields.
    enum Subject: Hashable, Sendable {
        case item(UUID)
        /// (2f-b) Whether `item` is in one routine or season: the one row a
        /// `collect` writes.
        case member(ContainerKind, containerId: String, item: UUID)
        /// (O8a) One container's own fields, and whether it exists. Never its
        /// member lists (a routine's or a season's `itemIds`, a season's
        /// `routineIds`, a goal's three roles), which other subjects own.
        case container(ContainerRef)
        /// (O13) Whether one season holds one routine: the one
        /// `season_routines` row a `holdRoutine` writes. Its own subject, so a
        /// failed field write on either container can't put a hold back and a
        /// failed hold can't put a field back.
        case hold(seasonId: String, routineId: String)

        /// The item it is about: its own id, or the member's; nil for a
        /// container and for a hold, which are about no item.
        var itemId: UUID? {
            switch self {
            case .item(let id): id
            case .member(_, _, let item): item
            case .container, .hold: nil
            }
        }
    }

    /// A subject as it was before a write, for that write's revert.
    enum Before: Sendable, Hashable {
        /// It existed: the item, and where it stood in the planner's list.
        case item(Item, Place)
        /// It didn't yet: a capture or a new subtask, which made `created`.
        case absent(created: Item)
        /// (2f-b, O12) Where the item stood in the container's `itemIds`
        /// before the toggle, or before a step's move; nil when it wasn't in
        /// it.
        case member(index: Int?)
        /// (O13) Whether the season held the routine before the write, and
        /// where it stood in its `routineIds`. `index` is read only with
        /// `held`: a take-out puts nothing back at a place.
        case hold(held: Bool, index: Int?)
        /// (O8a) The container, whole, and its place in the planner's list of
        /// its kind. A revert onto a container still there takes only its
        /// fields; one that is gone (a delete's, O10) comes back whole at
        /// `index`.
        case container(ContainerSnapshot, index: Int)
        /// (O11) The container didn't exist yet: a create, which made
        /// `created` (DsulCore `containerCreateRecord`).
        case containerAbsent(created: ContainerSnapshot)

        /// The item it holds, made yet or not; nil for a membership, a hold or
        /// a container.
        var snapshot: Item? {
            switch self {
            case .item(let item, _): item
            case .absent(let created): created
            case .member, .hold, .container, .containerAbsent: nil
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
        /// (O12) Where a landed step move left it: right after another step,
        /// or first. Nil when no move landed on it, and `index` is the word.
        let anchor: StepAnchor?
        /// Its earliest failure, which recorded `index`.
        let seq: Int
    }

    /// (O13) One season_routines row's rebase: whether the season holds the
    /// routine, and at what place in its `routineIds`, nil for last.
    private struct HoldTarget {
        let subject: Subject
        let held: Bool
        let index: Int?
        /// Its earliest failure, which recorded `index`.
        let seq: Int
    }

    /// (O8a) One container's rebase: what its fields come to, or nil once a
    /// landed write took it, and where it goes back if it is gone.
    private struct ContainerTarget {
        let ref: ContainerRef
        let snapshot: ContainerSnapshot?
        /// Its place in its kind's list, as the latest failed write naming it
        /// recorded it, and that write's number: the list it was measured
        /// against.
        let index: Int?
        let indexSeq: Int?
        /// Its earliest failure.
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

    /// Bumped by every write queued, and by a restore from the Trash when it
    /// is sent and when it is answered: a fetch that sees it move knows a
    /// write raced it. Also each queued write's sequence number.
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
                    failed(write, before: before, seq: seq, error: error)
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
        case .unschedule(let id):
            // No 404 exception: a row that isn't there was never unscheduled,
            // so it fails and reverts. A 200 for a row already in the
            // braindump's shape (a retry whose first answer was lost) landed.
            try await api.unschedule(id: id)
        case .collect(let id, let kind, let containerId, let member):
            try await api.collect(id: id, kind: kind, containerId: containerId, member: member)
        case .snooze(let id, let date, let minutes, let timeZone):
            _ = try await api.snooze(id: id, date: date, minutes: minutes, timeZone: timeZone)
        case .container(let ref, let intent, _):
            // Nil only for an intent the kind's route doesn't take, which no
            // gated control offers; refused as the route would refuse it.
            guard let body = ContainerWriteBody(intent, for: ref.kind) else {
                throw APIError.rejected(status: 400, code: "invalid")
            }
            do {
                try await api.writeContainer(ref, body: body)
            } catch let error as APIError where intent.removesContainer
                        && error == .rejected(status: 404, code: "not_found") {
                // (O10) A delete of a container this user has nowhere, live or
                // in the Trash: a create refused first, a purge, or a delete
                // from another device. Gone either way, so it landed. Any
                // other write answered 404 failed: the field was never set.
            }
        case .createContainer(let body):
            // No 404 exception: a 404 is a kind with no route, and nothing
            // was made.
            try await api.createContainer(body)
        case .moveMember, .holdRoutine:
            // No 404 exception either: a container the user doesn't hold
            // live refuses the whole write (a routine's 404, a season's 404,
            // and 409 `container_gone` for a hold's routine), and no
            // membership was written. The body is nil only where the route
            // would answer 400 (a step placed after itself, a routine id its
            // `Id` can't read), which no gated control sends; refused here as
            // the route would refuse it.
            guard let membership = write.membership,
                  let body = MembershipWriteBody(membership.intent, for: membership.ref.kind)
            else { throw APIError.rejected(status: 400, code: "invalid") }
            try await api.writeMembership(membership.ref, body: body)
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

    private func failed(_ write: Write, before: [Subject: Before], seq: Int, error: Error) {
        // Auth already moved to the sign-in screen; this planner is going.
        if (error as? APIError) == .signedOut { return }
        failures.append(Failure(seq: seq, before: before))
        refetchWhenDrained = true
        planner?.show(Self.writeFailureText(error, for: write), isError: true)
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

    // MARK: The Trash (O14)

    /// How a restore from the Trash ended, in the words the page shows.
    enum RestoreOutcome: Sendable, Equatable {
        /// It is back, and a fetch is on its way to show it.
        case restored
        /// Answered 404: no longer in the bin (`OrganizeCopy.restoreGone`).
        /// The page drops the row, since no retry can land.
        case gone(String)
        /// Refused, or not answered: the sentence to show
        /// (`TrashRestoreRefusal.sentence`, or `OrganizeCopy.restoreFailed`).
        case refused(String)
        /// Signed out, cancelled, or the sync stopped: nothing to say.
        case unsent
    }

    /// GET /api/app/trash, for the Trash page, which holds the rows itself:
    /// they never reach the planner. Throws `signedOut` once the sync has
    /// stopped.
    func fetchTrash() async throws -> TrashList {
        guard !stopped else { throw APIError.signedOut }
        return try await api.fetchTrash()
    }

    /// POST /api/app/trash/restore for `row`. The generation moves when it is
    /// sent and again when its answer arrives, so a fetch out across either
    /// comes back raced and is made again (`fetchOnce`); one that lands
    /// starts a fetch. A refusal is said in the route's own terms: a
    /// `name_taken` names the live project, a `parent_gone` points at the
    /// parent, a 404 is `gone` (no longer in the bin), and anything else, an
    /// error or no answer at all, is `restoreFailed`.
    func restoreFromTrash(_ row: TrashRow) async -> RestoreOutcome {
        guard !stopped else { return .unsent }
        writeGeneration += 1
        let answer: TrashRestoreResult
        do {
            answer = try await api.restoreFromTrash(TrashRestoreBody(row))
        } catch {
            // The server may have taken it before the answer was lost.
            writeGeneration += 1
            if stopped || error is CancellationError || (error as? APIError) == .signedOut { return .unsent }
            // Only `unavailable` can be a lost answer (offline mid-request, or
            // a 502 to 504 after the route ran), so only it asks the server
            // what it holds, as a failed queued write does. If that fetch
            // fails too, its own banner replaces this one.
            if (error as? APIError) == .unavailable { startFetch() }
            return .refused(OrganizeCopy.restoreFailed)
        }
        writeGeneration += 1
        guard !stopped else { return .unsent }
        switch answer {
        case .restored:
            startFetch()
            return .restored
        case .refused(let refusal):
            let sentence = refusal.sentence(rowName: row.name)
            return refusal.isGone ? .gone(sentence) : .refused(sentence)
        }
    }

    // MARK: The rebase

    /// Rebases each subject with a failure: what it was before its earliest
    /// failed write, with every write that landed after that one and names it
    /// played on it in order (`replaying`), and gone if a landed delete's
    /// cascade takes it. A later failure on the subject adds nothing, since
    /// the server never took it. A capture or a new subtask whose own answer
    /// was lost starts from nothing unless a later write that names or proves
    /// it landed. A container's fields are rebased in their own pass
    /// (`rebaseContainer`), a membership in another (`rebaseMember`) and a
    /// season's hold of a routine in a third (`rebaseHold`). They go back in
    /// this order, so a membership or a hold never goes into a container that
    /// isn't back yet: the items; the containers' field restores and removals;
    /// the containers that come back whole, newest failure first; the holds,
    /// newest failure first; the memberships, newest failure first.
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
            var containers: [ContainerTarget] = []
            var holds: [HoldTarget] = []
            var memberships: [MemberTarget] = []
            for (subject, first) in firsts where !waiting.contains(subject) {
                guard let start = first.before[subject] else { continue }
                switch subject {
                case .item:
                    targets.append(rebase(subject, from: start, after: first.seq, ordered: ordered,
                                          planner: planner))
                case .member:
                    memberships.append(rebaseMember(subject, from: start, after: first.seq))
                case .hold:
                    holds.append(rebaseHold(subject, from: start, after: first.seq))
                case .container:
                    if let target = rebaseContainer(subject, from: start, after: first.seq, ordered: ordered,
                                                    planner: planner) {
                        containers.append(target)
                    }
                }
            }
            let routines = planner.routines
            let seasons = planner.seasons
            let projects = planner.projectRecords
            let goals = planner.goals
            changed = put(targets, on: planner)
            putContainers(containers, on: planner)
            // (O13) The holds after the containers and before the
            // memberships, so a hold never goes into a season that isn't back
            // yet, and newest failure first, each onto the list it was
            // measured against, as the memberships below.
            for target in holds.sorted(by: { $0.seq > $1.seq }) {
                guard case .hold(let seasonId, let routineId) = target.subject else { continue }
                planner.restoreHold(seasonId, routineId: routineId, held: target.held, at: target.index)
            }
            // Each index was measured against the list the toggles before it
            // had left (`firsts` is in hash order), so the newest failure goes
            // back first, each onto the list it was measured against, as
            // `put` undoes deletes: Morning [a, b, c] with a taken out (at 0)
            // and then b (at 0 of [b, c]) is [b, c] and then [a, b, c], where
            // oldest first would give [b, a, c].
            for target in memberships.sorted(by: { $0.seq > $1.seq }) {
                guard case .member(let kind, let containerId, let item) = target.subject else { continue }
                // (O12) A move that landed since says where the server put the
                // step, which beats the place it held before.
                if let anchor = target.anchor {
                    planner.restoreMembership(kind, containerId, item: item, after: anchor.id, at: target.index)
                } else {
                    planner.restoreMembership(kind, containerId, item: item, member: target.member,
                                              at: target.index)
                }
            }
            changed = changed || planner.routines != routines || planner.seasons != seasons
                || planner.projectRecords != projects || planner.goals != goals
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
            // (or the new subtask) landed after all. A project rename that
            // re-filed it proves nothing: the route's bulk re-file answers 200
            // whether the row is there or not.
            let proven = later.contains {
                $0.proves.contains(subject)
                    || ($0.subjects.contains(subject) && !$0.write.refiledSubjects.contains(subject))
            }
            state = proven ? created : nil
        case .member, .hold, .container, .containerAbsent:
            // Never reached: a membership goes to `rebaseMember`, a hold to
            // `rebaseHold`, a container to `rebaseContainer`.
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

    /// (2f-b) A membership from before its earliest failed toggle or step
    /// move, with every write of it that landed since played in order: out on
    /// a remove; in on an add, at its old place when it was in before (the
    /// server keeps a member's place) and else last. (O12) A move that landed
    /// leaves the step in, after the step it named (`anchor`, nil for first),
    /// which is where the server holds it and so beats the recorded place; a
    /// toggle after it drops the anchor again. `revertFailures` puts the
    /// answers back through the planner, newest failure first.
    private func rebaseMember(_ subject: Subject, from start: Before, after seq: Int) -> MemberTarget {
        var index: Int? = nil
        if case .member(let at) = start { index = at }
        var member = index != nil
        var anchor: StepAnchor? = nil
        for write in landed where write.seq > seq && write.subjects.contains(subject) {
            switch write.write {
            case .collect(_, _, _, let landedMember):
                member = landedMember
                // A remove that landed took its place with it: an add after it
                // goes last, as the server's does.
                if !landedMember { index = nil }
                anchor = nil
            case .moveMember(_, _, let after):
                // A 200 says the routine holds the step (it answers 409
                // `member_gone` otherwise), right after the step it named.
                member = true
                anchor = after.map { StepAnchor.after($0) } ?? .first
            case .complete, .schedule, .capture, .skip, .move, .pause, .edit, .delete, .addSubtask, .resetStreak,
                 .unschedule, .snooze, .container, .createContainer, .holdRoutine:
                // No other write names a membership.
                continue
            }
        }
        return MemberTarget(subject: subject, member: member, index: index, anchor: anchor, seq: seq)
    }

    /// (O13) One season's hold of one routine from before its earliest failed
    /// write, with every hold of that row that landed since played in order:
    /// in on a hold, out on a take-out, and at the place it held before when
    /// it was held (the server orders a season's routines not at all, so the
    /// place is only the list the phone drew). `revertFailures` puts the
    /// answers back through the planner, newest failure first.
    private func rebaseHold(_ subject: Subject, from start: Before, after seq: Int) -> HoldTarget {
        var held = false
        var index: Int? = nil
        if case .hold(let was, let at) = start {
            held = was
            index = was ? at : nil
        }
        for write in landed where write.seq > seq && write.subjects.contains(subject) {
            guard case .holdRoutine(_, _, let landedHold) = write.write else { continue }
            held = landedHold
            // A take-out that landed took its place with it: a hold after it
            // goes last, as the optimistic step appends it.
            if !landedHold { index = nil }
        }
        return HoldTarget(subject: subject, held: held, index: index, seq: seq)
    }

    /// (O8a) A container from before its earliest failed write, with every
    /// container write naming it that landed since played on it, in order,
    /// through DsulCore `containerAfter` (`applyingContainer`, the step
    /// `applyContainer` takes, and from O10 a delete's end): each at its own
    /// `sentAt`, the instant the server resolved it, and in the zone the
    /// server read it in (`pauseZone`: the account's stored zone, else the
    /// one the write carried). Replayed at revert time instead, a pause would
    /// stamp a different `pausedAt`, and near midnight fall on a different
    /// day. A failed create (O11, `.containerAbsent`) starts from nothing
    /// unless a later write that names or proves it landed, as a capture
    /// does. Its place is the one the latest failed write naming it recorded,
    /// and so are the member lists it comes back with if it is gone (a failed
    /// delete's revert): that write saw every toggle that landed before it,
    /// which the earliest one may not have. Nil for a subject that isn't a
    /// container's.
    private func rebaseContainer(_ subject: Subject, from start: Before, after seq: Int, ordered: [Failure],
                                 planner: SamplePlanner) -> ContainerTarget? {
        guard case .container(let ref) = subject else { return nil }
        let later = landed.filter { $0.seq > seq }
        var state: ContainerSnapshot?
        switch start {
        case .container(let snapshot, _):
            state = snapshot
        case .containerAbsent(let created):
            // The container route answers 404 for a container it doesn't
            // hold, and the toggle route 409 `container_gone`, so a later
            // write either took on this one, or a toggle into it, proves the
            // create landed after all.
            let proven = later.contains { $0.proves.contains(subject) || $0.subjects.contains(subject) }
            state = proven ? created : nil
        case .item, .absent, .member, .hold:
            return nil
        }
        let stored = planner.settings.timezone
        let today = planner.today.description
        for write in later where write.subjects.contains(subject) {
            // A landed create names only a container it made itself, so it
            // can't follow a failure on that container: nothing to play.
            guard case .container(_, let intent, _) = write.write else { continue }
            let zone = pauseZone(stored: stored, device: intent.timeZone)
            state = containerAfter(intent, on: state, at: write.sentAt, timeZone: zone, today: today)
        }
        var recorded: (snapshot: ContainerSnapshot, index: Int, seq: Int)? = nil
        for failure in ordered.reversed() {
            if case .container(let snapshot, let index)? = failure.before[subject] {
                recorded = (snapshot, index, failure.seq)
                break
            }
        }
        if let lists = recorded?.snapshot, let fields = state {
            state = fields.withMembership(of: lists)
        }
        return ContainerTarget(ref: ref, snapshot: state, index: recorded?.index, indexSeq: recorded?.seq, seq: seq)
    }

    /// (O8a) Puts each container back through the planner
    /// (`restoreContainer`): first the ones still there, which take their
    /// fields only and keep the member lists they hold now, and the ones a
    /// landed write took; then the ones that come back whole, newest failure
    /// first, each at the place recorded against the list the writes before
    /// it had left, as `put` brings items back.
    private func putContainers(_ targets: [ContainerTarget], on planner: SamplePlanner) {
        let present = Set(targets.filter { planner.container($0.ref) != nil }.map(\.ref))
        let returning: (ContainerTarget) -> Bool = { $0.snapshot != nil && !present.contains($0.ref) }
        let back = targets.filter(returning).sorted { a, b in
            let (aSeq, bSeq) = (a.indexSeq ?? Int.min, b.indexSeq ?? Int.min)
            if aSeq != bSeq { return aSeq > bSeq }
            return (a.index ?? Int.max, a.seq) < (b.index ?? Int.max, b.seq)
        }
        for target in targets.filter({ !returning($0) }) + back {
            planner.restoreContainer(target.ref, to: target.snapshot, index: target.index)
        }
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
    /// the parent back already. Only an item's subject is put here. Returns
    /// whether the list changed.
    private func put(_ targets: [Target], on planner: SamplePlanner) -> Bool {
        let shown = planner.items
        let present = Set(shown.map(\.id))
        let items = targets.filter { target in
            if case .item = target.subject { return true }
            return false
        }
        let returning: (Target) -> Bool = { target in
            guard let id = target.subject.itemId else { return false }
            return target.item != nil && !present.contains(id)
        }
        let back = items.filter(returning).sorted { a, b in
            let (aSeq, bSeq) = (a.placeSeq ?? Int.min, b.placeSeq ?? Int.min)
            if aSeq != bSeq { return aSeq > bSeq }
            return (a.place?.index ?? Int.max, a.seq) < (b.place?.index ?? Int.max, b.seq)
        }
        for target in items.filter({ !returning($0) }) + back {
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
        case .unschedule:
            // Dateless: the server clears the four columns whatever day the
            // phone sent it from, and keeps the rest (DsulCore
            // `unscheduling`), so the replay needs no day either.
            return unscheduling(item)
        case .delete:
            return nil
        case .capture, .addSubtask:
            // It made the item, so there is nothing to play: a rebase already
            // starts from what it made (`created`).
            return item
        case .collect, .snooze, .createContainer, .moveMember, .holdRoutine:
            // Never asked: a toggle and a step's move (O12) name a
            // membership, not its item, a snooze names nothing, a create
            // (O11) names only its new container, and a hold (O13) only its
            // one join row; none changes a field of the item.
            return item
        case .container(let ref, let intent, _):
            // A project rename (O9) gives each member the new name, by
            // `projectId`, as the route re-files them (DsulCore `refiling`, the
            // planner's own step). Every other container write changes no
            // field of any item: it names only its container.
            return refiling(item, by: intent, on: ref)
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

    /// What the banner says when `write` fails: a container write's, a
    /// create's or a membership write's refusal in the route's own terms when
    /// it has words (`OrganizeCopy.refusal`, a `pause_refused` among them, a
    /// project create's `name_taken` and `name_in_trash` naming the name it
    /// sent, and O12's and O13's three `*_gone` codes), else what any failed
    /// write says.
    static func writeFailureText(_ error: Error, for write: Write) -> String {
        if case .rejected(_, let code)? = error as? APIError {
            switch write {
            case .container(_, let intent, _):
                if let words = OrganizeCopy.refusal(code: code, for: intent) { return words }
            case .createContainer(let body):
                if let words = OrganizeCopy.refusal(code: code, for: body) { return words }
            case .moveMember, .holdRoutine:
                // (O12, O13) `member_gone`, `anchor_gone` and
                // `container_gone` all read "It changed on another device.
                // Showing the latest.", whatever was sent.
                if let membership = write.membership,
                   let words = OrganizeCopy.refusal(code: code, for: membership.intent) { return words }
            default:
                break
            }
        }
        return writeFailureText(error)
    }

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

extension OrganizeKind {
    /// The kind a membership toggle's container is (`ContainerKind`, the item
    /// sheet's two), as Organize and PlannerSync name containers.
    init(_ kind: ContainerKind) {
        switch kind {
        case .routine: self = .routine
        case .season: self = .season
        }
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
