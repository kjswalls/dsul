import DsulCore
import SwiftUI

/// On-phone readings for the drag spike, so its pass/fail tests can be read
/// without a debugger. Toggled from the Today toolbar.
struct DragProbeHUD: View {
    var detent: PresentationDetent
    /// Fills the day to 40 blocks; nil hides the button (signed in, where
    /// `stress()` does nothing).
    var onStress: (() -> Void)?

    @Environment(ScheduleDrag.self) private var drag

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("phase \(drag.phase) · drop updates \(drag.dropUpdates) · \(drag.updatesPerSecond)/s")
            Text("ghost \(drag.ghostStartMin.map(minutesToTime) ?? "–") · finger y \(drag.contentY.map { String(Int($0)) } ?? "–")")
            Text("sheet \(detentName) · sheet top \(Int(drag.sheetTopGlobal.isFinite ? drag.sheetTopGlobal : -1)) · grid bottom \(Int(drag.viewportBottomGlobal))")
            Text("autoscroll steps \(drag.autoscrollSteps) · offset \(Int(drag.offsetY))")
            Text(drag.events.joined(separator: " › "))
                .lineLimit(2)
            if let onStress {
                Button("Load 40 blocks", action: onStress)
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
            }
        }
        .font(.caption2.monospaced())
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var detentName: String {
        switch detent {
        case .large: "large"
        case .medium: "medium"
        case .peek: "peek"
        default: "other"
        }
    }
}
