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
/// From O8a it carries the way back where the server takes the write:
/// "Resume now" for a routine, "Turn on now" for a season, the planner's
/// `turnOn(_:)` (the web's `setGateOn`), whatever the switches say, as on the
/// Paused list. The page pops itself once the entry is off the shelf (resumed
/// here or elsewhere, back on its day, or deleted), as a container's page
/// does when it goes.
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

    @Environment(SamplePlanner.self) private var planner

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

        if page.resume != nil || page.openIn != nil {
            Section {
                if let resume = page.resume {
                    Button {
                        withAnimation(.snappy) { planner.turnOn(resume.ref) }
                    } label: {
                        Label(resume.title, systemImage: "play")
                    }
                    // A list row's button takes the tint, the lime accent,
                    // which is a mark, never text.
                    .tint(Color.primary)
                }
                if let openIn = page.openIn {
                    NavigationLink(value: openIn.route) {
                        Text(openIn.title)
                            .foregroundStyle(Color.primary)
                    }
                }
            }
        }
    }
}
