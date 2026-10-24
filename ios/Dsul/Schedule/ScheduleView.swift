import DsulCore
import SwiftUI

/// The Schedule layout: the Anytime band above the hours, the grid, and the
/// braindump sheet over them; in Week, the week's seven columns
/// (WeekSchedule.swift) under the same sheet. Its drag answers whether a
/// system drag that starts in the sheet lands on the grid behind it, while
/// the sheet changes size. See memory/plans/ios-app.md.
///
/// The day is laid out here, once per change (`daySchedule(on:fieldWidth:)`),
/// and handed down as a value; in Week the seven days are
/// (`weekSchedule(of:columnWidth:)`, from one kept `week(of:)`). This body
/// never reads the drag: only the columns' drag layers, the autoscroll
/// switch and the ghost's haptic do, so a ghost step re-renders those and
/// derives nothing (design §5.1, "What reads what"; §4.6). A grip's step is
/// the same: it re-renders the selected block's reader and the grips, and
/// the switch only at a press's first move and its release.
///
/// Changing a length (PR 9): the autoscroll also runs while a grip in the
/// hand has moved, on both edges, and any sheet, another day, the Day/Week
/// switch or the Schedule going away clears the selected block
/// (`SelectionClearing`).
///
/// Week × Schedule (PR 10): the autoscroll's top edge is below the pinned
/// heads (`ScheduleDrag.hoursTop`), for a drag and a grip alike, and while
/// a drag rests at a side edge of the columns they step a day that way
/// (`ScheduleDrag.sideStep`, behind `ScheduleAutoscroll.handDrivesSideEdges`,
/// device check W-S3).
struct ScheduleView: View {
    var showProbe: Bool
    /// Minutes after midnight on today's clock, from TodayView's
    /// `TimelineView`; the now marker draws it on today only.
    var nowMin: Int
    /// Day or Week: what Today draws (`TodayLayout.effectiveScope`).
    var scope: TodayScope
    /// A week heading's tap, or a strip's "+N more": that day, in Day.
    var openDay: (DayString) -> Void

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drag: ScheduleDrag
    @State private var detent: PresentationDetent = .medium
    /// The hours' scroll, Day's or Week's (one shows at a time).
    @State private var position = ScrollPosition(edge: .top)
    /// Week × Schedule's columns, by day.
    @State private var columns = ScrollPosition(idType: DayString.self)
    @State private var autoscroller = EdgeAutoscroller()
    /// The grid right of the gutter, as last measured: what the overlap pass
    /// lays the blocks out on. Nil until the first layout, when no block draws.
    @State private var fieldWidth: Double?
    /// A Week × Schedule column's width, as last measured, the same way.
    @State private var columnWidth: Double?

    /// `drag` is for hosted tests, which step the ghost on the view's own
    /// drag state; the app passes none.
    init(showProbe: Bool, nowMin: Int, scope: TodayScope = .day, openDay: @escaping (DayString) -> Void = { _ in },
         drag: ScheduleDrag? = nil) {
        self.showProbe = showProbe
        self.nowMin = nowMin
        self.scope = scope
        self.openDay = openDay
        _drag = State(initialValue: drag ?? ScheduleDrag())
    }

