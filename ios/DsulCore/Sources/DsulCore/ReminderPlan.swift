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
// it and one instant, which UNNotificationRequests should be pending, under
// which identifiers, with which triggers and words, and which delivered ones
// are stale. The hosted scheduler diffs that against what is pending and
// delivered; it decides nothing itself.
//
// It never decides whether an item wants doing (that is `wantsDoingOn`,
// ReminderDue.swift, asked once per candidate day), never writes a sentence
// (`reminderCopy` and `eodCopy`, ReminderCopy.swift), and plans NO last call
// (design decision 24: a list worked out at the last plan can name a habit
// done elsewhere since, the one scold the copy contract cannot send).
//
// THE SHAPES. Two rules bind them: a phone left alone must not fall silent
// (decision 23: a one-off fires once and does not launch the app), and every
// ring lands on its own minute, on a day the item occurs.
// - a calendar cadence (daily; one weekday; a day of the month up to the
//   28th) is ONE repeating calendar trigger under `dsul-item-<id>`;
// - two to six weekdays are one calendar trigger per weekday,
//   `dsul-item-<id>#<weekday>` (1 = Sunday … 7 = Saturday);
// - a slot whose own next ring is not the next WANTED cue on its days is HELD
//   (today handled before its cue, or a pause or season over its next ring).
//   A held weekday of a split is a one-off at that weekday's next wanted cue,
//   under the same `#<weekday>`. A held daily slot splits into `#1` … `#7` by
//   the same rule, so six days keep standing and today's weekday is a one-off
//   a week out. A held lone weekday or day of the month is the one-off series
//   below. The first plan after the held day puts the calendar trigger back;
// - NO repeating interval trigger (where the web departs from decision 23's
//   letter): UNTimeIntervalNotificationTrigger has no start date, so a
//   repeating one first rings `seconds` after it is added and then every
//   `seconds`, and cannot both start at the next wanted cue and repeat on the
//   cadence. Anchored, its later rings drift off the minute and onto days the
//   item does not occur, where a Done credits the wrong day;
// - one-offs where no cadence stands: a dated task, a series not yet begun, a
//   day of the month after the 28th, a cue time in 01:00–03:59 (no repeating
//   trigger on a daylight-saving boundary), a held lone weekday or month day,
//   and a weekday set or a held daily's seven that the budget cannot hold;
//   each the next wanted cue under `dsul-item-<id>` and, while the budget
//   allows, the one after under `#next`;
// - a snooze is a one-off under `#snooze`, beside the standing trigger, and
//   withdraws the delivered cue it replaces. It belongs to its day: one that
//   would ring past that day's local midnight has expired (`ringsOnDay`,
//   ReminderSnooze.swift), as it has on the server;
// - a cue armed inside its own window rings now (`#now`), once per device,
//   never while a snooze from today is pending (armed, or expired at midnight);
// - the review is a standing daily trigger under `dsul-eod`, never removed
//   while it is on; reviewed today before its hour it is held as a daily cue
//   is (a one-off at tomorrow's hour under `dsul-eod`, `#next` the day after,
//   splitting into `dsul-eod#1` … `#7` while the budget allows); in
//   01:00–03:59, one-offs (`dsul-eod`, `dsul-eod#next`). No catch-up.
//
// What is left: a held lone weekday rings twice, a week apart, and a held
// month day twice, a month apart, then waits for dsul to open; a held daily
// without room for its seven rings tomorrow and the day after; with its seven,
// only today's weekday waits, and only from a week on.
//
// The budget: 60 requests (of the OS's 64 pending), spent in passes: the
// review's one request, live snoozes, then catch-ups; then ONE request per
// item, soonest first; then each split its slots (the review's first, then in
// the order the first requests were placed) while they fit; then the second
// one-offs of what was not split. An item, or the review, that loses anything
// but its second one-off gets an over-budget note.
//
// Swift shapes: instants are epoch milliseconds (`Int`), item ids are `UUID`s
// written lower-case in identifiers and orderings (as the server writes them;
// the web orders the same strings by code unit), and the trigger and the
// note are enums where the web has tagged objects. Nothing reads the clock.

/// lib/reminders/plan.ts `NOTIFICATION_BUDGET`: 60 of the OS's 64 pending.
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

