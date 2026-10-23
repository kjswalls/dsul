import DsulCore
import SwiftUI

/// The Organize tab (E board, design §6.1 and §6.2): every routine, season,
/// goal and project, each with its own colour tile, glyph, subtitle and header
/// count, under a large "Organize" and the avatar. What shows and what it says
/// is `OrganizeModel` (Foundation only, pinned by OrganizeTests); this draws it.
///
/// Each row pushes its container's page (O2, O3: ContainerPage.swift), where
/// it is edited. The summary cards (O4, SummaryCards.swift) open the list,
/// and the footer (O5, O14) ends it: Item types, Paused and, signed in,
/// Trash, each pushing its page. The + menu in the bar (O11) makes a routine,
/// a season, a goal or a project, each the switches show and the server
/// creates (`organizeCreates`), through a name sheet (CreateSheet.swift);
/// once the sheet has gone the new page is pushed, and VoiceOver hears
/// "Routine created". With nothing to make there is no +. The path is the
/// tab's own: tapping Organize again pops to the list, and a page whose
/// container goes takes itself off it (`OrganizePageHost`), a new one whose
/// create failed included.
///
/// No stack-wide `.tint`: Organize's lime marks (the banner's check, the
/// ticks, the strip, the ring and the timeline's nodes) are
/// `Color.accentColor`, and a stack tint would turn them the label colour.
/// Each control tints itself instead.
struct OrganizeView: View {
    @Environment(SamplePlanner.self) private var planner
    @State private var path: [OrganizeRoute] = []
    /// The name sheet, while it is up.
    @State private var creating: CreateEdit? = nil
    /// What the sheet made, pushed once it has gone.
    @State private var created: ContainerRef? = nil

    var body: some View {
        let creates = planner.organizeCreates
        NavigationStack(path: $path) {
            OrganizeList(path: $path)
                // A refused write's sentence shows here too, as on Today.
                .plannerBanner()
                .navigationTitle("Organize")
                .navigationBarTitleDisplayMode(.large)
                .toolbar {
                    if !creates.isEmpty {
                        ToolbarItem(placement: .topBarTrailing) {
                            CreateMenu(edits: creates) { creating = $0 }
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        AvatarMenu()
                    }
                }
                .navigationDestination(for: OrganizeRoute.self) { route in
                    OrganizeDestination(route: route, path: $path)
                }
        }
        .sheet(item: $creating, onDismiss: { pushCreated() }) { edit in
            CreateSheet(edit: edit) { created = $0 }
                .environment(planner)
        }
    }

    /// The sheet has gone: the new container's page goes on the stack, over
    /// whatever was there, and VoiceOver hears it once it has settled. One
    /// whose create was already taken back pops itself at once.
    private func pushCreated() {
        guard let ref = created else { return }
        created = nil
        path.append(.container(ref.kind, id: ref.id))
        SettledAnnouncement.post(ContainerEditModel.createdAnnouncement(ref.kind))
    }
}

/// The list's + (O11): New routine, New season, New goal and New project,
/// each the switches show and the server creates, in the list's order, with
/// the glyph the new one starts with (`createSymbol`). The label colour,
/// never the lime tint; to VoiceOver it is "New".
private struct CreateMenu: View {
    let edits: [CreateEdit]
    let onPick: (CreateEdit) -> Void

    var body: some View {
        Menu {
            ForEach(edits) { edit in
                Button {
                    onPick(edit)
                } label: {
                    Label(edit.title, systemImage: ContainerEditModel.createSymbol(edit))
                }
            }
        } label: {
            Label(ContainerEditModel.newLabel, systemImage: "plus")
        }
        .menuOrder(.fixed)
        .tint(Color.primary)
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
