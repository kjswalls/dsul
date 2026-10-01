import SwiftUI

/// The up-down layout capsule (G board): the current layout's icon and a
/// chevron. A tap steps to the next layout, a long press opens the full menu,
/// and a swipe along the capsule in either axis steps through the layouts.
/// Self-contained, so it can move (to the capture bar, as on the F board)
/// without changes.
struct LayoutSwitcher: View {
    @Binding var layout: TodayLayout

    /// Steps already applied during the current swipe.
    @State private var swipeSteps = 0

    /// Points of travel per step.
    private var stepDistance: CGFloat { 28 }

    var body: some View {
        Menu {
            Section("Layout") {
                Picker("Layout", selection: $layout) {
                    ForEach(TodayLayout.allCases) { option in
                        Label(option.title, systemImage: option.systemImage)
                            .tag(option)
                    }
                }
                .pickerStyle(.inline)
            }
            // Week isn't built, so Day is the only choice rather than a dead one.
            Section("Show") {
                Picker("Show", selection: .constant("day")) {
                    Label("Day", systemImage: "calendar").tag("day")
                }
                .pickerStyle(.inline)
            }
        } label: {
            HStack(spacing: 5) {
                Image(systemName: layout.systemImage)
                    .contentTransition(.symbolEffect(.replace))
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
            .contentShape(Capsule())
        } primaryAction: {
            layout = layout.next
        }
        .simultaneousGesture(swipe)
        .sensoryFeedback(.selection, trigger: layout)
        .accessibilityLabel("Layout")
        .accessibilityValue(layout.title)
        .accessibilityHint("Swipe up or down to change the layout")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment:
                layout = layout.next
            case .decrement:
                layout = layout.previous
            @unknown default:
                break
            }
        }
    }

    /// Down or right steps forward, up or left steps back, one layout per
    /// `stepDistance` of travel along whichever axis moved more.
    private var swipe: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                let dx = value.translation.width
                let dy = value.translation.height
                let travel: CGFloat = abs(dy) >= abs(dx) ? dy : dx
                let steps = Int((travel / stepDistance).rounded(.towardZero))
                if steps != swipeSteps {
                    withAnimation(.snappy) {
                        layout = layout.stepped(by: steps - swipeSteps)
                    }
                    swipeSteps = steps
                }
            }
            .onEnded { _ in
                swipeSteps = 0
            }
    }
}
