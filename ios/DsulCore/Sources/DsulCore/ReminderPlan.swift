import Foundation

// Port of lib/reminders/plan.ts: what the iPhone arms, and what it takes back
// out of the shade. Keep in step: a change there without the same change here
// is drift, and the phone's lock screen and the web's plan disagree about
// when a cue rings. Checked against the web by NotificationPlanFixtureTests
// (tests/fixtures/day/notification-plan.json): every case's whole plan,
// requests in order, withdrawals and notes. Also ported here: lib/eod.ts
// `minutesOfDay` (`eodMinutesOfDay`), the review hour's looser parser.
//
// On the phone the per-item cue, its snooze and the end-of-day review are
// LOCAL notifications (memory/plans/reminders-platforms.md §2.3, Phase 2).
// `planNotifications` decides the set: given the planner as the phone last saw
// it, what is in its shade, and one instant, which UNNotificationRequests
// should be pending, under which identifiers, with which triggers and words,
// and which delivered ones are stale. The hosted scheduler diffs that against
// what is pending and delivered; it decides nothing itself.
//
// It never decides whether an item wants doing (that is `wantsDoingOn`,
// ReminderDue.swift, asked once per candidate day), never writes a sentence
// (`reminderCopy` and `eodCopy`, ReminderCopy.swift), and plans NO last call
// (design decision 24: a list worked out at the last plan can name a habit
// done elsewhere since, the one scold the copy contract cannot send).
//
// THE SHAPES (plan.ts's header has the whole argument). Two rules bind them: a
// phone left alone must not fall silent (decision 23: a one-off fires once and
// does not launch the app), and every ring lands on its own minute, on a day
// the item occurs and, as far as the plan can see, still wants doing. A
// repeating trigger cannot be told when to stop, so where the two meet the
// second wins and the phone goes quiet instead.
// - a calendar cadence (daily; one weekday; a day of the month) is ONE
//   repeating calendar trigger under `dsul-item-<id>`. A day of the month after
//   the 28th rings in the long months, and the next shorter month's clamped
//   last day is a one-off beside it under `#next`;
// - two to six weekdays are one calendar trigger per weekday,
//   `dsul-item-<id>#<weekday>` (1 = Sunday … 7 = Saturday);
// - a slot STANDS only while its own next ring is the next wanted cue on its
//   days AND every ring it makes in the `lapseDays` after that one, and the
//   ring after it however far off, wants doing too. Otherwise it is HELD (today
//   handled before its cue; a pause or a season not yet begun over its next
//   ring; a season's end, a skip or a tick ahead the plan can already see). A
//   held weekday of a split is a one-off at that weekday's next wanted cue,
//   under the same `#<weekday>`. A held daily slot splits into `#1` … `#7` by
//   the same rule. A held lone weekday or day of the month is the one-off
//   series below;
// - NO repeating interval trigger (where the web departs from decision 23's
//   letter): UNTimeIntervalNotificationTrigger has no start date, so a
//   repeating one first rings `seconds` after it is added and then every
//   `seconds`, and cannot both start at the next wanted cue and repeat on the
//   cadence;
// - one-offs where no cadence stands: a dated task; a series whose start,
//   today or later, is off its own rule; a cue time in the zone's changeover
//   minutes (`changeoverMinutes`, ReminderClock.swift: 01:00–02:59 in New
//   York, none in Kolkata); a held lone weekday or month day. Each is the next
//   wanted cue under `dsul-item-<id>` and the one after under `#next`;
// - a snooze is a one-off under `#snooze`, beside the standing trigger. It
//   belongs to its day: one that would ring past that day's local midnight
//   has expired (`ringsOnDay`, ReminderSnooze.swift), as it has on the server;
// - a cue armed inside its own window rings now (`#now`), once per device,
//   never while a snooze from today is pending (armed, or expired at midnight);
// - the review is a standing daily trigger under `dsul-eod`, held as a daily
//   cue is (reviewed today before its hour, it splits into `dsul-eod#1` …
//   `#7`); in the changeover minutes, one-offs (`dsul-eod`, `dsul-eod#next`).
//   No catch-up.
//
// THE SHADE. A delivered notification is withdrawn when the day it is about
// (its own dateStr, or the local day it was delivered on) no longer wants
// doing, its item is gone or no longer reminds, reminders are off on this
// iPhone, a snooze armed for that day replaces it, or, for the review, that
// day is reviewed or the review is off. Nothing else is touched.
//
// What is left, each until dsul next plans: a held weekday of a split rings
// once, at its next wanted cue (a daily ticked before its cue is quiet on that
// weekday from two weeks on; a pause, or a season not yet begun, holds every
// weekday whose next ring it covers, so a pause of a week or more quiets the
// whole item from a week after it ends); a held lone weekday or month day,
// and a series not yet begun from an off-rule start, ring twice; a cue in the
// changeover minutes rings twice, a day apart; a day of the month after the
// 28th misses the short months after the next one; an unwanted day further
// than `lapseDays` past a slot's next ring (and past the ring after it) is
// left to a plan in between; a split the budget cut short stands on the
// weekdays it kept.
//
// The budget: 60 PENDING requests (of the OS's 64); a catch-up is delivered at
// once and never counted. Spent in passes: the review's soonest; live
// snoozes; catch-ups; ONE request per item, soonest first; then everyone's
// others, the review's among them, one at a time in the order they ring. An
// item, or the review, that loses anything but a second one-off (`#next`)
// gets an over-budget note.
//
// Swift shapes: instants are epoch milliseconds (`Int`), item ids are `UUID`s
// written lower-case in identifiers and orderings (as the server writes them;
// the web orders the same strings by code unit), and the trigger and the
// note are enums where the web has tagged objects. Nothing reads the clock.

