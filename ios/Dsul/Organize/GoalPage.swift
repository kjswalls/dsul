import DsulCore
import SwiftUI

/// A goal's page (O3, design §6.3 and §2 Q12 to Q14): the ring, the why
/// above every number, the countdown, the Status and window chips, an ended
/// goal's note, the time elapsed, then the wind-down list of an ended goal's
/// recurring members, the milestones' timeline, the check-ins and the
/// supporting work grouped by type. What shows is
/// `ContainerPageModel.goalPage`; while Goals is off, the web's sentence.
///
/// Every row opens the item's sheet, and says why when something hides it.
/// A milestone's node is its tick, whatever its date (`toggle(_:on:)` on
/// today behind the `tick` gate: one-shot, so the day doesn't matter).
struct GoalPageView: View {
    let id: String
    @Binding var path: [OrganizeRoute]

    var body: some View {
        OrganizePageHost(route: .container(.goal, id: id), path: $path,
                         load: { $0.goalPage(id) }) { (page: GoalPage) in
            GoalPageRows(page: page)
        }
    }
}

private struct GoalPageRows: View {
    let page: GoalPage

    var body: some View {
        Section {
            PageHeaderView(header: page.header, ring: page.ring)
                .pageTopRow()
            if let why = page.why {
                NotesText(text: why, onEdit: nil)
                    .pageTopRow()
            }
            if let countdown = page.countdown {
                Text(countdown)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .pageTopRow()
            }
            PageChipsView(chips: page.chips)
                .pageTopRow()
            if let ended = page.endedNote {
                PageQuietText(text: ended)
                    .pageTopRow()
            }
            if let elapsed = page.elapsed {
                PageQuietText(text: elapsed)
                    .pageTopRow()
            }
        }

        if let windDown = page.windDown {
            Section {
                PageQuietText(text: windDown.sentence)
                ForEach(windDown.rows) { row in
                    MemberRowView(row: row)
                }
            }
        }

        Section {
            ForEach(page.milestones) { line in
                MilestoneRowView(line: line, isFirst: line.id == page.milestones.first?.id,
                                 isLast: line.id == page.milestones.last?.id)
                    // Edge to edge top and bottom, so the rail runs on
                    // through the rows; no separator across it.
                    .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                    .listRowSeparator(.hidden)
            }
            if let empty = page.milestonesEmpty {
                PageQuietText(text: empty)
            }
        } header: {
            PageSectionHeader(title: ContainerPageModel.milestonesTitle, trailing: page.progress,
                              spokenTrailing: page.progressSpoken)
        }

        Section {
            ForEach(page.checkins) { row in
                MemberRowView(row: row)
            }
            if let empty = page.checkinsEmpty {
                PageQuietText(text: empty)
            }
        } header: {
            PageSectionHeader(title: ContainerPageModel.checkinsTitle)
        }

        Section {
            ForEach(page.groups) { group in
                Text(group.title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.secondary)
                    .accessibilityAddTraits(.isHeader)
                ForEach(group.rows) { row in
                    MemberRowView(row: row)
                }
            }
            if let empty = page.supportingEmpty {
                PageQuietText(text: empty)
            }
        } header: {
            PageSectionHeader(title: ContainerPageModel.supportingTitle)
        }
    }
}

/// One checkpoint on the timeline: its node on a 2pt gray rail that runs
/// through every row, the title, and the caption ("Oct 4 · next up"), with
/// the hidden note under it when something hides it.
///
/// - Reached: a lime node with a check, the title struck through, gray.
/// - Next: a 2pt lime ring; the title and caption the label colour,
///   semibold, never lime.
/// - Ahead, late or dropped: a gray ring, and the web's words.
///
/// The node ticks it, where the `tick` gate allows (never a dropped one);
/// the rest of the row opens its sheet. To VoiceOver the row is one element,
/// "Run a 10K, Oct 4, next up", whose activation opens the sheet, with the
/// tick as a named action ("Mark Run a 10K reached").
private struct MilestoneRowView: View {
    let line: MilestoneLine
    let isFirst: Bool
    let isLast: Bool

    @Environment(SamplePlanner.self) private var planner
    @ScaledMetric(relativeTo: .body) private var node: CGFloat = 22
    @ScaledMetric(relativeTo: .body) private var inset: CGFloat = 11

    var body: some View {
        let canTick = planner.canTick(line.item.id, on: planner.today)
        HStack(alignment: .top, spacing: 12) {
            Group {
                if canTick {
                    // Hit over 44pt around the 22pt node; the overhang
                    // leaves the layout alone.
                    Button(action: tick) {
                        nodeMark
                            .frame(width: hit, height: hit)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressScaleStyle())
                    .padding((node - hit) / 2)
                } else {
                    nodeMark
                }
            }
            .padding(.top, inset)

            Button(action: open) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(line.item.title)
                        .font(line.state == .next ? Font.body.weight(.semibold) : Font.body)
                        .strikethrough(line.state == .achieved)
                        .foregroundStyle(titleStyle)
                        .multilineTextAlignment(.leading)
                    Text(line.caption)
                        .font(line.state == .next ? Font.footnote.weight(.semibold) : Font.footnote)
                        .foregroundStyle(line.state == .next ? Color.primary : Color.secondary)
                        .multilineTextAlignment(.leading)
                    if let hidden = line.hiddenNote {
                        Text(hidden)
                            .font(.footnote)
                            .foregroundStyle(Color.secondary)
                            .multilineTextAlignment(.leading)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, inset)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle(verticalBleed: 0))
        }
        .background(alignment: .topLeading) {
            rail
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(line.spokenLabel))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text(ContainerPageModel.openHint))
        .accessibilityAction { open() }
        .accessibilityActions {
            if canTick {
                Button(line.tickLabel) { tick() }
            }
        }
        .accessibilityInputLabels([Text(line.item.title)])
    }

    /// The node's hit square: 44pt, or the node itself once it is larger.
    private var hit: CGFloat { max(44, node) }

    private var titleStyle: Color {
        switch line.state {
        case .achieved, .dropped: return Color.secondary
        case .next, .overdue, .ahead: return Color.primary
        }
    }

    /// The node for the state, over the row's own background so the rail
    /// never shows through it.
    @ViewBuilder
    private var nodeMark: some View {
        ZStack {
            Circle()
                .fill(Color(.secondarySystemGroupedBackground))
            switch line.state {
            case .achieved:
                TickCircle(done: true, habit: false, diameter: node)
            case .next:
                Circle()
                    .strokeBorder(Color.accentColor, lineWidth: 2)
            case .overdue, .ahead, .dropped:
                Circle()
                    .strokeBorder(Color.secondary, lineWidth: 1.5)
            }
        }
        .frame(width: node, height: node)
    }

    /// The rail: from the row's top to the node (not above the first), and
    /// from the node to the row's bottom (not below the last). The rows sit
    /// edge to edge, so the segments meet.
    private var rail: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(isFirst ? Color.clear : Color(.separator))
                .frame(width: 2, height: inset + node / 2)
            Rectangle()
                .fill(isLast ? Color.clear : Color(.separator))
                .frame(width: 2)
                .frame(maxHeight: .infinity)
        }
        .frame(width: node)
        .accessibilityHidden(true)
    }

    private func open() {
        planner.open(line.item.id, day: .today)
    }

    private func tick() {
        planner.toggle(line.item.id, on: planner.today)
    }
}
