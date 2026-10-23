import Foundation

// Port of lib/paused-shelf.ts: everything set aside, as Organize's Paused page
// lists it and its row counts it, one derivation, so the count on the row is
// always the number of items behind it. Keep in step: a change there without
// the same change here is drift, and the phone's Paused page groups or words
// an entry differently from the web's. Checked against the web by
// PausedShelfFixtureTests (tests/fixtures/organize/paused.json).
//
// Why it exists (programs-routines.md locked decision 10): pausing hides an
// item from the grid, the review, the past-due bar and the braindump, so
// without a browsable home the only way back is remembering its name.
//
// Grouped by the day it comes back, soonest first, the undated last. A routine
// or season is ONE entry carrying its hidden members, keyed on the container
// the item's `suppressionReason` names (the switch that actually brings it
// back). A trip's rest is never an entry: the trip's own line brings it back.
// Resolved at TODAY by the caller, never a browsed date: pausing is dateless.
//
// Dates are fixed English (`formatDay`'s months, a fixed weekday table), so
// the words are the same on every device and the fixture is locale-proof. The
// guilt-free law holds: nothing here is late, it comes back.

/// lib/paused-shelf.ts `PausedEntry`'s `kind`.
public enum PausedEntryKind: String, Sendable, Hashable, CaseIterable {
    case item, routine, season
}

/// lib/paused-shelf.ts `PausedEntry`: one row of the shelf. A paused item on
/// its own, or a routine or season carrying the items it is hiding (in the
/// store's order). `until` is the return day as the reason carries it (a
/// pause's `pausedUntil`, a routine's, a season's start), raw; nil when none.
public enum PausedEntry: Sendable, Hashable, Identifiable {
    case item(Item, until: String?)
    case routine(Routine, until: String?, items: [Item])
    case season(Season, until: String?, items: [Item])

    public var kind: PausedEntryKind {
        switch self {
        case .item: return .item
        case .routine: return .routine
        case .season: return .season
        }
    }

    /// The web's key: `item:<uuid>` (lowercase, as the payload writes it),
    /// `routine:<id>` or `season:<id>`. Unique on the shelf.
    public var key: String {
        switch self {
        case .item(let item, _): return "item:\(item.id.uuidString.lowercased())"
        case .routine(let routine, _, _): return "routine:\(routine.id)"
        case .season(let season, _, _): return "season:\(season.id)"
        }
    }

    public var id: String { key }

    /// The item's own id (lowercase), or the routine's or season's.
    public var subjectId: String {
        switch self {
        case .item(let item, _): return item.id.uuidString.lowercased()
        case .routine(let routine, _, _): return routine.id
        case .season(let season, _, _): return season.id
        }
    }

    public var until: String? {
        switch self {
        case .item(_, let until), .routine(_, let until, _), .season(_, let until, _): return until
        }
    }

    /// The items the entry brings back: the item itself, or the container's
    /// hidden members.
    public var items: [Item] {
        switch self {
        case .item(let item, _): return [item]
        case .routine(_, _, let items), .season(_, _, let items): return items
        }
    }

    fileprivate func appending(_ item: Item) -> PausedEntry {
        switch self {
        case .item: return self
        case .routine(let routine, let until, let items): return .routine(routine, until: until, items: items + [item])
        case .season(let season, let until, let items): return .season(season, until: until, items: items + [item])
        }
    }
}

/// lib/paused-shelf.ts `PausedDay`: the entries that come back on one day.
public struct PausedDay: Sendable, Hashable, Identifiable {
    /// The return day (yyyy-MM-dd), or "" for the undated group.
    public var key: String
    /// The return day, or nil for the undated group.
    public var until: String?
    public var entries: [PausedEntry]

    public init(key: String, until: String?, entries: [PausedEntry]) {
        self.key = key
        self.until = until
        self.entries = entries
    }

    public var id: String { key }
}

/// lib/paused-shelf.ts `PausedShelf`, with the words the list says beside it
/// (`PAUSED_NO_DATE`, `NOTHING_PAUSED`, `PAUSED_WELCOME`).
public struct PausedShelf: Sendable, Hashable {
    public var days: [PausedDay]
    /// Items, not entries: a routine of four counts four, the number the
    /// laptop's moon shows.
    public var count: Int

    public init(days: [PausedDay], count: Int) {
        self.days = days
        self.count = count
    }

    public static let empty = PausedShelf(days: [], count: 0)

    /// `PAUSED_NO_DATE`: the heading over the entries with no day to come back.
    public static let noDate = "No date"
    /// `NOTHING_PAUSED`: the list with nothing set aside.
    public static let nothingPaused = "Nothing is paused."
    /// `PAUSED_WELCOME`: what the list is, said once beside it.
    public static let welcome =
        "Things you've set aside. Nothing here is late: each one comes back on its own day, or whenever you resume it."
}

/// A non-empty string, or nil: JavaScript's truthiness on an optional day.
private func presentDay(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    return s
}

