import DsulCore
import Foundation
import Observation

// Changing a block's length on the Schedule (Week and blocks PR 9, design
// §5.6, §5.8, §5.9, B3, B4, B14, B16, B25): which block is selected, a grip
// in the hand and what it shows, where the two grips sit, and what letting
// go writes, in one place the shim tests on Linux. The SwiftUI side is
// ScheduleColumn (the grips, their gesture, the selected block's outline and
// live length), ScheduleGrid (a tap elsewhere, the viewport's coordinate
// space) and ScheduleView (the grip's autoscroll, and the sheets and days
// that clear the selection).
//
// The maths is DsulCore's (`resizeDeltaMin`, `resizePreview`, `resizeWrite`,
// lib/schedule-resize.ts), and every write is the existing `time` edit
// (`ResizeWrite.edit`) through `SamplePlanner.edit`, so PlannerSync sends it
// and a failed one puts the block back, as every write does. No new intent,
// route or write kind.
//
// Two rules the maths leaves to its caller, both the web's:
// - A press alone shows the block as it was pressed. `resizePreview` snaps
//   even with no travel (a 9:10 block's top grip answers 9:15 at 0), and the
//   web asks it only once the pointer or the grid has moved, so a grip
//   pressed and let go without moving writes nothing. Once it has moved it is
//   always asked, even with the finger back where it began. The phone's
//   "moved" is a travel of `ResizeGrips.slop` or more, since a resting finger
//   drifts by fractions of a point that a mouse never does; and the grip's
//   autoscroll waits for it too, so a still finger near the top or bottom of
//   the grid never scrolls the edge on its own.
// - The travel is the finger's movement in the hours' viewport, which never
//   scrolls, plus the grid's scroll since the press (day-schedule.tsx
//   `applyResize`: pointer delta plus scrollTop delta), so the autoscroll
//   keeps the edge under a still finger. Measured in the scrolling content
//   instead, the finger's movement would count the scroll twice.

/// A block chosen through Change length, on the day of the column that
/// draws it. Only the column of that day shows its grips, so Week ×
/// Schedule's seven columns (PR 10) never show two.
struct BlockSelection: Hashable, Sendable {
    let id: UUID
    let day: DayString
}

/// What letting go of a grip asks the planner to write: the block's id, the
/// edge that moved, the block as it was pressed and where it was let go
/// (`SamplePlanner.resize`, which writes nothing when the two are the same
/// length and start).
struct GripRelease: Hashable, Sendable {
    let id: UUID
    let edge: ResizeEdge
    let from: BlockSpan
    let to: BlockSpan
}

/// The selected block and the grip in the hand (design §5.6). Owned by
/// `ScheduleDrag` (`drag.resize`), whose every lift clears the selection, so
/// a drop never leaves grips behind (B3).
///
/// What the views read, and so re-render on: `selected` (every block's
/// reader, once per selection), `shown` (the selected block's reader and the
/// grips, once per 15-minute step), `edge` and `moved` (the autoscroll's
/// switch, at a press's first move and at its release), and the haptics' two
/// counters. The finger itself is ignored by Observation, so a finger that
/// moves inside one 15-minute step re-renders nothing.
///
/// Each press has a number (`presses` when it began), and a grip's gesture
/// follows, lets go of and cancels only the press it made, so a second
/// finger on the other grip neither drives nor ends the first one's.
@Observable @MainActor
final class BlockResize {
    /// The block whose grips show; nil when none is.
    private(set) var selected: BlockSelection?
    /// The grip in the hand, from the press to the release; nil otherwise.
    private(set) var edge: ResizeEdge?
    /// The block as the grip in the hand draws it: as pressed until the
    /// travel reaches `ResizeGrips.slop`, then `resizePreview`'s answer. Nil
    /// with no grip in the hand, when the block draws as the day lays it out.
    private(set) var shown: BlockSpan?
    /// One more each time `shown` changes: the `.selection` haptic's trigger,
    /// a tick per 15-minute step (design §5.8).
    private(set) var steps = 0
    /// One more at each press: the light impact's trigger (design §5.8).
    private(set) var presses = 0

