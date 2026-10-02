import DsulCore
import SwiftUI

/// A 24-hour timeline: hour rows, the day's blocks, and the drop ghost.
/// The drop target is the 24-hour content inside the ScrollView, not the
/// ScrollView, so drop locations are already in content space. A tap on a
/// block opens its item's sheet, acting on the selected day; the blocks are
/// plain buttons with no drop handling of their own, so a drop over one still
/// lands on the grid.
struct ScheduleGrid: View {
    @Binding var position: ScrollPosition

    @Environment(SamplePlanner.self) private var planner
    @Environment(ScheduleDrag.self) private var drag

    private let hourPx = CGFloat(ScheduleMetrics.hourPx)
    private let gutter: CGFloat = 52
    private var pxPerMin: CGFloat { hourPx / 60 }

    var body: some View {
        ScrollView {
            ZStack(alignment: .topLeading) {
                hourRows
                ForEach(planner.scheduled) { item in
                    if let start = item.startMin {
                        // `scheduled` hands back copies drawn at the block's
                        // time; the sheet reads the stored item by its id.
                        Button {
                            planner.open(item.id, day: .selected)
                        } label: {
                            BlockView(title: item.title, time: minutesToTime(start), ghost: false)
                        }
                        .buttonStyle(PressScaleStyle(scale: 0.97))
                        .accessibilityLabel(Text(blockLabel(item, start: start)))
                        .accessibilityHint("Opens details")
                        .frame(height: max(18, CGFloat(item.durationMin) * pxPerMin - 2))
                        .padding(.leading, gutter)
                        .padding(.trailing, 12)
                        .offset(y: CGFloat(start) * pxPerMin + 1)
                    }
                }
                if let start = drag.ghostStartMin {
                    BlockView(title: planner.item(drag.itemID)?.title ?? "", time: minutesToTime(start), ghost: true)
                        .frame(height: max(18, CGFloat(drag.durationMin) * pxPerMin - 2))
                        .padding(.leading, gutter)
                        .padding(.trailing, 12)
                        .offset(y: CGFloat(start) * pxPerMin + 1)
                        .allowsHitTesting(false)
                }
            }
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
        .sensoryFeedback(.selection, trigger: drag.ghostStartMin)
        .onAppear {
            position.scrollTo(y: 8 * hourPx)
        }
    }

    /// "Draft Q4 roadmap, 9 to 11 AM": the block's title and its drawn time.
    private func blockLabel(_ item: SampleItem, start: Int) -> String {
        let time = PlannerFormat.spokenRowTime(startMin: start, durationMin: item.durationMin) ?? ""
        return time.isEmpty ? item.title : "\(item.title), \(time)"
    }

    private var hourRows: some View {
        VStack(spacing: 0) {
            ForEach(0..<24, id: \.self) { hour in
                HStack(alignment: .top, spacing: 8) {
                    Text(minutesToTime(hour * 60))
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: gutter - 8, alignment: .trailing)
                        .offset(y: -6)
                    Rectangle()
                        .fill(.separator)
                        .frame(height: 0.5)
                }
                .frame(height: hourPx, alignment: .top)
            }
        }
    }
}

private struct BlockView: View {
    var title: String
    var time: String
    var ghost: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(time)
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
            Text(title)
                .font(.footnote.weight(.medium))
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(ghost ? Color.accentColor.opacity(0.35) : Color(.secondarySystemBackground))
        }
        .overlay {
            if ghost {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(Color.accentColor, style: StrokeStyle(lineWidth: 1.5, dash: [5, 3]))
            }
        }
    }
}
