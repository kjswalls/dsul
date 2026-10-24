import Accessibility
import DsulCore
import Foundation

// Moving a block on the Schedule (Week and blocks PR 8, design §5.4 to §5.9):
// what a drop, the block's menu and VoiceOver's named actions do, in one
// place the shim tests on Linux. The SwiftUI side is ScheduleColumn,
// BlockView, ScheduleGrid, AnytimeBand, AnytimeRow and BraindumpSheet.
//
// The rules are DsulCore's: `planBlockDrop` (lib/block-moves.ts) says where a
// block ends up, `phoneBlockDrop` (BlockDropWrite.swift) the one existing
// intent the phone sends for it, and the menu holds the web's verbs
// (`offers`, `verbLabel`) in components/planner/item-context-menu.tsx's order.
// Nothing here decides a move on its own: each answer is the rule's, behind
// the gate its write asks (`canWrite`, `canEdit`, `offers`).
//
// Every move asks the STORED item (`item(_:)`), never the grid's drawn copy:
// a task in a project block is drawn at the block's time, and the rule reads
// `inProjectBlock` off the row as the server holds it.

/// One entry of a block's menu (hold still on a block), and of its VoiceOver
/// actions (design §5.4, §5.9).
enum BlockMenuEntry: Hashable, Sendable {
    /// The tick, under the web's label on the block's day ("Mark done",
    /// "Done today", "Undo today", "Count one (1/3)"); `done` picks its symbol.
    case tick(String, done: Bool)
    /// Unskip, in the tick's place on a skipped day.
    case unskip(String)
    case skip(String)
    case pause
    case resume
    /// "Move to tomorrow" and its kin, landing on `date`, with the day it
    /// lands on ("Fri, Oct 2") beside it.
    case nextDay(String, detail: String?, date: String)
    /// Reschedule, a submenu of the web's three quick rows.
    case reschedule(String, [RescheduleRow])
    /// Move to Braindump.
    case braindump
    /// Change length: the block's two grips show (PR 9, design §5.6).
    case changeLength
    /// Move to Anytime: the day kept, the time dropped.
    case anytime

    /// The entry's words, as the menu and VoiceOver say them.
    var title: String {
        switch self {
        case .tick(let label, _), .unskip(let label), .skip(let label), .reschedule(let label, _):
            return label
        case .nextDay(let label, _, _):
            return label
        case .pause: return "Pause"
        case .resume: return "Resume"
        case .braindump: return "Move to Braindump"
        case .changeLength: return BlockResizeWords.changeLength
        case .anytime: return BlockMoveWords.moveToAnytime
        }
    }

    /// Its SF Symbol, the item sheet's for the same verb
    /// (`ItemSheetModel.symbol`).
    var symbol: String {
        switch self {
        case .tick(_, let done): return done ? "arrow.uturn.backward" : "checkmark"
        case .unskip: return "arrow.uturn.backward"
        case .skip: return "forward.end"
        case .pause: return "pause"
        case .resume: return "play"
        case .nextDay: return "arrow.right"
        case .reschedule: return "calendar"
        case .braindump: return "tray.and.arrow.down"
        case .changeLength: return "arrow.up.and.down"
        case .anytime: return "clock.badge.xmark"
        }
    }
}

/// One of Reschedule's quick rows: Today, Tomorrow, Next week.
struct RescheduleRow: Hashable, Sendable {
    let title: String
    /// yyyy-MM-dd.
    let date: String
    let symbol: String

    /// The web's three rows (item-context-menu.tsx), under the item sheet's
    /// words and symbols for the same days (`ItemSheetModel.dateOptions`):
    /// today, tomorrow, and the first day of next week.
    static func quickRows(today: DayString, nextWeekStart: DayString) -> [RescheduleRow] {
        return [
            RescheduleRow(title: "Today", date: today.description, symbol: "sun.max"),
            RescheduleRow(title: "Tomorrow", date: today.adding(days: 1).description, symbol: "sunrise"),
            RescheduleRow(title: "Next week", date: nextWeekStart.description, symbol: "calendar.badge.plus"),
        ]
    }
}

/// A block's menu in the web's three groups (design §5.4), each entry behind
/// its gate. Delete and Leave block are not in it (design §1).
struct BlockMenu: Hashable, Sendable {
    /// The tick or Unskip, then Skip, then Pause or Resume.
    var status: [BlockMenuEntry]
    /// The next day, Reschedule, Move to Braindump.
    var moves: [BlockMenuEntry]
    /// The phone's own: Change length, then Move to Anytime.
    var own: [BlockMenuEntry]

