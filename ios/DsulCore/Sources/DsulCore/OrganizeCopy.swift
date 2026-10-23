import Foundation

// Port of lib/organize-copy.ts, the words Organize's two shells share: the
// Status chips' labels, the "switched off" sentences, a routine's paused and
// held notes and its Today lines, a season's state sentence and Runs chip, a
// goal's ended note, wind-down sentence and empty sentences, a check-in's
// meta and a milestone tick's name; from O4 the summary cards' lines
// (`weekCardSentence`, `nextMilestoneLine`, pinned by organize.json), and from
// O14 the Trash's (`whenGone`, `daysUntilPurge`, the row meta, the restore
// sentences and the phone's refusal words). From O8a, the banner for a refused
// container write (`refusal(code:for:)`, `PAUSE_REFUSED` and
// `containerRefusal`), the phone's own words, which the web never says; from
// O9 its two name refusals, the second through `nameTakenSentence`, which the
// web's rename also says inline. From O10 a delete's confirm (`deleteTitle`,
// `deleteConfirmLabel` and `deleteConsequence`, the phone's sentence, which
// offers no undo and ends on `deleteStaysInTrash(kind)`), and from O11 the create
// sheet's words and starting glyph (`createCopy`, lib/organize-copy.ts
// `CONTAINER_CREATE_COPY`), whose name refusals `refusal(code:for:)` words by
// the name the create sent.
// Keep in step: a change there without the same change here is drift, and
// the phone words a container differently from the web. Checked against the
// web by OrganizeCopyFixtureTests (tests/fixtures/organize/copy.json), byte
// for byte: the curly quotes (U+201C, U+201D), the apostrophe (U+2019) and
// the separator (U+00B7) are the web's.
//
// Dates are `formatDay`'s fixed English months ("Oct 30", Cadence.swift). The
// guilt-free law holds in every line: nothing here says "missed", and nothing
// is late, only "still ahead". No em dashes.

/// One value of a Status chip and its label, in the web's order.
public struct StateLabel: Sendable, Hashable {
    /// The stored value ("active", "paused", "auto", "achieved", "abandoned").
    public var value: String
    /// What the chip says.
    public var label: String

    public init(value: String, label: String) {
        self.value = value
        self.label = label
    }
}

/// lib/organize-copy.ts `SwitchedOff`: what a page says while its extension
/// is off. Inert, never "not found".
public struct SwitchedOff: Sendable, Hashable {
    public var title: String
    public var body: String

    public init(title: String, body: String) {
        self.title = title
        self.body = body
    }

    /// lib/organize-copy.ts `switchedOffSentence`: the title and body as one
    /// run of text, for a surface with no room for a heading.
    public var sentence: String {
        return "\(title). \(body)"
    }
}

/// lib/organize-copy.ts `CreateCopy`: the create sheet's words for one kind,
/// and the glyph a new one starts with (O11).
public struct CreateCopy: Sendable, Hashable {
    /// "NEW ROUTINE": names what is being made.
    public var eyebrow: String
    /// "Name your routine…", the field's placeholder.
    public var placeholder: String
    /// The button: "Create routine".
    public var addLabel: String
    /// The glyph token a new one starts with (`icon:Repeat`). `icon:CalendarRange`
    /// is not in the icon library, so a new season's glyph derives from its
    /// name, on the web and the phone alike.
    public var icon: String
    /// What the kind is for, said once under the field.
    public var hint: String

    public init(eyebrow: String, placeholder: String, addLabel: String, icon: String, hint: String) {
        self.eyebrow = eyebrow
        self.placeholder = placeholder
        self.addLabel = addLabel
        self.icon = icon
        self.hint = hint
    }
}

