import SwiftUI
import UIKit

/// The app: one AuthStore for its life (the Keychain read once, at launch),
/// and AppGate choosing the sign-in screen, the sample or the user's planner.
/// An emailed sign-in link reaches the app as `app.dsul.ios://auth/callback`
/// (a cold launch included); everything about it is decided in AuthStore.
@main
struct DsulApp: App {
    @State private var auth = AuthStore.makeLive()

    init() {
        // A confirm (the item sheet's Delete) is a UIAlertController under
        // SwiftUI's `confirmationDialog`, and its Cancel takes the window's
        // tint, which is the lime accent (about 1.5:1 on white), never a
        // view's `.tint`. The label colour instead, set once at launch,
        // before any dialog is built. Delete itself stays the system red.
        UIView.appearance(whenContainedInInstancesOf: [UIAlertController.self]).tintColor = .label
    }

    var body: some Scene {
        WindowGroup {
            AppGate()
                .environment(auth)
                .onOpenURL { url in
                    let store = auth
                    Task { await store.handleOpenURL(url) }
                }
        }
    }
}
