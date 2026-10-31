import Foundation

// lib/ghost-rows.ts, ported: which items show as ghosts at the top of Today,
// and in what order (memory/plans/ghost-rows.md). A ghost is a VIEW over
// `selectOverdue` (Overdue.swift): nothing here writes, and nothing is written
// until the person picks a verb. Goal milestones never ghost, because a
// milestone's date is its target and the fold's sweeping verbs would walk or
// erase it (lib/goals.ts `milestoneItemIds`, Goals.swift).

/// lib/ghost-rows.ts `GHOST_PILE_THRESHOLD`: past this many ghosts the fold
/// starts collapsed, with its bulk verbs shown.
public let ghostPileThreshold = 5

/// lib/ghost-rows.ts `selectGhostRows`: the ghosts for `today`, newest first
/// (yesterday's at the top, the oldest at the bottom). Ties keep the order
/// `selectOverdue` gave them, which is store order.
///
/// - Parameters:
///   - inactiveIds: ids set aside today (`inactiveItemIdsOn`), required.
///   - milestoneIds: every goal milestone's item id (`milestoneItemIds` over
///     the RAW goals, never a display list).
public func selectGhostRows(
    _ items: [Item],
    today: String,
    inactiveIds: Set<UUID>,
    milestoneIds: Set<UUID>
) -> [Item] {
    let kept: [Item] = selectOverdue(items, today: today, inactiveIds: inactiveIds)
        .filter { !milestoneIds.contains($0.id) }
    let days: [String] = kept.map { toDateOnly($0.startDate ?? "") }
    let order: [Int] = kept.indices.sorted { a, b in
        days[a] == days[b] ? a < b : days[a] > days[b]
    }
    return order.map { kept[$0] }
}

/// lib/ghost-rows.ts `ghostFoldStartsCollapsed`.
public func ghostFoldStartsCollapsed(_ count: Int) -> Bool {
    count > ghostPileThreshold
}

private let shortWeekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/// lib/ghost-rows.ts `ghostWeekday`: "Thu" for a yyyy-MM-dd, read off the
/// string's own parts so no zone shifts it. Empty for a string that names no
/// day (the web's formatter throws there; no ghost ever carries one).
public func ghostWeekday(_ dateStr: String) -> String {
    guard let day = DayString(toDateOnly(dateStr)) else { return "" }
    return shortWeekdays[day.weekday]
}

/// lib/planner-store.ts `letGoItems`' gate for one item, the ghost rows' Let it
/// go: pending, not recurring, and a type that has a cancelled status (a habit
/// has none). The server asks the same (lib/item-intents.ts `applyLetGo`).
public func canLetGo(_ item: Item) -> Bool {
    return item.status == "pending" && !isRecurring(item.rule) && caps(item.typeName).cancellable
}

/// Let it go's optimistic step: `{status: 'cancelled'}`, nothing else, so the
/// item stays in history. An item `canLetGo` refuses comes back unchanged.
public func lettingGo(_ item: Item) -> Item {
    guard canLetGo(item) else { return item }
    var after = item
    after.status = "cancelled"
    return after
}

/// components/planner/ghost-fold.tsx `ghostDay`: the ghost's own day, bare,
/// since a legacy row may carry a full ISO start date.
public func ghostDay(_ item: Item) -> String {
    return toDateOnly(item.startDate ?? "")
}

/// The five things a ghost row can be told (memory/plans/ghost-rows.md,
/// "Verbs"), in the sheet's order.
public enum GhostVerb: String, Sendable, Hashable, CaseIterable {
    /// Keep for today: `moveTaskToDate(id, today)`.
    case keep
    /// Move to tomorrow: `moveTaskToDate(id, tomorrow)`, today's tomorrow.
    case tomorrow
    /// Reschedule: `moveTaskToDate(id, picked)`.
    case reschedule
    /// Send to sidebar: `unscheduleTask(id)`.
    case sidebar
    /// Let it go: `letGoItems([id])`, kept in history.
    case letGo
}

/// ghost-fold.tsx's gates, each asked on the ghost's own day (`ghostDay`) so a
/// control never no-ops: Keep and Reschedule are lib/row-moves.ts
/// `canReschedule`, Move to tomorrow `canMoveToNextDay`, Send to sidebar
/// `canSendToBraindump`, and Let it go the type's cancelled status
/// (`canLetGo`, which also asks pending and not recurring, as `letGoItems`
/// filters). Whether the server takes the write is the caller's to ask.
public func ghostVerbAllowed(_ verb: GhostVerb, _ item: Item, milestoneIds: Set<UUID>) -> Bool {
    let day = ghostDay(item)
    switch verb {
    case .keep, .reschedule: return canReschedule(item, kind: .task, dateStr: day)
    case .tomorrow: return canMoveToNextDay(item, kind: .task, dateStr: day)
    case .sidebar: return canSendToBraindump(item, kind: .task, dateStr: day, milestoneIds: milestoneIds)
    case .letGo: return canLetGo(item)
    }
}