/// lib/reminders/plan.ts `NOTIFICATION_BUDGET`: how many PENDING requests a
/// plan may hold, 60 of the OS's 64. A catch-up (`now`) is delivered the moment
/// it is added and never sits pending, so it is not counted.
public let notificationBudget = 60
/// `CUE_THREAD`: the thread a cue and its snooze stack under.
public let cueThread = "dsul.cues"
/// `RITUAL_THREAD`: the review's thread (and the last call's, once APNs brings one).
public let ritualThread = "dsul.rituals"
/// `CUE_CATEGORY`: Done and Snooze, without authenticationRequired.
public let cueCategory = "DSUL_CUE"
/// `EOD_CATEGORY`.
public let eodCategory = "DSUL_EOD"
/// `EOD_IDENTIFIER`: the review's identifier.
public let eodIdentifier = "dsul-eod"
/// `RELEVANCE_FULL_STREAK`: the streak at which a cue's relevance reaches 1.
public let relevanceFullStreak = 30

/// `HORIZON_DAYS`: how far ahead a next wanted cue is looked for, a year.
let planHorizonDays = 366
/// `LAPSE_DAYS`: how far past a slot's next ring its later rings must want
/// doing for it to stand (and its following ring, however far off). Kirby's
/// to move; see plan.ts.
let lapseDays = 31
/// `CHANGEOVER_DAYS`: how far ahead a zone's changeovers are looked for.
let changeoverDays = 400

/// lib/reminders/plan.ts `PlannedKind`. The raw values are the web's.
public enum PlannedKind: String, Sendable, Hashable, CaseIterable {
    case cue, snoozed, catchUp, eod
}

/// lib/reminders/plan.ts `PlannedTrigger`, in UNNotificationTrigger's own
/// terms, so the scheduler maps each case to one initializer:
/// - `calendar`: UNCalendarNotificationTrigger(dateMatching: hour, minute and,
///   when set, `weekday` (1 = Sunday … 7 = Saturday) or `day`, repeats: true);
/// - `at`: a one-off UNCalendarNotificationTrigger with the full date
///   (year, month, day from `dateStr`, hour and minute from `hhmm`);
/// - `afterMs`: a one-off UNTimeIntervalNotificationTrigger, `ms` after the
///   plan's instant (added later, `firesAt` minus the moment of adding);
/// - `now`: no trigger; delivered at once, and never pending.
///
/// There is no repeating interval: see the header for why it cannot be both
/// anchored at a cue and periodic.
public enum PlannedTrigger: Sendable, Hashable {
    case calendar(hour: Int, minute: Int, weekday: Int?, day: Int?)
    case at(dateStr: String, hhmm: String)
    case afterMs(Int)
    case now

    /// The web's discriminator: "calendar", "at", "afterMs", "now".
    public var type: String {
        switch self {
        case .calendar: return "calendar"
        case .at: return "at"
        case .afterMs: return "afterMs"
        case .now: return "now"
        }
    }

    /// Whether the trigger repeats: only the calendar does.
    public var repeats: Bool {
        switch self {
        case .calendar: return true
        case .at, .afterMs, .now: return false
        }
    }
}

/// UNNotificationInterruptionLevel. Time Sensitive is Phase 4's, per item and opt-in.
public enum PlannedLevel: String, Sendable, Hashable {
    case active
}

/// lib/reminders/plan.ts `PlannedUserInfo`: what the notification carries
/// back to the delegate when it is tapped or acted on.
public struct PlannedUserInfo: Sendable, Hashable {
    public var kind: PlannedKind
    public var itemId: UUID?
    /// The day it is about, when it is about exactly one. A repeating trigger
    /// rings on many, so it has none, and the delegate takes the local day of
    /// the notification's own date: Done credits that day, and the review's
    /// link names it. A calendar trigger only rings on its slot's own days, so
    /// that day is one the item occurs on; whether it still wants doing there
    /// (done elsewhere since, paused since the plan) is the delegate's to ask
    /// with `wantsDoingOn` before it sends a Done.
    public var dateStr: String?
    /// The cue's "HH:mm", so the delegate can record `sentKeyFor(day, at)`.
    public var at: String?

    public init(kind: PlannedKind, itemId: UUID? = nil, dateStr: String? = nil, at: String? = nil) {
        self.kind = kind
        self.itemId = itemId
        self.dateStr = dateStr
        self.at = at
    }

    /// As UNNotificationContent.userInfo carries it, the web's JSON keys with
    /// string values: absent keys left out, the id lower-case.
    public var dictionary: [String: String] {
        var out = ["kind": kind.rawValue]
        if let itemId { out["itemId"] = itemId.uuidString.lowercased() }
        if let dateStr { out["dateStr"] = dateStr }
        if let at { out["at"] = at }
        return out
    }
}

/// lib/reminders/plan.ts `PlannedRequest`: one request that should be pending.
public struct PlannedRequest: Sendable, Hashable {
    /// The UNNotificationRequest identifier (`identifiers(for:)`, `eodIdentifiers()`).
    public var id: String
    public var kind: PlannedKind
    public var itemId: UUID?
    /// Set exactly when userInfo's is: the request is about one day.
    public var dateStr: String?
    public var trigger: PlannedTrigger
    /// The instant (epoch ms) this request first rings, as planned. Order and
    /// diagnostics, not identity.
    public var firesAt: Int
    public var title: String
    public var body: String
    /// `cueThread` or `ritualThread`.
    public var threadId: String
    /// The title again, so a collapsed stack names its items.
    public var summaryArgument: String
    /// `cueCategory` or `eodCategory`.
    public var categoryId: String
    public var level: PlannedLevel
    /// UNNotificationContent.relevanceScore, 0…1: the streak at stake, the review 0.
    public var relevance: Double
    public var userInfo: PlannedUserInfo

