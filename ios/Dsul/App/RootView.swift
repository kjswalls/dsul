import Combine
import SwiftUI

enum AppTab: Hashable {
    case today, ask, organize, search
}

/// Today, Ask and Organize, plus the system Search tab, with the capture bar
/// as the tab view's bottom accessory everywhere but Ask (whose composer
/// takes its place).
///
/// The capture, date and item sheets are one `PlannerSheet` on the planner.
/// RootView presents it unless the braindump sheet is up; then the braindump
/// sheet presents it, stacked (ScheduleView), because nothing under a sheet can
/// present another one.
struct RootView: View {
    @Environment(SamplePlanner.self) private var planner
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab: AppTab = .today
    @AppStorage(TodayLayout.storageKey) private var layout: TodayLayout = .list

    var body: some View {
        @Bindable var planner = planner
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
            CaptureBar(count: planner.braindump.count, onCapture: { planner.activeSheet = .capture },
                       onTray: openTray)
        }
        .sheet(item: $planner.sheetOverApp) { sheet in
            PlannerSheetContent(sheet: sheet)
                .environment(planner)
        }
        // Today moves at midnight in the user's stored zone (the device's
        // when there is none) and when the app comes back to the front.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { planner.refreshToday() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)
            .receive(on: DispatchQueue.main)) { _ in
            planner.refreshToday()
        }
        // Keyed on the planner, so a new one (sign-in, the sample) gets its
        // own check.
        .task(id: ObjectIdentifier(planner)) {
            await keepTodayCurrent()
        }
    }

    /// `NSCalendarDayChanged` fires at the DEVICE's midnight, but the user's
    /// day turns at their stored zone's, which can be any hour here. A check
    /// a minute covers it: `refreshToday` does nothing until the day changes.
    /// Ends when the view goes or the planner changes (the task is cancelled
    /// and the sleep throws).
    private func keepTodayCurrent() async {
        while (try? await Task.sleep(for: .seconds(60))) != nil {
            planner.refreshToday()
        }
    }

    /// The tray count: Today, on Schedule, with the braindump sheet over it.
    private func openTray() {
        tab = .today
        layout = .schedule
        planner.showBraindumpSheet = true
    }
}

/// A `PlannerSheet`'s content, for whichever host presents it.
struct PlannerSheetContent: View {
    var sheet: PlannerSheet

    var body: some View {
        switch sheet {
        case .capture:
            CaptureSheet()
        case .datePicker:
            DatePickerSheet()
        case .item(let id, let day):
            ItemSheet(id: id, day: day)
        }
    }
}