    static let empty = BlockMenu(status: [], moves: [], own: [])

    /// Every entry, in order.
    var entries: [BlockMenuEntry] { status + moves + own }
}

/// One of a block's VoiceOver actions (design §5.9). Named actions only,
/// never the adjustable trait: a stray swipe would move a series on every
/// day, with no undo.
enum BlockSpokenAction: Hashable, Sendable {
    /// A menu entry (every one but Reschedule, whose choices are the sheet's).
    case entry(BlockMenuEntry)
    /// "15 minutes later": the write a drop at that start makes.
    case later
    /// "15 minutes earlier".
    case earlier
    /// "Make 15 minutes longer": the bottom grip a quarter hour down.
    case longer
    /// "Make 15 minutes shorter": the bottom grip a quarter hour up.
    case shorter

    var name: String {
        switch self {
        case .entry(let entry): return entry.title
        case .later: return BlockMoveWords.later
        case .earlier: return BlockMoveWords.earlier
        case .longer: return BlockResizeWords.longer
        case .shorter: return BlockResizeWords.shorter
        }
    }
}

/// The words a move says (design §11).
enum BlockMoveWords {
    /// The Anytime band's header while a drag is in the air
    /// (components/views/day-schedule.tsx).
    static let anytimeHint = "Drop here to keep it time-free"
    static let moveToAnytime = "Move to Anytime"
    static let later = "15 minutes later"
    static let earlier = "15 minutes earlier"
    /// How far one of VoiceOver's steps moves a block: the grid's snap.
    static let step = ScheduleMetrics.snapMin
    static let movedToAnytime = "Moved to Anytime"

    /// The Anytime band header's spoken label: its own (`spoken`), and while
    /// a drag is in the air the hint the screen shows in its place, so a
    /// VoiceOver drag hears where it can go too.
    static func anytimeHeader(_ spoken: String, dragging: Bool) -> String {
        return dragging ? "\(spoken), \(anytimeHint)" : spoken
    }

    /// What VoiceOver says after a move (design §5.5), in the clock the
    /// block's label already speaks (`PlannerFormat.clock`): "Moved to 10:15
    /// AM", "Moved to Thursday at 10:15 AM" for a one-off that changed day,
    /// "Moved to Anytime" or "Moved to the braindump"; a repeating item adds
    /// that it moved on every day it falls on: "Moved to 8 AM, every day it
    /// repeats". Whether it repeats is the registry's answer, a NULL
    /// frequency read as the type's default (a habit's is daily), as the
    /// server's `ctx.recurring` reads it. Nil for an answer that moves
    /// nothing.
    static func announcement(_ drop: BlockDrop, item: SampleItem, from origin: BlockOrigin) -> String? {
        let frequency = item.repeatFrequency ?? caps(item.typeName).defaultFrequency
        let repeats = isRecurring(RepeatRule(frequency: frequency, days: item.repeatDays,
                                             monthDay: item.repeatMonthDay))
        switch drop {
        case let .place(date, startMin):
            let clock = PlannerFormat.clock(startMin)
            if repeats { return "Moved to \(clock), every day it repeats" }
            if date != origin.date, let day = DayString(date) {
                return "Moved to \(PlannerFormat.weekdayName(day)) at \(clock)"
            }
            return "Moved to \(clock)"
        case let .retime(startMin):
            let clock = PlannerFormat.clock(startMin)
            return repeats ? "Moved to \(clock), every day it repeats" : "Moved to \(clock)"
        case .anytime:
            return movedToAnytime
        case .braindump:
            return "Moved to the braindump"
        case .pause, BlockDrop.none, .refused:
            return nil
        }
    }
}

/// The edge autoscroll while a drag hovers over the grid (design §5.4, B9).
enum ScheduleAutoscroll {
    /// Whether the phone scrolls the top edge itself. Off: dragging up past
    /// the top is left to the system's own drag autoscroll, as the spike
    /// assumed, and only the bottom edge, which the braindump sheet can
    /// cover, is driven by hand. Turn it on if device check M3
    /// (ios/README.md, "Moving a block") finds the grid doesn't scroll up;
    /// with both on, the two would scroll it twice.
    static let handDrivesTopEdge = false

