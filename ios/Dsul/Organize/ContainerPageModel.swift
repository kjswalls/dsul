import DsulCore
import Foundation

// What a container's page shows and says (design §6.3, O2 and O3), worked out
// apart from the views so the hosted tests pin it (OrganizePageTests), as
// OrganizeModel does for the list. Foundation only: the shim compiles it on
// Linux.
//
// Read-only. Every rule is asked of DsulCore, never re-derived:
// - which members are on a day, and in what state, is the grid's own answer
//   narrowed to the container (`deriveContainerSchedule`,
//   ContainerSchedule.swift, lib/container-schedule.ts), asked ONCE per page
//   over the strip's 14 days ending today; today's checklist
//   (`todayInOrder`), the strip (`dayRollup`) and which rows may tick all
//   read that one schedule;
// - a routine's standing, held note and "Held by" are lib/active.ts
//   (`routineStandingOn`, ActiveExplain.swift) and lib/organize-copy.ts
//   (OrganizeCopy.swift); a season's sentence and Runs chip are
//   lib/organize-copy.ts;
// - a goal's ring, countdown, timeline, check-ins and supporting work are
//   lib/goals.ts (Goals.swift), its words lib/organize-copy.ts, and a hidden
//   member's note lib/active.ts (`suppressionReason`, `suppressionLabel`);
// - a project's block is lib/project-block.ts (ProjectBlock.swift), its rows
//   the members its list row counts (`containerMemberIds`, subtasks left
//   out).
//
// The guilt-free law: a past day in the strip is drawn from what was
// recorded, never as a share of what was "due" (`DayStrip`), and nothing here
// says "missed" or "overdue". Lime is a mark the views draw; no word here asks
// for a hue. No em dashes.

/// A container page's model: every page has a header.
protocol OrganizePageModel: Hashable, Sendable {
    var header: PageHeader { get }
}

/// What a container's page shows: the page, or, while its extension is off,
/// the web's sentence in place of its body (container-page.tsx and the goal
/// page: off is inert, never "not found"). A page whose container is gone is
/// nil, and the page pops itself.
enum PageContent<Page: OrganizePageModel>: Hashable, Sendable {
    case switchedOff(SwitchedOff)
    case page(Page)

    /// The bar's title once the header scrolls away: the container's name,
    /// or nil while the extension is off (the sentence is the page).
    var title: String? {
        guard case .page(let page) = self else { return nil }
        return page.header.title
    }
}

/// A page's header: the tile, the kind's eyebrow, and the name.
struct PageHeader: Hashable, Sendable {
    let kind: OrganizeKind
    let title: String
    /// The kind's noun uppercased ("ROUTINE"), from `ContainerWords`.
    let eyebrow: String
    /// The tile's SF Symbol (`containerSymbol`).
    let symbol: String
    /// The tile's colour (`containerAccent`): the tile, the glyph and a goal's
    /// ring only, never text.
    let accent: ContainerAccent
}

/// One read-only chip under a page's header. Its words are the label colour
/// and its symbol gray; no hue.
struct PageChip: Identifiable, Hashable, Sendable {
    enum Kind: String, Hashable, Sendable {
        case usualTime, status, runs, window, items, timeBlock
    }

    let kind: Kind
    let text: String
    let systemImage: String
    /// VoiceOver's words: "Status: Paused until Oct 30".
    let spoken: String

    var id: Kind { kind }
}

/// One item on a page, drawn as Today draws a row: the status circle, the
/// title, a habit's flame while Streaks is on, and a line of meta under the
/// title. A tap opens the item's sheet on today; the circle ticks only an
/// item on today (`tickable`), through the row's own write on today.
struct MemberRow: Identifiable, Hashable, Sendable {
    let item: Item
    /// On today, and not skipped there: the circle is the tick.
    let tickable: Bool
    /// Ticked on today (`isRowDone`): a one-off by its status, a recurring
    /// item by today's date.
    let done: Bool
    /// Skipped today: drawn without a circle.
    let skipped: Bool
    /// The meta under the title, segments joined with " · ": "next", a
    /// cadence ("Daily", "Oct 2", "No date"), a check-in's "Sun · last Oct
    /// 18".
    let meta: String?
    /// Why it is not on the day, when something hides it (a goal's rows):
    /// `suppressionLabel`, "Hidden with Winter", "Back Nov 9".
    let hiddenNote: String?
    /// A habit, with Streaks on: the flame and its count show.
    let flame: Bool
    /// The row as one VoiceOver element: the title, the meta, the hidden
    /// note, "skipped", "streak N". Done is the element's value.
    let spokenLabel: String

