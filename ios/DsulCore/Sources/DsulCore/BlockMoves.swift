import Foundation

// Port of lib/block-moves.ts `planBlockDrop` (Week and blocks PR 7): what
// dropping a schedule block MEANS, one rule for the web and the phone. It
// answers an end state (place, retime, anytime, braindump, pause, none or a
// refusal), never how a client writes it; the phone maps each answer to an
// item intent (PR 8), the web to a store call (PR 11). Keep in step: a change
// there without the same change here is drift, and a block lands in one place
// on the phone and another on the web. Checked against the web by
// BlockMovesFixtureTests (tests/fixtures/day/block-moves.json, written by
// tests/unit/block-moves-fixtures.test.ts from the real TS).
//
// Keyed on the registry, never on task vs habit: `dateAnchored`
// (lib/item-registry.ts, the custom slug for a custom item), whether the item
// repeats (lib/recurrence.ts `isRecurring`), `inProjectBlock`, and the gates
// the verbs already ask: Move to Braindump's (lib/row-moves.ts
// `canSendToBraindump`), the registry's `isPausable`, and the braindump's own
// member test (lib/braindump-members.ts, `isTaskScheduled` and
// `braindumpMembers` in DayItems.swift). An hour's part of day is
// lib/time-bucket.ts `getBucketForTime` (`bucketForTime`, DayBuckets.swift).
//
// Days stay yyyy-MM-dd strings compared as strings, as on the web (and as
// RowMoves.swift keeps them): an hour's "already there" asks for the stored
// `startDate` to EQUAL the target's day, so a legacy ISO date is rewritten
// clean, while Anytime compares the date cut at "T". Optional text columns are
// read with JavaScript's truthiness: an empty string is absent. Minutes are an
// `Int`, so the web's `Number.isInteger` check is the type's; the range check
// (0 to 1439) is kept. The milestone ids are the caller's
// (`milestoneItemIds` over the payload's goals, Goals.swift), nil while
// unknown, and only the braindump reads them.

/// Where the block was lifted from: the day it was drawn on (yyyy-MM-dd), and
/// whether that day's occurrence is skipped. The client knows it drew a
/// skipped strip, so the rule never reads `skippedDates` for it.
public struct BlockOrigin: Sendable, Hashable {
    public var date: String
    public var skipped: Bool

    public init(date: String, skipped: Bool) {
        self.date = date
        self.skipped = skipped
    }

    /// The same origin from the phone's own day type.
    public init(day: DayString, skipped: Bool) {
        self.init(date: day.description, skipped: skipped)
    }
}

/// Where the block was let go: an hour (`startMin` minutes after midnight on
/// `date`), a day's Anytime, or the braindump sheet.
public enum BlockTarget: Sendable, Hashable {
    case hour(date: String, startMin: Int)
    case anytime(date: String)
    case braindump
}

/// What the rule reads beyond the item and the drop.
public struct BlockDropContext: Sendable, Hashable {
    /// Every goal's milestone ids, or nil while they are unknown (a payload
    /// whose `goals` is nil). Read only by the braindump drop, which refuses
    /// a dated item while it is nil.
    public var milestoneIds: Set<UUID>?

    public init(milestoneIds: Set<UUID>?) {
        self.milestoneIds = milestoneIds
    }
}

/// Why a drop does nothing, in the web's words (`BlockDropRefusal`).
public enum BlockDropRefusal: String, Sendable, Hashable, CaseIterable {
    /// The occurrence on the origin day is skipped.
    case skipped
    /// Anytime, for a task drawn inside a project block.
    case inBlock = "in-block"
    /// Another day's Anytime, for an item whose date the drop may not change.
    case anotherDay = "another-day"
    /// The braindump, for a dated item Move to Braindump refuses.
    case notBraindump = "not-braindump"
    /// The braindump, while the milestone ids are not known.
    case milestonesUnknown = "milestones-unknown"
    /// The braindump, for an undated item the registry will not pause.
    case notPausable = "not-pausable"
    /// An hour target outside the day.
    case invalid
}

/// The rule's answer (`BlockDrop`). Two answers the web takes are refused on
/// the phone in v1, by its mapping and not here (the design's B15 and B22):
/// `.pause` (the phone's braindump never lists a paused habit) and
/// `.anytime(date:)` with a day (another column's Anytime).
public enum BlockDrop: Sendable, Hashable {
    /// On `date` at `startMin`: the item's date becomes `date`.
    case place(date: String, startMin: Int)
    /// At `startMin`, its date untouched.
    case retime(startMin: Int)
    /// Under Anytime with no time; a nil `date` keeps its date, a day moves
    /// it there.
    case anytime(date: String?)
    /// Back to the braindump.
    case braindump
    /// Paused.
    case pause
    /// Already there: nothing to write. Spell it `BlockDrop.none` wherever
    /// an Optional could take `.none` for its own.
    case none
    case refused(BlockDropRefusal)
}

/// lib/block-moves.ts `startTimeOf`: `startMin` as the stored "HH:MM"
/// (615 → "10:15"). Spelled as the web spells it for any minute, a negative
/// one included (`Math.floor` hours, a remainder that keeps its sign,
/// `padStart(2, '0')`), though the rule only asks it inside the day.
public func startTimeOf(_ startMin: Int) -> String {
    let hours = Int((Double(startMin) / 60).rounded(.down))
    let minutes = startMin % 60
    return "\(padStart2(hours)):\(padStart2(minutes))"
}

