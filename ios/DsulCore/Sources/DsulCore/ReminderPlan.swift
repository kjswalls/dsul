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
// THE SHAPES (decision 23: a standing trigger is never replaced by a bare
// one-off, which fires once and does not launch the app):
// - a calendar cadence (daily; one weekday; a day of the month up to the
//   28th) is ONE repeating calendar trigger under `dsul-item-<id>`;
// - two to six weekdays are one calendar trigger per weekday,
//   `dsul-item-<id>#<weekday>` (1 = Sunday … 7 = Saturday);
// - when a slot's own next ring is not the next WANTED cue (today handled, its
//   cue still to come), the slot keeps its identifier and becomes a repeating
//   interval trigger first ringing at the next wanted cue; the first plan
//   after today's cue time puts the calendar trigger back;
// - one-offs where no cadence stands: a dated task, a series not yet begun, a
//   day of the month after the 28th, a cue time in 01:00–03:59 (no repeating
//   trigger on a daylight-saving boundary), a weekday set the budget cannot
//   hold; each the next wanted cue under `dsul-item-<id>` and, while the budget
//   allows, the one after under `#next`;
// - a snooze is a one-off under `#snooze`, beside the standing trigger, and
//   withdraws the delivered cue it replaces;
// - a cue armed inside its own window rings now (`#now`), once per device;
// - the review is a standing daily trigger under `dsul-eod`, never removed
//   while it is on (reviewed today before its hour: the same interval swap);
//   in 01:00–03:59, one-offs (`dsul-eod`, `dsul-eod#next`). No catch-up.
//
// The budget: 60 requests (of the OS's 64 pending), spent in passes: the
// review, live snoozes and catch-ups; then ONE request per item, soonest
// first; then each weekday set's full slots while they fit; then the second
// one-offs. An item that loses anything gets an over-budget note.
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
/// - `interval`: UNTimeIntervalNotificationTrigger(timeInterval: seconds,
///   repeats: true), which first fires `seconds` after it is ADDED, so
///   `seconds` runs from the plan's instant to `anchorAt` (the next wanted
///   cue). Added later than the plan's instant, recompute it as
///   max(60, ceil((anchorAt − now) / 1000));
/// - `at`: a one-off UNCalendarNotificationTrigger with the full date
///   (year, month, day from `dateStr`, hour and minute from `hhmm`);
/// - `afterMs`: a one-off UNTimeIntervalNotificationTrigger, `ms` after the
///   plan's instant;
/// - `now`: no trigger; delivered at once.
public enum PlannedTrigger: Sendable, Hashable {
    case calendar(hour: Int, minute: Int, weekday: Int?, day: Int?)
    case interval(seconds: Int, anchorAt: Int)
    case at(dateStr: String, hhmm: String)
    case afterMs(Int)
    case now

    /// The web's discriminator: "calendar", "interval", "at", "afterMs", "now".
    public var type: String {
        switch self {
        case .calendar: return "calendar"
        case .interval: return "interval"
        case .at: return "at"
        case .afterMs: return "afterMs"
        case .now: return "now"
        }
    }

