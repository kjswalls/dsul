import Foundation

// Port of lib/app-containers.ts' field intents: what POST
// /api/app/containers/:kind/:id takes (`RoutineWriteSchema`,
// `SeasonWriteSchema`, `CONTAINER_WRITES`) and what each does to a container
// (`containerIntentPatch`). Keep in step: a change there without the same
// change here is drift, and the phone steps a container one way while the
// server writes it another. Checked against the web by
// ContainerWritesFixtureTests (tests/fixtures/organize/container-writes.json),
// whose every case the route's own test also runs through the route.
//
// From O8a: a routine's pause (Pause, Pause until and Resume), resolved by
// lib/active.ts `resolvePauseWrite` (Active.swift) at the instant and in the
// zone the server resolved it with, and a season's state, stored as picked.
// The zone the server reads a pause in is lib/app-http.ts `pauseZone`'s, and
// the one decision Paused's Resume and "Turn on now" make before they send is
// lib/gate-toggle.ts `setGateOn`'s (`gateSwitchIntent`). The body an intent
// sends is ContainerWriteBody.swift's.
//
// Also the shared types the planner, its sync and the Linux tests all see
// (design §6.1): `ContainerRef` and `ContainerSnapshot` here, `OrganizeKind`
// in ContainerSchedule.swift. A snapshot's fields and its membership are kept
// apart (`withMembership(of:)`): an intent never names a member, so putting a
// container's fields back never puts back a list another write changed.

/// One container by kind and id: what a container write, its subject and a
/// page's route name. The id is kept as the planner holds it and never parsed
/// as a UUID (the sample's ids are not uuids); a new one is minted lowercase,
/// so it equals the id the server lowercases.
public struct ContainerRef: Hashable, Sendable {
    public let kind: OrganizeKind
    public let id: String

    public init(kind: OrganizeKind, id: String) {
        self.kind = kind
        self.id = id
    }
}

/// One container, whole, as the planner holds it: a container write's
/// `Before`, and what `applyingContainer` steps. It is the same value as
/// lib/container-schedule.ts' `ScheduleContainer` (ContainerSchedule.swift),
/// so it is that type, under the name the writes use.
public typealias ContainerSnapshot = ScheduleContainer

extension ScheduleContainer {
    /// The container's id, as the planner holds it.
    public var id: String {
        switch self {
        case .routine(let routine): return routine.id
        case .season(let season): return season.id
        case .goal(let goal): return goal.id
        case .project(let project): return project.id
        }
    }

    /// The container's name, as stored.
    public var name: String {
        switch self {
        case .routine(let routine): return routine.name
        case .season(let season): return season.name
        case .goal(let goal): return goal.name
        case .project(let project): return project.name
        }
    }

    /// Its kind and id.
    public var ref: ContainerRef { ContainerRef(kind: kind, id: id) }

    /// This snapshot's own fields over `current`'s membership: a routine's
    /// and a season's `itemIds`, a season's `routineIds`, and a goal's three
    /// role lists come from `current`, everything else from `self`. What a
    /// failed field write puts back onto a container that is still there
    /// (design §6.4, §8.2): the membership belongs to the `collect` and hold
    /// writes, and a landed one must survive a field's revert. A project's
    /// members are items filed by name, so it has no list to keep. `self`
    /// unchanged when the two are different containers.
    public func withMembership(of current: ContainerSnapshot) -> ContainerSnapshot {
        switch (self, current) {
        case (.routine(var routine), .routine(let live)) where routine.id == live.id:
            routine.itemIds = live.itemIds
            return .routine(routine)
        case (.season(var season), .season(let live)) where season.id == live.id:
            season.itemIds = live.itemIds
            season.routineIds = live.routineIds
            return .season(season)
        case (.goal(var goal), .goal(let live)) where goal.id == live.id:
            goal.memberIds = live.memberIds
            goal.milestoneIds = live.milestoneIds
            goal.checkinIds = live.checkinIds
            return .goal(goal)
        default:
            return self
        }
    }
}

/// packages/types `SeasonStateSchema`: the three values a season's `state`
/// is written as. `Season.state` stays a string, read as the web reads it
/// (anything but "active" or "paused" follows the dates); an intent only ever
/// sends one of these.
public enum SeasonState: String, Sendable, Hashable, CaseIterable {
    /// Follows its dates ("Dates").
    case auto
    /// Pinned on ("On").
    case active
    /// Switched off ("Off").
    case paused
}

/// An intent's `action`, as the route's unions name it and the payload's
/// `containerWrites` lists it.
public enum ContainerAction: String, Sendable, Hashable, CaseIterable {
    /// A routine's Pause, Pause until and Resume (`RoutineWriteActions`).
    case pause
    /// A season's On, Off and Dates (`SeasonWriteActions`).
    case state

    /// The kinds whose union holds the action: the routes a body with it may
    /// go to. Any other kind's route answers 400.
    public var kinds: [OrganizeKind] {
        switch self {
        case .pause: return [.routine]
        case .state: return [.season]
        }
    }
}

