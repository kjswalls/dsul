import DsulCore
import SwiftUI

/// The Organize tab (E board, design §6.1 and §6.2): every routine, season,
/// goal and project, each with its own colour tile, glyph, subtitle and header
/// count, under a large "Organize" and the avatar. What shows and what it says
/// is `OrganizeModel` (Foundation only, pinned by OrganizeTests); this draws it.
///
/// Read-only still, but for the tick, an item's Resume on Paused and a
/// restore from the Trash. Each row pushes its container's page (O2, O3:
/// ContainerPage.swift). The summary cards (O4, SummaryCards.swift) open the
/// list, and the footer (O5, O14) ends it: Item types, Paused and, signed
/// in, Trash, each pushing its page. The + menu (O11) comes later. The path
/// is the tab's own: tapping Organize again pops to the list, and a page
/// whose container goes takes itself off it (`OrganizePageHost`).
///
/// No stack-wide `.tint`: Organize's lime marks (the banner's check, the
/// ticks, the strip, the ring and the timeline's nodes) are
/// `Color.accentColor`, and a stack tint would turn them the label colour.
/// Each control tints itself instead.
struct OrganizeView: View {
    @State private var path: [OrganizeRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            OrganizeList(path: $path)
                // A refused write's sentence shows here too, as on Today.
                .plannerBanner()
                .navigationTitle("Organize")
                .navigationBarTitleDisplayMode(.large)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        AvatarMenu()
                    }
                }
                .navigationDestination(for: OrganizeRoute.self) { route in
                    OrganizeDestination(route: route, path: $path)
                }
        }
    }
}

/// The list itself: a spinner (or why the first fetch failed) until the
/// planner has loaded, then the summary cards, the sections, the quiet rows
/// and the footer. Signed in, a pull refreshes it, as on Today.
struct OrganizeList: View {
    /// The tab's stack, for the milestone card's push.
    @Binding var path: [OrganizeRoute]

    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        List {
            switch planner.organize {
            case .loading, .failed:
                // PlannerLoadingRow reads the error off the planner itself,
                // the same `loadError` the model's `.failed` came from.
                Section {
                    PlannerLoadingRow(loadingText: OrganizeModel.loadingText)
                }
            case .list(let sections, let nothingYet, let switchedOff):
                if let cards = planner.organizeSummary {
                    SummaryCardsSection(cards: cards, path: $path)
                }
                ForEach(sections) { section in
                    Section {
                        ForEach(section.rows) { row in
                            ContainerLinkRow(row: row)
                        }
                    } header: {
                        OrganizeSectionHeader(section: section)
                    }
                }
                if let nothingYet {
                    Section {
                        OrganizeNoteRow(note: nothingYet)
                    }
                }
                if let switchedOff {
                    Section {
                        OrganizeNoteRow(note: switchedOff)
                    }
                }
                Section {
                    ForEach(planner.organizeFooter) { row in
                        FooterLinkRow(row: row)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .modifier(LiveRefresh(planner: planner))
    }
}

/// "Routines" and its count, "Seasons" and "1 on": sentence case (not the
/// grouped list's capitals), the title `.primary`, the count `.secondary`.
/// One header element to VoiceOver.
private struct OrganizeSectionHeader: View {
    var section: OrganizeSection

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(section.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.primary)
            Spacer(minLength: 8)
            Text(section.count)
                .font(.footnote.monospacedDigit())
                .foregroundStyle(Color.secondary)
        }
        .textCase(nil)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(section.spokenLabel))
        .accessibilityAddTraits(.isHeader)
    }
}

/// A quiet row: "Nothing here yet." or "Organize is switched off.", with its
/// second line under it. Secondary throughout; it says why, it asks nothing.
private struct OrganizeNoteRow: View {
    var note: OrganizeNote

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(note.title)
                .font(.body)
                .foregroundStyle(Color.secondary)
            if let detail = note.detail {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(Color.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(note.spokenLabel))
    }
}

/// A footer row: Item types (plum, the Shapes glyph), Paused and Trash (gray),
/// with Item types' count, or Paused's and its soonest return, pushing the
/// row's page.
private struct FooterLinkRow: View {
    var row: FooterRow

    var body: some View {
        NavigationLink(value: row.route) {
            TileRow(symbol: row.symbol, color: row.accent?.color ?? Color(.systemGray), title: row.title,
                    subtitle: row.subtitle, trailing: row.trailing, spokenLabel: row.spokenLabel)
        }
        .accessibilityHint(Text(row.hint))
    }
}
