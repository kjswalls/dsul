import SwiftUI

/// Today, Schedule layout only for now. List and Buckets, Day/Week and the
/// layout switcher come in the next PR.
struct TodayView: View {
    @Environment(SamplePlanner.self) private var planner
    @State private var showProbe = false

    var body: some View {
        NavigationStack {
            ScheduleView(showProbe: showProbe)
                .navigationTitle("Today")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Drag probe", systemImage: "waveform.path.ecg") { showProbe.toggle() }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Braindump", systemImage: "tray.full") { planner.showBraindumpSheet = true }
                    }
                }
        }
    }
}