/// lib/organize-copy.ts `DeleteConsequenceInput`: what a delete's confirm
/// counts, the way the pane counts it (O10).
/// - `routine`: `liveCount` is its live members (`countLive` of its
///   `itemIds`); `reappear` is whether removing it puts any of them back on
///   the day (`membersRevealedByRemoving` is not empty).
/// - `season`: `itemCount` and `routineCount` are its live direct members and
///   live routines (`countLive`); `live` is `isSeasonActiveOn` today.
/// - `goal`: nothing to count; its members are ordinary items and stay.
/// - `project`: `itemCount` is the items filed under it, as its page counts
///   them (folded members, subtasks left out). The TS input's `requiredCount`
///   and `destination` are the web store's own move, which the phone's delete
///   never makes, so the phone has neither.
public enum DeleteConsequenceInput: Sendable, Hashable {
    case routine(name: String, liveCount: Int, reappear: Bool)
    case season(name: String, itemCount: Int, routineCount: Int, live: Bool)
    case goal
    case project(name: String, itemCount: Int)

    /// The kind the sentence is about, which names its last sentence.
    public var kind: OrganizeKind {
        switch self {
        case .routine: return .routine
        case .season: return .season
        case .goal: return .goal
        case .project: return .project
        }
    }
}

/// lib/organize-copy.ts, as one namespace.
public enum OrganizeCopy {
    /* ── status chips ──────────────────────────────────────────────────── */

    /// `ROUTINE_STATE_LABELS`: a routine's Status chip, its OWN switch.
    public static let routineStates: [StateLabel] = [
        StateLabel(value: "active", label: "Active"),
        StateLabel(value: "paused", label: "Paused"),
    ]

    /// `SEASON_STATE_LABELS`. `auto` follows its dates, so it reads "Dates".
    public static let seasonStates: [StateLabel] = [
        StateLabel(value: "active", label: "On"),
        StateLabel(value: "paused", label: "Off"),
        StateLabel(value: "auto", label: "Dates"),
    ]

    /// `GOAL_STATE_LABELS`. `abandoned` is "Set aside": put down, nothing
    /// failed.
    public static let goalStates: [StateLabel] = [
        StateLabel(value: "active", label: "Active"),
        StateLabel(value: "achieved", label: "Achieved"),
        StateLabel(value: "abandoned", label: "Set aside"),
    ]

    /// The label `states` gives `value`, or nil for a value it doesn't name
    /// (the web's record would answer `undefined`).
    public static func label(_ value: String, in states: [StateLabel]) -> String? {
        return states.first { $0.value == value }?.label
    }

    /* ── switched off ──────────────────────────────────────────────────── */

    /// `ORGANIZE_OFF`: a routine's or season's page with Organize off.
    public static let organizeOff = SwitchedOff(
        title: "Organize is switched off",
        body: "Your routines and seasons are still here. Switch the extension back on and this page "
            + "picks up where it left off. Nothing was deleted."
    )

    /// `GOALS_OFF`: a goal's page with Goals off.
    public static let goalsOff = SwitchedOff(
        title: "Goals is switched off",
        body: "Your goals are still here. Switch the extension back on and this page picks up where it "
            + "left off. Nothing was deleted."
    )

    /* ── a routine ─────────────────────────────────────────────────────── */

    /// `NOTHING_IN_IT_YET`: a container with nothing in it.
    public static let nothingInItYet = "Nothing is in it yet."

    /// `routinePausedNote`: under a paused routine's Status, when its items
    /// come back and that nothing was lost. Shown only while the routine's
    /// own switch is off.
    public static func routinePausedNote(_ routine: Routine) -> String {
        let back: String
        if let until = routine.pausedUntil, !until.isEmpty {
            back = "Its items come back on \(formatDay(until)), on their own."
        } else {
            back = "Its items are hidden until you resume."
        }
        return "\(back) Streaks and history stay exactly as they are."
    }

