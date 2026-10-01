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

    func note(_ event: String) {
        events.append(event)
        if events.count > 8 { events.removeFirst(events.count - 8) }
    }

    func reset() {
        itemID = nil
        clearGhost()
        detentBeforeDrag = nil
        phase = "idle"
    }
}
