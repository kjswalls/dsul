import Foundation

// Port of lib/item-verbs.ts (labels, details, `eligibleVerbs`) and
// lib/verb-gates.ts (every gate body and shared predicate, which item-verbs.ts
// re-exports), for the verbs the phone's item sheet offers:
// tick, skip, unskip, pause, resume, nextDay, reschedule, resetStreak and
// delete. For each, its gate (`verbEligible`), its label (`verbLabel`) and its
// detail (`verbDetail`), and `eligibleVerbs` in the web's declaration order;
// with the shared predicates (`isDoneOn`, `isSkippedOn`, `isCancelled`), the
// day's state (`drawnState`, `occurrenceOn`) and lib/reminders/due.ts
// `occursOn`, which `occurrenceOn` asks first. Keep in step: a change there
// without the same change here is drift, and the sheet offers a verb the web's
// menus refuse. Checked against the web by ItemVerbsFixtureTests
// (tests/fixtures/day/verbs.json) and OccursFixtureTests (occurs.json).
//
// The day a verb acts on is always passed in (`VerbContext.dateStr`), never
// looked up, as on the web; pause and resume read wall-clock today
// (`todayStr`) instead, because pausing is dateless. Gates are pure: the app
// re-reads the item and asks again with a fresh context before it writes.
//
// Not ported: `complete`, `braindump` and `leaveProjectBlock` (the sheet
// doesn't offer them yet), `milestoneIds` (the payload has no goals), and
// every `run`: the app does the optimistic step (VerbWrites.swift,
// ItemEdit.swift) and sends the write. Delete's `run` is a confirm whose words
// are the registry's (`ItemCaps.deleteDescription`) and the app's; Reset
// streak's is the streak popover's confirm. Days stay yyyy-MM-dd strings,
// compared as strings, as on the web.

/// lib/container-schedule.ts `OccurrenceState`, plus 'absent' (the item does
/// not fall on the day): what a caller knows about an item on one day.
public enum Occurrence: String, Sendable, Hashable, CaseIterable {
    case done, skipped, due, open, absent
}

/// lib/item-verbs.ts `VerbContext`, without `date` (the same day as `dateStr`)
/// and `milestoneIds`, plus the Streaks extension, which the web's gate reads
/// from a store and the phone is handed.
public struct VerbContext: Sendable, Hashable {
    /// The day the verb acts on, yyyy-MM-dd in the user's zone.
    public var dateStr: String
    /// Wall-clock today in the user's zone. Pause and resume read this.
    public var todayStr: String
    /// The user's IANA zone.
    public var timeZone: String
    /// What the caller knows about the item on `dateStr` (`occurrenceOn`); nil
    /// is unknown, and the per-day verbs then gate on the item's own records.
    public var occurrence: Occurrence?
    /// lib/extension-gates.ts `streaksEnabled()`: is the Streaks extension on?
    /// The payload's `settings.streaksEnabled`, which every current server
    /// sends. True when nothing says otherwise: that is a server older than the
    /// field, which only ever had Streaks on (the web's default is off since
    /// 2026-10-10). Off, Reset streak is never offered.
    public var streaksEnabled: Bool

    public init(
        dateStr: String, todayStr: String, timeZone: String, occurrence: Occurrence? = nil,
        streaksEnabled: Bool = true
    ) {
        self.dateStr = dateStr
        self.todayStr = todayStr
        self.timeZone = timeZone
        self.occurrence = occurrence
        self.streaksEnabled = streaksEnabled
    }

    /// The same context from the planner's days.
    public init(
        day: DayString, today: DayString, timeZone: String, occurrence: Occurrence? = nil,
        streaksEnabled: Bool = true
    ) {
        self.init(
            dateStr: day.description, todayStr: today.description, timeZone: timeZone, occurrence: occurrence,
            streaksEnabled: streaksEnabled
        )
    }
}

/// The ids of lib/item-verbs.ts `VerbId` the sheet offers, in `ITEM_VERBS`
/// declaration order, which is the order `eligibleVerbs` answers in. Delete is
/// declared last there, so it stays last here: a verb ported later goes in at
/// its own place, ahead of it, as `resetStreak` did (declared after
/// `braindump`, which isn't ported, and before `leaveProjectBlock` and
/// `delete`).
public enum VerbID: String, Sendable, Hashable, CaseIterable {
    case tick, skip, unskip, pause, resume, nextDay, reschedule, resetStreak, delete
}

// MARK: - Shared predicates

/// lib/item-verbs.ts `isTaskLike`: a task or a custom type, which rides the
/// task pipeline.
public func isTaskLike(_ item: Item) -> Bool {
    return !item.isHabit
}

