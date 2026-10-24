import DsulCore
import Foundation
import Testing
@testable import Dsul

// Moving a block on the iPhone's Schedule (Week and blocks PR 8): what a drop,
// a block's menu and its VoiceOver actions do through the planner
// (ScheduleMoves.swift), and the drag's own state (ScheduleDrag). Foundation
// only, so the shim runs it.
//
// The first test plays every case of tests/fixtures/day/block-moves.json
// through the live planner's `moveBlock` and holds what it sends, and the
// step it takes, to tests/fixtures/day/block-drop-writes.json: the body the
// real route (POST /api/app/items/:id) was sent for the same case, and the row
// it left. That is the check DsulCore's BlockDropWritesFixtureTests leaves to
// the app: a schedule write's encoder (APIClient) and its step (`placing`),
// and the gates the planner asks before a write (`takes`). The rule itself,
// and the phone's mapping of it, are DsulCore's and checked there.

private struct FixtureError: Error, CustomStringConvertible {
    let description: String
}

/// block-moves.json's case: what the drop is asked with. The `item` decodes
/// as the planner payload's rows do (`Item`'s lenient decoder).
private struct MoveCase: Decodable {
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
        origin = BlockOrigin(date: try o.decode(String.self, forKey: .date),
                             skipped: try o.decode(Bool.self, forKey: .skipped))
        let t = try c.nestedContainer(keyedBy: TargetKeys.self, forKey: .target)
        switch try t.decode(String.self, forKey: .kind) {
        case "hour":
            target = .hour(date: try t.decode(String.self, forKey: .date),
                           startMin: try t.decode(Int.self, forKey: .startMin))
        case "anytime":
            target = .anytime(date: try t.decode(String.self, forKey: .date))
        case "braindump":
            target = .braindump
        case let other:
            throw FixtureError(description: "\(name): unknown target kind \(other)")
        }
        guard c.contains(.milestoneIds) else { throw FixtureError(description: "\(name): no milestoneIds key") }
        if try c.decodeNil(forKey: .milestoneIds) {
            context = BlockDropContext(milestoneIds: nil)
        } else {
            let ids = try c.decode([String].self, forKey: .milestoneIds).map { raw -> UUID in
                guard let id = UUID(uuidString: raw) else {
                    throw FixtureError(description: "\(name): \(raw) is not a uuid")
                }
                return id
            }
            context = BlockDropContext(milestoneIds: Set(ids))
        }
    }
}

private struct MoveCases: Decodable {
    let cases: [MoveCase]
}

/// block-drop-writes.json's row, its bodies as raw JSON: what the phone sends
/// (nil for nothing), the route's status, the columns it wrote (empty when
/// it found the row already so) and the row it left.
private struct WroteRow {
    let name: String
    let write: [String: Any]?
    let status: Int?
    let updates: [String: Any]?
    let after: Item?

    /// The route took the write and changed the row: the one case the phone
    /// sends anything. A refusal (a subtask's time, 400) is refused by the
    /// planner's own gate first, and a write the route would find already so
    /// (`{}`) changes nothing, so neither is sent.
    var lands: Bool {
        return write != nil && status == 200 && !(updates?.isEmpty ?? true)
    }
}

/// The file at `relative` from the repo root: found by walking up from this
/// source file (the runner's checkout), or under /work, where the shim mounts
/// the tree it was copied from.
private func fixture(_ relative: String, here: String = #filePath) throws -> Data {
    var dir = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            return try Data(contentsOf: candidate)
        }
        dir = dir.deletingLastPathComponent()
    }
    let mounted = URL(fileURLWithPath: "/work").appendingPathComponent(relative)
    if FileManager.default.fileExists(atPath: mounted.path) {
        return try Data(contentsOf: mounted)
    }
    throw FixtureError(description: "\(relative) not found above \(here) or under /work")
}

/// Both fixtures, joined case for case: the server side writes them in the
/// same order, by name.
private func fixtureRows() throws -> [(move: MoveCase, wrote: WroteRow)] {
    let moves = try JSONDecoder().decode(MoveCases.self, from: fixture("tests/fixtures/day/block-moves.json")).cases
    let data = try fixture("tests/fixtures/day/block-drop-writes.json")
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let rows = root["cases"] as? [[String: Any]]
    else { throw FixtureError(description: "block-drop-writes.json has no cases") }
    let wrote: [WroteRow] = try rows.map { row in
        var after: Item?
        if let left = row["after"] as? [String: Any] {
            after = try JSONDecoder().decode(Item.self, from: JSONSerialization.data(withJSONObject: left))
        }
        return WroteRow(name: row["name"] as? String ?? "", write: row["write"] as? [String: Any],
                        status: row["status"] as? Int, updates: row["updates"] as? [String: Any], after: after)
    }
    guard moves.map(\.name) == wrote.map(\.name) else {
        throw FixtureError(description: "block-drop-writes.json does not answer block-moves.json case for case")
    }
    return Array(zip(moves, wrote)).map { (move: $0.0, wrote: $0.1) }
}

