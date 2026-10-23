import DsulCore
import Foundation

// What the footer's pages show and say (design §6.3, O5 and O14): Paused, a
// paused routine's or season's detail, Item types, and the Trash's rows,
// worked out apart from the views so the hosted tests pin them
// (ShelfPageTests), as ContainerPageModel does for a container's page.
// Foundation only: the shim compiles it on Linux.
//
// Every rule is asked of DsulCore, never re-derived:
// - the shelf is lib/paused-shelf.ts (`pausedShelf`, PausedShelf.swift), asked
//   at TODAY with the trips (pausing is dateless), grouped by the day each
//   entry comes back (`pausedDayLabel`), each entry worded by `entryKindLine`
//   with the user's own type names, and a container's detail by
//   `pausedStateLine`, asked with NO trips as the web's detail asks it;
// - a custom type's count is the live items whose `typeName` is its slug (a
//   custom item arrives as `"type":"custom","customType":"book"`, so `type`
//   alone would count none), the web's `countTypeItems`;
// - a Trash row's words are lib/organize-copy.ts (`trashRowMeta`, OrganizeCopy
//   .swift) and its glyph the web's `CategoryIcon` (ContainerLook.swift).
//
// Paused rides no switch: pausing is not gated, so its way back may not be
// (console-rail.tsx). An item's Resume is the planner's own (`resume(_:)`,
// the item `pause` write with `paused: false`), offered where the sheet would
// offer it. From O8a a routine's or a season's Resume (its detail's "Resume
// now" or "Turn on now") is the planner's `turnOn`, the web's `setGateOn`,
// offered wherever the server takes that write, whatever the switches say
// (`canResume`). The guilt-free law: a date here is a return, never an age,
// and nothing is late.

/// The Paused page: the welcome line, then the shelf by return day.
struct PausedPage: Hashable, Sendable {
    /// `PausedShelf.welcome`: what the list is, said once over it.
    let welcome: String
    /// Soonest return first, the undated last.
    let groups: [PausedGroup]
    /// Items, not entries: what the footer's row counts.
    let count: Int
    /// `PausedShelf.nothingPaused` with nothing set aside; nil otherwise.
    let empty: String?
}

/// The entries that come back on one day, under its heading ("Tomorrow",
/// "Fri, Oct 30", "No date").
struct PausedGroup: Identifiable, Hashable, Sendable {
    let key: String
    let title: String
    let rows: [PausedRow]

    var id: String { key }
}

/// What sits where a paused row's tick would: an item's outline (round for a
/// habit, as on the grid), or a container's own glyph in its colour.
enum PausedMark: Hashable, Sendable {
    case item(habit: Bool)
    case container(symbol: String, accent: ContainerAccent)
}

/// One paused thing: its mark, its name, what it is, and (for anything the
/// server will resume) Resume.
struct PausedRow: Identifiable, Hashable, Sendable {
    /// The shelf's key: "item:<uuid>", "routine:<id>", "season:<id>".
    let key: String
    let kind: PausedEntryKind
    /// `pausedEntryName`.
    let name: String
    /// `entryKindLine`: "Habit", "Routine · 4 habits".
    let kindLine: String
    let mark: PausedMark
    /// The item's id, for an item's row: a tap opens its sheet. Nil for a
    /// routine or season, whose tap pushes its paused detail.
    let itemId: UUID?
    /// The routine or season, for its row: what its Resume turns on
    /// (`SamplePlanner.turnOn`). Nil for an item.
    let container: ContainerRef?
    /// Resume shows: an item the sheet would offer Resume on, or a routine or
    /// season whose way back the server takes (`ShelfPageModel.canResume`).
    let resumable: Bool
    /// The row as one element: "Read, Habit", "Morning routine, Routine, 4
    /// habits".
    let spokenLabel: String

    var id: String { key }

    /// Where a tap goes: a routine's or season's paused detail; nil for an
    /// item, which opens its sheet.
    var route: OrganizeRoute? {
        return itemId == nil ? .pausedEntry(key) : nil
    }

    /// Resume's name to VoiceOver, the web's `aria-label`: "Resume Read".
    var resumeLabel: String { "Resume " + name }
}

