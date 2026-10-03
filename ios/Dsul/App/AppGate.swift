import SwiftUI
import UIKit

/// Which planner the app shows: none on the sign-in screen, the sample after
/// "Try with sample data", and the signed-in user's own once there is a
/// session. Keyed on `AuthStore.gateKey`, so a token refresh changes nothing
/// here, and signing in as someone else builds a new planner rather than
/// letting the last user's items show for a frame.
///
/// RootView and everything under it keep reading `SamplePlanner` from the
/// environment, as they did when the sample was all there was.
struct AppGate: View {
    @Environment(AuthStore.self) private var auth
    @Environment(\.scenePhase) private var scenePhase
    @State private var planner: SamplePlanner? = nil

    var body: some View {
        content
            .onChange(of: auth.gateKey, initial: true) { _, _ in
                reconcile()
            }
            // Back in front: a fetch, unless the last one is under a minute
            // old (PlannerSync). RootView moves `today` on the same change.
            // The icon is asked again too, in case iOS refused it last time.
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                planner?.refreshIfStale()
                AppIconSwitcher.shared.follow(planner?.settings.appIcon)
            }
            // The home-screen icon follows the App icon pick, which arrives
            // with each fetch. Nil (the sample, or nothing loaded yet) leaves
            // it alone.
            .onChange(of: planner?.settings.appIcon) { _, pick in
                AppIconSwitcher.shared.follow(pick)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch auth.state {
        case .signedOut, .signingIn:
            SignInView()
        case .signedIn, .sample:
            if let planner {
                RootView()
                    .environment(planner)
            } else {
                // One frame, until `reconcile` has built the planner.
                Color(.systemBackground)
                    .ignoresSafeArea()
            }
        }
    }

    /// Builds, keeps or drops the planner to match the auth state.
    private func reconcile() {
        switch auth.state {
        case .signedIn(let session):
            if let current = planner, current.userId == session.userId { return }
            planner?.stopSync()
            let api = APIClient(origin: AppConfig.apiOrigin, tokens: auth, transport: HTTP.live)
            let live = SamplePlanner(userId: session.userId, api: api, isDragging: { DragHold.shared.isHeld },
                                     backgroundTime: .uiApplication)
            if let email = auth.takeWelcome() {
                live.show(email.isEmpty ? "Signed in" : "Signed in as \(email)", isError: false)
            }
            planner = live
            Task { await live.refresh() }
        case .sample:
            if let current = planner, !current.isLive { return }
            planner?.stopSync()
            planner = SamplePlanner()
        case .signedOut, .signingIn:
            planner?.stopSync()
            planner = nil
        }
    }
}

extension BackgroundTime {
    /// iOS's own: `beginBackgroundTask`, which keeps the app running for about
    /// half a minute after it leaves the screen, so the writes PlannerSync has
    /// out finish (a title saved on the way out, a delete just before a swipe
    /// home). iOS calls the expiry handler on the main thread when the time is
    /// up, and the task must end there and then, so it runs synchronously
    /// rather than in a Task.
    static let uiApplication = BackgroundTime(
        begin: { name, expired in
            let id = UIApplication.shared.beginBackgroundTask(withName: name) {
                MainActor.assumeIsolated { expired() }
            }
            return id.rawValue
        },
        end: { token in
            let id = UIBackgroundTaskIdentifier(rawValue: token)
            // iOS answers `.invalid` when it won't give the time; there is
            // nothing to end then.
            guard id != .invalid else { return }
            UIApplication.shared.endBackgroundTask(id)
        }
    )
}
