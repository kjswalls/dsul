import DsulCore
import SwiftUI

/// One item row, shared by List and Buckets: a tick circle, the title (struck
/// through when done), a habit's streak and the time on the right. A skipped
/// occurrence is a strip instead, with no box to tick.
struct ItemRow: View {
    var item: SampleItem
    var done: Bool
    /// Skipped on the day: a tick on it is refused (lib/item-toggle.ts), so
    /// it gets no checkbox.
    var skipped: Bool = false
    /// "Now ·" in front of the time while the block is running.
    var isNow: Bool = false
    var onToggle: () -> Void

    private var actionName: String { done ? "Mark not done" : "Mark done" }

    var body: some View {
        if skipped {
            skippedStrip
        } else {
            row
        }
    }

    /// Where the box would be, a skip mark; the title dimmed; "Skipped".
    private var skippedStrip: some View {
        HStack(spacing: 12) {
            Image(systemName: "forward.end")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 30, height: 30)
            Text(item.title)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer(minLength: 8)
            Text("Skipped")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 1)
        .padding(.trailing, 8)
        .background(Capsule().fill(Color(.tertiarySystemFill)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(item.title), skipped"))
    }

    private var row: some View {
        HStack(spacing: 12) {
            Button(action: onToggle) {
                TickCircle(done: done, habit: item.isHabit)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(actionName))

            Text(item.title)
                .strikethrough(done)
                .foregroundStyle(done ? Color.secondary : Color.primary)
                .lineLimit(2)

            Spacer(minLength: 8)

            if let time = PlannerFormat.rowTime(startMin: item.startMin, durationMin: item.durationMin) {
                Text(isNow ? "Now \u{00B7} \(time)" : time)
                    .font(.footnote.monospacedDigit().weight(isNow ? .semibold : .regular))
                    .foregroundStyle(isNow ? Color.accentColor : Color.secondary)
            }
            if item.isHabit {
                StreakLabel(streak: item.streak ?? 0, lit: done)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(done ? .isSelected : [])
        .accessibilityAction(named: Text(actionName), onToggle)
    }
}

/// Filled with a tick when done; a dashed ring for an open habit, a solid one
/// for an open task.
struct TickCircle: View {
    var done: Bool
    var habit: Bool

    var body: some View {
        ZStack {
            if done {
                Image(systemName: "checkmark.circle.fill")
                    .resizable()
                    .foregroundStyle(Color.accentColor)
            } else if habit {
                Circle()
                    .strokeBorder(Color.secondary, style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
            } else {
                Circle()
                    .strokeBorder(Color.secondary, lineWidth: 1.5)
            }
        }
        .frame(width: 22, height: 22)
        .contentShape(Circle())
        .padding(4)
    }
}

/// A flame and the stored streak. Lit once today is done.
struct StreakLabel: View {
    var streak: Int
    var lit: Bool

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "flame.fill")
                .foregroundStyle(lit ? Color.orange : Color.secondary)
            Text("\(streak)")
                .foregroundStyle(.secondary)
        }
        .font(.footnote.monospacedDigit())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Streak \(streak)")
    }
}

/// The colour a project wears: its dot in the chips and section headers.
enum ProjectPalette {
    private static let colors: [Color] = [.blue, .teal, .purple, .pink, .orange, .indigo, .mint]

    static func color(for project: String, in projects: [String]) -> Color {
        guard let i = projects.firstIndex(of: project) else { return .gray }
        return colors[i % colors.count]
    }
}
