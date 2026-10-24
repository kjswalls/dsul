import DsulCore
import Foundation

// What the Organize tab lists and says, worked out apart from the views so the
// hosted tests can pin it (OrganizeTests), as ItemSheetModel does for the item
// sheet. Foundation only: the shim compiles it on Linux.
//
// The rules are the web's, asked of DsulCore: which containers show is the
// console's gating (components/planner/organize/console-rail.tsx; the two
// switches are display gates, `PlannerSettings.organizeEnabled` and
// `.goalsEnabled`); a row's state pill is lib/collections.ts
// (`routinePillLabel`, `seasonPillLabel`, Collections.swift), its counts
// `countLive` and `containerMemberIds` (ContainerSchedule.swift), a goal's
// progress lib/goals.ts (`goalProgress`, `progressLabel`,
// `sortGoalsForDisplay`, Goals.swift), the usual time `formatCueTime`
// (Cadence.swift, in the payload's 12/24-hour format), and the tile's colour
// and glyph `containerAccent` and `containerSymbol` (ContainerLook.swift). The
// container nouns are `ContainerWords` (lib/container-registry.ts
// `CONTAINER_KINDS`), never spelled here, so the provisional project noun stays
// one edit.
//
// Read-only. From O2 and O3 every row opens its container's page
// (`OrganizeRoute`, ContainerPageModel.swift says what each page shows), and a
// routine's row carries the web's "2/3 today". From O4 the list opens with
// the summary cards (`summary`: THIS WEEK, lib/organize.ts `organizeWeek`, and
// NEXT MILESTONE, `nextMilestoneAcross`, Organize.swift), and from O5 and O14
// it ends with the footer (`footer`: Item types, Paused and Trash), whose
// pages ShelfPageModel.swift works out.

/// Where a tap on Organize goes: a container's page, or one of the footer's.
/// Foundation only, so the hosted tests pin where every row leads; the stack's
/// path holds these (OrganizeView). A container's page is named by its kind
/// and id, the two halves of the DsulCore `ContainerRef` its writes take;
/// the id is never parsed as a UUID (the sample's are not).
enum OrganizeRoute: Hashable, Sendable {
    case container(OrganizeKind, id: String)
    /// The Paused page (O5): everything set aside, by the day it comes back.
    case paused
    /// A paused routine or season, the web's paused detail ("Comes back with
    /// it"), by its shelf key (`PausedEntry.key`, "routine:<id>"), never the
    /// container's page, which Organize off would blank.
    case pausedEntry(String)
    /// The Item types page (O5): the user's own types, read-only.
    case itemTypes
    /// The Trash page (O14): the bin, and Restore.
    case trash
}

/// One container on the list: its tile, its words, and what VoiceOver says.
struct OrganizeRow: Identifiable, Hashable, Sendable {
    let kind: OrganizeKind
    /// The container's own id: a routine's, season's, goal's or project's
    /// (a string, never parsed as a UUID: the sample's are not).
    let containerId: String
    let title: String
    /// The segments under the title, joined with " · "; nil when there are none.
    let subtitle: String?
    /// The SF Symbol drawn on the tile (`containerSymbol`).
    let symbol: String
    /// The tile's colour (`containerAccent`): the tile and its glyph only,
    /// never text.
    let accent: ContainerAccent
    /// The value at the row's trailing edge: a live routine's "2/3 today"
    /// (the web's `todayCount`), a holder's "on" or "off until Nov 1" on a
    /// routine's page; nil otherwise.
    let trailing: String?
    /// The whole row as one accessibility element: title, kind, then the
    /// subtitle's segments, then the trailing value in words.
    let spokenLabel: String

    var id: String { kind.rawValue + "/" + containerId }

    /// The page the row opens.
    var route: OrganizeRoute { .container(kind, id: containerId) }

    /// What a tap does, as VoiceOver hints it: "Opens the routine", with no
    /// full stop, as the house hints have none.
    var hint: String { "Opens the " + jsLowercased(OrganizeModel.noun(kind)) }
}

/// One section of the list, with its header's count.
struct OrganizeSection: Identifiable, Hashable, Sendable {
    enum Kind: String, Hashable, Sendable {
        case routines, seasons, goals, ended, projects
    }

    let kind: Kind
    /// "Routines", "Seasons", "Goals", "Ended", "Projects".
    let title: String
    /// The header's trailing count: the row count, or "N on" for Seasons.
    let count: String
    /// The header as VoiceOver reads it: "Seasons, 1 on".
    let spokenLabel: String
    let rows: [OrganizeRow]

    var id: Kind { kind }
}