/// A JSON object as one string, its keys sorted, so two bodies compare as
/// values: a null stays apart from an absent key.
private func canonical(_ object: [String: Any]?) -> String? {
    guard let object, let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    else { return nil }
    return String(decoding: data, as: UTF8.self)
}

@MainActor
@Suite struct BlockMoveTests {
    private let ok = "{\"ok\":true}"

    /// A Thursday (as SamplePlannerTests' planner), the clock noon UTC.
    private func makePlanner() -> SamplePlanner {
        SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
    }

    private func loaded(_ server: FakeServer) async -> SamplePlanner {
        let planner = makeLivePlanner(server)
        await planner.refresh()
        return planner
    }

    private func drain(_ planner: SamplePlanner) async {
        if let sync = planner.sync { await sync.drain() }
    }

    /// Every POST the server took after the first `from`.
    private func posts(_ server: FakeServer, after from: Int = 0) async -> [FakeServer.Request] {
        let all = await server.requests
        return all.dropFirst(from).filter { $0.route.hasPrefix("POST") }
    }

    private func block(_ planner: SamplePlanner, _ title: String, on day: DayString? = nil) -> ScheduleBlock {
        let schedule = planner.daySchedule(on: day ?? planner.today, fieldWidth: 333)
        return schedule.blocks.first { $0.item.title == title }!
    }

    private func schedule(_ planner: SamplePlanner, on day: DayString? = nil) -> DaySchedule {
        planner.daySchedule(on: day ?? planner.today, fieldWidth: 333)
    }

    private func id(_ planner: SamplePlanner, _ title: String) -> UUID {
        planner.items.first { $0.title == title }!.id
    }

    // MARK: Every drop, as the route took it