    public init(
        id: String, kind: PlannedKind, itemId: UUID?, dateStr: String?, trigger: PlannedTrigger, firesAt: Int,
        title: String, body: String, threadId: String, summaryArgument: String, categoryId: String,
        level: PlannedLevel = .active, relevance: Double, userInfo: PlannedUserInfo
    ) {
        self.id = id
        self.kind = kind
        self.itemId = itemId
        self.dateStr = dateStr
        self.trigger = trigger
        self.firesAt = firesAt
        self.title = title
        self.body = body
        self.threadId = threadId
        self.summaryArgument = summaryArgument
        self.categoryId = categoryId
        self.level = level
        self.relevance = relevance
        self.userInfo = userInfo
    }
}

/// lib/reminders/plan.ts `PlanNote`: something the plan could not do.
/// - `badZone`: the zone is not one Foundation knows; nothing planned.
/// - `badTime`: a cue time (or, with no item, the review's hour) is not a time.
/// - `dstGap`: that day's cue falls in the hour a spring-forward skips.
/// - `overBudget`: the item (no item: the review) lost a request to the
///   budget other than a second one-off (`#next`): its first, its snooze, or
///   a weekday of its split. `kept` is how many of its cue requests remain
///   (the review's own, for the review).
public enum PlanNote: Sendable, Hashable {
    case badZone(value: String)
    case badTime(itemId: UUID?, value: String)
    case dstGap(itemId: UUID?, dateStr: String, at: String)
    case overBudget(itemId: UUID?, kept: Int)

    /// The web's code: "bad-zone", "bad-time", "dst-gap", "over-budget".
    public var code: String {
        switch self {
        case .badZone: return "bad-zone"
        case .badTime: return "bad-time"
        case .dstGap: return "dst-gap"
        case .overBudget: return "over-budget"
        }
    }
}

/// lib/reminders/plan.ts `PlanSnooze`: a snooze as the planner payload
/// projects it (`reminder_snooze_until/date`; lib/app-api.ts `AppSnooze`).
public struct PlanSnooze: Decodable, Sendable, Hashable {
    public var itemId: UUID
    /// An ISO instant.
    public var until: String
    /// The local day the snooze belongs to, yyyy-MM-dd.
    public var date: String

    public init(itemId: UUID, until: String, date: String) {
        self.itemId = itemId
        self.until = until
        self.date = date
    }

    enum CodingKeys: String, CodingKey {
        case itemId, until, date
    }

    /// Strict: a snooze missing a field, or naming no item, can't be armed,
    /// and the payload's lossy array skips it.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try c.decode(String.self, forKey: .itemId)
        guard let itemId = UUID(uuidString: raw) else {
            throw DecodingError.dataCorruptedError(forKey: .itemId, in: c, debugDescription: "not a uuid: \(raw)")
        }
        self.itemId = itemId
        self.until = try c.decode(String.self, forKey: .until)
        self.date = try c.decode(String.self, forKey: .date)
    }
}

/// lib/reminders/plan.ts `PlanEod`: the end-of-day review's three settings.
public struct PlanEod: Sendable, Hashable {
    public var enabled: Bool
    /// eod_review_time: "HH:mm", or the looser "H:mm" lib/eod.ts accepts.
    public var time: String
    /// last_eod_review_date: the day the last review was FOR.
    public var lastReviewDate: String?

    public init(enabled: Bool, time: String, lastReviewDate: String? = nil) {
        self.enabled = enabled
        self.time = time
        self.lastReviewDate = lastReviewDate
    }
}

/// lib/reminders/plan.ts `PlanDelivered`: one notification in the shade, as
/// getDeliveredNotifications reports it. Any app's identifiers may be passed;
/// only dsul's are ever withdrawn.
public struct PlanDelivered: Sendable, Hashable {
    /// The request's identifier.
    public var id: String
    /// UNNotification.date, epoch ms: when it was delivered.
    public var deliveredAtMs: Int
    /// Its userInfo's dateStr, when it carried one.
    public var dateStr: String?

    public init(id: String, deliveredAtMs: Int, dateStr: String? = nil) {
        self.id = id
        self.deliveredAtMs = deliveredAtMs
        self.dateStr = dateStr
    }
}

/// lib/reminders/plan.ts `PlanInput`, with the web's defaults filled in.
public struct PlanInput: Sendable, Hashable {
    /// The instant of this plan, epoch milliseconds.
    public var nowMs: Int
    /// The device's IANA zone: a phone's cues ring where the phone is.
    public var timeZone: String
    /// The planner's items, deleted ones excluded.
    public var items: [Item]
    /// Live routines and seasons.
    public var routines: [Routine]
    public var seasons: [Season]
    public var timeFormat: TimeFormat
    /// habit_reminders_enabled AND this device's own switch. Off plans no cue,
    /// no snooze and no catch-up, and withdraws every cue in the shade; the
    /// review has its own switch.
    public var remindersEnabled: Bool
    public var eod: PlanEod?
    public var snoozes: [PlanSnooze]
    /// `sentKeyFor(day, at)` of every cue this device has rung or had armed at
    /// its minute. The scheduler adds a catch-up's key the moment it adds it.
    public var localSentKeys: Set<String>
    /// What is in the shade now. Empty, nothing is withdrawn.
    public var delivered: [PlanDelivered]
    public var graceMinutes: Int
    public var budget: Int

