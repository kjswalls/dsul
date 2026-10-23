import DsulCore
import SwiftUI

/// A paused routine's or season's detail (O5, design §6.3), the web's paused
/// detail (paused.tsx): its header, the state line under a moon ("Hidden with
/// your Evening routine until Oct 30."), what comes back with it (each member
/// with the Paused list's dashed outline, opening its sheet), and "Open in
/// Routines" or "Open in Seasons" while Organize is on. Pushed from Paused
/// rather than the container's page, which Organize off would blank. What
/// shows is `ShelfPageModel.pausedEntryPage` (pinned by ShelfPageTests).
///
/// No Resume yet: a container resumes from O8a ("Resume now", "Turn on now").
/// The page pops itself once the entry is off the shelf (resumed elsewhere,
/// back on its day, or deleted), as a container's page does when it goes.
struct PausedEntryPageView: View {
    let key: String
    @Binding var path: [OrganizeRoute]

    var body: some View {
        OrganizePageHost(route: .pausedEntry(key), path: $path,
                         load: { $0.pausedEntryPage(key) }) { (page: PausedEntryPage) in
            PausedEntryRows(page: page)
        }
    }
}

private struct PausedEntryRows: View {
    let page: PausedEntryPage

    var body: some View {
        Section {
            PageHeaderView(header: page.header)
                .pageTopRow()
            PageQuietText(text: page.kindLine)
                .pageTopRow()
        }

        Section {
            Label {
                Text(page.stateLine)
                    .font(.subheadline)
                    .foregroundStyle(Color.primary)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "moon")
                    .foregroundStyle(Color.secondary)
            }
        }

        Section {
            ForEach(page.members) { row in
                MemberRowView(row: row, paused: true)
            }
        } header: {
            PageSectionHeader(title: ShelfPageModel.comesBackTitle)
        }

        if let openIn = page.openIn {
            Section {
                NavigationLink(value: openIn.route) {
                    Text(openIn.title)
                        .foregroundStyle(Color.primary)
                }
            }
        }
    }
}
