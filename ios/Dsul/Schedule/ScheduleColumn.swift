import DsulCore
import SwiftUI

/// One day's 24 hours, right of the gutter (design §5.1): the hour lines, the
/// lane, the day's blocks where the overlap pass put them, the now marker on
/// today, and the drop ghost. Day's grid is the gutter and one column; Week ×
/// Schedule (PR 10, WeekSchedule.swift) is the gutter and seven, each in its
/// compact form (`compact`: a block says its title and, from 45 minutes up,
/// its start) and opening its blocks on its own day (`opensOn`).
///
/// The column draws `day`, a value laid out once by ScheduleView, and never
/// reads the drag itself: the ghost is `ScheduleDragLayer`, and a lifted
/// block's hollow outline is each block's own small reader, so a ghost step
/// re-renders that layer alone. The same for a length (PR 9): the grips are
/// `ResizeGripLayer`, and the block a grip reshapes is drawn by its own
/// `ResizableBlock` reader, so a grip's 15-minute step re-renders those two
/// and derives nothing.
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
    /// The day a block's sheet acts on: the selected day's on Day, the
    /// column's own in Week × Schedule (`.on(day)`), as Week × List's rows.
    var opensOn: SheetDay = .selected
    /// Week × Schedule's blocks (design §4.5): one line of title, and the
    /// mono start under it from 45 minutes up.
    var compact = false

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
                    placed(block, fieldWidth: width)
                }
                if let nowMin {
                    NowMarker(y: CGFloat(nowMin) / 60 * hourPx)
                        .zIndex(20)
                }
                // Over every block, so a grip's target wins a touch on the
                // neighbour it overhangs (design §5.6).
                ResizeGripLayer(day: day, fieldWidth: width)
                    .zIndex(25)
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

    /// One block: drawn by its own reader (as the day lays it out, or at a
    /// held grip's span), with its menu and its drag. Its VoiceOver actions
    /// and colour are worked out here, from the block as laid out, so a
    /// grip's step redraws the block without asking the planner again.
    private func placed(_ block: ScheduleBlock, fieldWidth width: Double) -> some View {
        let actions = planner.spokenActions(for: block, in: day)
        let tint = accent(for: block)
        return ResizableBlock(block: block, day: day.day) { drawn, selected, held in
            BlockView(block: drawn, day: day.day, fieldWidth: width, nowMin: nowMin, timeFormat: timeFormat,
                      accent: tint, actions: actions, selected: selected, showsRange: held,
                      onOpen: { planner.open(block.id, day: opensOn) },
                      onTick: { tick(block) },
                      onAction: { action in run(action, on: block) },
                      compact: compact)
        }
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
    /// hosted tests drive). A pick ends any lift the menu's long press began
    /// without a session end (`endStrayLift`, device check M1). Change
    /// length selects the block, which shows its grips; it is the only way
    /// a block is selected (B3), and it writes nothing.
    private func run(_ entry: BlockMenuEntry, on block: ScheduleBlock) {
        drag.endStrayLift()
        if case .changeLength = entry {
            drag.resize.select(block.id, on: day.day)
            return
        }
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

/// A block as it draws now: as the day lays it out, or, while a grip of it
/// is in the hand, at the grip's span (`ScheduleBlock.resized(to:)`), with
/// whether it is selected and whether a grip is held. Its own small view,
/// the only part of a block that reads the length: every block reads
/// whether it is selected (once per selection), and only the selected one
/// reads the grip's span, so a 15-minute step re-renders that block alone.
private struct ResizableBlock<Content: View>: View {
    let block: ScheduleBlock
    let day: DayString
    @ViewBuilder let content: (_ drawn: ScheduleBlock, _ selected: Bool, _ held: Bool) -> Content

    @Environment(ScheduleDrag.self) private var drag

    var body: some View {
        let resize = drag.resize
        let selected = resize.isSelected(block.id, on: day)
        let shown = selected ? resize.shown : nil
        content(shown.map { block.resized(to: $0) } ?? block, selected, shown != nil)
    }
}

/// Where the selected block's grips go (design §5.6): on the selection's
/// own day alone, and only while the block may change length
/// (`canResize`). The selection goes when the block leaves the day or loses
/// the gate. Every column's layer reads which block is selected (once per
/// selection); only the selected day's draws grips, so Week × Schedule's
/// other columns (PR 10) never re-render on a step. Hidden from VoiceOver,
/// which has the block's length actions (§5.9).
private struct ResizeGripLayer: View {
    let day: DaySchedule
    let fieldWidth: Double

    @Environment(ScheduleDrag.self) private var drag
    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        let resize = drag.resize
        let selection = resize.selected.flatMap { $0.day == day.day ? $0 : nil }
        let block = selection.flatMap { selected in day.blocks.first { $0.id == selected.id } }
        let usable = block.map { planner.canResize($0, in: day) } ?? false
        ZStack(alignment: .topLeading) {
            if let block, usable {
                GripPair(block: block, fieldWidth: fieldWidth)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityHidden(true)
        .onChange(of: selection != nil && !usable, initial: true) { _, lost in
            if lost { resize.clear() }
        }
    }
}

/// The selected block's two grips: small ink capsules on its pane's edge,
/// the top one at the leading end and the bottom one at the trailing end,
/// each a 44pt target centred on the edge (`ResizeGrips`), following the
/// edge as a grip moves it. The only view besides the block's reader that
/// reads the grip's span, and the one that plays the light impact at a
/// press and a selection tick at each 15-minute step (design §5.8). It
/// exists only while a block is selected on its day, so no other column
/// plays them.
private struct GripPair: View {
    /// The block as the day lays it out.
    let block: ScheduleBlock
    let fieldWidth: Double

    @Environment(ScheduleDrag.self) private var drag

    var body: some View {
        let resize = drag.resize
        let drawn = resize.shown.map { block.resized(to: $0) } ?? block
        // The lanes are the block's at rest, kept for the whole press, so a
        // grip never jumps from under the finger (`ResizeGrips.placements`).
        let places = ResizeGrips.placements(drawn.frame(fieldWidth: fieldWidth), plan: block.plan)
        ZStack(alignment: .topLeading) {
            ForEach(places, id: \.edge) { place in
                GripHandle(block: block, edge: place.edge)
                    .offset(x: CGFloat(place.x - ResizeGrips.target / 2),
                            y: CGFloat(place.y - ResizeGrips.target / 2))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .sensoryFeedback(.impact(weight: .light), trigger: resize.presses)
        .sensoryFeedback(.selection, trigger: resize.steps)
    }
}

/// One grip: its capsule, in ink ringed in the canvas, inside a 44pt square
/// that takes the touch. `DragGesture(minimumDistance: 0)` as a high
/// priority gesture, so a touch that begins on the grip resizes and never
/// scrolls (device check R1), measured in the hours' viewport
/// (`ResizeGrips.viewportSpace`), which stays put while the grid scrolls
/// under a still finger. The press is the gesture's first change, at
/// touch-down; the release writes through `SamplePlanner.resize`. A gesture
/// that ends with no `onEnded` (cancelled, or its view gone) lets go with
/// nothing written. Each touch acts only on the press it made (`press`): a
/// second finger on the other grip, while one is in the hand, neither
/// drives nor ends it, and presses from where it is once that one is let go.
private struct GripHandle: View {
    /// The block as the day lays it out: the span the press starts from.
    let block: ScheduleBlock
    let edge: ResizeEdge

    @Environment(ScheduleDrag.self) private var drag
    @Environment(SamplePlanner.self) private var planner
    @GestureState private var pressing = false
    /// The number of the press this grip's touch made (`BlockResize.press`),
    /// nil while it holds none. Never cleared at the gesture's end, so the
    /// end and the state's reset can come in either order: a number that is
    /// no longer the press in the hand acts on nothing.
    @State private var press: Int?

    private let target = CGFloat(ResizeGrips.target)

    var body: some View {
        Capsule()
            .fill(Color.primary)
            .frame(width: CGFloat(ResizeGrips.width), height: CGFloat(ResizeGrips.height))
            // Ringed in the canvas, so it reads apart from the pane's own
            // ink outline it sits on.
            .padding(1.5)
            .background { Capsule().fill(Color(.systemBackground)) }
            .frame(width: target, height: target)
            .contentShape(Rectangle())
            .highPriorityGesture(grip)
            .onChange(of: pressing) { _, now in
                // The gesture's state resets at its end as well as at a
                // cancel, in either order with `onEnded`: a cancel is let go
                // a turn later, once `onEnded` has had its chance, and only
                // for the press this touch made.
                guard !now, let press else { return }
                let resize = drag.resize
                Task { @MainActor in resize.cancel(press: press) }
            }
            .onDisappear {
                if let press { drag.resize.cancel(press: press) }
            }
    }

    private var grip: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .named(ResizeGrips.viewportSpace))
            .updating($pressing) { _, state, _ in
                state = true
            }
            .onChanged { value in
                let resize = drag.resize
                let fingerY = Double(value.location.y)
                let translation = Double(value.translation.height)
                // Pressed at the first change; while the other grip is in
                // the hand the press is refused (nil), and taken from where
                // the finger is once that one is let go.
                var made = press
                if !resize.holds(made) {
                    made = resize.press(edge, from: block.span, scrollOffset: drag.offsetY, fingerY: fingerY,
                                        translationY: translation)
                    press = made
                }
                guard let held = made else { return }
                resize.follow(translationY: translation, fingerY: fingerY, scrollOffset: drag.offsetY, press: held)
            }
            .onEnded { _ in
                guard let press, let release = drag.resize.release(press: press) else { return }
                withAnimation(.snappy) {
                    _ = planner.resize(release.id, edge: release.edge, from: release.from, to: release.to)
                }
            }
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
/// drag says (`ghostDay`). The only view on a column that reads the drag's
/// every step. The selection haptic at each 15-minute step (design §5.8) is
/// ScheduleView's `GhostStepHaptic`, once for the Schedule, so Week ×
/// Schedule's seven columns never play it seven times.
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