/// lib/paused-shelf.ts `pausedShelf`: everything set aside on `today`.
/// `routines`, `seasons` and `away` are the live ones (the activation
/// context); `suppressed`, when the caller already has today's
/// `inactiveItemIdsOn`, saves the pass.
///
/// - A subtask is never an entry: it travels with its parent.
/// - An item a trip rests is left out (the trip's line brings it back); its
///   own pause still counts, since a pause outranks a trip.
/// - Within a day, containers come first (one row that brings several back
///   reads before the single items), then each in the order the store holds
///   them; days run soonest first, the undated last.
public func pausedShelf(
    _ items: [Item],
    on today: DayString,
    timeZone: String,
    routines: [Routine] = [],
    seasons: [Season] = [],
    away: [AwayPeriod] = [],
    suppressed: Set<UUID>? = nil
) -> PausedShelf {
    let hidden = suppressed ?? inactiveItemIdsOn(
        items: items, date: today, timeZone: timeZone, routines: routines, seasons: seasons, away: away
    )
    if hidden.isEmpty { return .empty }

    // The web's insertion-ordered Map: keys in first-seen order.
    var order: [String] = []
    var entries: [String: PausedEntry] = [:]
    func put(_ key: String, _ entry: PausedEntry) {
        if entries[key] == nil { order.append(key) }
        entries[key] = entry
    }
    var count = 0
    for item in items {
        if !hidden.contains(item.id) { continue }
        if isSubtask(item) { continue }
        let reason = suppressionReason(
            item, on: today, timeZone: timeZone, routines: routines, seasons: seasons, away: away
        )
        if reason?.kind == .away { continue }
        count += 1
        switch reason {
        case .routine(let routine, let until)?:
            let key = "routine:\(routine.id)"
            if let entry = entries[key], entry.kind == .routine {
                put(key, entry.appending(item))
            } else {
                put(key, .routine(routine, until: until, items: [item]))
            }
        case .season(let season, _, let until)?:
            let key = "season:\(season.id)"
            if let entry = entries[key], entry.kind == .season {
                put(key, entry.appending(item))
            } else {
                put(key, .season(season, until: until, items: [item]))
            }
        default:
            // A nil reason can't normally reach here (the set and
            // suppressionReason agree), but listing it as an undated pause
            // keeps the row reachable rather than dropping it.
            put("item:\(item.id.uuidString.lowercased())", .item(item, until: reason?.until))
        }
    }
    if count == 0 { return .empty }

    var dayOrder: [String] = []
    var byDay: [String: [PausedEntry]] = [:]
    for key in order {
        guard let entry = entries[key] else { continue }
        let day = presentDay(entry.until).map(toDateOnly) ?? ""
        if byDay[day] == nil { dayOrder.append(day) }
        byDay[day, default: []].append(entry)
    }
    var days: [PausedDay] = dayOrder.map { key in
        let list = byDay[key] ?? []
        // A stable sort by rank: containers (0) before items (1).
        let sorted = list.filter { $0.kind != .item } + list.filter { $0.kind == .item }
        return PausedDay(key: key, until: key.isEmpty ? nil : key, entries: sorted)
    }
    days.sort { a, b in
        if a.key == b.key { return false }
        if a.key.isEmpty { return false }
        if b.key.isEmpty { return true }
        return a.key < b.key
    }
    return PausedShelf(days: days, count: count)
}

/// lib/paused-shelf.ts `pausedNote`: the Paused row's second line, "5 · Gym
/// back Fri", or just "5" when nothing set aside has a day to come back. Nil
/// with nothing paused. It names the soonest return only.
public func pausedNote(_ shelf: PausedShelf, today: DayString) -> String? {
    if shelf.count == 0 { return nil }
    guard let next = shelf.days.first(where: { presentDay($0.until) != nil }), let until = next.until,
          let first = next.entries.first
    else { return String(shelf.count) }
    return "\(shelf.count) \u{00B7} \(pausedEntryName(first)) back \(backWhen(until, today: today))"
}

/// "tomorrow", "Fri" within the week, "Nov 12" past it.
private func backWhen(_ day: String, today: DayString) -> String {
    guard let diff = daysFrom(today, day) else { return formatDay(day) }
    if diff <= 1 { return "tomorrow" }
    if diff < 7, let weekday = weekdayShort(day) { return weekday }
    return formatDay(day)
}

/// Whole calendar days from `today` to `day` (yyyy-MM-dd, its numbers as
/// `Date.UTC` reads them), or nil where the web's arithmetic is NaN.
private func daysFrom(_ today: DayString, _ day: String) -> Int? {
    guard let number = utcDayNumber(day) else { return nil }
    return number - daysFromCivil(today.year, today.month, today.day)
}

/// `day.split('-').map(Number)` into `Date.UTC`, in whole days since
/// 1970-01-01, or nil for a string that is not three numbers with a real
/// month. An overlong day rolls into the next month, as `Date.UTC` does.
private func utcDayNumber(_ day: String) -> Int? {
    let parts = day.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count >= 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
          (1...12).contains(m)
    else { return nil }
    return daysFromCivil(y, m, d)
}

