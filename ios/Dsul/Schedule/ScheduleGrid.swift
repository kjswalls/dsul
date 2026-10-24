import DsulCore
import SwiftUI

/// A 24-hour timeline: the hour gutter and one day's column (its hour lines,
/// blocks, now marker and drop ghost). The drop target is the 24-hour content
/// inside the ScrollView, not the ScrollView, so drop locations are already
/// in content space. The blocks have no drop handling of their own, so a drop
/// over one still lands on the grid.
///
/// The column is measured here (`fieldWidth`, the grid right of the gutter),
/// and ScheduleView lays the day out on that width. This body reads the drag
/// only in callbacks, never to draw: the ghost lives in the column's drag
/// layer, so a ghost step leaves this view alone.
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
            .dropDestination(for: ItemRef.self) { (refs: [ItemRef], session: DropSession) in
                guard let ref = refs.first else { return }
                let duration = planner.item(ref.id)?.durationMin ?? drag.durationMin
                let start = snappedStart(contentY: Double(session.location.y), hourPx: ScheduleMetrics.hourPx,
                                         durationMin: duration)
                planner.schedule(ref.id, startMin: start)
                drag.note("drop \(minutesToTime(start))")
            }
            .onDropSessionUpdated { session in
                drag.noteDropUpdate()
                switch session.phase {
                case .entering, .active:
                    drag.setContentY(Double(session.location.y))
                case .exiting, .ended:
                    drag.clearGhost()
                default:
                    break
                }
            }
            // Room under midnight for the latest block's floored pane (its
            // nudge and the 34pt floor, so one at 23:59 still shows whole),
            // outside the drop target so a drop's location stays the content's.
            .padding(.bottom, CGFloat(ScheduleMetrics.paneOffset + ScheduleMetrics.paneMinH))
        }
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
            position.scrollTo(y: 8 * hourPx)
        }
    }
}

/// The hours down the left: each hour's mark in the user's time format
/// (DsulCore `formatHourLabel`, "9 am" or "09:00"), top-aligned under its
/// line, and on today the time now, in ink, centred on the marker. The mark
/// the reading would run into steps aside (`eclipsedHour`).
private struct HourGutter: View {
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
