import DsulCore
import Foundation

// The Schedule's day as its views draw it (Week and blocks PRs 4 to 6):
// every block with the time and length it is drawn at, where the web's
// overlap pass puts it, and what it says; and the day's Anytime rows for the
// band above the hours. Foundation only, so the shim tests it on Linux; the
// SwiftUI side is ScheduleView, ScheduleGrid, ScheduleColumn, BlockView,
// NowMarker and AnytimeBand.
//
// The day is laid out ONCE per change, by ScheduleView, and handed down as a
// value (design §5.1, "What reads what"): the column draws it, and only a
// small child reads the drag, so a ghost step derives nothing.
//
// The rules are DsulCore's: `deriveTimedEntries` and `deriveUntimedRows`
// (components/views/day-schedule.tsx), `planOverlaps` and `blockFrame`
// (lib/schedule-overlap.ts), `formatDuration` and `formatClockRange` (the
// block's words, day-schedule.tsx and components/primitives/pills.tsx),
// `verbLabel` for the tick's name (lib/item-verbs.ts), and the web's numbers
// (`ScheduleMetrics`, pinned by overlap.json's `constants`, the narrow pane's
// `paneWrapPx` among them).

/// One block on a day's grid.
struct ScheduleBlock: Identifiable, Hashable, Sendable {
    /// The item as the grid draws it (`scheduled(on:)`'s copy: a task in a
    /// project block carries the block's time and length). The sheet and the
    /// tick find the stored item by `id`.
    let item: SampleItem
    /// Minutes after midnight, as drawn.
    let startMin: Int
    /// Minutes, as drawn (0 stays 0; the pane is floored, not the length).
    let duration: Int
    /// Where the web's overlap pass puts it (DsulCore `planOverlaps`), or
    /// `.lone` when it shares its time with nothing.
    let plan: OverlapPlan
    /// Ticked on the column's day (DsulCore `isRowDone`).
    let done: Bool
    /// A skipped occurrence on the column's day: a 24pt strip with no check.
    let skipped: Bool
    /// The check's name, the web's tick label ("Mark done", "Done today",
    /// "Undo today"), on a block that draws a check: a task, or a custom type
    /// riding the task pipeline, and not skipped. Nil on a habit's block,
    /// which has no check on the web either (day-schedule.tsx `isTask`).
    let tickLabel: String?

    var id: UUID { item.id }

    /// The block draws a square check, which ticks it on the column's day.
    var hasCheck: Bool { tickLabel != nil }

    /// The project whose colour the rail and bead wear; nil draws them lime,
    /// the web's `var(--primary)` for an item with no project
    /// (day-schedule.tsx `accent`). An empty name is no project there too.
    var project: String? {
        guard let name = item.project, !name.isEmpty else { return nil }
        return name
    }

    /// Where it draws on a field `fieldWidth` wide (DsulCore `blockFrame`):
    /// the band, pane, rail and bead, and the content's band in the pane.
    func frame(fieldWidth: Double) -> BlockFrame {
        return blockFrame(startMin: startMin, duration: duration, plan: plan, fieldWidth: fieldWidth)
    }

    /// The pane is narrower than `ScheduleMetrics.paneWrapPx`: the web drops
    /// the length and the range there, so the title keeps the width. The
    /// web's measure, the field's width times the plan's share
    /// (day-schedule.tsx `paneWidthPx`). Unmeasured, nothing is narrow.
    func isNarrow(fieldWidth: Double?) -> Bool {
        guard let fieldWidth else { return false }
        return fieldWidth * plan.widthFraction < ScheduleMetrics.paneWrapPx
    }

    /// "30m", "1h 30m" (pills.tsx `formatDuration`), on the title's line;
    /// nil for a block of no length, as the web shows none.
    var durationText: String? {
        return duration > 0 ? formatDuration(duration) : nil
    }

    /// A tall block's second line, "10:00–12:00", in the user's time format.
    func rangeText(_ timeFormat: TimeFormat) -> String {
        return formatClockRange(startMin: startMin, duration: duration, timeFormat: timeFormat)
    }

    /// Running at `nowMin` (nil off today).
    func isNow(nowMin: Int?) -> Bool {
        guard let nowMin else { return false }
        return PlannerFormat.isNow(startMin: startMin, durationMin: duration, nowMin: nowMin)
    }

    /// The block to VoiceOver: "Draft Q4 roadmap, 9 to 11 AM, Work", its
    /// title, the time it is drawn at, then its project (design §5.9).
    var spokenLabel: String {
        var parts = [item.title]
        if let time = PlannerFormat.spokenRowTime(startMin: startMin, durationMin: duration) {
            parts.append(time)
        }
        if let project { parts.append(project) }
        return parts.joined(separator: ", ")
    }

    /// Its state on the day, as VoiceOver's value: "skipped", "done", "now",
    /// or nothing. One word: a skipped occurrence is never done, and done
    /// says more than now.
    func spokenValue(nowMin: Int?) -> String {
        if skipped { return "skipped" }
        if done { return "done" }
        if isNow(nowMin: nowMin) { return "now" }
        return ""
    }
}

/// A day of the Schedule, laid out: what the column and the Anytime band draw.
struct DaySchedule: Hashable, Sendable {
    let day: DayString
    /// The blocks in the grid's order (`deriveTimedEntries`), which is also
    /// the order blocks of one `z` paint in.
    let blocks: [ScheduleBlock]
    /// The day's rows off the hour grid (`deriveUntimedRows`): the band's.
    let untimed: [SampleItem]
    /// The field the overlap pass was run on, the grid right of the gutter;
    /// nil until it is measured, when no block is drawn yet.
    let fieldWidth: Double?
}

