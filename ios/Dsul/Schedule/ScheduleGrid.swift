import DsulCore
import SwiftUI

/// A 24-hour timeline: the hour gutter and one day's column (its hour lines,
/// blocks, now marker and drop ghost). The drop target is the 24-hour content
/// inside the ScrollView, not the ScrollView, so drop locations are already
/// in content space. The blocks have no drop handling of their own, so a drop
/// over one still lands on the grid. It takes a braindump row, a block of
/// the day, and an Anytime row (PR 8).
///
/// The column is measured here (`fieldWidth`, the grid right of the gutter),
/// and ScheduleView lays the day out on that width. This body reads the drag
/// only in callbacks, never to draw: the ghost lives in the column's drag
/// layer, so a ghost step leaves this view alone.
///
/// Changing a length (PR 9): the scroll view names its own frame
/// (`ResizeGrips.viewportSpace`), which a grip's gesture measures in, and a
/// tap anywhere on the hours but a block clears the selected block
/// (`TapClearsSelection`). Scrolling keeps it.
///
/// Week × Schedule (PR 10) is WeekSchedule.swift: the same gutter, the same
/// tap, the same drop and the same session updates (`columnUpdate`), seven
/// columns across. Day's hours start at the top of the scroll's content, so
/// it sets the drag's `hoursTop` to 0 and its sideways geometry to none.
struct ScheduleGrid: View {
    @Binding var position: ScrollPosition
    /// The day, laid out once by ScheduleView.
    let day: DaySchedule
    /// Now, on today only.
    let nowMin: Int?
    /// Written with the column's width whenever it changes.
    @Binding var fieldWidth: Double?

    @Environment(SamplePlanner.self) private var planner
    @Environment(ScheduleDrag.self) private var drag

    private let hourPx = CGFloat(ScheduleMetrics.hourPx)

    var body: some View {
        let timeFormat = planner.settings.timeFormat
        ScrollView {
            HStack(alignment: .top, spacing: 0) {
                HourGutter(timeFormat: timeFormat, nowMin: nowMin)
                    // Grows with the text up to the first accessibility size,
                    // then caps (design §5.10), as VerbBar does.
                    .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                ScheduleColumn(day: day, nowMin: nowMin, timeFormat: timeFormat)
                    // A pane is 34pt at the least: past this size a line of
                    // footnote no longer fits in one, so the blocks' and the
                    // ghost's text stops growing here.
                    .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                    .onGeometryChange(for: Double.self) { proxy in
                        Double(proxy.size.width)
                    } action: { width in
                        fieldWidth = width
                    }
            }
            .padding(.trailing, 8)
            .frame(maxWidth: .infinity, minHeight: 24 * hourPx, maxHeight: 24 * hourPx, alignment: .topLeading)
            .contentShape(Rectangle())
            .modifier(TapClearsSelection())
            .dropDestination(for: ItemRef.self) { (refs: [ItemRef], session: DropSession) in
                guard let ref = refs.first else { return }
                drop(ref.id, at: Double(session.location.y))
            }
            .onDropSessionUpdated { session in
                guard let phase = ColumnDropPhase(session.phase) else {
                    drag.noteDropUpdate()
                    return
                }
                drag.columnUpdate(day: day.day, phase: phase, y: Double(session.location.y))
            }
            // Room under midnight for the latest block's floored pane (its
            // nudge and the 34pt floor, so one at 23:59 still shows whole),
            // outside the drop target so a drop's location stays the content's.
            .padding(.bottom, CGFloat(ScheduleMetrics.paneOffset + ScheduleMetrics.paneMinH))
        }
        // The hours' viewport: it stays put while its content scrolls, so a
        // grip measured here moves with the finger alone (ScheduleResize.swift).
        .coordinateSpace(.named(ResizeGrips.viewportSpace))
        .scrollPosition($position)
        .onScrollGeometryChange(for: ScrollGeometry.self, of: { $0 }) { _, geometry in
            drag.offsetY = Double(geometry.contentOffset.y)
            drag.viewportH = Double(geometry.containerSize.height)
            drag.contentH = Double(geometry.contentSize.height)
        }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.frame(in: .global).maxY
        } action: { bottom in
            drag.viewportBottomGlobal = Double(bottom)
        }
        .onAppear {
            drag.hoursTop = 0
            drag.columnDays = []
            position.scrollTo(y: 8 * hourPx)
        }
    }

    /// `id` let go at `contentY` on the day's hours: where the ghost showed
    /// it, the item's own length held at the drag's grab point
    /// (`ScheduleDrag.dropStart`). A braindump row keeps its hour drop
    /// (`schedule`); a block or an Anytime row moves by the drop rule from
    /// the day it was lifted on (`moveBlock`), which sends one write, or none
    /// for a drop it refuses. Routed by the item (`dropOnHour`, through
    /// `dropSource`), not by the drag's memory alone, which a missed lift
    /// leaves another item's. Nothing is selected after it (B3).
    private func drop(_ id: UUID, at contentY: Double) {
        let duration = planner.item(id)?.durationMin ?? drag.durationMin
        let start = drag.dropStart(contentY: contentY, durationMin: duration)
        withAnimation(.snappy) {
            planner.dropOnHour(id, said: drag.source(of: id), on: day.day, startMin: start)
        }
        drag.note("drop \(minutesToTime(start))")
    }
}

