import DsulCore
import SwiftUI

/// Organize's Paused page (O5, design §6.3): the welcome line, then
/// everything set aside, grouped by the day it comes back ("Tomorrow", "Fri,
/// Oct 30", "No date"), or "Nothing is paused.". What shows is
/// `ShelfPageModel.pausedPage` (pinned by ShelfPageTests); this draws it.
///
/// An item's row opens its sheet and carries Resume where the sheet would
/// offer it: the planner's own `resume(_:)`, the item `pause` write with
/// `paused: false`, never a write of its own. A routine's or season's row
/// pushes its paused detail (PausedEntryPage.swift) and, from O8a, carries
/// Resume where the server takes the container's write: the planner's
/// `turnOn(_:)`, the web's `setGateOn`, whatever the switches say. The page
/// rides no switch: pausing is not gated, so its way back may not be.
/// Nothing here is late; a date is a return, never an age.
struct PausedPageView: View {
    /// The tab's stack, for a routine's or season's push beside its Resume.
    @Binding var path: [OrganizeRoute]

    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        let page = planner.pausedPage
        List {
            Section {
                PageQuietText(text: page.welcome)
                    .pageTopRow()
            }
            if let empty = page.empty {
                Section {
                    PageQuietText(text: empty)
                }
            }
            ForEach(page.groups) { group in
                Section {
                    ForEach(group.rows) { row in
                        PausedRowView(row: row, path: $path)
                    }
                } header: {
                    PageSectionHeader(title: group.title)
                }
            }
        }
        .listStyle(.insetGrouped)
        .modifier(LiveRefresh(planner: planner))
        // A refused resume's sentence shows here too.
        .plannerBanner()
        .navigationTitle(ShelfPageModel.pausedTitle)
        .navigationBarTitleDisplayMode(.large)
    }
}

/// One paused thing: its mark, its name, what it is, and Resume where it has
/// one. To VoiceOver the row is one element ("Read, Habit") whose activation
/// opens the item's sheet or pushes the container's detail, with Resume as a
/// named action. A routine's or season's row with no Resume (a server older
/// than the write) is a plain link to its detail, as in O5; with one it is a
/// button that pushes, as an item's opens, so the pill beside it takes its
/// own taps.
private struct PausedRowView: View {
    let row: PausedRow
    @Binding var path: [OrganizeRoute]

    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        if let route = row.route, !row.resumable {
            NavigationLink(value: route) {
                label
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text(row.spokenLabel))
            }
            .accessibilityHint(Text(ContainerPageModel.openHint))
        } else {
            HStack(spacing: 12) {
                Button(action: open) {
                    HStack(spacing: 8) {
                        label
                        // A row that pushes says so, as the link it stands
                        // in for does (and as a subtask row does).
                        if row.route != nil {
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                                .accessibilityHidden(true)
                        }
                    }
                    // The hit shape overhangs the label to the row's
                    // edges, as Today's does, and leaves the layout alone.
                    .padding(.vertical, 11)
                    .contentShape(Rectangle())
                    .padding(.vertical, -11)
                }
                .buttonStyle(RowPressStyle())
                if row.resumable {
                    Button(ShelfPageModel.resume, action: resume)
                        .buttonStyle(ShelfPillStyle())
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(row.spokenLabel))
            .accessibilityAddTraits(.isButton)
            .accessibilityHint(Text(ContainerPageModel.openHint))
            .accessibilityAction { open() }
            .accessibilityActions {
                if row.resumable {
                    Button(ShelfPageModel.resume) { resume() }
                }
            }
            .accessibilityInputLabels([Text(row.name)])
        }
    }

    private var label: some View {
        HStack(spacing: 12) {
            PausedMarkView(mark: row.mark)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                    .foregroundStyle(Color.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Text(row.kindLine)
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// An item's sheet, or a routine's or season's paused detail.
    private func open() {
        if let route = row.route {
            path.append(route)
        } else if let id = row.itemId {
            planner.open(id, day: .today)
        }
    }

    /// The item's own Resume, or the container's way back (`turnOn`).
    private func resume() {
        guard row.resumable else { return }
        if let ref = row.container {
            planner.turnOn(ref)
        } else if let id = row.itemId {
            planner.resume(id)
        }
    }
}

/// Where a paused row's tick would be: an item's outline, dashed and gray
/// (round for a habit, as the grid draws it), quiet because nothing about it
/// is due; or a container's own glyph in its colour. Decorative. The column
/// grows with Dynamic Type beside the outline and the glyph, as an Organize
/// tile does, so a large size never crowds the name.
struct PausedMarkView: View {
    let mark: PausedMark

    @ScaledMetric(relativeTo: .body) private var outline: CGFloat = 18
    @ScaledMetric(relativeTo: .body) private var column: CGFloat = 30

    var body: some View {
        Group {
            switch mark {
            case .item(let habit):
                if habit {
                    Circle()
                        .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [3, 2.5]))
                        .foregroundStyle(Color.secondary)
                        .frame(width: outline, height: outline)
                } else {
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [3, 2.5]))
                        .foregroundStyle(Color.secondary)
                        .frame(width: outline, height: outline)
                }
            case .container(let symbol, let accent):
                Image(systemName: symbol)
                    .font(.body.weight(.medium))
                    .foregroundStyle(accent.color)
            }
        }
        .frame(width: column, height: column)
        .accessibilityHidden(true)
    }
}

/// A row's own verb (Resume, Restore): a gray capsule, the word in the label
/// colour, hit over 44pt. Never the tint: the lime accent is a mark, never
/// text. Nothing lime sits inside it, so the press may dim it.
struct ShelfPillStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.medium))
            .foregroundStyle(isEnabled ? Color.primary : Color.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Capsule().fill(Color(.tertiarySystemFill)))
            .opacity(configuration.isPressed ? 0.6 : 1)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
    }
}
