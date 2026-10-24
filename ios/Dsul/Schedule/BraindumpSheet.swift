import DsulCore
import SwiftUI

/// The braindump as a sheet over the Schedule grid. Rows drag onto an hour
/// (a long press lifts one); a tap opens the row's sheet, stacked on this one.
///
/// At .large the sheet dims what is behind it, and a dimmed grid can't take a
/// drop, so a drag that starts at .large drops the sheet to .medium at once,
/// and to .peek as soon as the finger leaves the sheet.
///
/// It is also where a block or an Anytime row goes to the braindump by drag
/// (Move to Braindump, design §5.4, PR 8): a drop target on the whole
/// `NavigationStack`, so the peek, mostly its navigation bar, still takes
/// one. It takes no drag that began in it, so a row let go back inside
/// still ends as a cancel and the sheet goes back to its size; a drop the
/// rule refuses (a habit, a repeating task) gets the system's forbidden
/// badge. A drag from the grid leaves the sheet's size alone.
struct BraindumpSheet: View {
    @Binding var detent: PresentationDetent

    @Environment(SamplePlanner.self) private var planner
    @Environment(ScheduleDrag.self) private var drag
    /// The list's top inside the sheet, below the inline navigation bar.
    @State private var listTop: CGFloat = 0

    var body: some View {
        NavigationStack {
            List(planner.braindump) { item in
                // A tap, not a Button: the long press that lifts the row for
                // the drag stays the system's alone.
                BraindumpRow(item: item)
                    .onTapGesture { planner.open(item.id, day: .selected) }
                    .draggable(containerItemID: item.id)
                    .accessibilityAction { planner.open(item.id, day: .selected) }
                    .accessibilityAction(named: "Schedule at 9:00") {
                        planner.schedule(item.id, startMin: 9 * 60)
                    }
            }
            .listStyle(.plain)
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.frame(in: .named(braindumpSheetSpace)).minY
            } action: { top in
                listTop = top
            }
            .dragContainer(for: ItemRef.self) { ids in
                ids.map { ItemRef(id: $0) }
            }
            .onDragSessionUpdated { session in
                switch session.phase {
                case .initial:
                    let id = session.draggedItemIDs(for: UUID.self).first
                    drag.begin(itemID: id, durationMin: planner.item(id)?.durationMin ?? 30, detent: detent)
                    if detent == .large {
                        withAnimation(.snappy) { detent = .medium }
                    }
                case .active:
                    drag.noteMove()
                    // The location is in the list's space; above the sheet's own
                    // top (not just the list's, which sits under the nav bar)
                    // means the finger has left the sheet.
                    if session.location.y + listTop < 0, detent != .peek {
                        drag.note("left sheet")
                        withAnimation(.snappy) { detent = .peek }
                    }
                case .ended(let operation):
                    drag.note("ended \(operation)")
                    // A drop that landed leaves the sheet small, so the new
                    // block shows; a cancelled or refused one puts it back.
                    // Decided from the operation, not from the planner: the
                    // grid's drop handler can run after this callback.
                    switch operation {
                    case .cancel, .forbidden:
                        if let before = drag.detentBeforeDrag {
                            withAnimation(.snappy) { detent = before }
                        }
                    default:
                        break
                    }
                    drag.reset()
                default:
                    break
                }
            }
            .navigationTitle("Braindump")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close", systemImage: "xmark") {
                        planner.showBraindumpSheet = false
                    }
                }
            }
        }
        .dropDestination(for: ItemRef.self, isEnabled: takesDrops) {
            (refs: [ItemRef], _: DropSession) in
            guard let ref = refs.first else { return }
            drop(ref.id)
        }
        .dropConfiguration { _ in
            DropConfiguration(operation: proposal())
        }
        .coordinateSpace(.named(braindumpSheetSpace))
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.frame(in: .global).minY
        } action: { top in
            drag.sheetTopGlobal = Double(top)
        }
        .presentationDetents([.peek, .medium, .large], selection: $detent)
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled()
        // Closed or swapped out mid-drag (Close, or the layout capsule, tapped
        // with a second finger): `.ended` never reaches a list that is gone,
        // so the drag's hold on fetched data is let go here.
        .onDisappear {
            if drag.phase != "idle" { drag.reset() }
            // No sheet covers the grid now: a later drag's bottom edge is the
            // grid's own (design §5.4, "A stale sheet top").
            drag.sheetTopGlobal = .infinity
        }
    }

    /// Whether the sheet is a destination: always, but while one of its own
    /// rows is in the air, so a row let go inside still ends as a cancel and
    /// the sheet goes back to its size. Read off the live drag, never
    /// `source` alone, which outlives `reset`: an idle sheet stays enabled,
    /// so a block's drag never has to switch it on mid-session (README,
    /// Moving a block, check 6). `proposal()` answers a cancel for a
    /// braindump row too, in case the switch off lands late.
    private var takesDrops: Bool {
        return !(drag.inFlight && drag.source == DragSource.braindump)
    }

    /// The sheet's proposal for the drag in the air, decided from what the
    /// drag says was lifted (the `ItemRef` is read only at the drop): no drop
    /// for a braindump row (a cancel, as with no destination at all); for a
    /// block or an Anytime row, forbidden when the rule or a gate refuses
    /// the braindump from the day it was lifted on (`refusesDrop`), else a
    /// move.
    private func proposal() -> DropOperation {
        guard let from = drag.source?.day else { return .cancel }
        guard let id = drag.itemID else { return .forbidden }
        let refused = planner.refusesDrop(id, from: planner.blockOrigin(id, on: from), to: .braindump)
        return refused ? .forbidden : .move
    }

    /// A block or an Anytime row let go on the sheet: Move to Braindump
    /// through the drop rule (`moveBlock`), one `unschedule`, or nothing for
    /// a drop it refuses. A braindump row (`dropSource`, routed by the item
    /// as the grid's drop is) is already there, and lands as nothing.
    private func drop(_ id: UUID) {
        guard let from = planner.dropSource(id, said: drag.source(of: id), on: planner.selectedDay).day
        else { return }
        withAnimation(.snappy) {
            _ = planner.moveBlock(id, from: planner.blockOrigin(id, on: from), to: .braindump)
        }
        drag.note("drop braindump")
    }
}

/// A file-level constant, not a static on the view: the geometry closures are
/// @Sendable and can't read a main-actor static.
private let braindumpSheetSpace = "braindump-sheet"

/// A captured thought and its length. One VoiceOver element, a button whose
/// activation opens the sheet; the list adds "Schedule at 9:00".
private struct BraindumpRow: View {
    var item: SampleItem

    var body: some View {
        HStack {
            Text(item.title)
            Spacer()
            Text("\(item.durationMin)m")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
        // Hit over the list row's full 44pt, not just the line of text, and
        // laid out as before.
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .padding(.vertical, -11)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(item.title), \(item.durationMin) minutes"))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Opens details")
    }
}
