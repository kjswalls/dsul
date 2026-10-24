import DsulCore
import SwiftUI

/// Now, on today's column (design §5.1): the web's lime diamond on the rail
/// line, ringed in the canvas colour, and a short lime stub off it into the
/// field, never a rule across a pane (day-schedule.tsx's now marker). The
/// time itself is the gutter's reading, in ink. Lime here is a mark at full
/// strength, so nothing above the marker fades it.
///
/// `y` is now's line, from midnight, in the field's points.
struct NowMarker: View {
    let y: CGFloat

    private let diamond = CGFloat(ScheduleMetrics.nowDiamondSize)
    private let stubWidth = CGFloat(ScheduleMetrics.nowStubWidth)

    var body: some View {
        ZStack(alignment: .topLeading) {
            // The stub, from the lane's edge into the field.
            Rectangle()
                .fill(Color.accentColor)
                .frame(width: stubWidth, height: 1)
                .offset(x: CGFloat(ScheduleMetrics.lanePx), y: y - 0.5)
            // The canvas ring, a point wider than the diamond each way.
            Rectangle()
                .fill(Color(.systemBackground))
                .frame(width: diamond + 2, height: diamond + 2)
                .rotationEffect(.degrees(45))
                .offset(x: 1, y: y - diamond / 2 - 1)
            Rectangle()
                .fill(Color.accentColor)
                .frame(width: diamond, height: diamond)
                .rotationEffect(.degrees(45))
                .offset(x: 2, y: y - diamond / 2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
