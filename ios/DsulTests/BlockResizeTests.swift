import DsulCore
import Foundation
import Testing
@testable import Dsul

// Changing a block's length on the iPhone's Schedule (Week and blocks PR 9):
// the grip's session (BlockResize), what letting go writes through the live
// planner (`SamplePlanner.resize`, the existing `time` edit), the gate, the
// length actions VoiceOver has, and where the grips sit. Foundation only, so
// the shim runs it. The maths is DsulCore's and checked there
// (ResizeFixtureTests); the grips' gesture and haptics are SwiftUI's, and the
// device checks in ios/README.md ("Changing a block's length") cover them.

private struct ResizeFixtureError: Error, CustomStringConvertible {
    let description: String
}

/// The file at `relative` from the repo root: found by walking up from this
/// source file (the runner's checkout), or under /work, where the shim mounts
/// the tree it was copied from.
private func resizeFixture(_ relative: String, here: String = #filePath) throws -> Data {
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
    throw ResizeFixtureError(description: "\(relative) not found above \(here) or under /work")
}

/// One row of tests/fixtures/day/edit-writes.json: the item, the body the
/// route took, and the row it left.
private struct EditWriteRow {
    let item: Item
    let edit: [String: Any]
    let after: Item
}

private func editWriteRow(_ name: String) throws -> EditWriteRow {
    let data = try resizeFixture("tests/fixtures/day/edit-writes.json")
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let rows = root["cases"] as? [[String: Any]],
          let row = rows.first(where: { $0["name"] as? String == name }),
          let item = row["item"] as? [String: Any], let edit = row["edit"] as? [String: Any],
          let after = row["after"] as? [String: Any]
    else { throw ResizeFixtureError(description: "edit-writes.json has no row \(name)") }
    func decoded(_ object: [String: Any]) throws -> Item {
        return try JSONDecoder().decode(Item.self, from: JSONSerialization.data(withJSONObject: object))
    }
    return EditWriteRow(item: try decoded(item), edit: edit, after: try decoded(after))
}

/// A JSON object as one string, its keys sorted, so two bodies compare as
/// values.
private func sortedJSON(_ object: [String: Any]?) -> String? {
    guard let object, let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    else { return nil }
    return String(decoding: data, as: UTF8.self)
}

@MainActor
@Suite struct BlockResizeTests {
    private let ok = "{\"ok\":true}"
    private let hour = ScheduleMetrics.hourPx

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

    private func schedule(_ planner: SamplePlanner, on day: DayString? = nil) -> DaySchedule {
        planner.daySchedule(on: day ?? planner.today, fieldWidth: 333)
    }

    private func block(_ planner: SamplePlanner, _ title: String) -> ScheduleBlock {
        return schedule(planner).blocks.first { $0.item.title == title }!
    }

    private func id(_ planner: SamplePlanner, _ title: String) -> UUID {
        planner.items.first { $0.title == title }!.id
    }

    /// A task on the day at 9:00 for an hour: every edge on a quarter.
    private let plan = UUID(uuidString: "0d000000-0000-4000-8000-0000000000c1")!
    private var planJSON: String {
        return "{\"id\":\"\(lowerID(plan))\",\"type\":\"task\",\"title\":\"Plan the week\",\"status\":\"pending\","
            + "\"startDate\":\"2026-10-01\",\"timeBucket\":\"morning\",\"startTime\":\"09:00\",\"duration\":60,"
            + "\"isScheduled\":true,\"order\":3,\"completedDates\":[],\"skippedDates\":[],\"dailyCounts\":{}}"
    }

    /// One off the quarter, at 9:10 for 50 minutes, where the maths alone
    /// snaps a press with no travel (handoff, review finding).
    private let draft = UUID(uuidString: "0d000000-0000-4000-8000-0000000000c2")!
    private var draftJSON: String {
        return "{\"id\":\"\(lowerID(draft))\",\"type\":\"task\",\"title\":\"Draft notes\",\"status\":\"pending\","
            + "\"startDate\":\"2026-10-01\",\"timeBucket\":\"morning\",\"startTime\":\"09:10\",\"duration\":50,"
            + "\"isScheduled\":true,\"order\":4,\"completedDates\":[],\"skippedDates\":[],\"dailyCounts\":{}}"
    }

