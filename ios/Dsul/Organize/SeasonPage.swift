import DsulCore
import SwiftUI

/// A season's page (O2, design §6.3): the header, its notes, the Status chip
/// (and Runs under Dates) with the web's sentence for its state, the routines
/// it holds (each pushing its page), its own items, and the last 14 days over
/// its items and its routines' items. What shows is
/// `ContainerPageModel.seasonPage`.
///
/// From O8a the Status chip is a menu of the three states where the server
/// takes the write; a pick is sent as picked (`setSeasonState`), and the
/// sentence under it follows the stepped season.
struct SeasonPageView: View {
    let id: String
    @Binding var path: [OrganizeRoute]

    var body: some View {
        OrganizePageHost(route: .container(.season, id: id), path: $path,
                         load: { $0.seasonPage(id) }) { (page: SeasonPage) in
            SeasonPageRows(seasonId: id, page: page)
        }
    }
}

private struct SeasonPageRows: View {
    /// The season this page shows.
    let seasonId: String
    let page: SeasonPage

    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        Section {
            PageHeaderView(header: page.header)
                .pageTopRow()
            if let notes = page.notes {
                NotesText(text: notes, onEdit: nil)
                    .pageTopRow()
            }
            PageChipsView(chips: page.chips, status: page.statusMenu, onStatus: { pick($0) })
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

    /// A Status pick: the state picked, sent as it is.
    private func pick(_ action: StatusAction) {
        switch action {
        case .state(let state):
            withAnimation(.snappy) { planner.setSeasonState(seasonId, state) }
        case .pause, .pauseUntil, .resume:
            // A routine's; a season's menu never offers them.
            break
        }
    }
}