/// A quiet row that says why the list is short: "Nothing here yet." or
/// "Organize is switched off."
struct OrganizeNote: Hashable, Sendable {
    let title: String
    let detail: String?

    var spokenLabel: String {
        guard let detail else { return title }
        return title + " " + detail
    }
}

/// What the Organize tab shows.
enum OrganizeContent: Hashable, Sendable {
    /// Signed in, before the first fetch lands: a spinner. Never "Nothing
    /// here yet.", which would be a guess.
    case loading
    /// Signed in, the first fetch failed: why, and Try again.
    case failed(String)
    /// The sections in order (Routines, Seasons, Goals, Ended, Projects; an
    /// empty one is left out), then "Nothing here yet." when every kind the
    /// switches allow is empty, then the switched-off note while Organize is
    /// off.
    case list(sections: [OrganizeSection], nothingYet: OrganizeNote?, switchedOff: OrganizeNote?)
}

/// Everything the list reads, so a test can hand it any account.
struct OrganizeSnapshot: Sendable {
    var hasLoaded: Bool = true
    var loadError: String? = nil
    var settings: PlannerSettings = PlannerSettings()
    var today: DayString
    /// The zone the day is read in (`SamplePlanner.timeZoneID`).
    var timeZone: String
    /// Every live item, braindump and subtasks included.
    var items: [Item] = []
    var routines: [Routine] = []
    var seasons: [Season] = []
    /// Nil is unknown (before the first fetch, or a server that couldn't read
    /// them): Goals hides, and is not counted as empty.
    var goals: [Goal]? = nil
    var projects: [Project] = []
    /// The user's trips (`SamplePlanner.awayPeriods`): a trip hides on the
    /// pages what it hides on the grid.
    var away: [AwayPeriod] = []
    /// The user's own item types by slug (`SamplePlanner.typeLabels`): a
    /// goal's Supporting work heads a custom type with its own plural.
    var typeLabels: [String: ItemTypeLabel] = [:]
    /// The same types in the server's order (`SamplePlanner.itemTypes`), for
    /// the Item types row and page. Nil when the server couldn't read them
    /// (or before the first fetch): the row shows no count and the page says
    /// so, never "No custom types yet."
    var itemTypes: [ItemTypeLabel]? = []
    /// Signed in, against a server that takes both Trash routes
    /// (`SamplePlanner.offersTrash`): the footer's Trash row shows. The
    /// sample has no server bin, so it never does.
    var trashOffered: Bool = false
    /// The container writes the server takes (`SamplePlanner.containerTakes`,
    /// O8a): every one for the sample, the payload's `containerWrites` signed
    /// in, and none from a server older than the routes. None by default, so
    /// a snapshot built without it offers no editor and no Resume.
    var containerTakes: ContainerWrites = ContainerWrites()
    /// (O12) Whether the server takes the ITEM write a routine's "Add from
    /// your items…" and its Remove are (`collect`, from the payload's own
    /// write list, `SamplePlanner.canWrite("collect")`), which is not a
    /// container write and is in no `containerWrites` list. False by default,
    /// so a snapshot built without it offers neither.
    var collects: Bool = false

    /// What every schedule here is derived against: the grid's own inputs.
    var scheduleSource: ScheduleSource {
        return ScheduleSource(items: items, routines: routines, seasons: seasons, away: away, timeZone: timeZone)
    }
}

enum OrganizeModel {
    /// The loading row's words: Organize's own, not Today's "Loading your
    /// day…".
    static let loadingText = "Loading\u{2026}"
    /// The segment separator, as the web's labels write it.
    static let separator = " \u{00B7} "
    /// A container with no live member.
    static let emptyContainer = "Nothing in it yet"

    /// The tab's content for `s`.
    static func content(_ s: OrganizeSnapshot) -> OrganizeContent {
        guard s.hasLoaded else {
            if let error = s.loadError { return .failed(error) }
            return .loading
        }
        let organizeOn = s.settings.organizeEnabled
        let goals = visibleGoals(s)
        var sections: [OrganizeSection] = []

        if organizeOn, let routines = routinesSection(s) { sections.append(routines) }
        if organizeOn, let seasons = seasonsSection(s) { sections.append(seasons) }
        if let goals { sections.append(contentsOf: goalSections(goals, s)) }
        if organizeOn, let projects = projectsSection(s) { sections.append(projects) }

        return .list(sections: sections, nothingYet: nothingYet(s), switchedOff: organizeOn ? nil : switchedOff)
    }

