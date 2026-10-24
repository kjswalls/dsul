import SwiftUI

/// The up-down layout capsule (G board): the current layout's icon and a
/// chevron. A tap steps to the next layout, a long press opens the full menu,
/// and a swipe along the capsule in either axis steps through the layouts.
/// Day or Week is the menu's Show section alone (design W6: one release
/// changes one thing), with a VoiceOver action for each. Self-contained, so it
/// can move (to the capture bar, as on the F board) without changes.
///
/// A plain view rather than a `Menu`: a menu's own tap (its primary action)
/// and a swipe on it either never both fire or both fire, so one swipe could
/// step twice. Here the swipe wins outright and the tap only counts when no
/// swipe started; the menu is a context menu.
struct LayoutSwitcher: View {
    @Binding var layout: TodayLayout
    /// The stored scope. What the layout draws of it is
    /// `layout.effectiveScope(scope)`: Day on Schedule, whatever is stored.
    @Binding var scope: TodayScope

    /// Counts the capsule's own Day or Week picks that change what shows, so
    /// its selection haptic follows them alone: not a week heading's tap
    /// (which stores Day from outside), nor Day picked again on Schedule.
    @State private var scopePicks = 0

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
            // Schedule has no week form yet, so there Day is the only choice
            // rather than a dead one. The check is on what the layout draws.
            Section("Show") {
                Picker("Show", selection: shownScope) {
                    ForEach(layout.scopes) { option in
                        Label(option.title, systemImage: option.systemImage)
                            .tag(option)
                    }
                }
                .pickerStyle(.inline)
            }
        }
        .sensoryFeedback(.selection, trigger: layout)
        .sensoryFeedback(.selection, trigger: scopePicks)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Layout")
        .accessibilityValue(layout.spokenValue(scope))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Swipe up or down to change the layout")
        .accessibilityAction {
            step(by: 1)
        }
        // Only the one that changes what shows: Show week on a layout with a
        // week form showing Day, Show day while Week shows.
        .accessibilityActions {
            if layout.hasWeek && layout.effectiveScope(scope) == .day {
                Button(TodayScope.week.showActionName) { show(.week) }
            }
            if layout.effectiveScope(scope) == .week {
                Button(TodayScope.day.showActionName) { show(.day) }
            }
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

    /// The Show picker's selection: the scope the layout draws, so Day is
    /// checked on Schedule whatever is stored; a pick stores it.
    private var shownScope: Binding<TodayScope> {
        Binding(get: { layout.effectiveScope(scope) }, set: { pick($0) })
    }

    private func show(_ option: TodayScope) {
        withAnimation(.snappy) {
            pick(option)
        }
    }

    /// Stores `option`, and counts it for the haptic only when it changes
    /// what the layout draws.
    private func pick(_ option: TodayScope) {
        let changes = layout.effectiveScope(option) != layout.effectiveScope(scope)
        scope = option
        if changes { scopePicks += 1 }
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
