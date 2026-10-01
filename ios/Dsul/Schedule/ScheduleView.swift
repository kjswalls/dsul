import DsulCore
import SwiftUI

/// The Schedule layout with the braindump sheet over it: the drag spike.
/// It answers whether a system drag that starts in the sheet lands on the grid
/// behind it, while the sheet changes size. See memory/plans/ios-app.md.
struct ScheduleView: View {
    var showProbe: Bool

    @Environment(SamplePlanner.self) private var planner
    @State private var drag = ScheduleDrag()
    @State private var detent: PresentationDetent = .medium
    @State private var position = ScrollPosition(edge: .top)
    @State private var autoscroller = EdgeAutoscroller()

    var body: some View {
        @Bindable var planner = planner
        ScheduleGrid(position: $position)
            .environment(drag)
            .overlay(alignment: .top) {
                if showProbe {
                    DragProbeHUD(detent: detent, onStress: { planner.stress() })
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
            .onChange(of: drag.contentY != nil) { _, hovering in
                if hovering { autoscroller.start() } else { autoscroller.stop() }
            }
            .onAppear {
                autoscroller.onTick = { dt in tick(dt: dt) }
            }
            .onDisappear {
                autoscroller.stop()
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
