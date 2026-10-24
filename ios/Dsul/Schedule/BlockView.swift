import DsulCore
import SwiftUI

/// One block on the Schedule, in the web's look (design §5.1, after
/// components/views/day-schedule.tsx): a 2pt rail over the block's true time
/// in its project's colour, a 6pt bead at its start, and a paper pane beside
/// them, radius 5, with a hairline and a soft shadow. A task's pane starts
/// with a square check; the title is one line, with the mono length on the
/// right, and a tall pane adds the mono range under it. Done strikes the
/// title and thins the plate, and never fades the block, so the lime check
/// keeps its full strength. A skipped occurrence is a 24pt strip that keeps
/// its bead and has no check.
///
/// Placed in the field's points from `block.frame(fieldWidth:)`: the view is
/// the block's own bounds, offset into the column, so VoiceOver's frame is
/// the block. To VoiceOver it is one element: "Draft Q4 roadmap, 9 to 11 AM,
/// Work", its state as the value, activation opens it, and its verbs and
/// moves are named actions (design §5.9), never the adjustable trait.
///
/// While it is the block in the air (PR 8) it draws hollow, an outline where
/// its pane was and no fill (design B8): never a fade, which would dim its
/// lime rail and check.
///
/// Selected through Change length (PR 9) its pane wears a 1.5pt ink outline,
/// and while a grip is in the hand the column draws it at the grip's span
/// (`ScheduleBlock.resized(to:)`), so its length and range read live. The
/// grips are the column's, drawn over the blocks (design §5.6).
struct BlockView: View {
    let block: ScheduleBlock
    let fieldWidth: Double
    /// Now, on today only (the "now" value).
    let nowMin: Int?
    let timeFormat: TimeFormat
    /// The rail and bead's colour when open: the project's, or lime.
    let accent: Color
    /// Its VoiceOver actions, in order (`SamplePlanner.spokenActions`).
    let actions: [BlockSpokenAction]
    /// Selected through Change length: the ink outline.
    let selected: Bool
    /// A grip is in the hand: a pane with no range line, narrow or short,
    /// says its range where its length was, so both ends read as they move.
    let showsRange: Bool
    let onOpen: () -> Void
    let onTick: () -> Void
    let onAction: (BlockSpokenAction) -> Void

    /// One line of block text (the web's `LINE_H`, scaled): a tall pane's
    /// title line is at least this tall.
    @ScaledMetric(relativeTo: .footnote) private var lineHeight = CGFloat(ScheduleMetrics.lineH)