/// One field write to one container, as the phone means it. Each case is one
/// strict member of a kind's union in lib/app-containers.ts, and the shapes
/// the route refuses cannot be built: a resume carries no day, a day is a
/// real calendar day, and a state is one of the three.
public enum ContainerIntent: Sendable, Hashable {
    /// A routine's Pause (`until` nil) or Pause until `until`, the exclusive
    /// resume day (`{"action":"pause","paused":true,…}`). On a routine paused
    /// today it moves the resume day, or with none keeps it, and never the
    /// stamp. `timeZone` is the device's zone, which the server uses only
    /// when the account stores none (`pauseZone`), as the item `.pause` sends.
    case pause(until: DayString?, timeZone: String?)
    /// A routine's Resume (`{"action":"pause","paused":false,…}`): the pause
    /// ends today and keeps when it began. `timeZone` as for `pause`.
    case resume(timeZone: String?)
    /// A season's Status, stored exactly as picked
    /// (`{"action":"state","state":…}`): On is `.active`, Off is `.paused`,
    /// Dates is `.auto`. Only a binary switch computes it first
    /// (`seasonStateForSwitch`, through `gateSwitchIntent`).
    case state(SeasonState)

    /// The route's `action`, which `containerWrites` lists. A pause and a
    /// resume are both `pause`.
    public var action: ContainerAction {
        switch self {
        case .pause, .resume: return .pause
        case .state: return .state
        }
    }

    /// Whether `kind`'s route takes it.
    public func applies(to kind: OrganizeKind) -> Bool {
        return action.kinds.contains(kind)
    }

    /// The zone a pause or a resume carries for the server, or nil.
    public var timeZone: String? {
        switch self {
        case .pause(_, let zone), .resume(let zone): return zone
        case .state: return nil
        }
    }
}

/// lib/app-containers.ts `containerIntentPatch`'s `patch`: the container's
/// columns an intent writes. A field left nil is not written; `.clear` writes
/// NULL (the TS patch's key present as `undefined`). Empty is "already so":
/// the route answers 200 and writes nothing.
public struct ContainerPatch: Sendable, Hashable {
    /// A routine's `pausedAt`: the instant a new pause began.
    public var pausedAt: ColumnWrite?
    /// A routine's `pausedUntil`: the exclusive resume day.
    public var pausedUntil: ColumnWrite?
    /// A season's `state`.
    public var state: SeasonState?

    public init(pausedAt: ColumnWrite? = nil, pausedUntil: ColumnWrite? = nil, state: SeasonState? = nil) {
        self.pausedAt = pausedAt
        self.pausedUntil = pausedUntil
        self.state = state
    }

    public var isEmpty: Bool { pausedAt == nil && pausedUntil == nil && state == nil }

    /// `container` with the patch written: a field the patch sets takes the
    /// value, one it clears becomes nil, one it leaves out stays, and a field
    /// the kind doesn't have is ignored. Never a member list: no patch has
    /// one. An empty patch changes nothing.
    public func applied(to container: ContainerSnapshot) -> ContainerSnapshot {
        switch container {
        case .routine(var routine):
            if let pausedAt { routine.pausedAt = pausedAt.value }
            if let pausedUntil { routine.pausedUntil = pausedUntil.value }
            return .routine(routine)
        case .season(var season):
            if let state { season.state = state.rawValue }
            return .season(season)
        case .goal, .project:
            return container
        }
    }
}

/// lib/app-containers.ts `ContainerIntentResult`: the write an intent makes,
/// or the route's refusal of it.
public enum ContainerIntentResult: Sendable, Hashable {
    /// The columns to write; empty when already so (200, nothing written).
    case patch(ContainerPatch)
    /// The route's answer instead: its code (`pause_refused`, 409) or, for an
    /// intent the kind doesn't take, the schema's (`invalid`, 400).
    case refused(code: String, status: Int)
}

/// lib/app-containers.ts `containerIntentPatch`: the write `intent` makes to
/// `container` as it stands, the one statement of the rule. The route runs it
/// on the row it read; the phone runs it on its copy to step a write
/// optimistically, and again to replay a landed one, at the instant the write
/// was sent (`now`) and in the zone the server read it in (`timeZone`, see
/// `pauseZone`), so a replay can't stamp a different instant or fall on a
/// different day.
///
/// - routine `pause`: lib/active.ts `resolvePauseWrite` with today in
///   `timeZone` and the stamp off the one `now`. Already so is empty, so a
///   retry never restamps `pausedAt`; a resume keeps the interval
///   (`pausedUntil` = today); a resume day not after today on a routine not
///   paused today is `pause_refused` (409).
/// - season `state`: the state picked, raw. The state it already has (compared
///   as stored, so a stored value the web reads as `auto` is still rewritten
///   as `auto`) is empty, as the web's `setSeasonState` writes nothing then.
///
/// `today` stands in for the day when `timeZone` can't be read (the web would
/// throw; the server's zone always reads). An intent the container's kind
/// doesn't take is refused as the route's schema refuses it.
public func containerIntentPatch(
    _ intent: ContainerIntent,
    on container: ContainerSnapshot,
    now: Date,
    timeZone: String,
    today: String
) -> ContainerIntentResult {
    switch (intent, container) {
    case (.pause(let until, _), .routine(let routine)):
        return pauseResult(routine, paused: true, until: until?.description, now: now, timeZone: timeZone, today: today)
    case (.resume, .routine(let routine)):
        return pauseResult(routine, paused: false, until: nil, now: now, timeZone: timeZone, today: today)
    case (.state(let state), .season(let season)):
        return .patch(season.state == state.rawValue ? ContainerPatch() : ContainerPatch(state: state))
    default:
        return .refused(code: "invalid", status: 400)
    }
}