    /// `routineHeldNote`: under an ACTIVE routine that every season holding
    /// it has switched off; nil when its own switch and what it achieves
    /// agree. The first sentence is about the routine, the second about its
    /// items, and only those actually off the day (`hiddenHere`, see
    /// `hiddenHere(_:items:routines:seasons:on:timeZone:)`). The return day
    /// is the soonest holder's.
    public static func routineHeldNote(_ standing: RoutineStanding, hiddenHere: Int, today: DayString) -> String? {
        guard standing.localOn, !standing.effectiveOn, let blocker = standing.soonestBlocker else { return nil }
        let routine = standing.blockers.count == 1
            ? "\u{201C}\(blocker.name)\u{201D} is off, so this routine isn\u{2019}t carrying anything right now."
            : "All \(standing.blockers.count) seasons holding it are off, so this routine isn\u{2019}t carrying anything right now."
        if hiddenHere == 0 { return "\(routine) Its items are still on your day another way." }
        let back = seasonResumeDate(blocker, on: today).map { "Back on \(formatDay($0))." }
            ?? "They come back when one of those seasons does."
        return "\(routine) \(hiddenHere) \(hiddenHere == 1 ? "item is" : "items are") hidden. \(back)"
    }

    /// The count `routineHeldNote` takes, asked as the routine pane asks it:
    /// the routine's `itemIds` (each entry, repeats included) that
    /// `inactiveItemIdsOn` hides on `day`, with the routines and seasons and
    /// NO trips. Not the suppression rows' question, which does ask trips.
    public static func hiddenHere(
        _ routine: Routine,
        items: [Item],
        routines: [Routine],
        seasons: [Season],
        on day: DayString,
        timeZone: String
    ) -> Int {
        let hidden = inactiveItemIdsOn(items: items, date: day, timeZone: timeZone, routines: routines, seasons: seasons)
        return routine.itemIds.filter { hidden.contains($0) }.count
    }

    /// `HELD_BY_NONE`: "Held by" with no season holding the routine.
    public static let heldByNone = "No season. It answers for itself."

    /// `heldByState`: a holder's state in a routine's "Held by" list, "on",
    /// "off", or "off until Nov 1" when its start is still ahead. It reads
    /// the start whatever the season's state (a paused season or an inverted
    /// range included), as the web does.
    public static func heldByState(_ season: Season, today: DayString) -> String {
        if isSeasonActiveOn(season, on: today) { return "on" }
        if let starts = season.startsOn, !starts.isEmpty, starts > today.description {
            return "off until \(formatDay(starts))"
        }
        return "off"
    }

    /// `routineTodaySummary`: "2 of 3 done", "2 of 3 done · 1 skipped"; nil
    /// with nothing on.
    public static func routineTodaySummary(done: Int, total: Int, skipped: Int) -> String? {
        if total == 0 { return nil }
        return "\(done) of \(total) done" + (skipped > 0 ? " \u{00B7} \(skipped) skipped" : "")
    }

    /// `routineTodayEmpty`: a routine with nothing on today, empty or empty
    /// TODAY. The words switch only at 0.
    public static func routineTodayEmpty(name: String, memberCount: Int) -> String {
        return memberCount == 0 ? nothingInItYet : "Nothing from \(name) is on today."
    }

    /// `ROUTINE_TODAY_FINISHED`: everything on today is done or skipped.
    public static let routineTodayFinished = "All through for today."

    /// `ROUTINE_TODAY_NEXT`: the meta on the first member still due.
    public static let routineTodayNext = "next"

    /* ── a season ──────────────────────────────────────────────────────── */

    /// `seasonSpan`: "Oct 1 to Mar 15", "from Oct 1", "until Mar 15"; nil
    /// with no dates.
    private static func seasonSpan(_ startsOn: String?, _ endsOn: String?) -> String? {
        // A non-empty day always formats to a non-empty word (`formatDay`
        // hands back what it cannot read), so only the inputs are tested.
        let from = startsOn.flatMap { $0.isEmpty ? nil : formatDay($0) }
        let to = endsOn.flatMap { $0.isEmpty ? nil : formatDay($0) }
        if let from, let to { return "\(from) to \(to)" }
        if let from { return "from \(from)" }
        if let to { return "until \(to)" }
        return nil
    }

    /// `seasonStateNote`: a season's state in its own words. `live` is
    /// `isSeasonActiveOn(season, on: today)`.
    public static func seasonStateNote(_ season: Season, live: Bool) -> String {
        if season.state == "active" { return "On until you say otherwise. Dates are ignored while it is set this way." }
        if season.state == "paused" {
            return "Off. Everything it holds is hidden, and streaks and history stay exactly as they are."
        }
        guard let span = seasonSpan(season.startsOn, season.endsOn) else {
            return "Always on. Give it a start or an end to make it follow the calendar."
        }
        return "Runs \(span), inclusive. " + (live ? "On now." : "Off right now. Nothing it holds is showing.")
    }