    var id: UUID { item.id }
}

/// The "Last 14 days" strip (design §2 Q7, §6.3): a past day is never a
/// fraction. A past day with something done is a full lime cell; one with
/// only unrecorded occurrences a neutral wash ("nothing recorded"); one with
/// a skip, or nothing on, an outline. Only today fills by share, done over
/// done and still due, the `weekTotals` rule for one day.
struct DayStrip: Hashable, Sendable {
    struct Cell: Identifiable, Hashable, Sendable {
        enum Mark: Hashable, Sendable {
            /// A past day with something done: full-strength lime, no fraction.
            case done
            /// A past day with only unrecorded occurrences: a neutral wash,
            /// never a faded lime, and never "missed".
            case nothingRecorded
            /// A past day whose occurrences were skipped (and none done).
            case skipped
            /// A day with nothing on.
            case nothingOn
            /// Today: filled from the bottom to `done / of` (`of` is done plus
            /// still due; 0 draws no fill).
            case today(done: Int, of: Int)
        }

        let date: DayString
        let mark: Mark
        /// "Oct 12, 2 done", "Oct 12, nothing recorded", "Oct 12, skipped",
        /// "Oct 12, nothing on", "Today, 2 of 3 done".
        let spokenLabel: String

        var id: DayString { date }
    }

    /// Oldest first; the last is today.
    let cells: [Cell]
    /// The first day, under the strip's left end: "Oct 10".
    let firstLabel: String
}

/// A routine's Today section: its members on today, in its own order.
struct TodayChecklist: Hashable, Sendable {
    let rows: [MemberRow]
    /// The header's trailing text: "2 of 3 done", "2 of 3 done · 1 skipped";
    /// nil with nothing on today.
    let summary: String?
    /// "Nothing from Morning routine is on today."; nil when something is.
    let empty: String?
    /// "All through for today." once nothing on today is left due.
    let finished: String?
}

/// The routine page (O2).
struct RoutinePage: OrganizePageModel {
    let header: PageHeader
    let notes: String?
    /// "Usually 7:00 am" (when set), then Status: "Active", "Paused" or
    /// "Paused until Oct 30".
    let chips: [PageChip]
    /// Under Status: the web's paused note, or its held note when every
    /// season holding the routine is off (`localOn && !effectiveOn`), so the
    /// chip never says "Active" over a routine held off with nothing to
    /// explain it.
    let statusNote: String?
    /// "Held by": one row per season holding it, in the seasons' order, each
    /// pushing that season ("on", "off until Nov 1").
    let heldBy: [OrganizeRow]
    /// "No season. It answers for itself." when none holds it.
    let heldByEmpty: String?
    /// Nil when the routine has no live member (`empty` says so instead).
    let today: TodayChecklist?
    /// The live members not on today, in the routine's order, each with its
    /// cadence.
    let otherDays: [MemberRow]
    let strip: DayStrip?
    /// "Nothing is in it yet." with no live member.
    let empty: String?
}

/// The season page (O2).
struct SeasonPage: OrganizePageModel {
    let header: PageHeader
    let notes: String?
    /// Status ("On", "Off", "Dates"), then Runs under Dates when it has a
    /// date ("Oct 1 to Mar 15", "From Oct 1", "Until Mar 15").
    let chips: [PageChip]
    /// `seasonStateNote`: "Always on. Give it a start or an end …".
    let stateNote: String
    /// The routines it holds, in the routines' own order, each pushing its
    /// page (the list's routine row).
    let routines: [OrganizeRow]
    /// Its own items.
    let items: [MemberRow]
    /// Over its items and its routines' items.
    let strip: DayStrip?
    /// "Nothing is in it yet." with no routine and no item.
    let empty: String?
}

/// A goal's progress ring: the lime arc at `fraction`. Hidden with nothing to
/// measure (no milestone): a nil fraction, never 0.
struct GoalRing: Hashable, Sendable {
    let fraction: Double
    /// "2 of 5 milestones reached".
    let spokenLabel: String
}

/// One checkpoint on a goal's timeline (`milestoneTimeline`).
struct MilestoneLine: Identifiable, Hashable, Sendable {
    let item: Item
    let state: MilestoneState
    /// "Oct 4", or "No date yet".
    let dateLabel: String
    /// The web's notes after the date, each drawn "· {note}": "reached",
    /// "next up", "still ahead of you", "dropped".
    let annotations: [String]
    let hiddenNote: String?
    /// The node's tick, named for what it does: "Mark Run a 10K reached".
    let tickLabel: String
    /// "Run a 10K, Oct 4, next up".
    let spokenLabel: String