    /// The goals the list may show: nil when Goals is off or they are unknown.
    static func visibleGoals(_ s: OrganizeSnapshot) -> [Goal]? {
        guard s.settings.goalsEnabled else { return nil }
        return s.goals
    }

    /// The kinds the switches let the list show, in section order. Goals
    /// counts only when they are known: an unreadable list is not an empty one.
    static func shownKinds(_ s: OrganizeSnapshot) -> [OrganizeKind] {
        var kinds: [OrganizeKind] = []
        if s.settings.organizeEnabled { kinds += [.routine, .season] }
        if visibleGoals(s) != nil { kinds.append(.goal) }
        if s.settings.organizeEnabled { kinds.append(.project) }
        return kinds
    }

    /// "Nothing here yet.", only when every kind the switches allow is empty,
    /// and never when they allow none (the switched-off note says why then).
    /// Its second line names only those kinds, so a switch that hides one
    /// never reads as emptiness: from O11 the ones the + menu makes ("Make a
    /// routine, season or project with +."), and with no + (a server older
    /// than the create route) where they come from ("Routines, seasons and
    /// projects you make on the web show up here.").
    static func nothingYet(_ s: OrganizeSnapshot) -> OrganizeNote? {
        let kinds = shownKinds(s)
        guard !kinds.isEmpty else { return nil }
        let empty = kinds.allSatisfy { kind in
            switch kind {
            case .routine: return s.routines.isEmpty
            case .season: return s.seasons.isEmpty
            case .goal: return visibleGoals(s)?.isEmpty ?? true
            case .project: return s.projects.isEmpty
            }
        }
        guard empty else { return nil }
        let made = ContainerEditModel.createEdits(s).map(\.kind)
        if !made.isEmpty {
            let nouns = englishList(made.map { jsLowercased(noun($0)) }, conjunction: "or")
            return OrganizeNote(title: "Nothing here yet.", detail: "Make \(article(nouns)) \(nouns) with +.")
        }
        let nouns = englishList(kinds.map { jsLowercased(pluralNoun($0)) })
        return OrganizeNote(title: "Nothing here yet.", detail: capitalizedFirst(nouns) + " you make on the web show up here.")
    }

    /// Organize is off: Routines, Seasons and Projects are hidden, and this
    /// says so, with the phone's way back (it cannot flip the switch). The
    /// web's words (container-page.tsx's switched-off page), trimmed to a row.
    static var switchedOff: OrganizeNote {
        let nouns = englishList([OrganizeKind.routine, .season, .project].map { jsLowercased(pluralNoun($0)) })
        return OrganizeNote(title: "Organize is switched off.",
                            detail: "Your \(nouns) are still here. Switch it back on in Settings on the web.")
    }

    // MARK: Sections

    static func routinesSection(_ s: OrganizeSnapshot) -> OrganizeSection? {
        guard !s.routines.isEmpty else { return nil }
        let live = Set(s.items.map(\.id))
        let source = s.scheduleSource
        let rows = s.routines.map { routineRow($0, s, liveItems: live, source: source) }
        return section(.routines, title: ContainerWords.routines, count: "\(rows.count)", rows: rows)
    }

    /// Seasons count the ones live today ("1 on", "0 on" included), the
    /// ported `isSeasonActiveOn`.
    static func seasonsSection(_ s: OrganizeSnapshot) -> OrganizeSection? {
        guard !s.seasons.isEmpty else { return nil }
        let liveItems = Set(s.items.map(\.id))
        let liveRoutines = Set(s.routines.map(\.id))
        let rows = s.seasons.map { seasonRow($0, s, liveItems: liveItems, liveRoutines: liveRoutines) }
        let on = s.seasons.filter { isSeasonActiveOn($0, on: s.today) }.count
        return section(.seasons, title: ContainerWords.seasons, count: "\(on) on", rows: rows)
    }