/// The day's short weekday in fixed English (`WEEKDAYS`, Cadence.swift's
/// `weekdayLabels`, as `formatDay`'s months are), or nil for an unreadable day.
private func weekdayShort(_ day: String) -> String? {
    guard let number = utcDayNumber(day) else { return nil }
    // 1970-01-01 was a Thursday (4).
    return weekdayLabels[floorMod(number + 4, 7)]
}

/// lib/paused-shelf.ts `returnDayLabel`: a return day's heading on the Paused
/// list, said the way a calendar would: "Tomorrow" when it is exactly one day
/// on, else "Fri, Oct 30" (today itself reads that way too). A day the web
/// cannot read keeps `formatDay`'s answer alone.
public func returnDayLabel(_ day: String, today: DayString) -> String {
    if daysFrom(today, day) == 1 { return "Tomorrow" }
    guard let weekday = weekdayShort(day) else { return formatDay(day) }
    return "\(weekday), \(formatDay(day))"
}

/// lib/paused-shelf.ts `pausedDayLabel`: a group's heading, its return day's
/// label or `PausedShelf.noDate`.
public func pausedDayLabel(_ day: PausedDay, today: DayString) -> String {
    guard let until = presentDay(day.until) else { return PausedShelf.noDate }
    return returnDayLabel(until, today: today)
}

/// lib/paused-shelf.ts `entryKindLine`: what an entry is, under its name.
/// "Habit" (the item's type label; pass the payload's `itemTypes` as
/// `labels` so a custom type reads as the user named it, as the web's
/// hydrated registry does), "Routine · 4 habits", "Season · 3 items". A
/// container says "habits" only when every member it is hiding is one.
public func entryKindLine(_ entry: PausedEntry, labels: [String: ItemTypeLabel] = [:]) -> String {
    switch entry {
    case .item(let item, _):
        return caps(item.typeName, labels: labels).label
    case .routine(_, _, let items), .season(_, _, let items):
        let n = items.count
        let allHabits = items.allSatisfy { $0.type == "habit" }
        let noun = allHabits ? (n == 1 ? "habit" : "habits") : (n == 1 ? "item" : "items")
        return "\(entry.kind == .routine ? ContainerWords.routine : ContainerWords.season) \u{00B7} \(n) \(noun)"
    }
}

/// lib/paused-shelf.ts `pausedStateLine`: an entry's state line, the long form
/// of why it is away, as a sentence. "Paused until Oct 30.", "Hidden with your
/// Morning routine. It stays set aside until you resume it." Asked of the
/// entry's first item, so it never disagrees with what the grid would say.
/// Asked with the routines and seasons and NO trips, as the web's detail pane
/// asks it (a trip's rest is never an entry), so this takes no trips.
public func pausedStateLine(
    _ entry: PausedEntry,
    on today: DayString,
    timeZone: String,
    routines: [Routine] = [],
    seasons: [Season] = []
) -> String {
    let reason = entry.items.first.flatMap {
        suppressionReason($0, on: today, timeZone: timeZone, routines: routines, seasons: seasons)
    }
    let line = reason.map { suppressionLabel($0, long: true) } ?? "Paused"
    return line + (presentDay(entry.until) != nil ? "." : ". It stays set aside until you resume it.")
}

/// lib/paused-shelf.ts `pausedEntryName`: what a paused entry is called on its
/// row and on the Paused row's line.
public func pausedEntryName(_ entry: PausedEntry) -> String {
    switch entry {
    case .item(let item, _): return item.title
    case .routine(let routine, _, _): return routine.name
    case .season(let season, _, _): return season.name
    }
}

/// lib/paused-shelf.ts `backOn`: what comes back ON `day`. Set aside the day
/// before, live on the day, and the reason named this very day as its return.
/// A trip's return is the trip's own line, so it is left out. Containers are
/// named once, like the shelf names them, in the store's order.
public func backOn(
    _ items: [Item],
    on day: DayString,
    timeZone: String,
    routines: [Routine] = [],
    seasons: [Season] = [],
    away: [AwayPeriod] = []
) -> [String] {
    let before = day.adding(days: -1)
    let hiddenBefore = inactiveItemIdsOn(
        items: items, date: before, timeZone: timeZone, routines: routines, seasons: seasons, away: away
    )
    if hiddenBefore.isEmpty { return [] }

    var names: [String] = []
    var seen = Set<String>()
    for item in items {
        if !hiddenBefore.contains(item.id) { continue }
        if isSubtask(item) { continue }
        guard let reason = suppressionReason(
            item, on: before, timeZone: timeZone, routines: routines, seasons: seasons, away: away
        ), reason.kind != .away, let until = presentDay(reason.until), toDateOnly(until) == day.description
        else { continue }
        if suppressionReason(item, on: day, timeZone: timeZone, routines: routines, seasons: seasons, away: away) != nil {
            continue
        }
        let key: String
        let name: String
        switch reason {
        case .routine(let routine, _):
            key = "routine:\(routine.id)"
            name = routine.name
        case .season(let season, _, _):
            key = "season:\(season.id)"
            name = season.name
        default:
            key = "item:\(item.id.uuidString.lowercased())"
            name = item.title
        }
        if seen.contains(key) { continue }
        seen.insert(key)
        names.append(name)
    }
    return names
}
