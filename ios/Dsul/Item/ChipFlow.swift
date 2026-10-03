import SwiftUI

/// Chips laid out left to right, wrapping onto new lines, as the web panel's
/// property field wraps. Each chip is offered the full width and held to it,
/// so a long one (a reminder's cue words, a long project name) truncates on
/// its own line instead of running off the sheet.
///
/// The lines touch (`lineSpacing` 0): every chip comes in its slot
/// (`chipSlot()`), which brings 6pt above and below its capsule, so capsules
/// sit 12pt apart on every line at every text size, whichever chip on a line
/// is the tallest. The slot is also what gives a chip that is a control (the
/// streak chip, an editable chip, Add property: `chipHit()`) its 44pt of
/// height to hit inside its own line; were it the only chip in one, its line
/// would sit further from the next than the others do.
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

/// One property chip: its symbol (or a project's colour dot) and its words.
/// Read-only unless `editable`, when it is a menu's or a button's label and
/// ends in a chevron, as the streak chip does, saying it opens something; a
/// read-only chip has none, so it doesn't promise an edit it can't make. Its
/// words are the label colour, set here, so a menu's or a button's tint (the
/// 1.5:1 lime) never reaches them, and its symbol and chevron are gray
/// against that. To VoiceOver, one element with a spoken label ("Time: 9:00
/// to 11:00 am"); the control around an editable one adds its trait and hint.
struct ChipView: View {
    let chip: SheetChip
    /// A project's colour, drawn as a dot in place of a symbol.
    var dot: Color? = nil
    /// The label of a control that edits the chip's property.
    var editable: Bool = false

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
            if editable {
                Image(systemName: "chevron.down")
                    .imageScale(.small)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
        .foregroundStyle(Color.primary)
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

    /// The hit area of a chip that is a control (the streak chip, an editable
    /// chip, Add property): its slot, at least 44pt wide too, all of it taking
    /// taps. Put inside the control's label, where a `Button` or a `Menu`
    /// tests its taps; a frame outside it wouldn't widen the tap.
    func chipHit() -> some View {
        self
            .chipSlot()
            .frame(minWidth: 44)
            .contentShape(Rectangle())
    }
}
