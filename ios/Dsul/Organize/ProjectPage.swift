import DsulCore
import SwiftUI

/// A project's page (O3, design §6.3): the header, the item count and the
/// time block as read-only chips, its notes, the items the count counts (open
/// first, then done), and the last 14 days when anything is in range. What
/// shows is `ContainerPageModel.projectPage`. Ungated, as on the web.
struct ProjectPageView: View {
    let id: String
    @Binding var path: [OrganizeRoute]

    var body: some View {
        OrganizePageHost(route: .container(.project, id: id), path: $path,
                         load: { $0.projectPage(id) }) { (page: ProjectPage) in
            ProjectPageRows(page: page)
        }
    }
}

private struct ProjectPageRows: View {
    let page: ProjectPage

    var body: some View {
        Section {
            PageHeaderView(header: page.header)
                .pageTopRow()
            PageChipsView(chips: page.chips)
                .pageTopRow()
            if let notes = page.notes {
                NotesText(text: notes, onEdit: nil)
                    .pageTopRow()
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
