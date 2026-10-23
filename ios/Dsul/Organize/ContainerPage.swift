import DsulCore
import SwiftUI

// A container's page on the Organize stack (design §6.3, O2 and O3): the
// parts every page shares, and the host that keeps a page honest while its
// container comes and goes. What each page shows and says is
// ContainerPageModel (Foundation only, pinned by OrganizePageTests); these
// draw it.
//
// Read-only. The one write is the tick, the row's own (`toggle(_:on:)` on
// today, behind the `tick` gate), the write Today's circle sends; a row's tap
// opens the item's sheet on today. Edits come with O8 to O13.
//
// No tint anywhere here (OrganizeView): the ticks, the strip, the ring and
// the timeline's nodes are `Color.accentColor`, lime, and a tint would turn
// them the label colour. Lime is a mark, never text, and nothing lime sits
// inside anything faded.

/// Where a route on the Organize stack goes.
struct OrganizeDestination: View {
    let route: OrganizeRoute
    @Binding var path: [OrganizeRoute]

    var body: some View {
        switch route {
        case .container(let kind, let id):
            switch kind {
            case .routine: RoutinePageView(id: id, path: $path)
            case .season: SeasonPageView(id: id, path: $path)
            case .goal: GoalPageView(id: id, path: $path)
            case .project: ProjectPageView(id: id, path: $path)
            }
        }
    }
}

/// One page: its rows in an inset grouped list, the planner's banner over
/// it, pull to refresh, and the name in the bar once the header has scrolled
/// under it.
///
/// A page whose container goes (a delete from the web, a fetch without it)
/// takes itself off the stack, and keeps drawing what it last showed while it
/// slides away, as an item's page does (`ItemDetail`). One pushed for a
/// container already gone pops at once. While the container's extension is
/// off the page is the web's sentence, never "not found".
struct OrganizePageHost<Page: OrganizePageModel, Rows: View>: View {
    let route: OrganizeRoute
    @Binding var path: [OrganizeRoute]
    /// The page as the planner has it now; nil once the container is gone.
    let load: @MainActor (SamplePlanner) -> PageContent<Page>?
    @ViewBuilder let rows: (Page) -> Rows

    @Environment(SamplePlanner.self) private var planner
    @State private var lastShown: PageContent<Page>? = nil
    /// The header's name has scrolled under the bar: the bar shows it.
    @State private var titleShown = false
    /// How far the list scrolls before the header's name is under the bar:
    /// about the tile and the first line of a large title.
    @ScaledMetric(relativeTo: .largeTitle) private var titleFold: CGFloat = 96

    var body: some View {
        let live = load(planner)
        let shown = live ?? lastShown
        let title = shown?.title ?? ""
        List {
            switch shown {
            case .page(let page)?:
                rows(page)
            case .switchedOff(let off)?:
                Section {
                    SwitchedOffRow(off: off)
                }
            case nil:
                EmptyView()
            }
        }
        .listStyle(.insetGrouped)
        .modifier(LiveRefresh(planner: planner))
        // A refused tick's sentence shows here too: the list's banner is
        // under this page.
        .plannerBanner()
        // The back button's words on a page pushed from this one, and the
        // stack's long-press menu.
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .opacity(titleShown ? 1 : 0)
                    .accessibilityHidden(!titleShown)
            }
        }
        .onScrollGeometryChange(for: Bool.self) { [fold = titleFold] geometry in
            geometry.contentOffset.y + geometry.contentInsets.top > fold
        } action: { _, past in
            withAnimation(.easeInOut(duration: 0.15)) { titleShown = past }
        }
        .onChange(of: live, initial: true) { _, now in
            if let now {
                lastShown = now
            } else {
                path.removeAll { planner.isGone($0) }
            }
        }
    }
}