    /// `seasonRunsLabel`: the Runs chip under Dates, "Oct 1 to Mar 15",
    /// "From Oct 1", "Until Mar 15", or nil with no dates. The first UTF-16
    /// unit is upper-cased, as `span[0].toUpperCase()` does.
    public static func seasonRunsLabel(startsOn: String?, endsOn: String?) -> String? {
        guard let span = seasonSpan(startsOn, endsOn) else { return nil }
        return upperFirstUnit(span)
    }

    /* ── a goal ────────────────────────────────────────────────────────── */

    /// `goalEndedNote`: the page's note on an ended goal; nil while it is
    /// active. An achieved goal's day is its `achievedAt` stamp's first ten
    /// characters, the stamp's UTC date, as the web reads it.
    public static func goalEndedNote(_ goal: Goal) -> String? {
        if goal.state == "active" { return nil }
        if goal.state == "achieved" {
            let on = goal.achievedAt.flatMap { $0.isEmpty ? nil : " on \(formatDay(String($0.prefix(10))))" } ?? ""
            return "Achieved\(on). Everything below is the record of how it went."
        }
        return "Set aside. Its work is untouched, and nothing here was cancelled on your behalf."
    }

    /// `windDownSentence`: an ended goal's recurring members keep coming
    /// round, and this says so and changes nothing. Nil with none, and nil
    /// for a goal still active. `count` is `windDownMembers(goal, itemsById:).count`.
    public static func windDownSentence(state: String, count: Int) -> String? {
        if state == "active" || count == 0 { return nil }
        let lead = count == 1
            ? "This still repeats on its own schedule."
            : "\(count) of its items still repeat on their own schedules."
        return "\(lead) Nothing was changed for you. \(state == "achieved" ? "An achieved" : "A set-aside") goal never "
            + "edits its members. Keep them as they are, open one to park it in a season, or delete it for good."
    }

    /// `windDownSentence` for a goal.
    public static func windDownSentence(_ goal: Goal, count: Int) -> String? {
        return windDownSentence(state: goal.state, count: count)
    }

    /// `NO_CHECKIN_YET`.
    public static let noCheckinYet =
        "No check-in yet. A recurring review (weekly is usually right) is what keeps a long goal from going "
        + "quiet for a month at a time."

    /// `NO_MILESTONES_YET`, under Milestones.
    public static let noMilestonesYet =
        "No checkpoints yet. A milestone is a one-shot task whose date is the day you mean to have reached it."

    /// `NO_SUPPORTING_WORK`, under Supporting work.
    public static let noSupportingWork = "Nothing else is filed under this goal yet."

    /// `checkinMeta`: a check-in row's meta, its cadence (`cadenceLabel`,
    /// Cadence.swift) then the last day it was done (`lastDoneOn`): "Sun ·
    /// last Oct 18", or just "Sun" before the first one.
    public static func checkinMeta(cadence: String, lastDone: String?) -> String {
        guard let lastDone, !lastDone.isEmpty else { return cadence }
        return "\(cadence) \u{00B7} last \(formatDay(lastDone))"
    }

    /// `milestoneTickLabel`: a milestone's tick, named for what it does.
    public static func milestoneTickLabel(title: String, reached: Bool) -> String {
        return reached ? "Mark \(title) not reached" : "Mark \(title) reached"
    }

    /* ── the summary cards (O4) ────────────────────────────────────────── */

    /// `NOTHING_ON_THIS_WEEK`: THIS WEEK with nothing done or due; the card
    /// shows no bar.
    public static let nothingOnThisWeek = "Nothing on this week"

    /// `weekCardSentence`: THIS WEEK's line over `organizeWeek`, "18 of 23
    /// done", or `nothingOnThisWeek` when nothing is done or due. Never a share
    /// of the past: `counted` is what is done plus what is still ahead.
    public static func weekCardSentence(done: Int, counted: Int) -> String {
        return counted == 0 ? nothingOnThisWeek : "\(done) of \(counted) done"
    }