    /// Goals in `sortGoalsForDisplay` order. Ended goals sit under their own
    /// "Ended" header below the active ones (the console's ENDED divider);
    /// with no active goal they stay under Goals, as the web's `i > 0` does.
    /// Each header counts its own rows.
    static func goalSections(_ goals: [Goal], _ s: OrganizeSnapshot) -> [OrganizeSection] {
        guard !goals.isEmpty else { return [] }
        let byId = Dictionary(s.items.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        let ordered = sortGoalsForDisplay(goals)
        let active = ordered.filter { isGoalActive($0) }.map { goalRow($0, itemsById: byId) }
        let ended = ordered.filter { !isGoalActive($0) }.map { goalRow($0, itemsById: byId) }
        if active.isEmpty {
            return [section(.goals, title: ContainerWords.goals, count: "\(ended.count)", rows: ended)]
        }
        var sections = [section(.goals, title: ContainerWords.goals, count: "\(active.count)", rows: active)]
        if !ended.isEmpty {
            sections.append(section(.ended, title: "Ended", count: "\(ended.count)", rows: ended))
        }
        return sections
    }

    static func projectsSection(_ s: OrganizeSnapshot) -> OrganizeSection? {
        guard !s.projects.isEmpty else { return nil }
        let listed = listedByProject(s.items)
        let rows = s.projects.map { projectRow($0, s, listedByProject: listed) }
        return section(.projects, title: ContainerWords.projects, count: "\(rows.count)", rows: rows)
    }

    private static func section(_ kind: OrganizeSection.Kind, title: String, count: String,
                                rows: [OrganizeRow]) -> OrganizeSection {
        return OrganizeSection(kind: kind, title: title, count: count, spokenLabel: "\(title), \(count)", rows: rows)
    }

    // MARK: Rows

    /// The routine's pill ("Until Oct 30", "Paused", "Held · Nov 1", "Held"),
    /// its usual time, and its live items; and at the trailing edge "2/3
    /// today" (`routineToday`). The list passes the schedule source it built
    /// once; a row built alone builds one.
    static func routineRow(_ routine: Routine, _ s: OrganizeSnapshot, liveItems: Set<UUID>,
                           source: ScheduleSource? = nil) -> OrganizeRow {
        var segments: [String] = []
        if let pill = routinePillLabel(routine, today: s.today, timeZone: s.timeZone, seasons: s.seasons) {
            segments.append(pill)
        }
        if let time = routine.usualTime, !time.isEmpty {
            segments.append(formatCueTime(time, timeFormat: s.settings.timeFormat))
        }
        segments.append(itemsSegment(countLive(routine.itemIds, live: liveItems)))
        return row(.routine, id: routine.id, name: routine.name, glyph: routine.icon, color: routine.color,
                   segments: segments, spoken: segments,
                   trailing: routineToday(routine, s, source: source ?? s.scheduleSource))
    }

    /// A routine's "2/3 today" and its words ("2 of 3 done today"): the web's
    /// `todayCount` over the routine's members on today, only while the
    /// routine is carrying them (`routineStandingOn`'s `effectiveOn`, the
    /// gate the web puts on its Today list) and something of it is on today.
    /// A member skipped today counts on neither side. Nil otherwise: a held
    /// or paused routine, or one with nothing on today, shows no count.
    static func routineToday(_ routine: Routine, _ s: OrganizeSnapshot,
                             source: ScheduleSource) -> (shown: String, spoken: String)? {
        let standing = routineStandingOn(routine, seasons: s.seasons, on: s.today, timeZone: s.timeZone)
        guard standing.effectiveOn else { return nil }
        let schedule = deriveContainerSchedule(memberIds: routine.itemIds, source: source, from: s.today, days: 1,
                                               today: s.today)
        let byItem = occurrencesByItem(schedule)
        guard let shown = todayCount(byItem, ids: routine.itemIds, today: s.today) else { return nil }
        let tally = todayTally(byItem, ids: routine.itemIds, today: s.today)
        return (shown, "\(tally.done) of \(tally.on) done today")
    }

    /// The two numbers `todayCount` writes as "done/on today", for the words
    /// VoiceOver says: the same walk (each listed id, a skip on neither
    /// side). OrganizePageTests pins that the two agree.
    static func todayTally(_ byItem: OccurrencesByItem, ids: [UUID], today: DayString) -> (done: Int, on: Int) {
        var done = 0
        var on = 0
        for id in ids {
            guard let state = byItem[id]?[today]?.state, state != .skipped else { continue }
            on += 1
            if state == .done { done += 1 }
        }
        return (done, on)
    }

    /// The season's pill ("Paused", "From Nov 1", "Ended"), then its live
    /// routines and its own live items (not its routines' items), or "Nothing
    /// in it yet" with neither.
    static func seasonRow(_ season: Season, _ s: OrganizeSnapshot, liveItems: Set<UUID>,
                          liveRoutines: Set<String>) -> OrganizeRow {
        var segments: [String] = []
        if let pill = seasonPillLabel(season, today: s.today) { segments.append(pill) }
        let routines = countLive(season.routineIds, live: liveRoutines)
        let items = countLive(season.itemIds, live: liveItems)
        if routines > 0 {
            segments.append(counted(routines, jsLowercased(ContainerWords.routine), jsLowercased(ContainerWords.routines)))
        }
        if items > 0 { segments.append(itemsSegment(items)) }
        if routines == 0 && items == 0 { segments.append(emptyContainer) }
        return row(.season, id: season.id, name: season.name, glyph: season.icon, color: season.color,
                   segments: segments, spoken: segments)
    }

    /// An ended goal wears its state ("Achieved", "Set aside", the web's
    /// pill). An active one shows its target day, then its progress in the
    /// web's words ("1/3", "2/2 so far", "No milestones yet").
    static func goalRow(_ goal: Goal, itemsById: [UUID: Item]) -> OrganizeRow {
        let progress = goalProgress(goal, itemsById: itemsById)
        var segments: [String] = []
        var spoken: [String] = []
        if let state = endedWord(goal) {
            segments.append(state)
            spoken.append(state)
        } else {
            if let target = goal.targetOn, !target.isEmpty {
                segments.append(formatDay(target))
                spoken.append("target " + formatDay(target))
            }
            segments.append(progressLabel(goal, progress))
            spoken.append(spokenProgress(goal, progress))
        }
        return row(.goal, id: goal.id, name: goal.name, glyph: goal.icon, color: goal.color,
                   segments: segments, spoken: spoken)
    }

    /// The project's items, subtasks left out, so the count is the length of
    /// the list its page draws: every item whose project folds equal to the
    /// name (`containerMemberIds`), done ones included. Each member comes
    /// from the live items, so none needs `countLive`. The list passes the
    /// counts it built once (`listedByProject`); a row built alone builds them.
    /// Then its time block, when it has one ("Weekdays · 6pm–7pm",
    /// `timeBlockSummary`, ProjectBlock.swift).
    static func projectRow(_ project: Project, _ s: OrganizeSnapshot,
                           listedByProject counts: [[UInt16]: Int]? = nil) -> OrganizeRow {
        let byName = counts ?? listedByProject(s.items)
        let listed = byName[Array(jsLowercased(project.name).utf16)] ?? 0
        var segments = [itemsSegment(listed)]
        var spoken = segments
        if let block = timeBlockSummary(project) {
            segments.append(block)
            spoken.append(spokenBlock(block))
        }
        return row(.project, id: project.id, name: project.name, glyph: project.emoji, color: project.color,
                   segments: segments, spoken: spoken)
    }

    /// A time block as VoiceOver says it: "Weekdays, 6pm to 7pm" (the
    /// separator a pause, the range's en dash "to").
    static func spokenBlock(_ summary: String) -> String {
        return spokenSegment(summary).replacingOccurrences(of: "\u{2013}", with: " to ")
    }

    /// Top-level items per folded project name, in one pass over the items,
    /// so each project row is a lookup rather than a scan of every item. The
    /// rule is `containerMemberIds(.project …)` less subtasks: the name folds
    /// with `jsLowercased` and compares code unit by code unit (JavaScript's
    /// `===`, hence the UTF-16 key, never a `String` key, which would compare
    /// by canonical equivalence), an empty name files nothing, and an item
    /// with any `parentItemId` but "" is a subtask. OrganizeTests pins it
    /// against `containerMemberIds`.
    static func listedByProject(_ items: [Item]) -> [[UInt16]: Int] {
        var counts: [[UInt16]: Int] = [:]
        for item in items where (item.parentItemId ?? "").isEmpty {
            guard let name = item.project, !name.isEmpty else { continue }
            counts[Array(jsLowercased(name).utf16), default: 0] += 1
        }
        return counts
    }

    /// A row: its tile from the stored look (else the name's), the
    /// subtitle's segments joined, and VoiceOver's label: the name, the kind,
    /// the spoken segments, then the trailing value's words.
    static func row(_ kind: OrganizeKind, id: String, name: String, glyph: String?, color: String?,
                    segments: [String], spoken: [String],
                    trailing: (shown: String, spoken: String)? = nil) -> OrganizeRow {
        var parts = [name, jsLowercased(noun(kind))] + spoken.map(spokenSegment)
        if let trailing { parts.append(trailing.spoken) }
        return OrganizeRow(kind: kind, containerId: id, title: name,
                           subtitle: segments.isEmpty ? nil : segments.joined(separator: separator),
                           symbol: containerSymbol(glyph: glyph, name: name, kind: kind),
                           accent: containerAccent(color, name: name),
                           trailing: trailing?.shown,
                           spokenLabel: parts.joined(separator: ", "))
    }

    // MARK: Words

    /// "Achieved" or "Set aside" for an ended goal (the web's words for
    /// 'achieved' and 'abandoned'); nil for an active one, and for a state
    /// this build doesn't know, which shows its progress instead.
    static func endedWord(_ goal: Goal) -> String? {
        switch goal.state {
        case "achieved": return "Achieved"
        case "abandoned": return "Set aside"
        default: return nil
        }
    }

    /// The progress as VoiceOver says it, the goal page's ring label's words:
    /// "1 of 3 milestones reached", with "so far" where the web's
    /// `progressLabel` says it.
    static func spokenProgress(_ goal: Goal, _ progress: GoalProgress) -> String {
        let label = progressLabel(goal, progress)
        guard progress.total > 0 else { return label }
        let reached = "\(progress.achieved) of \(progress.total) milestones reached"
        return label.hasSuffix(" so far") ? reached + " so far" : reached
    }

    /// "1 item", "3 items", or "Nothing in it yet" at none.
    static func itemsSegment(_ n: Int) -> String {
        return n == 0 ? emptyContainer : counted(n, "item", "items")
    }

    static func counted(_ n: Int, _ one: String, _ many: String) -> String {
        return "\(n) \(n == 1 ? one : many)"
    }

    // MARK: Container writes (O8a)

    /// Every container write the phone sends, each under the kinds whose
    /// route takes it (`ContainerAction.kinds`): what the sample answers,
    /// since nothing it writes is sent.
    static let everyContainerWrite: ContainerWrites = {
        var all = ContainerWrites()
        for action in ContainerAction.allCases {
            for kind in action.kinds {
                switch kind {
                case .routine: all.routine.append(action.rawValue)
                case .season: all.season.append(action.rawValue)
                case .goal: all.goal.append(action.rawValue)
                case .project: all.project.append(action.rawValue)
                }
            }
        }
        return all
    }()

    /// May a container's page offer `action` on `kind` (design §6.4 Gating)?
    /// The server takes it (`takes`, the resolved list) and the kind's
    /// extension is on: Organize for a routine, a season and a project, Goals
    /// for a goal. The switches are display gates, as on the web, where off
    /// hides the sections; the route takes every write whatever they say
    /// (lib/extension-gates.ts). Paused's Resume asks `takes` alone
    /// (`ShelfPageModel.pausedRow`), as the web's does.
    static func canEdit(_ action: ContainerAction, on kind: OrganizeKind, takes: ContainerWrites,
                        settings: PlannerSettings) -> Bool {
        guard takes.takes(action, on: kind) else { return false }
        switch kind {
        case .routine, .season, .project: return settings.organizeEnabled
        case .goal: return settings.goalsEnabled
        }
    }

    static func noun(_ kind: OrganizeKind) -> String {
        switch kind {
        case .routine: return ContainerWords.routine
        case .season: return ContainerWords.season
        case .goal: return ContainerWords.goal
        case .project: return ContainerWords.project
        }
    }

    static func pluralNoun(_ kind: OrganizeKind) -> String {
        switch kind {
        case .routine: return ContainerWords.routines
        case .season: return ContainerWords.seasons
        case .goal: return ContainerWords.goals
        case .project: return ContainerWords.projects
        }
    }

    /// A segment as VoiceOver reads it: the pill's "·" becomes a pause.
    static func spokenSegment(_ segment: String) -> String {
        return segment.replacingOccurrences(of: separator, with: ", ")
    }

    /// "a", "a and b", "a, b and c"; with `conjunction` "or", "a, b or c".
    static func englishList(_ words: [String], conjunction: String = "and") -> String {
        guard let last = words.last else { return "" }
        guard words.count > 1 else { return last }
        return words.dropLast().joined(separator: ", ") + " \(conjunction) " + last
    }

    /// "a" or "an" before `phrase`, by its first letter.
    static func article(_ phrase: String) -> String {
        guard let first = phrase.lowercased().first else { return "a" }
        return "aeiou".contains(first) ? "an" : "a"
    }

    static func capitalizedFirst(_ s: String) -> String {
        guard let first = s.first else { return s }
        return first.uppercased() + String(s.dropFirst())
    }
}

/// The two cards over the list (O4, design §6.2): THIS WEEK and NEXT
/// MILESTONE. Either may be absent; the list draws them only when one shows.
struct SummaryCards: Hashable, Sendable {
    /// THIS WEEK: done out of done-or-due across everything the grid shows
    /// this calendar week (`organizeWeek`, design Q1's default: however it
    /// is filed). Never a share of the past: an unrecorded past day is
    /// neither done nor due (the guilt-free law).
    struct Week: Hashable, Sendable {
        /// The big number, "18"; nil with nothing on, when `tail` is the
        /// whole line.
        let lead: String?
        /// The rest of `weekCardSentence`: "of 23 done", or "Nothing on this
        /// week" alone.
        let tail: String
        /// The lime bar's fill, `done / counted`; nil draws no bar.
        let fraction: Double?
        /// The card as one element: "This week, 18 of 23 done".
        let spokenLabel: String
    }

