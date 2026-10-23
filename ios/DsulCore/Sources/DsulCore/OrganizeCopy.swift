import Foundation

// Port of lib/organize-copy.ts, the words Organize's two shells share: the
// Status chips' labels, the "switched off" sentences, a routine's paused and
// held notes and its Today lines, a season's state sentence and Runs chip, a
// goal's ended note, wind-down sentence and empty sentences, a check-in's
// meta and a milestone tick's name. Keep in step: a change there without the
// same change here is drift, and the phone words a container differently
// from the web. Checked against the web by OrganizeCopyFixtureTests
// (tests/fixtures/organize/copy.json), byte for byte: the curly quotes
// (U+201C, U+201D), the apostrophe (U+2019) and the separator (U+00B7) are
// the web's.
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
