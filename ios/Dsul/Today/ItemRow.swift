import DsulCore
import SwiftUI

/// One item row, shared by List and Buckets: a tick circle, the title (struck
/// through when done), a habit's streak and the time on the right. A skipped
/// occurrence is a strip instead, with no box to tick. With Streaks off
/// (`streaksEnabled`, the payload's `settings.streaksEnabled`) a habit's row
/// has no flame and no count, and VoiceOver hears no "streak N", as the web's
/// row hides them (components/primitives/task-row.tsx, `streaksOn`).
///
/// Two buttons side by side: the circle ticks, the rest of the row opens the
/// item's sheet. The circle's hit area is 44pt square though it draws at 22, so
/// a near miss still ticks instead of opening. To VoiceOver the row is ONE
/// element whose activation opens the sheet, with the tick as a named action.
struct ItemRow: View {
    var item: SampleItem
    var done: Bool
    /// Skipped on the day: a tick on it is refused (lib/item-toggle.ts), so
    /// it gets no checkbox, only a way into the sheet (where Unskip is).
    var skipped: Bool = false
    /// "Now ·" in front of the time while the block is running.
    var isNow: Bool = false
    /// The Streaks extension is on: a habit shows its flame and count.
    var streaksEnabled: Bool = true
    var onToggle: () -> Void
    var onOpen: () -> Void

    private var actionName: String { done ? "Mark not done" : "Mark done" }

    var body: some View {
        if skipped {
            skippedStrip
        } else {
            row
        }
    }

    /// Where the box would be, a skip mark; the title dimmed; "Skipped". The
    /// whole strip opens the sheet: it is the only way to Unskip.
    private var skippedStrip: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                Image(systemName: "forward.end")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 30, height: 30)
                Text(item.title)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                Text("Skipped")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 1)
            .padding(.trailing, 8)
            .background(Capsule().fill(Color(.tertiarySystemFill)))
            // Drawn 32pt tall, hit over 44pt: the overhang grows the hit
            // shape and leaves the layout alone.
            .padding(.vertical, 6)
            .contentShape(Capsule())
            .padding(.vertical, -6)
        }
        .buttonStyle(PressScaleStyle(scale: 0.98))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(item.title), skipped"))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Opens details")
        .accessibilityAction { onOpen() }
    }

    private var row: some View {
        HStack(spacing: 12) {
            // Laid out as the 30pt circle always was (22pt plus 4pt each
            // side), with the 44pt square overhanging it by 7pt all round, so
            // the column, the strip's skip mark and the row height stay put.
            Button(action: onToggle) {
                TickCircle(done: done, habit: item.isHabit)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleStyle())
            .padding(-7)

            Button(action: onOpen) {
                HStack(spacing: 12) {
                    Text(item.title)
                        .strikethrough(done)
                        .foregroundStyle(done ? Color.secondary : Color.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)

                    Spacer(minLength: 8)

                    if let time = PlannerFormat.rowTime(startMin: item.startMin, durationMin: item.durationMin) {
                        Text(isNow ? "Now \u{00B7} \(time)" : time)
                            .font(.footnote.monospacedDigit().weight(isNow ? .semibold : .regular))
                            .foregroundStyle(isNow ? Color.accentColor : Color.secondary)
                    }
                    if item.isHabit && streaksEnabled {
                        StreakLabel(streak: item.streak ?? 0, lit: done)
                    }
                }
                // A line of title is about 22pt: the hit shape overhangs it
                // by 11pt each way, the list row's full 44, as the circle's
                // does, so the row's height and its press fill stay put.
                .padding(.vertical, 11)
                .contentShape(Rectangle())
                .padding(.vertical, -11)
            }
            .buttonStyle(RowPressStyle())
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(PlannerFormat.rowLabel(item, isNow: isNow, streaksEnabled: streaksEnabled)))
        .accessibilityValue(Text(done ? "Done" : ""))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Opens details")
        .accessibilityAction { onOpen() }
        .accessibilityAction(named: Text(actionName), onToggle)
        .accessibilityInputLabels([Text(item.title)])
    }
}

/// Filled with a tick when done; a dashed ring for an open habit, a solid one
/// for an open task. Drawn at `diameter`; the caller gives it its hit area.
struct TickCircle: View {
    var done: Bool
    var habit: Bool
    var diameter: CGFloat = 22

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
        .frame(width: diameter, height: diameter)
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

/// The colour a project wears: its dot in the chips, the section headers and
/// the item sheet. The project kind folds case (lib/container-registry.ts
/// `caseFold`), so an item filed under "work" wears Work's colour.
enum ProjectPalette {
    private static let colors: [Color] = [.blue, .teal, .purple, .pink, .orange, .indigo, .mint]

    static func color(for project: String, in projects: [String]) -> Color {
        let folded = project.lowercased()
        guard let i = projects.firstIndex(where: { $0.lowercased() == folded }) else { return .gray }
        return colors[i % colors.count]
    }
}

/// A press that shrinks the label a little and never fades it. A lime mark
/// (a done tick, "Now") must not dim through opacity, which `.plain` does on
/// every press.
struct PressScaleStyle: ButtonStyle {
    var scale: CGFloat = 0.9

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .animation(.snappy(duration: 0.15), value: configuration.isPressed)
    }
}

/// A row's press: a soft fill behind the label, which itself never fades.
/// The fill reaches `verticalBleed` past the label above and below; a label
/// already as tall as its row takes 0, so the fill stays in the row.
struct RowPressStyle: ButtonStyle {
    var verticalBleed: CGFloat = 3

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color(.systemFill))
                    .padding(.horizontal, -6)
                    .padding(.vertical, -verticalBleed)
                    .opacity(configuration.isPressed ? 1 : 0)
            }
    }
}

extension PlannerFormat {
    /// A row's time as VoiceOver should say it: "3 PM", "3:30 PM", or a
    /// range for a block of an hour or more, "9 to 11 AM" ("11 AM to 1 PM"
    /// across noon). Nil when untimed. The words of `rowTime`, spelled out.
    static func spokenRowTime(startMin: Int?, durationMin: Int) -> String? {
        guard let start = startMin else { return nil }
        guard durationMin >= 60 else { return clock(start) }
        let end = start + durationMin
        let sameHalf = ((start / 60) % 24 < 12) == ((end / 60) % 24 < 12)
        return clock(start, meridiem: !sameHalf) + " to " + clock(end)
    }

    /// The row as one VoiceOver label: "Draft Q4 roadmap, 9 to 11 AM", with
    /// "now" while the block runs and a habit's "streak 41", unless Streaks
    /// is off (`streaksEnabled`), which hides the streak the row draws too.
    /// Done is the element's value, not part of this.
    static func rowLabel(_ item: SampleItem, isNow: Bool, streaksEnabled: Bool = true) -> String {
        var parts = [item.title]
        if let time = spokenRowTime(startMin: item.startMin, durationMin: item.durationMin) {
            parts.append(isNow ? "now, \(time)" : time)
        }
        if item.isHabit && streaksEnabled {
            parts.append("streak \(item.streak ?? 0)")
        }
        return parts.joined(separator: ", ")
    }
}
