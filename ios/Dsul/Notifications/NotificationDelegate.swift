import Foundation
import UserNotifications

/// UNUserNotificationCenter's delegate, set at launch (AppDelegate), so a
/// button pressed while the app isn't running reaches it. It only translates:
/// each notification becomes a `NotificationInfo` here, and NotificationHub
/// decides.
///
/// - **willPresent**: in front, a dsul notification shows only if it still
///   wants doing as the planner holds it now (`shouldPresent`). With no
///   planner up, it shows.
/// - **didReceive**: Done and Snooze go to the hub, which writes them to the
///   outbox before anything else; a tap on the notification opens its item.
///   iOS keeps the app awake until this returns.
///
/// A pushed last call about one item counts as dsul's whatever identifier
/// iOS gave it (`NotificationKeys.identity`), so its Done and Snooze work too.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {
    /// Held here: the center keeps its delegate weakly.
    static let shared = NotificationDelegate()

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        let info = Self.info(notification)
        let show = await NotificationHub.shared.shouldPresent(info)
        return show ? [.banner, .list, .sound] : []
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let info = Self.info(response.notification)
        let action: NotificationAction
        switch response.actionIdentifier {
        case NotificationKeys.doneAction:
            action = .done
        case NotificationKeys.snoozeAction:
            action = .snooze
        case UNNotificationDefaultActionIdentifier:
            action = .open
        default:
            action = .dismiss
        }
        await NotificationHub.shared.handle(action, info)
    }

    nonisolated private static func info(_ notification: UNNotification) -> NotificationInfo {
        let request = notification.request
        let userInfo = LiveNotificationCenter.strings(request.content.userInfo)
        let id = NotificationKeys.identity(of: request.identifier,
                                           pushed: request.trigger is UNPushNotificationTrigger,
                                           userInfo: userInfo)
        return NotificationInfo(id: id, userInfo: userInfo,
                                date: notification.date, title: request.content.title,
                                body: request.content.body)
    }
}
