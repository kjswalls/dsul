import Foundation
import Testing
import DsulCore

// The phone's writes for a block drop (Week and blocks PR 8), checked against
// what the server wrote for them. tests/unit/block-drop-writes-fixtures.test.ts
// takes every case of tests/fixtures/day/block-moves.json, asks the real
// lib/block-moves.ts for its answer, maps it as the design's §5.5 does, sends
// that body through the real route (POST /api/app/items/:id) over the row it
// would read, and commits what the route answered and wrote to
// tests/fixtures/day/block-drop-writes.json: one row per case, in the same
// order, joined by name. Never edit either JSON by hand: regenerate them from
// the Vitest side (UPDATE_FIXTURES=1, block-moves.json first).
//
// Checked here: BlockDropWrite.swift's mapping gives every row's body and its
// phone refusal; the gate a time write asks (`editAllowed`) refuses exactly
// what the route refused; and each optimistic step DsulCore holds (`editing`
// for a time write, `unscheduling` for the braindump) is the row the route
// left. A schedule write's step is the app's own `placing`
// (ios/Dsul/Model/ItemAccessors.swift), which the hosted tests check; here the
// row it must reach is pinned column by column. Bodies are compared as JSON
// values (`JSONValue`, EditWritesFixtureTests.swift), so null and absent stay
// apart. Both files are decoded strictly: a missing key, an unknown target or
// phone refusal, or a milestone id that is not a uuid fails the test.

private struct FixtureError: Error, CustomStringConvertible {
    let description: String
}

/// block-moves.json's case: the fields the drop is asked with. The `item` is
/// decoded as the planner payload decodes one (`Item`'s own lenient decoder).
private struct MoveCase: Decodable, Sendable {
    let name: String
    let item: Item
    let origin: BlockOrigin
    let target: BlockTarget
    let context: BlockDropContext

    enum CodingKeys: String, CodingKey { case name, item, from, target, milestoneIds }
    enum OriginKeys: String, CodingKey { case date, skipped }
    enum TargetKeys: String, CodingKey { case kind, date, startMin }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let name = try c.decode(String.self, forKey: .name)
        self.name = name
        item = try c.decode(Item.self, forKey: .item)
        let o = try c.nestedContainer(keyedBy: OriginKeys.self, forKey: .from)
        origin = BlockOrigin(
            date: try o.decode(String.self, forKey: .date), skipped: try o.decode(Bool.self, forKey: .skipped)
        )
        let t = try c.nestedContainer(keyedBy: TargetKeys.self, forKey: .target)
        switch try t.decode(String.self, forKey: .kind) {
        case "hour":
            target = .hour(
                date: try t.decode(String.self, forKey: .date), startMin: try t.decode(Int.self, forKey: .startMin)
            )
        case "anytime":
            target = .anytime(date: try t.decode(String.self, forKey: .date))
        case "braindump":
            target = .braindump
        case let other:
            throw FixtureError(description: "\(name): unknown target kind \(other)")
        }
        // A missing key would read as "unknown"; it must be spelled out.
        guard c.contains(.milestoneIds) else { throw FixtureError(description: "\(name): no milestoneIds key") }
        if try c.decodeNil(forKey: .milestoneIds) {
            context = BlockDropContext(milestoneIds: nil)
        } else {
            var ids = Set<UUID>()
            for s in try c.decode([String].self, forKey: .milestoneIds) {
                guard let id = UUID(uuidString: s) else {
                    throw FixtureError(description: "\(name): \(s) is not a uuid")
                }
                ids.insert(id)
            }
            context = BlockDropContext(milestoneIds: ids)
        }
    }

    /// The phone's answer for this case, or for the same item let go elsewhere.
    func answer(from origin: BlockOrigin? = nil, target: BlockTarget? = nil) -> PhoneBlockDrop {
        return phoneBlockDrop(item, from: origin ?? self.origin, target: target ?? self.target, context: context)
    }

    /// The shared rule's own answer.
    var rule: BlockDrop {
        return planBlockDrop(item, from: origin, target: target, context: context)
    }
}

/// block-drop-writes.json's row. Every key is always there, null or not.
private struct WriteCase: Decodable, Sendable {
    let name: String
    /// The body the phone sends; nil when it sends nothing.
    let write: JSONValue?
    let phoneRefusal: PhoneDropRefusal?
    /// The route's status for `write`, and its refusal code.
    let status: Int?
    let error: String?
    /// The columns the route wrote (a cleared one as `.null`); empty when it
    /// found the row already so; nil with no write or a refusal.
    let updates: [String: JSONValue]?
    /// The item as the route left it; nil likewise.
    let after: Item?