/// Cue times in [01:00, 04:00) are planned as one-offs.
let dstBandStart = 60
let dstBandEnd = 240
/// How far ahead a next wanted cue is looked for: a year.
let planHorizonDays = 366

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
/// - `now`: no trigger; delivered at once.
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
/// - `overBudget`: the item (no item: the review) lost requests to the
///   budget; `kept` is how many of its cue requests remain.
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
/// projects it (`reminder_snooze_until/date`).
public struct PlanSnooze: Sendable, Hashable {
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
    /// no snooze and no catch-up; the review has its own switch.
    public var remindersEnabled: Bool
    public var eod: PlanEod?
    public var snoozes: [PlanSnooze]
    /// `sentKeyFor(day, at)` of every cue this device has rung or had armed at
    /// its minute. The scheduler adds a catch-up's key the moment it adds it.
    public var localSentKeys: Set<String>
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
        self.graceMinutes = graceMinutes
        self.budget = budget
    }
}

/// lib/reminders/plan.ts `NotificationPlan`.
public struct NotificationPlan: Sendable, Hashable {
    /// Every request that should be pending, ordered by firesAt, then id.
    public var requests: [PlannedRequest]
    /// Identifiers to remove from the DELIVERED notifications, sorted. Pending
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

/// What one item, or the review, asks of the budget: the one-off series (the
/// next wanted cue, and the one after it) or a lone calendar trigger, and the
/// split that replaces the primary while the budget allows.
private struct Ask {
    /// The item's id; nil for the review.
    var itemId: UUID?
    /// The one request it must have to ring at all.
    let primary: PlannedRequest
    /// The one-off after the primary, while the budget allows.
    var secondary: PlannedRequest?
    /// Its weekday slots, which replace the primary while the budget allows.
    var upgrade: [PlannedRequest]?
}

/// Whose spring-forward gap a cue search reports, if anyone's.
private enum GapReport {
    case silent
    case review
    case item(UUID)
}

/// lib/reminders/plan.ts `cadence`'s arguments: how one cadence, an item's or
/// the review's, is planned. `once` makes its one-off for a cue and `standing`
/// its calendar trigger for a slot; the rest is the same for both.
private struct CadenceRules {
    let base: String
    let minutes: Int
    let gaps: GapReport
    let wanted: (DayString) -> Bool
    let once: (String, PlannedCue) -> PlannedRequest
    let standing: (Slot, Int) -> PlannedRequest
}

private func inDstBand(_ minutes: Int) -> Bool {
    return minutes >= dstBandStart && minutes < dstBandEnd
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

/// lib/reminders/plan.ts `slotsOf`: the standing slots an item's cadence can
/// stand on, or `.oneOffs` when it has none. An empty list is a cadence that
/// rings on no day (custom with no days): no request, as `occursOn`.
private func slotsOf(_ item: Item, minutes: Int, today: DayString) -> CueCadence {
    if inDstBand(minutes) { return .oneOffs }
    if !isRecurring(item.rule) { return .oneOffs }
    let startDate = truthyText(item.startDate).map(toDateOnly)
    if caps(item.typeName).dateAnchored {
        // A series not yet begun: its start day need not be a repeat day.
        guard let startDate, startDate < today.description else { return .oneOffs }
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
        // A calendar trigger on the 31st skips every shorter month, where
        // occursOn clamps to the last day: past the 28th, one-offs.
        if let monthDay = item.repeatMonthDay, (1...28).contains(monthDay) {
            return .slots([Slot(id: base, weekday: nil, day: monthDay, rings: { $0.day == monthDay })])
        }
        return .oneOffs
    default:
        return .oneOffs
    }
}

// MARK: - The plan

/// lib/reminders/plan.ts `planNotifications`: the requests that should be
/// pending at `input.nowMs`, the delivered identifiers to withdraw, and notes
/// on what could not be planned. Pure; see the header for the rules.
public func planNotifications(_ input: PlanInput) -> NotificationPlan {
    let nowMs = input.nowMs
    guard let zone = TimeZone(identifier: input.timeZone) else {
        return NotificationPlan(requests: [], withdraw: [], notes: [.badZone(value: input.timeZone)])
    }
    let (today, nowMinutes) = wallClock(nowMs, zone)
    let todayStr = today.description

    let ctx = ActivationContext(timeZone: input.timeZone, routines: input.routines, seasons: input.seasons)
    let budget = input.budget

    var notes: [PlanNote] = []
    var fixed: [PlannedRequest] = []
    var asks: [Ask] = []
    var reviewAsk: Ask?
    var withdraw = Set<String>()
    var gapsSeen = Set<String>()

    /// Report a skipped spring-forward minute once, and only if it was still to come.
    func reportGap(_ day: DayString, _ minutes: Int, _ itemId: UUID?) {
        if day == today && minutes <= nowMinutes { return }
        let key = "\(itemId.map(idString) ?? "")|\(day)"
        guard gapsSeen.insert(key).inserted else { return }
        notes.append(.dstGap(itemId: itemId, dateStr: day.description, at: clockText(minutes)))
    }

    /// The first cue at `minutes`, on a day from `start` on that `accept`
    /// takes, that is still to come. A day whose minute does not exist is
    /// passed over (and reported, when asked); nothing moves to another minute.
    func nextCue(from start: DayString, _ minutes: Int, _ gaps: GapReport, accept: (DayString) -> Bool) -> PlannedCue? {
        var day = start
        for i in 0..<planHorizonDays {
            if i > 0 { day = day.adding(days: 1) }
            if !accept(day) { continue }
            guard let at = instantOf(day, minutes, zone) else {
                switch gaps {
                case .silent: break
                case .review: reportGap(day, minutes, nil)
                case .item(let id): reportGap(day, minutes, id)
                }
                continue
            }
            if at > nowMs { return PlannedCue(day: day, at: at) }
        }
        return nil
    }

    /// The next wanted cue under the base identifier and, when there is one,
    /// the one after under `#next`.
    func series(_ c: CadenceRules) -> Ask? {
        guard let first = nextCue(from: today, c.minutes, c.gaps, accept: c.wanted) else { return nil }
        let second = nextCue(from: first.day.adding(days: 1), c.minutes, c.gaps, accept: c.wanted)
        return Ask(itemId: nil, primary: c.once(c.base, first), secondary: second.map { c.once("\(c.base)#next", $0) })
    }

    /// One slot: its calendar trigger when that trigger's own next ring is the
    /// next wanted cue on its days, else (held) a one-off at that cue under the
    /// slot's own identifier, else nothing (no wanted cue within the horizon:
    /// paused with no end, a season over for good).
    func slot(_ s: Slot, _ c: CadenceRules) -> PlannedRequest? {
        let rings = nextCue(from: today, c.minutes, .silent, accept: s.rings)
        guard let next = nextCue(from: today, c.minutes, c.gaps, accept: { s.rings($0) && c.wanted($0) }) else {
            return nil
        }
        if let rings, rings.day == next.day { return c.standing(s, rings.at) }
        return c.once(s.id, next)
    }

    /// What standing `slots` ask: the calendar trigger alone, or the series
    /// with a split to upgrade to.
    func stand(_ slots: [Slot], _ c: CadenceRules) -> Ask? {
        if slots.count == 1 {
            let only = slots[0]
            guard let own = slot(only, c) else { return nil }
            if case .calendar = own.trigger { return Ask(itemId: nil, primary: own) }
            guard var held = series(c) else { return nil }
            // A lone weekday or day of the month has no other day to stand on.
            if only.weekday != nil || only.day != nil { return held }
            // A daily slot splits, so the other six days keep standing.
            held.upgrade = weekdaySlots(c.base, Array(0...6)).compactMap { slot($0, c) }
            return held
        }
        // A weekday set rides the budget as one one-off until its slots fit.
        let planned = slots.compactMap { slot($0, c) }
        if planned.isEmpty { return nil }
        guard var held = series(c) else { return nil }
        held.upgrade = planned
        return held
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
            let rules = CadenceRules(
                base: eodIdentifier,
                minutes: minutes,
                gaps: .review,
                // Owed is any day not already recorded as reviewed (lib/eod.ts
                // isEodOwed, minus the hour). Only today can be.
                wanted: { $0.description != eod.lastReviewDate },
                once: { id, next in
                    review(id, .at(dateStr: next.day.description, hhmm: clockText(minutes)), next.at, next.day.description)
                },
                standing: { slot, at in review(slot.id, calendarTrigger(minutes, weekday: slot.weekday), at) }
            )
            reviewAsk = inDstBand(minutes) ? series(rules) : stand([dailySlot(eodIdentifier)], rules)
            // Done today: the invitation in the shade has been answered.
            if eod.lastReviewDate == todayStr { withdraw.formUnion(eodIdentifiers()) }
        } else {
            notes.append(.badTime(itemId: nil, value: eod.time))
        }
    }

    // MARK: The items

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

            let snooze = snoozeOf[item.id]
            let wantedToday = wantsDoingOn(item, on: today, ctx)
            let own = identifiers(for: item.id)
            let base = itemIdentifier(item.id)
            let snoozeId = "\(base)#snooze"

            // Handled today (done, skipped, tallied, paused, season-inactive):
            // what is in the shade about it asks for something already answered.
            if (minutes != nil || snooze != nil)
                && occursOn(item, on: todayStr, timeZone: input.timeZone) && !wantedToday {
                withdraw.formUnion(own)
            }

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
                // The snooze replaces whichever of the item's cues is in the shade.
                for id in own where id != snoozeId { withdraw.insert(id) }
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

            let rules = CadenceRules(
                base: base,
                minutes: minutes,
                gaps: .item(item.id),
                wanted: { wantsDoingOn(item, on: $0, ctx) },
                once: { id, next in
                    let day = next.day.description
                    return cue(id, .cue, .at(dateStr: day, hhmm: at), next.at, day)
                },
                standing: { slot, firesAt in
                    cue(slot.id, .cue, calendarTrigger(minutes, weekday: slot.weekday, day: slot.day), firesAt)
                }
            )
            let ask: Ask?
            switch slotsOf(item, minutes: minutes, today: today) {
            case .oneOffs: ask = series(rules)
            case .slots(let slots): ask = stand(slots, rules)
            }
            if var ask {
                ask.itemId = item.id
                asks.append(ask)
            }
        }
    }

    // MARK: The budget

    var taken: [PlannedRequest] = []
    var placed: [Ask] = []
    var short = Set<UUID>()
    var reviewShort = false
    func take(_ request: PlannedRequest) -> Bool {
        guard taken.count < budget else { return false }
        taken.append(request)
        return true
    }

    // The review first (it is never removed), then snoozes (the user asked for
    // each by name), then catch-ups; each by when it rings.
    if let reviewAsk {
        if take(reviewAsk.primary) { placed.append(reviewAsk) } else { reviewShort = true }
    }
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
    for request in fixed {
        if !take(request), let itemId = request.itemId { short.insert(itemId) }
    }

    // One request per item, soonest first.
    asks.sort { byFireThenId($0.primary, $1.primary) }
    for ask in asks {
        if take(ask.primary) {
            placed.append(ask)
        } else if let itemId = ask.itemId {
            short.insert(itemId)
        }
    }

    // Each split its slots, in the order the first requests were placed.
    var upgraded = Set<Int>()
    for (index, ask) in placed.enumerated() {
        guard let upgrade = ask.upgrade, !upgrade.isEmpty else { continue }
        if taken.count - 1 + upgrade.count <= budget,
           let at = taken.firstIndex(where: { $0.id == ask.primary.id }) {
            taken.replaceSubrange(at...at, with: upgrade)
            upgraded.insert(index)
        } else if let itemId = ask.itemId {
            short.insert(itemId)
        } else {
            reviewShort = true
        }
    }

    // Then the second one-offs of what was not split.
    let seconds = placed.enumerated().compactMap { index, ask in upgraded.contains(index) ? nil : ask.secondary }
    for request in seconds.sorted(by: byFireThenId) { _ = take(request) }

    if reviewShort { notes.append(.overBudget(itemId: nil, kept: taken.filter { $0.kind == .eod }.count)) }
    for itemId in short.sorted(by: { codeUnitLess(idString($0), idString($1)) }) {
        let kept = taken.filter { $0.itemId == itemId && $0.kind == .cue }.count
        notes.append(.overBudget(itemId: itemId, kept: kept))
    }

    return NotificationPlan(
        requests: taken.sorted(by: byFireThenId),
        withdraw: withdraw.sorted(by: codeUnitLess),
        notes: notes
    )
}
