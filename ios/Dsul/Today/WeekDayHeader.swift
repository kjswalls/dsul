import DsulCore
import SwiftUI

/// One day's heading in Week × List and Week × Buckets: the weekday over its
/// date ("Thursday  Oct 1"), and on today a 6pt lime dot by the weekday; the
/// date and the word stay in ink (lime is a mark, never text; the web's
/// coloured "today" word is not copied, design W12). A tap opens that day in
/// Day, on the same layout (W7). To VoiceOver it is a heading and a button:
/// "Thursday, October 1, today", hint "Opens this day".
///
/// At the accessibility sizes the date drops under the weekday rather than
/// clipping, so a heading stays whole.
struct WeekDayHeader: View {
    var day: DayString
    var isToday: Bool
    var onOpen: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 0) {
                lines
                Spacer(minLength: 0)
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        // A press fills behind the label and never fades it, so today's dot
        // keeps its full strength.
        .buttonStyle(RowPressStyle())
        // The button is already one element; its label is replaced whole.
        .accessibilityLabel(Text(PlannerFormat.spokenHeading(day, isToday: isToday)))
        .accessibilityAddTraits(.isHeader)
        .accessibilityHint(Text(PlannerFormat.opensThisDay))
    }

    private var lines: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
        return layout {
            HStack(alignment: .center, spacing: 6) {
                Text(PlannerFormat.weekdayName(day))
                    .font(.headline)
                    .foregroundStyle(Color.primary)
                if isToday {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 6, height: 6)
                }
            }
            Text(PlannerFormat.headingDate(day))
                .font(.subheadline)
                .foregroundStyle(Color.secondary)
        }
        .multilineTextAlignment(.leading)
    }
}
