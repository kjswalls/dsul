import Foundation

// Port of lib/app-containers.ts' field intents: what POST
// /api/app/containers/:kind/:id takes (`RoutineWriteSchema`,
// `SeasonWriteSchema`, `GoalWriteSchema`, `ProjectWriteSchema`,
// `CONTAINER_WRITES`) and what each does to a container
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
// From O8b: a routine's usual time, a season's Runs, a goal's Status (lib/goals.ts
// `resolveGoalStateWrite`, Goals.swift) and window, notes on a routine, a
// season and a project, and a goal's why, stored as lib/item-edit.ts
// `cleanNotes` stores them (trimmed, blank is none). From O9: rename (trimmed,
// as the route's `Name` schema trims), icon (an `icon:<Name>` token, as
// lib/category-icons.ts `makeIconToken` writes it; a project's glyph column is
// `emoji`) and colour (one of lib/accent-colors.ts `ACCENT_RAMP`, or none for
// Auto). A project rename also runs the route's two other steps: the
// folded clash (`projectNameClash`, lib/container-registry.ts
// `foldContainerName`) and the members' re-file by id (`refiledItems`,
// `refiling`), the route's `renameProject`.
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
/// `containerWrites` lists it. Declared in the order each kind's union lists
/// its own (the kind's own fields, then notes or why, then rename, icon and
/// colour), so the actions of `kinds` read in `allCases` order are the
/// server's list for that kind.
public enum ContainerAction: String, Sendable, Hashable, CaseIterable {
    /// A routine's Pause, Pause until and Resume.
    case pause
    /// A season's On, Off and Dates; a goal's Active, Achieved and Set aside.
    case state
    /// A routine's usual time (O8b).
    case usualTime
    /// A season's Runs (O8b).
    case dates
    /// A goal's window (O8b).
    case window
    /// A routine's, a season's or a project's notes (O8b).
    case notes
    /// A goal's why, its free text (O8b).
    case why
    /// Any container's name (O9).
    case rename
    /// Any container's glyph (O9).
    case icon
    /// Any container's colour (O9).
    case color

    /// The kinds whose union holds the action: the routes a body with it may
    /// go to. Any other kind's route answers 400. (A `state` body is a
    /// different value on each of its two kinds: `ContainerIntent.kinds`.)
    public var kinds: [OrganizeKind] {
        switch self {
        case .pause, .usualTime: return [.routine]
        case .state: return [.season, .goal]
        case .dates: return [.season]
        case .window, .why: return [.goal]
        case .notes: return [.routine, .season, .project]
        case .rename, .icon, .color: return OrganizeKind.allCases
        }
    }
}

