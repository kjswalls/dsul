import SwiftUI

enum AppTab: Hashable {
    case today, ask, organize, search
}

/// Today, Ask and Organize, plus the system Search tab, with the capture bar
/// as the tab view's bottom accessory everywhere but Ask (whose composer
/// takes its place).
struct RootView: View {
    @Environment(SamplePlanner.self) private var planner
    @State private var tab: AppTab = .today
    @State private var showCapture = false
    @AppStorage(TodayLayout.storageKey) private var layout: TodayLayout = .list

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
        .tabViewBottomAccessory(isEnabled: tab != .ask) {
            CaptureBar(count: planner.braindump.count, onCapture: { showCapture = true }, onTray: openTray)
        }
        .sheet(isPresented: $showCapture) {
            CaptureSheet()
                .environment(planner)
        }
    }

    /// The tray count: Today, on Schedule, with the braindump sheet over it.
    private func openTray() {
        tab = .today
        layout = .schedule
        planner.showBraindumpSheet = true
    }
}
