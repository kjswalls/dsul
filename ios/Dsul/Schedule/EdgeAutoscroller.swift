import QuartzCore
import UIKit

/// Drives the grid's bottom-edge autoscroll while a drag hovers just above the
/// braindump sheet. The system already autoscrolls a scroll view near its own
/// edges during a drag, but the grid's bottom edge is under the sheet, where
/// the finger never reaches the grid, so that edge is ours.
///
/// CADisplayLink retains its target, so a deinit would never run while the
/// link is live: `stop()` is the only way it ends, called when the drag leaves
/// the grid and when the view disappears.
@MainActor
final class EdgeAutoscroller: NSObject {
    private var link: CADisplayLink?
    var onTick: (@MainActor (Double) -> Void)?

    var isRunning: Bool { link != nil }

    func start() {
        guard link == nil else { return }
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        // 120Hz on ProMotion phones also needs CADisableMinimumFrameDurationOnPhone in Info.plist.
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    func stop() {
        link?.invalidate()
        link = nil
    }

    @objc private func tick(_ link: CADisplayLink) {
        onTick?(link.targetTimestamp - link.timestamp)
    }
}
