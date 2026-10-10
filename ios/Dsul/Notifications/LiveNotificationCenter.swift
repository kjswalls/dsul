import DsulCore
import Foundation
import UserNotifications

/// UNUserNotificationCenter behind `NotificationCenterPort`: the one file the
/// scheduler's requests become real in. Each call reads or builds the
/// framework's objects inside a nonisolated step and hands back only plain
/// values, so nothing of UserNotifications crosses to the main actor.
///
/// The plan's triggers map one to one (`PlannedTrigger`): `calendar` to a
/// repeating UNCalendarNotificationTrigger on hour, minute and the weekday or
/// day when set; `at` to a one-off calendar trigger on the full date; `afterMs`
/// to a one-off interval trigger, `afterSeconds` from the moment of adding;
/// `now` to no trigger. Date components carry no zone, so they ring in the
/// device's, which is the zone the plan was made in. `summaryArgument` is not
/// set: iOS 15 stopped reading it, and grouping is the thread's.
@MainActor
final class LiveNotificationCenter: NotificationCenterPort {
    func permission() async -> NotificationPermission {
        return await Self.readPermission()
    }

    func requestPermission() async -> Bool {
        return await Self.askPermission()
    }

    func pending() async -> [PendingNotification] {
        return await Self.readPending()
    }

    func delivered() async -> [DeliveredNotification] {
        return await Self.readDelivered()
    }

    func add(_ notification: ScheduledNotification) async throws {
        try await Self.addRequest(notification)
    }

    func removePending(_ ids: [String]) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ids)
    }

    func removeDelivered(_ ids: [String]) {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
    }

    /// The badge stays at zero (dsul never sets one), and is put back there
    /// on every return to the app.
    static func clearBadge() async {
        try? await UNUserNotificationCenter.current().setBadgeCount(0)
    }

    // MARK: The framework's side

    nonisolated private static func readPermission() async -> NotificationPermission {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return .allowed
        case .notDetermined:
            return .notDetermined
        case .denied:
            return .denied
        @unknown default:
            return .denied
        }
    }

    nonisolated private static func askPermission() async -> Bool {
        let granted = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        return granted ?? false
    }

    nonisolated private static func readPending() async -> [PendingNotification] {
        let requests = await UNUserNotificationCenter.current().pendingNotificationRequests()
        return requests.map { request in
            let info = strings(request.content.userInfo)
            var next: Date? = nil
            var weekday: Int? = nil
            var day: Int? = nil
            if let calendar = request.trigger as? UNCalendarNotificationTrigger {
                next = calendar.nextTriggerDate()
                weekday = calendar.dateComponents.weekday
                day = calendar.dateComponents.day
                // A one-off on a full date has a day too; only a slot's
                // matters, and a slot never names its year.
                if calendar.dateComponents.year != nil { day = nil }
            } else if let interval = request.trigger as? UNTimeIntervalNotificationTrigger {
                next = interval.nextTriggerDate()
            }
            return PendingNotification(
                id: request.identifier,
                signature: info[NotificationKeys.signature],
                itemId: info["itemId"].flatMap(UUID.init(uuidString:)),
                at: info["at"],
                nextFireMs: next.map(NotificationScheduler.epochMs),
                repeats: request.trigger?.repeats ?? false,
                weekday: weekday,
                day: day
            )
        }
    }

    nonisolated private static func readDelivered() async -> [DeliveredNotification] {
        let notes = await UNUserNotificationCenter.current().deliveredNotifications()
        return notes.map { note in
            let info = strings(note.request.content.userInfo)
            return DeliveredNotification(id: note.request.identifier,
                                         deliveredAtMs: NotificationScheduler.epochMs(note.date),
                                         dateStr: info["dateStr"], at: info["at"])
        }
    }

    nonisolated private static func addRequest(_ notification: ScheduledNotification) async throws {
        let planned = notification.request
        let content = UNMutableNotificationContent()
        content.title = planned.title
        content.body = planned.body
        content.sound = .default
        content.threadIdentifier = planned.threadId
        content.categoryIdentifier = planned.categoryId
        content.interruptionLevel = .active
        content.relevanceScore = planned.relevance
        content.userInfo = notification.userInfo

        let trigger: UNNotificationTrigger?
        switch planned.trigger {
        case .calendar(let hour, let minute, let weekday, let day):
            var match = DateComponents()
            match.hour = hour
            match.minute = minute
            match.weekday = weekday
            match.day = day
            trigger = UNCalendarNotificationTrigger(dateMatching: match, repeats: true)
        case .at(let dateStr, let hhmm):
            guard let date = DayString(dateStr), let minutes = minutesOfDay(hhmm) else { return }
            var match = DateComponents()
            match.year = date.year
            match.month = date.month
            match.day = date.day
            match.hour = minutes / 60
            match.minute = minutes % 60
            trigger = UNCalendarNotificationTrigger(dateMatching: match, repeats: false)
        case .afterMs(let ms):
            let seconds = notification.afterSeconds ?? Double(ms) / 1000
            trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, seconds), repeats: false)
        case .now:
            trigger = nil
        }
        let request = UNNotificationRequest(identifier: planned.id, content: content, trigger: trigger)
        try await UNUserNotificationCenter.current().add(request)
    }

    /// userInfo's string values, as the plan writes them.
    nonisolated static func strings(_ userInfo: [AnyHashable: Any]) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in userInfo {
            if let key = key as? String, let value = value as? String { out[key] = value }
        }
        return out
    }
}

extension NotificationHub {
    /// The app's hub: the real center, state in UserDefaults, the outbox in
    /// Application Support, the production API (or a Debug override), and
    /// this install's device id.
    static let shared = NotificationHub(
        scheduler: NotificationScheduler(center: LiveNotificationCenter(), store: UserDefaultsSchedulerStore()),
        outbox: ActionOutbox(storage: FileOutboxStorage.standard()),
        makeAPI: { tokens in
            APIClient(origin: AppConfig.apiOrigin, tokens: tokens, transport: HTTP.live, deviceId: DeviceIdentity.id())
        },
        deviceId: DeviceIdentity.id()
    )
}