extension View {
    /// A row of a page's top (the header, its lines, the chips, the notes):
    /// on the page's own background, with no separator, edge to edge of the
    /// sections below. A button in it (the notes' Show all) answers its own
    /// taps, never the whole row's, as a list row's plain button would.
    func pageTopRow() -> some View {
        self
            .buttonStyle(.borderless)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
    }
}

/// A page's header: the tile (or a goal's ring), the kind's eyebrow, and the
/// name in `.largeTitle`, wrapping. Hue is on the tile, its glyph and the
/// ring alone; the eyebrow is gray and the name the label colour. To
/// VoiceOver the name and kind are one heading ("Morning routine, routine"),
/// read before the ring's own label.
struct PageHeaderView: View {
    let header: PageHeader
    /// A goal's progress, drawn in place of the tile; nil draws the tile.
    var ring: GoalRing? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                if let ring {
                    GoalRingView(ring: ring, symbol: header.symbol, accent: header.accent)
                } else {
                    ContainerTile(symbol: header.symbol, accent: header.accent, side: 44)
                }
                Text(header.eyebrow)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.secondary)
                    .accessibilityHidden(true)
            }
            Text(header.title)
                .font(.largeTitle.bold())
                .foregroundStyle(Color.primary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(Text("\(header.title), \(jsLowercased(OrganizeModel.noun(header.kind)))"))
                .accessibilityAddTraits(.isHeader)
                .accessibilitySortPriority(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

/// A goal's progress ring: a gray track, the lime arc at the share of
/// milestones reached, and the goal's glyph in its colour at the centre, not
/// a percent. 64pt, scaling with Dynamic Type. One element to VoiceOver,
/// "2 of 5 milestones reached"; the glyph is hidden.
struct GoalRingView: View {
    let ring: GoalRing
    let symbol: String
    let accent: ContainerAccent

    @ScaledMetric(relativeTo: .body) private var side: CGFloat = 64
    @ScaledMetric(relativeTo: .body) private var line: CGFloat = 6
    @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = 24

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color(.tertiarySystemFill), lineWidth: line)
            Circle()
                .trim(from: 0, to: CGFloat(min(max(ring.fraction, 0), 1)))
                .stroke(Color.accentColor, style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.snappy, value: ring.fraction)
            Image(systemName: symbol)
                .font(.system(size: glyph, weight: .medium))
                .foregroundStyle(accent.color)
        }
        // A stroke straddles its path: inset by half the line, the ring
        // draws inside its frame.
        .padding(line / 2)
        .frame(width: side, height: side)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(ring.spokenLabel))
    }
}

/// The read-only chips under a page's header, wrapping as the item sheet's
/// do (`ChipFlow`), each in its 44pt slot: the symbol gray, the words the
/// label colour, no chevron (they edit nothing yet). One element each to
/// VoiceOver ("Status: Paused until Oct 30").
struct PageChipsView: View {
    let chips: [PageChip]

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let flow = ChipFlow()
        flow {
            ForEach(chips) { chip in
                HStack(spacing: 5) {
                    Image(systemName: chip.systemImage)
                        .foregroundStyle(.secondary)
                    Text(chip.text)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                }
                .foregroundStyle(Color.primary)
                .font(.subheadline)
                .chipBackground()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(chip.spoken))
                .chipSlot()
            }
        }
    }
}

/// A section's heading: sentence case, the title `.primary`, a count or
/// summary at the trailing edge `.secondary`. One heading to VoiceOver,
/// with the trailing words as they are said.
struct PageSectionHeader: View {
    let title: String
    var trailing: String? = nil
    /// The trailing words for VoiceOver; the shown ones with "·" as a pause
    /// when nil.
    var spokenTrailing: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.primary)
            Spacer(minLength: 8)
            if let trailing {
                Text(trailing)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(Color.secondary)
                    .multilineTextAlignment(.trailing)
            }
        }
        .textCase(nil)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(spokenLabel))
        .accessibilityAddTraits(.isHeader)
    }

    private var spokenLabel: String {
        guard let words = spokenTrailing ?? trailing.map(OrganizeModel.spokenSegment) else { return title }
        return "\(title), \(words)"
    }
}