    public init(
        nowMs: Int,
        timeZone: String,
        items: [Item],
        routines: [Routine] = [],
        seasons: [Season] = [],
        timeFormat: TimeFormat = .twelveHour,
        remindersEnabled: Bool,
        eod: PlanEod? = nil,
        snoozes: [PlanSnooze] = [],
        localSentKeys: Set<String> = [],
        delivered: [PlanDelivered] = [],
        graceMinutes: Int = reminderGraceMinutes,
        budget: Int = notificationBudget
    ) {
        self.nowMs = nowMs
        self.timeZone = timeZone
        self.items = items
        self.routines = routines
        self.seasons = seasons
        self.timeFormat = timeFormat
        self.remindersEnabled = remindersEnabled
        self.eod = eod
        self.snoozes = snoozes
        self.localSentKeys = localSentKeys
        self.delivered = delivered
        self.graceMinutes = graceMinutes
        self.budget = budget
    }
}

/// lib/reminders/plan.ts `NotificationPlan`.
public struct NotificationPlan: Sendable, Hashable {
    /// Every request that should be pending (or, `now`, delivered), ordered
    /// by firesAt, then id.
    public var requests: [PlannedRequest]
    /// Identifiers to remove from the DELIVERED notifications, sorted: each one
    /// of `delivered` that is stale (see the header's THE SHADE). Pending
    /// requests are the diff's business, never this.
    public var withdraw: [String]
    public var notes: [PlanNote]

    public init(requests: [PlannedRequest], withdraw: [String], notes: [PlanNote]) {
        self.requests = requests
        self.withdraw = withdraw
        self.notes = notes
    }
}

/// lib/reminders/plan.ts `itemIdentifier`: `dsul-item-<id>`, which replaces a
/// pending cue, replaces a delivered one, and withdraws.
public func itemIdentifier(_ itemId: UUID) -> String {
    return "dsul-item-\(itemId.uuidString.lowercased())"
}

/// lib/reminders/plan.ts `identifiers`: every identifier an item can ever be
/// under, in a fixed order: its own, one per weekday (#1 Sunday … #7
/// Saturday), the second one-off (#next), the catch-up (#now) and the snooze
/// (#snooze). Every one, so a withdrawal never leaves an old shape's in the shade.
public func identifiers(for itemId: UUID) -> [String] {
    let base = itemIdentifier(itemId)
    return [base] + (1...7).map { "\(base)#\($0)" } + ["\(base)#next", "\(base)#now", "\(base)#snooze"]
}

/// lib/reminders/plan.ts `eodIdentifiers`: the review's identifiers, in the
/// same order as an item's: its standing trigger (or its next one-off), its
/// seven weekdays while it is held, and its second one-off.
public func eodIdentifiers() -> [String] {
    return [eodIdentifier] + (1...7).map { "\(eodIdentifier)#\($0)" } + ["\(eodIdentifier)#next"]
}

/// lib/eod.ts `minutesOfDay`: the review hour's parser, looser than the cue's
/// (`/^(\d{1,2}):(\d{2})$/` after a trim, so "9:00" is 09:00), because
/// user_settings' eod_review_time has no CHECK. Nil when malformed.
public func eodMinutesOfDay(_ hhmm: String) -> Int? {
    let parts = Array(jsTrim(hhmm).utf8)
    guard let colon = parts.firstIndex(of: UInt8(ascii: ":")) else { return nil }
    let hourDigits = parts[..<colon]
    let minuteDigits = parts[(colon + 1)...]
    guard (1...2).contains(hourDigits.count), minuteDigits.count == 2 else { return nil }
    func number<C: Collection>(_ digits: C) -> Int? where C.Element == UInt8 {
        var value = 0
        for c in digits {
            guard c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9") else { return nil }
            value = value * 10 + Int(c - UInt8(ascii: "0"))
        }
        return value
    }
    guard let hours = number(hourDigits), let minutes = number(minuteDigits), hours <= 23, minutes <= 59 else {
        return nil
    }
    return hours * 60 + minutes
}


// MARK: - Internals

/// One cue: the day, and the instant (epoch ms).
private struct PlannedCue {
    let day: DayString
    let at: Int
}

/// One standing calendar trigger, and the days it rings on.
private struct Slot {
    let id: String
    let weekday: Int?
    let day: Int?
    let rings: (DayString) -> Bool
}

/// The standing slots a cadence can stand on, or none to stand on.
private enum CueCadence {
    case oneOffs
    case slots([Slot])
}

/// What one item, or the review, asks of the budget: its requests, soonest first.
private struct Ask {
    /// The item's id; nil for the review.
    var itemId: UUID?
    var requests: [PlannedRequest]
}

/// Minutes since midnight as "HH:mm".
private func clockText(_ minutes: Int) -> String {
    return "\(zeroPadded(minutes / 60, 2)):\(zeroPadded(minutes % 60, 2))"
}

/// A lower-case UUID, the string the web's ids are.
private func idString(_ id: UUID) -> String {
    return id.uuidString.lowercased()
}

/// String order by code unit, as JavaScript's `<` and default `sort()` compare
/// (the same as byte order for the ASCII identifiers and ids compared here).
private func codeUnitLess(_ a: String, _ b: String) -> Bool {
    return a.utf16.lexicographicallyPrecedes(b.utf16)
}

/// `byFireThenId`: firesAt, then id.
private func byFireThenId(_ a: PlannedRequest, _ b: PlannedRequest) -> Bool {
    if a.firesAt != b.firesAt { return a.firesAt < b.firesAt }
    return codeUnitLess(a.id, b.id)
}