    /// `nextMilestoneLine`: NEXT MILESTONE's second line, the milestone's day
    /// through `formatDay` then the goal, "Oct 4 · Run a half marathon", or
    /// the goal's name alone for an undated milestone. No countdown: the web
    /// counts down to a goal's target, never to a milestone.
    public static func nextMilestoneLine(date: String?, goalName: String) -> String {
        guard let date, !date.isEmpty else { return goalName }
        return "\(formatDay(date)) \u{00B7} \(goalName)"
    }

    /* ── the Trash (O14) ───────────────────────────────────────────────── */

    /// `TRASH_WINDOW_DAYS`: how long a soft-deleted row survives before the
    /// nightly purge (migration 036).
    public static let trashWindowDays = 30

    /// `NOTHING_IN_TRASH`: an empty bin.
    public static let nothingInTrash = "Nothing deleted in the last \(trashWindowDays) days."

    /// `TRASH_TEACHING`: what the bin is for, said once beside it.
    public static let trashTeaching = "Anything you delete waits here for \(trashWindowDays) days, then goes for good."

    /// `TRASH_LOAD_FAILED`: the list could not be read. Never an empty bin.
    public static let trashLoadFailed = "Couldn't load the Trash."

    /// `RESTORE_FAILED`: a restore refused for a reason the phone can't fix,
    /// or not answered.
    public static let restoreFailed = "Couldn't restore it. Check your connection and try again."

    /// `RESTORE_GONE`: a restore answered 404, the row no longer in the bin
    /// (purged after the list was read). A retry can never land, so the page
    /// drops the row rather than asking for one.
    public static let restoreGone = "It's no longer in the Trash."

    /// `whenGone`: how long ago, in the words a bin needs. "just now" under an
    /// hour (and for a stamp in the future or one that can't be read), "5h
    /// ago" under a day, else "3d ago", each rounded DOWN from the elapsed
    /// milliseconds, so the count never runs ahead of the purge.
    public static func whenGone(_ deletedAt: String, now: Date = Date()) -> String {
        guard let elapsed = elapsedMilliseconds(deletedAt, now: now), elapsed >= 0 else { return "just now" }
        let hours = elapsed / 3_600_000
        if hours < 1 { return "just now" }
        if hours < 24 { return "\(hours)h ago" }
        return "\(hours / 24)d ago"
    }

    /// `daysUntilPurge`: days of the window still left, counting DOWN from
    /// `whenGone`'s elapsed days so the two never disagree; past the purge it
    /// clamps at 0, and a stamp in the future or one that can't be read reads
    /// the full window.
    public static func daysUntilPurge(_ deletedAt: String, now: Date = Date()) -> Int {
        guard let elapsed = elapsedMilliseconds(deletedAt, now: now), elapsed >= 0 else { return trashWindowDays }
        return max(0, trashWindowDays - elapsed / 86_400_000)
    }

    /// `now - new Date(deletedAt).getTime()` in whole milliseconds (a JS Date
    /// holds none below), or nil where the web's is NaN.
    private static func elapsedMilliseconds(_ deletedAt: String, now: Date) -> Int? {
        guard let gone = parseTimestamp(deletedAt) else { return nil }
        return epochMilliseconds(now) - epochMilliseconds(gone)
    }

    private static func epochMilliseconds(_ date: Date) -> Int {
        return Int((date.timeIntervalSince1970 * 1000).rounded(.down))
    }

    /// `trashKindLine`: a trash row's meta before its age, the kind and then
    /// what comes back WITH it, said before the click: "Item · 2 subtasks",
    /// "Project · 3 items refile". A count of 0 says nothing.
    public static func trashKindLine(_ kind: TrashKind, childCount: Int, memberCount: Int) -> String {
        var line = kind.label
        if childCount > 0 { line += " \u{00B7} \(childCount) \(childCount == 1 ? "subtask" : "subtasks")" }
        if memberCount > 0 { line += " \u{00B7} \(memberCount) \(memberCount == 1 ? "item" : "items") refile" }
        return line
    }

