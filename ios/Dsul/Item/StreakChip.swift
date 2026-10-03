import SwiftUI

/// A habit's streak in the sheet: the flame and the stored count (0 included),
/// then this week's seven days (`ItemSheetModel.weekDots`), first day first,
/// each a `StreakDotView`, and a chevron. From 2b it is a button's label: the
/// page wraps it in its slot (`chipSlot()`) and a `Button` that opens the
/// streak popover (`StreakPopover`), so the chevron says it opens something,
/// as an editable chip's will. To VoiceOver it stays one element, "Streak 41;
/// this week: 3 done"; the button adds its trait and its hint.
///
/// Nothing in it is drawn in the accent: a done day reads by its fill, and
/// the count is the label colour, set here rather than left to the button,
/// whose tint is the 1.5:1 lime.
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
                    .foregroundStyle(Color.primary)
            }
            HStack(spacing: 3) {
                ForEach(0..<dots.count, id: \.self) { index in
                    StreakDotView(dot: dots[index])
                        .frame(width: dotSize, height: dotSize)
                }
            }
            Image(systemName: "chevron.down")
                .imageScale(.small)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        }
        .font(.subheadline)
        .chipBackground()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(spoken))
    }
}

/// One day of a streak's week, drawn at whatever size its frame gives it:
/// - done: a filled dot in the label colour;
/// - skipped: a dashed ring;
/// - today, not ticked yet: a solid ring;
/// - missed, still to come, or a day off: a faint dot.
/// The chip draws it small, the popover larger, with `lineScale` thickening
/// the rings to match.
struct StreakDotView: View {
    let dot: StreakDot
    /// The rings' weight against the chip's (1).
    var lineScale: CGFloat = 1

    var body: some View {
        switch dot {
        case .done:
            Circle().fill(Color.primary)
        case .skipped:
            Circle().strokeBorder(Color.secondary,
                                  style: StrokeStyle(lineWidth: lineScale, dash: [1.5 * lineScale, 1.5 * lineScale]))
        case .today:
            Circle().strokeBorder(Color.primary, lineWidth: 1.25 * lineScale)
        case .rest:
            Circle().fill(Color(.quaternarySystemFill))
        }
    }
}