private func calendarTrigger(_ minutes: Int, weekday: Int? = nil, day: Int? = nil) -> PlannedTrigger {
    return .calendar(hour: minutes / 60, minute: minutes % 60, weekday: weekday, day: day)
}

/// `weekdaySlots`: one slot per weekday of `days` (0 = Sunday … 6), each under
/// `<base>#<1 … 7>`.
private func weekdaySlots(_ base: String, _ days: [Int]) -> [Slot] {
    return days.map { w in Slot(id: "\(base)#\(w + 1)", weekday: w + 1, day: nil, rings: { $0.weekday == w }) }
}

/// `dailySlot`: every day, under `base`, an item's or the review's.
private func dailySlot(_ base: String) -> Slot {
    return Slot(id: base, weekday: nil, day: nil, rings: { _ in true })
}

/// lib/reminders/plan.ts `itemIdOf`: the item a dsul identifier belongs to,
/// as the string it was written with, or nil for one that is not an item's.
private func itemIdOf(_ id: String) -> String? {
    let prefix = "dsul-item-"
    guard id.hasPrefix(prefix) else { return nil }
    let rest = id.dropFirst(prefix.count)
    let itemId = String(rest.firstIndex(of: "#").map { rest[..<$0] } ?? rest)
    guard !itemId.isEmpty else { return nil }
    let base = prefix + itemId
    let own = [base] + (1...7).map { "\(base)#\($0)" } + ["\(base)#next", "\(base)#now", "\(base)#snooze"]
    return own.contains(id) ? itemId : nil
}

/// The first cue at `minutes`, on a day from `start` on (within `days` days)
/// that `accept` takes, that is still to come. A day whose minute does not
/// exist (spring forward) is passed over and reported to `onGap`; nothing is
/// moved to another minute.
private func nextCue(
    from start: DayString, _ minutes: Int, _ zone: TimeZone, _ nowMs: Int,
    days: Int = planHorizonDays,
    accept: (DayString) -> Bool,
    onGap: ((DayString) -> Void)? = nil
) -> PlannedCue? {
    var day = start
    var i = 0
    while i < days {
        if i > 0 { day = day.adding(days: 1) }
        i += 1
        if !accept(day) { continue }
        guard let at = instantOf(day, minutes, zone) else {
            onGap?(day)
            continue
        }
        if at > nowMs { return PlannedCue(day: day, at: at) }
    }
    return nil
}

/// lib/reminders/plan.ts `slotsOf`: the standing slots an item's cadence can
/// stand on, or `.oneOffs` when it has none. An empty list is a cadence that
/// rings on no day (custom with no days): no request, as `occursOn`.
private func slotsOf(_ item: Item, today: DayString) -> CueCadence {
    if !isRecurring(item.rule) { return .oneOffs }
    if caps(item.typeName).dateAnchored {
        // Undated occurs on no day (the one-offs find none); a start still to
        // come off the rule is a day no calendar trigger rings.
        guard let startDate = truthyText(item.startDate).map(toDateOnly), !startDate.isEmpty else {
            return .oneOffs
        }
        if !codeUnitLess(startDate, today.description) {
            // lib/recurrence.ts `shouldShowOnDate` on the start; a start that is
            // no day is on no rule but the daily one, as the web reads it.
            let onRule = DayString(startDate).map { shouldShowOnDate(item.rule, on: $0) }
                ?? (item.rule.frequency == "daily")
            if !onRule { return .oneOffs }
        }
    }

    let base = itemIdentifier(item.id)
    func weekdays(_ days: [Int]?) -> [Slot] {
        let set = Array(Set((days ?? []).filter { (0...6).contains($0) })).sorted()
        if set.count == 7 { return [dailySlot(base)] }
        if set.count == 1 {
            let w = set[0]
            return [Slot(id: base, weekday: w + 1, day: nil, rings: { $0.weekday == w })]
        }
        return weekdaySlots(base, set)
    }

    switch item.repeatFrequency {
    case "daily":
        return .slots([dailySlot(base)])
    case "weekdays":
        return .slots(weekdays([1, 2, 3, 4, 5]))
    case "weekends":
        return .slots(weekdays([0, 6]))
    case "weekly", "custom":
        return .slots(weekdays(item.repeatDays))
    case "monthly":
        if let monthDay = item.repeatMonthDay, (1...31).contains(monthDay) {
            return .slots([Slot(id: base, weekday: nil, day: monthDay, rings: { $0.day == monthDay })])
        }
        return .oneOffs
    default:
        return .oneOffs
    }
}

/// lib/reminders/plan.ts `cadence`: how one cadence, an item's or the
/// review's, asks the budget. `once` makes its one-off for a cue and
/// `standing` its calendar trigger for a slot; the rest is the same for both.
private final class Cadence {
    let base: String
    let minutes: Int
    let today: DayString
    let zone: TimeZone
    let nowMs: Int
    let wanted: (DayString) -> Bool
    let gap: (DayString) -> Void
    let once: (String, PlannedCue) -> PlannedRequest
    let standing: (Slot, Int) -> PlannedRequest
    /// `unwantedDays`: nil until asked, then the lead-in (nil inside: none
    /// within the horizon wants doing).
    private var unwantedDays: Int??