    /// Whether the trigger repeats: the calendar and the interval do.
    public var repeats: Bool {
        switch self {
        case .calendar, .interval: return true
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
    /// has none: the delegate takes the local day of the notification's date.
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

/// lib/reminders/plan.ts `eodIdentifiers`: the review's standing trigger and
/// its second one-off in the small hours.
public func eodIdentifiers() -> [String] {
    return [eodIdentifier, "\(eodIdentifier)#next"]
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

/// What one item asks of the budget.
private struct ItemAsk {
    let itemId: UUID
    /// The one request it must have to ring at all.
    let primary: PlannedRequest
    /// Its weekday slots, which replace the primary while the budget allows.
    var upgrade: [PlannedRequest]?
    /// The one-off after the primary, while the budget allows.
    var secondary: PlannedRequest?
}

/// Whose spring-forward gap a cue search reports, if anyone's.
private enum GapReport {
    case silent
    case review
    case item(UUID)
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

/// `Math.ceil(a / b)` for b > 0.
private func ceilDiv(_ a: Int, _ b: Int) -> Int {
    return -floorDiv(-a, b)
}

private func calendarTrigger(_ minutes: Int, weekday: Int? = nil, day: Int? = nil) -> PlannedTrigger {
    return .calendar(hour: minutes / 60, minute: minutes % 60, weekday: weekday, day: day)
}

/// The interval trigger whose first ring is `anchorAt`: whole seconds, rounded
/// up so it never rings before the cue, and at least the 60 a repeating
/// interval trigger must have.
private func intervalTrigger(_ anchorAt: Int, nowMs: Int) -> PlannedTrigger {
    return .interval(seconds: max(60, ceilDiv(anchorAt - nowMs, 1000)), anchorAt: anchorAt)
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
    let daily = Slot(id: base, weekday: nil, day: nil, rings: { _ in true })
    func weekdays(_ days: [Int]?) -> [Slot] {
        let set = Array(Set((days ?? []).filter { (0...6).contains($0) })).sorted()
        if set.count == 7 { return [daily] }
        if set.count == 1 {
            let w = set[0]
            return [Slot(id: base, weekday: w + 1, day: nil, rings: { $0.weekday == w })]
        }
        return set.map { w in Slot(id: "\(base)#\(w + 1)", weekday: w + 1, day: nil, rings: { $0.weekday == w }) }
    }

    switch item.repeatFrequency {
    case "daily":
        return .slots([daily])
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
    var asks: [ItemAsk] = []
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

    // MARK: The review

    var eodSecondary: PlannedRequest?
    if let eod = input.eod, eod.enabled {
        if let minutes = eodMinutesOfDay(eod.time) {
            // Owed is any day not already recorded as reviewed (lib/eod.ts
            // isEodOwed, minus the hour). Only today can be.
            let wanted: (DayString) -> Bool = { $0.description != eod.lastReviewDate }
            func review(_ id: String, _ trigger: PlannedTrigger, _ firesAt: Int, _ dateStr: String? = nil) -> PlannedRequest {
                return PlannedRequest(
                    id: id, kind: .eod, itemId: nil, dateStr: dateStr, trigger: trigger, firesAt: firesAt,
                    title: eodCopy.title, body: eodCopy.body, threadId: ritualThread,
                    summaryArgument: eodCopy.title, categoryId: eodCategory, level: .active, relevance: 0,
                    userInfo: PlannedUserInfo(kind: .eod, dateStr: dateStr)
                )
            }

            if inDstBand(minutes) {
                if let first = nextCue(from: today, minutes, .review, accept: wanted) {
                    let firstDay = first.day.description
                    fixed.append(review(eodIdentifier, .at(dateStr: firstDay, hhmm: clockText(minutes)), first.at, firstDay))
                    if let second = nextCue(from: first.day.adding(days: 1), minutes, .review, accept: wanted) {
                        let secondDay = second.day.description
                        eodSecondary = review(
                            "\(eodIdentifier)#next", .at(dateStr: secondDay, hhmm: clockText(minutes)), second.at, secondDay
                        )
                    }
                }
            } else {
                let rings = nextCue(from: today, minutes, .silent) { _ in true }
                if let next = nextCue(from: today, minutes, .review, accept: wanted) {
                    if let rings, rings.day == next.day {
                        fixed.append(review(eodIdentifier, calendarTrigger(minutes), rings.at))
                    } else {
                        fixed.append(review(eodIdentifier, intervalTrigger(next.at, nowMs: nowMs), next.at))
                    }
                }
            }
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

            // A snooze belongs to its day, as in dueReminders: one for another
            // day never rings, one already matured has rung, and one on an
            // item no longer wanted today would re-ask something answered.
            // Not gated on a cue time: Snooze can be tapped on a last call.
            var snoozed = false
            if let snooze, snooze.date == todayStr, wantedToday, !hasMatured(snooze.until, nowMs: nowMs),
               let untilMs = parseEpochMs(snooze.until) {
                snoozed = true
                fixed.append(cue(snoozeId, .snoozed, .afterMs(untilMs - nowMs), untilMs, snooze.date))
                // The snooze replaces whichever of the item's cues is in the shade.
                for id in own where id != snoozeId { withdraw.insert(id) }
            }

            guard let minutes, let at else { continue }

            // Armed inside its own window: no trigger is left to ring today,
            // and the server would still be sending it. Never beside a live
            // snooze, which is the user's word on when to ask again.
            if !snoozed && wantedToday && isWithinWindow(minutes, now: nowMinutes, grace: input.graceMinutes)
                && !input.localSentKeys.contains(sentKeyFor(todayStr, at)) {
                fixed.append(cue("\(base)#now", .catchUp, .now, nowMs, todayStr))
            }

            let wanted: (DayString) -> Bool = { wantsDoingOn(item, on: $0, ctx) }
            func oneOff(_ id: String, _ c: PlannedCue) -> PlannedRequest {
                let day = c.day.description
                return cue(id, .cue, .at(dateStr: day, hhmm: at), c.at, day)
            }
            func oneOffs() -> (primary: PlannedRequest, secondary: PlannedRequest?)? {
                guard let first = nextCue(from: today, minutes, .item(item.id), accept: wanted) else { return nil }
                let second = nextCue(from: first.day.adding(days: 1), minutes, .item(item.id), accept: wanted)
                return (oneOff(base, first), second.map { oneOff("\(base)#next", $0) })
            }

            switch slotsOf(item, minutes: minutes, today: today) {
            case .oneOffs:
                if let series = oneOffs() {
                    asks.append(ItemAsk(itemId: item.id, primary: series.primary, secondary: series.secondary))
                }
            case .slots(let slots):
                // Each slot: its calendar trigger when that trigger's own next
                // ring is the next wanted cue on its days, else the interval
                // trigger anchored at that cue (decision 23). A slot with no
                // wanted cue within the horizon plans nothing.
                let planned: [PlannedRequest] = slots.compactMap { slot in
                    let rings = nextCue(from: today, minutes, .silent, accept: slot.rings)
                    guard let next = nextCue(from: today, minutes, .item(item.id), accept: { slot.rings($0) && wanted($0) })
                    else { return nil }
                    if let rings, rings.day == next.day {
                        return cue(slot.id, .cue, calendarTrigger(minutes, weekday: slot.weekday, day: slot.day), rings.at)
                    }
                    return cue(slot.id, .cue, intervalTrigger(next.at, nowMs: nowMs), next.at)
                }
                if planned.isEmpty { continue }
                if slots.count == 1 {
                    asks.append(ItemAsk(itemId: item.id, primary: planned[0]))
                    continue
                }
                // A weekday set rides the budget as one one-off until its slots fit.
                if let series = oneOffs() {
                    asks.append(ItemAsk(
                        itemId: item.id, primary: series.primary, upgrade: planned, secondary: series.secondary
                    ))
                }
            }
        }
    }

    // MARK: The budget

    var taken: [PlannedRequest] = []
    var short = Set<UUID>()
    var eodShort = false

    // The review first (it is never removed), then snoozes (the user asked for
    // each by name), then catch-ups; each by when it rings.
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
        if taken.count < budget {
            taken.append(request)
        } else if let itemId = request.itemId {
            short.insert(itemId)
        } else {
            eodShort = true
        }
    }

    asks.sort { byFireThenId($0.primary, $1.primary) }
    var placed: [ItemAsk] = []
    for ask in asks {
        if taken.count < budget {
            taken.append(ask.primary)
            placed.append(ask)
        } else {
            short.insert(ask.itemId)
        }
    }

    var upgraded = Set<UUID>()
    for ask in placed {
        guard let upgrade = ask.upgrade else { continue }
        if taken.count - 1 + upgrade.count <= budget,
           let index = taken.firstIndex(where: { $0.id == ask.primary.id }) {
            taken.replaceSubrange(index...index, with: upgrade)
            upgraded.insert(ask.itemId)
        } else {
            short.insert(ask.itemId)
        }
    }

    var seconds = placed.compactMap { ask in upgraded.contains(ask.itemId) ? nil : ask.secondary }
    if let eodSecondary, taken.contains(where: { $0.id == eodIdentifier }) { seconds.append(eodSecondary) }
    for request in seconds.sorted(by: byFireThenId) where taken.count < budget {
        taken.append(request)
    }

    if eodShort { notes.append(.overBudget(itemId: nil, kept: 0)) }
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
