import Foundation
import UIKit
import UserNotifications

/// What the app needs from UIKit's delegate, at launch and before any window
/// (a lock-screen Done can launch the app with none): the notification
/// delegate, the categories, the background re-plan, a re-plan whenever
/// the day or the zone changes under a running app, and the APNs token
/// (reminders Phase 3), asked for at every launch and never kept: it only
/// lets the server send what the phone cannot ring alone, and asks the user
/// nothing (the alert permission is still the Remind sheet's).
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
}

extension AuthStore: NotificationAccount {
    var signedInUserId: UUID? { session?.userId }
}
