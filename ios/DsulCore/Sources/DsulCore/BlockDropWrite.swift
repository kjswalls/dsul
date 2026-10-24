import Foundation

// What the iPhone sends for a block drop (Week and blocks PR 8): the one
// existing item intent each answer of lib/block-moves.ts `planBlockDrop`
// (BlockMoves.swift) becomes, and the two answers the phone refuses in v1.
// The rule says where a block ends up; this says how the phone writes it
// (the design's §5.5 and §6.2; memory/plans/ios-app.md, "Dropping a block"):
//
//   place {date, startMin}   `schedule {date, startTime}` (lib/app-api.ts),
//                            the web's single hour drop, which also releases a
//                            project block. A dated series in one is placed on
//                            its own start date, so the date sent is the one
//                            the phone draws.
//   retime {startMin}        `time {timeBucket, startTime}`, both keys always,
//                            the hour's part of day (lib/time-bucket.ts
//                            `getBucketForTime`, `bucketForTime`), never the
//                            date: a start date the web moved since the last
//                            fetch is never written back.
//   anytime, its own day     `time {timeBucket: "anytime", startTime: null}`:
//                            a time beside Anytime is refused, so the time
//                            goes with it.
//   braindump                `unschedule` (Move to Braindump).
//   anytime, another day     nothing, refused on the phone (B22): it would be
//                            two writes, which can land half.
//   pause                    nothing, refused on the phone (B15): the phone's
//                            braindump never lists a paused habit.
//   none                     nothing: already there.
//   refused                  nothing.
//
// No web function holds this mapping (the web turns the same answers into
// store calls), so there is no TypeScript twin to keep in step. It is pinned
// by tests/fixtures/day/block-drop-writes.json instead, which
// tests/unit/block-drop-writes-fixtures.test.ts writes by sending each body
// through the real route (app/api/app/items/[id]/route.ts) over the row it
// would read. BlockDropWritesFixtureTests checks every body against it, and
// the optimistic steps of the time and unschedule writes (`editing`,
// `unscheduling`) against the row the route left; a change to an intent's
// body, or to lib/item-edit.ts `timeEditPatch`, moves that fixture.

/// The two answers the web takes that the phone refuses in v1. The raw values
/// are block-drop-writes.json's `phoneRefusal`.
public enum PhoneDropRefusal: String, Sendable, Hashable, CaseIterable {
    /// `.pause`: a placed item of a type with no date (a habit) dropped on
    /// the braindump (B15). Pause is in the block's menu.
    case pause
    /// `.anytime(date:)` with a day: another day's Anytime (B22). Drop it on
    /// that day's hour, then Move to Anytime.
    case anotherDay = "another-day"
}

/// The one write a drop sends, POST /api/app/items/:id. No drop sends two.
public enum BlockDropWrite: Sendable, Hashable {
    /// `place`: `{"action":"schedule","date":…,"startTime":…}`, the time
    /// being `startTimeOf(startMin)` ("HH:MM"). Its optimistic step is the
    /// planner's hour drop: scheduled, the hour's part of day, the time, out
    /// of any project block with its stash cleared, and `date` as its start
    /// date.
    case schedule(date: String, startMin: Int)
    /// `retime`, and `anytime` on its own day: the Time chip's edit,
    /// `{"action":"time","timeBucket":…,"startTime":…}` through
    /// `ItemWriteBody.edit`, always both keys and never a length. Its gate is
    /// `editAllowed(_:on:caps:)`, which refuses a subtask's time as the route
    /// does; its optimistic step is `editing(item, edit)`, which leaves the
    /// item as it was exactly where the route writes nothing (lib/item-edit.ts
    /// `timeEditPatch` finds the part of day and the time already as sent).
    case time(ItemEdit)
    /// `braindump`: `{"action":"unschedule"}` (`ItemWriteBody.unschedule`).
    /// Its optimistic step is `unscheduling(item)`.
    case unschedule

    /// The route's `action`, the name the payload's `writes` lists.
    public var action: String {
        switch self {
        case .schedule: "schedule"
        case .time(let edit): edit.action
        case .unschedule: "unschedule"
        }
    }
}

/// What the phone does with a drop: the rule's answer, mapped.
public enum PhoneBlockDrop: Sendable, Hashable {
    /// Send this write, once.
    case write(BlockDropWrite)
    /// The rule's `none`: already there, so nothing is sent. Not a refusal:
    /// the block lands where it was.
    case alreadyThere
    /// The rule refused it: nothing is sent.
    case refused(BlockDropRefusal)
    /// The rule took it and the phone refuses it in v1: nothing is sent.
    case refusedOnPhone(PhoneDropRefusal)

    /// The write to send, or nil to send nothing.
    public var write: BlockDropWrite? {
        if case .write(let write) = self { return write }
        return nil
    }

    /// The destination proposes forbidden, the system's badge (design §5.4
    /// and §5.8): either refusal. Already there is not forbidden.
    public var isForbidden: Bool {
        switch self {
        case .refused, .refusedOnPhone: true
        case .write, .alreadyThere: false
        }
    }
}

/// The phone's mapping of the rule's answer (design §5.5's table).
public func phoneBlockDrop(_ drop: BlockDrop) -> PhoneBlockDrop {
    switch drop {
    case let .place(date, startMin):
        return .write(.schedule(date: date, startMin: startMin))
    case let .retime(startMin):
        let time = startTimeOf(startMin)
        return .write(.time(.time(bucket: .set(bucketForTime(time).rawValue), startTime: .set(time), duration: nil)))
    case let .anytime(date):
        guard date == nil else { return .refusedOnPhone(.anotherDay) }
        return .write(.time(.time(bucket: .set(DayBucket.anytime.rawValue), startTime: .clear, duration: nil)))
    case .braindump:
        return .write(.unschedule)
    case .pause:
        return .refusedOnPhone(.pause)
    case BlockDrop.none:
        return .alreadyThere
    case let .refused(reason):
        return .refused(reason)
    }
}

/// `phoneBlockDrop(planBlockDrop(item, from:target:context:))`: what the phone
/// does with `item` let go on `target`, asked while the finger moves (the
/// destination's proposal) and again at the drop.
public func phoneBlockDrop(
    _ item: Item, from: BlockOrigin, target: BlockTarget, context: BlockDropContext
) -> PhoneBlockDrop {
    return phoneBlockDrop(planBlockDrop(item, from: from, target: target, context: context))
}