    var id: UUID { item.id }

    /// The caption under the title: "Oct 4 · next up · still ahead of you".
    var caption: String {
        return ([dateLabel] + annotations).joined(separator: OrganizeModel.separator)
    }
}

/// One heading of a goal's Supporting work: a type's plural and its members.
struct MemberGroup: Identifiable, Hashable, Sendable {
    let typeName: String
    /// The type's plural: "Habits", "Tasks", "Books".
    let title: String
    let rows: [MemberRow]

    var id: String { typeName }
}

/// An ended goal's recurring members, which keep coming round.
struct WindDown: Hashable, Sendable {
    let sentence: String
    let rows: [MemberRow]
}

/// The goal page (O3).
struct GoalPage: OrganizePageModel {
    let header: PageHeader
    let ring: GoalRing?
    /// The why, under the title and above every number.
    let why: String?
    /// "12 days to Nov 4", "target is today", "3 days past Oct 20"; active
    /// goals with a target only.
    let countdown: String?
    /// Status ("Active", "Achieved", "Set aside"), then the window ("Started
    /// Oct 1 · Target Mar 15") when it has a date.
    let chips: [PageChip]
    /// An ended goal's note: "Achieved on Oct 1. Everything below …".
    let endedNote: String?
    let windDown: WindDown?
    /// "40% of the way to Mar 15", only with both dates and a milestone.
    let elapsed: String?
    /// Milestones' header: `progressLabel` ("1/3", "2/2 so far", "No
    /// milestones yet").
    let progress: String
    /// The same as VoiceOver says it: "1 of 3 milestones reached".
    let progressSpoken: String
    let milestones: [MilestoneLine]
    /// "No checkpoints yet. …" with none.
    let milestonesEmpty: String?
    let checkins: [MemberRow]
    /// "No check-in yet. …" with none.
    let checkinsEmpty: String?
    let groups: [MemberGroup]
    /// "Nothing else is filed under this goal yet." with none.
    let supportingEmpty: String?
}

/// The project page (O3).
struct ProjectPage: OrganizePageModel {
    let header: PageHeader
    /// "3 items" (subtasks left out, the list row's count), then the time
    /// block ("Weekdays · 6pm–7pm", or "No time block"), read-only.
    let chips: [PageChip]
    let notes: String?
    /// The items the count counts: open first, then done, each in planner
    /// order.
    let items: [MemberRow]
    /// Only when anything is in range.
    let strip: DayStrip?
    /// "Nothing is in it yet." with no item.
    let empty: String?
}

enum ContainerPageModel {
    /// The strip's length: 14 days ending today.
    static let stripDays = 14
    /// The project page's words for a project with no time block. The web
    /// has none (its chip offers "Add a time block"); the phone's are its own.
    static let noTimeBlock = "No time block"

    // MARK: Words

    /// The section titles, the web page's where it has one.
    static let heldByTitle = "Held by"
    static let todayTitle = "Today"
    static let otherDaysTitle = "Other days"
    static let itemsTitle = "Items"
    static let milestonesTitle = "Milestones"
    static let checkinsTitle = "Check-ins"
    static let supportingTitle = "Supporting work"
    static let stripTitle = "Last 14 days"
    /// The strip's legend: "Done · Nothing recorded", then "Today".
    static let legendDone = "Done"
    static let legendNothingRecorded = "Nothing recorded"
    static let legendToday = "Today"
    /// What a member row's tap does, as VoiceOver hints it (Today's words).
    static let openHint = "Opens details"
    /// A row's tick, named for what it does (Today's words).
    static func tickName(done: Bool) -> String {
        return done ? "Mark not done" : "Mark done"
    }

    // MARK: Lookups

    /// The container a route names, whatever the switches say: gone is gone,
    /// switched off is not. Nil when the planner no longer holds it.
    static func container(_ kind: OrganizeKind, id: String, _ s: OrganizeSnapshot) -> ScheduleContainer? {
        switch kind {
        case .routine: return s.routines.first { $0.id == id }.map(ScheduleContainer.routine)
        case .season: return s.seasons.first { $0.id == id }.map(ScheduleContainer.season)
        case .goal: return s.goals?.first { $0.id == id }.map(ScheduleContainer.goal)
        case .project: return s.projects.first { $0.id == id }.map(ScheduleContainer.project)
        }
    }

    /// The items by id, as the web's `new Map(items.map(…))` (a repeat keeps
    /// the last).
    static func itemsById(_ items: [Item]) -> [UUID: Item] {
        return Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    }

