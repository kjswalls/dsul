import Foundation
import UIKit
import UserNotifications

/// What the app needs from UIKit's delegate, at launch and before any window
/// (a lock-screen Done can launch the app with none): the notification
/// delegate, the categories, the background re-plan, a re-plan whenever
/// the day or the zone changes under a running app or the server wakes it,
/// and the APNs token (reminders Phase 3), asked for at every launch and
/// never kept: it only lets the server send what the phone cannot ring
/// alone, and asks the user nothing (the alert permission is still the
/// Remind sheet's).
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil)
        -> Bool {
        UNUserNotificationCenter.current().delegate = NotificationDelegate.shared
        NotificationCategories.register()
        BackgroundRefresh.register()
        for name in [Notification.Name.NSCalendarDayChanged, UIApplication.significantTimeChangeNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated {
                    NotificationHub.shared.requestPlan()
                }
            }
        }
        application.registerForRemoteNotifications()
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = PushToken(deviceToken: deviceToken)
        MainActor.assumeIsolated {
            NotificationHub.shared.pushTokenArrived(token)
        }
    }

    /// No token (no network, the simulator, a build without the push
    /// entitlement): the phone stays `transport 'none'`, and its own triggers
    /// ring as before.
    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: any Error) {}

    /// The server's silent wake (reminders PR-3c, lib/devices/wake.ts): an
    /// item changed on another device, so fetch the planner and re-plan, the
    /// same pass the background refresh runs. iOS gives it about 30 seconds,
    /// sends at most a couple an hour, and none to an app the user force-quit.
    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        guard NotificationKeys.isWake(userInfo) else { return .noData }
        return await NotificationHub.shared.backgroundRefresh() ? .newData : .failed
    }
}

extension AuthStore: NotificationAccount {
    var signedInUserId: UUID? { session?.userId }
}
