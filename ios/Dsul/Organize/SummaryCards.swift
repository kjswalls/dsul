import DsulCore
import SwiftUI

/// The two cards over the Organize list (O4, design §6.2): THIS WEEK and NEXT
/// MILESTONE. What they say is `OrganizeModel.summary` (Foundation only,
/// pinned by ShelfPageTests); this draws it.
///
/// Side by side while both fit the row's width (`ViewThatFits`), stacked when
/// they don't and at every accessibility size; one alone spans the width. On
/// the list's own background, each card its own grouped surface.
///
/// The week's bar is the one lime here: a full-strength `Color.accentColor`
/// fill on a gray track, never faded and never text. The milestone card is
/// one button that pushes its goal onto the tab's path; nothing on it is
/// lime.
struct SummaryCardsSection: View {
    let cards: SummaryCards
    /// The tab's stack: the milestone card pushes its goal onto it.
    @Binding var path: [OrganizeRoute]

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// A card's narrowest comfortable width side by side: two of these and
    /// the gap must fit the row, or the cards stack.
    @ScaledMetric(relativeTo: .body) private var cardWidth: CGFloat = 150

    var body: some View {
        Section {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    stacked
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: 12) {
                            cardViews(sideBySide: true)
                        }
                        // As tall as the taller card, which both then fill.
                        .fixedSize(horizontal: false, vertical: true)
                        stacked
                    }
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowSeparator(.hidden)
        }
    }

    private var stacked: some View {
        VStack(spacing: 12) {
            cardViews(sideBySide: false)
        }
    }

    /// Each card at its own width: side by side, it asks for `cardWidth` at
    /// least so `ViewThatFits` measures the pair honestly, and grows to share
    /// the row; stacked, it spans it.
    @ViewBuilder
    private func cardViews(sideBySide: Bool) -> some View {
        if let week = cards.week {
            WeekCard(week: week)
                .frame(minWidth: sideBySide ? cardWidth : nil, idealWidth: sideBySide ? cardWidth : nil,
                       maxWidth: .infinity, maxHeight: sideBySide ? .infinity : nil, alignment: .topLeading)
        }
        if let milestone = cards.milestone {
            MilestoneCard(milestone: milestone) { path.append(milestone.route) }
                .frame(minWidth: sideBySide ? cardWidth : nil, idealWidth: sideBySide ? cardWidth : nil,
                       maxWidth: .infinity, maxHeight: sideBySide ? .infinity : nil, alignment: .topLeading)
        }
    }
}

/// A card's surface: the grouped list's row colour, rounded.
private struct CardSurface: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(14)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color(.secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

/// THIS WEEK: the eyebrow, "18" and "of 23 done", and the bar; or "Nothing
/// on this week" with no bar. One element to VoiceOver: "This week, 18 of 23
/// done".
private struct WeekCard: View {
    let week: SummaryCards.Week

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Eyebrow(text: SummaryCards.weekEyebrow)
            if let lead = week.lead {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(lead)
                        .font(.title2.bold().monospacedDigit())
                        .foregroundStyle(Color.primary)
                    Text(week.tail)
                        .font(.subheadline)
                        .foregroundStyle(Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text(week.tail)
                    .font(.subheadline)
                    .foregroundStyle(Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let fraction = week.fraction {
                WeekBar(fraction: fraction)
                    .padding(.top, 2)
            }
        }
        .modifier(CardSurface())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(week.spokenLabel))
    }
}

/// The week's bar: a 5pt capsule, a gray track and the lime fill at
/// `done / counted`. Decorative: the card's label says the numbers.
private struct WeekBar: View {
    let fraction: Double

    @ScaledMetric(relativeTo: .body) private var height: CGFloat = 5

    var body: some View {
        Capsule()
            .fill(Color(.tertiarySystemFill))
            .frame(height: height)
            .overlay(alignment: .leading) {
                GeometryReader { geometry in
                    Capsule()
                        .fill(Color.accentColor)
                        .frame(width: geometry.size.width * CGFloat(min(max(fraction, 0), 1)))
                }
            }
            .animation(.snappy, value: fraction)
            .accessibilityHidden(true)
    }
}

/// NEXT MILESTONE: the eyebrow, the milestone's title (two lines at most),
/// and its day and goal. One button that pushes the goal, with the hint
/// "Opens the goal". A button on the path rather than a `NavigationLink`, so
/// the list never treats the whole row, the week card included, as the link.
private struct MilestoneCard: View {
    let milestone: SummaryCards.Milestone
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            VStack(alignment: .leading, spacing: 4) {
                Eyebrow(text: SummaryCards.milestoneEyebrow)
                Text(milestone.title)
                    .font(.headline)
                    .foregroundStyle(Color.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(milestone.line)
                    .font(.subheadline)
                    .foregroundStyle(Color.secondary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .modifier(CardSurface())
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        // Its own style, so the tap is the card's alone (not the whole row's,
        // as a list row's lone default button would take it) and nothing
        // takes the tint.
        .buttonStyle(CardPressStyle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(milestone.spokenLabel))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text(SummaryCards.milestoneHint))
    }
}

/// A card's press: a soft fill over the card's own shape. The label never
/// fades.
private struct CardPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color(.systemFill))
                    .opacity(configuration.isPressed ? 1 : 0)
                    .allowsHitTesting(false)
            }
    }
}

/// A card's eyebrow: `.caption` semibold, gray. Hidden from VoiceOver: the
/// card's label opens with the same words.
private struct Eyebrow: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.secondary)
            .accessibilityHidden(true)
    }
}