    /// The block as it was pressed.
    @ObservationIgnored private var from: BlockSpan?
    /// The grid's scroll offset at the press.
    @ObservationIgnored private var scrollAtPress: Double = 0
    /// The finger's movement since the press, in the viewport's points.
    @ObservationIgnored private var translationY: Double = 0
    /// The gesture's own translation at the press, taken off every later
    /// one, so a press made mid-gesture (a finger that found the other grip
    /// in the hand, then saw it let go) starts from where the finger is.
    @ObservationIgnored private var translationAtPress: Double = 0
    /// The travel has reached `ResizeGrips.slop` since the press: from here
    /// on it is always asked of `resizePreview`, and the autoscroll runs.
    private(set) var moved = false
    /// The finger's height in the hours' viewport, for the autoscroll.
    @ObservationIgnored private(set) var fingerY: Double?

    /// A grip is in the hand.
    var isHeld: Bool { edge != nil }

    /// The grip in the hand has moved, so the edge autoscroll runs for it
    /// (design §5.6). Not at the press: a still finger within the edge zone
    /// would scroll the grid, and the scroll would move the edge and write.
    var drivesAutoscroll: Bool { edge != nil && moved }

    /// A grip is in the hand and it is the press numbered `press`.
    func holds(_ press: Int?) -> Bool {
        guard let press else { return false }
        return owns(press)
    }

    /// Is `id` on `day` the selected block?
    func isSelected(_ id: UUID, on day: DayString) -> Bool {
        return selected == BlockSelection(id: id, day: day)
    }

    /// Change length, picked from `id`'s menu on `day`'s column: its grips
    /// show, and any other block's go. The only way a block is selected.
    func select(_ id: UUID, on day: DayString) {
        letGo()
        selected = BlockSelection(id: id, day: day)
    }

    /// No block selected, and a grip in the hand let go with nothing written:
    /// a tap elsewhere on the grid, a sheet, another day, a lift, the block
    /// leaving the day, the Schedule going away.
    func clear() {
        letGo()
        selected = nil
    }

    /// A grip of the selected block pressed (its gesture's first callback,
    /// at touch-down): `from` is the block as the day draws it (its length
    /// already the type's default when the item has none, as the web's
    /// `entry`), `scrollOffset` the grid's offset now, `fingerY` the
    /// finger's height in the viewport and `translationY` the gesture's own
    /// translation so far (0 at touch-down). The block shows as pressed, the
    /// light impact fires, and the hold on fetched data is taken, as a
    /// block's lift takes it (design §5.4, B20). Returns the press's number,
    /// which the gesture passes back to `follow`, `release` and `cancel`.
    /// Nothing without a selection, or while a grip is already in the hand
    /// (a second finger on the other grip).
    @discardableResult
    func press(_ edge: ResizeEdge, from span: BlockSpan, scrollOffset: Double, fingerY: Double,
               translationY: Double = 0) -> Int? {
        guard selected != nil, !isHeld else { return nil }
        self.edge = edge
        from = span
        shown = span
        scrollAtPress = scrollOffset
        translationAtPress = translationY
        self.translationY = 0
        if moved { moved = false }
        self.fingerY = fingerY
        presses += 1
        DragHold.shared.hold()
        return presses
    }

    /// The finger in the hand moved, or reported where it is: the gesture's
    /// `translationY` and `fingerY` in the viewport, with the grid at
    /// `scrollOffset`. Returns the block as it now shows. Nothing with no
    /// grip in the hand, or when `press` is given and the grip in the hand
    /// is another press.
    @discardableResult
    func follow(translationY: Double, fingerY: Double, scrollOffset: Double, press: Int? = nil) -> BlockSpan? {
        guard owns(press) else { return nil }
        self.translationY = translationY - translationAtPress
        self.fingerY = fingerY
        return preview(scrollOffset: scrollOffset)
    }