    @Test func everyDropSendsWhatTheRouteTookAndStepsToTheRowItLeft() async throws {
        let rows = try fixtureRows()
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(goals: [])))
        await server.setFallback(.status(200, ok))
        let planner = await loaded(server)
        var sent = 0
        for (move, wrote) in rows {
            let id = move.item.id
            planner.items = [move.item]
            let before = await server.requests.count
            let drop = planner.moveBlock(id, from: move.origin, to: move.target, context: move.context)
            await drain(planner)
            let made = await posts(server, after: before)
            if wrote.lands {
                sent += 1
                #expect(made.count == 1, "\(move.name)")
                #expect(made.first?.route == itemRoute(id), "\(move.name)")
                #expect(canonical(bodyJSON(made.first)) == canonical(wrote.write), "\(move.name)")
                #expect(planner.item(id) == wrote.after, "\(move.name)")
                #expect(drop == planBlockDrop(move.item, from: move.origin, target: move.target,
                                              context: move.context), "\(move.name)")
            } else {
                #expect(made.isEmpty, "\(move.name)")
                #expect(planner.item(id) == move.item, "\(move.name)")
                #expect(drop == nil, "\(move.name)")
            }
        }
        // 51 schedule writes, 23 time edits that change the row, 5 unschedules.
        #expect(sent == 79)
        #expect(rows.count - sent == 74)
    }

    // MARK: What keeps its date

    /// A daily task from September at 8:00, scheduled.
    private let standup = UUID(uuidString: "0d000000-0000-4000-8000-0000000000a1")!
    private var standupJSON: String {
        return "{\"id\":\"\(lowerID(standup))\",\"type\":\"task\",\"title\":\"Daily standup\","
            + "\"status\":\"pending\",\"startDate\":\"2026-09-01\",\"timeBucket\":\"morning\","
            + "\"startTime\":\"08:00\",\"duration\":30,\"isScheduled\":true,\"repeatFrequency\":\"daily\","
            + "\"order\":9,\"completedDates\":[],\"skippedDates\":[],\"dailyCounts\":{}}"
    }

    /// The same, parked in Work's block: drawn at the block's time, its own
    /// stashed.
    private let triage = UUID(uuidString: "0d000000-0000-4000-8000-0000000000a2")!
    private var triageJSON: String {
        return "{\"id\":\"\(lowerID(triage))\",\"type\":\"task\",\"title\":\"Triage\","
            + "\"status\":\"pending\",\"startDate\":\"2026-09-01\",\"timeBucket\":\"morning\","
            + "\"isScheduled\":true,\"repeatFrequency\":\"daily\",\"order\":10,\"project\":\"Work\","
            + "\"projectId\":\"\(PlannerJSON.work)\",\"inProjectBlock\":true,\"previousStartTime\":\"08:30\","
            + "\"duration\":30,\"completedDates\":[],\"skippedDates\":[],\"dailyCounts\":{}}"
    }

    @Test func aRepeatingTaskMovesInTimeAndNeverSendsItsDate() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [standupJSON], projects: [PlannerJSON.workJSON],
                                                                   goals: [])))
        await server.setFallback(.status(200, ok))
        let planner = await loaded(server)
        let today = planner.today
        // Its own column, then another (Week × Schedule's), where it keeps its
        // own day (B18).
        let targets: [(String, Int)] = [(today.description, 9 * 60 + 15), (today.adding(days: 2).description, 10 * 60 + 30)]
        for (date, start) in targets {
            let before = await server.requests.count
            let drop = planner.moveBlock(standup, from: planner.blockOrigin(standup, on: today),
                                         to: .hour(date: date, startMin: start))
            await drain(planner)
            #expect(drop == .retime(startMin: start))
            let made = await posts(server, after: before)
            #expect(made.count == 1)
            let body = bodyJSON(made.first)
            let time = startTimeOf(start)
            #expect(body?["action"] as? String == "time")
            #expect(body?["startTime"] as? String == time)
            #expect(body?["timeBucket"] as? String == bucketForTime(time).rawValue)
            #expect(body?["date"] == nil)
            #expect(body?.count == 3)
            #expect(planner.item(standup)?.startDate == "2026-09-01")
            #expect(planner.item(standup)?.startTime == time)
        }
    }

    @Test func aRepeatingTaskInAProjectBlockIsScheduledOnItsOwnStartDate() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [triageJSON], projects: [PlannerJSON.workJSON],
                                                                   goals: [])))
        await server.setFallback(.status(200, ok))
        let planner = await loaded(server)
        let today = planner.today
        let drop = planner.moveBlock(triage, from: planner.blockOrigin(triage, on: today),
                                     to: .hour(date: today.description, startMin: 10 * 60))
        await drain(planner)
        #expect(drop == .place(date: "2026-09-01", startMin: 10 * 60))
        let made = await posts(server)
        #expect(made.count == 1)
        #expect(canonical(bodyJSON(made.first))
                == canonical(["action": "schedule", "date": "2026-09-01", "startTime": "10:00"]))
        let moved = planner.item(triage)
        #expect(moved?.startDate == "2026-09-01")
        #expect(moved?.startTime == "10:00")
        #expect(moved?.inProjectBlock == false)
        #expect(moved?.previousStartTime == nil)
    }

    // MARK: The Anytime band

    /// A done braindump row.
    private let filed = UUID(uuidString: "0d000000-0000-4000-8000-0000000000a3")!
    private var filedJSON: String {
        return "{\"id\":\"\(lowerID(filed))\",\"type\":\"task\",\"title\":\"File the receipts\","
            + "\"status\":\"completed\",\"isScheduled\":false,\"order\":11,"
            + "\"completedDates\":[],\"skippedDates\":[],\"dailyCounts\":{}}"
    }

    @Test func aBraindumpRowLandsOnTheBandThroughTheDateChipsWriteAndADoneOneSendsNothing() async {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(extra: [filedJSON], goals: [])))
        await server.setFallback(.status(200, ok))
        let planner = await loaded(server)
        let today = planner.today

        #expect(!planner.canPlaceAnytime(filed, on: today))
        planner.placeAnytime(filed, on: today)
        await drain(planner)
        #expect(await posts(server).isEmpty)

        #expect(planner.canPlaceAnytime(PlannerJSON.bank, on: today))
        planner.placeAnytime(PlannerJSON.bank, on: today)
        await drain(planner)
        let made = await posts(server)
        #expect(made.count == 1)
        #expect(made.first?.route == itemRoute(PlannerJSON.bank))
        #expect(canonical(bodyJSON(made.first)) == canonical(["action": "move", "date": today.description]))
        #expect(planner.item(PlannerJSON.bank)?.startDate == today.description)
        #expect(!planner.braindump.contains { $0.id == PlannerJSON.bank })
        #expect(planner.anytime(on: today).contains { $0.id == PlannerJSON.bank })
        // Already there: nothing more to take.
        #expect(!planner.canPlaceAnytime(PlannerJSON.bank, on: today))
        #expect(!planner.canPlaceAnytime(nil, on: today))
    }

    @Test func aBlockMovesToAnytimeKeepingItsDay() {
        let planner = makePlanner()
        let today = planner.today
        let lunch = id(planner, "Lunch walk")
        #expect(planner.canMoveToAnytime(lunch, on: today))
        #expect(planner.moveToAnytime(lunch, on: today) == .anytime(date: nil))
        let moved = planner.item(lunch)
        #expect(moved?.timeBucket == DayBucket.anytime.rawValue)
        #expect(moved?.startTime == nil)
        #expect(moved?.startDate == today.description)
        #expect(planner.anytime(on: today).contains { $0.id == lunch })
        #expect(!planner.canMoveToAnytime(lunch, on: today))
        // And back onto an hour, as an Anytime row: a block again.
        let back = planner.moveBlock(lunch, from: planner.blockOrigin(lunch, on: today),
                                     to: .hour(date: today.description, startMin: 10 * 60))
        #expect(back == .place(date: today.description, startMin: 10 * 60))
        #expect(block(planner, "Lunch walk").startMin == 10 * 60)
    }

    // MARK: The hold on fetched data

    /// The lift takes the hold and the drop lets it go at once. No await
    /// between the steps: the hold is the app's one, and other tests on the
    /// main actor take it too.
    @Test func aLiftHoldsFetchedDataUntilTheDropLands() {
        let planner = makePlanner()
        let today = planner.today
        let walk = SampleData.uuid(59)
        let drag = ScheduleDrag()
        DragHold.shared.releaseNow()

        drag.beginMove(itemID: walk, durationMin: 20, source: .block(day: today), anchor: 0.25, confinedTo: today)
        #expect(DragHold.shared.isHeld)
        #expect(drag.inFlight)
        #expect(drag.lifts(walk))
        #expect(drag.source == .block(day: today))
        _ = planner.moveBlock(walk, from: planner.blockOrigin(walk, on: today),
                              to: .hour(date: today.description, startMin: 8 * 60 + 15))
        #expect(!DragHold.shared.isHeld)

        // The session ends after the drop: what landed is still known.
        drag.reset()
        #expect(!drag.inFlight)
        #expect(!drag.lifts(walk))
        #expect(drag.itemID == nil)
        #expect(drag.ghostDay == nil)
        #expect(drag.source == .block(day: today))
        #expect(drag.anchor == 0.25)
        #expect(drag.durationMin == 20)

        // A braindump row on the band lets it go too, and so does a drop
        // that moves nothing.
        drag.begin(itemID: SampleData.uuid(18), durationMin: 15, detent: .medium)
        #expect(DragHold.shared.isHeld)
        #expect(drag.source == .braindump)
        #expect(drag.anchor == 0.5)
        #expect(!drag.lifts(SampleData.uuid(18)))
        planner.placeAnytime(SampleData.uuid(18), on: today)
        #expect(!DragHold.shared.isHeld)
        drag.beginMove(itemID: walk, durationMin: 20, source: .block(day: today), anchor: 0.5, confinedTo: today)
        #expect(planner.moveBlock(walk, from: planner.blockOrigin(walk, on: today), to: .braindump) == nil)
        #expect(!DragHold.shared.isHeld)
        drag.reset()
        DragHold.shared.releaseNow()
    }

    // MARK: Which drop is which

    /// A drop is routed by what the drag says of THIS item, and when it says
    /// nothing (a lift whose `.initial` was missed) by the item itself, so a
    /// placed series never goes down through the braindump's own hour drop.
    @Test func aDropRoutesOnItsOwnLiftOrElseOnTheItem() {
        let planner = makePlanner()
        let today = planner.today
        let yesterday = today.adding(days: -1)
        let teamSync = SampleData.uuid(60)
        let row = planner.braindump.first!.id
        let drag = ScheduleDrag()

        // A braindump row's lift, and then a block whose own lift was missed.
        drag.begin(itemID: row, durationMin: 15, detent: .medium)
        drag.reset()
        #expect(drag.liftedID == row)
        #expect(drag.source(of: row) == .braindump)
        #expect(drag.source(of: teamSync) == nil)
        #expect(planner.dropSource(row, said: drag.source(of: row), on: today) == .braindump)
        #expect(planner.dropSource(teamSync, said: drag.source(of: teamSync), on: today) == .block(day: today))
        // A braindump word about a row that is no braindump member is not
        // taken; a lift off a day is taken as it says.
        #expect(planner.dropSource(teamSync, said: .braindump, on: today) == .block(day: today))
        #expect(planner.dropSource(row, said: nil, on: today) == .braindump)
        #expect(planner.dropSource(teamSync, said: .block(day: yesterday), on: today) == .block(day: yesterday))
        #expect(planner.dropSource(teamSync, said: .anytime(day: today), on: today) == .anytime(day: today))

        // So the series is retimed, and keeps its start date.
        let start = planner.item(teamSync)?.startDate
        guard case .block(let from) = planner.dropSource(teamSync, said: drag.source(of: teamSync), on: today) else {
            Issue.record("not a block")
            return
        }
        #expect(planner.moveBlock(teamSync, from: planner.blockOrigin(teamSync, on: from),
                                  to: .hour(date: today.description, startMin: 17 * 60))
                == .retime(startMin: 17 * 60))
        #expect(planner.item(teamSync)?.startDate == start)

        // A block's lift names it until the next lift.
        drag.beginMove(itemID: teamSync, durationMin: 30, source: .block(day: today), anchor: 0.5, confinedTo: today)
        drag.reset()
        #expect(drag.source(of: teamSync) == .block(day: today))
        #expect(drag.source(of: row) == nil)
        DragHold.shared.releaseNow()
    }

    /// The block's menu and its drag share one long press (M1): a pick lets
    /// go of a lift whose session never ended, and is nothing otherwise.
    @Test func aMenuPickEndsAStrayLift() {
        let today = DayString("2026-10-01")!
        let walk = SampleData.uuid(59)
        let drag = ScheduleDrag()
        drag.endStrayLift()
        #expect(!drag.inFlight)
        #expect(drag.events.isEmpty)

        drag.beginMove(itemID: walk, durationMin: 20, source: .block(day: today), anchor: 0.5, confinedTo: today)
        #expect(drag.lifts(walk))
        drag.endStrayLift()
        #expect(!drag.inFlight)
        #expect(!drag.lifts(walk))
        #expect(drag.itemID == nil)
        #expect(drag.events.last == "menu picked")
        DragHold.shared.releaseNow()
    }

    // MARK: The ghost

    @Test func theGhostLandsWhereTheBlockIsHeldAndKeepsToItsColumn() {
        let today = DayString("2026-10-01")!
        let hour = ScheduleMetrics.hourPx
        let drag = ScheduleDrag()
        // Held by its top: the ghost's top is the finger.
        drag.beginMove(itemID: UUID(), durationMin: 60, source: .block(day: today), anchor: 0, confinedTo: today)
        drag.setContentY(10 * hour, on: today.adding(days: 1))
        #expect(drag.ghostStartMin == 10 * 60)
        #expect(drag.ghostDay == today)
        // Held by its middle: half an hour higher.
        drag.beginMove(itemID: UUID(), durationMin: 60, source: .anytime(day: today), anchor: 0.5, confinedTo: nil)
        drag.setContentY(10 * hour, on: today.adding(days: 1))
        #expect(drag.ghostStartMin == 9 * 60 + 30)
        #expect(drag.ghostDay == today.adding(days: 1))
        drag.setContentY(11 * hour)
        #expect(drag.ghostDay == today.adding(days: 1))
        drag.reset()
        #expect(drag.ghostDay == nil)
        #expect(drag.ghostStartMin == nil)
        DragHold.shared.releaseNow()
    }

    @Test func theGrabAnchorIsWhereOnTheBlockTheFingerHolds() {
        let top = 9 * ScheduleMetrics.hourPx
        let height = ScheduleMetrics.hourPx
        #expect(ScheduleDrag.grabAnchor(fingerY: top, blockTop: top, durationMin: 60) == 0)
        #expect(ScheduleDrag.grabAnchor(fingerY: top + height / 4, blockTop: top, durationMin: 60) == 0.25)
        #expect(ScheduleDrag.grabAnchor(fingerY: top + height, blockTop: top, durationMin: 60) == 1)
        // The lifted block's own height, not the pane's floor: off the end
        // holds it by its foot, above it by its top.
        #expect(ScheduleDrag.grabAnchor(fingerY: top + 2 * height, blockTop: top, durationMin: 60) == 1)
        #expect(ScheduleDrag.grabAnchor(fingerY: top - 10, blockTop: top, durationMin: 60) == 0)
        #expect(ScheduleDrag.grabAnchor(fingerY: top, blockTop: top, durationMin: 0) == 0.5)
        #expect(ScheduleDrag.grabAnchor(fingerY: .nan, blockTop: top, durationMin: 60) == 0.5)
    }

    @Test func whatMovesInTimeOnlyKeepsToItsColumn() {
        let planner = makePlanner()
        let today = planner.today
        #expect(planner.confinedDay(SampleData.uuid(59), from: today) == today)
        #expect(planner.confinedDay(SampleData.uuid(60), from: today) == today)
        #expect(planner.confinedDay(id(planner, "Lunch walk"), from: today) == nil)
        #expect(planner.confinedDay(UUID(), from: today) == nil)
    }

    // MARK: What lifts, and what each target proposes

    @Test func aSkippedStripNeverLifts() {
        let planner = makePlanner()
        let today = planner.today
        let walk = SampleData.uuid(59)
        #expect(planner.canLift(block(planner, "Walk"), in: schedule(planner)))
        #expect(planner.canLift(block(planner, "Team sync"), in: schedule(planner)))
        planner.skip(walk, on: today)
        let skipped = block(planner, "Walk")
        #expect(skipped.skipped)
        #expect(!planner.canLift(skipped, in: schedule(planner)))
        #expect(planner.blockOrigin(walk, on: today).skipped)
        #expect(planner.moveBlock(walk, from: planner.blockOrigin(walk, on: today),
                                  to: .hour(date: today.description, startMin: 9 * 60)) == nil)
    }

    @Test func anAnytimeRowLiftsWhenAnHourOrTheBraindumpTakesIt() {
        let planner = makePlanner()
        let today = planner.today
        let groceries = planner.anytime(on: today).first { $0.title == "Groceries" }!
        #expect(planner.canLiftRow(groceries, on: today))
        let other = DayString("2026-10-02")!
        #expect(planner.confinedDay(groceries.id, from: today) == nil)
        #expect(planner.moveBlock(groceries.id, from: planner.blockOrigin(groceries.id, on: today),
                                  to: .hour(date: other.description, startMin: 14 * 60))
                == .place(date: other.description, startMin: 14 * 60))
        #expect(planner.item(groceries.id)?.startDate == other.description)
    }

    @Test func eachTargetProposesWhatTheRuleAndThePhoneAnswer() {
        let planner = makePlanner()
        let today = planner.today
        let walk = SampleData.uuid(59)
        let teamSync = SampleData.uuid(60)
        let lunch = id(planner, "Lunch walk")
        func origin(_ id: UUID) -> BlockOrigin { planner.blockOrigin(id, on: today) }
        // The braindump: a one-off goes; a habit (pause, B15) and a repeating
        // task (refused) get the forbidden badge.
        #expect(!planner.refusesDrop(lunch, from: origin(lunch), to: .braindump))
        #expect(planner.refusesDrop(walk, from: origin(walk), to: .braindump))
        #expect(planner.refusesDrop(teamSync, from: origin(teamSync), to: .braindump))
        // Anytime: its own day takes each; another day's is the phone's
        // refusal for a one-off (B22) and the rule's for the rest.
        let tomorrow = today.adding(days: 1).description
        #expect(!planner.refusesDrop(lunch, from: origin(lunch), to: .anytime(date: today.description)))
        #expect(!planner.refusesDrop(walk, from: origin(walk), to: .anytime(date: today.description)))
        #expect(planner.refusesDrop(lunch, from: origin(lunch), to: .anytime(date: tomorrow)))
        #expect(planner.refusesDrop(walk, from: origin(walk), to: .anytime(date: tomorrow)))
        // An hour, and its own place, which is no refusal.
        #expect(!planner.refusesDrop(walk, from: origin(walk), to: .hour(date: today.description, startMin: 9 * 60)))
        #expect(!planner.refusesDrop(walk, from: origin(walk), to: .hour(date: today.description,
                                                                          startMin: 7 * 60 + 45)))
        // Nothing the planner holds.
        #expect(planner.refusesDrop(UUID(), from: origin(walk), to: .braindump))
        #expect(planner.refusesDrop(nil, from: origin(walk), to: .braindump))
    }

    @Test func aBlockGoesToTheBraindumpByTheDropRule() {
        let planner = makePlanner()
        let today = planner.today
        let lunch = id(planner, "Lunch walk")
        #expect(planner.moveBlock(lunch, from: planner.blockOrigin(lunch, on: today), to: .braindump) == .braindump)
        #expect(planner.braindump.contains { $0.id == lunch })
        #expect(!planner.scheduled(on: today).contains { $0.id == lunch })
        // A habit stays where it is.
        #expect(planner.moveBlock(SampleData.uuid(59), from: planner.blockOrigin(SampleData.uuid(59), on: today),
                                  to: .braindump) == nil)
        #expect(planner.scheduled(on: today).contains { $0.id == SampleData.uuid(59) })
    }

    // MARK: The sample's "in time only"

    @Test func walkMovesOnEveryDayAndTeamSyncKeepsItsEarlierWeeks() {
        let planner = makePlanner()
        let today = planner.today
        let walk = SampleData.uuid(59)
        #expect(planner.moveBlock(walk, from: planner.blockOrigin(walk, on: today),
                                  to: .hour(date: today.description, startMin: 8 * 60 + 15))
                == .retime(startMin: 8 * 60 + 15))
        for offset in [-1, 0, 1, 6] {
            let day = today.adding(days: offset)
            #expect(block(planner, "Walk", on: day).startMin == 8 * 60 + 15, "\(day)")
        }
        let teamSync = SampleData.uuid(60)
        let start = planner.item(teamSync)?.startDate
        #expect(planner.moveBlock(teamSync, from: planner.blockOrigin(teamSync, on: today),
                                  to: .hour(date: today.description, startMin: 17 * 60 + 15))
                == .retime(startMin: 17 * 60 + 15))
        #expect(planner.item(teamSync)?.startDate == start)
        for weeks in [-2, -1, 0, 1] {
            let day = today.adding(days: 7 * weeks)
            #expect(block(planner, "Team sync", on: day).startMin == 17 * 60 + 15, "\(day)")
        }
    }

    // MARK: The block's menu and VoiceOver

    @Test func aHabitsMenuIsTheTickSkipPauseLengthAndAnytime() {
        let planner = makePlanner()
        let menu = planner.blockMenu(for: block(planner, "Walk"), in: schedule(planner))
        #expect(menu.status == [.tick("Done today", done: false), .skip("Skip today"), .pause])
        #expect(menu.moves.isEmpty)
        #expect(menu.own == [.changeLength, .anytime])
    }

    @Test func aOneOffsMenuListsTheWebsVerbsInItsOrder() {
        let planner = makePlanner()
        let today = planner.today
        let menu = planner.blockMenu(for: block(planner, "Lunch walk"), in: schedule(planner))
        #expect(menu.status == [.tick("Mark done", done: false), .pause])
        #expect(menu.moves == [
            .nextDay("Move to tomorrow", detail: "Fri, Oct 2", date: "2026-10-02"),
            .reschedule("Reschedule", RescheduleRow.quickRows(today: today, nextWeekStart: planner.nextWeekStart)),
            .braindump,
        ])
        #expect(menu.own == [.changeLength, .anytime])
        #expect(menu.entries == menu.status + menu.moves + menu.own)
        #expect(menu.entries.map(\.title) == [
            "Mark done", "Pause", "Move to tomorrow", "Reschedule", "Move to Braindump", "Change length",
            "Move to Anytime",
        ])
    }

    @Test func aDoneBlocksTickUndoesAndASkippedOneUnskips() {
        let planner = makePlanner()
        let today = planner.today
        let lunch = id(planner, "Lunch walk")
        planner.run(.tick("Mark done", done: false), on: block(planner, "Lunch walk"), in: schedule(planner))
        #expect(planner.isDone(planner.item(lunch)!, on: today))
        let done = planner.blockMenu(for: block(planner, "Lunch walk"), in: schedule(planner))
        guard case .tick(_, let isDone)? = done.status.first else {
            Issue.record("no tick")
            return
        }
        #expect(isDone)
        #expect(done.status.first?.symbol == "arrow.uturn.backward")

        planner.skip(SampleData.uuid(59), on: today)
        let skipped = planner.blockMenu(for: block(planner, "Walk"), in: schedule(planner))
        guard case .unskip? = skipped.status.first else {
            Issue.record("no unskip")
            return
        }
        planner.run(skipped.status[0], on: block(planner, "Walk"), in: schedule(planner))
        #expect(!block(planner, "Walk").skipped)
    }

    @Test func theMenuRunsEachVerbOnTheBlocksDay() {
        let planner = makePlanner()
        let today = planner.today
        let lunch = id(planner, "Lunch walk")
        let entry = planner.blockMenu(for: block(planner, "Lunch walk"), in: schedule(planner)).moves[0]
        planner.run(entry, on: block(planner, "Lunch walk"), in: schedule(planner))
        #expect(planner.item(lunch)?.startDate == today.adding(days: 1).description)

        let read = id(planner, "Read")
        planner.run(.anytime, on: block(planner, "Read"), in: schedule(planner))
        #expect(planner.item(read)?.timeBucket == DayBucket.anytime.rawValue)

        let gym = id(planner, "Gym")
        planner.run(.braindump, on: block(planner, "Gym"), in: schedule(planner))
        #expect(planner.braindump.contains { $0.id == gym })

        let walk = SampleData.uuid(59)
        planner.run(.pause, on: block(planner, "Walk"), in: schedule(planner))
        #expect(planner.item(walk)?.pausedAt != nil)
    }

    @Test func voiceOverHasTheMenusActionsAndTheQuarterHourSteps() {
        let planner = makePlanner()
        let actions = planner.spokenActions(for: block(planner, "Lunch walk"), in: schedule(planner))
        #expect(actions.map(\.name) == [
            "Mark done", "Pause", "Move to tomorrow", "Move to Braindump", "15 minutes later", "15 minutes earlier",
            "Make 15 minutes longer", "Make 15 minutes shorter", "Move to Anytime",
        ])
        let walk = planner.spokenActions(for: block(planner, "Walk"), in: schedule(planner))
        #expect(walk.map(\.name) == [
            "Done today", "Skip today", "Pause", "15 minutes later", "15 minutes earlier", "Make 15 minutes longer",
            "Make 15 minutes shorter", "Move to Anytime",
        ])
    }

    @Test func aStepIsOneWriteAndNeverPastMidnight() {
        let planner = makePlanner()
        let walk = SampleData.uuid(59)
        planner.run(.later, on: block(planner, "Walk"), in: schedule(planner))
        #expect(planner.item(walk)?.startTime == "08:00")
        planner.run(.earlier, on: block(planner, "Walk"), in: schedule(planner))
        planner.run(.earlier, on: block(planner, "Walk"), in: schedule(planner))
        #expect(planner.item(walk)?.startTime == "07:30")

        let today = planner.today
        planner.items.append(Item(id: UUID(), type: "task", title: "Last call", status: "pending",
                                  startDate: today.description, startTime: "23:45",
                                  timeBucket: DayBucket.evening.rawValue, duration: 15, isScheduled: true))
        planner.items.append(Item(id: UUID(), type: "task", title: "First light", status: "pending",
                                  startDate: today.description, startTime: "00:00",
                                  timeBucket: DayBucket.morning.rawValue, duration: 15, isScheduled: true))
        let late = planner.spokenActions(for: block(planner, "Last call"), in: schedule(planner))
        #expect(!late.contains(.later))
        #expect(late.contains(.earlier))
        let early = planner.spokenActions(for: block(planner, "First light"), in: schedule(planner))
        #expect(early.contains(.later))
        #expect(!early.contains(.earlier))
    }

    @Test func aMoveSaysWhereTheBlockLanded() {
        let planner = makePlanner()
        let today = planner.today
        let origin = BlockOrigin(day: today, skipped: false)
        let lunch = planner.item(id(planner, "Lunch walk"))!
        let walk = planner.item(SampleData.uuid(59))!
        let next = DayString("2026-10-08")!
        #expect(BlockMoveWords.announcement(.place(date: today.description, startMin: 615), item: lunch, from: origin)
                == "Moved to 10:15 AM")
        #expect(BlockMoveWords.announcement(.place(date: next.description, startMin: 615), item: lunch, from: origin)
                == "Moved to \(PlannerFormat.weekdayName(next)) at 10:15 AM")
        #expect(BlockMoveWords.announcement(.retime(startMin: 480), item: walk, from: origin)
                == "Moved to 8 AM, every day it repeats")
        #expect(BlockMoveWords.announcement(.place(date: "2026-09-01", startMin: 600),
                                            item: planner.item(SampleData.uuid(60))!, from: origin)
                == "Moved to 10 AM, every day it repeats")
        #expect(BlockMoveWords.announcement(.anytime(date: nil), item: lunch, from: origin) == "Moved to Anytime")
        #expect(BlockMoveWords.announcement(.braindump, item: lunch, from: origin) == "Moved to the braindump")
        #expect(BlockMoveWords.announcement(.pause, item: walk, from: origin) == nil)
        #expect(BlockMoveWords.announcement(BlockDrop.none, item: lunch, from: origin) == nil)
        #expect(BlockMoveWords.announcement(.refused(.skipped), item: lunch, from: origin) == nil)
        // A habit stored with no frequency is daily, the registry's default.
        let stretch = Item(id: UUID(), type: "habit", title: "Stretch", status: "pending", startTime: "08:00",
                           timeBucket: DayBucket.morning.rawValue)
        #expect(BlockMoveWords.announcement(.retime(startMin: 495), item: stretch, from: origin)
                == "Moved to 8:15 AM, every day it repeats")
        // A one-off retimed (a type with no date, never repeating) says no more.
        var once = stretch
        once.repeatFrequency = "none"
        #expect(BlockMoveWords.announcement(.retime(startMin: 495), item: once, from: origin) == "Moved to 8:15 AM")
    }

    @Test func theBandsHeaderSaysTheHintToVoiceOverDuringADrag() {
        let spoken = AnytimeBandRules.spokenHeader(count: 4)
        #expect(BlockMoveWords.anytimeHeader(spoken, dragging: false) == spoken)
        #expect(BlockMoveWords.anytimeHeader(spoken, dragging: true)
                == "Anytime, 4 items, Drop here to keep it time-free")
    }

    // MARK: The edges

    @Test func theGridScrollsItsBottomEdgeAndLeavesTheTopToTheSystem() {
        let edge = ScheduleMetrics.edgeZone
        let frame = 1.0 / 60
        #expect(!ScheduleAutoscroll.handDrivesTopEdge)
        #expect(ScheduleAutoscroll.step(fingerY: 4, viewportH: 600, coveredBottom: 0, dt: frame) == 0)
        #expect(ScheduleAutoscroll.step(fingerY: 4, viewportH: 600, coveredBottom: 0, dt: frame, topEdge: true) < 0)
        #expect(ScheduleAutoscroll.step(fingerY: 600 - edge / 2, viewportH: 600, coveredBottom: 0, dt: frame) > 0)
        #expect(ScheduleAutoscroll.step(fingerY: 300, viewportH: 600, coveredBottom: 0, dt: frame) == 0)
        // Under a sheet the edge is the sheet's top.
        #expect(ScheduleAutoscroll.step(fingerY: 300 - edge / 2, viewportH: 600, coveredBottom: 300, dt: frame) > 0)
        #expect(ScheduleAutoscroll.step(fingerY: 200, viewportH: 600, coveredBottom: 300, dt: frame) == 0)
    }
}