    var body: some View {
        let geometry = block.frame(fieldWidth: fieldWidth)
        let box = bounds(geometry)
        let pane = CGRect(x: CGFloat(geometry.paneX) - box.minX, y: CGFloat(geometry.paneTop) - box.minY,
                          width: CGFloat(geometry.paneWidth), height: CGFloat(geometry.paneHeight))
        HollowWhileLifted(id: block.id, pane: pane) {
            ZStack(alignment: .topLeading) {
                rail(geometry, in: box)
                bead(geometry, in: box)
                if block.skipped {
                    skippedStrip(geometry)
                        .offset(x: pane.minX, y: pane.minY)
                } else {
                    BlockPane(block: block, geometry: geometry, narrow: block.isNarrow(fieldWidth: fieldWidth),
                              timeFormat: timeFormat, lineHeight: lineHeight, selected: selected,
                              showsRange: showsRange, onOpen: onOpen, onTick: onTick)
                        .offset(x: pane.minX, y: pane.minY)
                }
            }
        }
        .frame(width: box.width, height: box.height, alignment: .topLeading)
        .offset(x: box.minX, y: box.minY)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(block.spokenLabel))
        .accessibilityValue(Text(block.spokenValue(nowMin: nowMin)))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Opens details")
        .accessibilityAction { onOpen() }
        .accessibilityActions {
            ForEach(actions, id: \.self) { action in
                Button(action.name) { onAction(action) }
            }
        }
        .accessibilityInputLabels([Text(block.item.title)])
    }

    /// The block's bounds in the field: its rail, its ringed bead and its
    /// pane (or strip), whichever reaches furthest each way.
    private func bounds(_ f: BlockFrame) -> CGRect {
        let paneH = block.skipped ? ScheduleBlockMetrics.skippedStripHeight : f.paneHeight
        let railH = block.skipped ? ScheduleBlockMetrics.skippedStripHeight : f.spanHeight
        let ring = ScheduleMetrics.beadSize / 2 + 1
        let minX = min(f.beadX - 1, f.railX, f.paneX)
        let maxX = max(f.paneX + f.paneWidth, f.railX + ScheduleMetrics.railWidth,
                       f.beadX + ScheduleMetrics.beadSize + 1)
        let minY = min(f.startY - ring, f.paneTop)
        let maxY = max(f.paneTop + paneH, f.startY + railH, f.startY + ring)
        return CGRect(x: minX, y: minY, width: max(0, maxX - minX), height: max(0, maxY - minY))
    }

    /// The rail: the block's true time, start to end; a skipped one keeps
    /// only the strip's height.
    private func rail(_ f: BlockFrame, in box: CGRect) -> some View {
        let height = block.skipped ? ScheduleBlockMetrics.skippedStripHeight : f.spanHeight
        return RoundedRectangle(cornerRadius: CGFloat(ScheduleMetrics.railWidth) / 2)
            .fill(markColor(skippedOpacity: 0.35))
            .frame(width: CGFloat(ScheduleMetrics.railWidth), height: CGFloat(max(0, height)))
            .offset(x: CGFloat(f.railX) - box.minX, y: CGFloat(f.startY) - box.minY)
            // A tap on a rail falls through to what is under it, a host's pane.
            .allowsHitTesting(false)
    }

    /// The bead at the start, ringed a point wide in what it sits on: the
    /// canvas, or a host's pane when the block nests in one.
    private func bead(_ f: BlockFrame, in box: CGRect) -> some View {
        let size = CGFloat(ScheduleMetrics.beadSize)
        let x = CGFloat(f.beadX) - box.minX
        let y = CGFloat(f.startY) - size / 2 - box.minY
        // The web's `beadOnPocket`: a stepped plate (nested, or cascaded past
        // the channel cap) puts its bead on the plate beneath it, and a
        // stepped plate is exactly one whose z is above the lone block's 2.
        let ring = block.plan.z > 2 ? Color(.secondarySystemGroupedBackground) : Color(.systemBackground)
        return ZStack(alignment: .topLeading) {
            Circle()
                .fill(ring)
                .frame(width: size + 2, height: size + 2)
                .offset(x: x - 1, y: y - 1)
            Circle()
                .fill(markColor(skippedOpacity: 0.45))
                .frame(width: size, height: size)
                .offset(x: x, y: y)
        }
        .allowsHitTesting(false)
    }

    /// The rail and bead's colour: the accent while open; muted ink once
    /// done or skipped, never a faded lime.
    private func markColor(skippedOpacity: Double) -> Color {
        if block.skipped { return Color.secondary.opacity(skippedOpacity) }
        if block.done { return Color.secondary.opacity(0.45) }
        return accent
    }

    /// A skipped occurrence: the skip mark and the title in secondary ink on
    /// a soft strip. A tap opens the sheet, where Unskip is.
    private func skippedStrip(_ f: BlockFrame) -> some View {
        let shape = RoundedRectangle(cornerRadius: CGFloat(ScheduleMetrics.paneRadius), style: .continuous)
        return HStack(spacing: 6) {
            Image(systemName: "forward.end")
                .font(.caption2.weight(.semibold))
            Text(block.item.title)
                .font(.footnote)
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .foregroundStyle(.secondary)
        .padding(.leading, 8)
        .padding(.trailing, 4)
        .frame(width: CGFloat(f.paneWidth), height: CGFloat(ScheduleBlockMetrics.skippedStripHeight))
        .background { shape.fill(Color(.tertiarySystemFill)) }
        .contentShape(shape)
        .onTapGesture(perform: onOpen)
    }
}