    /// The grid scrolled to `offset` under the finger (the grip's autoscroll):
    /// the travel takes the scroll in, so the edge keeps following the finger.
    @discardableResult
    func scrolled(to offset: Double) -> BlockSpan? {
        guard isHeld else { return nil }
        return preview(scrollOffset: offset)
    }

    /// Where the edge lands for the travel so far: the finger's movement plus
    /// the grid's, in minutes at the grid's 75pt hour (`resizeDeltaMin`),
    /// through `resizePreview`. The block as pressed until the travel first
    /// reaches the slop.
    private func preview(scrollOffset: Double) -> BlockSpan? {
        guard let edge, let from else { return nil }
        let points = translationY + (scrollOffset - scrollAtPress)
        if !moved && abs(points) >= ResizeGrips.slop { moved = true }
        DragHold.shared.renew()
        guard moved else { return shown }
        let travel = resizeDeltaMin(points, hourPx: ScheduleMetrics.hourPx)
        let next = resizePreview(edge: edge, from: from, deltaMin: travel)
        if next != shown {
            shown = next
            steps += 1
        }
        return shown
    }

    /// The finger let go: what to write (`SamplePlanner.resize`), the
    /// selection kept so the grips stay for another go. Nil with no grip in
    /// the hand, or when `press` is given and the grip in the hand is another
    /// press, which is then kept. The hold on fetched data goes at once, as
    /// a drop lets it go.
    func release(press: Int? = nil) -> GripRelease? {
        guard owns(press) else { return nil }
        guard let edge, let from, let shown, let selected else {
            letGo()
            return nil
        }
        let release = GripRelease(id: selected.id, edge: edge, from: from, to: shown)
        letGo()
        return release
    }

    /// The gesture was cancelled (its state reset with no end, or its view
    /// went away mid-press): the block goes back as it was and nothing is
    /// written. Only the press numbered `press` (`presses` when it began),
    /// so a late cancel never lets go of a newer press; nil lets go of any.
    func cancel(press: Int? = nil) {
        guard owns(press) else { return }
        letGo()
    }

    /// A grip is in the hand, and it is the press numbered `press` when one
    /// is given (nil: whichever).
    private func owns(_ press: Int?) -> Bool {
        return isHeld && (press == nil || press == presses)
    }

    /// No grip in the hand: the block draws as the day lays it out again,
    /// and the hold on fetched data is let go.
    private func letGo() {
        let held = isHeld
        edge = nil
        shown = nil
        from = nil
        translationY = 0
        translationAtPress = 0
        if moved { moved = false }
        fingerY = nil
        if held { DragHold.shared.releaseNow() }
    }
}

/// Where a selected block's grip sits: centred on the pane's edge, in the
/// field's points (x from its left edge, y from midnight).
struct GripPlacement: Hashable, Sendable {
    let edge: ResizeEdge
    let x: Double
    let y: Double
}

/// The two grips' sizes and places (design §5.6, §5.10).
enum ResizeGrips {
    /// Each grip's hit target: a square this wide, centred on the pane's
    /// edge, above the neighbouring blocks.
    static let target: Double = 44
    /// The capsule drawn on the edge.
    static let width: Double = 20
    static let height: Double = 5
    /// How far a grip's travel (the finger's and the grid's together) goes
    /// before the press counts as moved: under it, the block shows as
    /// pressed, nothing scrolls, and letting go writes nothing. A resting
    /// finger drifts by fractions of a point, and on a block off the quarter
    /// any travel the maths is asked about snaps (9:10 for 50 to 9:15 for
    /// 45). Well under half a 15-minute step (9.4pt at 75pt an hour), so a
    /// drag still lands every quarter hour where the finger is. The web,
    /// with a mouse, has none.
    static let slop: Double = 4
    /// The coordinate space a grip's gesture measures in: the hours' scroll
    /// view's own frame, which stays put while its content scrolls (see the
    /// file's header). ScheduleGrid names it; Week × Schedule's grid names
    /// the same.
    static let viewportSpace = "Schedule.viewport"

