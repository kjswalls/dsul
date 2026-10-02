import DsulCore
import SwiftUI

/// Today: one day in three layouts, List, Buckets and Schedule (G board).
/// The title is the day; a tap on it picks another. The layout capsule and
/// the avatar sit top right. Day only for now: Week comes later. The
/// planner's banner ("Signed in as …", a write that didn't save) shows over
/// the top for a few seconds.
struct TodayView: View {
    @Environment(SamplePlanner.self) private var planner
    @AppStorage(TodayLayout.storageKey) private var layout: TodayLayout = .list
    @State private var showProbe = false

    var body: some View {
        NavigationStack {
            TimelineView(.everyMinute) { context in
                content(nowMin: planner.minuteOfDay(context.date))
            }
            .overlay(alignment: .top) {
                if let banner = planner.banner {
                    BannerView(banner: banner) {
                        planner.dismissBanner(banner.id)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 4)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.snappy, value: planner.banner)
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

/// The avatar circle: the account (the email and Sign out), or on the sample
/// a way back to the sign-in screen, then the drag spike's switches. "Load
/// 40 blocks" is sample only: its blocks exist nowhere on the server.
private struct AvatarMenu: View {
    @Binding var showProbe: Bool

    @Environment(SamplePlanner.self) private var planner
    @Environment(AuthStore.self) private var auth
    @AppStorage(TodayLayout.storageKey) private var layout: TodayLayout = .list

    var body: some View {
        Menu {
            if planner.isLive {
                Section(auth.email ?? "Signed in") {
                    Button(role: .destructive) {
                        let store = auth
                        Task { await store.signOut() }
                    } label: {
                        Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                }
            } else {
                Section("Sample data") {
                    Button("Leave sample data", systemImage: "rectangle.portrait.and.arrow.right") {
                        auth.leaveSample()
                    }
                }
            }
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
        } label: {
            Text(planner.isLive ? AccountFormat.initials(auth.email) : "KI")
                .font(.caption.weight(.semibold))
                .frame(width: 30, height: 30)
                .background(Circle().fill(Color(.tertiarySystemFill)))
        }
        .accessibilityLabel("Account")
    }
}

enum AccountFormat {
    /// "KF" for kirby.fox@…, "KI" for kirby@…: the first letters of the first
    /// two words of the address's local part, or its first two letters.
    static func initials(_ email: String?) -> String {
        guard let email, let local = email.split(separator: "@").first else { return "?" }
        let words = local.split(whereSeparator: { !$0.isLetter })
        let letters: [Character]
        if words.count >= 2 {
            letters = words.prefix(2).compactMap { $0.first }
        } else {
            letters = Array(local.filter { $0.isLetter }.prefix(2))
        }
        let text = String(letters).uppercased()
        return text.isEmpty ? "?" : text
    }
}

/// The planner's banner: it goes by itself after a few seconds
/// (`SamplePlanner.show`), and a tap dismisses it sooner. Over Today, and over
/// an item's sheet, which would otherwise hide a write the server refused.
struct BannerView: View {
    var banner: PlannerBanner
    var onDismiss: () -> Void

    var body: some View {
        Button(action: onDismiss) {
            HStack(spacing: 8) {
                Image(systemName: banner.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(banner.isError ? Color.orange : Color.accentColor)
                Text(banner.text)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.primary)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        // Not `.plain`, whose press fades the lime tick.
        .buttonStyle(PressScaleStyle(scale: 0.97))
        .accessibilityHint("Dismisses the message")
    }
}