/// A paused routine's or season's detail, the web's paused detail: its
/// header, why it is away, what comes back with it, and (with Organize on)
/// the way to its own page.
struct PausedEntryPage: OrganizePageModel {
    let key: String
    let header: PageHeader
    /// `entryKindLine`: "Routine · 4 habits".
    let kindLine: String
    /// `pausedStateLine`: "Paused until Oct 30.", "Paused. It stays set aside
    /// until you resume it."
    let stateLine: String
    /// "Comes back with it": the members it is hiding, each opening its
    /// sheet. None ticks: nothing here is on today.
    let members: [MemberRow]
    /// "Open in Routines" or "Open in Seasons", pushing the container's page;
    /// nil with Organize off, as the web offers it only when that section is
    /// on the rail.
    let openIn: OpenIn?
    /// "Resume now", or "Turn on now" for a season (O8a), whatever the
    /// switches say; nil when the server doesn't take that write.
    let resume: Resume?

    struct OpenIn: Hashable, Sendable {
        let title: String
        let route: OrganizeRoute
    }

    struct Resume: Hashable, Sendable {
        let title: String
        /// What it turns on (`SamplePlanner.turnOn`).
        let ref: ContainerRef
    }
}

/// The Item types page: the user's own types, read-only.
struct ItemTypesPage: Hashable, Sendable {
    let rows: [ItemTypeRow]
    /// Why there are no rows: "No custom types yet. You make them on the
    /// web.", or that the server couldn't say; nil with rows.
    let empty: String?
}

/// One custom type: its tile, its name, and how many items are of it.
struct ItemTypeRow: Identifiable, Hashable, Sendable {
    /// The slug, as `items.type` stores it.
    let slug: String
    /// The user's noun ("Book to read").
    let title: String
    /// "2 items".
    let subtitle: String
    let symbol: String
    /// The slug's ramp step, as the web hashes a custom type's accent.
    let accent: ContainerAccent
    /// "Book to read, item type, 2 items".
    let spokenLabel: String

    var id: String { slug }
}

/// One row of the bin as the Trash page draws it.
struct TrashListRow: Identifiable, Hashable, Sendable {
    let row: TrashRow
    /// The glyph the web's `CategoryIcon` draws for it.
    let symbol: String
    /// Its stored colour, else its name's ramp step: the glyph only.
    let accent: ContainerAccent
    /// `trashRowMeta`: "Project · 3 items refile · 3d ago".
    let meta: String
    /// The row as one element: "Work, Project, 3 items refile, 3d ago".
    let spokenLabel: String
    /// Restore's name to VoiceOver, the web's `aria-label`: "Restore project
    /// Work", so two rows of one name are told apart by their kind.
    let restoreLabel: String

    var id: String { row.key }
}

enum ShelfPageModel {
    static let pausedTitle = "Paused"
    static let itemTypesTitle = "Item types"
    static let trashTitle = "Trash"
    /// The paused detail's members heading (paused.tsx).
    static let comesBackTitle = "Comes back with it"
    /// The Item types page with none (the web's first sentence, labels.tsx,
    /// and the phone's way to make one).
    static let noCustomTypes = "No custom types yet. You make them on the web."
    /// The server couldn't read the user's types (labels.tsx's words for an
    /// account without them).
    static let typesUnavailable = "Custom types aren\u{2019}t available on this account yet."
    /// Restore's word, beside the spinner while one is out.
    static let restore = "Restore"
    /// What VoiceOver hears on Restore while one is out (the button stays,
    /// disabled, where the focus is).
    static let restoring = "Restoring"
    /// Resume's word on a paused row.
    static let resume = "Resume"
    /// The paused detail's way back (paused.tsx): a season's, and anything
    /// else's.
    static let turnOnNow = "Turn on now"
    static let resumeNow = "Resume now"
    /// The Trash page's Retry after a failed read.
    static let retry = "Try again"

    // MARK: Paused (O5)

    /// Everything set aside on today, the trips counted (a trip's rest is
    /// never an entry).
    static func shelf(_ s: OrganizeSnapshot) -> PausedShelf {
        return pausedShelf(s.items, on: s.today, timeZone: s.timeZone, routines: s.routines, seasons: s.seasons,
                           away: s.away)
    }

