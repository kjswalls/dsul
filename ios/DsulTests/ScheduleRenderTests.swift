#if canImport(UIKit)
import DsulCore
import SwiftUI
import Testing
import UIKit
@testable import Dsul

/// The Schedule as SwiftUI draws it (Week and blocks PRs 4 to 6), hosted in a
/// window: a ghost step re-renders only the drag's own layer and derives
/// nothing, while a change to the planner still lays the day out again; and
/// every SF Symbol a block or the band draws exists. Runs on the xcode-27
/// runner only; the Linux shim never compiles it (ScheduleLayoutTests is the
/// shim's half).
@MainActor
@Suite struct ScheduleRenderTests {
    private func makePlanner() -> SamplePlanner {
        SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
    }

    /// `view` in a visible window the size of a phone, on the app's own scene
    /// when there is one, so SwiftUI lays it out and keeps it updated.
    private func host(_ view: some View) -> UIWindow {
        let frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: frame)
        window.frame = frame
        window.rootViewController = UIHostingController(rootView: view)
        window.isHidden = false
        window.rootViewController?.view.layoutIfNeeded()
        return window
    }

    /// One turn of the main run loop, a frame long, after a layout pass, so
    /// SwiftUI applies whatever changed.
    private func frame(_ window: UIWindow) async {
        window.rootViewController?.view.layoutIfNeeded()
        try? await Task.sleep(for: .milliseconds(16))
    }

    #if DEBUG
    /// Turns frames until the planner's derive count holds still for five
    /// of them: SwiftUI has nothing left to lay out. Returns the count.
    @discardableResult
    private func settle(_ window: UIWindow, _ planner: SamplePlanner) async -> Int {
        var last = -1
        var still = 0
        for _ in 0..<200 {
            await frame(window)
            if planner.derivations == last {
                still += 1
                if still >= 5 { break }
            } else {
                still = 0
                last = planner.derivations
            }
        }
        return planner.derivations
    }

    /// The design's proof (§5.1, "What reads what"): the day is derived in
    /// ScheduleView, whose body never reads the drag, so stepping the ghost
    /// down the grid lays nothing out again. A tick still does.
    @Test func aGhostStepDerivesNothing() async {
        let planner = makePlanner()
        let drag = ScheduleDrag()
        let window = host(ScheduleView(showProbe: false, nowMin: 10 * 60, drag: drag).environment(planner))
        defer { window.isHidden = true }

        let rendered = await settle(window, planner)
        #expect(rendered > 0, "The Schedule laid its day out")

        // Within the visible grid and well above its bottom edge, so the
        // edge autoscroll never moves (it has a test of its own on device).
        let top = drag.offsetY
        for y in stride(from: top + 100, through: top + 300, by: 20) {
            drag.setContentY(y)
            await frame(window)
        }
        #expect(drag.ghostStartMin != nil)
        #expect(planner.derivations == rendered, "A ghost step re-derived the day")

        drag.clearGhost()
        await settle(window, planner)
        #expect(planner.derivations == rendered)

        let standup = planner.items.first { $0.title == "Standup" }!
        planner.toggleRow(standup.id, on: planner.today)
        let after = await settle(window, planner)
        #expect(after > rendered, "A tick lays the day out again")
    }
    #endif

    /// A block's check (open, and the tick drawn on a done one's lime), a
    /// skipped strip's mark, the band's chevron: a missing name draws nothing
    /// at all.
    @Test func everyScheduleSymbolExists() {
        for symbol in ["square", "checkmark", "forward.end", "chevron.down"] {
            #expect(UIImage(systemName: symbol) != nil, "\(symbol)")
        }
    }
}
#endif