/// Sizes the block's views use beyond DsulCore's `ScheduleMetrics`.
enum ScheduleBlockMetrics {
    /// A skipped occurrence's strip (day-schedule.tsx `h-[24px]`): it keeps
    /// its bead and gives the rest of its time back to the grid.
    static let skippedStripHeight: Double = 24
    /// The hour gutter's width at the default text size (design §5.10); it
    /// grows with the text up to the first accessibility size.
    static let gutterWidth: Double = 52
    /// The check's tap target is this wide, and never taller than its pane's
    /// content band (design B25), so a tap beside a short block's check
    /// reaches the neighbour.
    static let checkTarget: Double = 44
    /// The check as drawn.
    static let checkSize: Double = 16
}

/// The Anytime band above the hours (design §5.2): its words, its fold, and
/// when it shows only its header.
enum AnytimeBandRules {
    /// Whether the band's rows are unfolded: device-local, kept in
    /// `@AppStorage`. Add, never rename: a rename loses the saved choice.
    static let storageKey = "schedule.anytimeOpen"
    /// Open until the person folds it.
    static let defaultOpen = true
    /// How many rows show before the band scrolls on its own.
    static let visibleRows = 3
    /// At the accessibility text sizes, where three rows would take most of
    /// a small phone's height from the hours.
    static let visibleRowsAtAccessibilitySizes = 1

    /// The rows the band shows before it scrolls, at this text size.
    static func visibleRows(accessibilitySize: Bool) -> Int {
        return accessibilitySize ? visibleRowsAtAccessibilitySizes : visibleRows
    }

    /// The header, always there: "Anytime", or "Anytime · 4" with rows. The
    /// phone's Buckets word for the part of the day.
    static func header(count: Int) -> String {
        let word = DayBucket.anytime.label
        return count > 0 ? "\(word) \u{00B7} \(count)" : word
    }

    /// The header to VoiceOver: "Anytime, 4 items".
    static func spokenHeader(count: Int) -> String {
        let word = DayBucket.anytime.label
        switch count {
        case 0: return word
        case 1: return word + ", 1 item"
        default: return word + ", \(count) items"
        }
    }

    /// Do the rows show? Only when unfolded, and never while the braindump
    /// sheet is up, so the grid keeps its room above a medium sheet.
    static func showsRows(open: Bool, sheetUp: Bool) -> Bool {
        return open && !sheetUp
    }

    /// What a tap on the header stores: the fold flipped, or the stored
    /// choice untouched while the sheet is up, since the header-only band is
    /// the sheet's doing, not the person's. Closing the sheet brings back
    /// the rows they had open.
    static func afterTap(open: Bool, sheetUp: Bool) -> Bool {
        return sheetUp ? open : !open
    }
}

/// A derived day's timed entries as the grid draws them
/// (day-schedule.tsx `deriveTimedEntries`), each item once, and each entry's
/// item the DRAWN copy: a task in a project block carries the block's time
/// and length. `scheduled(on:)` and `daySchedule(on:fieldWidth:)` both read
/// it, so the list and the Schedule never disagree on what is drawn.
func drawnTimedEntries(_ derived: DayItems) -> [TimedEntry] {
    var seen = Set<UUID>()
    return deriveTimedEntries(derived).compactMap { entry in
        guard seen.insert(entry.item.id).inserted else { return nil }
        var drawn = entry.item
        drawn.startTime = minutesToTime(entry.startMin)
        drawn.duration = entry.duration
        return TimedEntry(item: drawn, startMin: entry.startMin, duration: entry.duration)
    }
}

extension SamplePlanner {
    /// `day`'s Schedule, derived once for the grid and the band: the timed
    /// entries (`drawnTimedEntries`, as `scheduled(on:)` draws them) laid out
    /// by the web's overlap pass on a field `fieldWidth` wide (Day's, so
    /// crossing blocks take only the columns that clear `minChannelPx`), and
    /// the untimed rows (`anytime(on:)`'s). The tick's label and the done and
    /// skipped states are asked at `day`.
    func daySchedule(on day: DayString, fieldWidth: Double?) -> DaySchedule {
        let derived = derive(on: day)
        let entries = drawnTimedEntries(derived)
        let plans = planOverlaps(entries.map { OverlapEntry($0) }, fieldWidth: fieldWidth)
        let blocks = entries.map { entry -> ScheduleBlock in
            let drawn = entry.item
            let skipped = isSkipped(drawn, on: day)
            let tickLabel = isTaskLike(drawn) && !skipped
                ? verbLabel(.tick, drawn, verbContext(for: drawn, on: day))
                : nil
            return ScheduleBlock(item: drawn, startMin: entry.startMin, duration: entry.duration,
                                 plan: plans.plan(for: drawn.id), done: isDone(drawn, on: day), skipped: skipped,
                                 tickLabel: tickLabel)
        }
        return DaySchedule(day: day, blocks: blocks, untimed: deriveUntimedRows(derived), fieldWidth: fieldWidth)
    }

    /// A block's check: the web's row tick (`toggleRowDone`), ungated as a
    /// List row's circle, on the day `schedule` draws, never the selected
    /// day, so a column ticks its own day (Week × Schedule's seven, PR 10).
    /// The one entry ScheduleColumn calls.
    func tickBlock(_ block: ScheduleBlock, in schedule: DaySchedule) {
        toggleRow(block.id, on: schedule.day)
    }

    /// An Anytime row's tick, on the band's day (`schedule.day`), as
    /// `tickBlock`. The one entry AnytimeBand calls.
    func tickAnytimeRow(_ row: SampleItem, in schedule: DaySchedule) {
        toggleRow(row.id, on: schedule.day)
    }
}
