import DsulCore
import Foundation
import Observation
import SwiftUI

/// Where the drag in the air began (design §5.4, "Which drag is which"): set
/// at `.initial` by the container that began the session. The drop handlers
/// ask it: a braindump row keeps the hour drop it always had (`schedule`); a
/// block or an Anytime row goes through the drop rule (`moveBlock`) from the
/// day it was lifted on.
enum DragSource: Hashable, Sendable {
    /// A row of the braindump sheet.
    case braindump
    /// A block on `day`'s column.
    case block(day: DayString)
    /// A row of `day`'s Anytime band.
    case anytime(day: DayString)

    /// The day a block or an Anytime row was lifted on; nil for a braindump
    /// row, which is on no day.
    var day: DayString? {
        switch self {
        case .braindump: return nil
        case .block(let day), .anytime(let day): return day
        }
    }
}

/// Where a column's drop session is (Week × Schedule, PR 10): SwiftUI's
/// `DropSession.Phase` as `ScheduleDrag.columnUpdate` takes it, so a hosted
/// test can deliver the phases in any order.
enum ColumnDropPhase: Hashable, Sendable {
    case entering, active, exiting, ended
}

/// The one piece of state the drag sources (the braindump sheet, a column's
/// blocks, the Anytime band's rows) and the drop targets (the grid, the band,
/// the sheet) share. The drop callbacks carry no item ids until the drop
/// itself, so the source tells them what is being dragged when the drag
/// starts.
@Observable @MainActor
final class ScheduleDrag {
    var itemID: UUID?
    var durationMin = 30
    /// The finger, in the grid's content space (scroll offset included): in
    /// Week × Schedule the column's, whose hours start `hoursTop` down.
    var contentY: Double?
    var ghostStartMin: Int?
    var detentBeforeDrag: PresentationDetent?
    /// A drag is in the air: from the lift (`begin`, `beginMove`) to the end
    /// of its session (`reset`). The band's header hint and a lifted block's
    /// hollow outline read it.
    private(set) var inFlight = false
    /// Which container began the drag. Kept past `reset`, as `anchor` and
    /// `durationMin` are, until the next lift: a drop handler can run after
    /// the source's `.ended`, and it still has to know what landed.
    private(set) var source: DragSource?
    /// The item the last lift was of, kept past `reset` with `source`, so a
    /// drop handler can tell whether the drag it remembers is the one that
    /// landed (`source(of:)`).
    private(set) var liftedID: UUID?
    /// Where on the ghost the finger holds it, 0 at its top to 1 at its foot
    /// (design §5.5), so a block lands where it was held, not centred. A
    /// braindump row is held by its middle.
    private(set) var anchor = 0.5
    /// The column the ghost draws in: the day the finger is over, or
    /// `confinedTo` when that is set. Day has one column.
    private(set) var ghostDay: DayString?
    /// The day a block that moves in time only (a habit, a dated series)
    /// keeps its ghost on as the finger crosses other columns (B18,
    /// `SamplePlanner.confinedDay`); nil when the ghost follows the finger.
    /// Only Week × Schedule (PR 10) has other columns to cross.
    private(set) var confinedTo: DayString?
    /// The column the finger is over, as the drop sessions last said
    /// (`columnUpdate`): only its own `.exiting` clears the ghost, so
    /// Monday's late exit never wipes the ghost Tuesday has just set, even
    /// for a drag kept to Monday's column (B18). Ignored by Observation:
    /// nothing draws it.
    @ObservationIgnored private(set) var overDay: DayString?

    /// The selected block and the grip in the hand (Change length, PR 9).
    /// Here so the grid, the columns and the autoscroll share one, and so a
    /// lift clears it: a drop never leaves grips behind (B3).
    let resize = BlockResize()