    /// NEXT MILESTONE: the earliest dated open milestone across the active
    /// goals, else the first undated one (`nextMilestoneAcross`). The card is
    /// one button that pushes its goal.
    struct Milestone: Hashable, Sendable {
        let goalId: String
        /// The milestone's title.
        let title: String
        /// "Oct 4 · Run a half marathon", or the goal's name alone for an
        /// undated milestone (`nextMilestoneLine`). No countdown.
        let line: String
        /// "Next milestone, Run a 10K, Oct 4, Run a half marathon".
        let spokenLabel: String

        var route: OrganizeRoute { .container(.goal, id: goalId) }
    }

    let week: Week?
    let milestone: Milestone?

    static let weekEyebrow = "THIS WEEK"
    static let milestoneEyebrow = "NEXT MILESTONE"
    /// The milestone card's hint: "Opens the goal".
    static var milestoneHint: String { "Opens the " + jsLowercased(ContainerWords.goal) }
}

/// One row of the footer under the list (O5, O14): Item types, Paused and
/// Trash, each opening its page. Its tile is the console rail's identity
/// (console-rail.tsx `SECTION_IDENTITY`): Item types plum (accent-4) with
/// the Shapes glyph, Paused and Trash muted gray.
struct FooterRow: Identifiable, Hashable, Sendable {
    enum Kind: String, Hashable, Sendable {
        case itemTypes, paused, trash
    }