    /// Whether the phone scrolls Week × Schedule's columns sideways itself
    /// while a drag rests at a side edge (`SideAutoscroll`, PR 10). On: the
    /// columns are a scroll view inside the hours' scroll view, which the
    /// system's drag autoscroll is not known to reach. Turn it off if device
    /// check W-S3 (ios/README.md, "Checking Week × Schedule") finds the
    /// columns scroll twice at an edge, the system's and this one.
    static let handDrivesSideEdges = true

    /// Whether the phone scrolls Week × Schedule's top edge itself, from just
    /// below the pinned strips (`visibleTop: hoursTop`, design §4.5): on,
    /// since the system's own zone sits at the top of the scroll view, under
    /// the headings, where a finger over the hours never is. Turn it off if
    /// device check W-S3 (ios/README.md, "Checking Week × Schedule") finds
    /// the hours scroll up twice as fast just below the strips, the system's
    /// and this one. If they scroll while the finger is over a strip or a
    /// heading, that is the system's zone, which no switch here reaches: the
    /// design's fallback is heads that scroll away with the hours.
    static let handDrivesWeekTopEdge = true

    /// Does a drag scroll the top edge by hand? Behind `handDrivesTopEdge`
    /// on Day; under Week × Schedule's pinned heads (`hoursTop` above 0),
    /// behind `handDrivesWeekTopEdge`, whose zone starts below the strips.
    static func drivesTopEdge(hoursTop: Double) -> Bool {
        return handDrivesTopEdge || (hoursTop > 0 && handDrivesWeekTopEdge)
    }

    /// One frame's scroll, in points (negative is up), for a finger
    /// `fingerY` points down the grid's viewport, `viewportH` tall with its
    /// bottom `coveredBottom` points under the sheet and its top `visibleTop`
    /// points under Week's pinned heads: DsulCore's `autoscrollStep` over the
    /// part of the grid that shows, with the top edge only when `topEdge`.
    static func step(fingerY: Double, viewportH: Double, coveredBottom: Double, dt: Double,
                     topEdge: Bool = handDrivesTopEdge, visibleTop: Double = 0) -> Double {
        let step = autoscrollStep(fingerY: fingerY, visibleTop: visibleTop, visibleBottom: viewportH - coveredBottom,
                                  dt: dt)
        return step < 0 && !topEdge ? 0 : step
    }
}

extension SamplePlanner {
    /// What every block drop is asked with: the goals' milestones, nil while
    /// they are unread (only the braindump reads them, and refuses then).
    var blockDropContext: BlockDropContext {
        return BlockDropContext(milestoneIds: milestoneIds)
    }

    /// Where `id` is lifted from on `day`: that day, and whether its
    /// occurrence there is skipped (a skipped strip goes nowhere).
    func blockOrigin(_ id: UUID, on day: DayString) -> BlockOrigin {
        let skipped = item(id).map { isSkipped($0, on: day) } ?? false
        return BlockOrigin(day: day, skipped: skipped)
    }

    /// The write the phone sends for `item` let go on `target`, or nil to send
    /// nothing: the rule's answer, mapped (DsulCore `phoneBlockDrop`), behind
    /// the gate that write asks (`takes`).
    func blockDropWrite(_ item: SampleItem, from origin: BlockOrigin, to target: BlockTarget,
                        context: BlockDropContext) -> BlockDropWrite? {
        guard let write = phoneBlockDrop(item, from: origin, target: target, context: context).write else {
            return nil
        }
        return takes(write, item, from: origin) ? write : nil
    }

    /// Does this server, and this item, take `write`? `schedule` when the
    /// server lists it (never a habit, which the route answers
    /// `not_schedulable`, though the rule never places one); a time edit
    /// behind `canEdit(edit, item)`, which also refuses a subtask's time as
    /// the route does; `unschedule` behind Move to Braindump's own gate
    /// (`offers(.braindump)`) on the day it was lifted from.
    private func takes(_ write: BlockDropWrite, _ item: SampleItem, from origin: BlockOrigin) -> Bool {
        switch write {
        case .schedule:
            return canWrite(write.action) && !item.isHabit
        case .time(let change):
            return canEdit(change, item)
        case .unschedule:
            guard let day = DayString(origin.date) else { return false }
            return offers(.braindump, item, verbContext(for: item, on: day))
        }
    }

