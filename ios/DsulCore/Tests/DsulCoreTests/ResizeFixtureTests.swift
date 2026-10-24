import Foundation
import Testing
import DsulCore

// The web's own answers for changing a block's length, checked against
// ScheduleMath.swift's `resizeDeltaMin`, `resizePreview` and `resizeWrite`
// (Week and blocks PR 9). tests/unit/day-fixtures.test.ts runs every case
// through the real lib/schedule-resize.ts and commits the results to
// tests/fixtures/day/resize.json. Never edit the JSON by hand: regenerate it
// from the Vitest side (UPDATE_FIXTURES=1).
//
// - `constants`: `RESIZE_SNAP_MIN`, `RESIZE_MIN_DURATION`, `DAY_END_MIN`.
// - `deltaMin`: a travel in points at the phone's 75pt hour and two of the
//   web's fitted heights, in minutes, compared to the bit.
// - `preview`: both edges (bottom first) over 17 blocks and 15 travels, each
//   with where it lands (`expected`, whole minutes) and what letting go there
//   writes (`write`: `{"duration"}` for the bottom grip,
//   `{"startTime","duration","timeBucket"}` for the top, null for no change).
//   The phone sends `write` as the `time` intent, `{"action":"time", …}`. The
//   last four blocks are stored starting outside the day (24:00, 24:15, and
//   -65, the "-1:-5" the web's old maths could write), which the phone reads
//   back as the web does (DayItems.swift `minutesOf`).
//
// The top grip's row in tests/fixtures/day/edit-writes.json
// (`time-top-grip-anytime-stored`) is built from the same helper, so it is
// checked here too, as the body the phone's grip sends.

private struct DeltaCase: Decodable, Sendable {
    let name: String
    let deltaPx: Double
    let hourPx: Double
    let expected: Double
}

private struct SpanRow: Decodable, Sendable {
    let startMin: Int
    let duration: Int

    var span: BlockSpan { BlockSpan(startMin: startMin, duration: duration) }
}

private struct PreviewCase: Decodable, Sendable {
    let name: String
    let edge: String
    let startMin: Int
    let duration: Int
    let deltaMin: Double
    let expected: SpanRow
    /// The write's keys, as the TS answered them; nil for null (no change).
    let write: JSONValue?
}

private struct Fixture: Decodable, Sendable {
    let constants: [String: Int]
    let deltaMin: [DeltaCase]
    let preview: [PreviewCase]
}

/// The rows again as bare objects, to check their key sets: a decoded
/// optional can't tell a null `write` from a missing one.
private struct RawFixture: Decodable, Sendable {
    let deltaMin: [[String: JSONValue]]
    let preview: [[String: JSONValue]]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func fixtureData(_ here: String = #filePath) throws -> Data {
    let relative = "tests/fixtures/day/resize.json"
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            return try Data(contentsOf: candidate)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw FixtureError.notFound("\(relative) above \(here)")
}

private func loadFixture() throws -> Fixture {
    try JSONDecoder().decode(Fixture.self, from: fixtureData())
}

private func edge(_ c: PreviewCase) throws -> ResizeEdge {
    try #require(ResizeEdge(rawValue: c.edge), "\(c.name): unknown edge \(c.edge)")
}

/// `body` as the JSON it encodes to.
private func json(_ body: ItemWriteBody) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(body))
}

/// The wire body of a grip's write: the `time` intent with the write's keys.
private func wire(_ write: ResizeWrite) throws -> JSONValue {
    try json(.edit(write.edit))
}

/// The fixture's `write` as the phone sends it: `{"action":"time", …write}`.
private func timeBody(_ write: JSONValue) -> JSONValue? {
    guard case .object(var fields) = write else { return nil }
    fields["action"] = .string("time")
    return .object(fields)
}

@Suite struct ResizeFixtureTests {
    /// Every number the helper names is the Swift's, and a constant the TS
    /// adds fails here until the port names it.
    @Test func theConstantsAreTheWebs() throws {
        let swift: [String: Int] = [
            "RESIZE_SNAP_MIN": ScheduleMetrics.snapMin,
            "RESIZE_MIN_DURATION": ScheduleMetrics.resizeMinDuration,
            "DAY_END_MIN": ScheduleMetrics.dayEndMin,
        ]
        let web = try loadFixture().constants
        #expect(Set(web.keys) == Set(swift.keys))
        for (key, value) in web {
            #expect(swift[key] == value, "\(key)")
        }
    }