extension ColumnDropPhase {
    /// SwiftUI's drop session phase as `ScheduleDrag.columnUpdate` takes it;
    /// nil for a phase that moves no ghost (the data's transfer done).
    init?(_ phase: DropSession.Phase) {
        switch phase {
        case .entering: self = .entering
        case .active: self = .active
        case .exiting: self = .exiting
        case .ended: self = .ended
        default: return nil
        }
    }
}

/// A tap on the hours that no block or grip takes (the gutter, an empty
/// stretch, an hour line) clears the selected block (design §5.6). A block's
/// own tap still opens it, since a child's gesture wins over this one, and a
/// grip's gesture is its own. Its own modifier, so a selection re-renders
/// this alone, never the grid; with nothing selected the tap is off
/// (`.subviews`), and the hours take touches exactly as before. Day's grid
/// and Week × Schedule's both wear it.
struct TapClearsSelection: ViewModifier {
    @Environment(ScheduleDrag.self) private var drag

    func body(content: Content) -> some View {
        let resize = drag.resize
        content.gesture(TapGesture().onEnded { resize.clear() },
                        including: resize.selected != nil ? .all : .subviews)
    }
}

/// The hours down the left: each hour's mark in the user's time format
/// (DsulCore `formatHourLabel`, "9 am" or "09:00"), top-aligned under its
/// line, and on today the time now, in ink, centred on the marker. The mark
/// the reading would run into steps aside (`eclipsedHour`). Day's grid and
/// Week × Schedule's share it; in Week it reads now when the week holds
/// today, whichever columns show.
struct HourGutter: View {
    let timeFormat: TimeFormat
    let nowMin: Int?

    /// The gutter's width (design §5.10), scaled with the text.
    @ScaledMetric(relativeTo: .caption2) private var width = CGFloat(ScheduleBlockMetrics.gutterWidth)
    /// How far below an hour's line the now reading still covers its mark:
    /// the web's `ECLIPSE_PX` at the default size, scaled with the text.
    @ScaledMetric(relativeTo: .caption2) private var eclipse = CGFloat(ScheduleMetrics.eclipsePx)

    private let hourPx = CGFloat(ScheduleMetrics.hourPx)

    var body: some View {
        let hidden = eclipsedLabel
        ZStack(alignment: .topLeading) {
            ForEach(0..<24, id: \.self) { hour in
                Text(formatHourLabel(hour, timeFormat: timeFormat))
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .frame(width: max(0, width - 8), alignment: .leading)
                    .offset(x: 6, y: CGFloat(hour) * hourPx + 3)
                    .opacity(hour == hidden ? 0 : 1)
                    .accessibilityHidden(hour == hidden)
            }
            if let nowMin {
                let clock = formatClock(nowMin, timeFormat: timeFormat)
                Text(clock)
                    .font(.caption2.monospaced().weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(width: max(0, width - 6), alignment: .leading)
                    .position(x: 4 + max(0, width - 6) / 2, y: CGFloat(nowMin) / 60 * hourPx)
                    .accessibilityLabel(Text("Now, \(clock)"))
            }
        }
        .frame(width: width, height: 24 * hourPx, alignment: .topLeading)
    }

    /// The hour whose mark steps aside for the now reading. DsulCore's rule
    /// measures in default-size points; scaling the hour by the factor the
    /// text grew by asks it at this text size.
    private var eclipsedLabel: Int? {
        guard let nowMin else { return nil }
        let scaledHourPx = Double(hourPx) * ScheduleMetrics.eclipsePx / Double(eclipse)
        return eclipsedHour(nowMin: nowMin, hourPx: scaledHourPx)
    }
}