    /// The destination's proposal while `id` is in the air over `target`
    /// (design §5.4, §5.8): true for the system's forbidden badge, when the
    /// rule or the phone refuses the drop, or its write is one this server or
    /// item won't take. Already there is not refused: the block lands where
    /// it was. An item the planner doesn't hold is refused.
    func refusesDrop(_ id: UUID?, from origin: BlockOrigin, to target: BlockTarget) -> Bool {
        guard let id, let item = item(id) else { return true }
        let answer = phoneBlockDrop(item, from: origin, target: target, context: blockDropContext)
        if answer.isForbidden { return true }
        guard let write = answer.write else { return false }
        return !takes(write, item, from: origin)
    }

    /// Moves `id`, lifted from `origin`, to `target`: the rule's answer
    /// (`planBlockDrop`), its one write (`phoneBlockDrop`), its optimistic
    /// step, and VoiceOver's announcement. A drop, a VoiceOver step, Move to
    /// Anytime and the menu's Move to Braindump all come here.
    ///
    /// - `schedule {date, startTime}`: the hour drop's step (`placing`) on the
    ///   rule's date, which for a repeating task in a project block is its
    ///   own start date, never the column it was let go on.
    /// - a time edit: `edit(_:_:)`, which sends nothing when the item already
    ///   says it.
    /// - `unschedule`: `unschedule(_:on:)`, Move to Braindump.
    ///
    /// Nothing is sent for an answer the phone refuses or a write the gates
    /// refuse. Also ends the drag's hold on fetched data, as the braindump's
    /// drop does: the drop has landed, whatever it did. Returns the rule's
    /// answer when the item moved, else nil.
    @discardableResult
    func moveBlock(_ id: UUID, from origin: BlockOrigin, to target: BlockTarget) -> BlockDrop? {
        return moveBlock(id, from: origin, to: target, context: blockDropContext)
    }

    /// `moveBlock(_:from:to:)` asked with `context`, for a hosted test that
    /// plays block-moves.json's own milestones.
    @discardableResult
    func moveBlock(_ id: UUID, from origin: BlockOrigin, to target: BlockTarget,
                   context: BlockDropContext) -> BlockDrop? {
        DragHold.shared.releaseNow()
        guard let before = item(id) else { return nil }
        let drop = planBlockDrop(before, from: origin, target: target, context: context)
        guard let write = phoneBlockDrop(drop).write, takes(write, before, from: origin) else { return nil }
        switch write {
        case let .schedule(date, startMin):
            // As the edit, move and unschedule paths do: nothing is sent for
            // a placement that changes nothing (the rule answers `none` for
            // one before this, so it is the gate's backstop).
            let placed = placing(before, on: date, startMin: startMin)
            guard placed != before, let i = items.firstIndex(where: { $0.id == id }) else { return nil }
            items[i] = placed
            sync?.enqueue(.schedule(id: id, date: date, startTime: startTimeOf(startMin)), snapshot: before)
        case .time(let change):
            edit(id, change)
        case .unschedule:
            guard let day = DayString(origin.date) else { return nil }
            unschedule(id, on: day)
        }
        guard item(id) != before else { return nil }
        if let words = BlockMoveWords.announcement(drop, item: before, from: origin) {
            announceMove(words)
        }
        return drop
    }

    /// Where a drop of `id` came from, for the drop handlers (the grid, the
    /// band, the braindump sheet), on a surface that draws `day`. What the
    /// drag says of this item (`said`, `ScheduleDrag.source(of:)`) when it
    /// lifted off a day; otherwise the item itself decides: a braindump
    /// member is a braindump row, anything else is drawn on `day`. So a drop
    /// whose lift was missed (no `.initial`, the drag in memory another
    /// item's or none), or whose memory says braindump of a row that has
    /// since been placed, never puts a placed block down through the
    /// braindump's own hour drop (`schedule` on the selected day), which
    /// would re-anchor a series.
    func dropSource(_ id: UUID, said: DragSource?, on day: DayString) -> DragSource {
        if let said, said.day != nil { return said }
        return braindump.contains { $0.id == id } ? .braindump : .block(day: day)
    }