    enum CodingKeys: String, CodingKey, CaseIterable {
        case name, write, phoneRefusal, status, error, updates, after
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let name = try c.decode(String.self, forKey: .name)
        self.name = name
        for key in CodingKeys.allCases where !c.contains(key) {
            throw FixtureError(description: "\(name): no \(key.stringValue) key")
        }
        write = try c.decodeIfPresent(JSONValue.self, forKey: .write)
        if let raw = try c.decodeIfPresent(String.self, forKey: .phoneRefusal) {
            guard let refusal = PhoneDropRefusal(rawValue: raw) else {
                throw FixtureError(description: "\(name): unknown phone refusal \(raw)")
            }
            phoneRefusal = refusal
        } else {
            phoneRefusal = nil
        }
        status = try c.decodeIfPresent(Int.self, forKey: .status)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        updates = try c.decodeIfPresent([String: JSONValue].self, forKey: .updates)
        after = try c.decodeIfPresent(Item.self, forKey: .after)
    }
}

private struct Cases<Case: Decodable & Sendable>: Decodable, Sendable {
    let cases: [Case]
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func load<T: Decodable>(_ relative: String, as type: T.Type, here: String = #filePath) throws -> T {
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            let data: Data = try Data(contentsOf: candidate)
            return try JSONDecoder().decode(T.self, from: data)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw FixtureError(description: "\(relative) not found above \(here)")
}

/// A case and the row the route wrote for it.
private struct Row: Sendable {
    let move: MoveCase
    let wrote: WriteCase
    var name: String { move.name }
}

/// Both fixtures, joined by name. They must hold the same cases in the same
/// order, so a block-moves.json case can't go without its write.
private func rows() throws -> [Row] {
    let moves = try load("tests/fixtures/day/block-moves.json", as: Cases<MoveCase>.self).cases
    let writes = try load("tests/fixtures/day/block-drop-writes.json", as: Cases<WriteCase>.self).cases
    guard moves.map(\.name) == writes.map(\.name) else {
        throw FixtureError(
            description: "block-drop-writes.json does not answer block-moves.json case for case, in order"
        )
    }
    return zip(moves, writes).map { Row(move: $0, wrote: $1) }
}

/// A body as the wire carries it.
private func wire(_ body: ItemWriteBody) throws -> JSONValue {
    return try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(body))
}

/// The phone's body for `write`, as JSON. The time and unschedule writes are
/// DsulCore's `ItemWriteBody`; the schedule body is the app's own (APIClient's
/// `ScheduleBody`), so it is spelled here as the route takes it, and the
/// hosted tests hold the app's encoder to the same rows.
private func body(_ write: BlockDropWrite) throws -> JSONValue {
    switch write {
    case let .schedule(date, startMin):
        return .object([
            "action": .string("schedule"), "date": .string(date), "startTime": .string(startTimeOf(startMin)),
        ])
    case let .time(edit):
        return try wire(.edit(edit))
    case .unschedule:
        return try wire(.unschedule)
    }
}

/// The body's keys, when it is an object.
private func keys(_ value: JSONValue?) -> Set<String>? {
    guard case let .object(fields)? = value else { return nil }
    return Set(fields.keys)
}

/// What may not change its date (BlockMoves.swift's `keepsDate`): a type with
/// no date, or a series on the canvas with a start date.
private func keepsItsDate(_ item: Item) -> Bool {
    if !caps(item.typeName).dateAnchored { return true }
    let rule = RepeatRule(frequency: item.repeatFrequency, days: item.repeatDays, monthDay: item.repeatMonthDay)
    return isRecurring(rule) && !(item.startDate ?? "").isEmpty && isTaskScheduled(item)
}

@Suite struct BlockDropWritesFixtureTests {
    @Test func theRowsReachEveryWriteAndEveryWayToSendNothing() throws {
        let all = try rows()
        #expect(!all.isEmpty)
        let actions = Set(all.compactMap { $0.move.answer().write?.action })
        #expect(actions == ["schedule", "time", "unschedule"])
        #expect(Set(all.compactMap(\.wrote.phoneRefusal)) == Set(PhoneDropRefusal.allCases))
        // A guard on the guard: the rows the gate and the steps matter for.
        #expect(all.contains { $0.wrote.status == 400 }, "a write the route refused")
        #expect(all.contains { $0.wrote.updates?.isEmpty == true }, "a write the route found already so")
        let silent = all.contains { $0.wrote.write == nil && $0.wrote.phoneRefusal == nil }
        #expect(silent, "nothing sent, and not a phone refusal")
    }

