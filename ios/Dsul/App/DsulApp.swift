import SwiftUI

/// The app: one AuthStore for its life (the Keychain read once, at launch),
/// and AppGate choosing the sign-in screen, the sample or the user's planner.
@main
struct DsulApp: App {
    @State private var auth = AuthStore.makeLive()

    var body: some Scene {
        WindowGroup {
            AppGate()
                .environment(auth)
        }
    }
}
