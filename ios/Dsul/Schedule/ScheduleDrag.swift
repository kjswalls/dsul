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

/// The one piece of state the drag sources (the braindump sheet, a column's
/// blocks, the Anytime band's rows) and the drop targets (the grid, the band,
/// the sheet) share. The drop callbacks carry no item ids until the drop
/// itself, so the source tells them what is being dragged when the drag
/// starts.
@Observable @MainActor
final class ScheduleDrag {
    var itemID: UUID?
    var durationMin = 30
    /// The finger, in the grid's content space (scroll offset included).
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

    // Geometry, fed by the grid and the sheet.
    var offsetY: Double = 0
    var viewportH: Double = 0
    var contentH: Double = 0
    var viewportBottomGlobal: Double = 0
    var sheetTopGlobal: Double = .infinity

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
        DragHold.shared.hold()
    }

    /// Where `id`'s drag began, when the last lift was of `id`; nil when it
    /// was another item's or none, as after a lift whose `.initial` was
    /// missed. The drop handlers ask this, never `source` alone, so a drop
    /// never routes on another item's drag (`SamplePlanner.dropSource`).
    func source(of id: UUID) -> DragSource? {
        return liftedID == id ? source : nil
    }

    /// Is `id` the block in the air? Its own column draws it hollow then
    /// (design B8).
    func lifts(_ id: UUID) -> Bool {
        guard inFlight, itemID == id, case .block? = source else { return false }
        return true
    }

    /// The finger over the grid at `y`, on `day`'s column (nil keeps the
    /// column the ghost is on): the ghost's start, snapped to 15 minutes,
    /// with the finger where it holds the ghost (`anchor`).
    func setContentY(_ y: Double, on day: DayString? = nil) {
        contentY = y
        ghostDay = confinedTo ?? day ?? ghostDay
        ghostStartMin = snappedStart(contentY: y, hourPx: ScheduleMetrics.hourPx, durationMin: durationMin,
                                     anchor: anchor)
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