    // Geometry, fed by the grid and the sheet.
    var offsetY: Double = 0
    var viewportH: Double = 0
    var contentH: Double = 0
    var viewportBottomGlobal: Double = 0
    var sheetTopGlobal: Double = .infinity
    /// How far down the grid's content the hours start (design §4.5): 0 on
    /// Day, whose band sits outside the scroll; in Week × Schedule the
    /// pinned head's height (the headings and the Anytime strips). The
    /// ghost and a drop read the hours at `contentY - hoursTop`, and while
    /// the heads are pinned the edge autoscroll's top edge is `hoursTop`
    /// down the viewport, below the strips. Set by the layout that shows.
    var hoursTop: Double = 0

    // Week × Schedule's sideways geometry (PR 10), fed by its columns' scroll
    // view: none of it draws, so Observation ignores it all.
    /// The seven days, in column order; empty on Day, which has no sideways
    /// autoscroll.
    @ObservationIgnored var columnDays: [DayString] = []
    @ObservationIgnored var columnWidth: Double = 0
    /// The columns' scroll offset and visible width.
    @ObservationIgnored var offsetX: Double = 0
    @ObservationIgnored var viewportW: Double = 0
    /// The finger across the columns' content (scroll offset included), as
    /// the last drop update over a column's hours said; nil off the hours.
    @ObservationIgnored private(set) var fingerX: Double?
    /// The sideways autoscroll's dwell (`SideAutoscroll`).
    @ObservationIgnored private var side = SideAutoscroll()

    // Probe readings for the on-phone HUD (spike tests 1 to 5).
    var phase = "idle"
    var dropUpdates = 0
    var updatesPerSecond = 0
    var autoscrollSteps = 0
    var events: [String] = []
    private var windowStart = Date()
    private var windowCount = 0

    /// A braindump row lifted (the sheet's `.initial`): held by its middle,
    /// with the sheet's size to restore if it goes nowhere.
    func begin(itemID: UUID?, durationMin: Int, detent: PresentationDetent) {
        lift(itemID: itemID, durationMin: durationMin, source: .braindump, anchor: 0.5, confinedTo: nil)
        detentBeforeDrag = detent
    }

    /// A block or an Anytime row lifted off the grid (its container's
    /// `.initial`): held at `anchor` (`grabAnchor`), and kept to
    /// `confinedTo`'s column when it moves in time only. It takes the same
    /// hold on fetched data as a braindump drag (B20).
    func beginMove(itemID: UUID, durationMin: Int, source: DragSource, anchor: Double, confinedTo: DayString?) {
        lift(itemID: itemID, durationMin: durationMin, source: source, anchor: anchor, confinedTo: confinedTo)
        detentBeforeDrag = nil
    }

    private func lift(itemID: UUID?, durationMin: Int, source: DragSource, anchor: Double,
                      confinedTo: DayString?) {
        self.itemID = itemID
        liftedID = itemID
        self.durationMin = durationMin
        self.source = source
        self.anchor = anchor
        self.confinedTo = confinedTo
        inFlight = true
        phase = "dragging"
        note("lift \(durationMin)m")
        resize.clear()
        DragHold.shared.hold()
    }

    /// Where `id`'s drag began, when the last lift was of `id`; nil when it
    /// was another item's or none, as after a lift whose `.initial` was
    /// missed. The drop handlers ask this, never `source` alone, so a drop
    /// never routes on another item's drag (`SamplePlanner.dropSource`).
    func source(of id: UUID) -> DragSource? {
        return liftedID == id ? source : nil
    }

    /// Is `id`'s block on `day` the one in the air? Its own column draws it
    /// hollow then (design B8), and only that one: in Week × Schedule a habit
    /// or a series has a block in every column it falls on, and the copies on
    /// the other days are not the source (PR 10).
    func lifts(_ id: UUID, on day: DayString) -> Bool {
        guard inFlight, itemID == id, source == .block(day: day) else { return false }
        return true
    }

    /// The finger over the grid at `y`, on `day`'s column (nil keeps the
    /// column the ghost is on): the ghost's start, snapped to 15 minutes,
    /// with the finger where it holds the ghost (`anchor`), read on the hours
    /// (`y - hoursTop`).
    func setContentY(_ y: Double, on day: DayString? = nil) {
        contentY = y
        ghostDay = confinedTo ?? day ?? ghostDay
        ghostStartMin = dropStart(contentY: y, durationMin: durationMin)
    }

