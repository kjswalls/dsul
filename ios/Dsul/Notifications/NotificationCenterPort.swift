import DsulCore
import Foundation

// What the scheduler needs of UNUserNotificationCenter, in its own terms, so
// NotificationScheduler and NotificationHub stay Foundation-only and their
// tests run against a fake (FakeNotificationCenter in the tests). The one
// real adapter is LiveNotificationCenter.swift, the only file here that
// imports UserNotifications.

/// The words and numbers a notification carries that both sides read: the
/// category and action ids (memory/plans/reminders-platforms.md §5.3), and the
/// userInfo keys the plan writes (`PlannedUserInfo.dictionary`) plus the
/// scheduler's own signature.
enum NotificationKeys {
    /// The Done button: ticks the item on the day the cue is about.
    static let doneAction = "done"
    /// The Snooze button: rings again in `snoozeMinutes`.
    static let snoozeAction = "snooze"
    /// The button's words, the web's push action titles
    /// (lib/reminders/channels/push.ts).
    static let doneTitle = "Done"
    static var snoozeTitle: String { "Snooze \(snoozeMinutes)m" }
    /// SNOOZE_MINUTES in lib/reminders/channels/push.ts: what the button
    /// promises, and what the `snooze` intent is sent.
    static let snoozeMinutes = 15
    /// userInfo: the request's signature (`ScheduledNotification.signature`),
    /// so a re-plan leaves a request that would be added unchanged alone.
    static let signature = "sig"
    /// Every identifier dsul owns starts with this; nothing else is ever
    /// removed.
    static let prefix = "dsul-"

    static func isDsul(_ id: String) -> Bool { id.hasPrefix(prefix) }
}

/// Whether this iPhone lets dsul notify. `provisional` and `ephemeral` are
/// never asked for, but a phone can hold them (granted by another build), and
/// both deliver, so both count as allowed.
enum NotificationPermission: Sendable, Hashable {
    case notDetermined
    case denied
    case allowed

    var canNotify: Bool { self == .allowed }
}

/// A request as the center holds it: its identifier, the signature it was
/// added with (nil for one added by an older build), what its userInfo says
/// it is about, and when it next rings.
struct PendingNotification: Sendable, Hashable {
    var id: String
    var signature: String?
    var itemId: UUID?
    /// The cue's "HH:mm" (`PlannedUserInfo.at`), nil for the review.
    var at: String?
    /// The trigger's next ring, epoch ms; nil when the center can't say.
    var nextFireMs: Int?
    /// Whether the trigger repeats (a calendar slot).
    var repeats: Bool
    /// The calendar slot's weekday (1 = Sunday … 7 = Saturday) or day of the
    /// month, when it has one: which days a repeating trigger rings on.
    var weekday: Int?
    var day: Int?

    init(id: String, signature: String? = nil, itemId: UUID? = nil, at: String? = nil, nextFireMs: Int? = nil,
         repeats: Bool = false, weekday: Int? = nil, day: Int? = nil) {
        self.id = id
        self.signature = signature
        self.itemId = itemId
        self.at = at
        self.nextFireMs = nextFireMs
        self.repeats = repeats
        self.weekday = weekday
        self.day = day
    }
}

/// A notification in the shade (`getDeliveredNotifications`).
struct DeliveredNotification: Sendable, Hashable {
    var id: String
    var deliveredAtMs: Int
    /// The userInfo's `dateStr` and `at`, when it carried them.
    var dateStr: String?
    var at: String?

    init(id: String, deliveredAtMs: Int, dateStr: String? = nil, at: String? = nil) {
        self.id = id
        self.deliveredAtMs = deliveredAtMs
        self.dateStr = dateStr
        self.at = at
    }
}

/// One request to add: the plan's, and what the adapter needs beyond it.
struct ScheduledNotification: Sendable, Hashable {
    var request: PlannedRequest
    /// For `afterMs`: how long from the moment of adding, at least a second
    /// (`firesAt` minus now; the plan's instant is not the adding's).
    var afterSeconds: Double?

    /// What the request is, as far as a re-plan cares: its trigger, words,
    /// grouping and userInfo. A request pending under the same id with the
    /// same signature is left alone; any other is replaced. A calendar
    /// trigger's `firesAt` is left out (it moves every day the slot rings,
    /// and the trigger with it would not), a one-off's is in.
    static func signature(of request: PlannedRequest) -> String {
        let trigger: String
        switch request.trigger {
        case .calendar(let hour, let minute, let weekday, let day):
            trigger = "cal:\(hour):\(minute):\(weekday.map(String.init) ?? "-"):\(day.map(String.init) ?? "-")"
        case .at(let dateStr, let hhmm):
            trigger = "at:\(dateStr)T\(hhmm)"
        case .afterMs:
            trigger = "after:\(request.firesAt)"
        case .now:
            trigger = "now"
        }
        let info = request.userInfo.dictionary.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
            .joined(separator: "&")
        let parts = [trigger, request.title, request.body, request.threadId, request.summaryArgument,
                     request.categoryId, request.level.rawValue, String(request.relevance), info]
        return parts.joined(separator: "\u{1F}")
    }

    var signature: String { Self.signature(of: request) }

    /// The userInfo the adapter writes: the plan's, with the signature.
    var userInfo: [String: String] {
        var info = request.userInfo.dictionary
        info[NotificationKeys.signature] = signature
        return info
    }
}

/// UNUserNotificationCenter, as far as dsul uses it. Every call is about
/// dsul's own requests; the scheduler filters by `NotificationKeys.prefix`
/// before it removes anything.
@MainActor
protocol NotificationCenterPort: AnyObject {
    func permission() async -> NotificationPermission
    /// Asks once, `[.alert, .sound]`, never provisional. Answers whether it
    /// is allowed now.
    func requestPermission() async -> Bool
    func pending() async -> [PendingNotification]
    func delivered() async -> [DeliveredNotification]
    /// Adds (or, under an id already pending, replaces) one request. A
    /// `now` request is delivered at once and never pending.
    func add(_ notification: ScheduledNotification) async throws
    func removePending(_ ids: [String])
    func removeDelivered(_ ids: [String])
}
