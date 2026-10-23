import DsulCore
import SwiftUI

/// A season's page (O2, design §6.3): the header, its notes, the Status chip
/// (and Runs under Dates) with the web's sentence for its state, the routines
/// it holds (each pushing its page), its own items, and the last 14 days over
/// its items and its routines' items. What shows is
/// `ContainerPageModel.seasonPage`.
struct SeasonPageView: View {
    let id: String
    @Binding var path: [OrganizeRoute]

    var body: some View {
        OrganizePageHost(route: .container(.season, id: id), path: $path,
                         load: { $0.seasonPage(id) }) { (page: SeasonPage) in
            SeasonPageRows(page: page)
        }
    }
}

private struct SeasonPageRows: View {
    let page: SeasonPage

    var body: some View {
        Section {
            PageHeaderView(header: page.header)
                .pageTopRow()
            if let notes = page.notes {
                NotesText(text: notes, onEdit: nil)
                    .pageTopRow()
            }
            PageChipsView(chips: page.chips)
                .pageTopRow()
            PageQuietText(text: page.stateNote)
                .pageTopRow()
        }

        if !page.routines.isEmpty {
            Section {
                ForEach(page.routines) { row in
                    ContainerLinkRow(row: row)
                }
            } header: {
                PageSectionHeader(title: OrganizeModel.pluralNoun(.routine))
            }
        }

        if !page.items.isEmpty {
            Section {
                ForEach(page.items) { row in
                    MemberRowView(row: row)
                }
            } header: {
                PageSectionHeader(title: ContainerPageModel.itemsTitle)
            }
        }

        if let strip = page.strip {
            Section {
                DayStripView(strip: strip)
            } header: {
                PageSectionHeader(title: ContainerPageModel.stripTitle)
            }
        }

        if let empty = page.empty {
            Section {
                PageQuietText(text: empty)
            }
        }
    }
}
