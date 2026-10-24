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
    /// "Now ·" in front of the time while the block is running, in ink with
    /// a lime dot. Week passes it on today's rows only.
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
                TickBox(done: done, habit: item.isHabit)
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
                        // "Now" is ink with a 6pt lime dot before it: lime is
                        // a mark, never text.
                        HStack(spacing: 5) {
                            if isNow {
                                Circle()
                                    .fill(Color.accentColor)
                                    .frame(width: 6, height: 6)
                            }
                            Text(isNow ? "Now \u{00B7} \(time)" : time)
                                .font(.footnote.monospacedDigit().weight(isNow ? .semibold : .regular))
                                .foregroundStyle(isNow ? Color.primary : Color.secondary)
                        }
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

/// The item checkbox, drawn as the web's (components/primitives/item-check.tsx
/// and the `--check-*` tokens in app/globals.css): a rounded square, filled
/// grey with a fine lime tick when done. Light fills a mid pewter with the
/// most saturated lime, since the brand lime is too close to pewter in
/// lightness and reads washed out on it; dark fills a raised graphite with the
/// accent. Open, it is a ring: dashed for a habit, solid for a task. The box is
/// 90% of `diameter`, so it sits at the weight the old circle did; the caller
/// gives it its hit area.
struct TickBox: View {
    var done: Bool
    var habit: Bool
    var diameter: CGFloat = 22

    @Environment(\.colorScheme) private var scheme

    // oklch(0.5 0.016 272) and oklch(0.36 0.008 286): `--check-fill`.
    private static let pewter = Color(red: 96 / 255, green: 99 / 255, blue: 109 / 255)
    private static let graphite = Color(red: 61 / 255, green: 61 / 255, blue: 65 / 255)
    // oklch(0.9 0.2 125), clipped to sRGB: light mode's `--check-tick`.
    private static let vividLime = Color(red: 192 / 255, green: 244 / 255, blue: 71 / 255)

    var body: some View {
        let side = diameter * 0.9
        let shape = RoundedRectangle(cornerRadius: side * 5 / 16, style: .continuous)
        ZStack {
            if done {
                shape.fill(scheme == .dark ? Self.graphite : Self.pewter)
                ItemTickShape()
                    .stroke(scheme == .dark ? Color.accentColor : Self.vividLime,
                            style: StrokeStyle(lineWidth: side * (scheme == .dark ? 1.3 : 1.5) / 16,
                                               lineCap: .round, lineJoin: .round))
            } else if habit {
                shape.strokeBorder(Color.secondary, style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
            } else {
                shape.strokeBorder(Color.secondary, lineWidth: 1.5)
            }
        }
        .frame(width: side, height: side)
        .frame(width: diameter, height: diameter)
    }
}

/// The web's tick, `M4.3 8.4 7 11.1 12 5.4` on a 16-unit box.
struct ItemTickShape: Shape {
    func path(in rect: CGRect) -> Path {
        let u = rect.width / 16
        var p = Path()
        p.move(to: CGPoint(x: rect.minX + 4.3 * u, y: rect.minY + 8.4 * u))
        p.addLine(to: CGPoint(x: rect.minX + 7 * u, y: rect.minY + 11.1 * u))
        p.addLine(to: CGPoint(x: rect.minX + 12 * u, y: rect.minY + 5.4 * u))
        return p
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
