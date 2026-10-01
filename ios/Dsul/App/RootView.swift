import SwiftUI

enum AppTab: Hashable {
    case today, ask, organize, search
}

/// Today, Ask and Organize, plus the system Search tab. The capture bar
/// (tabViewBottomAccessory) and the layout switcher come in the next PR;
/// this one is the shell around the drag spike.
struct RootView: View {
    @State private var tab: AppTab = .today

    var body: some View {
        TabView(selection: $tab) {
            Tab("Today", systemImage: "sun.max", value: AppTab.today) {
                TodayView()
            }
            Tab("Ask", systemImage: "sparkles", value: AppTab.ask) {
                AskView()
            }
            Tab("Organize", systemImage: "square.stack.3d.up", value: AppTab.organize) {
                OrganizeView()
            }
            Tab(value: AppTab.search, role: .search) {
                SearchView()
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
    }
}