/// lib/item-verbs.ts `isCancelled`: only a task-like item can be.
public func isCancelled(_ item: Item) -> Bool {
    return !item.isHabit && item.status == "cancelled"
}

/// lib/item-verbs.ts `isDoneOn`: a habit and a recurring item read the date; a
/// one-off compares its status with its type's `doneStatus`.
public func isDoneOn(_ item: Item, on dateStr: String) -> Bool {
    if item.isHabit { return item.completedDates.contains(dateStr) }
    if isRecurring(item.rule) { return item.completedDates.contains(dateStr) }
    return item.status == caps(item.typeName).doneStatus
}

/// lib/item-verbs.ts `isSkippedOn`: skips are per date on every type.
public func isSkippedOn(_ item: Item, on dateStr: String) -> Bool {
    return item.skippedDates.contains(dateStr)
}

/// lib/item-verbs.ts `drawnState`: what drawing the item on `dateStr` says
/// about it there. Nil for a one-off; for a recurring item, what was recorded
/// (done before skipped), else due from today on and merely open before it.
public func drawnState(_ item: Item, on dateStr: String, today todayStr: String) -> Occurrence? {
    guard isRecurring(item.rule) else { return nil }
    if isDoneOn(item, on: dateStr) { return .done }
    if isSkippedOn(item, on: dateStr) { return .skipped }
    return dateStr >= todayStr ? .due : .open
}

/// A non-empty string, or nil: JavaScript's truthiness for the optional text
/// columns these rules test.
private func present(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    return s
}

/// lib/reminders/due.ts `occursOn`: does the item have an occurrence on
/// `dateStr` at all?
/// - recurring and date-anchored (tasks, custom types): from its start date on,
///   the start date itself and then the repeat (`anchoredSeriesOn`); with no
///   start date, never;
/// - recurring and un-anchored (habits): the repeat alone;
/// - one-shot: exactly its own date.
/// `timeZone` is unread, as on the web: `dateStr` is already the user's day.
public func occursOn(_ item: Item, on dateStr: String, timeZone: String) -> Bool {
    let day = toDateOnly(dateStr)
    // The start date's day; nil when there is none (the web's `!startDate`).
    let startDay: String? = present(item.startDate).map { toDateOnly($0) }

    if isRecurring(item.rule) {
        if caps(item.typeName).dateAnchored {
            guard let anchorDay = startDay else { return false }
            // lib/recurrence.ts `anchoredSeriesOn`, on the strings as given.
            let anchor = String(anchorDay.prefix(10))
            if anchor > day { return false }
            if anchor == day { return true }
        }
        guard let date = DayString(day) else { return false }
        return shouldShowOnDate(item.rule, on: date)
    }

    return startDay == day
}

/// lib/item-verbs.ts `occurrenceOn`: `drawnState` for a caller no schedule
/// handed the day to (the item sheet), which first asks whether the item falls
/// on the day at all: a weekday habit opened on a Saturday is `.absent`, not
/// due. Nil for a one-off.
public func occurrenceOn(_ item: Item, on dateStr: String, today todayStr: String, timeZone: String) -> Occurrence? {
    guard isRecurring(item.rule) else { return nil }
    return occursOn(item, on: dateStr, timeZone: timeZone) ? drawnState(item, on: dateStr, today: todayStr) : .absent
}

/// lib/verb-gates.ts `absent`: a recurring item whose caller knows it does not
/// fall on the day.
private func isAbsent(_ item: Item, _ ctx: VerbContext) -> Bool {
    return isRecurring(item.rule) && ctx.occurrence == .absent
}

/// lib/verb-gates.ts `rowDateOf`: the day a dated row is drawn on, for the
/// put-off verbs' gates: a task-like item's own `startDate`, else the acting day.
private func rowDateOf(_ item: Item, _ ctx: VerbContext) -> String {
    if isTaskLike(item), let start = present(item.startDate) { return start }
    return ctx.dateStr
}

/// lib/verb-gates.ts `kindOf`.
private func kindOf(_ item: Item) -> ItemKind {
    return item.isHabit ? .habit : .task
}

/// `isPausedOn(item, ctx.todayStr, ctx.tz)`. A today that isn't a day is no
/// pause, as an unreadable `pausedAt` is none.
private func isPausedToday(_ item: Item, _ ctx: VerbContext) -> Bool {
    guard let today = DayString(ctx.todayStr) else { return false }
    return isPausedOn(item, on: today, timeZone: ctx.timeZone)
}

/// lib/item-verbs.ts `nextDayOf`: where the carry lands, the day after the
/// later of the row's day and today (lib/row-moves.ts `nextDayTarget`).
public func nextDayOf(_ item: Item, _ ctx: VerbContext) -> String {
    return nextDayTarget(rowDateOf(item, ctx), today: ctx.todayStr)
}

