import DsulCore
import UIKit

/// What the switcher needs from UIApplication, so a test can stand in for it.
@MainActor
protocol AlternateIconHost: AnyObject {
    var supportsAlternateIcons: Bool { get }
    var alternateIconName: String? { get }
    func setAlternateIconName(_ name: String?) async throws
}

/// The real one: UIApplication.shared.
@MainActor
final class SystemIconHost: AlternateIconHost {
    var supportsAlternateIcons: Bool { UIApplication.shared.supportsAlternateIcons }
    var alternateIconName: String? { UIApplication.shared.alternateIconName }

    func setAlternateIconName(_ name: String?) async throws {
        try await UIApplication.shared.setAlternateIconName(name)
    }
}

/// Makes the home-screen icon follow the App icon pick (Settings → Look on
/// the web, user_settings.app_icon), which arrives with each planner fetch.
///
/// iOS shows an alert each time the icon changes and refuses the change while
/// the app is in the background, so the switcher asks only when the pick
/// differs from the icon showing (`AppIcon.change`), and only from AppGate,
/// whose fetches and foreground hook run with the app in front. A refused
/// change is tried again the next time the app comes to the front.
///
/// One change at a time: two fetches landing close together can't send two
/// requests that finish out of order. The pick that arrives while a change is
/// running is the one made next; the ones in between are skipped.
@MainActor
final class AppIconSwitcher {
    static let shared = AppIconSwitcher(host: SystemIconHost())

    private let host: AlternateIconHost
    /// The latest pick not yet made.
    private var wanted: AppIcon?
    private var running: Task<Void, Never>?

    init(host: AlternateIconHost) {
        self.host = host
    }

    /// Follows `pick`. Nil (never chosen, the sample, or not loaded yet)
    /// leaves the icon as it is.
    func follow(_ pick: AppIcon?) {
        guard let pick else { return }
        wanted = pick
        guard running == nil else { return }
        running = Task { [weak self] in
            await self?.drain()
        }
    }

    /// For tests: waits for the change in flight, if any.
    func settle() async {
        await running?.value
    }

    private func drain() async {
        while let pick = wanted {
            wanted = nil
            guard host.supportsAlternateIcons,
                  let change = AppIcon.change(to: pick, from: host.alternateIconName)
            else { continue }
            do {
                try await host.setAlternateIconName(change.alternateIconName)
            } catch {
                // Refused (the app left the front, or the set is missing). The
                // next foreground follows the pick again.
            }
        }
        running = nil
    }
}
