import DsulCore
import Foundation
import Observation
import SwiftUI

/// The one piece of state the braindump sheet (the drag source) and the grid
/// (the drop target) share. The grid's drop callbacks carry no item ids, so the
/// sheet tells it what is being dragged when the drag starts.
@Observable @MainActor
final class ScheduleDrag {
    var itemID: UUID?
    var durationMin = 30
    /// The finger, in the grid's content space (scroll offset included).
    var contentY: Double?
    var ghostStartMin: Int?
    var detentBeforeDrag: PresentationDetent?

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

    func begin(itemID: UUID?, durationMin: Int, detent: PresentationDetent) {
        self.itemID = itemID
        self.durationMin = durationMin
        detentBeforeDrag = detent
        phase = "dragging"
        note("lift \(durationMin)m")
        DragHold.shared.hold()
    }

    func setContentY(_ y: Double) {
        contentY = y
        ghostStartMin = snappedStart(contentY: y, hourPx: ScheduleMetrics.hourPx, durationMin: durationMin)
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

    /// The drag session ended (`.ended`, from the sheet). The grid's drop
    /// handler can still be on its way, so the hold on fetched data outlives
    /// this by half a second; the drop itself releases it at once
    /// (`SamplePlanner.schedule`).
    func reset() {
        itemID = nil
        clearGhost()
        detentBeforeDrag = nil
        phase = "idle"
        DragHold.shared.release(after: .milliseconds(500))
    }
}

/// Holds a fetched planner back while a braindump row is in the air: a fetch
/// that landed mid-drag could take the row out from under the finger, or put
/// a just-dropped one back in the braindump. Set when a drag begins, released
/// by the drop or shortly after the session ends; PlannerSync asks it before
/// applying anything and refetches once it lets go. One for the app, since
/// there is one braindump sheet.
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
