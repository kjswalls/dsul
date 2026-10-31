import DsulCore
import UserNotifications

/// The category (memory/plans/reminders-platforms.md §5.3), registered at
/// every launch: a cue's (`DSUL_CUE`) with Done and Snooze. The end of day
/// review's (`DSUL_EOD`) went with the review (ghost rows phase 3); setting
/// the list replaces the old one. Both buttons are background actions without
/// `authenticationRequired`: Done from the lock screen is the feature, and
/// the tap waits in the outbox, which is readable while the phone is locked.
enum NotificationCategories {
    static func register() {
        let done = UNNotificationAction(identifier: NotificationKeys.doneAction, title: NotificationKeys.doneTitle,
                                        options: [])
        let snooze = UNNotificationAction(identifier: NotificationKeys.snoozeAction,
                                          title: NotificationKeys.snoozeTitle, options: [])
        let cue = UNNotificationCategory(identifier: cueCategory, actions: [done, snooze], intentIdentifiers: [],
                                         options: [])
        UNUserNotificationCenter.current().setNotificationCategories([cue])
    }
}
