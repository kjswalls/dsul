import Combine
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
///
/// A Sign in with Apple session's Apple ID is asked about at launch, on every
/// return to the front and when Apple says a credential was revoked
/// (`AuthStore.checkAppleCredential`), so a revoked or changed Apple ID signs
/// this phone out.
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
                if phase == .background {
                    BackgroundRefresh.schedule()
                    return
                }
                guard phase == .active else { return }
                planner?.refreshIfStale()
                Task {
                    await LiveNotificationCenter.clearBadge()
                    await NotificationHub.shared.foreground()
                }
                AppIconSwitcher.shared.follow(planner?.settings.appIcon)
                let store = auth
                Task { await store.checkAppleCredential() }
            }
            // Sign in with Apple: asked at launch and, above, on every return;
            // Apple's notification names no user, so it asks too rather than
            // signing out blind. Unstructured, like the other two: a modifier
            // on `content` follows its branch, and the swap a sign-out causes
            // would cancel the logout mid-request. (It may run again on each
            // swap: one more local ask, and nothing without an Apple session.)
            .task {
                let store = auth
                Task { await store.checkAppleCredential() }
            }
            .onReceive(NotificationCenter.default.publisher(for: AppleAuthorization.revokedNotification)
                .receive(on: DispatchQueue.main)) { _ in
                let store = auth
                Task { await store.checkAppleCredential() }
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

    /// Builds, keeps or drops the planner to match the auth state, and hands
    /// the signed-in one to the notification hub. Signing out, switching
    /// user or trying the sample clears every dsul notification on this
    /// iPhone, and the taps still waiting in the outbox.
    private func reconcile() {
        let hub = NotificationHub.shared
        switch auth.state {
        case .signedIn(let session):
            if let current = planner, current.userId == session.userId { return }
            let switching = planner?.isLive == true
            planner?.stopSync()
            let api = APIClient(origin: AppConfig.apiOrigin, tokens: auth, transport: HTTP.live)
            let live = SamplePlanner(userId: session.userId, api: api, isDragging: { DragHold.shared.isHeld },
                                     backgroundTime: .uiApplication)
            if let email = auth.takeWelcome() {
                live.show(email.isEmpty ? "Signed in" : "Signed in as \(email)", isError: false)
            }
            planner = live
            Task {
                if switching { await hub.detach() }
                hub.attach(live)
            }
            Task { await live.refresh() }
        case .sample:
            if let current = planner, !current.isLive { return }
            planner?.stopSync()
            planner = SamplePlanner()
            Task { await hub.detach() }
        case .signedOut, .signingIn:
            let wasLive = planner?.isLive == true
            planner?.stopSync()
            planner = nil
            if wasLive || auth.state == .signedOut {
                Task { await hub.detach() }
            }
        }
    }
}

extension BackgroundTime {
    /// iOS's own: `beginBackgroundTask`, which keeps the app running for about
    /// half a minute after it leaves the screen, so the writes PlannerSync has
    /// out finish (a title saved on the way out, a delete just before a swipe
    /// home). `UIKitBackgroundTasks` holds what is begun and not yet ended.
    static let uiApplication = BackgroundTime(
        begin: { name, expired in
            UIKitBackgroundTasks.shared.begin(name, expired: expired)
        },
        end: { token in
            UIKitBackgroundTasks.shared.end(token)
        }
    )
}

/// The background tasks begun and not yet ended, by a token of our own, so
/// each is ended exactly once. iOS calls the expiry handler on the main thread
/// when the time is up, and the task must be ended there and then (it runs
/// synchronously rather than in a Task): the owner is told (`expired`), and
/// the handler ends the task itself if the owner didn't, since an owner gone
/// by then (a sync dropped with writes queued) would leave it running and iOS
/// would kill the app.
@MainActor
private final class UIKitBackgroundTasks {
    static let shared = UIKitBackgroundTasks()

    private var nextToken = 0
    private var live: [Int: UIBackgroundTaskIdentifier] = [:]

    func begin(_ name: String, expired: @escaping @MainActor @Sendable () -> Void) -> Int {
        nextToken += 1
        let token = nextToken
        let id = UIApplication.shared.beginBackgroundTask(withName: name) {
            MainActor.assumeIsolated {
                expired()
                UIKitBackgroundTasks.shared.end(token)
            }
        }
        // iOS answers `.invalid` when it won't give the time; there is
        // nothing to end then.
        if id != .invalid { live[token] = id }
        return token
    }

    func end(_ token: Int) {
        guard let id = live.removeValue(forKey: token) else { return }
        UIApplication.shared.endBackgroundTask(id)
    }
}
