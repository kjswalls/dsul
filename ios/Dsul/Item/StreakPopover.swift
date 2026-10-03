import SwiftUI

/// What the streak chip opens: this week's seven days, drawn larger than the
/// chip draws them, with the flame and the count; under them how long the
/// run is ("41 days in a row", or "No streak yet": the web's flame tooltip,
/// `ItemSheetModel.streakRun`); then, when the sheet offers it, Reset streak
/// after a divider. One column, in the round 5 drawing.
///
/// - **Its form.** A popover at the usual text sizes; at the accessibility
///   sizes a sheet, at half height with a grabber, scrolling if its words
///   need more, with the flame and the count above the days so the week
///   fits (`ItemSheetModel.streakPopoverStyle`). It applies that to
///   itself, since an adaptation, like a detent, takes effect only on the
///   presented content.
/// - **Reset's confirm is its own.** The page presenting this can't also
///   present a dialog, so the popover asks: "Reset streak?", the web's
///   message, Reset streak and Cancel. Confirmed, `onReset` writes the reset
///   and closes the popover.
/// - **Words.** Reset's are the verb's own label (`resetLabel`, DsulCore
///   `verbLabel`, which verbs.json pins to the web's "Reset streak"), on its
///   button and on the confirm's; the popover never spells them itself.
/// - **VoiceOver.** The week is one element, labelled as the chip is; the run
///   is plain text; Reset is a button.
/// - **Colour.** Nothing lime. Reset and its confirm are the system red; the
///   count is the label colour.
struct StreakPopover: View {
    let streak: Int
    let dots: [StreakDot]
    /// Today is ticked: the flame lights.
    let lit: Bool
    /// `ItemSheetModel.streakSpoken`: the week as VoiceOver reads the chip.
    let spoken: String
    /// `verbLabel(.resetStreak, …)` when the sheet offers Reset streak, else
    /// nil (no Reset), read each time the popover is drawn.
    let resetLabel: String?
    /// The page's reset: the write, then the popover closing.
    let onReset: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var confirmReset = false
    @ScaledMetric(relativeTo: .title3) private var dotSize: CGFloat = 16

    /// A popover, or at the accessibility sizes a sheet.
    private var style: StreakPopoverStyle {
        return ItemSheetModel.streakPopoverStyle(accessibilitySize: dynamicTypeSize.isAccessibilitySize)
    }

    var body: some View {
        let adaptation: PresentationAdaptation = style == .sheet ? .sheet : .popover
        Group {
            if style == .sheet {
                ScrollView {
                    column
                }
            } else {
                column
            }
        }
        .presentationCompactAdaptation(adaptation)
        // The sheet form only: a popover ignores them. Half height first,
        // with a grabber, so the way out shows.
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .confirmationDialog(ItemSheetModel.resetConfirmTitle, isPresented: $confirmReset,
                            titleVisibility: .visible) {
            if let resetLabel {
                Button(resetLabel, role: .destructive) { onReset() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(ItemSheetModel.resetConfirmMessage)
        }
    }

    private var column: some View {
        VStack(alignment: .leading, spacing: 12) {
            week
            Text(ItemSheetModel.streakRun(streak))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let resetLabel {
                Divider()
                // A row hit over at least 44pt, in the system red.
                Button(role: .destructive) {
                    confirmReset = true
                } label: {
                    Text(resetLabel)
                        .foregroundStyle(Color.red)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(RowPressStyle(verticalBleed: 0))
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The flame and the count, then the seven days, as the chip draws them,
    /// larger. In one row at the usual text sizes; at the accessibility sizes
    /// (the sheet form) the flame and the count sit above the days, and the
    /// days stop growing at 32pt, so all seven fit the narrowest phone's
    /// column: 7 × 32 + 6 × 6 = 260pt of 343. In one row there, the days
    /// alone would be 344pt at the largest size, and the last of them would
    /// run off the sheet's edge.
    private var week: some View {
        let size = min(dotSize, 32)
        let flame = HStack(spacing: 4) {
            Image(systemName: "flame.fill")
                .foregroundStyle(lit ? Color.orange : Color.secondary)
            Text("\(streak)")
                .monospacedDigit()
                .foregroundStyle(Color.primary)
        }
        let days = HStack(spacing: 6) {
            ForEach(0..<dots.count, id: \.self) { index in
                StreakDotView(dot: dots[index], lineScale: 1.6)
                    .frame(width: size, height: size)
            }
        }
        return Group {
            if style == .sheet {
                VStack(alignment: .leading, spacing: 8) {
                    flame
                    days
                }
            } else {
                HStack(spacing: 12) {
                    flame
                    days
                }
            }
        }
        .font(.title3.weight(.semibold))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(spoken))
    }
}
