import DsulCore
import SwiftUI

/// One day's 24 hours, right of the gutter (design §5.1): the hour lines, the
/// lane, the day's blocks where the overlap pass put them, the now marker on
/// today, and the drop ghost. Day's grid is the gutter and one column; Week ×
/// Schedule (PR 10) will be the gutter and seven.
///
/// The column draws `day`, a value laid out once by ScheduleView, and never
/// reads the drag itself: the ghost is `ScheduleDragLayer`, the one child
/// that does, so a ghost step re-renders that layer alone.
///
/// Everything is placed in the field's own points, as the web places it
/// (components/views/day-schedule.tsx): x from the field's left edge, y from
/// midnight at `ScheduleMetrics.hourPx` an hour.
struct ScheduleColumn: View {
    let day: DaySchedule
    /// Now, on today only.
    let nowMin: Int?
    let timeFormat: TimeFormat

    @Environment(SamplePlanner.self) private var planner

    private let hourPx = CGFloat(ScheduleMetrics.hourPx)

    var body: some View {
        ZStack(alignment: .topLeading) {
            HourLines()
            // The lane: a hairline down the field where the rails run.
            Rectangle()
                .fill(.separator)
                .frame(width: 1, height: 24 * hourPx)
                .offset(x: 5)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            if let width = day.fieldWidth {
                ForEach(day.blocks) { block in
                    BlockView(block: block, fieldWidth: width, nowMin: nowMin, timeFormat: timeFormat,
                              accent: accent(for: block),
                              onOpen: { planner.open(block.id, day: .selected) },
                              onTick: { tick(block) })
                        .zIndex(Double(block.plan.z))
                }
                if let nowMin {
                    NowMarker(y: CGFloat(nowMin) / 60 * hourPx)
                        .zIndex(20)
                }
                ScheduleDragLayer(fieldWidth: width, timeFormat: timeFormat)
                    .zIndex(30)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 24 * hourPx, maxHeight: 24 * hourPx, alignment: .topLeading)
    }

    /// The rail and bead's colour: the project's (`projectAccent`, Organize's
    /// port of the web's), or lime for a block with no project, the web's
    /// `var(--primary)`, at full strength.
    private func accent(for block: ScheduleBlock) -> Color {
        guard let project = block.project else { return Color.accentColor }
        return planner.projectAccent(for: project).color
    }

    /// A block's check: the web's row tick on the column's day
    /// (`tickBlock`, which ScheduleLayoutTests drives).
    private func tick(_ block: ScheduleBlock) {
        withAnimation(.snappy) { planner.tickBlock(block, in: day) }
    }
}

/// A hairline at every hour but midnight, from the lane's edge to the field's
/// right, as day-schedule.tsx draws them.
private struct HourLines: View {
    private let hourPx = CGFloat(ScheduleMetrics.hourPx)

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(1..<24, id: \.self) { hour in
                Rectangle()
                    .fill(.separator)
                    .frame(height: 0.5)
                    .padding(.leading, CGFloat(ScheduleMetrics.lanePx))
                    .padding(.trailing, 4)
                    .offset(y: CGFloat(hour) * hourPx - 0.25)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 24 * hourPx, maxHeight: 24 * hourPx, alignment: .topLeading)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The drop ghost: where a braindump row would land, drawn as a lone block
/// (`blockFrame` with no plan) of the dragged row's length, a lime tint with
/// dashed lime edges and its landing time in ink. The only view on the grid
/// that reads the drag, and the one that ticks a selection haptic at each
/// 15-minute step (design §5.8).
private struct ScheduleDragLayer: View {
    let fieldWidth: Double
    let timeFormat: TimeFormat

    @Environment(ScheduleDrag.self) private var drag
    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let start = drag.ghostStartMin {
                let lone = blockFrame(startMin: start, duration: drag.durationMin, fieldWidth: fieldWidth)
                GhostPane(title: planner.item(drag.itemID)?.title ?? "",
                          time: formatClock(start, timeFormat: timeFormat))
                    .frame(width: CGFloat(lone.paneWidth), height: CGFloat(lone.paneHeight))
                    .offset(x: CGFloat(lone.paneX), y: CGFloat(lone.paneTop))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .sensoryFeedback(.selection, trigger: drag.ghostStartMin)
    }
}

/// The ghost's pane. Its tint is a fill colour, not an opacity over a lime
/// mark; its time is ink, never lime (design §5.1).
private struct GhostPane: View {
    let title: String
    let time: String

    var body: some View {
        HStack(spacing: 6) {
            Text(time)
                .font(.caption2.monospaced().weight(.medium))
                .foregroundStyle(.primary)
            Text(title)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.primary)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: CGFloat(ScheduleMetrics.paneRadius), style: .continuous)
                .fill(Color.accentColor.opacity(0.35))
        }
        .overlay {
            RoundedRectangle(cornerRadius: CGFloat(ScheduleMetrics.paneRadius), style: .continuous)
                .strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 1.5, dash: [5, 3]))
        }
    }
}
