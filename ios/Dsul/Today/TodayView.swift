import DsulCore
import SwiftUI

/// Today: one day in three layouts, List, Buckets and Schedule (G board).
/// The title is the day; a tap on it picks another. The layout capsule and
/// the avatar sit top right. Day only for now: Week comes later.
struct TodayView: View {
    @Environment(SamplePlanner.self) private var planner
    @AppStorage(TodayLayout.storageKey) private var layout: TodayLayout = .list
    @State private var showProbe = false

    var body: some View {
        NavigationStack {
            TimelineView(.everyMinute) { context in
                content(nowMin: Self.minuteOfDay(context.date))
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    TodayTitle(layout: layout)
                }
                .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .topBarTrailing) {
                    LayoutSwitcher(layout: $layout)
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
                ToolbarItem(placement: .topBarTrailing) {
                    AvatarMenu(showProbe: $showProbe)
                }
            }
        }
        .onChange(of: layout) { _, newLayout in
            // The braindump sheet belongs to Schedule; leaving it closes the sheet.
            if newLayout != .schedule {
                planner.showBraindumpSheet = false
            }
        }
    }

    @ViewBuilder
    private func content(nowMin: Int) -> some View {
        switch layout {
        case .list:
            ListLayout(nowMin: nowMin)
        case .buckets:
            BucketsLayout(nowMin: nowMin)
        case .schedule:
            ScheduleView(showProbe: showProbe)
        }
    }

    private static func minuteOfDay(_ date: Date) -> Int {
        let c = Calendar.current.dateComponents([.hour, .minute], from: date)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }
}

/// "Today" (or the date) over "Tue, Sep 29 · List". A tap opens the date
/// picker (a `PlannerSheet`, so it shows over the braindump sheet too); off
/// today, a Today button jumps back.
private struct TodayTitle: View {
    var layout: TodayLayout

    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        HStack(spacing: 10) {
            Button {
                planner.activeSheet = .datePicker
            } label: {
                VStack(alignment: .leading, spacing: 0) {
                    Text(PlannerFormat.title(selected: planner.selectedDay, today: planner.today))
                        .font(.headline)
                        .foregroundStyle(Color.primary)
                    Text(PlannerFormat.subtitle(selected: planner.selectedDay, layout: layout))
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                }
                .fixedSize()
            }
            .buttonStyle(.plain)
            .accessibilityHint("Picks another day")

            if !planner.isOnToday {
                Button("Today") {
                    withAnimation(.snappy) { planner.goToToday() }
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
            }
        }
    }
}

/// The avatar circle. Until sign-in it holds the debug switches, including
/// the drag probe the on-device spike reads.
private struct AvatarMenu: View {
    @Binding var showProbe: Bool

    @Environment(SamplePlanner.self) private var planner
    @AppStorage(TodayLayout.storageKey) private var layout: TodayLayout = .list

    var body: some View {
        Menu {
            Section("Drag spike") {
                Toggle(isOn: $showProbe) {
                    Label("Drag probe", systemImage: "waveform.path.ecg")
                }
                Button("Load 40 blocks", systemImage: "square.stack") {
                    layout = .schedule
                    planner.stress()
                }
            }
        } label: {
            Text("KI")
                .font(.caption.weight(.semibold))
                .frame(width: 30, height: 30)
                .background(Circle().fill(Color(.tertiarySystemFill)))
        }
        .accessibilityLabel("Account")
    }
}