    /// `ids` resolved to live items, each once, first seen first: a trashed
    /// member (its join row outlives it) is skipped, never counted.
    static func resolved(_ ids: [UUID], _ byId: [UUID: Item]) -> [Item] {
        var seen = Set<UUID>()
        return ids.compactMap { id in
            guard seen.insert(id).inserted else { return nil }
            return byId[id]
        }
    }

    /// The same list without repeats, first seen first.
    static func unique(_ items: [Item]) -> [Item] {
        var seen = Set<UUID>()
        return items.filter { seen.insert($0.id).inserted }
    }

    /// The members of `schedule` on `today`, each with the schedule's state
    /// there (the first occurrence, as `occurrencesByItem` keeps it).
    static func onToday(_ schedule: ContainerSchedule, today: DayString) -> [UUID: OccurrenceState] {
        let occurrences = schedule.days.first { $0.date == today }?.occurrences ?? []
        return Dictionary(occurrences.map { ($0.itemId, $0.state) }, uniquingKeysWith: { first, _ in first })
    }

    /// The strip's schedule: `memberIds` over the 14 days ending today.
    static func stripSchedule(_ memberIds: [UUID], _ s: OrganizeSnapshot, source: ScheduleSource? = nil,
                              block: Project? = nil) -> ContainerSchedule {
        return deriveContainerSchedule(memberIds: memberIds, source: source ?? s.scheduleSource,
                                       from: s.today.adding(days: -(stripDays - 1)), days: stripDays,
                                       today: s.today, block: block)
    }

    // MARK: Shared parts

    static func header(_ kind: OrganizeKind, name: String, glyph: String?, color: String?) -> PageHeader {
        return PageHeader(kind: kind, title: name, eyebrow: OrganizeModel.noun(kind).uppercased(),
                          symbol: containerSymbol(glyph: glyph, name: name, kind: kind),
                          accent: containerAccent(color, name: name))
    }

    /// Stored notes, trimmed; nil when there are none.
    static func notes(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let clean = jsTrim(raw)
        return clean.isEmpty ? nil : clean
    }

    /// One item's row on a page. `onToday` is the members on today in the
    /// page's schedule, with their state there; only those tick. `meta` is
    /// joined with " · ".
    ///
    /// Skipped is the schedule's own word for today, so a row and the
    /// summary over it agree: a cancelled one-off is a recorded decision
    /// (lib/container-schedule.ts `stateOn`), drawn skipped and never offered
    /// a tick the `tick` gate would refuse.
    static func memberRow(_ item: Item, _ s: OrganizeSnapshot, onToday: [UUID: OccurrenceState], meta: [String] = [],
                          hidden: String? = nil) -> MemberRow {
        let state = onToday[item.id]
        let on = state != nil
        let skipped = state == .skipped
        let flame = item.isHabit && s.settings.streaksEnabled
        let segments = meta.filter { !$0.isEmpty }
        var spoken = [item.title] + segments.map(OrganizeModel.spokenSegment)
        if let hidden { spoken.append(hidden) }
        if skipped { spoken.append("skipped") }
        if flame { spoken.append("streak \(item.streak ?? 0)") }
        return MemberRow(item: item, tickable: on && !skipped, done: isRowDone(item, on: s.today), skipped: skipped,
                         meta: segments.isEmpty ? nil : segments.joined(separator: OrganizeModel.separator),
                         hiddenNote: hidden, flame: flame, spokenLabel: spoken.joined(separator: ", "))
    }

    /// Why `item` is not on today, in the short words a row's meta takes, or
    /// nil when it is on: lib/active.ts `suppressionReason` with the trips,
    /// as the goal surfaces ask it (`GoalMemberNote`).
    static func hiddenNote(_ item: Item, _ s: OrganizeSnapshot) -> String? {
        return suppressionReason(item, on: s.today, timeZone: s.timeZone, routines: s.routines, seasons: s.seasons,
                                 away: s.away).map { suppressionLabel($0) }
    }

    /// The strip over a schedule's days, or nil when nothing in range was
    /// done, is due or went unrecorded (a range of skips alone, or nothing
    /// on, shows no strip).
    static func dayStrip(_ schedule: ContainerSchedule, today: DayString) -> DayStrip? {
        let rollup = dayRollup(schedule)
        guard rollup.contains(where: { $0.done + $0.due + $0.open > 0 }) else { return nil }
        return DayStrip(cells: rollup.map { stripCell($0, today: today) },
                        firstLabel: rollup.first.map { formatDay($0.date.description) } ?? "")
    }