// MARK: - The verbs

/// The verb's `eligible`: may it act on `item` in `ctx`?
/// - tick: not cancelled, not absent, and a recurring item's day not skipped
///   (that day's answer is `unskip`);
/// - skip: `isSkippable`, not done or skipped that day, and the occurrence
///   unknown or due (never an absent day, never a past open one);
/// - unskip: skipped that day and not absent;
/// - pause: `isPausable` and not paused today; resume: paused today;
/// - nextDay: task-like, dated, and `canMoveToNextDay` off its day;
/// - reschedule: `canReschedule` with the date left open, so an undated item
///   may, and so may a recurring task (its picked day becomes the series start);
/// - resetStreak: a habit with a streak above 0, while Streaks is on
///   (`ctx.streaksEnabled`);
/// - delete: always. Anything may be deleted, something finished, cancelled,
///   paused or not due included.
public func verbEligible(_ verb: VerbID, _ item: Item, _ ctx: VerbContext) -> Bool {
    switch verb {
    case .tick:
        if isCancelled(item) || isAbsent(item, ctx) { return false }
        if !isRecurring(item.rule) { return true }
        return !isSkippedOn(item, on: ctx.dateStr)
    case .skip:
        return isSkippable(item)
            && !isDoneOn(item, on: ctx.dateStr)
            && !isSkippedOn(item, on: ctx.dateStr)
            && (ctx.occurrence == nil || ctx.occurrence == .due)
    case .unskip:
        return isSkippedOn(item, on: ctx.dateStr) && !isAbsent(item, ctx)
    case .pause:
        return isPausable(item) && !isPausedToday(item, ctx)
    case .resume:
        return isPausedToday(item, ctx)
    case .nextDay:
        return isTaskLike(item) && present(item.startDate) != nil
            && canMoveToNextDay(item, kind: kindOf(item), dateStr: rowDateOf(item, ctx))
    case .reschedule:
        return isTaskLike(item) && canReschedule(item, kind: kindOf(item), dateStr: rowDateOf(item, ctx))
    case .resetStreak:
        return item.isHabit && (item.streak ?? 0) > 0 && ctx.streaksEnabled
    case .delete:
        return true
    }
}

/// The verb's `label`, the web's own words. The sheet shortens some of them
/// (and drops " today" off the acting day); that mapping is the app's.
/// - tick: a one-off "Mark done" / "Mark not done"; a recurring item "Undo
///   today" when done, "Count one (1/3)" for a counted habit, else "Done today";
/// - nextDay: "Move to tomorrow", or "Move to next day" when it lands later;
/// - reschedule: "Reschedule" for a dated task-like item, else "Schedule";
/// - resetStreak: "Reset streak", which the popover's button and its confirm's
///   both say;
/// - delete: "Delete", whatever the type (the confirm names it).
public func verbLabel(_ verb: VerbID, _ item: Item, _ ctx: VerbContext) -> String {
    switch verb {
    case .tick:
        let done = isDoneOn(item, on: ctx.dateStr)
        if !isRecurring(item.rule) { return done ? "Mark not done" : "Mark done" }
        if done { return "Undo today" }
        let target = item.isHabit ? (item.timesPerDay ?? 1) : 1
        if target > 1 {
            let count = item.dailyCounts[ctx.dateStr] ?? 0
            return "Count one (\(count)/\(target))"
        }
        return "Done today"
    case .skip:
        return "Skip today"
    case .unskip:
        return "Unskip today"
    case .pause:
        return "Pause"
    case .resume:
        return "Resume"
    case .nextDay:
        return nextDayLabel(nextDayOf(item, ctx), today: ctx.todayStr)
    case .reschedule:
        return isTaskLike(item) && present(item.startDate) != nil ? "Reschedule" : "Schedule"
    case .resetStreak:
        return "Reset streak"
    case .delete:
        return "Delete"
    }
}

/// The verb's `detail`, when it has one: the carry's landing day, "Sat, Sep 27"
/// (lib/row-moves.ts `formatTargetDay`). Nil for every other verb.
public func verbDetail(_ verb: VerbID, _ item: Item, _ ctx: VerbContext) -> String? {
    switch verb {
    case .nextDay:
        return formatTargetDay(nextDayOf(item, ctx))
    case .tick, .skip, .unskip, .pause, .resume, .reschedule, .resetStreak, .delete:
        return nil
    }
}

/// lib/item-verbs.ts `eligibleVerbs`, over the sheet's verbs: every verb that
/// may act on `item` in `ctx`, in declaration order.
public func eligibleVerbs(_ item: Item, _ ctx: VerbContext) -> [VerbID] {
    return VerbID.allCases.filter { verbEligible($0, item, ctx) }
}