    /// The Paused page. `canResume` is the planner's own gate for an item's
    /// Resume (`offers(.resume, …)` on today); a routine's or a season's is
    /// `canResume(_:_:)`.
    static func pausedPage(_ s: OrganizeSnapshot, canResume: (Item) -> Bool) -> PausedPage {
        let shelf = Self.shelf(s)
        let groups = shelf.days.map { day in
            PausedGroup(key: day.key, title: pausedDayLabel(day, today: s.today),
                        rows: day.entries.map { pausedRow($0, s, canResume: canResume) })
        }
        return PausedPage(welcome: PausedShelf.welcome, groups: groups, count: shelf.count,
                          empty: shelf.count == 0 ? PausedShelf.nothingPaused : nil)
    }

    static func pausedRow(_ entry: PausedEntry, _ s: OrganizeSnapshot, canResume: (Item) -> Bool) -> PausedRow {
        let name = pausedEntryName(entry)
        let kindLine = entryKindLine(entry, labels: s.typeLabels)
        let spoken = [name, OrganizeModel.spokenSegment(kindLine)].joined(separator: ", ")
        switch entry {
        case .item(let item, _):
            return PausedRow(key: entry.key, kind: entry.kind, name: name, kindLine: kindLine,
                             mark: .item(habit: item.isHabit), itemId: item.id, container: nil,
                             resumable: canResume(item), spokenLabel: spoken)
        case .routine(let routine, _, _):
            return PausedRow(key: entry.key, kind: entry.kind, name: name, kindLine: kindLine,
                             mark: containerMark(.routine, name: routine.name, glyph: routine.icon,
                                                 color: routine.color),
                             itemId: nil, container: ContainerRef(kind: .routine, id: routine.id),
                             resumable: Self.canResume(.routine(routine), s), spokenLabel: spoken)
        case .season(let season, _, _):
            return PausedRow(key: entry.key, kind: entry.kind, name: name, kindLine: kindLine,
                             mark: containerMark(.season, name: season.name, glyph: season.icon,
                                                 color: season.color),
                             itemId: nil, container: ContainerRef(kind: .season, id: season.id),
                             resumable: Self.canResume(.season(season), s), spokenLabel: spoken)
        }
    }

    /// May Paused bring `container` back (O8a)? Turning it on must change
    /// something (DsulCore `gateSwitchIntent`, lib/gate-toggle.ts
    /// `setGateOn`'s decision: a paused routine resumes, a season not live
    /// today gets `seasonStateForSwitch`), which it always does for an entry
    /// on today's shelf, and the server must take that write. Never the
    /// switches: Paused is the one way back the web keeps with Organize off
    /// (paused.tsx, console-rail.tsx), and the route takes the write either
    /// way.
    static func canResume(_ container: ContainerSnapshot, _ s: OrganizeSnapshot) -> Bool {
        guard let intent = gateSwitchIntent(container, on: true, today: s.today, timeZone: s.timeZone) else {
            return false
        }
        return s.containerTakes.takes(intent, on: container.kind)
    }

    private static func containerMark(_ kind: OrganizeKind, name: String, glyph: String?,
                                      color: String?) -> PausedMark {
        return .container(symbol: containerSymbol(glyph: glyph, name: name, kind: kind),
                          accent: containerAccent(color, name: name))
    }

    /// The entry `key` names on today's shelf, or nil once it is not there
    /// (resumed, come back on its day, deleted).
    static func pausedEntry(_ key: String, _ s: OrganizeSnapshot) -> PausedEntry? {
        for day in shelf(s).days {
            if let entry = day.entries.first(where: { $0.key == key }) { return entry }
        }
        return nil
    }