    /// `id` let go on `day`'s hours at `startMin`, by whichever surface took
    /// it: Day's grid or a Week × Schedule column (PR 10). Routed by the item
    /// (`dropSource`, with what the drag says of it, `said`): a block or an
    /// Anytime row moves by the drop rule from the day it was lifted on
    /// (`moveBlock`), so a one-off carried to another column takes that
    /// column's day and a habit or a series keeps its own (B18); a braindump
    /// row keeps its hour drop on `day` (`schedule(_:on:startMin:)`).
    func dropOnHour(_ id: UUID, said: DragSource?, on day: DayString, startMin: Int) {
        switch dropSource(id, said: said, on: day) {
        case .block(let from), .anytime(let from):
            moveBlock(id, from: blockOrigin(id, on: from), to: .hour(date: day.description, startMin: startMin))
        case .braindump:
            schedule(id, on: day, startMin: startMin)
        }
    }

    /// `id` let go on `day`'s Anytime band (Day) or strip (a Week × Schedule
    /// column), routed as `dropOnHour` is: a block or an Anytime row by the
    /// drop rule to `.anytime` (which refuses another day's, B22), a
    /// braindump row through `placeAnytime`.
    func dropOnAnytime(_ id: UUID, said: DragSource?, on day: DayString) {
        switch dropSource(id, said: said, on: day) {
        case .block(let from), .anytime(let from):
            moveBlock(id, from: blockOrigin(id, on: from), to: .anytime(date: day.description))
        case .braindump:
            placeAnytime(id, on: day)
        }
    }

    /// The band's or a strip's proposal while `id` is in the air over
    /// `day`'s Anytime (design §5.4): true for the forbidden badge. A block
    /// or an Anytime row asks the drop rule from the day it was lifted on
    /// (`refusesDrop`), which refuses another day's Anytime in v1 (B22); a
    /// braindump row, or a drag whose lift was missed, asks the Date chip's
    /// gate (`canPlaceAnytime`). With nothing in the air, it refuses.
    func refusesAnytimeDrop(_ id: UUID?, source: DragSource?, on day: DayString) -> Bool {
        guard let id else { return true }
        switch source {
        case .block(let from)?, .anytime(let from)?:
            return refusesDrop(id, from: blockOrigin(id, on: from), to: .anytime(date: day.description))
        case .braindump?, nil:
            return !canPlaceAnytime(id, on: day)
        }
    }

    /// May `id` go to Anytime on `day`, keeping the day and dropping its
    /// time? The rule's Anytime answer on its own day, behind the time
    /// edit's gate: never a block in a project block (`in-block`), nor one
    /// already there.
    func canMoveToAnytime(_ id: UUID, on day: DayString) -> Bool {
        guard let item = item(id) else { return false }
        return blockDropWrite(item, from: blockOrigin(id, on: day), to: .anytime(date: day.description),
                              context: blockDropContext) != nil
    }

    /// Move to Anytime (the block's menu, VoiceOver, or a drop on the band):
    /// `time {timeBucket: "anytime", startTime: null}`.
    @discardableResult
    func moveToAnytime(_ id: UUID, on day: DayString) -> BlockDrop? {
        return moveBlock(id, from: blockOrigin(id, on: day), to: .anytime(date: day.description))
    }

    /// May the braindump row `id` land on `day`'s Anytime band? The Date
    /// chip's gate (`offers(.reschedule)`, lib/row-moves.ts `canReschedule`,
    /// which `move` asks of the target day as the server does), and a move
    /// that changes something, so the band never takes a drop the server
    /// answers with a 409. A done row is refused.
    func canPlaceAnytime(_ id: UUID?, on day: DayString) -> Bool {
        guard let id, let item = item(id) else { return false }
        return offers(.reschedule, item, verbContext(for: item, on: day))
            && moving(item, to: day.description) != item
    }

    /// A braindump row dropped on `day`'s Anytime band (design §5.2): `move
    /// {date}`, the Date chip's write, which gives an undated task the date
    /// and the Anytime bucket and so takes it out of the braindump. Ends the
    /// drag's hold, as every drop does.
    func placeAnytime(_ id: UUID, on day: DayString) {
        DragHold.shared.releaseNow()
        guard canPlaceAnytime(id, on: day) else { return }
        let before = item(id)
        move(id, to: day.description)
        if item(id) != before {
            announceMove(BlockMoveWords.movedToAnytime)
        }
    }

    /// Can `block` lift at all? A block whose every target the rule refuses
    /// never lifts (design §5.5): a skipped strip, or one whose writes this
    /// server won't take. Asked of three targets, the ones a drag can reach
    /// on Day: another quarter hour on its day, its day's Anytime, and the
    /// braindump.
    func canLift(_ block: ScheduleBlock, in schedule: DaySchedule) -> Bool {
        guard !block.skipped, let item = item(block.id) else { return false }
        let day = schedule.day.description
        let step = BlockMoveWords.step
        let probe = block.startMin + step < 24 * 60 ? block.startMin + step : block.startMin - step
        return goesSomewhere(item, from: blockOrigin(block.id, on: schedule.day),
                             to: [.hour(date: day, startMin: probe), .anytime(date: day), .braindump])
    }