/// The block, or while it is the one in the air (`ScheduleDrag.lifts`) an
/// outline where its pane was and nothing else: the source draws hollow
/// (design B8). Its own small view, the only part of a block that reads the
/// drag, and only whether this block is lifted, so a ghost step never
/// re-renders it. The system's lifted copy is the block as it was.
private struct HollowWhileLifted<Content: View>: View {
    let id: UUID
    /// The pane's rect in the block's bounds.
    let pane: CGRect
    @ViewBuilder let content: () -> Content

    @Environment(ScheduleDrag.self) private var drag

    var body: some View {
        if drag.lifts(id) {
            RoundedRectangle(cornerRadius: CGFloat(ScheduleMetrics.paneRadius), style: .continuous)
                .strokeBorder(Color.secondary, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                .frame(width: pane.width, height: pane.height)
                .offset(x: pane.minX, y: pane.minY)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .allowsHitTesting(false)
        } else {
            content()
        }
    }
}

/// A block's pane: the plate, its words centred in the content band the
/// overlap plan leaves clear (the web's `justify-center`), and a task's check
/// on the title's line. A tap anywhere but the check opens the item; a tap
/// gesture rather than a Button, so the check can sit inside it.
private struct BlockPane: View {
    let block: ScheduleBlock
    /// Where it draws (`blockFrame`); the content band is pane-relative.
    let geometry: BlockFrame
    /// Narrower than `ScheduleMetrics.paneWrapPx`: the title gets the width,
    /// no length or range.
    let narrow: Bool
    let timeFormat: TimeFormat
    let lineHeight: CGFloat
    /// Selected through Change length: a 1.5pt ink outline for the
    /// hairline (design §5.6). Ink, never lime: lime is a mark.
    let selected: Bool
    /// A grip is in the hand: the title's line says the range in the
    /// length's place wherever no range line shows, a narrow pane's
    /// included, whose title gives way to it.
    let showsRange: Bool
    let onOpen: () -> Void
    let onTick: () -> Void

    /// The middle of the title's line, measured in the content band once it
    /// is laid out: the check sits on it. Until then, the band's middle,
    /// which is where a one-line block's title is.
    @State private var titleMid: CGFloat?
    /// The content band's coordinate space, for `titleMid`.
    private static let bandSpace = "BlockPane.contentBand"
    /// The check's left inset, and the gap after it.
    private var checkLeading: CGFloat { narrow ? 6 : 8 }
    private let checkGap: CGFloat = 6