    /// The rows carry exactly the keys decoded here, and the cases reach
    /// both edges, every stop, both writes and every part of day.
    @Test func everySectionHasCases() throws {
        let raw = try JSONDecoder().decode(RawFixture.self, from: fixtureData())
        #expect(!raw.deltaMin.isEmpty)
        for row in raw.deltaMin {
            #expect(Set(row.keys) == ["name", "deltaPx", "hourPx", "expected"], "\(row.keys.sorted())")
        }
        for row in raw.preview {
            #expect(Set(row.keys) == ["name", "edge", "startMin", "duration", "deltaMin", "expected", "write"],
                    "\(row.keys.sorted())")
        }

        let f = try loadFixture()
        #expect(f.deltaMin.contains { $0.hourPx == ScheduleMetrics.hourPx }, "the phone's hour height")
        #expect(Set(f.preview.map(\.edge)) == Set(ResizeEdge.allCases.map(\.rawValue)))
        // Both writes and no write, and the top grip's every part of day.
        #expect(f.preview.contains { $0.edge == "bottom" && $0.write != nil })
        #expect(f.preview.contains { $0.edge == "bottom" && $0.write == nil })
        #expect(f.preview.contains { $0.edge == "top" && $0.write == nil })
        let buckets = Set(f.preview.compactMap { c -> String? in
            guard case .object(let fields)? = c.write, case .string(let bucket)? = fields["timeBucket"] else {
                return nil
            }
            return bucket
        })
        #expect(buckets == ["morning", "afternoon", "evening"])
        // The stops: an end at 24:00, a start at 0:00, and the top's last
        // quarter before midnight; and a length the floor holds at 15.
        #expect(f.preview.contains { $0.edge == "bottom" && $0.expected.startMin + $0.expected.duration == 1440 })
        #expect(f.preview.contains { $0.edge == "top" && $0.expected.startMin == 0 })
        #expect(f.preview.contains { $0.edge == "top" && $0.expected.startMin == 1425 })
        #expect(f.preview.contains { $0.expected.duration == ScheduleMetrics.resizeMinDuration })
        // A block stored past midnight, held to 24:00 by the top grip, and the
        // edges with nothing inside the day to hold to, which stay put.
        #expect(f.preview.contains {
            $0.edge == "top" && $0.startMin + $0.duration > 1440 && $0.expected.startMin + $0.expected.duration == 1440
        })
        let held = { (c: PreviewCase) in c.expected.span == BlockSpan(startMin: c.startMin, duration: c.duration) }
        #expect(f.preview.contains { $0.edge == "bottom" && $0.startMin >= 1440 && $0.deltaMin != 0 && held($0) })
        #expect(f.preview.contains { $0.edge == "bottom" && $0.startMin < 0 && $0.deltaMin != 0 && held($0) })
        #expect(f.preview.contains { $0.edge == "top" && $0.startMin + $0.duration <= 0 && $0.deltaMin != 0 && held($0) })
    }

    /// A travel in points is the web's in minutes, to the bit.
    @Test func theTravelIsTheWebs() throws {
        for c in try loadFixture().deltaMin {
            #expect(resizeDeltaMin(c.deltaPx, hourPx: c.hourPx) == c.expected, "\(c.name)")
        }
    }

    @Test func eachEdgeLandsWhereTheWebsDoes() throws {
        for c in try loadFixture().preview {
            let e = try edge(c)
            let got = resizePreview(edge: e, startMin: c.startMin, duration: c.duration, deltaMin: c.deltaMin)
            #expect(got == c.expected.span, "\(c.name)")
            let from = BlockSpan(startMin: c.startMin, duration: c.duration)
            #expect(resizePreview(edge: e, from: from, deltaMin: c.deltaMin) == got, "\(c.name): from a span")
        }
    }

    /// Letting go writes what the web writes, key for key (none when nothing
    /// changed), and the phone's body for it is the `time` intent's.
    @Test func eachWriteIsTheWebs() throws {
        for c in try loadFixture().preview {
            let e = try edge(c)
            let from = BlockSpan(startMin: c.startMin, duration: c.duration)
            let landed = resizePreview(edge: e, from: from, deltaMin: c.deltaMin)
            let write = resizeWrite(edge: e, from: from, to: landed)
            guard let expected = c.write else {
                #expect(write == nil, "\(c.name): nothing to write")
                continue
            }
            let got = try #require(write, "\(c.name): a write")
            #expect(try wire(got) == timeBody(expected), "\(c.name)")
            switch (e, got) {
            case (.bottom, .duration), (.top, .start):
                break
            default:
                Issue.record("\(c.name): the \(e) grip wrote \(got)")
            }
        }
    }

    /// Every write the helper answers is one the `time` intent takes, as far
    /// as the body can say: no length over the route's cap
    /// (`EditLimits.durationMax`) or under 1, and a start the stored `HH:mm`
    /// can say, for a block stored past midnight or outside the day too.
    @Test func everyWriteIsATimeEditTheRouteTakes() throws {
        let id = UUID(uuidString: "00000000-0000-4000-8000-000000000901")!
        for c in try loadFixture().preview {
            let e = try edge(c)
            let from = BlockSpan(startMin: c.startMin, duration: c.duration)
            let landed = resizePreview(edge: e, from: from, deltaMin: c.deltaMin)
            guard let write = resizeWrite(edge: e, from: from, to: landed) else { continue }
            let task = Item(id: id, title: "Block", startDate: "2026-10-01", startTime: minutesToTime(c.startMin),
                            timeBucket: DayBucket.anytime.rawValue, duration: c.duration)
            let habit = Item(id: id, type: "habit", title: "Stretch", startTime: minutesToTime(c.startMin),
                             timeBucket: "morning", duration: c.duration)
            #expect(editAllowed(write.edit, on: task, caps: .task), "\(c.name)")
            #expect(editAllowed(write.edit, on: habit, caps: .habit), "\(c.name): a habit")
        }
    }

    /// edit-writes.json's top-grip row is this helper's write for Team sync
    /// (13:00 for 60, filed under Anytime, its top grip dragged an hour and a
    /// half up), so the grip's body is the row the Time chip's port already
    /// takes (EditWritesFixtureTests), bucket and all.
    @Test func theTopGripRowInEditWritesIsAResize() throws {
        let row = try #require(try loadEditWrites().cases.first(where: { $0.name == "time-top-grip-anytime-stored" }))
        #expect(row.item.timeBucket == DayBucket.anytime.rawValue)
        let start = try #require(minutesOfDay(row.item.startTime))
        let duration = try #require(row.item.duration)
        let from = BlockSpan(startMin: start, duration: duration)
        let travel = resizeDeltaMin(-90 * ScheduleMetrics.hourPx / 60, hourPx: ScheduleMetrics.hourPx)
        let landed = resizePreview(edge: .top, from: from, deltaMin: travel)
        #expect(landed == BlockSpan(startMin: 690, duration: 150))
        let write = try #require(resizeWrite(edge: .top, from: from, to: landed))
        #expect(write == .start(startTime: "11:30", duration: 150, timeBucket: .morning))
        #expect(try wire(write) == row.edit)
        #expect(phoneBody(row.edit) == .edit(write.edit))
        #expect(editAllowed(write.edit, on: row.item, caps: caps(row.item.typeName)))
        // The server takes it, and files the block under the new start's part
        // of day (the row's `after`, checked by EditWritesFixtureTests).
        #expect(row.refusal == nil)
        #expect(row.after?.timeBucket == DayBucket.morning.rawValue)
    }

    /// The day holds both edges, over a sweep from before 0:00 to past 24:00
    /// the fixture only samples: the other edge stays (the top's end held to
    /// 24:00), the bottom's end never passes 24:00, no length is over a day,
    /// the top's start stays inside the day and is a time the stored `HH:mm`
    /// can say, and the top's part of day is the hour's. An edge with nothing
    /// inside the day to hold to keeps the block as it was.
    @Test func theDayHoldsBothEdges() {
        var failures: [String] = []
        let deltas: [Double] = [-2000, -600, -90, -15, -7.6, -7.5, -3.2, 0, 3.2, 7.4, 7.5, 15, 90, 600, 2000]
        for start in stride(from: -130, to: 1570, by: 5) {
            let rest = max(0, 1440 - start)
            for duration in Set([0, 1, 10, 14, 15, 30, 45, 60, 120, 600, 1440, 1500, rest, rest + 30]) {
                let from = BlockSpan(startMin: start, duration: duration)
                let end = min(start + duration, 1440)
                for delta in deltas {
                    let bottom = resizePreview(edge: .bottom, from: from, deltaMin: delta)
                    if start < 0 || start >= 1440 {
                        if bottom != from { failures.append("bottom \(start)+\(duration) \(delta) moved: \(bottom)") }
                    } else if bottom.startMin != start || bottom.startMin + bottom.duration > 1440
                        || bottom.duration < min(15, 1440 - start) || bottom.duration > 1440 {
                        failures.append("bottom \(start)+\(duration) \(delta): \(bottom)")
                    }
                    let top = resizePreview(edge: .top, from: from, deltaMin: delta)
                    if end <= 0 {
                        if top != from { failures.append("top \(start)+\(duration) \(delta) moved: \(top)") }
                        continue
                    }
                    if top.startMin + top.duration != end || top.startMin < 0
                        || top.startMin > max(0, end - 15) || top.duration < 1
                        || minutesOfDay(minutesToTime(top.startMin)) != top.startMin {
                        failures.append("top \(start)+\(duration) \(delta): \(top)")
                    }
                    if case .start(let time, _, let bucket)? = resizeWrite(edge: .top, from: from, to: top),
                       time != minutesToTime(top.startMin) || bucket != DayBucket(bucketForMinute(top.startMin)) {
                        failures.append("top write \(start)+\(duration) \(delta): \(time) \(bucket)")
                    }
                }
            }
        }
        #expect(failures.isEmpty, "\(failures.prefix(10))")
    }

    /// The three places an edge used to leave the day (the one deliberate
    /// change from the web's inline maths), pinned by name.
    @Test func theStopsAtMidnight() {
        // The bottom edge's end stops at 24:00: 23:00 for 30, two hours down.
        #expect(resizePreview(edge: .bottom, startMin: 1380, duration: 30, deltaMin: 120)
            == BlockSpan(startMin: 1380, duration: 60))
        // The day wins over the floor: 23:50 for 10 stays 10, so nothing is written.
        let late = BlockSpan(startMin: 1430, duration: 10)
        #expect(resizePreview(edge: .bottom, from: late, deltaMin: 30) == late)
        #expect(resizeWrite(edge: .bottom, from: late, to: late) == nil)
        // A block stored past midnight (23:30 for 60): the top grip holds its
        // end at 24:00, so the start stops at 23:45, and dragged a day up it
        // is a day long, never the 1,470 minutes the route would refuse.
        let pastMidnight = BlockSpan(startMin: 1410, duration: 60)
        let top = resizePreview(edge: .top, from: pastMidnight, deltaMin: 45)
        #expect(top == BlockSpan(startMin: 1425, duration: 15))
        #expect(resizeWrite(edge: .top, from: pastMidnight, to: top)
            == .start(startTime: "23:45", duration: 15, timeBucket: .evening))
        #expect(resizePreview(edge: .top, from: pastMidnight, deltaMin: -1500)
            == BlockSpan(startMin: 0, duration: 1440))
        // A block ending before 0:15 can only start at 0:00: 0:00 for 10
        // stays, and writes nothing; 0:05 for 5 goes to 0:00 even unmoved.
        let early = BlockSpan(startMin: 0, duration: 10)
        #expect(resizePreview(edge: .top, from: early, deltaMin: 15) == early)
        #expect(resizeWrite(edge: .top, from: early, to: early) == nil)
        #expect(resizePreview(edge: .top, startMin: 5, duration: 5, deltaMin: 0)
            == BlockSpan(startMin: 0, duration: 10))
        // Stored starting outside the day: the bottom grip keeps a start it
        // can't end inside the day from, so nothing is written (it once wrote
        // a length under zero); the top grip brings 24:15 back to 23:45 or
        // earlier, and keeps a block that ends by 0:00.
        let tomorrow = BlockSpan(startMin: 1455, duration: 30)
        #expect(resizePreview(edge: .bottom, from: tomorrow, deltaMin: 60) == tomorrow)
        #expect(resizePreview(edge: .top, from: tomorrow, deltaMin: -60) == BlockSpan(startMin: 1395, duration: 45))
        let before = BlockSpan(startMin: -65, duration: 15)
        #expect(resizePreview(edge: .bottom, from: before, deltaMin: 60) == before)
        #expect(resizePreview(edge: .top, from: before, deltaMin: 600) == before)
    }

    /// The bottom grip sends the length alone; the top grip the start with
    /// its length and part of day; nothing when the edge lands where it was.
    @Test func eachGripWritesItsOwnKeys() throws {
        let block = BlockSpan(startMin: 600, duration: 60)
        let id = UUID(uuidString: "00000000-0000-4000-8000-000000000902")!
        #expect(TimedEntry(item: Item(id: id, title: "Standup"), startMin: 600, duration: 60).span == block)
        let longer = resizePreview(edge: .bottom, from: block, deltaMin: 30)
        #expect(longer == BlockSpan(startMin: 600, duration: 90))
        let bottom = try #require(resizeWrite(edge: .bottom, from: block, to: longer))
        #expect(bottom == .duration(90))
        #expect(try wire(bottom) == .object(["action": .string("time"), "duration": .number(90)]))

        let earlier = resizePreview(edge: .top, from: block, deltaMin: -150)
        #expect(earlier == BlockSpan(startMin: 450, duration: 210))
        let top = try #require(resizeWrite(edge: .top, from: block, to: earlier))
        #expect(try wire(top) == .object([
            "action": .string("time"), "startTime": .string("07:30"), "duration": .number(210),
            "timeBucket": .string("morning"),
        ]))
        // Across a part of day: noon's block pulled up into the morning.
        let noon = BlockSpan(startMin: 720, duration: 60)
        #expect(resizeWrite(edge: .top, from: noon, to: resizePreview(edge: .top, from: noon, deltaMin: -15))
            == .start(startTime: "11:45", duration: 75, timeBucket: .morning))

        #expect(resizeWrite(edge: .bottom, from: block, to: block) == nil)
        #expect(resizeWrite(edge: .top, from: block, to: block) == nil)
        // The bottom grip compares the length alone.
        #expect(resizeWrite(edge: .bottom, from: block, to: BlockSpan(startMin: 615, duration: 60)) == nil)
    }

    /// A travel that is NaN reads as none (where `Int(_:)` would trap); an
    /// infinite one is at a stop, as in the TS, and so is one past a day
    /// either way.
    @Test func degenerateTravelDoesNotTrap() {
        #expect(resizeDeltaMin(10, hourPx: 0).isInfinite)
        #expect(resizeDeltaMin(0, hourPx: 0).isNaN)
        for edge in ResizeEdge.allCases {
            for start in [-65, 0, 550, 600, 1410, 1455] {
                let none = resizePreview(edge: edge, startMin: start, duration: 50, deltaMin: 0)
                for travel in [Double.nan, resizeDeltaMin(0, hourPx: 0)] {
                    #expect(resizePreview(edge: edge, startMin: start, duration: 50, deltaMin: travel) == none,
                            "\(edge) \(start) \(travel)")
                }
                let infinite: [(Double, Double)] = [
                    (.infinity, 1e300), (-.infinity, -1e300), (resizeDeltaMin(10, hourPx: 0), 1e300),
                ]
                for (travel, far) in infinite {
                    #expect(resizePreview(edge: edge, startMin: start, duration: 50, deltaMin: travel)
                        == resizePreview(edge: edge, startMin: start, duration: 50, deltaMin: far),
                            "\(edge) \(start) \(travel)")
                }
            }
        }
        #expect(resizePreview(edge: .bottom, startMin: 600, duration: 60, deltaMin: .infinity)
            == BlockSpan(startMin: 600, duration: 840))
        #expect(resizePreview(edge: .top, startMin: 600, duration: 60, deltaMin: -.infinity)
            == BlockSpan(startMin: 0, duration: 660))
        #expect(resizePreview(edge: .bottom, startMin: 600, duration: 60, deltaMin: 1e300)
            == BlockSpan(startMin: 600, duration: 840))
        #expect(resizePreview(edge: .top, startMin: 600, duration: 60, deltaMin: -1e300)
            == BlockSpan(startMin: 0, duration: 660))
        #expect(resizePreview(edge: .top, startMin: 600, duration: 60, deltaMin: 1e300)
            == BlockSpan(startMin: 645, duration: 15))
        #expect(resizePreview(edge: .bottom, startMin: 600, duration: 60, deltaMin: -1e300)
            == BlockSpan(startMin: 600, duration: 15))
    }

    /// The grid's own hour-to-part-of-day rule is lib/time-bucket.ts
    /// `getBucketForTime` at every minute of the day, which the top grip's
    /// write uses.
    @Test func theHoursPartOfDayIsTheTimesAtEveryMinute() {
        let disagree = (0..<1440).filter { bucketForTime(minutesToTime($0)) != DayBucket(bucketForMinute($0)) }
        #expect(disagree.isEmpty, "\(disagree.prefix(5))")
    }
}