    /// Can the Anytime row `row` lift off `day`'s band? As `canLift`: never
    /// a skipped row, and only when a target in reach takes a write: an hour
    /// of its day (the minute is moot for a row with no time: any hour
    /// places or retimes it) or the braindump.
    func canLiftRow(_ row: SampleItem, on day: DayString) -> Bool {
        guard let item = item(row.id), !isSkipped(item, on: day) else { return false }
        return goesSomewhere(item, from: blockOrigin(row.id, on: day),
                             to: [.hour(date: day.description, startMin: 9 * 60), .braindump])
    }

    /// Does any of `targets` take a write for `item` lifted from `origin`?
    private func goesSomewhere(_ item: SampleItem, from origin: BlockOrigin, to targets: [BlockTarget]) -> Bool {
        return targets.contains { blockDropWrite(item, from: origin, to: $0, context: blockDropContext) != nil }
    }

    /// The day a lifted block's ghost stays on while the finger crosses other
    /// columns (B18): its own, for a block the rule moves in time only (a
    /// habit, a dated series), whatever column it is let go on; nil for one
    /// a drop may carry to another day. Asked of the rule: let go at another
    /// minute on the next day's hour, it keeps its date. Day has one column,
    /// so only Week × Schedule (PR 10) draws the difference.
    func confinedDay(_ id: UUID, from day: DayString) -> DayString? {
        guard let item = item(id) else { return nil }
        let other = day.adding(days: 1).description
        let minute = ((item.startMin ?? 0) + BlockMoveWords.step) % (24 * 60)
        switch planBlockDrop(item, from: BlockOrigin(day: day, skipped: false),
                             target: .hour(date: other, startMin: minute), context: blockDropContext) {
        case .retime:
            return day
        case .place(let date, _) where date != other:
            return day
        default:
            return nil
        }
    }

    /// VoiceOver's "15 minutes later" (`by` 15) or "earlier" (-15): the hour
    /// drop at that start on the block's own day, from where it is drawn.
    private func nudgeTarget(_ block: ScheduleBlock, in schedule: DaySchedule, by minutes: Int) -> BlockTarget {
        return .hour(date: schedule.day.description, startMin: block.startMin + minutes)
    }

    /// Is the step offered? Only when the rule's answer is a write the gates
    /// take: never past midnight either way, and never for a block that
    /// can't move.
    func canNudge(_ block: ScheduleBlock, in schedule: DaySchedule, by minutes: Int) -> Bool {
        guard let item = item(block.id) else { return false }
        return blockDropWrite(item, from: blockOrigin(block.id, on: schedule.day),
                              to: nudgeTarget(block, in: schedule, by: minutes), context: blockDropContext) != nil
    }

    /// One VoiceOver step, one write (design §7).
    @discardableResult
    func nudge(_ block: ScheduleBlock, in schedule: DaySchedule, by minutes: Int) -> BlockDrop? {
        return moveBlock(block.id, from: blockOrigin(block.id, on: schedule.day),
                         to: nudgeTarget(block, in: schedule, by: minutes))
    }

