#if canImport(UIKit)
import DsulCore
import SwiftUI
import Testing
import UIKit
@testable import Dsul

/// The Schedule as SwiftUI draws it (Week and blocks PRs 4 to 6), hosted in a
/// window: a ghost step, or a grip's step (PR 9), re-renders only its own
/// small views and derives nothing, in Day and in Week × Schedule (PR 10),
/// while a change to the planner still lays the day (or the week) out
/// again; and every SF Symbol a block or the band draws exists.
/// Runs on the xcode-27 runner only; the Linux shim never compiles it
/// (ScheduleLayoutTests is the shim's half).
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

    /// The same for a length (PR 9): choosing Change length, pressing the
    /// bottom grip and drawing it down the grid step by step redraws the
    /// block and its grips and lays nothing out again; letting go writes,
    /// which does.
    @Test func aGripStepDerivesNothing() async {
        let planner = makePlanner()
        let drag = ScheduleDrag()
        let window = host(ScheduleView(showProbe: false, nowMin: 10 * 60, drag: drag).environment(planner))
        defer { window.isHidden = true }

        let rendered = await settle(window, planner)
        let lunch = planner.items.first { $0.title == "Lunch walk" }!
        let span = BlockSpan(startMin: 12 * 60 + 30, duration: 45)
        drag.resize.select(lunch.id, on: planner.today)
        await settle(window, planner)
        #expect(planner.derivations == rendered, "Selecting a block re-derived the day")

        // Mid-viewport, so the grip's autoscroll never moves.
        drag.resize.press(.bottom, from: span, scrollOffset: drag.offsetY, fingerY: 200)
        for dy in stride(from: 10.0, through: 120.0, by: 10.0) {
            drag.resize.follow(translationY: dy, fingerY: 200 + dy, scrollOffset: drag.offsetY)
            await frame(window)
        }
        #expect(drag.resize.steps > 0)
        #expect(planner.derivations == rendered, "A grip step re-derived the day")

        guard let release = drag.resize.release() else {
            Issue.record("no release")
            return
        }
        planner.resize(release.id, edge: release.edge, from: release.from, to: release.to)
        let after = await settle(window, planner)
        #expect(after > rendered, "A length lays the day out again")
        drag.resize.clear()
        DragHold.shared.releaseNow()
    }

    /// Week × Schedule (PR 10, design §4.5 "Cost"): the week is laid out
    /// once, from a kept `week(of:)`, and a ghost walked down a column and
    /// across to the next redraws the ghost and derives nothing; a tick lays
    /// the week out again. It opens with the hours under the pinned heads
    /// and the selected day at the leading edge (a Thursday, the fifth of a
    /// week starting Sunday, which the week's end allows to lead).
    @Test func aWeekGhostStepDerivesNothing() async {
        let planner = makePlanner()
        let drag = ScheduleDrag()
        let window = host(ScheduleView(showProbe: false, nowMin: 10 * 60, scope: .week, drag: drag)
            .environment(planner))
        defer { window.isHidden = true }

        let rendered = await settle(window, planner)
        #expect(rendered > 0, "The Schedule laid its week out")
        #expect(drag.hoursTop > 0, "The hours start under the pinned heads")
        #expect(drag.columnDays.count == 7)
        #expect(drag.columnWidth > 0, "The columns were measured")
        // The outer scroll geometry is the hours' own scroll view, not the
        // columns' nested inside it: only the hours' content is taller than
        // its viewport, and only it opened toward 8:00 (a safe-area inset
        // may sit between the two readings, never 120pt).
        #expect(drag.viewportH > 0 && drag.viewportH < drag.contentH, "The hours' scroll view reports")
        #expect(abs(drag.offsetY - 8 * ScheduleMetrics.hourPx) < 120, "The hours opened at 8:00")
        // The opening column can land a frame after the derive count holds
        // still: wait for the offset to hold still too, five frames running.
        var lastX = drag.offsetX
        var stillFrames = 0
        var frames = 0
        while stillFrames < 5 && frames < 120 {
            await frame(window)
            frames += 1
            stillFrames = abs(drag.offsetX - lastX) < 0.5 ? stillFrames + 1 : 0
            lastX = drag.offsetX
        }
        #expect(abs(drag.offsetX - 4 * drag.columnWidth) < 1, "The selected day leads")

        // Within the visible hours, clear of both edges' zones, so neither
        // autoscroll moves; one column, then the next.
        let days = drag.columnDays
        let top = drag.offsetY + drag.hoursTop
        for (step, y) in stride(from: top + 100, through: top + 300, by: 20).enumerated() {
            drag.columnUpdate(day: days[step < 5 ? 4 : 5], phase: .active, y: y)
            await frame(window)
        }
        #expect(drag.ghostStartMin != nil)
        #expect(drag.ghostDay == days[5])
        #expect(planner.derivations == rendered, "A ghost step re-derived the week")

        drag.reset()
        await settle(window, planner)
        #expect(planner.derivations == rendered)

        let standup = planner.items.first { $0.title == "Standup" }!
        planner.toggleRow(standup.id, on: planner.today)
        let after = await settle(window, planner)
        #expect(after > rendered, "A tick lays the week out again")
        DragHold.shared.releaseNow()
    }
    #endif

    /// A block's check (open, and the tick drawn on a done one's lime), a
    /// skipped strip's mark, the band's chevron, and every entry of a block's
    /// menu (`BlockMenuEntry.symbol`) and of its Reschedule submenu: a missing
    /// name draws nothing at all.
    @Test func everyScheduleSymbolExists() {
        let menu: [BlockMenuEntry] = [
            .tick("", done: false), .tick("", done: true), .unskip(""), .skip(""), .pause, .resume,
            .nextDay("", detail: nil, date: ""), .reschedule("", []), .braindump, .changeLength, .anytime,
        ]
        let today = DayString("2026-10-01")!
        let choices = RescheduleRow.quickRows(today: today, nextWeekStart: today.adding(days: 4)).map(\.symbol)
        for symbol in ["square", "checkmark", "forward.end", "chevron.down"] + menu.map(\.symbol) + choices {
            #expect(UIImage(systemName: symbol) != nil, "\(symbol)")
        }
    }
}
#endif