    /// One day's cell. A past day ranks done, then skipped, then nothing
    /// recorded, then nothing on, so a member added today (which is `open` on
    /// every earlier day it would have fallen on) never turns a recorded day
    /// into a wash, and a day never reads as a share.
    static func stripCell(_ day: DayRollup, today: DayString) -> DayStrip.Cell {
        if day.date == today {
            let of = day.done + day.due
            let words: String
            if of > 0 {
                words = "\(day.done) of \(of) done"
            } else if day.skipped > 0 {
                words = "skipped"
            } else {
                words = "nothing on"
            }
            return DayStrip.Cell(date: day.date, mark: .today(done: day.done, of: of), spokenLabel: "Today, " + words)
        }
        let date = formatDay(day.date.description)
        if day.done > 0 {
            return DayStrip.Cell(date: day.date, mark: .done, spokenLabel: "\(date), \(day.done) done")
        }
        if day.skipped > 0 {
            return DayStrip.Cell(date: day.date, mark: .skipped, spokenLabel: "\(date), skipped")
        }
        if day.open > 0 {
            return DayStrip.Cell(date: day.date, mark: .nothingRecorded, spokenLabel: "\(date), nothing recorded")
        }
        return DayStrip.Cell(date: day.date, mark: .nothingOn, spokenLabel: "\(date), nothing on")
    }

    // MARK: Routine

    /// A routine's page, or the switched-off sentence while Organize is off;
    /// nil when the planner no longer holds it.
    static func routinePage(_ id: String, _ s: OrganizeSnapshot) -> PageContent<RoutinePage>? {
        guard let routine = s.routines.first(where: { $0.id == id }) else { return nil }
        guard s.settings.organizeEnabled else { return .switchedOff(OrganizeCopy.organizeOff) }
        let today = s.today
        let source = s.scheduleSource
        let byId = itemsById(s.items)
        let members = resolved(routine.itemIds, byId)
        let standing = routineStandingOn(routine, seasons: s.seasons, on: today, timeZone: s.timeZone)

        var chips: [PageChip] = []
        if let time = routine.usualTime, !time.isEmpty {
            let clock = formatCueTime(time, timeFormat: s.settings.timeFormat)
            chips.append(PageChip(kind: .usualTime, text: "Usually \(clock)", systemImage: "clock",
                                  spoken: "Usual time: \(clock)"))
        }
        let status = routineStatus(routine, standing)
        chips.append(PageChip(kind: .status, text: status, systemImage: standing.localOn ? "play.circle" : "pause.circle",
                              spoken: "Status: \(status)"))

        let statusNote: String?
        if !standing.localOn {
            statusNote = OrganizeCopy.routinePausedNote(routine)
        } else {
            let hidden = OrganizeCopy.hiddenHere(routine, items: s.items, routines: s.routines, seasons: s.seasons,
                                                 on: today, timeZone: s.timeZone)
            statusNote = OrganizeCopy.routineHeldNote(standing, hiddenHere: hidden, today: today)
        }

        let heldBy = standing.holders.map { holderRow($0, today: today) }

        var checklist: TodayChecklist? = nil
        var otherDays: [MemberRow] = []
        var strip: DayStrip? = nil
        if !members.isEmpty {
            let schedule = stripSchedule(routine.itemIds, s, source: source)
            let on = onToday(schedule, today: today)
            let run = todayInOrder(schedule, order: routine.itemIds, today: today)
            var listed = Set<UUID>()
            let rows: [MemberRow] = run.rows.compactMap { r in
                guard let item = byId[r.itemId], listed.insert(r.itemId).inserted else { return nil }
                let meta = r.itemId == run.nextId ? [OrganizeCopy.routineTodayNext] : []
                return memberRow(item, s, onToday: on, meta: meta)
            }
            checklist = TodayChecklist(
                rows: rows,
                summary: OrganizeCopy.routineTodaySummary(done: run.done, total: rows.count, skipped: run.skipped),
                empty: rows.isEmpty ? OrganizeCopy.routineTodayEmpty(name: routine.name, memberCount: members.count)
                    : nil,
                finished: run.finished ? OrganizeCopy.routineTodayFinished : nil
            )
            // A member held off today (the routine paused, a season off, its
            // own pause, a trip) says why beside its cadence, so "Other days"
            // never reads "Daily" with nothing to explain it. One merely off
            // today keeps its plain cadence: `hiddenNote` is nil for it.
            otherDays = members.filter { !listed.contains($0.id) }.map { item in
                memberRow(item, s, onToday: on, meta: [cadenceLabel(item)], hidden: hiddenNote(item, s))
            }
            strip = dayStrip(schedule, today: today)
        }

        return .page(RoutinePage(
            header: header(.routine, name: routine.name, glyph: routine.icon, color: routine.color),
            notes: notes(routine.notes),
            chips: chips,
            statusNote: statusNote,
            heldBy: heldBy,
            heldByEmpty: heldBy.isEmpty ? OrganizeCopy.heldByNone : nil,
            today: checklist,
            otherDays: otherDays,
            strip: strip,
            empty: members.isEmpty ? OrganizeCopy.nothingInItYet : nil
        ))
    }

