import DsulCore
import SwiftUI

/// The Schedule layout: the Anytime band above the hours, the grid, and the
/// braindump sheet over them. Its drag answers whether a system drag that
/// starts in the sheet lands on the grid behind it, while the sheet changes
/// size. See memory/plans/ios-app.md.
///
/// The day is laid out here, once per change (`daySchedule(on:fieldWidth:)`),
/// and handed down as a value. This body never reads the drag: only the
/// grid's drag layer and the autoscroll switch do, so a ghost step re-renders
/// those two and derives nothing (design §5.1, "What reads what"). A grip's
/// step is the same: it re-renders the selected block's reader and the
/// grips, and the switch only at a press's first move and its release.
///
/// Changing a length (PR 9): the autoscroll also runs while a grip in the
/// hand has moved, on both edges, and any sheet, another day or the
/// Schedule going away clears the selected block (`SelectionClearing`).
struct ScheduleView: View {
    var showProbe: Bool
    /// Minutes after midnight on today's clock, from TodayView's
    /// `TimelineView`; the now marker draws it on today only.
    var nowMin: Int

    @Environment(SamplePlanner.self) private var planner
    @State private var drag: ScheduleDrag
    @State private var detent: PresentationDetent = .medium
    @State private var position = ScrollPosition(edge: .top)
    @State private var autoscroller = EdgeAutoscroller()
    /// The grid right of the gutter, as last measured: what the overlap pass
    /// lays the blocks out on. Nil until the first layout, when no block draws.
    @State private var fieldWidth: Double?

    /// `drag` is for hosted tests, which step the ghost on the view's own
    /// drag state; the app passes none.
    init(showProbe: Bool, nowMin: Int, drag: ScheduleDrag? = nil) {
        self.showProbe = showProbe
        self.nowMin = nowMin
        _drag = State(initialValue: drag ?? ScheduleDrag())
    }

    var body: some View {
        @Bindable var planner = planner
        let day = planner.daySchedule(on: planner.selectedDay, fieldWidth: fieldWidth)
        VStack(spacing: 0) {
            AnytimeBand(schedule: day, sheetUp: planner.showBraindumpSheet)
            ScheduleGrid(position: $position, day: day, nowMin: planner.isOnToday ? nowMin : nil,
                         fieldWidth: $fieldWidth)
                // Signed in, before the first fetch lands: the spinner, or why
                // it failed with a retry. The grid has no pull to refresh (its
                // drag owns the gestures), and an empty grid alone reads as a
                // day with nothing planned. The sample starts loaded, so it
                // never shows.
                .overlay(alignment: .top) {
                    if !planner.hasLoaded {
                        PlannerLoadingRow()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .padding(.horizontal, 12)
                            .padding(.top, 4)
                    }
                }
        }
        .environment(drag)
        .background {
            AutoscrollSwitch(drag: drag, autoscroller: autoscroller)
            SelectionClearing(resize: drag.resize)
        }
        .overlay(alignment: .top) {
            if showProbe {
                // "Load 40 blocks" is sample only: its blocks exist nowhere
                // on the server.
                DragProbeHUD(detent: detent, onStress: planner.isLive ? nil : { planner.stress() })
                    .environment(drag)
                    .padding(.horizontal, 12)
            }
        }
        .sheet(isPresented: $planner.showBraindumpSheet) {
            BraindumpSheet(detent: $detent)
                .environment(planner)
                .environment(drag)
                // Capture and Go to date, stacked on the braindump while
                // it is up (RootView presents them otherwise).
                .sheet(item: $planner.sheetOverBraindump) { sheet in
                    PlannerSheetContent(sheet: sheet)
                        .environment(planner)
                }
        }
        .onAppear {
            autoscroller.onTick = { dt in tick(dt: dt) }
        }
        .onDisappear {
            autoscroller.stop()
            // A drag cut off by the layout switching away never ends on
            // its own; let its hold on fetched data go. The same for a
            // grip, and the selection goes with the Schedule.
            if drag.phase != "idle" { drag.reset() }
            drag.resize.clear()
        }
    }

    /// One autoscroll frame (`ScheduleAutoscroll`, design §5.4, §5.6). For
    /// a drag: the bottom edge, the one the sheet covers, always; the top
    /// edge only behind `ScheduleAutoscroll.handDrivesTopEdge`, off while
    /// the system's own drag autoscroll is trusted with it (device check
    /// M3). For a grip in the hand: both edges, since no system drag is
    /// running to scroll either, with the finger's height in the viewport,
    /// and only once the grip has moved (`BlockResize.drivesAutoscroll`): a
    /// still finger pressed near an edge scrolls nothing, so it moves no edge.
    private func tick(dt: Double) {
        let resize = drag.resize
        let fingerY: Double
        let topEdge: Bool
        if resize.isHeld {
            guard resize.drivesAutoscroll, let gripY = resize.fingerY else { return }
            fingerY = gripY
            topEdge = true
        } else if let contentY = drag.contentY {
            fingerY = contentY - drag.offsetY
            topEdge = ScheduleAutoscroll.handDrivesTopEdge
        } else {
            return
        }
        let covered = max(0, drag.viewportBottomGlobal - drag.sheetTopGlobal)
        let step = ScheduleAutoscroll.step(fingerY: fingerY, viewportH: drag.viewportH, coveredBottom: covered,
                                           dt: dt, topEdge: topEdge)
        guard step != 0 else { return }
        let newY = clampScrollOffset(drag.offsetY + step, contentH: drag.contentH, viewportH: drag.viewportH)
        let moved = newY - drag.offsetY
        guard moved != 0 else { return }
        position.scrollTo(y: newY)
        drag.offsetY = newY
        drag.autoscrollSteps += 1
        if resize.isHeld {
            // The finger holds still while the grid scrolls under it: the
            // scroll is the edge's travel (`BlockResize.scrolled`).
            resize.scrolled(to: newY)
        } else if let contentY = drag.contentY {
            // The drop callbacks may not fire while the finger is still, so
            // the ghost follows the scroll here.
            drag.setContentY(contentY + moved)
        }
    }
}

/// Starts the edge autoscroll while a drag hovers over the grid or a grip
/// in the hand has moved, and stops it when the drag leaves or the grip is
/// let go. Its own view, so the drag's every step re-renders only this empty
/// one, never ScheduleView's derive.
private struct AutoscrollSwitch: View {
    let drag: ScheduleDrag
    let autoscroller: EdgeAutoscroller

    var body: some View {
        Color.clear
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .onChange(of: drag.contentY != nil || drag.resize.drivesAutoscroll) { _, running in
                if running { autoscroller.start() } else { autoscroller.stop() }
            }
    }
}

/// Clears the selected block (design §5.6) when any sheet opens (an item's,
/// the date picker, Capture, the braindump) and when the Schedule moves to
/// another day. Its own empty view, so a sheet re-renders this alone, never
/// ScheduleView's derive.
private struct SelectionClearing: View {
    let resize: BlockResize

    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        Color.clear
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .onChange(of: planner.activeSheet != nil) { _, up in
                if up { resize.clear() }
            }
            .onChange(of: planner.showBraindumpSheet) { _, up in
                if up { resize.clear() }
            }
            .onChange(of: planner.selectedDay) {
                resize.clear()
            }
    }
}
