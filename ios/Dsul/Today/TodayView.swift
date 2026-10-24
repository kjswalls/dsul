import DsulCore
import SwiftUI

/// Today: one day, or its week, in three layouts, List, Buckets and Schedule
/// (G board). The title is the day (or the week); a tap on it picks another
/// day, and the week is that day's. The layout capsule and the avatar sit top
/// right; the capsule's menu holds Day and Week, on every layout since Week ×
/// Schedule (design PR 10). The planner's banner ("Signed in as …", a write
/// that didn't save) shows over the top for a few seconds.
struct TodayView: View {
    @Environment(SamplePlanner.self) private var planner
    @AppStorage(TodayLayout.storageKey) private var layout: TodayLayout = .list
    /// Day or Week, device-local, never the web's `default_view`.
    @AppStorage(TodayScope.storageKey) private var scope: TodayScope = .day
    @State private var showProbe = false

    /// What Today draws: the stored scope where the layout has a week form,
    /// else Day. The title and the content read this one value.
    private var effectiveScope: TodayScope { layout.effectiveScope(scope) }

    var body: some View {
        NavigationStack {
            TimelineView(.everyMinute) { context in
                content(nowMin: planner.minuteOfDay(context.date))
            }
            // The banner over the top ("Signed in as …", a write that didn't
            // save), as on Organize.
            .plannerBanner()
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    TodayTitle(layout: layout, scope: effectiveScope)
                }
                .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .topBarTrailing) {
                    LayoutSwitcher(layout: $layout, scope: $scope)
                }
                ToolbarSpacer(.fixed, placement: .topBarTrailing)
                ToolbarItem(placement: .topBarTrailing) {
                    AvatarMenu {
                        // The drag spike's switches. "Load 40 blocks" is
                        // sample only: its blocks exist nowhere on the server.
                        Section("Drag spike") {
                            Toggle(isOn: $showProbe) {
                                Label("Drag probe", systemImage: "waveform.path.ecg")
                            }
                            if !planner.isLive {
                                Button("Load 40 blocks", systemImage: "square.stack") {
                                    layout = .schedule
                                    planner.stress()
                                }
                            }
                        }
                    }
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
        switch (layout, effectiveScope) {
        case (.list, .day):
            ListLayout(nowMin: nowMin)
        case (.list, .week):
            WeekList(nowMin: nowMin, openDay: { openDay($0) })
        case (.buckets, .day):
            BucketsLayout(nowMin: nowMin)
        case (.buckets, .week):
            WeekBuckets(nowMin: nowMin, openDay: { openDay($0) })
        case (.schedule, let shown):
            // One view for both, so the braindump sheet, the drag and the
            // hours' scroll carry across the Day/Week switch.
            ScheduleView(showProbe: showProbe, nowMin: nowMin, scope: shown, openDay: { openDay($0) })
        }
    }

    /// A week day's heading: that day in Day, on the same layout (W7).
    private func openDay(_ day: DayString) {
        withAnimation(.snappy) {
            planner.select(day)
            scope = .day
        }
    }
}

/// "Today" (or the date) over "Tue, Sep 29 · List"; in Week, "This week" (or
/// "Week of Oct 26") over "Oct 19 – 25 · List". A tap opens the date picker
/// (a `PlannerSheet`, so it shows over the braindump sheet too); off today,
/// or in Week off today's week, a Today button jumps back.
private struct TodayTitle: View {
    var layout: TodayLayout
    /// The scope Today draws (`effectiveScope`), never the stored one.
    var scope: TodayScope

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 10) {
            Button {
                planner.activeSheet = .datePicker
            } label: {
                VStack(alignment: .leading, spacing: 0) {
                    Text(title)
                        .font(.headline)
                        .foregroundStyle(Color.primary)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(Color.secondary)
                }
                .fixedSize()
            }
            .buttonStyle(.plain)
            .modifier(WeekTitleLabel(label: spokenWeek))
            .accessibilityHint("Picks another day")

            if showsToday {
                Button("Today") {
                    // No slide under Reduce Motion (design §5.10).
                    withAnimation(reduceMotion ? nil : .snappy) { planner.goToToday() }
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.small)
                // A bordered button takes the tint for its words and fill,
                // and the tint is the lime accent, which is a mark, never text.
                .tint(Color.primary)
            }
        }
    }

    /// The selected day's week's first day, by the user's Week starts on.
    private var weekStart: DayString {
        return weekStartOf(planner.selectedDay, planner.settings.weekStartDay)
    }

    private var title: String {
        switch scope {
        case .day:
            return PlannerFormat.title(selected: planner.selectedDay, today: planner.today)
        case .week:
            return PlannerFormat.weekTitle(start: weekStart, today: planner.today,
                                           weekStart: planner.settings.weekStartDay)
        }
    }

    private var subtitle: String {
        switch scope {
        case .day:
            return PlannerFormat.subtitle(selected: planner.selectedDay, layout: layout)
        case .week:
            return PlannerFormat.weekSubtitle(start: weekStart, today: planner.today, layout: layout)
        }
    }

    /// Week's title as VoiceOver says it, "This week, October 19 to 25,
    /// List"; nil in Day, whose two lines read well as they are.
    private var spokenWeek: String? {
        guard scope == .week else { return nil }
        return title + ", " + PlannerFormat.spokenWeekRange(start: weekStart, today: planner.today) + ", "
            + layout.title
    }

    /// Off today in Day; in Week, only when the week doesn't hold today.
    private var showsToday: Bool {
        switch scope {
        case .day: return !planner.isOnToday
        case .week: return !planner.isOnTodaysWeek
        }
    }
}

/// The title's spoken label in Week; Day keeps the button's own reading.
private struct WeekTitleLabel: ViewModifier {
    var label: String?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let label {
            content.accessibilityLabel(Text(label))
        } else {
            content
        }
    }
}