    /// `block`'s menu on `schedule`'s day (design §5.4): the web's verbs in
    /// item-context-menu.tsx's order, each behind the sheet's own gate
    /// (`offers`) and under the web's label ("today" kept on today alone,
    /// `ItemSheetModel.onDay`, as the web's `onDay`), then Change length
    /// (`canResize`) and Move to Anytime.
    func blockMenu(for block: ScheduleBlock, in schedule: DaySchedule) -> BlockMenu {
        guard let item = item(block.id) else { return .empty }
        let day = schedule.day
        let ctx = verbContext(for: item, on: day)
        func can(_ verb: VerbID) -> Bool { offers(verb, item, ctx) }
        func label(_ verb: VerbID) -> String { ItemSheetModel.onDay(verbLabel(verb, item, ctx), ctx) }

        var status: [BlockMenuEntry] = []
        if can(.unskip) {
            status.append(.unskip(label(.unskip)))
        } else if can(.tick) {
            status.append(.tick(label(.tick), done: isDoneOn(item, on: ctx.dateStr)))
        }
        if can(.skip) { status.append(.skip(label(.skip))) }
        if can(.resume) {
            status.append(.resume)
        } else if can(.pause) {
            status.append(.pause)
        }

        var moves: [BlockMenuEntry] = []
        if can(.nextDay) {
            moves.append(.nextDay(verbLabel(.nextDay, item, ctx), detail: verbDetail(.nextDay, item, ctx),
                                  date: nextDayOf(item, ctx)))
        }
        if can(.reschedule) {
            moves.append(.reschedule(verbLabel(.reschedule, item, ctx),
                                     RescheduleRow.quickRows(today: today, nextWeekStart: nextWeekStart)))
        }
        if can(.braindump) { moves.append(.braindump) }

        var own: [BlockMenuEntry] = []
        if canResize(block, in: schedule) { own.append(.changeLength) }
        if canMoveToAnytime(block.id, on: day) { own.append(.anytime) }
        return BlockMenu(status: status, moves: moves, own: own)
    }

    /// `block`'s VoiceOver actions (design §5.9), each only when its gate
    /// allows, in the menu's order: the tick or Unskip, Skip, Pause or
    /// Resume, the next-day label, Move to Braindump, then "15 minutes
    /// later", "15 minutes earlier", "Make 15 minutes longer", "Make 15
    /// minutes shorter" and Move to Anytime. Reschedule is the sheet's (its
    /// choices are a submenu), and Change length the menu's alone: the
    /// length pair needs no grips.
    func spokenActions(for block: ScheduleBlock, in schedule: DaySchedule) -> [BlockSpokenAction] {
        let menu = blockMenu(for: block, in: schedule)
        var actions: [BlockSpokenAction] = (menu.status + menu.moves).compactMap { entry in
            if case .reschedule = entry { return nil }
            return .entry(entry)
        }
        if canNudge(block, in: schedule, by: BlockMoveWords.step) { actions.append(.later) }
        if canNudge(block, in: schedule, by: -BlockMoveWords.step) { actions.append(.earlier) }
        if canChangeLength(block, in: schedule, by: BlockResizeWords.step) { actions.append(.longer) }
        if canChangeLength(block, in: schedule, by: -BlockResizeWords.step) { actions.append(.shorter) }
        actions += menu.own.compactMap { entry in
            if case .changeLength = entry { return nil }
            return .entry(entry)
        }
        return actions
    }

    /// Runs a menu entry on `block`, on `schedule`'s day: each verb's own
    /// write, gated again as it is when the sheet runs it. Reschedule's
    /// choices run `move(_:to:)` with their date; its own row does nothing,
    /// and so does Change length, which writes nothing until a grip is let
    /// go (the column selects the block, `BlockResize.select`).
    func run(_ entry: BlockMenuEntry, on block: ScheduleBlock, in schedule: DaySchedule) {
        let id = block.id
        let day = schedule.day
        switch entry {
        case .tick: toggle(id, on: day)
        case .unskip: unskip(id, on: day)
        case .skip: skip(id, on: day)
        case .pause: pause(id, until: nil)
        case .resume: resume(id)
        case .nextDay(_, _, let date): move(id, to: date)
        case .reschedule: break
        case .braindump: moveBlock(id, from: blockOrigin(id, on: day), to: .braindump)
        case .changeLength: break
        case .anytime: moveToAnytime(id, on: day)
        }
    }

    /// Says a move or a length to VoiceOver once the block has settled where
    /// it landed: a moment after the drop, the release or the action, so the
    /// element's own change doesn't cut it off (Organize's
    /// `SettledAnnouncement` waits the same way).
    func announceMove(_ words: String) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(300))
            AccessibilityNotification.Announcement(AttributedString(words)).post()
        }
    }

    /// Runs one of `block`'s VoiceOver actions.
    func run(_ action: BlockSpokenAction, on block: ScheduleBlock, in schedule: DaySchedule) {
        switch action {
        case .entry(let entry): run(entry, on: block, in: schedule)
        case .later: nudge(block, in: schedule, by: BlockMoveWords.step)
        case .earlier: nudge(block, in: schedule, by: -BlockMoveWords.step)
        case .longer: changeLength(block, in: schedule, by: BlockResizeWords.step)
        case .shorter: changeLength(block, in: schedule, by: -BlockResizeWords.step)
        }
    }
}