    /// The routine's Status chip: its OWN switch, "Active" or "Paused",
    /// with the day a pause ends ("Paused until Oct 30", the exclusive resume
    /// day, as the paused note words it).
    static func routineStatus(_ routine: Routine, _ standing: RoutineStanding) -> String {
        let states = OrganizeCopy.routineStates
        guard !standing.localOn else { return OrganizeCopy.label("active", in: states) ?? "Active" }
        let paused = OrganizeCopy.label("paused", in: states) ?? "Paused"
        guard let until = routine.pausedUntil, !until.isEmpty else { return paused }
        return "\(paused) until \(formatDay(until))"
    }

    /// One season in a routine's "Held by": its tile and name, and the web's
    /// state words at the trailing edge ("on", "off", "off until Nov 1").
    static func holderRow(_ season: Season, today: DayString) -> OrganizeRow {
        let state = OrganizeCopy.heldByState(season, today: today)
        return OrganizeModel.row(.season, id: season.id, name: season.name, glyph: season.icon, color: season.color,
                                 segments: [], spoken: [], trailing: (state, state))
    }

    // MARK: Season

    /// A season's page, or the switched-off sentence while Organize is off;
    /// nil when the planner no longer holds it.
    static func seasonPage(_ id: String, _ s: OrganizeSnapshot) -> PageContent<SeasonPage>? {
        guard let season = s.seasons.first(where: { $0.id == id }) else { return nil }
        guard s.settings.organizeEnabled else { return .switchedOff(OrganizeCopy.organizeOff) }
        let today = s.today
        let source = s.scheduleSource
        let byId = itemsById(s.items)
        let live = isSeasonActiveOn(season, on: today)

        let status = OrganizeCopy.label(season.state, in: OrganizeCopy.seasonStates) ?? season.state
        var chips = [PageChip(kind: .status, text: status, systemImage: seasonStatusSymbol(season.state),
                              spoken: "Status: \(status)")]
        // Under Dates alone, as on the web: On and Off always win, so a range
        // beside them would be a control with no effect.
        if season.state == "auto",
           let runs = OrganizeCopy.seasonRunsLabel(startsOn: season.startsOn, endsOn: season.endsOn) {
            chips.append(PageChip(kind: .runs, text: runs, systemImage: "calendar", spoken: "Runs: \(runs)"))
        }

        // Held routines in the routines' own order, not the payload's
        // `routineIds` order, so an optimistic hold doesn't jump on the next
        // fetch; a routine the planner doesn't hold is skipped.
        let liveItems = Set(s.items.map(\.id))
        let routines = s.routines.filter { season.routineIds.contains($0.id) }.map {
            OrganizeModel.routineRow($0, s, liveItems: liveItems, source: source)
        }
        let memberIds = containerMemberIds(.season(season), items: s.items, routines: s.routines)
        let schedule = stripSchedule(memberIds, s, source: source)
        let on = onToday(schedule, today: today)
        let items = resolved(season.itemIds, byId).map { item in
            memberRow(item, s, onToday: on, meta: [cadenceLabel(item)])
        }

        return .page(SeasonPage(
            header: header(.season, name: season.name, glyph: season.icon, color: season.color),
            notes: notes(season.notes),
            chips: chips,
            stateNote: OrganizeCopy.seasonStateNote(season, live: live),
            routines: routines,
            items: items,
            strip: dayStrip(schedule, today: today),
            empty: routines.isEmpty && items.isEmpty ? OrganizeCopy.nothingInItYet : nil
        ))
    }

    /// The Status chip's symbol: On a play mark, Off a pause, Dates a
    /// calendar.
    static func seasonStatusSymbol(_ state: String) -> String {
        switch state {
        case "active": return "play.circle"
        case "paused": return "pause.circle"
        default: return "calendar.badge.clock"
        }
    }

    // MARK: Goal