    let kind: Kind
    /// "Item types", "Paused", "Trash".
    let title: String
    /// Under the title: Paused's soonest return ("Gym back Fri", the rest of
    /// the web's rail note, `pausedNote`); nil otherwise.
    let subtitle: String?
    /// The SF Symbol on the tile.
    let symbol: String
    /// The tile's colour; nil draws it muted gray.
    let accent: ContainerAccent?
    /// The count at the trailing edge: the custom types, or the items set
    /// aside (`PausedShelf.count`, items not entries); nil at none, as the
    /// web's rail note is, and always for Trash.
    let trailing: String?
    /// The row as one element: "Paused, 5 items, Gym back Fri".
    let spokenLabel: String

    var id: Kind { kind }

    var route: OrganizeRoute {
        switch kind {
        case .itemTypes: return .itemTypes
        case .paused: return .paused
        case .trash: return .trash
        }
    }

    /// "Opens Paused", with no full stop, as the house hints have none.
    var hint: String { "Opens " + title }
}

extension OrganizeModel {
    // MARK: Summary cards (O4)

    /// The cards for `s`, or nil when neither shows. THIS WEEK shows only
    /// with Organize on; NEXT MILESTONE only with Goals on, the goals known,
    /// and an open milestone on an active goal.
    static func summary(_ s: OrganizeSnapshot) -> SummaryCards? {
        let week = s.settings.organizeEnabled ? weekCard(s) : nil
        let milestone = visibleGoals(s).flatMap { milestoneCard($0, s) }
        guard week != nil || milestone != nil else { return nil }
        return SummaryCards(week: week, milestone: milestone)
    }

