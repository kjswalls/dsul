import SwiftUI

@main
struct DsulApp: App {
    @State private var planner = SamplePlanner()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(planner)
        }
    }
}