/// The `pause` arm: `resolvePauseWrite` on the routine, its refusal as the
/// route's code.
private func pauseResult(
    _ routine: Routine, paused: Bool, until: String?, now: Date, timeZone: String, today: String
) -> ContainerIntentResult {
    let day = toDateStr(now, timeZone: timeZone)?.description ?? today
    let result = resolvePauseWrite(
        current: routine, paused: paused, pausedUntil: until.map { ColumnWrite.set($0) },
        todayStr: day, nowISO: toISOString(now), timeZone: timeZone
    )
    switch result {
    case .patch(let patch):
        return .patch(ContainerPatch(pausedAt: patch.pausedAt, pausedUntil: patch.pausedUntil))
    case .refused:
        return .refused(code: "pause_refused", status: 409)
    }
}

/// `container` with `intent` written, as the server writes it when the intent
/// was sent at `instant` and read in `timeZone` (`containerIntentPatch`): the
/// phone's optimistic step, and a landed write's replay at its own `sentAt`.
/// A refusal, or a write already so, changes nothing. `today` stands in for a
/// zone that can't be read.
public func applyingContainer(
    _ intent: ContainerIntent,
    to container: ContainerSnapshot,
    at instant: Date,
    timeZone: String,
    today: String
) -> ContainerSnapshot {
    let result = containerIntentPatch(intent, on: container, now: instant, timeZone: timeZone, today: today)
    guard case .patch(let patch) = result else { return container }
    return patch.applied(to: container)
}

/// lib/app-http.ts `pauseZone`, after its read: the zone the server reads a
/// pause in. The account's stored zone, trimmed, when it is a zone; else the
/// device's zone the body carried, trimmed, when it is one; else UTC. The
/// phone steps and replays a container pause in this zone, so its "today"
/// is the server's. (`Intl` accepts a zone in any letter case where
/// `TimeZone(identifier:)` wants the canonical spelling; the zones the web and
/// the phone store are canonical.)
public func pauseZone(stored: String?, device: String?) -> String {
    for candidate in [stored, device] {
        guard let raw = candidate else { continue }
        let zone = jsTrim(raw)
        if !zone.isEmpty, TimeZone(identifier: zone) != nil { return zone }
    }
    return "UTC"
}

/// lib/gate-toggle.ts `setGateOn`'s decision: the intent that turns a routine
/// or a season on (`on` true) or off, or nil when it already is (or for a
/// goal or a project, which have no switch). Paused's Resume and "Turn on
/// now" send it, whatever the extension switches say.
///
/// - A routine reads its OWN switch (`routineStandingOn`'s `localOn`: not
///   paused today), never what a season makes of it, and resumes or pauses
///   with no day.
/// - A season reads whether it is live today, and writes
///   `seasonStateForSwitch`, so a switch never destroys date-following.
///
/// Resolved at today (pausing is dateless), in `timeZone`, which the pause's
/// body carries as the item pause's does.
public func gateSwitchIntent(
    _ container: ContainerSnapshot,
    on desiredOn: Bool,
    today: DayString,
    timeZone: String
) -> ContainerIntent? {
    switch container {
    case .routine(let routine):
        let localOn = !isPausedOn(routine, on: today, timeZone: timeZone)
        if localOn == desiredOn { return nil }
        return desiredOn ? .resume(timeZone: timeZone) : .pause(until: nil, timeZone: timeZone)
    case .season(let season):
        if isSeasonActiveOn(season, on: today) == desiredOn { return nil }
        return .state(seasonStateForSwitch(season, on: desiredOn, today: today))
    case .goal, .project:
        return nil
    }
}

extension ContainerWrites {
    /// Whether the server takes `action` on `kind`: listed for the kind, and
    /// a member of its union.
    public func takes(_ action: ContainerAction, on kind: OrganizeKind) -> Bool {
        return action.kinds.contains(kind) && takes(action.rawValue, on: kind)
    }

    /// Whether the server takes `intent` on `kind`.
    public func takes(_ intent: ContainerIntent, on kind: OrganizeKind) -> Bool {
        return intent.applies(to: kind) && takes(intent.action, on: kind)
    }
}
