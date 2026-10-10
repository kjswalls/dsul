import Foundation
import UIKit
import UserNotifications

/// What the app needs from UIKit's delegate, at launch and before any window
/// (a lock-screen Done can launch the app with none): the notification
/// delegate, the categories, the background re-plan, and a re-plan whenever
/// the day or the zone changes under a running app.
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
        return true
    }
}

extension AuthStore: NotificationAccount {
    var signedInUserId: UUID? { session?.userId }
}
