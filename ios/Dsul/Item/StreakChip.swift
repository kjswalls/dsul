import SwiftUI

/// A habit's streak in the sheet: the flame and the stored count (0 included),
/// then this week's seven days (`ItemSheetModel.weekDots`), first day first:
/// - done: a filled dot in the label colour;
/// - skipped: a dashed ring;
/// - today, not ticked yet: a solid ring;
/// - missed, still to come, or a day off: a faint dot.
/// No dot is drawn in the accent through an opacity, and none in the accent at
/// all: a done day reads by its fill. To VoiceOver, one element: "Streak 41;
/// this week: 3 done".
struct StreakChip: View {
    let streak: Int
    let dots: [StreakDot]
    /// Today is ticked: the flame lights, as a row's does.
    let lit: Bool
    let spoken: String

    @ScaledMetric(relativeTo: .subheadline) private var dotSize: CGFloat = 7

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 3) {
                Image(systemName: "flame.fill")
                    .foregroundStyle(lit ? Color.orange : Color.secondary)
                Text("\(streak)")
                    .monospacedDigit()
            }
            HStack(spacing: 3) {
                ForEach(0..<dots.count, id: \.self) { index in
                    dotView(dots[index])
                        .frame(width: dotSize, height: dotSize)
                }
            }
        }
        .font(.subheadline)
        .chipBackground()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(spoken))
    }

    @ViewBuilder
    private func dotView(_ dot: StreakDot) -> some View {
        switch dot {
        case .done:
            Circle().fill(Color.primary)
        case .skipped:
            Circle().strokeBorder(Color.secondary, style: StrokeStyle(lineWidth: 1, dash: [1.5, 1.5]))
        case .today:
            Circle().strokeBorder(Color.primary, lineWidth: 1.25)
        case .rest:
            Circle().fill(Color(.quaternarySystemFill))
        }
    }
}
