import DsulCore
import SwiftUI

/// A routine's page (O2, design §6.3): the header, its notes, the Usual time
/// and Status chips with the paused or held note under them, the seasons that
/// hold it, today's members in its own order with their ticks and the web's
/// empty and finished lines, the members on other days with their cadence,
/// and the last 14 days. What shows is `ContainerPageModel.routinePage`.
struct RoutinePageView: View {
    let id: String
    @Binding var path: [OrganizeRoute]

    var body: some View {
        OrganizePageHost(route: .container(.routine, id: id), path: $path,
                         load: { $0.routinePage(id) }) { (page: RoutinePage) in
            RoutinePageRows(page: page)
        }
    }
}

private struct RoutinePageRows: View {
    let page: RoutinePage

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
            if let note = page.statusNote {
                PageQuietText(text: note)
                    .pageTopRow()
            }
        }

        Section {
            ForEach(page.heldBy) { row in
                ContainerLinkRow(row: row)
            }
            if let none = page.heldByEmpty {
                PageQuietText(text: none)
            }
        } header: {
            PageSectionHeader(title: ContainerPageModel.heldByTitle)
        }

        if let today = page.today {
            Section {
                ForEach(today.rows) { row in
                    MemberRowView(row: row)
                }
                if let empty = today.empty {
                    PageQuietText(text: empty)
                }
            } header: {
                PageSectionHeader(title: ContainerPageModel.todayTitle, trailing: today.summary)
            } footer: {
                if let finished = today.finished {
                    Text(finished)
                }
            }
        }

        if !page.otherDays.isEmpty {
            Section {
                ForEach(page.otherDays) { row in
                    MemberRowView(row: row)
                }
            } header: {
                PageSectionHeader(title: ContainerPageModel.otherDaysTitle)
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