    /// `trashRowMeta`: the whole meta line, "Project · 3 items refile · 3d ago".
    public static func trashRowMeta(
        _ kind: TrashKind, childCount: Int, memberCount: Int, deletedAt: String, now: Date = Date()
    ) -> String {
        return "\(trashKindLine(kind, childCount: childCount, memberCount: memberCount)) \u{00B7} "
            + whenGone(deletedAt, now: now)
    }

    /// `trashRowMeta` for a row of the bin as the route answers it.
    public static func trashRowMeta(_ row: TrashRow, now: Date = Date()) -> String {
        return trashRowMeta(
            row.kind, childCount: row.childCount, memberCount: row.memberCount, deletedAt: row.deletedAt, now: now
        )
    }

    /// `restoreSentence`: what restoring a trashed container reconnects, one
    /// honest sentence per kind (the web's ContainerFacts). The noun is the
    /// registry's, lower-cased.
    public static func restoreSentence(_ kind: OrganizeKind, memberCount: Int) -> String {
        let noun = jsLowercased(TrashKind(kind).label)
        switch kind {
        case .project:
            return memberCount > 0
                ? "Restoring brings the \(noun) back and re-files the \(memberCount) "
                    + "\(memberCount == 1 ? "item" : "items") still pointing at it."
                : "Restoring brings the \(noun) back. Nothing is filed under it right now."
        case .routine:
            return "Restoring brings the \(noun) back, along with the items it grouped."
        case .season:
            return "Restoring brings the \(noun) back, along with the routines and items it held."
        case .goal:
            return "Restoring brings the \(noun) back, along with its milestones, check-ins and members."
        }
    }

    /* ── making one (O11) ───────────────────────────────────────────────── */

    /// The kind's noun as copy says it mid-sentence ("routine"), from the
    /// registry's (`ContainerWords`).
    private static func noun(_ kind: OrganizeKind) -> String {
        return jsLowercased(TrashKind(kind).label)
    }

    /// `CONTAINER_CREATE_COPY[kind]`: the create sheet's eyebrow, placeholder,
    /// button and hint, and the glyph a new one starts with. The first three
    /// say the registry's noun; the hints are the web's.
    public static func createCopy(_ kind: OrganizeKind) -> CreateCopy {
        let word = noun(kind)
        func words(_ icon: String, _ hint: String) -> CreateCopy {
            return CreateCopy(
                eyebrow: "NEW \(word.uppercased())", placeholder: "Name your \(word)\u{2026}",
                addLabel: "Create \(word)", icon: icon, hint: hint
            )
        }
        switch kind {
        case .goal:
            return words(
                "icon:Target",
                "A goal is the reason a stretch of work exists. It holds the habits and tasks that serve it, the "
                    + "checkpoints along the way, and a recurring check-in. It never hides anything."
            )
        case .routine:
            return words(
                "icon:Repeat",
                "A routine is a set of things you do regularly, in order, like a morning or a workout week. Pause it "
                    + "and they all step off your day together."
            )
        case .season:
            return words(
                "icon:CalendarRange",
                "A season is a stretch of life (a summer, a term, a training block) that switches whole routines on "
                    + "and off. Without dates it starts always-on, hiding nothing."
            )
        case .project:
            return words(
                "icon:Briefcase",
                "\(ContainerWords.projects) file your tasks, and can carry a repeating block on the grid."
            )
        }
    }

    /// The + menu's row for a kind: "New routine", "New season", "New goal",
    /// "New project", sentence case, built from the registry's noun (design
    /// §4: nothing reads `CONTAINER_KINDS.*.newLabel`, whose "New Project" is
    /// title case). Phone-only: the web's console says "+ New".
    public static func newMenuLabel(_ kind: OrganizeKind) -> String {
        return "New \(noun(kind))"
    }

    /* ── deleting one (O10) ────────────────────────────────────────────── */

