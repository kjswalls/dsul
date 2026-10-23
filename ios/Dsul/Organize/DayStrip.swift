import DsulCore
import SwiftUI

/// "Last 14 days" (design §6.3): fourteen cells, oldest on the left and today
/// on the right, then the legend. What each cell is comes from the model
/// (`DayStrip`, ContainerPageModel.swift); this draws it.
///
/// - A past day with something done is a full-strength lime cell, whatever
///   share of the day that was. A day is never drawn as a fraction.
/// - A past day with only unrecorded occurrences is a neutral wash, never a
///   faded lime, and never "missed".
/// - A skipped day, or one with nothing on, is an empty outline.
/// - Today fills from the bottom, done over done and still due, at full
///   strength, inside a 1.5pt `.primary` outline. A tick raises it.
///
/// Lime is a mark here, never text: the legend's words are `.secondary`. No
/// cell sits inside anything faded. To VoiceOver the strip is fourteen
/// elements, one per day ("Oct 12, 2 done", "Today, 2 of 3 done"); the legend
/// says nothing the cells don't, so it is hidden.
struct DayStripView: View {
    let strip: DayStrip

    @ScaledMetric(relativeTo: .body) private var cellHeight: CGFloat = 22
    @ScaledMetric(relativeTo: .footnote) private var swatch: CGFloat = 9

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 3) {
                ForEach(strip.cells) { cell in
                    DayStripCell(mark: cell.mark, height: cellHeight)
                        .frame(maxWidth: .infinity)
                        .frame(height: cellHeight)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Text(cell.spokenLabel))
                }
            }
            // On one line while it fits; at the largest sizes the three
            // parts stack, and the cells keep their columns.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    Text(strip.firstLabel)
                    Spacer(minLength: 8)
                    key
                    Spacer(minLength: 8)
                    Text(ContainerPageModel.legendToday)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(strip.firstLabel)
                    key
                    Text(ContainerPageModel.legendToday)
                }
            }
            .font(.footnote)
            .foregroundStyle(Color.secondary)
            .accessibilityHidden(true)
        }
        .padding(.vertical, 6)
    }

    /// "Done · Nothing recorded", each word after its swatch. The swatches
    /// are the cells' own fills; the words stay gray.
    private var key: some View {
        HStack(spacing: 5) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(Color.accentColor)
                .frame(width: swatch, height: swatch)
            Text(ContainerPageModel.legendDone)
            Text(verbatim: "\u{00B7}")
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(Color(.tertiarySystemFill))
                .frame(width: swatch, height: swatch)
            Text(ContainerPageModel.legendNothingRecorded)
        }
    }
}

/// One day's cell, drawn from its mark.
private struct DayStripCell: View {
    let mark: DayStrip.Cell.Mark
    /// The cell's height, which today's fill takes its share of.
    let height: CGFloat

    private let shape = RoundedRectangle(cornerRadius: 4, style: .continuous)

    var body: some View {
        switch mark {
        case .done:
            shape.fill(Color.accentColor)
        case .nothingRecorded:
            shape.fill(Color(.tertiarySystemFill))
        case .skipped, .nothingOn:
            shape.strokeBorder(Color(.separator), lineWidth: 1)
        case .today(let done, let of):
            // A height from the bottom, so a tick raises the fill. Never a
            // scale: nothing done is a zero scale, a singular transform that
            // Core Animation drops. The fill is the lime at full strength,
            // never an opacity.
            let fraction = of > 0 ? CGFloat(done) / CGFloat(of) : 0
            Rectangle()
                .fill(Color.accentColor)
                .frame(height: height * fraction)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .clipShape(shape)
                .overlay {
                    shape.strokeBorder(Color.primary, lineWidth: 1.5)
                }
                .animation(.snappy, value: fraction)
        }
    }
}