    init(
        base: String, minutes: Int, today: DayString, zone: TimeZone, nowMs: Int,
        wanted: @escaping (DayString) -> Bool,
        gap: @escaping (DayString) -> Void,
        once: @escaping (String, PlannedCue) -> PlannedRequest,
        standing: @escaping (Slot, Int) -> PlannedRequest
    ) {
        self.base = base
        self.minutes = minutes
        self.today = today
        self.zone = zone
        self.nowMs = nowMs
        self.wanted = wanted
        self.gap = gap
        self.once = once
        self.standing = standing
    }

    /// How many days from today none wants doing, or nil when none does within
    /// the horizon. Every search for a wanted cue starts there, so an item
    /// paused for months is walked through once, not once per slot.
    private func leadIn() -> Int? {
        if let known = unwantedDays { return known }
        var found: Int?
        var day = today
        for i in 0..<planHorizonDays {
            if i > 0 { day = day.adding(days: 1) }
            if wanted(day) {
                found = i
                break
            }
        }
        unwantedDays = .some(found)
        return found
    }

    /// The next cue `accept` takes on a day that wants doing, searched as from today.
    func nextWanted(_ accept: (DayString) -> Bool) -> PlannedCue? {
        guard let skip = leadIn() else { return nil }
        return nextCue(
            from: today.adding(days: skip), minutes, zone, nowMs, days: planHorizonDays - skip,
            accept: { accept($0) && self.wanted($0) }, onGap: gap
        )
    }

    /// The next wanted cue under `base` and, when there is one, the one after under `#next`.
    func series() -> [PlannedRequest] {
        guard let first = nextWanted({ _ in true }) else { return [] }
        guard let second = nextCue(from: first.day.adding(days: 1), minutes, zone, nowMs, accept: wanted, onGap: gap)
        else { return [once(base, first)] }
        return [once(base, first), once("\(base)#next", second)]
    }

    /// Does every ring `s` makes in the `lapseDays` after `from` want doing,
    /// and its following ring too when that is further off (a trigger on the
    /// 31st rings again two months on when the next month is short)?
    private func keepsWanting(_ s: Slot, from: DayString) -> Bool {
        var rang = false
        var day = from
        var i = 1
        while i <= planHorizonDays && (i <= lapseDays || !rang) {
            day = day.adding(days: 1)
            i += 1
            if !s.rings(day) { continue }
            if !wanted(day) { return false }
            rang = true
        }
        return true
    }

    /// One slot: its calendar trigger while that trigger's own next ring is the
    /// next wanted cue on its days and its rings after it want doing too; else
    /// (held) a one-off at that cue under the slot's own identifier; else
    /// nothing (no wanted cue within the horizon: paused with no end, a season
    /// over for good).
    func slot(_ s: Slot) -> PlannedRequest? {
        guard let next = nextWanted(s.rings) else { return nil }
        if let rings = nextCue(from: today, minutes, zone, nowMs, accept: s.rings),
           rings.day == next.day, keepsWanting(s, from: next.day) {
            return standing(s, rings.at)
        }
        return once(s.id, next)
    }

    /// What standing `slots` ask: one request per slot, a held daily's seven, or the series.
    func stand(_ slots: [Slot]) -> [PlannedRequest] {
        if slots.count != 1 { return slots.compactMap { slot($0) } }
        let only = slots[0]
        guard let own = slot(only) else {
            // A day of the month after the 28th with none of its own days
            // wanted can still have a clamped one, which the series finds.
            if let day = only.day, day > 28 { return series() }
            return []
        }
        guard case .calendar = own.trigger else {
            // A lone weekday or day of the month has no other day to stand on.
            if only.weekday != nil || only.day != nil { return series() }
            // A daily slot splits, so the days that still want it keep standing.
            return weekdaySlots(base, Array(0...6)).compactMap { slot($0) }
        }
        if let day = only.day, day > 28,
           // The shorter months' clamped day, which a trigger on the 31st never rings.
           let clamped = nextWanted({ !only.rings($0) }) {
            return [own, once("\(base)#next", clamped)]
        }
        return [own]
    }
}

// MARK: - The plan

