import DsulCore
import SwiftUI

/// The braindump as a sheet over the Schedule grid. Rows drag onto an hour.
///
/// At .large the sheet dims what is behind it, and a dimmed grid can't take a
/// drop, so a drag that starts at .large drops the sheet to .medium at once,
/// and to .peek as soon as the finger leaves the sheet.
struct BraindumpSheet: View {
    @Binding var detent: PresentationDetent

    @Environment(SamplePlanner.self) private var planner
    @Environment(ScheduleDrag.self) private var drag
    /// The list's top inside the sheet, below the inline navigation bar.
    @State private var listTop: CGFloat = 0

    var body: some View {
        NavigationStack {
            List(planner.braindump) { item in
                BraindumpRow(item: item)
                    .draggable(containerItemID: item.id)
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
    }
}

/// A file-level constant, not a static on the view: the geometry closures are
/// @Sendable and can't read a main-actor static.
private let braindumpSheetSpace = "braindump-sheet"

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
        .contentShape(Rectangle())
    }
}
