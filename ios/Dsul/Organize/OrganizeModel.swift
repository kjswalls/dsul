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
// routine's row carries the web's "2/3 today". There are no summary cards
// (O4) and no footer rows (Item types, Paused, Trash; O5 and O14) yet.

/// Where a tap on Organize goes: a container's page. Foundation only, so the
/// hosted tests pin where every row leads; the stack's path holds these
/// (OrganizeView). Not yet the design's `ContainerRef`, which O8a adds to
/// DsulCore with the writes: until then a kind and an id say the same, and
/// the id is never parsed as a UUID (the sample's are not).
enum OrganizeRoute: Hashable, Sendable {
    case container(OrganizeKind, id: String)
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
    /// never reads as emptiness.
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

    /// "a", "a and b", "a, b and c".
    static func englishList(_ words: [String]) -> String {
        guard let last = words.last else { return "" }
        guard words.count > 1 else { return last }
        return words.dropLast().joined(separator: ", ") + " and " + last
    }

    static func capitalizedFirst(_ s: String) -> String {
        guard let first = s.first else { return s }
        return first.uppercased() + String(s.dropFirst())
    }
}

extension SamplePlanner {
    /// What the Organize tab reads off this planner.
    var organizeSnapshot: OrganizeSnapshot {
        return OrganizeSnapshot(hasLoaded: hasLoaded, loadError: loadError, settings: settings, today: today,
                                timeZone: timeZoneID, items: items, routines: routines, seasons: seasons,
                                goals: goals, projects: projectRecords, away: awayPeriods, typeLabels: typeLabels)
    }

    /// The Organize tab's content now.
    var organize: OrganizeContent {
        return OrganizeModel.content(organizeSnapshot)
    }
}
