import SwiftUI

/// The app: one AuthStore for its life (the Keychain read once, at launch),
/// and AppGate choosing the sign-in screen, the sample or the user's planner.
/// An emailed sign-in link reaches the app as `app.dsul.ios://auth/callback`
/// (a cold launch included); everything about it is decided in AuthStore.
@main
struct DsulApp: App {
    @State private var auth = AuthStore.makeLive()

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