    /// A paused routine's or season's detail, or nil once it is off the
    /// shelf, when the page pops itself. An item's key answers nil too: its
    /// row opens its sheet, never this page.
    static func pausedEntryPage(_ key: String, _ s: OrganizeSnapshot) -> PageContent<PausedEntryPage>? {
        guard let entry = pausedEntry(key, s) else { return nil }
        let header: PageHeader
        let openIn: PausedEntryPage.OpenIn?
        let resume: PausedEntryPage.Resume?
        let organizeOn = s.settings.organizeEnabled
        switch entry {
        case .item:
            return nil
        case .routine(let routine, _, _):
            header = ContainerPageModel.header(.routine, name: routine.name, glyph: routine.icon,
                                               color: routine.color)
            openIn = organizeOn
                ? PausedEntryPage.OpenIn(title: "Open in " + ContainerWords.routines,
                                         route: .container(.routine, id: routine.id))
                : nil
            resume = canResume(.routine(routine), s)
                ? PausedEntryPage.Resume(title: resumeNow, ref: ContainerRef(kind: .routine, id: routine.id))
                : nil
        case .season(let season, _, _):
            header = ContainerPageModel.header(.season, name: season.name, glyph: season.icon, color: season.color)
            openIn = organizeOn
                ? PausedEntryPage.OpenIn(title: "Open in " + ContainerWords.seasons,
                                         route: .container(.season, id: season.id))
                : nil
            resume = canResume(.season(season), s)
                ? PausedEntryPage.Resume(title: turnOnNow, ref: ContainerRef(kind: .season, id: season.id))
                : nil
        }
        let state = pausedStateLine(entry, on: s.today, timeZone: s.timeZone, routines: s.routines,
                                    seasons: s.seasons)
        return .page(PausedEntryPage(
            key: key,
            header: header,
            kindLine: entryKindLine(entry, labels: s.typeLabels),
            stateLine: state,
            members: entry.items.map { ContainerPageModel.memberRow($0, s, onToday: [:]) },
            openIn: openIn,
            resume: resume
        ))
    }

    // MARK: Item types (O5)

    /// The Item types page: the types in the server's order, or why there
    /// are none. Nil while Organize is off: the web hides its types section
    /// then, so the footer's row hides and a page already open pops
    /// (`isGone`), as a paused entry's detail does once it leaves the shelf.
    static func itemTypesPage(_ s: OrganizeSnapshot) -> ItemTypesPage? {
        guard s.settings.organizeEnabled else { return nil }
        guard let types = s.itemTypes else {
            return ItemTypesPage(rows: [], empty: typesUnavailable)
        }
        let rows = types.map { itemTypeRow($0, s) }
        return ItemTypesPage(rows: rows, empty: rows.isEmpty ? noCustomTypes : nil)
    }

    /// One type: the user's noun, and the live items of it.
    static func itemTypeRow(_ type: ItemTypeLabel, _ s: OrganizeSnapshot) -> ItemTypeRow {
        let n = typeCount(type.name, s.items)
        let title = typeLabel(type.name, labels: s.typeLabels)
        let subtitle = OrganizeModel.counted(n, "item", "items")
        return ItemTypeRow(slug: type.name, title: title, subtitle: subtitle, symbol: "square.on.circle",
                           accent: containerAccent(nil, name: type.name),
                           spokenLabel: "\(title), item type, \(subtitle)")
    }

    /// The web's `countTypeItems`: the live items of the type `slug`, asked
    /// by `typeName`, so a custom item (`type` "custom") counts.
    static func typeCount(_ slug: String, _ items: [Item]) -> Int {
        return items.filter { $0.typeName == slug }.count
    }

    // MARK: Trash (O14)

    /// A row of the bin, worded at `now`.
    static func trashRow(_ row: TrashRow, now: Date) -> TrashListRow {
        let symbol: String
        if let kind = row.kind.container {
            symbol = containerSymbol(glyph: row.icon, name: row.name, kind: kind)
        } else {
            symbol = ContainerLook.lucideToSymbol[resolveCategoryIconName(row.icon, row.name)] ?? "circle"
        }
        let meta = OrganizeCopy.trashRowMeta(row, now: now)
        return TrashListRow(row: row, symbol: symbol, accent: containerAccent(row.color, name: row.name), meta: meta,
                            spokenLabel: row.name + ", " + OrganizeModel.spokenSegment(meta),
                            restoreLabel: "Restore \(jsLowercased(row.kind.label)) \(row.name)")
    }
}

extension SamplePlanner {
    /// The Paused page now, an item's Resume asked of the sheet's own gate
    /// on today.
    var pausedPage: PausedPage {
        return ShelfPageModel.pausedPage(organizeSnapshot) { [self] item in
            offers(.resume, item, verbContext(for: item, on: today))
        }
    }

    func pausedEntryPage(_ key: String) -> PageContent<PausedEntryPage>? {
        return ShelfPageModel.pausedEntryPage(key, organizeSnapshot)
    }

    /// Nil while Organize is off: the page is gone.
    var itemTypesPage: ItemTypesPage? {
        return ShelfPageModel.itemTypesPage(organizeSnapshot)
    }
}
