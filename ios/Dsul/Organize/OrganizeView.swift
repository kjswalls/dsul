import DsulCore
import SwiftUI

/// The Organize tab (E board, design §6.1 and §6.2): every routine, season,
/// goal and project, each with its own colour tile, glyph, subtitle and header
/// count, under a large "Organize" and the avatar. What shows and what it says
/// is `OrganizeModel` (Foundation only, pinned by OrganizeTests); this draws it.
///
/// O1 is read-only. Rows open nothing yet; the container pages (O2, O3), the
/// summary cards (O4), the footer's Item types, Paused and Trash (O5, O14)
/// and the + menu (O11) come later, and the stack gains its path with the
/// first page.
///
/// No stack-wide `.tint`: Organize's lime marks (the banner's check, and later
/// the ticks, bars and rings) are `Color.accentColor`, and a stack tint would
/// turn them the label colour. Each control tints itself instead.
struct OrganizeView: View {
    var body: some View {
        NavigationStack {
            OrganizeList()
                // A refused write's sentence shows here too, as on Today.
                .plannerBanner()
                .navigationTitle("Organize")
                .navigationBarTitleDisplayMode(.large)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        AvatarMenu()
                    }
                }
        }
    }
}

/// The list itself: a spinner (or why the first fetch failed) until the
/// planner has loaded, then the sections and the quiet rows. Signed in, a pull
/// refreshes it, as on Today.
struct OrganizeList: View {
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
                ForEach(sections) { section in
                    Section {
                        ForEach(section.rows) { row in
                            ContainerRow(row: row)
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
