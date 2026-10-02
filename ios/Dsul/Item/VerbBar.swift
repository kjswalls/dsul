import DsulCore
import SwiftUI

/// The item sheet's verbs: up to three slots in a glass capsule under the
/// scroll (`ItemSheetModel.verbs` picks them), each a symbol over a word.
/// Above it, "For Thu, Oct 8" when the per-day verbs act on a day other than
/// today; in its place, "Not due Sat, Oct 3" on a day a recurring item
/// doesn't fall on.
///
/// - Reschedule is a menu: Today, Next week, Pick a date….
/// - A slot keeps its place when its verb turns into its opposite (Skip into
///   Unskip), so VoiceOver's focus stays on it.
/// - The words stop growing at the first accessibility text size, where three
///   slots still fit; a long press shows the slot in the large content viewer.
/// - Every slot is drawn in the label colour and shrinks a little on a press,
///   never fading.
struct VerbBar: View {
    let item: SampleItem
    let ctx: VerbContext
    let verbs: SheetVerbs
    /// "For Thu, Oct 8"; nil on today.
    let caption: String?
    let onRun: (SheetVerb) -> Void
    let onReschedule: (RescheduleChoice) -> Void

    var body: some View {
        VStack(spacing: 8) {
            if let caption {
                Text(caption)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if verbs.notDue {
                Text(ItemSheetModel.notDueLine(ctx))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 12)
            } else if !verbs.bar.isEmpty {
                GlassEffectContainer {
                    HStack(spacing: 0) {
                        ForEach(verbs.bar, id: \.slotID) { verb in
                            slot(verb)
                        }
                    }
                    .padding(4)
                    .glassEffect(.regular, in: Capsule())
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
    }

    @ViewBuilder
    private func slot(_ verb: SheetVerb) -> some View {
        if verb == .reschedule {
            Menu {
                Button("Today", systemImage: "sun.max") { onReschedule(.today) }
                Button("Next week", systemImage: "calendar.badge.plus") { onReschedule(.nextWeek) }
                Button("Pick a date\u{2026}", systemImage: "calendar") { onReschedule(.pick) }
            } label: {
                slotLabel(verb)
            }
            .menuOrder(.fixed)
            .menuStyle(.button)
            .buttonStyle(PressScaleStyle())
            .accessibilityLabel(Text(ItemSheetModel.spokenLabel(verb, item, ctx)))
            .accessibilityShowsLargeContentViewer()
        } else {
            Button {
                onRun(verb)
            } label: {
                slotLabel(verb)
            }
            .buttonStyle(PressScaleStyle())
            .accessibilityLabel(Text(ItemSheetModel.spokenLabel(verb, item, ctx)))
            .accessibilityValue(Text(ItemSheetModel.spokenValue(verb, item, ctx) ?? ""))
            .accessibilityShowsLargeContentViewer()
        }
    }

    /// The symbol over the bar's short word, filling its third of the capsule.
    private func slotLabel(_ verb: SheetVerb) -> some View {
        Label(ItemSheetModel.barLabel(verb, item, ctx), systemImage: ItemSheetModel.symbol(verb, item, ctx))
            .labelStyle(StackedLabelStyle())
            .foregroundStyle(Color.primary)
            .frame(maxWidth: .infinity, minHeight: 48)
            .contentShape(Capsule())
    }
}

/// A bar slot's label: the symbol over one line of words, which shrink a
/// little before they truncate.
private struct StackedLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(spacing: 3) {
            configuration.icon
                .font(.body.weight(.medium))
            configuration.title
                .font(.caption.weight(.medium))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 6)
    }
}