/// One field write to one container, as the phone means it. Each case is one
/// strict member of a kind's union in lib/app-containers.ts. The shapes the
/// route refuses whatever their values cannot be built: a resume carries no
/// day, a day is a real calendar day, a state is one of its kind's three, an
/// icon is never cleared, and both ends of a range always travel. Values the
/// route's schema refuses (a blank name, a time that is not "HH:mm", a token
/// off the ramp, an inverted range) are caught by `isWellFormed`, and no
/// body is built for them (`ContainerWriteBody`).
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
    /// A goal's Status (`{"action":"state","state":…}` on a goal's route):
    /// Active, Achieved or Set aside, through `resolveGoalStateWrite` at the
    /// instant sent, so the state it already has writes nothing and a goal
    /// achieved twice keeps its first stamp.
    case goalState(GoalState)
    /// A routine's usual time, "HH:mm" (00:00 to 23:59), or nil to clear it
    /// (`{"action":"usualTime","usualTime":…|null}`). A label that orders the
    /// routine and moves no member.
    case usualTime(String?)
    /// A season's Runs, both ends together, either open (nil)
    /// (`{"action":"dates","startsOn":…|null,"endsOn":…|null}`). A start
    /// after the end is refused; equal ends are one day.
    case dates(startsOn: DayString?, endsOn: DayString?)
    /// A goal's window, both ends together, as a season's Runs
    /// (`{"action":"window","startsOn":…|null,"targetOn":…|null}`).
    case window(startsOn: DayString?, targetOn: DayString?)
    /// A routine's, a season's or a project's notes, as typed
    /// (`{"action":"notes","notes":…|null}`). Stored trimmed; nil or text
    /// that trims to nothing clears them. At most `EditLimits.outerNotes`
    /// UTF-16 units as sent (send `cleanNotes(_:limit:)` of what was typed).
    case notes(String?)
    /// A goal's why, as `notes` (`{"action":"why","why":…|null}`). A goal has
    /// no notes: its free text is the why.
    case why(String?)
    /// Any container's new name, as typed (`{"action":"rename","name":…}`).
    /// The route trims it and refuses one that trims to nothing or runs past
    /// `EditLimits.outerTitle` UTF-16 units (send `cleanTitle(_:limit:)` of
    /// what was typed). A project's runs its clash check first and re-files
    /// its members by id after (`projectNameClash`, `refiledItems`).
    case rename(String)
    /// Any container's glyph, an `icon:<Name>` token
    /// (`ContainerLook.iconToken`; `{"action":"icon","icon":…}`). Never
    /// cleared: the web never clears a glyph. A project's is written to its
    /// `emoji`.
    case icon(String)
    /// Any container's colour, one of `ContainerLook.ramp`, or nil for
    /// Auto, which clears it so the name's hash colours it again
    /// (`{"action":"color","color":…|null}`).
    case color(String?)

    /// The route's `action`, which `containerWrites` lists. A pause and a
    /// resume are both `pause`; a season's and a goal's Status both `state`.
    public var action: ContainerAction {
        switch self {
        case .pause, .resume: return .pause
        case .state, .goalState: return .state
        case .usualTime: return .usualTime
        case .dates: return .dates
        case .window: return .window
        case .notes: return .notes
        case .why: return .why
        case .rename: return .rename
        case .icon: return .icon
        case .color: return .color
        }
    }

    /// The kinds whose route takes it: its action's, but a Status only on
    /// the kind its states belong to.
    public var kinds: [OrganizeKind] {
        switch self {
        case .state: return [.season]
        case .goalState: return [.goal]
        default: return action.kinds
        }
    }

    /// Whether `kind`'s route takes it.
    public func applies(to kind: OrganizeKind) -> Bool {
        return kinds.contains(kind)
    }

    /// The zone a pause or a resume carries for the server, or nil.
    public var timeZone: String? {
        switch self {
        case .pause(_, let zone), .resume(let zone): return zone
        default: return nil
        }
    }

    /// Whether the route's schema takes the intent's values (on a kind that
    /// takes the intent at all, `applies(to:)`): a Pause until day, a Runs or
    /// window day a real day the schema reads (years 0100 to 9999: JavaScript
    /// reads a two-digit year as 19xx, so the route's `isCalendarDate` refuses
    /// 0000 to 0099); a range not inverted; a usual time "HH:mm" from 00:00 to
    /// 23:59; notes or a why of at most `EditLimits.outerNotes` UTF-16 units
    /// as sent; a name that trims to 1 to `EditLimits.outerTitle` units; an
    /// icon `icon:` and 1 to 64 ASCII letters or digits; a colour on the ramp.
    /// A body is never built for one that isn't (it would be 400).
    public var isWellFormed: Bool {
        switch self {
        case .pause(let until, _):
            return until.map(isSchemaDay) ?? true
        case .resume, .state, .goalState:
            return true
        case .usualTime(let time):
            return time.map(isTimeStr) ?? true
        case .dates(let start, let end), .window(let start, let end):
            return isSchemaRange(start, end)
        case .notes(let text), .why(let text):
            return (text?.utf16.count ?? 0) <= EditLimits.outerNotes
        case .rename(let name):
            let trimmed = jsTrim(name).utf16.count
            return trimmed >= 1 && trimmed <= EditLimits.outerTitle
        case .icon(let token):
            return isIconToken(token)
        case .color(let color):
            return color.map(isRampToken) ?? true
        }
    }

    /// The name a well-formed rename writes (trimmed, as the route's `Name`
    /// schema reads it): the container's new name, and a project's members'.
    /// Nil for any other intent, or a rename the route would refuse.
    public var renamedTo: String? {
        guard case .rename(let name) = self, isWellFormed else { return nil }
        return jsTrim(name)
    }
}

/// lib/app-http.ts `DateStrSchema` on a `DayString`'s text: always
/// "yyyy-MM-dd" and a real day, so only the year can fail it. The route's
/// `isCalendarDate` builds the day with `Date.UTC`, which reads a year of 0
/// to 99 as 1900 to 1999, so those never match.
private func isSchemaDay(_ day: DayString) -> Bool {
    return (100...9999).contains(day.year)
}

