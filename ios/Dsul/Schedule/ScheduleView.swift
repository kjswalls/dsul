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
/// those two and derives nothing (design §5.1, "What reads what").
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
            // its own; let its hold on fetched data go.
            if drag.phase != "idle" { drag.reset() }
        }
    }

    /// One autoscroll frame. Only the bottom edge, the one the sheet covers;
    /// the top edge is left to the system's own drag autoscroll.
    private func tick(dt: Double) {
        guard let contentY = drag.contentY else { return }
        let fingerY = contentY - drag.offsetY
        let covered = max(0, drag.viewportBottomGlobal - drag.sheetTopGlobal)
        let visibleBottom = drag.viewportH - covered
        let step = autoscrollStep(fingerY: fingerY, visibleTop: 0, visibleBottom: visibleBottom, dt: dt)
        guard step > 0 else { return }
        let newY = clampScrollOffset(drag.offsetY + step, contentH: drag.contentH, viewportH: drag.viewportH)
        let moved = newY - drag.offsetY
        guard moved > 0 else { return }
        position.scrollTo(y: newY)
        drag.offsetY = newY
        drag.autoscrollSteps += 1
        // The drop callbacks may not fire while the finger is still, so the
        // ghost follows the scroll here.
        drag.setContentY(contentY + moved)
    }
}

/// Starts the bottom-edge autoscroll while a drag hovers over the grid, and
/// stops it when the drag leaves. Its own view, so the drag's every step
/// re-renders only this empty one, never ScheduleView's derive.
private struct AutoscrollSwitch: View {
    let drag: ScheduleDrag
    let autoscroller: EdgeAutoscroller

    var body: some View {
        Color.clear
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .onChange(of: drag.contentY != nil) { _, hovering in
                if hovering { autoscroller.start() } else { autoscroller.stop() }
            }
    }
}
