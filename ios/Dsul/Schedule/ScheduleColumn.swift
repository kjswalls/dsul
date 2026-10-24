import DsulCore
import SwiftUI

/// One day's 24 hours, right of the gutter (design §5.1): the hour lines, the
/// lane, the day's blocks where the overlap pass put them, the now marker on
/// today, and the drop ghost. Day's grid is the gutter and one column; Week ×
/// Schedule (PR 10) will be the gutter and seven.
///
/// The column draws `day`, a value laid out once by ScheduleView, and never
/// reads the drag itself: the ghost is `ScheduleDragLayer`, and a lifted
/// block's hollow outline is each block's own small reader, so a ghost step
/// re-renders that layer alone.
///
/// It is also the blocks' drag container (design §5.4, PR 8): a block lifts
/// with a hold and a move (`.draggable(containerItemID:)`, the same in-app
/// `ItemRef` the braindump drags), and a hold that stays still opens its
/// menu. A block that can go nowhere (`canLift`), a skipped strip among
/// them, gets no drag. The session's start tells the drag where it came
/// from and where the finger holds it; the drop is the grid's, the band's or
/// the braindump sheet's.
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
    /// Written from the drag session's and the menu's callbacks only, never
    /// read to draw.
    @Environment(ScheduleDrag.self) private var drag

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
                              actions: planner.spokenActions(for: block, in: day),
                              onOpen: { planner.open(block.id, day: .selected) },
                              onTick: { tick(block) },
                              onAction: { action in run(action, on: block) })
                        .contextMenu {
                            BlockMenuItems(menu: planner.blockMenu(for: block, in: day)) { entry in
                                run(entry, on: block)
                            } onReschedule: { date in
                                drag.endStrayLift()
                                withAnimation(.snappy) { planner.move(block.id, to: date) }
                            }
                        }
                        .modifier(LiftsWhen(enabled: planner.canLift(block, in: day), id: block.id))
                        .zIndex(Double(block.plan.z))
                }
                if let nowMin {
                    NowMarker(y: CGFloat(nowMin) / 60 * hourPx)
                        .zIndex(20)
                }
                ScheduleDragLayer(day: day.day, fieldWidth: width, timeFormat: timeFormat)
                    .zIndex(30)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 24 * hourPx, maxHeight: 24 * hourPx, alignment: .topLeading)
        .dragContainer(for: ItemRef.self) { ids in
            ids.map { ItemRef(id: $0) }
        }
        .onDragSessionUpdated { session in
            switch session.phase {
            case .initial:
                lift(session.draggedItemIDs(for: UUID.self).first, fingerY: Double(session.location.y))
            case .active:
                drag.noteMove()
            case .ended(let operation):
                drag.note("ended \(operation)")
                drag.reset()
            default:
                break
            }
        }
    }

    /// A block lifted (the session's `.initial`): the drag learns what it
    /// is, its own length for the ghost (a task in a project block is drawn
    /// at the block's), where the finger holds it, and the column it keeps
    /// to when it moves in time only. The location is the column's, which
    /// is the grid's content space: the column starts at midnight.
    private func lift(_ id: UUID?, fingerY: Double) {
        guard let id, let block = day.blocks.first(where: { $0.id == id }) else { return }
        let duration = planner.item(id)?.durationMin ?? block.duration
        let top = Double(block.startMin) / 60 * ScheduleMetrics.hourPx
        drag.beginMove(itemID: id, durationMin: duration, source: .block(day: day.day),
                       anchor: ScheduleDrag.grabAnchor(fingerY: fingerY, blockTop: top, durationMin: duration),
                       confinedTo: planner.confinedDay(id, from: day.day))
    }

    /// A menu entry on the block's day (`SamplePlanner.run`, which the
    /// hosted tests drive). Nothing is selected after it (B3). A pick ends
    /// any lift the menu's long press began without a session end
    /// (`endStrayLift`, device check M1).
    private func run(_ entry: BlockMenuEntry, on block: ScheduleBlock) {
        drag.endStrayLift()
        withAnimation(.snappy) { planner.run(entry, on: block, in: day) }
    }

    /// One of the block's VoiceOver actions.
    private func run(_ action: BlockSpokenAction, on block: ScheduleBlock) {
        withAnimation(.snappy) { planner.run(action, on: block, in: day) }
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

/// A block's or an Anytime row's drag, on only when it can go somewhere:
/// one that can't lift has no `draggable` at all, so a hold on a block is
/// its menu alone. Inside its container's `.dragContainer(for: ItemRef.self)`.
struct LiftsWhen: ViewModifier {
    let enabled: Bool
    let id: UUID

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content.draggable(containerItemID: id)
        } else {
            content
        }
    }
}

/// A block's menu (design §5.4): the web's verbs in its three groups, a
/// divider between them, each under its label and the item sheet's symbol.
/// Reschedule is a submenu of Today, Tomorrow and Next week.
private struct BlockMenuItems: View {
    let menu: BlockMenu
    let onRun: (BlockMenuEntry) -> Void
    let onReschedule: (String) -> Void

    var body: some View {
        let groups = [menu.status, menu.moves, menu.own].filter { !$0.isEmpty }
        ForEach(groups.indices, id: \.self) { index in
            if index > 0 { Divider() }
            ForEach(groups[index], id: \.self) { entry in
                item(entry)
            }
        }
    }

    @ViewBuilder
    private func item(_ entry: BlockMenuEntry) -> some View {
        switch entry {
        case .reschedule(let title, let choices):
            Menu(title, systemImage: entry.symbol) {
                ForEach(choices, id: \.self) { choice in
                    Button(choice.title, systemImage: choice.symbol) { onReschedule(choice.date) }
                }
            }
        case .nextDay(let title, let detail, _):
            Button { onRun(entry) } label: {
                Label(title, systemImage: entry.symbol)
                // The landing day as the row's subtitle, as the web's detail.
                if let detail {
                    Text(detail)
                }
            }
        default:
            Button(entry.title, systemImage: entry.symbol) { onRun(entry) }
        }
    }
}

/// The drop ghost: where a dragged row or block would land, drawn as a lone
/// block (`blockFrame` with no plan) of the item's own length, a lime tint
/// with dashed lime edges and its landing time in ink, on the column the
/// drag says (`ghostDay`). The only view on the grid that reads the drag's
/// every step, and the one that ticks a selection haptic at each 15-minute
/// step (design §5.8).
private struct ScheduleDragLayer: View {
    let day: DayString
    let fieldWidth: Double
    let timeFormat: TimeFormat

    @Environment(ScheduleDrag.self) private var drag
    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let start = drag.ghostStartMin, drag.ghostDay == nil || drag.ghostDay == day {
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