    /// Where an item `durationMin` long lands when let go with the finger at
    /// `contentY` in the grid's content: the hours' own height
    /// (`contentY - hoursTop`), held at the drag's grab point, snapped to 15
    /// minutes and kept inside the day. The ghost and every hour drop ask it.
    func dropStart(contentY: Double, durationMin: Int) -> Int {
        return snappedStart(contentY: contentY - hoursTop, hourPx: ScheduleMetrics.hourPx, durationMin: durationMin,
                            anchor: anchor)
    }

    /// One drop session update over `day`'s hours (design §4.5, "Drops"):
    /// Day's grid and each Week × Schedule column send theirs here, `y` in
    /// the column's content (hours from `hoursTop`) and `x`, when given,
    /// across the columns' content. `.entering` and `.active` put the ghost
    /// on `day` (or keep it on `confinedTo`, B18) at `y`; `.exiting` and
    /// `.ended` clear it only when `day` is the column the finger was last
    /// over, so two columns' updates can arrive in either order and the
    /// ghost stays where the finger is.
    func columnUpdate(day: DayString, phase: ColumnDropPhase, y: Double, x: Double? = nil) {
        noteDropUpdate()
        switch phase {
        case .entering, .active:
            overDay = day
            fingerX = x
            setContentY(y, on: day)
        case .exiting, .ended:
            guard overDay == day else { return }
            overDay = nil
            clearGhost()
        }
    }

    /// One frame of Week × Schedule's sideways autoscroll (PR 10, device
    /// check W-S3): while the finger rests in a side edge of the columns
    /// (`SideAutoscroll`), the column a step that way, to scroll to the
    /// leading edge; nil otherwise. The finger stays put while the columns
    /// move under it, so the ghost moves to the column now under it, as the
    /// vertical autoscroll's does to the hour. A drag kept to its own column
    /// (`confinedTo`, a habit or a series, B18) never steps: it lands on its
    /// own day whichever column it is let go on, so a step would only carry
    /// its ghost off the screen.
    func sideStep(dt: Double) -> DayString? {
        guard contentY != nil, confinedTo == nil, let fingerX, columnWidth > 0, viewportW > 0,
              !columnDays.isEmpty else {
            side.reset()
            return nil
        }
        let count = columnDays.count
        let across = WeekScheduleRules.across(viewportW: viewportW, columnWidth: columnWidth)
        let leading = WeekScheduleRules.leadingIndex(offsetX: offsetX, columnWidth: columnWidth, count: count,
                                                     across: across)
        let direction = side.step(fingerX: fingerX - offsetX, viewportW: viewportW, dt: dt)
        guard direction != 0 else { return nil }
        let target = min(max(0, leading + direction), max(0, count - across))
        guard target != leading else { return nil }
        let moved = Double(target - leading) * columnWidth
        offsetX += moved
        let x = fingerX + moved
        self.fingerX = x
        let under = columnDays[WeekScheduleRules.columnIndex(atContentX: x, columnWidth: columnWidth, count: count)]
        overDay = under
        ghostDay = under
        autoscrollSteps += 1
        note("side \(direction > 0 ? "+" : "-")1")
        return columnDays[target]
    }

    /// Where on a block's ghost a finger at `fingerY` (content space) holds
    /// it: `clamp((fingerY - blockTop) / ghostHeight, 0, 1)` (design §5.5),
    /// the ghost being `durationMin` long at `hourPx` an hour. The middle
    /// for a ghost of no height.
    nonisolated static func grabAnchor(fingerY: Double, blockTop: Double, durationMin: Int,
                                       hourPx: Double = ScheduleMetrics.hourPx) -> Double {
        let height = Double(durationMin) * hourPx / 60
        guard height > 0, fingerY.isFinite, blockTop.isFinite else { return 0.5 }
        return min(max((fingerY - blockTop) / height, 0), 1)
    }

