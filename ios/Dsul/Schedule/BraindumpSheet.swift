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
                    // Above the list's top edge means the finger has left the sheet.
                    if session.location.y < 0, detent != .peek {
                        drag.note("left sheet")
                        withAnimation(.snappy) { detent = .peek }
                    }
                case .ended(let operation):
                    drag.note("ended \(operation)")
                    // A drop that landed leaves the sheet small, so the new
                    // block shows; anything else puts the sheet back.
                    if !planner.isScheduled(drag.itemID), let before = drag.detentBeforeDrag {
                        withAnimation(.snappy) { detent = before }
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