    /// The body the phone sends for every case is the one the route was sent,
    /// nothing where it sent nothing, and the phone refuses exactly the pause
    /// and another day's Anytime.
    @Test func everyDropSendsTheBodyTheRouteWasSent() throws {
        for row in try rows() {
            let answer = row.move.answer()
            if let write = answer.write {
                #expect(try body(write) == row.wrote.write, "\(row.name)")
                if case let .object(fields)? = row.wrote.write {
                    #expect(fields["action"] == JSONValue.string(write.action), "\(row.name)")
                }
            } else {
                #expect(row.wrote.write == nil, "\(row.name)")
            }
            if case let .refusedOnPhone(refusal) = answer {
                #expect(refusal == row.wrote.phoneRefusal, "\(row.name)")
            } else {
                #expect(row.wrote.phoneRefusal == nil, "\(row.name)")
            }
        }
    }

    /// Forbidden is a refusal, the rule's (its reason kept) or the phone's;
    /// a drop on its own place sends nothing and is not refused.
    @Test func onlyARefusalIsForbidden() throws {
        for row in try rows() {
            let rule = row.move.rule
            let answer = phoneBlockDrop(rule)
            #expect(answer == row.move.answer(), "\(row.name): the convenience asks the same rule")
            var ruleRefused = false
            if case let .refused(reason) = rule {
                ruleRefused = true
                #expect(answer == .refused(reason), "\(row.name)")
            }
            #expect(answer.isForbidden == (ruleRefused || row.wrote.phoneRefusal != nil), "\(row.name)")
            #expect((answer == .alreadyThere) == (rule == BlockDrop.none), "\(row.name)")
            #expect(answer.isForbidden == (answer.write == nil && answer != .alreadyThere), "\(row.name)")
        }
    }

    /// The gate a time write asks is the route's: `editAllowed` refuses
    /// exactly the times the route answered 400 (a subtask's, which no
    /// surface draws as a block) and passes every other, so the planner's
    /// edit path never sends one the route refuses. Every schedule and
    /// unschedule the phone sends lands.
    @Test func theTimeGateRefusesWhatTheRouteRefused() throws {
        var refused = 0
        for row in try rows() {
            guard let write = row.move.answer().write else { continue }
            switch write {
            case let .time(edit):
                let allowed = editAllowed(edit, on: row.move.item, caps: caps(row.move.item.typeName))
                #expect(allowed == (row.wrote.status == 200), "\(row.name)")
                if !allowed {
                    refused += 1
                    #expect(row.wrote.status == 400 && row.wrote.error == "not_for_subtask", "\(row.name)")
                    #expect(!(row.move.item.parentItemId ?? "").isEmpty, "\(row.name)")
                }
            case .schedule, .unschedule:
                #expect(row.wrote.status == 200 && row.wrote.error == nil, "\(row.name)")
            }
        }
        #expect(refused > 0)
    }

    /// A time write's optimistic step (`editing`) is the row the route left.
    /// It changes nothing exactly where the route wrote nothing (`{}`), so the
    /// planner, which sends no edit that changes nothing, and the route agree
    /// on those rows too: nothing on screen moves either way.
    @Test func aTimeWriteStepsToTheRowTheRouteLeft() throws {
        var count = 0
        var unmoved = 0
        for row in try rows() {
            guard case let .time(edit)? = row.move.answer().write, row.wrote.status == 200 else { continue }
            count += 1
            let after = try #require(row.wrote.after, "\(row.name)")
            let updates = try #require(row.wrote.updates, "\(row.name)")
            let stepped = editing(row.move.item, edit)
            #expect(stepped == after, "\(row.name)")
            #expect((stepped == row.move.item) == updates.isEmpty, "\(row.name)")
            if updates.isEmpty { unmoved += 1 }
        }
        #expect(count > 0)
        #expect(unmoved > 0)
    }

    /// The braindump's optimistic step (`unscheduling`) is the row the route left.
    @Test func aBraindumpWriteStepsToTheRowTheRouteLeft() throws {
        var count = 0
        for row in try rows() {
            guard case .unschedule? = row.move.answer().write else { continue }
            count += 1
            let after = try #require(row.wrote.after, "\(row.name)")
            #expect(unscheduling(row.move.item) == after, "\(row.name)")
        }
        #expect(count > 0)
    }