    private func liveServer(writes: [String]? = PlannerJSON.allWrites) async -> FakeServer {
        let server = FakeServer()
        await server.on(plannerRoute, .status(200, PlannerJSON.payload(writes: writes, extra: [planJSON, draftJSON])))
        await server.setFallback(.status(200, ok))
        return server
    }

    // MARK: What letting go writes

    @Test func theBottomGripSendsTheLengthAlone() async {
        let server = await liveServer()
        let planner = await loaded(server)
        let today = planner.today
        let span = block(planner, "Plan the week").span
        #expect(span == BlockSpan(startMin: 9 * 60, duration: 60))
        let resize = BlockResize()
        resize.select(plan, on: today)
        resize.press(.bottom, from: span, scrollOffset: 600, fingerY: 300)
        // An hour down the grid: an hour longer.
        resize.follow(translationY: hour, fingerY: 300 + hour, scrollOffset: 600)
        #expect(resize.shown == BlockSpan(startMin: 9 * 60, duration: 120))
        let before = await server.requests.count
        guard let release = resize.release() else {
            Issue.record("no release")
            return
        }
        #expect(release == GripRelease(id: plan, edge: .bottom, from: span,
                                       to: BlockSpan(startMin: 9 * 60, duration: 120)))
        // The grips stay for another go.
        #expect(resize.selected == BlockSelection(id: plan, day: today))
        #expect(!resize.isHeld)
        #expect(resize.shown == nil)

        let write = planner.resize(release.id, edge: release.edge, from: release.from, to: release.to)
        #expect(write == .duration(120))
        await drain(planner)
        let made = await posts(server, after: before)
        #expect(made.count == 1)
        #expect(made.first?.route == itemRoute(plan))
        #expect(sortedJSON(bodyJSON(made.first)) == "{\"action\":\"time\",\"duration\":120}")
        let item = planner.item(plan)
        #expect(item?.duration == 120)
        #expect(item?.startTime == "09:00")
        #expect(item?.timeBucket == DayBucket.morning.rawValue)
        #expect(block(planner, "Plan the week").span == BlockSpan(startMin: 9 * 60, duration: 120))
    }

    /// edit-writes.json's `time-top-grip-anytime-stored`: Team sync stored
    /// under Anytime at 13:00 for an hour, its top grip an hour and a half
    /// up. The bucket of the new start rides with it, or the route would
    /// refuse a time beside Anytime; the row is what the route left.
    @Test func theTopGripSendsTheBucketWithTheStart() async throws {
        let row = try editWriteRow("time-top-grip-anytime-stored")
        let server = await liveServer()
        let planner = await loaded(server)
        let id = row.item.id
        planner.items = [row.item]
        let resize = BlockResize()
        resize.select(id, on: planner.today)
        resize.press(.top, from: BlockSpan(startMin: 13 * 60, duration: 60), scrollOffset: 0, fingerY: 400)
        resize.follow(translationY: -1.5 * hour, fingerY: 400 - 1.5 * hour, scrollOffset: 0)
        #expect(resize.shown == BlockSpan(startMin: 11 * 60 + 30, duration: 150))
        let before = await server.requests.count
        guard let release = resize.release() else {
            Issue.record("no release")
            return
        }
        let write = planner.resize(release.id, edge: release.edge, from: release.from, to: release.to)
        #expect(write == .start(startTime: "11:30", duration: 150, timeBucket: .morning))
        await drain(planner)
        let made = await posts(server, after: before)
        #expect(made.count == 1)
        #expect(made.first?.route == itemRoute(id))
        #expect(sortedJSON(bodyJSON(made.first)) == sortedJSON(row.edit))
        #expect(planner.item(id) == row.after)
    }

    @Test func nothingChangedSendsNothing() async {
        let server = await liveServer()
        let planner = await loaded(server)
        let span = block(planner, "Plan the week").span
        let resize = BlockResize()
        resize.select(plan, on: planner.today)
        let before = await server.requests.count

        // A few points of travel snap back to the same length.
        resize.press(.bottom, from: span, scrollOffset: 0, fingerY: 300)
        resize.follow(translationY: 5, fingerY: 305, scrollOffset: 0)
        #expect(resize.shown == span)
        #expect(resize.steps == 0)
        var release = resize.release()
        #expect(release?.to == span)
        #expect(planner.resize(plan, edge: .bottom, from: span, to: span) == nil)

        // Down an hour and back: two steps, and the length it began with.
        resize.press(.top, from: span, scrollOffset: 0, fingerY: 300)
        resize.follow(translationY: hour, fingerY: 300 + hour, scrollOffset: 0)
        resize.follow(translationY: 0, fingerY: 300, scrollOffset: 0)
        #expect(resize.steps == 2)
        release = resize.release()
        #expect(release?.to == span)
        if let release {
            #expect(planner.resize(release.id, edge: release.edge, from: release.from, to: release.to) == nil)
        }

        await drain(planner)
        let made = await posts(server, after: before)
        #expect(made.isEmpty)
        #expect(planner.item(plan)?.duration == 60)
        #expect(planner.item(plan)?.startTime == "09:00")
    }

    /// A grip pressed and let go without moving sends nothing, even on a
    /// block off the quarter, where `resizePreview` snaps with no travel
    /// (9:10 for 50: its top grip answers 9:15, its bottom one 45 minutes),
    /// and even when the resting finger drifts by a point or two, as a real
    /// one does (under `ResizeGrips.slop`). Once it has moved, the maths is
    /// always asked, as on the web: back at zero it snaps.
    @Test func aGripPressedAndLetGoUnmovedSendsNothing() async {
        let server = await liveServer()
        let planner = await loaded(server)
        let span = block(planner, "Draft notes").span
        #expect(span == BlockSpan(startMin: 9 * 60 + 10, duration: 50))
        // The helper alone would write.
        #expect(resizeWrite(edge: .top, from: span, to: resizePreview(edge: .top, from: span, deltaMin: 0)) != nil)
        #expect(resizeWrite(edge: .bottom, from: span, to: resizePreview(edge: .bottom, from: span, deltaMin: 0))
                != nil)

        let resize = BlockResize()
        resize.select(draft, on: planner.today)
        let before = await server.requests.count
        for edge in ResizeEdge.allCases {
            // DragGesture(minimumDistance: 0) reports the touch-down as a
            // change with no translation.
            resize.press(edge, from: span, scrollOffset: 600, fingerY: 300)
            resize.follow(translationY: 0, fingerY: 300, scrollOffset: 600)
            #expect(!resize.moved)
            // A resting finger's drift, with a quarter point of the grid's,
            // stays under the slop.
            for drift in [0.33, -1.5, 2, 3.5, -3.5] {
                resize.follow(translationY: drift, fingerY: 300 + drift, scrollOffset: 600)
                resize.scrolled(to: 600.25)
            }
            #expect(!resize.moved)
            #expect(resize.shown == span)
            #expect(resize.steps == 0)
            guard let release = resize.release() else {
                Issue.record("no release")
                return
            }
            #expect(release.to == span)
            #expect(planner.resize(release.id, edge: release.edge, from: release.from, to: release.to) == nil)
        }
        await drain(planner)
        let unmoved = await posts(server, after: before)
        #expect(unmoved.isEmpty)
        #expect(planner.item(draft)?.startTime == "09:10")
        #expect(planner.item(draft)?.duration == 50)

        // Moved (the slop reached), then back where it began: the web's snap.
        resize.press(.top, from: span, scrollOffset: 600, fingerY: 300)
        resize.follow(translationY: ResizeGrips.slop, fingerY: 300 + ResizeGrips.slop, scrollOffset: 600)
        #expect(resize.moved)
        resize.follow(translationY: 0, fingerY: 300, scrollOffset: 600)
        #expect(resize.moved)
        #expect(resize.shown == BlockSpan(startMin: 9 * 60 + 15, duration: 45))
        guard let moved = resize.release() else {
            Issue.record("no release")
            return
        }
        #expect(planner.resize(moved.id, edge: moved.edge, from: moved.from, to: moved.to)
                == .start(startTime: "09:15", duration: 45, timeBucket: .morning))
        await drain(planner)
        let made = await posts(server, after: before)
        #expect(made.count == 1)
        #expect(sortedJSON(bodyJSON(made.first))
                == "{\"action\":\"time\",\"duration\":45,\"startTime\":\"09:15\",\"timeBucket\":\"morning\"}")
    }

    /// The travel is the finger's plus the grid's scroll since the press, so
    /// the autoscroll moves the edge under a still finger, and a finger that
    /// went back up while the grid scrolled down has gone nowhere.
    @Test func theGridsScrollIsPartOfTheTravel() {
        let resize = BlockResize()
        let span = BlockSpan(startMin: 9 * 60, duration: 60)
        resize.select(plan, on: DayString("2026-10-01")!)
        resize.press(.bottom, from: span, scrollOffset: 600, fingerY: 700)
        #expect(resize.scrolled(to: 600) == span)
        #expect(!resize.moved)
        #expect(resize.scrolled(to: 600 + hour) == BlockSpan(startMin: 9 * 60, duration: 120))
        #expect(resize.moved)
        #expect(resize.follow(translationY: -hour, fingerY: 700 - hour, scrollOffset: 600 + hour) == span)
        #expect(resize.fingerY == 700 - hour)
        #expect(resize.scrolled(to: 600 + 2 * hour) == BlockSpan(startMin: 9 * 60, duration: 120))
        // Up past the start: the top grip stops 15 minutes short of the end.
        _ = resize.release()
        resize.press(.top, from: span, scrollOffset: 600, fingerY: 100)
        #expect(resize.scrolled(to: 600 - hour) == BlockSpan(startMin: 8 * 60, duration: 120))
        #expect(resize.follow(translationY: 3 * hour, fingerY: 100 + 3 * hour, scrollOffset: 600 - hour)
                == BlockSpan(startMin: 9 * 60 + 45, duration: 15))
        resize.clear()
        #expect(resize.fingerY == nil)
        DragHold.shared.releaseNow()
    }

    /// A still finger pressed on a grip near the top or the bottom of the
    /// grid scrolls nothing: the grip's autoscroll waits until the press has
    /// moved, since a scroll would move the edge, and letting go would write
    /// it. Once it has moved, both edges scroll, until it is let go.
    @Test func aStillPressNeverScrolls() {
        let resize = BlockResize()
        let span = BlockSpan(startMin: 9 * 60 + 10, duration: 50)
        resize.select(draft, on: DayString("2026-10-01")!)
        // The finger 10pt into the viewport: inside the top edge's zone.
        resize.press(.top, from: span, scrollOffset: 600, fingerY: 10)
        #expect(resize.isHeld)
        #expect(!resize.drivesAutoscroll)
        resize.follow(translationY: 2, fingerY: 12, scrollOffset: 600)
        #expect(!resize.drivesAutoscroll)
        resize.follow(translationY: -ResizeGrips.slop, fingerY: 10 - ResizeGrips.slop, scrollOffset: 600)
        #expect(resize.drivesAutoscroll)
        #expect(resize.release() != nil)
        #expect(!resize.drivesAutoscroll)
        DragHold.shared.releaseNow()
    }

    /// Each press has a number, and a grip's touch acts only on its own: a
    /// second finger on the other grip is refused a press while one is in
    /// the hand, can't drive, end or cancel it, and presses from where it is
    /// once the first is let go, so its edge never jumps by the travel it
    /// made while it waited.
    @Test func aSecondFingerNeitherDrivesNorEndsTheFirst() {
        let resize = BlockResize()
        let span = BlockSpan(startMin: 9 * 60, duration: 60)
        resize.select(plan, on: DayString("2026-10-01")!)
        DragHold.shared.releaseNow()

        guard let first = resize.press(.bottom, from: span, scrollOffset: 0, fingerY: 300) else {
            Issue.record("no press")
            return
        }
        #expect(resize.holds(first))
        #expect(!resize.holds(nil))
        resize.follow(translationY: hour, fingerY: 300 + hour, scrollOffset: 0, press: first)
        #expect(resize.shown == BlockSpan(startMin: 9 * 60, duration: 120))

        // The other grip, touched while the first is held.
        #expect(resize.press(.top, from: span, scrollOffset: 0, fingerY: 200) == nil)
        #expect(resize.presses == first)
        #expect(resize.follow(translationY: 0, fingerY: 200, scrollOffset: 0, press: first + 1) == nil)
        #expect(resize.release(press: first + 1) == nil)
        resize.cancel(press: first - 1)
        #expect(resize.edge == .bottom)
        #expect(resize.shown == BlockSpan(startMin: 9 * 60, duration: 120))

        // The first lets go: its own length.
        #expect(resize.release(press: first)
                == GripRelease(id: plan, edge: .bottom, from: span, to: BlockSpan(startMin: 9 * 60, duration: 120)))
        #expect(!resize.holds(first))

        // The second, 30pt into its own gesture, now presses from there.
        let after = BlockSpan(startMin: 9 * 60, duration: 120)
        guard let second = resize.press(.top, from: after, scrollOffset: 0, fingerY: 230, translationY: 30) else {
            Issue.record("no second press")
            return
        }
        #expect(second == first + 1)
        #expect(resize.follow(translationY: 30, fingerY: 230, scrollOffset: 0, press: second) == after)
        #expect(!resize.moved)
        #expect(resize.follow(translationY: 30 + hour, fingerY: 230 + hour, scrollOffset: 0, press: second)
                == BlockSpan(startMin: 10 * 60, duration: 60))
        #expect(resize.release(press: first) == nil)
        #expect(resize.isHeld)
        resize.cancel(press: second)
        #expect(!resize.isHeld)
        #expect(!DragHold.shared.isHeld)
        resize.clear()
    }

    // MARK: The selection

    @Test func oneBlockIsSelectedOnOneDayUntilCleared() {
        let resize = BlockResize()
        let today = DayString("2026-10-01")!
        #expect(resize.selected == nil)
        // A press with nothing selected is nothing.
        resize.press(.bottom, from: BlockSpan(startMin: 540, duration: 60), scrollOffset: 0, fingerY: 0)
        #expect(!resize.isHeld)
        #expect(resize.presses == 0)

        resize.select(plan, on: today)
        #expect(resize.isSelected(plan, on: today))
        #expect(!resize.isSelected(plan, on: today.adding(days: 1)))
        resize.press(.bottom, from: BlockSpan(startMin: 540, duration: 60), scrollOffset: 0, fingerY: 0)
        #expect(resize.isHeld)
        // Another block chosen: the grip in the hand is let go, unwritten.
        resize.select(draft, on: today)
        #expect(!resize.isHeld)
        #expect(resize.shown == nil)
        #expect(!resize.isSelected(plan, on: today))
        #expect(resize.isSelected(draft, on: today))
        #expect(resize.release() == nil)
        resize.clear()
        #expect(resize.selected == nil)
        DragHold.shared.releaseNow()
    }

    /// Only Change length selects (B3): a lift clears the selection, so a
    /// drop never leaves grips, and the drop itself selects nothing.
    @Test func aLiftClearsTheSelectionAndADropSelectsNothing() {
        let planner = makePlanner()
        let today = planner.today
        let walk = SampleData.uuid(59)
        let lunch = id(planner, "Lunch walk")
        let drag = ScheduleDrag()
        DragHold.shared.releaseNow()

        drag.resize.select(lunch, on: today)
        drag.resize.press(.bottom, from: block(planner, "Lunch walk").span, scrollOffset: 0, fingerY: 300)
        drag.beginMove(itemID: walk, durationMin: 20, source: .block(day: today), anchor: 0.5, confinedTo: today)
        #expect(drag.resize.selected == nil)
        #expect(!drag.resize.isHeld)
        // The lift's own hold is kept.
        #expect(DragHold.shared.isHeld)
        _ = planner.moveBlock(walk, from: planner.blockOrigin(walk, on: today),
                              to: .hour(date: today.description, startMin: 8 * 60 + 15))
        drag.reset()
        #expect(drag.resize.selected == nil)
        #expect(planner.item(walk)?.startTime == "08:15")

        // A braindump row's lift clears it too.
        drag.resize.select(lunch, on: today)
        drag.begin(itemID: planner.braindump.first?.id, durationMin: 15, detent: .medium)
        #expect(drag.resize.selected == nil)
        drag.reset()

        // A menu pick that ends a stray lift keeps what the pick then selects.
        drag.beginMove(itemID: lunch, durationMin: 45, source: .block(day: today), anchor: 0.5, confinedTo: nil)
        drag.endStrayLift()
        drag.resize.select(lunch, on: today)
        #expect(drag.resize.isSelected(lunch, on: today))
        DragHold.shared.releaseNow()
    }

    /// A press takes the hold on fetched data a block's lift takes, each
    /// change renews it, and letting go, a cancel, or the write lets it go.
    /// No await between the steps: the hold is the app's one.
    @Test func aGripHoldsFetchedDataUntilItIsLetGo() {
        let planner = makePlanner()
        let today = planner.today
        let lunch = id(planner, "Lunch walk")
        let span = block(planner, "Lunch walk").span
        let resize = BlockResize()
        DragHold.shared.releaseNow()
        resize.select(lunch, on: today)
        #expect(!DragHold.shared.isHeld)

        resize.press(.bottom, from: span, scrollOffset: 0, fingerY: 300)
        #expect(DragHold.shared.isHeld)
        #expect(resize.presses == 1)
        _ = resize.release()
        #expect(!DragHold.shared.isHeld)

        // A cancel lets go only of the press it was for.
        resize.press(.bottom, from: span, scrollOffset: 0, fingerY: 300)
        resize.follow(translationY: hour, fingerY: 300 + hour, scrollOffset: 0)
        #expect(resize.presses == 2)
        resize.cancel(press: 1)
        #expect(resize.isHeld)
        #expect(DragHold.shared.isHeld)
        resize.cancel(press: 2)
        #expect(!resize.isHeld)
        #expect(resize.shown == nil)
        #expect(!DragHold.shared.isHeld)
        #expect(planner.item(lunch)?.duration == 45)

        // The write lets it go at once, as a drop does.
        resize.press(.bottom, from: span, scrollOffset: 0, fingerY: 300)
        #expect(DragHold.shared.isHeld)
        planner.resize(lunch, edge: .bottom, from: span, to: BlockSpan(startMin: span.startMin, duration: 60))
        #expect(!DragHold.shared.isHeld)
        #expect(planner.item(lunch)?.duration == 60)
        resize.clear()
        DragHold.shared.releaseNow()
    }

    // MARK: The gate

    /// B4 and B16: the web's `canResize`, plus a skipped occurrence's strip
    /// and the server's `time` write. A done block keeps it.
    @Test func whoMayChangeLength() async {
        let planner = makePlanner()
        let today = planner.today
        let lunch = block(planner, "Lunch walk")
        #expect(planner.canResize(lunch, in: schedule(planner)))
        #expect(planner.blockMenu(for: lunch, in: schedule(planner)).own == [.changeLength, .anytime])

        planner.run(.tick("Mark done", done: false), on: lunch, in: schedule(planner))
        let done = block(planner, "Lunch walk")
        #expect(done.done)
        #expect(planner.canResize(done, in: schedule(planner)))
        #expect(planner.blockMenu(for: done, in: schedule(planner)).own.contains(.changeLength))

        planner.skip(SampleData.uuid(59), on: today)
        let skipped = block(planner, "Walk")
        #expect(skipped.skipped)
        #expect(!planner.canResize(skipped, in: schedule(planner)))
        #expect(!planner.blockMenu(for: skipped, in: schedule(planner)).own.contains(.changeLength))
        let spoken = planner.spokenActions(for: skipped, in: schedule(planner))
        #expect(!spoken.contains(.longer))
        #expect(!spoken.contains(.shorter))

        var item = planner.item(lunch.id)!
        #expect(planner.canResize(item))
        item.inProjectBlock = true
        #expect(!planner.canResize(item), "a block in a project block takes the project's extent")
        item.inProjectBlock = false
        item.startTime = ""
        #expect(!planner.canResize(item), "an empty time is none, as the web's !!startTime")
        item.startTime = nil
        #expect(!planner.canResize(item))

        // Asked again at the write, off the item as it is then.
        let read = id(planner, "Read")
        let readSpan = block(planner, "Read").span
        if let index = planner.items.firstIndex(where: { $0.id == read }) {
            planner.items[index].inProjectBlock = true
        }
        #expect(planner.resize(read, edge: .bottom, from: readSpan,
                               to: BlockSpan(startMin: readSpan.startMin, duration: 60)) == nil)
        #expect(planner.item(read)?.duration == 30)

        // A server that takes no time edit: no length to change.
        let server = await liveServer(writes: PlannerJSON.allWrites.filter { $0 != "time" })
        let live = await loaded(server)
        let planned = block(live, "Plan the week")
        #expect(!live.canResize(planned, in: schedule(live)))
        #expect(!live.blockMenu(for: planned, in: schedule(live)).own.contains(.changeLength))
        #expect(live.resize(plan, edge: .bottom, from: planned.span,
                            to: BlockSpan(startMin: 9 * 60, duration: 90)) == nil)
    }

    @Test func changeLengthIsAMenuEntryThatWritesNothing() {
        let planner = makePlanner()
        let lunch = block(planner, "Lunch walk")
        let before = planner.items
        #expect(BlockMenuEntry.changeLength.title == "Change length")
        #expect(BlockMenuEntry.changeLength.symbol == "arrow.up.and.down")
        planner.run(.changeLength, on: lunch, in: schedule(planner))
        #expect(planner.items == before)
        // VoiceOver has the length pair instead.
        let spoken = planner.spokenActions(for: lunch, in: schedule(planner))
        #expect(!spoken.contains(.entry(.changeLength)))
        #expect(spoken.contains(.longer))
        #expect(spoken.contains(.shorter))
    }

    // MARK: VoiceOver

    /// "Make 15 minutes longer" and "shorter" move the bottom grip a quarter
    /// hour, one write each, offered only when they write: shorter stops at
    /// 15 minutes, longer at midnight, and a length off the quarter lands on
    /// one.
    @Test func voiceOverMakesABlockAQuarterHourLongerOrShorter() {
        let planner = makePlanner()
        let today = planner.today
        let lunch = id(planner, "Lunch walk")
        #expect(BlockSpokenAction.longer.name == "Make 15 minutes longer")
        #expect(BlockSpokenAction.shorter.name == "Make 15 minutes shorter")

        planner.run(.longer, on: block(planner, "Lunch walk"), in: schedule(planner))
        #expect(planner.item(lunch)?.duration == 60)
        #expect(planner.item(lunch)?.startTime == "12:30")
        planner.run(.shorter, on: block(planner, "Lunch walk"), in: schedule(planner))
        planner.run(.shorter, on: block(planner, "Lunch walk"), in: schedule(planner))
        #expect(planner.item(lunch)?.duration == 30)

        let standup = planner.spokenActions(for: block(planner, "Standup"), in: schedule(planner))
        #expect(standup.contains(.longer))
        #expect(!standup.contains(.shorter))

        planner.items.append(Item(id: UUID(), type: "task", title: "Last call", status: "pending",
                                  startDate: today.description, startTime: "23:45",
                                  timeBucket: DayBucket.evening.rawValue, duration: 15, isScheduled: true))
        let late = planner.spokenActions(for: block(planner, "Last call"), in: schedule(planner))
        #expect(!late.contains(.longer))
        #expect(!late.contains(.shorter))
        #expect(planner.changeLength(block(planner, "Last call"), in: schedule(planner), by: 15) == nil)

        let odd = UUID()
        planner.items.append(Item(id: odd, type: "task", title: "Odd length", status: "pending",
                                  startDate: today.description, startTime: "14:10",
                                  timeBucket: DayBucket.afternoon.rawValue, duration: 50, isScheduled: true))
        // Off the quarter, a step lands on one: 50 minutes shorter is 30.
        #expect(planner.lengthStep(block(planner, "Odd length"), in: schedule(planner), by: -15)
                == BlockSpan(startMin: 14 * 60 + 10, duration: 30))
        #expect(planner.lengthStep(block(planner, "Odd length"), in: schedule(planner), by: 15)
                == BlockSpan(startMin: 14 * 60 + 10, duration: 60))
        #expect(planner.changeLength(block(planner, "Odd length"), in: schedule(planner), by: 15) == .duration(60))
        #expect(planner.item(odd)?.duration == 60)
    }

    @Test func aLengthIsSaidAsTheNewRange() {
        #expect(BlockResizeWords.announcement(BlockSpan(startMin: 12 * 60 + 30, duration: 45)) == "12:30 to 1:15 PM")
        #expect(BlockResizeWords.announcement(BlockSpan(startMin: 9 * 60, duration: 60)) == "9 to 10 AM")
        #expect(BlockResizeWords.announcement(BlockSpan(startMin: 11 * 60 + 30, duration: 150))
                == "11:30 AM to 2 PM")
        #expect(BlockResizeWords.announcement(BlockSpan(startMin: 23 * 60 + 45, duration: 15))
                == "11:45 PM to 12 AM")
        #expect(BlockResizeWords.announcement(BlockSpan(startMin: 7 * 60, duration: 15)) == "7 to 7:15 AM")
    }

    // MARK: Where the grips sit

    @Test func theGripsSitOnThePanesEnds() {
        let frame = blockFrame(startMin: 9 * 60, duration: 60, fieldWidth: 333)
        let top = ResizeGrips.placement(.top, frame: frame, inLane: false)
        let bottom = ResizeGrips.placement(.bottom, frame: frame, inLane: false)
        #expect(top == GripPlacement(edge: .top, x: frame.paneX + 22, y: frame.paneTop))
        #expect(bottom == GripPlacement(edge: .bottom, x: frame.paneX + frame.paneWidth - 22,
                                        y: frame.paneTop + frame.paneHeight))
        // A 15-minute block's two targets never overlap on a wide pane.
        let short = blockFrame(startMin: 9 * 60, duration: 15, fieldWidth: 333)
        let pair = ResizeGrips.placements(short, plan: .lone)
        #expect(pair.map(\.edge) == [.top, .bottom])
        #expect(abs(pair[1].x - pair[0].x) >= ResizeGrips.target)

        // A pane narrower than a target: both centred on it.
        var narrow = frame
        narrow.paneWidth = 30
        #expect(ResizeGrips.placement(.top, frame: narrow, inLane: false).x == narrow.paneX + 15)
        #expect(ResizeGrips.placement(.bottom, frame: narrow, inLane: false).x == narrow.paneX + 15)

        // A nested child on the edge: the grip goes to the parent's lane.
        var plan = OverlapPlan.lone
        plan.handleTopLane = true
        let laned = ResizeGrips.placements(frame, plan: plan)
        #expect(laned[0].x == frame.bandX + (ScheduleMetrics.lanePx + 8) / 2)
        #expect(laned[1].x == frame.paneX + frame.paneWidth - 22)
    }

    @Test func aHeldBlockDrawsAtTheGripsSpan() {
        let planner = makePlanner()
        let lunch = block(planner, "Lunch walk")
        let drawn = lunch.resized(to: BlockSpan(startMin: 12 * 60 + 15, duration: 90))
        #expect(drawn.id == lunch.id)
        #expect(drawn.startMin == 12 * 60 + 15)
        #expect(drawn.duration == 90)
        #expect(drawn.item.startTime == "12:15")
        #expect(drawn.item.duration == 90)
        #expect(drawn.done == lunch.done)
        #expect(drawn.skipped == lunch.skipped)
        #expect(drawn.tickLabel == lunch.tickLabel)
        #expect(drawn.plan == lunch.plan.bandOnly)
        #expect(drawn.span == BlockSpan(startMin: 12 * 60 + 15, duration: 90))

        var plan = OverlapPlan.lone
        plan.contentTop = 10
        plan.contentHeight = 20
        plan.handleTopLane = true
        plan.handleBottomLane = true
        let band = plan.bandOnly
        #expect(band.contentTop == nil)
        #expect(band.contentHeight == nil)
        #expect(!band.handleTopLane)
        #expect(!band.handleBottomLane)
        #expect(band.left == plan.left)
        #expect(band.paneLeft == plan.paneLeft)
        #expect(band.railX == plan.railX)
        #expect(band.z == plan.z)
        #expect(band.widthFraction == plan.widthFraction)
    }
}