    private var width: CGFloat { CGFloat(geometry.paneWidth) }
    private var height: CGFloat { CGFloat(geometry.paneHeight) }
    private var bandTop: CGFloat { CGFloat(geometry.contentTop) }
    private var bandHeight: CGFloat { CGFloat(geometry.contentHeight) }
    private var tall: Bool { geometry.isTall && !narrow }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: CGFloat(ScheduleMetrics.paneRadius), style: .continuous)
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            plate
            words
                .frame(width: width, height: max(0, bandHeight), alignment: .leading)
                .coordinateSpace(.named(Self.bandSpace))
                .clipped()
                .offset(y: bandTop)
                .allowsHitTesting(false)
            if block.hasCheck {
                check
            }
        }
        .frame(width: width, height: height, alignment: .topLeading)
        .contentShape(shape)
        .onTapGesture(perform: onOpen)
    }

    /// Elevated paper with a hairline and a soft shadow; done, a thinner
    /// plate with no shadow. Selected, the hairline is a 1.5pt ink outline.
    private var plate: some View {
        shape
            .fill(block.done ? Color(.tertiarySystemFill) : Color(.secondarySystemGroupedBackground))
            .overlay {
                if selected {
                    shape.strokeBorder(Color.primary, lineWidth: 1.5)
                } else {
                    shape.strokeBorder(.separator, lineWidth: 0.5)
                }
            }
            .shadow(color: block.done ? Color.clear : Color.black.opacity(0.08), radius: 2, y: 1)
    }

    @ViewBuilder
    private var words: some View {
        let leading = block.hasCheck ? checkLeading + CGFloat(ScheduleBlockMetrics.checkSize) + checkGap
            : (narrow ? 6 : 10)
        let trailing: CGFloat = narrow ? 4 : 8
        if tall {
            // Two lines when they fit; at a large text size, the title alone.
            ViewThatFits(in: .vertical) {
                VStack(alignment: .leading, spacing: 1) {
                    measured(titleLine(meta: block.durationText).frame(minHeight: lineHeight))
                    Text(block.rangeText(timeFormat))
                        .font(.caption2.monospaced())
                        .foregroundStyle(metaStyle)
                        .lineLimit(1)
                }
                measured(titleLine(meta: oneLineMeta).frame(minHeight: lineHeight))
            }
            .padding(.leading, leading)
            .padding(.trailing, trailing)
        } else {
            measured(titleLine(meta: oneLineMeta))
                .padding(.leading, leading)
                .padding(.trailing, trailing)
        }
    }

    /// What the title's line says on its right when it is the pane's only
    /// line: the length, or the range while a grip is in the hand.
    private var oneLineMeta: String? {
        return showsRange ? block.rangeText(timeFormat) : block.durationText
    }

    /// `line`, reporting where its middle sits in the content band.
    private func measured(_ line: some View) -> some View {
        line.onGeometryChange(for: CGFloat.self) { proxy in
            proxy.frame(in: .named(Self.bandSpace)).midY
        } action: { mid in
            titleMid = mid
        }
    }

    /// The title, and `meta` (the length, or the range) on the right unless
    /// the pane is narrow. While a grip is in the hand the range shows on a
    /// narrow pane too, the title truncating before it, so a length always
    /// reads as it changes (design §5.6, "the pane's mono range updates
    /// live"); the web's narrow pane shows none.
    private func titleLine(meta: String?) -> some View {
        HStack(spacing: 6) {
            Text(block.item.title)
                .font(.footnote.weight(.medium))
                .strikethrough(block.done)
                .foregroundStyle(block.done ? Color.secondary : Color.primary)
                .lineLimit(1)
            Spacer(minLength: 0)
            if !narrow || showsRange, let meta {
                Text(meta)
                    .font(.caption2.monospaced())
                    .foregroundStyle(metaStyle)
                    .lineLimit(1)
                    .fixedSize()
            }
        }
    }

    /// The length and range: secondary ink, a step fainter once done.
    private var metaStyle: HierarchicalShapeStyle {
        block.done ? HierarchicalShapeStyle.tertiary : HierarchicalShapeStyle.secondary
    }

    /// The square check, drawn 16pt on the title's line, hit over 44pt wide
    /// and never taller than the content band (design B25), so a tap just
    /// above or below a short block's check reaches its neighbour.
    private var check: some View {
        let size = CGFloat(ScheduleBlockMetrics.checkSize)
        let targetWidth = CGFloat(ScheduleBlockMetrics.checkTarget)
        let targetHeight = max(0, min(targetWidth, bandHeight))
        let lineCenter = titleMid ?? bandHeight / 2
        let targetTop = min(max(0, lineCenter - targetHeight / 2), max(0, bandHeight - targetHeight))
        return Button(action: onTick) {
            BlockCheck(done: block.done)
                .frame(width: size, height: size)
                .offset(x: checkLeading, y: lineCenter - targetTop - size / 2)
                .frame(width: targetWidth, height: targetHeight, alignment: .topLeading)
                .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle())
        .offset(y: bandTop + targetTop)
        .accessibilityHidden(true)
    }
}

/// An open task's square, or once done the lime square at full strength
/// with its tick in the web's ink on lime (`--lime-ink`, which
/// `--primary-foreground` names: the web's ItemTick), in light and dark.
private struct BlockCheck: View {
    let done: Bool

    /// app/globals.css `--lime-ink`, oklch(0.32 0.07 130), in sRGB.
    private static let limeInk = Color(red: 39 / 255, green: 58 / 255, blue: 15 / 255)

    var body: some View {
        if done {
            // The web's 16px box, rounded 5, with its tick drawn in.
            RoundedRectangle(cornerRadius: CGFloat(ScheduleMetrics.paneRadius), style: .continuous)
                .fill(Color.accentColor)
                .overlay {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Self.limeInk)
                }
        } else {
            Image(systemName: "square")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .foregroundStyle(Color.secondary)
        }
    }
}
