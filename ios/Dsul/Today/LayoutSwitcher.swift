import SwiftUI

/// The up-down layout capsule (G board): the current layout's icon and a
/// chevron. A tap steps to the next layout, a long press opens the full menu,
/// and a swipe along the capsule in either axis steps through the layouts.
/// Self-contained, so it can move (to the capture bar, as on the F board)
/// without changes.
///
/// A plain view rather than a `Menu`: a menu's own tap (its primary action)
/// and a swipe on it either never both fire or both fire, so one swipe could
/// step twice. Here the swipe wins outright and the tap only counts when no
/// swipe started; the menu is a context menu.
struct LayoutSwitcher: View {
    @Binding var layout: TodayLayout

    /// Steps already applied during the current swipe. Gesture state, so it
    /// goes back to 0 however the swipe ends, cancelled included.
    @GestureState private var swipeSteps = 0

    /// Points of travel per step.
    private var stepDistance: CGFloat { 28 }

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: layout.systemImage)
                .contentTransition(.symbolEffect(.replace))
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 4)
        .frame(minHeight: 32)
        .contentShape(Capsule())
        .gesture(swipe.exclusively(before: TapGesture().onEnded { step(by: 1) }))
        .contextMenu {
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
        }
        .sensoryFeedback(.selection, trigger: layout)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Layout")
        .accessibilityValue(layout.title)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Swipe up or down to change the layout")
        .accessibilityAction {
            step(by: 1)
        }
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

    private func step(by delta: Int) {
        withAnimation(.snappy) {
            layout = layout.stepped(by: delta)
        }
    }

    /// Down or right steps forward, up or left steps back, one layout per
    /// `stepDistance` of travel along whichever axis moved more.
    private var swipe: some Gesture {
        DragGesture(minimumDistance: 10)
            .updating($swipeSteps) { value, applied, _ in
                let dx = value.translation.width
                let dy = value.translation.height
                let travel: CGFloat = abs(dy) >= abs(dx) ? dy : dx
                let steps = Int((travel / stepDistance).rounded(.towardZero))
                guard steps != applied else { return }
                let delta = steps - applied
                applied = steps
                step(by: delta)
            }
    }
}