/// lib/reminders/plan.ts `planNotifications`: the requests that should be
/// pending at `input.nowMs`, the delivered identifiers to withdraw, and notes
/// on what could not be planned. Pure; see the header for the rules.
///
/// Every item, and the review, asks for its requests, soonest first, and the
/// budget is spent in passes: the review's soonest request, then live snoozes,
/// then catch-ups (free: never pending); then ONE request per item, soonest
/// first; then everyone's others, the review's among them, one at a time in
/// the order they ring.
public func planNotifications(_ input: PlanInput) -> NotificationPlan {
    let nowMs = input.nowMs
    guard let zone = TimeZone(identifier: input.timeZone) else {
        return NotificationPlan(requests: [], withdraw: [], notes: [.badZone(value: input.timeZone)])
    }
    let (today, nowMinutes) = wallClock(nowMs, zone)
    let todayStr = today.description

    let ctx = ActivationContext(timeZone: input.timeZone, routines: input.routines, seasons: input.seasons)
    let budget = input.budget

    // The minutes no repeating trigger may sit on here: those the zone's
    // daylight-saving changeovers skip or play twice.
    let changeovers = changeoverMinutes(zone, fromMs: nowMs, days: changeoverDays)
    func onChangeover(_ minutes: Int) -> Bool {
        return changeovers.contains { inMinuteRun(minutes, $0) }
    }

    var notes: [PlanNote] = []
    var fixed: [PlannedRequest] = []
    var asks: [Ask] = []
    var reviewAsk: [PlannedRequest] = []
    var gapsSeen = Set<String>()

    /// Report a skipped spring-forward minute once, and only if it was still to come.
    func gapReporter(_ minutes: Int, _ itemId: UUID?) -> (DayString) -> Void {
        return { day in
            if day == today && minutes <= nowMinutes { return }
            let key = "\(itemId.map(idString) ?? "")|\(day)"
            guard gapsSeen.insert(key).inserted else { return }
            notes.append(.dstGap(itemId: itemId, dateStr: day.description, at: clockText(minutes)))
        }
    }

    // MARK: The review

    if let eod = input.eod, eod.enabled {
        if let minutes = eodMinutesOfDay(eod.time) {
            func review(_ id: String, _ trigger: PlannedTrigger, _ firesAt: Int, _ dateStr: String? = nil) -> PlannedRequest {
                return PlannedRequest(
                    id: id, kind: .eod, itemId: nil, dateStr: dateStr, trigger: trigger, firesAt: firesAt,
                    title: eodCopy.title, body: eodCopy.body, threadId: ritualThread,
                    summaryArgument: eodCopy.title, categoryId: eodCategory, level: .active, relevance: 0,
                    userInfo: PlannedUserInfo(kind: .eod, dateStr: dateStr)
                )
            }
            let lastReviewDate = eod.lastReviewDate
            let plan = Cadence(
                base: eodIdentifier, minutes: minutes, today: today, zone: zone, nowMs: nowMs,
                // Owed is lib/eod.ts's isEodOwed, minus the hour: any day not
                // already recorded as reviewed.
                wanted: { $0.description != lastReviewDate },
                gap: gapReporter(minutes, nil),
                once: { id, next in
                    review(id, .at(dateStr: next.day.description, hhmm: clockText(minutes)), next.at, next.day.description)
                },
                standing: { slot, at in review(slot.id, calendarTrigger(minutes, weekday: slot.weekday), at) }
            )
            reviewAsk = (onChangeover(minutes) ? plan.series() : plan.stand([dailySlot(eodIdentifier)]))
                .sorted(by: byFireThenId)
        } else {
            notes.append(.badTime(itemId: nil, value: eod.time))
        }
    }

    // MARK: The items

    /// The day each item's armed snooze belongs to: it replaces that day's cue in the shade.
    var snoozedDay: [UUID: String] = [:]

    if input.remindersEnabled {
        var snoozeOf: [UUID: PlanSnooze] = [:]
        for snooze in input.snoozes { snoozeOf[snooze.itemId] = snooze }
        // By id, stable among equals, as the web's sort.
        let items = input.items.enumerated()
            .sorted { a, b in
                let ia = idString(a.element.id), ib = idString(b.element.id)
                return ia != ib ? codeUnitLess(ia, ib) : a.offset < b.offset
            }
            .map(\.element)

        for item in items {
            if !isRemindable(item) { continue }
            let at = item.reminderTime
            let minutes = minutesOfDay(at)
            if minutes == nil, let at, !at.isEmpty { notes.append(.badTime(itemId: item.id, value: at)) }

            // One plan asks about the same days many times over (the series,
            // each slot, each slot's later rings), and an item under a pause
            // asks about every day of a year: wantsDoingOn once per day.
            var answers: [DayString: Bool] = [:]
            let wanted: (DayString) -> Bool = { day in
                if let answer = answers[day] { return answer }
                let answer = wantsDoingOn(item, on: day, ctx)
                answers[day] = answer
                return answer
            }

            let snooze = snoozeOf[item.id]
            let wantedToday = wanted(today)
            let base = itemIdentifier(item.id)
            let snoozeId = "\(base)#snooze"

            let anchor = truthyText(item.reminderAnchor)
            let streak = streakOf(item)
            let relevance = streak > 0 ? min(1, Double(streak) / Double(relevanceFullStreak)) : 0
            func cue(
                _ id: String, _ kind: PlannedKind, _ trigger: PlannedTrigger, _ firesAt: Int, _ dateStr: String? = nil
            ) -> PlannedRequest {
                // An empty `at` (a snooze on an item with no cue of its own)
                // reads as no time to echo.
                let words = reminderCopy(
                    ReminderCandidate(item: item, at: at ?? "", anchor: anchor, snoozed: kind == .snoozed),
                    timeFormat: input.timeFormat
                )
                return PlannedRequest(
                    id: id, kind: kind, itemId: item.id, dateStr: dateStr, trigger: trigger, firesAt: firesAt,
                    title: words.title, body: words.body, threadId: cueThread, summaryArgument: words.title,
                    categoryId: cueCategory, level: .active, relevance: relevance,
                    userInfo: PlannedUserInfo(kind: kind, itemId: item.id, dateStr: dateStr, at: truthyText(at))
                )
            }

            // A snooze belongs to its day (habit-reminders.md decision 8), as
            // in dueReminders: one for another day never rings, and one
            // already matured has rung (or the server's tick took it). PENDING
            // is a snooze for today still to come. It is armed only while the
            // item still wants doing today and only if it rings before that
            // day's local midnight: the web's Snooze stores the tap plus
            // fifteen minutes with no gate, so one tapped at 23:55 arrives as
            // 00:10 tomorrow, which the server would never ring. Not gated on
            // a cue time: Snooze can be tapped on a last call. An instant
            // nobody can read is no snooze at all, as hasMatured reads it.
            let untilMs = snooze.flatMap { parseEpochMs($0.until) }
            var pending = false
            if let snooze, untilMs != nil, snooze.date == todayStr, !hasMatured(snooze.until, nowMs: nowMs) {
                pending = true
            }
            if pending, wantedToday, let snooze, let untilMs,
               ringsOnDay(fireMs: untilMs, zone: input.timeZone, dayStr: snooze.date) {
                fixed.append(cue(snoozeId, .snoozed, .afterMs(untilMs - nowMs), untilMs, snooze.date))
                snoozedDay[item.id] = snooze.date
            }

            guard let minutes, let at else { continue }

            // Armed inside its own window: no trigger is left to ring today,
            // and the server would still be sending it. Never while a snooze
            // from today is pending, armed or expired at midnight: either is
            // the user's word on when to ask again.
            if !pending && wantedToday && isWithinWindow(minutes, now: nowMinutes, grace: input.graceMinutes)
                && !input.localSentKeys.contains(sentKeyFor(todayStr, at)) {
                fixed.append(cue("\(base)#now", .catchUp, .now, nowMs, todayStr))
            }

            let plan = Cadence(
                base: base, minutes: minutes, today: today, zone: zone, nowMs: nowMs,
                wanted: wanted,
                gap: gapReporter(minutes, item.id),
                once: { id, next in
                    let day = next.day.description
                    return cue(id, .cue, .at(dateStr: day, hhmm: at), next.at, day)
                },
                standing: { slot, firesAt in
                    cue(slot.id, .cue, calendarTrigger(minutes, weekday: slot.weekday, day: slot.day), firesAt)
                }
            )
            let requests: [PlannedRequest]
            switch onChangeover(minutes) ? CueCadence.oneOffs : slotsOf(item, today: today) {
            case .oneOffs: requests = plan.series()
            case .slots(let slots): requests = plan.stand(slots)
            }
            if !requests.isEmpty { asks.append(Ask(itemId: item.id, requests: requests.sorted(by: byFireThenId))) }
        }
    }

    // MARK: The budget

    var taken: [PlannedRequest] = []
    var pendingCount = 0
    var short = Set<UUID>()
    var reviewShort = false
    /// Take `request` if it fits; a catch-up always does, since it is never pending.
    func take(_ request: PlannedRequest) -> Bool {
        if case .now = request.trigger {} else {
            if pendingCount >= budget { return false }
            pendingCount += 1
        }
        taken.append(request)
        return true
    }
    /// Take `request`, or note its owner short unless it was only a second one-off.
    func place(_ request: PlannedRequest) {
        if take(request) || request.id.hasSuffix("#next") { return }
        if request.kind == .eod {
            reviewShort = true
        } else if let itemId = request.itemId {
            short.insert(itemId)
        }
    }

    // The review's soonest first (it is never absent), then snoozes (the user
    // asked for each one by name), then catch-ups; each by when it rings.
    if let first = reviewAsk.first { place(first) }
    func rank(_ kind: PlannedKind) -> Int {
        switch kind {
        case .eod: return 0
        case .snoozed: return 1
        case .catchUp: return 2
        case .cue: return 3
        }
    }
    fixed.sort { a, b in
        rank(a.kind) != rank(b.kind) ? rank(a.kind) < rank(b.kind) : byFireThenId(a, b)
    }
    for request in fixed { place(request) }

    // One request per item, soonest first.
    asks.sort { byFireThenId($0.requests[0], $1.requests[0]) }
    for ask in asks { place(ask.requests[0]) }

    // Then everyone's others, the review's among them, in the order they ring.
    let others = ([reviewAsk] + asks.map(\.requests)).flatMap { $0.dropFirst() }
    for request in others.sorted(by: byFireThenId) { place(request) }

    if reviewShort { notes.append(.overBudget(itemId: nil, kept: taken.filter { $0.kind == .eod }.count)) }
    for itemId in short.sorted(by: { codeUnitLess(idString($0), idString($1)) }) {
        let kept = taken.filter { $0.itemId == itemId && $0.kind == .cue }.count
        notes.append(.overBudget(itemId: itemId, kept: kept))
    }

    // MARK: The shade

    var withdraw = Set<String>()
    let eodIds = Set(eodIdentifiers())
    // The item a delivered identifier names, by the string the web compares:
    // the lower-case id, as the server writes it.
    var itemById: [String: Item] = [:]
    for item in input.items { itemById[idString(item.id)] = item }
    /// JavaScript's Date range: an instant past it is no day at all.
    let maxDateMs = 8_640_000_000_000_000
    for delivered in input.delivered {
        // The day it is about: its own, or the local day it rang on.
        let day: String
        if let own = delivered.dateStr, isDayShaped(own) {
            day = own
        } else if abs(delivered.deliveredAtMs) <= maxDateMs {
            day = wallClock(delivered.deliveredAtMs, zone).day.description
        } else {
            continue
        }

        if eodIds.contains(delivered.id) {
            // Answered: the review recorded for that day or a later one
            // (lib/eod.ts reviewedDay files a review finished after midnight
            // under the night it was for, so the invitation it answered is
            // that night's).
            if let eod = input.eod {
                let reviewed = eod.lastReviewDate.map { !codeUnitLess($0, day) } ?? false
                if !eod.enabled || reviewed { withdraw.insert(delivered.id) }
            }
            continue
        }

        guard let itemId = itemIdOf(delivered.id) else { continue }
        let stale: Bool
        if !input.remindersEnabled {
            stale = true
        } else if let item = itemById[itemId] {
            let snoozedThatDay = snoozedDay[item.id] == day && delivered.id != "\(itemIdentifier(item.id))#snooze"
            stale = !isRemindable(item) || !wantsDoingOn(item, on: day, ctx) || snoozedThatDay
        } else {
            stale = true
        }
        if stale { withdraw.insert(delivered.id) }
    }

    return NotificationPlan(
        requests: taken.sorted(by: byFireThenId),
        withdraw: withdraw.sorted(by: codeUnitLess),
        notes: notes
    )
}
