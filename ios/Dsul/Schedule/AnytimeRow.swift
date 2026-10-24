import DsulCore
import SwiftUI

/// One row of the Anytime band (design §5.2, PR 8): ItemRow's look, the tick
/// circle, the title and a habit's streak, with no time (it has none). The
/// band is its drag container, and a hold lifts it onto an hour, so it opens
/// with a tap gesture rather than a Button and the long press stays the
/// system's, as a braindump row's does. The tick is still its own 44pt
/// Button. A skipped occurrence is ItemRow's strip, which never lifts.
///
/// To VoiceOver it is ItemRow's one element: activation opens it, and the
/// tick is a named action.
struct AnytimeRow: View {
    var item: SampleItem
    var done: Bool
    var skipped: Bool
    var streaksEnabled: Bool
    var onToggle: () -> Void
    var onOpen: () -> Void

    var body: some View {
        if skipped {
            ItemRow(item: item, done: done, skipped: true, streaksEnabled: streaksEnabled,
                    onToggle: onToggle, onOpen: onOpen)
        } else {
            row
        }
    }

    private var row: some View {
        HStack(spacing: 12) {
            // ItemRow's circle: laid out at 30pt, hit over 44pt.
            Button(action: onToggle) {
                TickCircle(done: done, habit: item.isHabit)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleStyle())
            .padding(-7)

            HStack(spacing: 12) {
                Text(item.title)
                    .strikethrough(done)
                    .foregroundStyle(done ? Color.secondary : Color.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if item.isHabit && streaksEnabled {
                    StreakLabel(streak: item.streak ?? 0, lit: done)
                }
            }
            // Hit over the row's full 44pt, as ItemRow's title is.
            .padding(.vertical, 11)
            .contentShape(Rectangle())
            .padding(.vertical, -11)
            .onTapGesture(perform: onOpen)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(PlannerFormat.rowLabel(item, isNow: false, streaksEnabled: streaksEnabled)))
        .accessibilityValue(Text(done ? "Done" : ""))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Opens details")
        .accessibilityAction { onOpen() }
        .accessibilityAction(named: Text(done ? "Mark not done" : "Mark done"), onToggle)
        .accessibilityInputLabels([Text(item.title)])
    }
}