    /// THIS WEEK over the grid's own inputs, from the user's Week starts on.
    static func weekCard(_ s: OrganizeSnapshot) -> SummaryCards.Week {
        let week = organizeWeek(s.scheduleSource, today: s.today, weekStartDay: s.settings.weekStartDay)
        let sentence = OrganizeCopy.weekCardSentence(done: week.done, counted: week.counted)
        // The big number is the sentence's own first word, so the words stay
        // OrganizeCopy's.
        let lead = "\(week.done)"
        guard week.counted > 0, sentence.hasPrefix(lead + " ") else {
            return SummaryCards.Week(lead: nil, tail: sentence, fraction: nil, spokenLabel: sentence)
        }
        return SummaryCards.Week(lead: lead, tail: String(sentence.dropFirst(lead.count + 1)),
                                 fraction: week.fraction, spokenLabel: "This week, " + sentence)
    }

    /// NEXT MILESTONE across `goals`, or nil when no active goal has one open.
    static func milestoneCard(_ goals: [Goal], _ s: OrganizeSnapshot) -> SummaryCards.Milestone? {
        let byId = Dictionary(s.items.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        guard let next = nextMilestoneAcross(goals, itemsById: byId) else { return nil }
        let line = OrganizeCopy.nextMilestoneLine(date: next.date, goalName: next.goal.name)
        return SummaryCards.Milestone(goalId: next.goal.id, title: next.milestone.title, line: line,
                                      spokenLabel: "Next milestone, \(next.milestone.title), \(spokenSegment(line))")
    }

    // MARK: The footer (O5, O14)

    /// The footer's rows, in the console rail's order. Item types only with
    /// Organize on (its rail row rides the switch); Paused always, whatever
    /// the switches say, because pausing is not gated and its way back may
    /// not be; Trash only signed in against a server that takes its routes.
    static func footer(_ s: OrganizeSnapshot) -> [FooterRow] {
        var rows: [FooterRow] = []
        if s.settings.organizeEnabled { rows.append(itemTypesRow(s)) }
        rows.append(pausedRow(s))
        if s.trashOffered { rows.append(trashRow) }
        return rows
    }

    static func itemTypesRow(_ s: OrganizeSnapshot) -> FooterRow {
        let n = s.itemTypes?.count ?? 0
        let title = ShelfPageModel.itemTypesTitle
        var spoken = [title]
        if n > 0 { spoken.append(counted(n, "type", "types")) }
        return FooterRow(kind: .itemTypes, title: title, subtitle: nil, symbol: "square.on.circle",
                         accent: containerAccent("var(--accent-4)", name: title),
                         trailing: n > 0 ? "\(n)" : nil, spokenLabel: spoken.joined(separator: ", "))
    }

    /// Paused counts the items set aside, a routine of four as four, the
    /// number the laptop's moon shows; under it the soonest return.
    static func pausedRow(_ s: OrganizeSnapshot) -> FooterRow {
        let shelf = ShelfPageModel.shelf(s)
        let title = ShelfPageModel.pausedTitle
        let note = pausedNote(shelf, today: s.today)
        // The web's rail note is "5 · Gym back Fri": the count goes to the
        // trailing edge and the rest under the title.
        let countPrefix = "\(shelf.count)" + separator
        let back: String? = note.flatMap { $0.hasPrefix(countPrefix) ? String($0.dropFirst(countPrefix.count)) : nil }
        var spoken = [title]
        if shelf.count > 0 { spoken.append(counted(shelf.count, "item", "items")) }
        if let back { spoken.append(back) }
        return FooterRow(kind: .paused, title: title, subtitle: back, symbol: "moon", accent: nil,
                         trailing: shelf.count > 0 ? "\(shelf.count)" : nil,
                         spokenLabel: spoken.joined(separator: ", "))
    }

    /// Trash carries no count: the bin is fetched only on its page.
    static var trashRow: FooterRow {
        let title = ShelfPageModel.trashTitle
        return FooterRow(kind: .trash, title: title, subtitle: nil, symbol: "trash", accent: nil, trailing: nil,
                         spokenLabel: title)
    }
}

extension SamplePlanner {
    /// What the Organize tab reads off this planner.
    var organizeSnapshot: OrganizeSnapshot {
        return OrganizeSnapshot(hasLoaded: hasLoaded, loadError: loadError, settings: settings, today: today,
                                timeZone: timeZoneID, items: items, routines: routines, seasons: seasons,
                                goals: goals, projects: projectRecords, away: awayPeriods, typeLabels: typeLabels,
                                itemTypes: itemTypes, trashOffered: offersTrash, containerTakes: containerTakes,
                                collects: canWrite("collect"))
    }

    /// The Organize tab's content now.
    var organize: OrganizeContent {
        return OrganizeModel.content(organizeSnapshot)
    }

    /// The summary cards over the list, or nil when neither shows.
    var organizeSummary: SummaryCards? {
        return OrganizeModel.summary(organizeSnapshot)
    }

    /// The footer's rows under the list.
    var organizeFooter: [FooterRow] {
        return OrganizeModel.footer(organizeSnapshot)
    }

    /// The + menu's rows (O11); empty hides the +. Built from a slim
    /// snapshot of only what the menu reads (loaded, the switches, whether
    /// goals are known, the live projects a new name may clash with, and what
    /// the server takes), so the Organize bar that shows it observes those
    /// alone: a tick on Today doesn't redraw the tab's stack.
    var organizeCreates: [CreateEdit] {
        let menu = OrganizeSnapshot(hasLoaded: hasLoaded, settings: settings, today: today, timeZone: timeZoneID,
                                    goals: goals.map { _ in [Goal]() }, projects: projectRecords,
                                    containerTakes: containerTakes)
        return ContainerEditModel.createEdits(menu)
    }
}