    /// A schedule write lands as the planner's hour drop draws it: the route
    /// writes seven columns, `scheduleTaskPatch` and the date, and nothing
    /// else. The app's `placing` builds them from `minutesToTime` and
    /// `DayBucket.owning(minute:)`, which agree with the rule's
    /// `startTimeOf` and the route's `getBucketForTime` on every row.
    @Test func aScheduleWriteLandsAsTheHourDropDraws() throws {
        let columns: Set<String> = [
            "isScheduled", "timeBucket", "startTime", "inProjectBlock", "previousStartTime", "previousStartDate",
            "startDate",
        ]
        var count = 0
        for row in try rows() {
            guard case let .schedule(date, startMin)? = row.move.answer().write else { continue }
            count += 1
            let after = try #require(row.wrote.after, "\(row.name)")
            #expect(row.wrote.updates.map { Set($0.keys) } == columns, "\(row.name)")
            #expect(minutesToTime(startMin) == startTimeOf(startMin), "\(row.name)")
            #expect(DayBucket.owning(minute: startMin) == bucketForTime(startTimeOf(startMin)), "\(row.name)")
            var placed = row.move.item
            placed.isScheduled = true
            placed.timeBucket = DayBucket.owning(minute: startMin).rawValue
            placed.startTime = minutesToTime(startMin)
            placed.inProjectBlock = false
            placed.previousStartTime = nil
            placed.previousStartDate = nil
            placed.startDate = date
            #expect(placed == after, "\(row.name)")
        }
        #expect(count > 0)
    }

    /// What keeps its date moves in time only (B7, B18): a series on the
    /// canvas and a type with no date send `time`, exactly its two keys, and
    /// keep their start date; the one exception is a series in a project
    /// block, scheduled on its own start date so the move releases it. Every
    /// time write, a one-off's Move to Anytime included, leaves the date alone.
    @Test func whatKeepsItsDateNeverSendsAnother() throws {
        var retimed = 0
        var released = 0
        for row in try rows() {
            guard let write = row.move.answer().write else { continue }
            let item = row.move.item
            switch write {
            case .time:
                #expect(keys(row.wrote.write) == Set(["action", "timeBucket", "startTime"]), "\(row.name)")
                if let after = row.wrote.after { #expect(after.startDate == item.startDate, "\(row.name)") }
                if keepsItsDate(item) { retimed += 1 }
            case let .schedule(date, _):
                guard keepsItsDate(item) else { continue }
                released += 1
                #expect(item.inProjectBlock == true, "\(row.name)")
                #expect(date == item.startDate?.split(separator: "T").first.map(String.init), "\(row.name)")
            case .unschedule:
                #expect(!keepsItsDate(item), "\(row.name)")
            }
        }
        #expect(retimed > 0)
        #expect(released > 0)
    }

    /// A block that is not a skipped strip always has somewhere to go: some
    /// quarter hour of its own day answers a write. So the design's "a block
    /// whose every target the rule refuses never lifts" (§5.5, Gates) is the
    /// skipped strip and nothing else; and a skipped one is refused on every
    /// hour, its day's Anytime and the braindump.
    @Test func onlyASkippedStripHasNowhereToGo() throws {
        let quarters = Array(stride(from: 0, to: 24 * 60, by: ScheduleMetrics.snapMin))
        for row in try rows() {
            let day = row.move.origin.date
            let hours = quarters.map { BlockTarget.hour(date: day, startMin: $0) }
            if !row.move.origin.skipped {
                let somewhere = hours.contains { row.move.answer(target: $0).write != nil }
                #expect(somewhere, "\(row.name)")
            }
            let skipped = BlockOrigin(date: day, skipped: true)
            let everywhere = (hours + [.anytime(date: day), .braindump]).allSatisfy {
                row.move.answer(from: skipped, target: $0) == .refused(.skipped)
            }
            #expect(everywhere, "\(row.name)")
        }
    }

    @Test func eachWriteNamesItsAction() {
        #expect(BlockDropWrite.schedule(date: "2026-07-04", startMin: 615).action == "schedule")
        #expect(BlockDropWrite.unschedule.action == "unschedule")
        let anytime = ItemEdit.time(bucket: .set("anytime"), startTime: .clear, duration: nil)
        #expect(BlockDropWrite.time(anytime).action == "time")
        #expect(phoneBlockDrop(.anytime(date: nil)) == .write(.time(anytime)))
        #expect(phoneBlockDrop(.anytime(date: "2026-07-05")) == .refusedOnPhone(.anotherDay))
        #expect(phoneBlockDrop(.pause) == .refusedOnPhone(.pause))
        #expect(phoneBlockDrop(.retime(startMin: 1155))
            == .write(.time(.time(bucket: .set("evening"), startTime: .set("19:15"), duration: nil))))
        #expect(phoneBlockDrop(.place(date: "2026-07-04", startMin: 0))
            == .write(.schedule(date: "2026-07-04", startMin: 0)))
        #expect(phoneBlockDrop(BlockDrop.none) == .alreadyThere)
        #expect(phoneBlockDrop(.refused(.inBlock)) == .refused(.inBlock))
    }
}