    /// `DELETE_STAYS_IN_TRASH[kind]`: how every phone delete confirm ends,
    /// "The routine stays in the Trash for 30 days." The phone has no undo,
    /// so it names the bin, never an undo. It names the kind because the
    /// sentence before it can end on an item ("It just stops being
    /// grouped."), and a bare "It" would read as the item going.
    public static func deleteStaysInTrash(_ kind: OrganizeKind) -> String {
        return "The \(noun(kind)) stays in the Trash for \(trashWindowDays) days."
    }

    /// `deleteTitle`: a delete confirm's title. "Delete this routine?",
    /// "Delete this season?", "Delete Run a half marathon?" (the goal's own
    /// name, unquoted) and `Delete “Home”?`.
    public static func deleteTitle(_ kind: OrganizeKind, name: String) -> String {
        switch kind {
        case .routine, .season: return "Delete this \(noun(kind))?"
        case .goal: return "Delete \(name)?"
        case .project: return "Delete \u{201C}\(name)\u{201D}?"
        }
    }

    /// `DELETE_CONFIRM_LABELS[kind]`: a delete confirm's button, "Delete", and
    /// the goal's "Delete goal".
    public static func deleteConfirmLabel(_ kind: OrganizeKind) -> String {
        return kind == .goal ? "Delete \(noun(.goal))" : "Delete"
    }

    /// `deleteConsequence(input, 'phone')`: what a delete confirm says will
    /// happen, the PHONE's sentence. The web's says what ⌘Z can do; the phone
    /// has no undo, so this never offers one, and every kind ends on
    /// `deleteStaysInTrash(kind)` (the goal's own "moves to the trash" opening
    /// goes, so 30 days is said once). One thing is counted in the singular,
    /// and an empty routine says only that it is removed, as the web now
    /// does. A project's never says a habit moves: the phone's delete stamps
    /// the project alone.
    public static func deleteConsequence(_ input: DeleteConsequenceInput) -> String {
        let said: String
        switch input {
        case .routine(let name, let n, let reappear):
            if n == 0 {
                // An empty routine has nothing to keep, so it says only that
                // it goes.
                said = "\u{201C}\(name)\u{201D} is removed."
            } else {
                let one = n == 1
                var line = "\u{201C}\(name)\u{201D} is removed, but its \(n) \(one ? "item stays" : "items stay")"
                line += " exactly as \(one ? "it is" : "they are"). "
                    + "\(one ? "It just stops" : "They just stop") being grouped"
                if reappear { line += ", and \(one ? "it comes" : "they come") back into view" }
                said = line + "."
            }
        case .season(let name, let itemCount, let routineCount, let live):
            var held: [String] = []
            if itemCount > 0 { held.append("\(itemCount) \(itemCount == 1 ? "item" : "items")") }
            if routineCount > 0 { held.append("\(routineCount) \(routineCount == 1 ? "routine" : "routines")") }
            let one = itemCount + routineCount == 1
            var line = "\u{201C}\(name)\u{201D} is removed"
            if !held.isEmpty {
                line += ", but the \(held.joined(separator: " and ")) it holds "
                    + (one ? "stays exactly as it is" : "stay exactly as they are")
            }
            if !live && !held.isEmpty { line += ". Anything it was hiding comes back into view" }
            said = line + "."
        case .goal:
            said = "Its habits, tasks and milestones are ordinary items and stay exactly where they are. "
                + "Only the goal and its links go."
        case .project(let name, let n):
            if n == 0 {
                said = "Nothing is filed under it, so nothing moves."
            } else {
                let one = n == 1
                said = "Its \(n) \(one ? "item stays" : "items stay") exactly as \(one ? "it is" : "they are"). "
                    + "\(one ? "It just stops" : "They just stop") being filed under \(name)."
            }
        }
        return "\(said) \(deleteStaysInTrash(input.kind))"
    }

    /// `nameInTrashSentence`: a name a trashed container is still holding (the
    /// unique index spans the bin). It names the Trash because the bin is the
    /// fix.
    public static func nameInTrashSentence(noun: String, name: String) -> String {
        return "A deleted \(noun) called \u{201C}\(name)\u{201D} still has that name. "
            + "Restore it from Trash, or pick a different one."
    }