    /// Where `edge`'s grip sits on a block drawn at `frame`. The top grip at
    /// the pane's leading end and the bottom one at its trailing end, each
    /// target flush with the pane's side, so a 15-minute block's two targets
    /// never overlap on a pane 88pt wide or wider. In the block's own lane
    /// instead (`inLane`) when a nested child shares that edge, so the
    /// grip is not drawn over the child: the web's `handleTopLane` and
    /// `handleBottomLane`, whose handle runs from the band's left edge for
    /// the lane plus 8 (components/views/day-schedule.tsx).
    static func placement(_ edge: ResizeEdge, frame: BlockFrame, inLane: Bool) -> GripPlacement {
        let y = edge == .top ? frame.paneTop : frame.paneTop + frame.paneHeight
        let inset = min(target / 2, frame.paneWidth / 2)
        let x: Double
        if inLane {
            x = frame.bandX + (ScheduleMetrics.lanePx + 8) / 2
        } else if edge == .top {
            x = frame.paneX + inset
        } else {
            x = frame.paneX + frame.paneWidth - inset
        }
        return GripPlacement(edge: edge, x: x, y: y)
    }

    /// Both grips of a block drawn at `frame`, top first, in or out of the
    /// lane as the block's laid-out plan says (`plan`, the day's, kept for
    /// the whole press so a grip never jumps from under the finger).
    static func placements(_ frame: BlockFrame, plan: OverlapPlan) -> [GripPlacement] {
        return [placement(.top, frame: frame, inLane: plan.handleTopLane),
                placement(.bottom, frame: frame, inLane: plan.handleBottomLane)]
    }
}

/// The words a length says (design §11, §5.9).
enum BlockResizeWords {
    /// The block's menu entry that shows its grips.
    static let changeLength = "Change length"
    /// VoiceOver's two length actions: the bottom grip moved a quarter hour.
    static let longer = "Make 15 minutes longer"
    static let shorter = "Make 15 minutes shorter"
    /// How far one of them moves the end: the grid's snap.
    static let step = ScheduleMetrics.snapMin

    /// What VoiceOver says after a length (design §5.9): the block's new
    /// spoken range, as its label says a range (`PlannerFormat.spokenRange`),
    /// "12:30 to 1:15 PM", the meridiem said once when both ends share it.
    /// Always a range, where the block's label says a start alone under an
    /// hour, since the length is what changed.
    static func announcement(_ span: BlockSpan) -> String {
        return PlannerFormat.spokenRange(startMin: span.startMin, endMin: span.startMin + span.duration)
    }
}

extension OverlapPlan {
    /// The plan while a grip reshapes its block: lib/schedule-overlap.ts
    /// `bandOnly` over the ported subset. The band, the pane's margins, the
    /// rail and the bead stay (a length never moves a block into another
    /// lane); what the new extent makes stale goes: the content band (the
    /// content centres in the whole pane) and the grips' lanes.
    var bandOnly: OverlapPlan {
        var plan = self
        plan.contentTop = nil
        plan.contentHeight = nil
        plan.handleTopLane = false
        plan.handleBottomLane = false
        return plan
    }
}

extension ScheduleBlock {
    /// The block as a grip is pressed on it (DsulCore `TimedEntry.span`): its
    /// start and length as the day draws them.
    var span: BlockSpan { BlockSpan(startMin: startMin, duration: duration) }

    /// The block drawn at `span` while a grip is in the hand: its band kept
    /// and the rest of its plan dropped (`bandOnly`), as the web draws a block
    /// mid-resize, so its range and length read the new span.
    func resized(to span: BlockSpan) -> ScheduleBlock {
        var drawn = item
        drawn.startTime = minutesToTime(span.startMin)
        drawn.duration = span.duration
        return ScheduleBlock(item: drawn, startMin: span.startMin, duration: span.duration, plan: plan.bandOnly,
                             done: done, skipped: skipped, tickLabel: tickLabel)
    }
}