/// `String(n).padStart(2, '0')`.
private func padStart2(_ n: Int) -> String {
    let s = String(n)
    return s.count < 2 ? String(repeating: "0", count: 2 - s.count) + s : s
}

/// A non-empty string: JavaScript's truthiness for an optional text column.
private func present(_ s: String?) -> Bool {
    guard let s else { return false }
    return !s.isEmpty
}

/// `s.split('T')[0]`: a day, with a legacy ISO string's time cut off.
private func dayPart(_ s: String) -> String {
    return s.split(separator: "T", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
}

/// lib/block-moves.ts `typeNameOf`: the custom slug for a custom item that
/// has one, else the item's own `type` (so a habit answers as a habit).
private func typeNameOf(_ item: Item) -> String {
    if item.type == "custom", let slug = item.customType, !slug.isEmpty { return slug }
    return item.type
}

/// lib/block-moves.ts `hasStash`: a block's stashed time or date, which the
/// drop clears, so a row holding one is never "already there".
private func hasStash(_ item: Item) -> Bool {
    return present(item.previousStartTime) || present(item.previousStartDate)
}

/// lib/block-moves.ts `planBlockDrop`, in the web's order:
///
/// 1. A skipped origin is refused, whatever the target.
/// 2. An hour outside the day is refused. A dated series on the canvas (a
///    `startDate` to keep) and a type with no date are retimed on their own
///    day, a series in a project block excepted: it is placed on its own start
///    date, which releases it. Anything else (a one-off, a series with no
///    start date, or one still in the braindump) is placed on the target's
///    day. Its own place, stored exactly so, is `none`.
/// 3. Anytime: a task in a project block is refused. What may not change its
///    date takes only its own day's Anytime; a dated one-off moves to another
///    day's.
/// 4. The braindump: a row it already lists stays; a type with no date pauses
///    where the registry lets it; while the milestones are unknown a dated row
///    is refused; else Move to Braindump's gate decides (with the verb's and
///    the server's checks beside it: a start date, and not a subtask).
public func planBlockDrop(
    _ item: Item, from: BlockOrigin, target: BlockTarget, context: BlockDropContext
) -> BlockDrop {
    if from.skipped { return .refused(.skipped) }

    let anchored = caps(typeNameOf(item)).dateAnchored
    let series = isRecurring(item.rule)
    // Placed somewhere on the canvas, as the braindump's own placement test
    // asks it (`isTaskScheduled`, DayItems.swift): marked scheduled, or filed
    // under a part of day.
    let placed = isTaskScheduled(item)
    // The drop may not change this item's date: a series block keeps its
    // anchor, and a type with no date has none. A series with no start date is
    // drawn on no day, and one in the braindump is not a block at all, so a
    // drop gives it the day it lands on, as it does a one-off (and as the web's
    // braindump-to-grid drop does).
    let keepsDate = !anchored || (series && present(item.startDate) && placed)
    // On the grid as the web stores a placed row: a dated row says so with
    // `isScheduled`; an undated one is placed by its part of day alone.
    let onGrid = !anchored || item.isScheduled == true

    switch target {
    case let .hour(date, startMin):
        // `minutesPerDay` is the module's 1440 (ReminderDue.swift).
        guard startMin >= 0, startMin < minutesPerDay else { return .refused(.invalid) }
        let time = startTimeOf(startMin)
        let atTime = onGrid && item.inProjectBlock != true && !hasStash(item)
            && item.startTime == time && item.timeBucket == bucketForTime(time).rawValue
        if keepsDate {
            if anchored && item.inProjectBlock == true, let start = item.startDate {
                return .place(date: dayPart(start), startMin: startMin)
            }
            return atTime ? .none : .retime(startMin: startMin)
        }
        if atTime && item.startDate == date { return .none }
        return .place(date: date, startMin: startMin)

    case let .anytime(date):
        if item.inProjectBlock == true { return .refused(.inBlock) }
        let atAnytime = onGrid && item.timeBucket == DayBucket.anytime.rawValue
            && !present(item.startTime) && !hasStash(item)
        if keepsDate {
            if date != from.date { return .refused(.anotherDay) }
            return atAnytime ? .none : .anytime(date: nil)
        }
        // A dated one-off is drawn only on its own date, so another day's
        // Anytime (or any day's, for a row with no date yet) moves it there.
        if item.startDate.map(dayPart) != date { return .anytime(date: date) }
        return atAnytime ? .none : .anytime(date: nil)

    case .braindump:
        // The braindump already lists it (`braindumpMembers`, suppression
        // aside, which the rule is not given): a dated row placed nowhere that
        // is not let go, and an undated one placed nowhere that does not repeat
        // either.
        let member = !placed && (anchored ? item.status != "cancelled" : !series)
        if member { return .none }
        if !anchored { return isPausable(item) ? .pause : .refused(.notPausable) }
        guard let milestoneIds = context.milestoneIds else { return .refused(.milestonesUnknown) }
        // Move to Braindump's gate: the verb's (lib/verb-gates.ts, a row with a
        // day to take away) and the server's (lib/item-intents.ts
        // `applyUnschedule`, never a subtask), around `canSendToBraindump`.
        if !present(item.startDate) || present(item.parentItemId) { return .refused(.notBraindump) }
        return canSendToBraindump(item, kind: .task, dateStr: from.date, milestoneIds: milestoneIds)
            ? .braindump
            : .refused(.notBraindump)
    }
}