/// Both ends schema days, and the start not after the end (the unions'
/// `rejectInverted`; compared as the route compares the strings).
private func isSchemaRange(_ start: DayString?, _ end: DayString?) -> Bool {
    if let start, !isSchemaDay(start) { return false }
    if let end, !isSchemaDay(end) { return false }
    if let start, let end, start > end { return false }
    return true
}

/// lib/app-http.ts `TimeStrSchema`: `/^([01]\d|2[0-3]):[0-5]\d$/`, ASCII
/// digits only.
private func isTimeStr(_ s: String) -> Bool {
    let b = Array(s.utf16)
    func digit(_ u: UInt16, _ max: UInt16) -> Bool { u >= 48 && u <= 48 + max }
    guard b.count == 5, b[2] == 58 /* : */ else { return false }
    guard digit(b[0], 2), digit(b[1], 9), digit(b[3], 5), digit(b[4], 9) else { return false }
    return b[0] < 50 /* 0 or 1 */ || b[1] <= 51 /* 20 to 23 */
}

/// lib/app-containers.ts `IconToken`: `/^icon:[A-Za-z0-9]{1,64}$/`.
private func isIconToken(_ s: String) -> Bool {
    let units = Array(s.utf16)
    let prefix = Array(ContainerLook.iconTokenPrefix.utf16)
    guard units.count > prefix.count, units.starts(with: prefix) else { return false }
    let name = units.dropFirst(prefix.count)
    guard name.count <= 64 else { return false }
    return name.allSatisfy { u in
        (u >= 48 && u <= 57) || (u >= 65 && u <= 90) || (u >= 97 && u <= 122)
    }
}

/// lib/app-containers.ts `AccentToken`: one of lib/accent-colors.ts
/// `ACCENT_RAMP`, matched code unit for code unit.
private func isRampToken(_ s: String) -> Bool {
    return ContainerLook.ramp.contains { $0.utf16.elementsEqual(s.utf16) }
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
    /// A goal's `state` (O8b).
    public var goalState: GoalState?
    /// A goal's `achievedAt` (O8b): stamped on Achieved, cleared on Active.
    public var achievedAt: ColumnWrite?
    /// A routine's `usualTime` (O8b).
    public var usualTime: ColumnWrite?
    /// A season's or a goal's `startsOn` (O8b).
    public var startsOn: ColumnWrite?
    /// A season's `endsOn` (O8b).
    public var endsOn: ColumnWrite?
    /// A goal's `targetOn` (O8b).
    public var targetOn: ColumnWrite?
    /// A routine's, a season's or a project's `notes` (O8b).
    public var notes: ColumnWrite?
    /// A goal's `why` (O8b).
    public var why: ColumnWrite?
    /// The `name` (O9); never cleared.
    public var name: String?
    /// A routine's, a season's or a goal's `icon` (O9); never cleared.
    public var icon: String?
    /// A project's glyph, its `emoji` column (O9); never cleared.
    public var emoji: String?
    /// The `color` (O9); `.clear` is Auto.
    public var color: ColumnWrite?

    public init(
        pausedAt: ColumnWrite? = nil,
        pausedUntil: ColumnWrite? = nil,
        state: SeasonState? = nil,
        goalState: GoalState? = nil,
        achievedAt: ColumnWrite? = nil,
        usualTime: ColumnWrite? = nil,
        startsOn: ColumnWrite? = nil,
        endsOn: ColumnWrite? = nil,
        targetOn: ColumnWrite? = nil,
        notes: ColumnWrite? = nil,
        why: ColumnWrite? = nil,
        name: String? = nil,
        icon: String? = nil,
        emoji: String? = nil,
        color: ColumnWrite? = nil
    ) {
        self.pausedAt = pausedAt
        self.pausedUntil = pausedUntil
        self.state = state
        self.goalState = goalState
        self.achievedAt = achievedAt
        self.usualTime = usualTime
        self.startsOn = startsOn
        self.endsOn = endsOn
        self.targetOn = targetOn
        self.notes = notes
        self.why = why
        self.name = name
        self.icon = icon
        self.emoji = emoji
        self.color = color
    }

    public var isEmpty: Bool { self == ContainerPatch() }

    /// `container` with the patch written: a field the patch sets takes the
    /// value, one it clears becomes nil, one it leaves out stays, and a field
    /// the kind doesn't have is ignored. Never a member list: no patch has
    /// one. An empty patch changes nothing.
    public func applied(to container: ContainerSnapshot) -> ContainerSnapshot {
        switch container {
        case .routine(var routine):
            if let pausedAt { routine.pausedAt = pausedAt.value }
            if let pausedUntil { routine.pausedUntil = pausedUntil.value }
            if let usualTime { routine.usualTime = usualTime.value }
            if let notes { routine.notes = notes.value }
            if let name { routine.name = name }
            if let icon { routine.icon = icon }
            if let color { routine.color = color.value }
            return .routine(routine)
        case .season(var season):
            if let state { season.state = state.rawValue }
            if let startsOn { season.startsOn = startsOn.value }
            if let endsOn { season.endsOn = endsOn.value }
            if let notes { season.notes = notes.value }
            if let name { season.name = name }
            if let icon { season.icon = icon }
            if let color { season.color = color.value }
            return .season(season)
        case .goal(var goal):
            if let goalState { goal.state = goalState.rawValue }
            if let achievedAt { goal.achievedAt = achievedAt.value }
            if let startsOn { goal.startsOn = startsOn.value }
            if let targetOn { goal.targetOn = targetOn.value }
            if let why { goal.why = why.value }
            if let name { goal.name = name }
            if let icon { goal.icon = icon }
            if let color { goal.color = color.value }
            return .goal(goal)
        case .project(var project):
            if let notes { project.notes = notes.value }
            if let name { project.name = name }
            if let emoji { project.emoji = emoji }
            if let color { project.color = color.value }
            return .project(project)
        }
    }
}

