import SwiftUI

/// Chips laid out left to right, wrapping onto new lines, as the web panel's
/// property field wraps. Each chip is offered the full width and held to it,
/// so a long one (a reminder's cue words, a long project name) truncates on
/// its own line instead of running off the sheet.
///
/// The lines touch (`lineSpacing` 0): every chip comes in its slot
/// (`chipSlot()`), which brings 6pt above and below its capsule, so capsules
/// sit 12pt apart on every line at every text size, whichever chip on a line
/// is the tallest. The slot is also what gives the streak chip, a button, its
/// 44pt of height to hit inside its own line; were it the only chip in one,
/// its line would sit further from the next than the others do.
struct ChipFlow: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 0

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let lines = arrange(subviews, maxWidth: proposal.width)
        let width = lines.map(\.width).max() ?? 0
        let heights = lines.reduce(CGFloat(0)) { $0 + $1.height }
        return CGSize(width: width, height: heights + lineSpacing * CGFloat(max(0, lines.count - 1)))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for line in arrange(subviews, maxWidth: bounds.width) {
            for chip in line.chips {
                subviews[chip.index].place(
                    at: CGPoint(x: bounds.minX + chip.x, y: y + (line.height - chip.size.height) / 2),
                    anchor: .topLeading,
                    proposal: ProposedViewSize(width: chip.size.width, height: chip.size.height)
                )
            }
            y += line.height + lineSpacing
        }
    }

    private struct Placed {
        var index: Int
        var x: CGFloat
        var size: CGSize
    }

    private struct Line {
        var chips: [Placed] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    /// Fills each line until the next chip doesn't fit. Nil width (asked for
    /// an ideal size) is one line.
    private func arrange(_ subviews: Subviews, maxWidth: CGFloat?) -> [Line] {
        let limit = maxWidth ?? .infinity
        let offer = ProposedViewSize(width: limit.isFinite ? limit : nil, height: nil)
        var lines: [Line] = []
        var line = Line()
        for index in subviews.indices {
            var size = subviews[index].sizeThatFits(offer)
            size.width = min(size.width, limit)
            let x = line.chips.isEmpty ? 0 : line.width + spacing
            if !line.chips.isEmpty && x + size.width > limit + 0.5 {
                lines.append(line)
                line = Line(chips: [Placed(index: index, x: 0, size: size)], width: size.width, height: size.height)
            } else {
                line.chips.append(Placed(index: index, x: x, size: size))
                line.width = x + size.width
                line.height = max(line.height, size.height)
            }
        }
        if !line.chips.isEmpty { lines.append(line) }
        return lines
    }
}

/// One read-only property chip: its symbol (or a project's colour dot) and
/// its words. Not a button and no press state in part 1, so it doesn't
/// promise an edit it can't make; to VoiceOver, one element with a spoken
/// label ("Time: 9:00 to 11:00 am").
struct ChipView: View {
    let chip: SheetChip
    /// A project's colour, drawn as a dot in place of a symbol.
    var dot: Color? = nil

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .subheadline) private var dotSize: CGFloat = 8

    var body: some View {
        HStack(spacing: 5) {
            if let dot {
                Circle().fill(dot).frame(width: dotSize, height: dotSize)
            } else if let symbol = chip.systemImage {
                Image(systemName: symbol)
                    .foregroundStyle(.secondary)
            }
            Text(chip.text)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
        }
        .font(.subheadline)
        .chipBackground()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(chip.spoken))
    }
}

extension View {
    /// A chip's padding and fill, shared by the property chips and the
    /// streak chip.
    func chipBackground() -> some View {
        self
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(.secondarySystemFill)))
    }

    /// A chip's slot in `ChipFlow`: 6pt above and below its capsule, and at
    /// least 44pt tall, the capsule centred. At the default text size a
    /// capsule is about 32pt, so the slot is 44pt and a chip that is a button
    /// is hit over all of it, inside its own line, never overhanging the next.
    /// At larger sizes the capsule grows and the 6pt stay. Every chip takes
    /// one, the read-only ones too, so the lines stay evenly spaced.
    func chipSlot() -> some View {
        self
            .padding(.vertical, 6)
            .frame(minHeight: 44)
    }
}
