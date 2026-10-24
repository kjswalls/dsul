import Foundation

// Port of lib/row-moves.ts, the two "get this off today" verbs: where "move
// to tomorrow" lands, what it is called, and which items may take it
// (`canMoveToNextDay`, and Reschedule's looser `canReschedule`), and which may
// go back to the braindump (`canSendToBraindump`, from Week and blocks PR 3),
// plus `addDaysToDateStr` from lib/goals.ts, which the carry lands with. Keep
// in step: a change there without the same change here is drift, and the
// phone offers a carry or a Move to Braindump the web refuses (or lands it on
// another day). Checked against the web by RowMovesFixtureTests
// (tests/fixtures/day/row-moves.json).
//
// Refused, as on the web: a habit or any type without `dateAddressable` (the
// braindump asks `braindumpEligible` instead); a recurring item, whose
// `startDate` is the series anchor (except by Reschedule, where the picked day
// becomes the series start); a task inside a project block; anything not open
// on the day (done or cancelled); and, for the braindump only, a milestone,
// whose start date is its target date. A subtask and a paused item are NOT
// refused here; the sheet asks other gates.
//
// Days stay yyyy-MM-dd strings, compared as strings, as on the web. Where the
// web would throw on a string that isn't a day (`toISOString` of an Invalid
// Date), these answer the string back instead. The milestone ids are the
// caller's (`milestoneItemIds` over the payload's goals, Goals.swift), never
// looked up here.

/// The `itemType` argument the web's carry rules take: which projection the
/// row came from, 'task' (any task-shaped type) or 'habit'.
public enum ItemKind: String, Sendable, Hashable, CaseIterable {
    case task, habit
}

/// lib/goals.ts `addDaysToDateStr`: `2026-08-21` + 3 → `2026-08-24`, in pure
/// calendar terms.
func addDaysToDateStr(_ dateStr: String, _ days: Int) -> String {
    guard let day = DayString(dateStr) else { return dateStr }
    return day.adding(days: days).description
}

/// lib/row-moves.ts `nextDayTarget`: the day after the row's own day, never
/// earlier than today, so an overdue carry never lands in the past.
public func nextDayTarget(_ rowDateStr: String, today todayStr: String) -> String {
    let next = addDaysToDateStr(rowDateStr, 1)
    return next > todayStr ? next : todayStr
}

/// lib/row-moves.ts `nextDayLabel`: "Move to today" or "Move to tomorrow" only
/// when the target is that day, else "Move to next day".
public func nextDayLabel(_ target: String, today todayStr: String) -> String {
    if target == todayStr { return "Move to today" }
    return target == addDaysToDateStr(todayStr, 1) ? "Move to tomorrow" : "Move to next day"
}

/// lib/row-moves.ts `isOpenOn`: not cancelled, and not done on the day (per
/// date for a recurring item, by status for a one-off).
private func isOpenOn(_ item: Item, _ dateStr: String) -> Bool {
    if item.status == "cancelled" { return false }
    if isRecurring(item.rule) { return !item.completedDates.contains(dateStr) }
    return item.status != "completed"
}

/// lib/row-moves.ts `canMoveToNextDay`: may this row be carried off `dateStr`?
/// The registry is asked about `kind` unless the item is a custom type, which
/// answers for its slug (`typeNameOf`), exactly as the web asks it.
public func canMoveToNextDay(_ item: Item, kind: ItemKind, dateStr: String) -> Bool {
    if isRecurring(item.rule) { return false }
    return canReschedule(item, kind: kind, dateStr: dateStr)
}

/// lib/row-moves.ts `canReschedule`: the Reschedule picker's gate, the
/// carry's except that a recurring task may take it too. A picked day becomes
/// the series start, and that day always shows as an occurrence
/// (`anchoredSeriesOn`), so the move lands where the person put it.
public func canReschedule(_ item: Item, kind: ItemKind, dateStr: String) -> Bool {
    guard kind == .task else { return false }
    guard caps(typeNameOf(item, kind)).dateAddressable else { return false }
    if item.inProjectBlock == true { return false }
    return isOpenOn(item, dateStr)
}

/// lib/row-moves.ts `canSendToBraindump`: may this row go back to the
/// braindump (Move to Braindump, `unscheduleTask`) from `dateStr`? A task-like
/// type the registry lets into the braindump (`braindumpEligible`), not
/// recurring, not inside a project block, not one of `milestoneIds` (a
/// milestone's start date is its target date, which unscheduling erases), and
/// open on the day. Whether the braindump already lists the row is not asked
/// here, as on the web: the surfaces ask it (`isTaskScheduled`, DayItems.swift).
public func canSendToBraindump(_ item: Item, kind: ItemKind, dateStr: String, milestoneIds: Set<UUID>) -> Bool {
    guard kind == .task else { return false }
    guard caps(typeNameOf(item, kind)).braindumpEligible else { return false }
    if isRecurring(item.rule) || item.inProjectBlock == true || milestoneIds.contains(item.id) { return false }
    return isOpenOn(item, dateStr)
}

/// lib/row-moves.ts `typeNameOf`: the custom slug for a custom item that has
/// one, else the projection the row came from.
private func typeNameOf(_ item: Item, _ kind: ItemKind) -> String {
    if item.type == "custom", let slug = item.customType, !slug.isEmpty { return slug }
    return kind.rawValue
}

/// lib/row-moves.ts `formatTargetDay`: "Sat, Sep 27", the en-US short weekday,
/// short month and day, read off the string's own parts so no zone can shift
/// it. Spelled by hand so Linux and Darwin agree; a string that isn't a day
/// reads "Invalid Date", as JavaScript's does.
public func formatTargetDay(_ dateStr: String) -> String {
    guard let day = DayString(dateStr) else { return "Invalid Date" }
    return "\(weekdayLabels[day.weekday]), \(monthLabels[day.month - 1]) \(day.day)"
}