/// lib/app-containers.ts `ContainerIntentResult`: the write an intent makes,
/// or the route's refusal of it.
public enum ContainerIntentResult: Sendable, Hashable {
    /// The columns to write; empty when already so (200, nothing written).
    case patch(ContainerPatch)
    /// The route's answer instead: its code (`pause_refused`, 409) or, for an
    /// intent the kind doesn't take or a value its schema refuses, the
    /// schema's (`invalid`, 400).
    case refused(code: String, status: Int)
}

/// A value, or a clear for none.
private func column(_ value: String?) -> ColumnWrite {
    return value.map { ColumnWrite.set($0) } ?? .clear
}

/// lib/item-edit.ts `cleanNotes` as a column: trimmed, and nil or blank is a
/// clear (`raw?.trim() || undefined`).
private func noteColumn(_ raw: String?) -> ColumnWrite {
    let trimmed = raw.map(jsTrim) ?? ""
    return trimmed.isEmpty ? .clear : .set(trimmed)
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
/// - goal `state`: lib/goals.ts `resolveGoalStateWrite` at `now`: the state it
///   already has is empty (a goal achieved twice keeps its first stamp);
///   Achieved stamps `now`, Active clears the stamp, Set aside keeps it.
/// - `usualTime`, `dates`, `window`: the value as sent, a nil end cleared;
///   both ends of a range together.
/// - `notes`, `why`: trimmed; nil or blank clears.
/// - `rename`: the name trimmed. `icon`: the token, a project's into its
///   `emoji`. `color`: the token, nil clears it.
///
/// Every field intent but the two states (and a pause already so) writes its
/// value again when it already has it: the same value, so a retry is
/// harmless. A project rename's re-file of its members is not in the patch:
/// see `refiledItems` and `refiling`.
///
/// `today` stands in for the day when `timeZone` can't be read (the web would
/// throw; the server's zone always reads). An intent the container's kind
/// doesn't take, or with a value the route's schema refuses
/// (`isWellFormed`), is refused as the schema refuses it.
public func containerIntentPatch(
    _ intent: ContainerIntent,
    on container: ContainerSnapshot,
    now: Date,
    timeZone: String,
    today: String
) -> ContainerIntentResult {
    let invalid = ContainerIntentResult.refused(code: "invalid", status: 400)
    guard intent.applies(to: container.kind), intent.isWellFormed else { return invalid }
    switch (intent, container) {
    case (.pause(let until, _), .routine(let routine)):
        return pauseResult(routine, paused: true, until: until?.description, now: now, timeZone: timeZone, today: today)
    case (.resume, .routine(let routine)):
        return pauseResult(routine, paused: false, until: nil, now: now, timeZone: timeZone, today: today)
    case (.state(let state), .season(let season)):
        return .patch(season.state == state.rawValue ? ContainerPatch() : ContainerPatch(state: state))
    case (.goalState(let state), .goal(let goal)):
        let write = resolveGoalStateWrite(goal, state: state, nowISO: toISOString(now))
        return .patch(ContainerPatch(goalState: write.state, achievedAt: write.achievedAt))
    case (.usualTime(let time), .routine):
        return .patch(ContainerPatch(usualTime: column(time)))
    case (.dates(let start, let end), .season):
        return .patch(ContainerPatch(startsOn: column(start?.description), endsOn: column(end?.description)))
    case (.window(let start, let target), .goal):
        return .patch(ContainerPatch(startsOn: column(start?.description), targetOn: column(target?.description)))
    case (.notes(let text), .routine), (.notes(let text), .season), (.notes(let text), .project):
        return .patch(ContainerPatch(notes: noteColumn(text)))
    case (.why(let text), .goal):
        return .patch(ContainerPatch(why: noteColumn(text)))
    case (.rename(let name), _):
        return .patch(ContainerPatch(name: jsTrim(name)))
    case (.icon(let token), .project):
        // A project's glyph column is `emoji`: the name it had before icons.
        return .patch(ContainerPatch(emoji: token))
    case (.icon(let token), _):
        return .patch(ContainerPatch(icon: token))
    case (.color(let color), _):
        return .patch(ContainerPatch(color: column(color)))
    default:
        return invalid
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

/* ── a project rename's two other steps (O9) ──────────────────────────── */

/// lib/app-containers.ts `renameProject`, step 1: the LIVE project, other
/// than `exceptId`, whose name folds to the same as `name` trimmed (the
/// route's `Name` schema trims it), folded as lib/container-registry.ts
/// `foldContainerName` folds a project (`caseFold`, `toLowerCase`, so
/// `jsLowercased`). A rename onto it is 409 `name_taken`, so Rename's Save
/// stays off while there is one; a project changing only its own case is not
/// one (`exceptId`). `projects` are the live ones (the payload's): a project
/// in the Trash is no clash here, only its exact name is, as a 409
/// `name_in_trash` the server finds. Nil for a name that trims to nothing,
/// which the route refuses before it asks. The create sheet asks the same
/// with no `exceptId`.
public func projectNameClash(_ name: String, among projects: [Project], except exceptId: String? = nil) -> Project? {
    let trimmed = jsTrim(name)
    guard !trimmed.isEmpty else { return nil }
    let folded = Array(jsLowercased(trimmed).utf16)
    return projects.first { project in
        project.id != exceptId && jsLowercased(project.name).utf16.elementsEqual(folded)
    }
}

/// lib/app-containers.ts `renameProject`, step 3 (lib/db.ts
/// `renameContainerMembers`): the items a container write re-files, by id.
/// A well-formed project rename re-files every item whose `projectId` is the
/// project's (by id, never by name: an item filed under the old name with no
/// id stays put, as on the server); every other write re-files none. What
/// the phone records at enqueue as the write's `refiled`, since the write
/// alone can't name them later. (The server also reaches trashed members,
/// which the phone doesn't hold.)
public func refiledItems(_ intent: ContainerIntent, on ref: ContainerRef, items: [Item]) -> [UUID] {
    guard ref.kind == .project, intent.renamedTo != nil else { return [] }
    return items.filter { $0.projectId == ref.id }.map(\.id)
}

/// `item` as a container write leaves it (lib/app-containers.ts
/// `renameProject`, step 3): a well-formed project rename gives a member, an
/// item whose `projectId` is the project's, the new name, trimmed as the
/// route writes it. Every other write, and every other item, is unchanged.
/// The optimistic step and a landed rename's replay both use it.
public func refiling(_ item: Item, by intent: ContainerIntent, on ref: ContainerRef) -> Item {
    guard ref.kind == .project, let name = intent.renamedTo, item.projectId == ref.id else { return item }
    var next = item
    next.project = name
    return next
}

/* ── the zone, and the switch ─────────────────────────────────────────── */

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