extension SamplePlanner {
    /// May `block` change length on `schedule`'s day (B4, B16)? Never a
    /// skipped occurrence's strip; otherwise the stored item's
    /// (`canResize(_:)`). A done block may.
    func canResize(_ block: ScheduleBlock, in schedule: DaySchedule) -> Bool {
        guard !block.skipped, let item = item(block.id) else { return false }
        return canResize(item)
    }

    /// The web's gate (components/views/day-schedule.tsx `canResize`): the
    /// type's `schedule.resizable`, a start time (the web's `!!startTime`,
    /// so an empty one is none), and not in a project block, whose block
    /// takes the project's extent. And the phone's: the server takes a time
    /// edit on this item (`canEdit("time")`: the write is one, and a type
    /// with no time, a subtask's, takes none). The web reads
    /// `inProjectBlock` on a task alone; a habit never carries it true, so
    /// asking it of every item answers the same on real rows.
    func canResize(_ item: SampleItem) -> Bool {
        return caps(for: item).resizable && !(item.startTime ?? "").isEmpty && item.inProjectBlock != true
            && canEdit("time", item)
    }

    /// What letting go of a grip writes (design §9's `resize(_:edge:to:)`):
    /// `edge` moved `id`'s block `from` the span it was pressed at `to` the
    /// one it was let go at. DsulCore's `resizeWrite` says the write (the
    /// bottom grip's length alone; the top grip's start, length and the
    /// start's part of day; nothing when nothing changed), and it goes the
    /// way the Time chip's edits go (`edit`): behind `canEdit(edit, item)`,
    /// stepped by `editing`, sent as the `time` intent, put back if it fails.
    /// Asks the gate again off the item as it is now, and ends the press's
    /// hold on fetched data, as a drop does. Returns the write when the item
    /// changed, else nil; announces the new range to VoiceOver when it did.
    @discardableResult
    func resize(_ id: UUID, edge: ResizeEdge, from: BlockSpan, to: BlockSpan) -> ResizeWrite? {
        DragHold.shared.releaseNow()
        guard let before = item(id), canResize(before),
              let write = resizeWrite(edge: edge, from: from, to: to)
        else { return nil }
        edit(id, write.edit)
        guard item(id) != before else { return nil }
        announceMove(BlockResizeWords.announcement(to))
        return write
    }

    /// VoiceOver's "Make 15 minutes longer" (`by` 15) or "shorter" (-15):
    /// where the bottom grip moved a quarter hour leaves `block`, when that
    /// writes something the item takes. So shorter stops at 15 minutes and
    /// longer at midnight, and a length off the quarter lands on one (50
    /// minutes made longer is 60, as a quarter-hour drag of the web's handle).
    func lengthStep(_ block: ScheduleBlock, in schedule: DaySchedule, by minutes: Int) -> BlockSpan? {
        guard canResize(block, in: schedule), let item = item(block.id) else { return nil }
        let to = resizePreview(edge: .bottom, from: block.span, deltaMin: Double(minutes))
        guard let write = resizeWrite(edge: .bottom, from: block.span, to: to), canEdit(write.edit, item)
        else { return nil }
        return to
    }

    /// Is the length action offered? Only when it writes (`lengthStep`).
    func canChangeLength(_ block: ScheduleBlock, in schedule: DaySchedule, by minutes: Int) -> Bool {
        return lengthStep(block, in: schedule, by: minutes) != nil
    }

    /// One VoiceOver length action, one write (design §7): the bottom grip's,
    /// through `resize`.
    @discardableResult
    func changeLength(_ block: ScheduleBlock, in schedule: DaySchedule, by minutes: Int) -> ResizeWrite? {
        guard let to = lengthStep(block, in: schedule, by: minutes) else { return nil }
        return resize(block.id, edge: .bottom, from: block.span, to: to)
    }
}