/// A quiet line: an empty section's sentence, a note under the chips.
/// Secondary; it says why, it asks nothing.
struct PageQuietText: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(Color.secondary)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The page while its extension is off: the web's title and sentence, in
/// place of everything else.
private struct SwitchedOffRow: View {
    let off: SwitchedOff

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(off.title)
                .font(.body)
                .foregroundStyle(Color.secondary)
            Text(off.body)
                .font(.subheadline)
                .foregroundStyle(Color.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(off.sentence))
    }
}

/// One item on a page, Today's row in look: the status circle, the title
/// (struck through when done), the meta under it, and a habit's flame while
/// Streaks is on.
///
/// The circle is the tick only for an item on today (`tickable`), through
/// the row's own write on today, never the selected day's; anywhere else on
/// the row, and the whole row of an item not on today, opens the item's sheet
/// on today. Skipped today, the circle gives way to a skip mark (the sheet is
/// where Unskip is). To VoiceOver the row is ONE element whose activation
/// opens the sheet; Done is its value, and the tick a named action.
struct MemberRowView: View {
    let row: MemberRow

    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        HStack(spacing: 12) {
            if row.tickable {
                // Drawn at 22 in a 30pt column, hit over 44pt: the overhang
                // grows the hit shape and leaves the layout alone.
                Button(action: toggle) {
                    TickCircle(done: row.done, habit: row.item.isHabit)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle())
                .padding(-7)
            }

            Button(action: open) {
                HStack(spacing: 12) {
                    if !row.tickable {
                        mark
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.item.title)
                            .strikethrough(row.done)
                            .foregroundStyle(row.done || row.skipped ? Color.secondary : Color.primary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        if let subline {
                            Text(subline)
                                .font(.footnote)
                                .foregroundStyle(Color.secondary)
                                .multilineTextAlignment(.leading)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if row.flame {
                        StreakLabel(streak: row.item.streak ?? 0, lit: row.done)
                    }
                }
                // The hit shape overhangs the label to the row's edges, as
                // Today's does, and leaves the layout alone.
                .padding(.vertical, 11)
                .contentShape(Rectangle())
                .padding(.vertical, -11)
            }
            .buttonStyle(RowPressStyle())
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(row.spokenLabel))
        .accessibilityValue(Text(row.done ? "Done" : ""))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text(ContainerPageModel.openHint))
        .accessibilityAction { open() }
        .accessibilityActions {
            if row.tickable {
                Button(ContainerPageModel.tickName(done: row.done)) { toggle() }
            }
        }
        .accessibilityInputLabels([Text(row.item.title)])
    }

    /// The meta, then why it is hidden, as one line.
    private var subline: String? {
        let parts = [row.meta, row.hiddenNote].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: OrganizeModel.separator)
    }

    /// Where the tick would be on a row that doesn't tick today: a skip
    /// mark, or the circle drawn for its state, part of the open button.
    @ViewBuilder
    private var mark: some View {
        if row.skipped {
            Image(systemName: "forward.end")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.secondary)
                .frame(width: 30, height: 30)
        } else {
            TickCircle(done: row.done, habit: row.item.isHabit)
                .frame(width: 30, height: 30)
        }
    }

    private func open() {
        planner.open(row.item.id, day: .today)
    }

    private func toggle() {
        planner.toggle(row.item.id, on: planner.today)
    }
}

/// A container row that pushes its page: the Organize list's rows, a
/// routine's "Held by", a season's routines.
struct ContainerLinkRow: View {
    let row: OrganizeRow

    var body: some View {
        NavigationLink(value: row.route) {
            ContainerRow(row: row)
        }
        .accessibilityHint(Text(row.hint))
    }
}