    var body: some View {
        @Bindable var planner = planner
        content
            .environment(drag)
            .background {
                AutoscrollSwitch(drag: drag, autoscroller: autoscroller)
                SelectionClearing(resize: drag.resize)
                GhostStepHaptic(drag: drag)
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
            .onChange(of: reduceMotion) {
                // The tick reads Reduce Motion for its sideways step: hand it
                // the setting as it is now.
                autoscroller.onTick = { dt in tick(dt: dt) }
            }
            .onChange(of: scope) {
                // Day and Week each draw their own blocks: a selection, or a
                // drag cut off by the switch, never outlives the one it began
                // in (PR 9's note).
                drag.resize.clear()
                if drag.phase != "idle" { drag.reset() }
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

    /// Day: the band over the day's grid. Week: the week's columns, whose
    /// text stops growing at the second accessibility size, as Day's
    /// blocks' does (a pane is 34pt at the least).
    @ViewBuilder
    private var content: some View {
        switch scope {
        case .day:
            let day = planner.daySchedule(on: planner.selectedDay, fieldWidth: fieldWidth)
            VStack(spacing: 0) {
                AnytimeBand(schedule: day, sheetUp: planner.showBraindumpSheet)
                ScheduleGrid(position: $position, day: day, nowMin: planner.isOnToday ? nowMin : nil,
                             fieldWidth: $fieldWidth)
                    .modifier(LoadingOverlay())
            }
        case .week:
            WeekSchedule(position: $position, columns: $columns,
                         week: planner.weekSchedule(of: planner.selectedDay, columnWidth: columnWidth),
                         nowMin: nowMin, columnWidth: $columnWidth, openDay: openDay)
                .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                .modifier(LoadingOverlay())
        }
    }

    /// One autoscroll frame (`ScheduleAutoscroll`, design §5.4, §5.6). For
    /// a drag: the bottom edge, the one the sheet covers, always; the top
    /// edge behind `ScheduleAutoscroll.drivesTopEdge`, which on Day is off
    /// while the system's own drag autoscroll is trusted with it (device
    /// check M3) and in Week is on, below the pinned heads. For a grip in
    /// the hand: both edges, since no system drag is running to scroll
    /// either, with the finger's height in the viewport, and only once the
    /// grip has moved (`BlockResize.drivesAutoscroll`): a still finger
    /// pressed near an edge scrolls nothing, so it moves no edge. Either
    /// way the top edge starts `hoursTop` down, under Week's heads.
    ///
    /// Sideways first: a drag resting at a side edge of Week's columns steps
    /// them a day (`ScheduleDrag.sideStep`); Day's grid leaves the drag no
    /// columns, so there it is never a step.
    private func tick(dt: Double) {
        let resize = drag.resize
        if ScheduleAutoscroll.handDrivesSideEdges, !resize.isHeld, let day = drag.sideStep(dt: dt) {
            withAnimation(reduceMotion ? nil : .snappy) {
                columns.scrollTo(id: day, anchor: .leading)
            }
        }
        let fingerY: Double
        let topEdge: Bool
        if resize.isHeld {
            guard resize.drivesAutoscroll, let gripY = resize.fingerY else { return }
            fingerY = gripY
            topEdge = true
        } else if let contentY = drag.contentY {
            fingerY = contentY - drag.offsetY
            topEdge = ScheduleAutoscroll.drivesTopEdge(hoursTop: drag.hoursTop)
        } else {
            return
        }
        let covered = max(0, drag.viewportBottomGlobal - drag.sheetTopGlobal)
        let step = ScheduleAutoscroll.step(fingerY: fingerY, viewportH: drag.viewportH, coveredBottom: covered,
                                           dt: dt, topEdge: topEdge, visibleTop: drag.hoursTop)
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

/// Signed in, before the first fetch lands: the spinner, or why it failed
/// with a retry, over the top of the hours. The grid has no pull to refresh
/// (its drag owns the gestures), and an empty grid alone reads as a day with
/// nothing planned. The sample starts loaded, so it never shows.
private struct LoadingOverlay: ViewModifier {
    @Environment(SamplePlanner.self) private var planner

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
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
}

/// The selection haptic at each step of the ghost (design §5.8): a new
/// quarter hour, or a new column in Week. Once for the Schedule, rather than
/// on each column's drag layer, which in Week would play it seven times
/// (design §4.5); and only while a ghost shows, so the ghost going away is
/// no step. Its own empty view, so the drag's every step re-renders only
/// this, never ScheduleView's derive.
private struct GhostStepHaptic: View {
    let drag: ScheduleDrag

    var body: some View {
        let spot = GhostSpot(day: drag.ghostDay, startMin: drag.ghostStartMin)
        Color.clear
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .sensoryFeedback(.selection, trigger: spot) { _, new in
                new.startMin != nil
            }
    }
}

/// Where the ghost is: its column and its start.
private struct GhostSpot: Equatable {
    let day: DayString?
    let startMin: Int?
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
