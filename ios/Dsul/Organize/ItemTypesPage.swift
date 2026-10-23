import DsulCore
import SwiftUI

/// Organize's Item types page (O5, design §6.3): the user's own types in the
/// server's order, each with how many live items are of it ("2 items"), on a
/// tile in its slug's colour with the Shapes glyph. Read-only: the rows are
/// inert, and a type is made, renamed and deleted on the web. What shows is
/// `ShelfPageModel.itemTypesPage` (pinned by ShelfPageTests).
///
/// While Organize is off the web hides its types section, so the page is
/// gone (`isGone`): it takes itself off the stack, drawing what it last
/// showed while it slides away, as OrganizePageHost's pages do.
struct ItemTypesPageView: View {
    @Binding var path: [OrganizeRoute]

    @Environment(SamplePlanner.self) private var planner
    @State private var lastShown: ItemTypesPage? = nil

    var body: some View {
        let live = planner.itemTypesPage
        List {
            if let page = live ?? lastShown {
                Section {
                    ForEach(page.rows) { row in
                        TileRow(symbol: row.symbol, color: row.accent.color, title: row.title,
                                subtitle: row.subtitle, spokenLabel: row.spokenLabel)
                    }
                    if let empty = page.empty {
                        PageQuietText(text: empty)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .modifier(LiveRefresh(planner: planner))
        .plannerBanner()
        .navigationTitle(ShelfPageModel.itemTypesTitle)
        .navigationBarTitleDisplayMode(.large)
        .onChange(of: live, initial: true) { _, now in
            if let now {
                lastShown = now
            } else {
                path.removeAll { planner.isGone($0) }
            }
        }
    }
}