    /// `restoreRefusal`: the phone's words for a refused restore. `name_taken`
    /// when a live project folds to the same name (`name` is that project's,
    /// see `TrashRestoreRefusal.sentence(rowName:)`), `parent_gone` when a
    /// subtask's parent is in the bin too, `not_found` when the row is no
    /// longer in the bin (`restoreGone`). Anything else, no answer at all
    /// included, is `restoreFailed`.
    public static func restoreRefusal(code: String?, name: String) -> String {
        if code == "name_taken" {
            return "You already have a \(jsLowercased(ContainerWords.project)) called \u{201C}\(name)\u{201D}. "
                + "Rename that one, then restore this one."
        }
        if code == "parent_gone" { return "Its parent is in the Trash too. Restore that instead." }
        if code == "not_found" { return restoreGone }
        return restoreFailed
    }

    /* ── container writes (O8a, O9) ────────────────────────────────────── */

    /// `PAUSE_REFUSED`: the banner for a routine pause the route refused
    /// (`pause_refused`, 409): Pause until's day is no longer after today,
    /// because the picker was left open across midnight, so nothing was
    /// paused. The item sheet's words for the same refusal of an item's
    /// pause. Phone-only: the web's store refuses the same request before it
    /// writes, and says nothing.
    public static let pauseRefused = "That day is no longer after today, so nothing was paused."

    /// `nameTakenSentence`: a name a live sibling already has, folding case
    /// (the web's inline rename check, and the phone's banner for a project
    /// rename refused 409 `name_taken`). The noun is the caller's, lower-cased.
    public static func nameTakenSentence(noun: String, name: String) -> String {
        return "You already have a \(noun) called \u{201C}\(name)\u{201D}."
    }

    /// `containerRefusal(code, sentName)`: the banner for a container write
    /// the route refused, by its code (design §6.4):
    /// - `pause_refused` is `pauseRefused`, whatever was sent;
    /// - `name_taken` (a project named onto a live project's name, folding
    ///   case) is `nameTakenSentence`, and `name_in_trash` (onto the exact
    ///   name a project in the Trash still holds) is `nameInTrashSentence`,
    ///   both naming the project by `sentName`, the name the write sent, never
    ///   the answer's body. Without one, they have no words.
    /// Nil for a code with no words of its own (an answer that never came, a
    /// 404, a 500), where the sync says what it says for any failed write.
    /// Later parts add their codes here (`container_gone`, `member_gone`,
    /// `anchor_gone`). The two overloads below take the name from the write.
    public static func refusal(code: String?, sentName: String?) -> String? {
        let noun = jsLowercased(ContainerWords.project)
        switch code {
        case "pause_refused": return pauseRefused
        case "name_taken": return sentName.map { nameTakenSentence(noun: noun, name: $0) }
        case "name_in_trash": return sentName.map { nameInTrashSentence(noun: noun, name: $0) }
        default: return nil
        }
    }

    /// `containerRefusal` for a field write (O8a, O9): a rename's name,
    /// trimmed as the route read it, is the one sent; no other intent sends a
    /// name, so the name codes have no words for it.
    public static func refusal(code: String?, for intent: ContainerIntent) -> String? {
        var sentName: String? = nil
        if case .rename(let name) = intent { sentName = jsTrim(name) }
        return refusal(code: code, sentName: sentName)
    }

    /// `containerRefusal` for a create (O11): the name the create sent, trimmed
    /// as the route read it (`storedName`). Only a project's create is ever
    /// refused for its name.
    public static func refusal(code: String?, for create: ContainerCreateBody) -> String? {
        return refusal(code: code, sentName: create.storedName)
    }
}

/// `s[0].toUpperCase() + s.slice(1)`: the first UTF-16 code unit upper-cased
/// (a lone surrogate stays as it is), the rest untouched.
private func upperFirstUnit(_ s: String) -> String {
    let units = Array(s.utf16)
    guard let first = units.first else { return s }
    guard let scalar = Unicode.Scalar(first) else { return s }
    let rest = String(decoding: units.dropFirst(), as: UTF16.self)
    return String(scalar).uppercased() + rest
}