    /// A goal's page, or the switched-off sentence while Goals is off; nil
    /// when the planner no longer holds it (or never could read goals).
    static func goalPage(_ id: String, _ s: OrganizeSnapshot) -> PageContent<GoalPage>? {
        guard let goal = s.goals?.first(where: { $0.id == id }) else { return nil }
        guard s.settings.goalsEnabled else { return .switchedOff(OrganizeCopy.goalsOff) }
        let today = s.today
        let byId = itemsById(s.items)
        let progress = goalProgress(goal, itemsById: byId)
        let memberIds = containerMemberIds(.goal(goal), items: s.items, routines: s.routines)
        let schedule = deriveContainerSchedule(memberIds: memberIds, source: s.scheduleSource, from: today, days: 1,
                                               today: today)
        let on = onToday(schedule, today: today)

        let status = OrganizeCopy.label(goal.state, in: OrganizeCopy.goalStates) ?? goal.state
        var chips = [PageChip(kind: .status, text: status, systemImage: goalStatusSymbol(goal.state),
                              spoken: "Status: \(status)")]
        if let window = goalWindow(goal) {
            chips.append(PageChip(kind: .window, text: window, systemImage: "calendar",
                                  spoken: OrganizeModel.spokenSegment(window)))
        }

        var windDown: WindDown? = nil
        if !isGoalActive(goal) {
            let recurring = unique(windDownMembers(goal, itemsById: byId))
            if let sentence = OrganizeCopy.windDownSentence(goal, count: recurring.count) {
                // Each row opens the item's sheet, where Season and Delete
                // already live; the goal changes none of them, so none ticks
                // here.
                windDown = WindDown(sentence: sentence, rows: recurring.map { item in
                    memberRow(item, s, onToday: [:], meta: [cadenceLabel(item)], hidden: hiddenNote(item, s))
                })
            }
        }

        var seen = Set<UUID>()
        let milestones: [MilestoneLine] = milestoneTimeline(goal, itemsById: byId, today: today).compactMap { row in
            guard seen.insert(row.item.id).inserted else { return nil }
            return milestoneLine(row, s)
        }
        let checkins = resolved(goal.checkinIds, byId).map { item in
            memberRow(item, s, onToday: on,
                      meta: [OrganizeCopy.checkinMeta(cadence: cadenceLabel(item), lastDone: lastDoneOn(item))],
                      hidden: hiddenNote(item, s))
        }
        let groups = goalMemberGroups(goal.memberIds, itemsById: byId).map { group in
            MemberGroup(typeName: group.typeName, title: typeLabelPlural(group.typeName, labels: s.typeLabels),
                        rows: unique(group.items).map { item in
                            memberRow(item, s, onToday: on, meta: [cadenceLabel(item)], hidden: hiddenNote(item, s))
                        })
        }

        return .page(GoalPage(
            header: header(.goal, name: goal.name, glyph: goal.icon, color: goal.color),
            ring: progress.fraction.map {
                GoalRing(fraction: $0, spokenLabel: OrganizeModel.spokenProgress(goal, progress))
            },
            why: notes(goal.why),
            countdown: goalCountdown(goal, today: today),
            chips: chips,
            endedNote: OrganizeCopy.goalEndedNote(goal),
            windDown: windDown,
            // `GoalProgressTrack` draws nothing at zero milestones, its
            // elapsed line included.
            elapsed: progress.total > 0 ? timeElapsedLabel(goal, today: today) : nil,
            progress: progressLabel(goal, progress),
            progressSpoken: OrganizeModel.spokenProgress(goal, progress),
            milestones: milestones,
            milestonesEmpty: milestones.isEmpty ? OrganizeCopy.noMilestonesYet : nil,
            checkins: checkins,
            checkinsEmpty: checkins.isEmpty ? OrganizeCopy.noCheckinYet : nil,
            groups: groups,
            supportingEmpty: groups.isEmpty ? OrganizeCopy.noSupportingWork : nil
        ))
    }

    /// The window chip: "Started Oct 1 · Target Mar 15", either half alone,
    /// or nil with neither (the web's chip then offers to set a target, an
    /// edit the phone doesn't make yet).
    static func goalWindow(_ goal: Goal) -> String? {
        var parts: [String] = []
        if let start = goal.startsOn, !start.isEmpty { parts.append("Started \(formatDay(start))") }
        if let target = goal.targetOn, !target.isEmpty { parts.append("Target \(formatDay(target))") }
        return parts.isEmpty ? nil : parts.joined(separator: OrganizeModel.separator)
    }

    static func goalStatusSymbol(_ state: String) -> String {
        switch state {
        case "achieved": return "checkmark.circle"
        case "abandoned": return "pause.circle"
        default: return "play.circle"
        }
    }