    func clearGhost() {
        contentY = nil
        ghostStartMin = nil
        fingerX = nil
        side.reset()
    }

    func noteDropUpdate() {
        DragHold.shared.renew()
        dropUpdates += 1
        windowCount += 1
        let now = Date()
        let elapsed = now.timeIntervalSince(windowStart)
        if elapsed >= 1 {
            updatesPerSecond = Int(Double(windowCount) / elapsed)
            windowCount = 0
            windowStart = now
        }
    }

    /// The finger moved over the sheet (`.active`): the drag is still on,
    /// so the hold on fetched data starts its lease over.
    func noteMove() {
        DragHold.shared.renew()
    }

    func note(_ event: String) {
        events.append(event)
        if events.count > 8 { events.removeFirst(events.count - 8) }
    }

    /// One of a block's menu entries was picked. The menu and the drag share
    /// one long press (device check M1), and no drag is in the air once a
    /// menu row is tapped, so a lift whose session never reached `.ended`
    /// is let go here: no hollow outline, no band hint, no hold on fetched
    /// data. Nothing when no drag is in the air.
    func endStrayLift() {
        guard inFlight else { return }
        note("menu picked")
        reset()
    }

    /// The drag session ended (`.ended`, from the sheet, a column or the
    /// band). The drop handler can still be on its way, so the hold on
    /// fetched data outlives this by half a second, and `source`, `anchor`
    /// and `durationMin` stay until the next lift; the drop itself releases
    /// the hold at once (`SamplePlanner.schedule`, `moveBlock`,
    /// `placeAnytime`).
    func reset() {
        itemID = nil
        clearGhost()
        ghostDay = nil
        overDay = nil
        detentBeforeDrag = nil
        inFlight = false
        phase = "idle"
        DragHold.shared.release(after: .milliseconds(500))
    }
}

/// Holds a fetched planner back while a braindump row, a block or an Anytime
/// row is in the air: a fetch that landed mid-drag could take the row out
/// from under the finger, or put a just-dropped one back where it was. Set
/// when a drag begins, released by the drop or shortly after the session
/// ends; PlannerSync asks it before applying anything and refetches once it
/// lets go. One for the app, since one drag is in the air at a time.
///
/// A hold is a lease, not a flag: it lapses by itself `lease` after the last
/// sign of the drag (the lift, a move over the sheet, a drop update over the
/// grid). A drag whose view is torn down mid-flight (Close, or the layout
/// capsule tapped with a second finger) never delivers `.ended`, and a flag
/// would then hold every fetch back for the life of the process.
/// PlannerSync waits up to two minutes for a hold, longer than the lease, so
/// the fetch it held back is made once the lease runs out.
@MainActor
final class DragHold {
    static let shared = DragHold()

    /// How long a hold outlives the last sign of its drag. A drag that goes
    /// longer than this with no update at all only loses the protection; it
    /// still drops.
    let lease: Duration

    /// When the hold lapses by itself; nil once released.
    private var heldUntil: ContinuousClock.Instant?
    private var pendingRelease: Task<Void, Never>?

    init(lease: Duration = .seconds(60)) {
        self.lease = lease
    }

    var isHeld: Bool {
        guard let heldUntil else { return false }
        return ContinuousClock.now < heldUntil
    }

    func hold() {
        pendingRelease?.cancel()
        pendingRelease = nil
        heldUntil = ContinuousClock.now.advanced(by: lease)
    }

    /// The drag is still going: the lease starts over. Only a live hold is
    /// renewed: once the drop or the end of the session has let go, or the
    /// lease has run out, a late update can't take the hold back.
    func renew() {
        guard isHeld, pendingRelease == nil else { return }
        heldUntil = ContinuousClock.now.advanced(by: lease)
    }

    func releaseNow() {
        pendingRelease?.cancel()
        pendingRelease = nil
        heldUntil = nil
    }

    func release(after delay: Duration) {
        pendingRelease?.cancel()
        pendingRelease = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            self.heldUntil = nil
            self.pendingRelease = nil
        }
    }
}