    /// One timeline row, with the hidden note the web's `GoalMemberNote`
    /// adds, and its words for VoiceOver.
    static func milestoneLine(_ row: MilestoneRow, _ s: OrganizeSnapshot) -> MilestoneLine {
        let hidden = hiddenNote(row.item, s)
        var spoken = [row.item.title, row.dateLabel] + row.annotations
        if let hidden { spoken.append(hidden) }
        return MilestoneLine(item: row.item, state: row.state, dateLabel: row.dateLabel, annotations: row.annotations,
                             hiddenNote: hidden,
                             tickLabel: OrganizeCopy.milestoneTickLabel(title: row.item.title,
                                                                        reached: row.state == .achieved),
                             spokenLabel: spoken.joined(separator: ", "))
    }

    // MARK: Project

    /// A project's page; ungated, as on the web. Nil when the planner no
    /// longer holds it.
    static func projectPage(_ id: String, _ s: OrganizeSnapshot) -> PageContent<ProjectPage>? {
        guard let project = s.projects.first(where: { $0.id == id }) else { return nil }
        let today = s.today
        let byId = itemsById(s.items)
        let memberIds = containerMemberIds(.project(project), items: s.items, routines: s.routines)
        // The list row's set: every item filed under the folded name, done
        // ones included, subtasks left out, so the count is these rows.
        let listed = resolved(memberIds, byId).filter { ($0.parentItemId ?? "").isEmpty }
        let schedule = stripSchedule(memberIds, s, block: project)
        let on = onToday(schedule, today: today)
        // Open first, then done, each in planner order (a stable split).
        let ordered = listed.filter { !isRowDone($0, on: today) } + listed.filter { isRowDone($0, on: today) }
        let rows = ordered.map { item in memberRow(item, s, onToday: on, meta: [cadenceLabel(item)]) }

        let count = OrganizeModel.counted(listed.count, "item", "items")
        var chips = [PageChip(kind: .items, text: count, systemImage: "list.bullet", spoken: count)]
        if let block = timeBlockSummary(project) {
            chips.append(PageChip(kind: .timeBlock, text: block, systemImage: "clock",
                                  spoken: "Time block: " + OrganizeModel.spokenBlock(block)))
        } else {
            chips.append(PageChip(kind: .timeBlock, text: noTimeBlock, systemImage: "clock", spoken: noTimeBlock))
        }

        return .page(ProjectPage(
            header: header(.project, name: project.name, glyph: project.emoji, color: project.color),
            chips: chips,
            notes: notes(project.notes),
            items: rows,
            strip: dayStrip(schedule, today: today),
            empty: listed.isEmpty ? OrganizeCopy.nothingInItYet : nil
        ))
    }
}

extension SamplePlanner {
    /// The container a route names, or nil once it is gone (a delete from
    /// the web, a fetch without it): the page then pops itself.
    func container(_ kind: OrganizeKind, id: String) -> ScheduleContainer? {
        return ContainerPageModel.container(kind, id: id, organizeSnapshot)
    }

    /// Is the page `route` names gone? A goal is gone only when goals were
    /// read and it is not among them: a fetch that could not read goals
    /// (`goals` nil) is a lost read, not a delete, so the page keeps drawing
    /// what it last showed until a good fetch answers.
    func isGone(_ route: OrganizeRoute) -> Bool {
        switch route {
        case .container(.goal, let id):
            return goals.map { read in !read.contains { $0.id == id } } ?? false
        case .container(let kind, let id):
            return container(kind, id: id) == nil
        }
    }

    func routinePage(_ id: String) -> PageContent<RoutinePage>? {
        return ContainerPageModel.routinePage(id, organizeSnapshot)
    }

    func seasonPage(_ id: String) -> PageContent<SeasonPage>? {
        return ContainerPageModel.seasonPage(id, organizeSnapshot)
    }

    func goalPage(_ id: String) -> PageContent<GoalPage>? {
        return ContainerPageModel.goalPage(id, organizeSnapshot)
    }

    func projectPage(_ id: String) -> PageContent<ProjectPage>? {
        return ContainerPageModel.projectPage(id, organizeSnapshot)
    }

    /// May a milestone's node tick `id` on `day`? The sheet's own gate (the
    /// web's `tick` gate, and the server takes the write), which
    /// `toggle(_:on:)` asks again before it writes: a dropped (cancelled)
    /// checkpoint never ticks.
    func canTick(_ id: UUID, on day: DayString) -> Bool {
        guard let item = item(id) else { return false }
        return offers(.tick, item, verbContext(for: item, on: day))
    }
}
