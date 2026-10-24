import Foundation
import Testing
import DsulCore

// The web's own overlap pass, checked against ScheduleOverlap.swift.
// tests/unit/overlap-fixtures.test.ts runs every case through the real
// lib/schedule-overlap.ts `planOverlaps` and commits the results to
// tests/fixtures/day/overlap.json. Never edit the JSON by hand: regenerate it
// from the Vitest side (UPDATE_FIXTURES=1).
//
// - `constants`: every web number ScheduleMath.swift copies (the pass's and
//   the pane's, lib/schedule-constants.ts, with the narrow pane's
//   PANE_WRAP_PX and the now marker's ECLIPSE_PX from
//   components/views/day-schedule.tsx) and the pass's own tuning.
// - `cases`: 29 Day cases at the four field widths a phone can answer to
//   (280, 300, 315 and 330pt: two channels need 284 at the root, 306 in a
//   nest and 328 in a nest's nest) and six Week cases (no field width), all
//   at 75pt an hour on a grid from midnight. `entries` are the pass's input in the
//   grid's drawing order; `expected` is one row per planned id, in the TS's
//   order, carrying design §5.3's subset only. An id with no row is not laid
//   out and draws as `OverlapPlan.lone`. Every number is compared exactly.

private struct EntryRow: Decodable, Sendable {
    let id: UUID
    let startMin: Int
    let duration: Int
    let projectBlock: String?

    var entry: OverlapEntry {
        OverlapEntry(id: id, startMin: startMin, duration: duration, projectBlock: projectBlock)
    }
}

private struct PlanRow: Decodable, Sendable {
    let id: UUID
    let depth: Int
    let left: BandLength
    let right: BandLength
    let paneLeft: BandLength
    let paneRight: BandLength
    let railX: BandLength
    let beadX: BandLength
    let z: Int
    let widthFraction: Double
    let contentTop: Double?
    let contentHeight: Double?
    let handleTopLane: Bool
    let handleBottomLane: Bool

    var plan: OverlapPlan {
        OverlapPlan(depth: depth, left: left, right: right, paneLeft: paneLeft, paneRight: paneRight,
                    railX: railX, beadX: beadX, z: z, widthFraction: widthFraction,
                    contentTop: contentTop, contentHeight: contentHeight,
                    handleTopLane: handleTopLane, handleBottomLane: handleBottomLane)
    }
}

private struct OverlapCase: Decodable, Sendable {
    let name: String
    let variant: String
    let hourPx: Double
    let gridStartMin: Int
    let fieldWidth: Double?
    let entries: [EntryRow]
    let expected: [PlanRow]
}

private struct Fixture: Decodable, Sendable {
    let constants: [String: Double]
    let cases: [OverlapCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/overlap.json"
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            let data: Data = try Data(contentsOf: candidate)
            return try JSONDecoder().decode(Fixture.self, from: data)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw FixtureError.notFound("\(relative) above \(here)")
}

private func plan(_ c: OverlapCase) throws -> OverlapPlans {
    let variant = try #require(OverlapVariant(rawValue: c.variant), "\(c.name): unknown variant \(c.variant)")
    return planOverlaps(c.entries.map(\.entry), hourPx: c.hourPx, gridStartMin: c.gridStartMin,
                        variant: variant, fieldWidth: c.fieldWidth)
}

/// overlap-fixtures.test.ts `uid`: entry n as a fixed v4-shaped uuid.
private func uid(_ n: Int) -> UUID {
    let hex = String(n, radix: 16)
    return UUID(uuidString: "00000000-0000-4000-8000-" + String(repeating: "0", count: 12 - hex.count) + hex)!
}

@Suite struct OverlapFixtureTests {
    /// Every number the fixture pins is the Swift's, and a constant the TS
    /// adds fails here until the port names it.
    @Test func theConstantsAreTheWebs() throws {
        let swift: [String: Double] = [
            "HOUR_PX": ScheduleMetrics.hourPx,
            "LANE_PX": ScheduleMetrics.lanePx,
            "PANE_OFFSET": ScheduleMetrics.paneOffset,
            "PANE_TRIM": ScheduleMetrics.paneTrim,
            "PANE_MIN_H": ScheduleMetrics.paneMinH,
            "PANE_TALL_H": ScheduleMetrics.paneTallH,
            "COL_GAP": ScheduleMetrics.colGap,
            "NEST_PX": ScheduleMetrics.nestPx,
            "NEST_RIGHT_PX": ScheduleMetrics.nestRightPx,
            "LINE_H": ScheduleMetrics.lineH,
            "BAND_COMFORT": ScheduleMetrics.bandComfort,
            "SHINGLE_PX": ScheduleMetrics.shinglePx,
            "MAX_DEPTH_DAY": Double(ScheduleMetrics.maxDepthDay),
            "MIN_CHANNEL_PX": ScheduleMetrics.minChannelPx,
            "MIN_HOST_FREE_MIN": OverlapTuning.minHostFreeMin,
            "MIN_HOST_FREE_FRAC": OverlapTuning.minHostFreeFrac,
            "IDENTICAL_TOL": OverlapTuning.identicalTol,
            "NOMINAL_FIELD_DAY": OverlapTuning.nominalFieldDay,
            "NOMINAL_FIELD_WEEK": OverlapTuning.nominalFieldWeek,
            "PANE_WRAP_PX": ScheduleMetrics.paneWrapPx,
            "ECLIPSE_PX": ScheduleMetrics.eclipsePx,
        ]
        let web = try loadFixture().constants
        #expect(Set(web.keys) == Set(swift.keys))
        for (key, value) in web {
            #expect(swift[key] == value, "\(key)")
        }
    }

    /// The web's floor, from PR 6 on (design B13).
    @Test func thePaneFloorIs34() throws {
        #expect(ScheduleMetrics.paneMinH == 34)
        #expect(try loadFixture().constants["PANE_MIN_H"] == 34)
    }

    @Test func theFileHoldsDayAndWeekCases() throws {
        let cases = try loadFixture().cases
        #expect(Set(cases.map(\.name)).count == cases.count)
        let day = cases.filter { $0.variant == "day" }
        let week = cases.filter { $0.variant == "week" }
        #expect(day.count == 116 && week.count == 6)
        #expect(Set(day.compactMap(\.fieldWidth)) == [280, 300, 315, 330])
        #expect(day.allSatisfy { $0.fieldWidth != nil } && week.allSatisfy { $0.fieldWidth == nil })
        #expect(cases.allSatisfy { $0.hourPx == ScheduleMetrics.hourPx && $0.gridStartMin == 0 })
    }

    /// The ids, in the TS's order, and each plan, exactly.
    @Test func everyCaseMatchesTheWeb() throws {
        for c in try loadFixture().cases {
            let plans = try plan(c)
            #expect(plans.ids == c.expected.map(\.id), "\(c.name): the laid-out ids")
            for row in c.expected {
                let got = plans[row.id]
                #expect(got == row.plan, "\(c.name): \(row.id)\n  got      \(String(describing: got))\n  expected \(row.plan)")
            }
            // Anything else draws as a lone block.
            for e in c.entries where !c.expected.contains(where: { $0.id == e.id }) {
                #expect(plans[e.id] == nil && plans.plan(for: e.id) == .lone, "\(c.name): \(e.id)")
            }
        }
    }

    /// The cases reach every topology the phone draws (the TS checks the same
    /// of what it wrote).
    @Test func theCasesReachEveryTopology() throws {
        let cases = try loadFixture().cases
        let day = cases.filter { $0.variant == "day" }.flatMap(\.expected)
        let week = cases.filter { $0.variant == "week" }.flatMap(\.expected)
        #expect(cases.filter { $0.expected.isEmpty }.map(\.name).contains("solo, 330pt"))
        #expect(cases.filter { $0.expected.isEmpty }.map(\.name).contains("two apart, 330pt"))
        #expect(day.contains { $0.depth == 1 })
        #expect(day.contains { $0.depth == ScheduleMetrics.maxDepthDay })
        #expect(day.allSatisfy { $0.depth <= ScheduleMetrics.maxDepthDay })
        #expect(day.contains { $0.paneLeft.pct > 0 })
        #expect(day.contains { $0.depth == 0 && $0.z > 2 })
        #expect(day.contains { $0.handleTopLane })
        #expect(day.contains { $0.handleBottomLane })
        #expect(day.contains { $0.contentTop != nil })
        #expect(Set(week.map(\.left.px)) == [0, ScheduleMetrics.shinglePx, 2 * ScheduleMetrics.shinglePx])
        #expect(week.contains { $0.widthFraction == 0.5 })
    }

    /// "double booked" is drawn b before a: the tiles go in id order.
    @Test func aDoubleBookingTilesInIdOrder() throws {
        let c = try #require(try loadFixture().cases.first(where: { $0.name == "double booked, 330pt" }))
        #expect(c.entries.map(\.id) == [uid(0xb), uid(0xa)])
        let plans = try plan(c)
        #expect(plans[uid(0xa)]?.paneLeft == BandLength(pct: 0, px: ScheduleMetrics.lanePx))
        #expect(plans[uid(0xb)]?.paneLeft == BandLength(pct: 50, px: ScheduleMetrics.lanePx))
        // Drawn: two panes of one width, side by side, each beside its own rail.
        let a = blockFrame(startMin: 540, duration: 60, plan: plans.plan(for: uid(0xa)), fieldWidth: 330)
        let b = blockFrame(startMin: 540, duration: 60, plan: plans.plan(for: uid(0xb)), fieldWidth: 330)
        #expect(a.bandX == 0 && a.bandWidth == 326 && b.bandWidth == 326)
        #expect(a.paneX == 12 && a.paneWidth == 151)
        #expect(b.paneX == 175 && b.paneWidth == 151)
        #expect(a.paneX + a.paneWidth < b.railX && b.railX < b.paneX)
        #expect(a.railX == 5 && b.railX == 168 && b.beadX == 166)
    }

    /// The TS's own check, through the phone's drawing: on a field wide enough
    /// for two channels, back-to-back quarters never share a column.
    @Test func backToBackQuartersNeverShareAColumn() throws {
        for c in try loadFixture().cases where c.name.hasPrefix("two quarters back to back, ") {
            let width = try #require(c.fieldWidth)
            guard width - 4 >= 2 * ScheduleMetrics.minChannelPx else { continue }
            let plans = try plan(c)
            let frames = c.entries.map {
                blockFrame(startMin: $0.startMin, duration: $0.duration, plan: plans.plan(for: $0.id), fieldWidth: width)
            }
            let (a, b) = (frames[0], frames[1])
            #expect(a.bandX + a.bandWidth <= b.bandX || b.bandX + b.bandWidth <= a.bandX, "\(c.name)")
        }
    }

    /// The same day, on a phone too narrow for two channels: the second steps
    /// into the cascade, above the first, and the first's title moves clear.
    @Test func onTheNarrowestPhoneAQuarterCascades() throws {
        let c = try #require(try loadFixture().cases.first(where: { $0.name == "two quarters back to back, 280pt" }))
        let plans = try plan(c)
        let first = try #require(plans[c.entries[0].id])
        let second = try #require(plans[c.entries[1].id])
        #expect(first.z == 2 && second.z == 4)
        #expect(second.left.px == ScheduleMetrics.nestPx)
        #expect(first.contentTop == 0 && first.contentHeight != nil)
    }

    @Test func aLoneBlockIsTheWebsUnlaidOutBlock() {
        let lone = OverlapPlan.lone
        #expect(lone.left == BandLength(pct: 0, px: 0) && lone.right == BandLength(pct: 0, px: 4))
        #expect(lone.paneLeft == BandLength(pct: 0, px: 12) && lone.paneRight == BandLength(pct: 0, px: 0))
        #expect(lone.railX == BandLength(pct: 0, px: 5) && lone.beadX == BandLength(pct: 0, px: 3))
        #expect(lone.z == 2 && lone.depth == 0 && lone.widthFraction == 1)
        #expect(lone.contentTop == nil && lone.contentHeight == nil && !lone.handleTopLane && !lone.handleBottomLane)
        // One entry, or none, is never laid out.
        #expect(planOverlaps([]).isEmpty)
        #expect(planOverlaps([OverlapEntry(id: uid(1), startMin: 540, duration: 60)]).isEmpty)
    }
}

/// lib/schedule-overlap.ts `pickContentBand`, the TS's own cases
/// (tests/unit/schedule-overlap.test.ts).
@Suite struct ContentBandTests {
    @Test func nothingCoveringIsTheWholePane() {
        #expect(pickContentBand(paneHeight: 200, covers: []) == nil)
    }

    @Test func takesTheTopBandWhenItIsComfortable() {
        #expect(pickContentBand(paneHeight: 200, covers: [(top: 120, bottom: 200)]) == ContentBand(top: 0, height: 120))
    }

    @Test func fallsToALowerBandWhenTheTopCannotHoldALine() {
        #expect(pickContentBand(paneHeight: 200, covers: [(top: 10, bottom: 100)]) == ContentBand(top: 100, height: 100))
    }

    @Test func isAThresholdNotAMaximum() {
        #expect(pickContentBand(paneHeight: 200, covers: [(top: 40, bottom: 80)]) == ContentBand(top: 0, height: 40))
    }

    @Test func givesUpRatherThanPrintingAClippedHalfLine() {
        #expect(pickContentBand(paneHeight: 40, covers: [(top: 8, bottom: 40)]) == nil)
    }
}

/// components/views/day-schedule.tsx `toOverlapEntries`, and the drawing of a
/// plan on a field.
@Suite struct OverlapEntryTests {
    private let gym = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
    private let call = UUID(uuidString: "00000000-0000-4000-8000-000000000002")!
    private let walk = UUID(uuidString: "00000000-0000-4000-8000-000000000003")!

    @Test func aProjectBlocksTaskCarriesItsProjectAndNothingElseDoes() {
        let inBlock = Item(id: gym, title: "Legs", project: "Gym", inProjectBlock: true)
        let timed = Item(id: call, title: "Call", project: "Work", inProjectBlock: false)
        let entries = overlapEntries([
            TimedEntry(item: inBlock, startMin: 1080, duration: 60),
            TimedEntry(item: timed, startMin: 1080, duration: 30),
        ])
        #expect(entries == [
            OverlapEntry(id: gym, startMin: 1080, duration: 60, projectBlock: "Gym"),
            OverlapEntry(id: call, startMin: 1080, duration: 30, projectBlock: nil),
        ])
    }

    @Test func theWebReadsTheBlockFlagWhateverTheType() {
        let habit = Item(id: walk, type: "habit", title: "Walk", project: "Gym", inProjectBlock: true)
        #expect(OverlapEntry(item: habit, startMin: 450, duration: 20).projectBlock == "Gym")
        // In a block with no project: no unit.
        let loose = Item(id: walk, title: "Loose", inProjectBlock: true)
        #expect(OverlapEntry(item: loose, startMin: 450, duration: 20).projectBlock == nil)
    }

    /// An empty project name is no block, as on the web (its `projectBlock`
    /// is falsy): two crossing blocks with "" are a crossing in two columns,
    /// where one project's members would tile one band.
    @Test func anEmptyProjectIsNoBlock() {
        let plans = planOverlaps([
            OverlapEntry(id: gym, startMin: 540, duration: 60, projectBlock: ""),
            OverlapEntry(id: call, startMin: 570, duration: 60, projectBlock: ""),
        ], fieldWidth: 330)
        #expect(plans[gym]?.paneLeft.pct == 0 && plans[call]?.paneLeft.pct == 0)
        #expect(plans[gym]?.right.pct == 50 && plans[call]?.left.pct == 50)
        // The same two as one project's members: one band, tiled.
        let tiled = planOverlaps([
            OverlapEntry(id: gym, startMin: 540, duration: 60, projectBlock: "Gym"),
            OverlapEntry(id: call, startMin: 570, duration: 60, projectBlock: "Gym"),
        ], fieldWidth: 330)
        #expect(tiled[gym]?.right.pct == 0 && tiled[call]?.left.pct == 0)
        #expect(tiled[call]?.paneLeft.pct == 50)
    }

    @Test func aLoneBlockDrawsAcrossTheField() {
        let f = blockFrame(startMin: 540, duration: 60, fieldWidth: 330)
        #expect(f.bandX == 0 && f.bandWidth == 326)
        #expect(f.paneX == 12 && f.paneWidth == 314)
        #expect(f.railX == 5 && f.beadX == 3)
        #expect(f.startY == 675 && f.spanHeight == 75)
        #expect(f.paneTop == 678 && f.paneHeight == 71)
        #expect(f.contentTop == 0 && f.contentHeight == 71 && f.isTall)
        #expect(f.z == 2)
    }

    @Test func aShortBlockIsFlooredAndOneLine() {
        let f = blockFrame(startMin: 540, duration: 15, fieldWidth: 330)
        #expect(f.spanHeight == 18.75 && f.paneHeight == ScheduleMetrics.paneMinH)
        #expect(!f.isTall)
        // 45 minutes is 56.25 less the trim: one line still.
        #expect(!blockFrame(startMin: 540, duration: 45, fieldWidth: 330).isTall)
        #expect(blockFrame(startMin: 540, duration: 48, fieldWidth: 330).isTall)
    }

    @Test func aNestedChildSitsInsetInItsParent() throws {
        let host = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
        let child = UUID(uuidString: "00000000-0000-4000-8000-000000000002")!
        let plans = planOverlaps([
            OverlapEntry(id: host, startMin: 540, duration: 180),
            OverlapEntry(id: child, startMin: 600, duration: 60),
        ], fieldWidth: 330)
        let p = try #require(plans[host])
        let c = try #require(plans[child])
        #expect(p.depth == 0 && c.depth == 1 && c.z == 4)
        let pf = blockFrame(startMin: 540, duration: 180, plan: p, fieldWidth: 330)
        let cf = blockFrame(startMin: 600, duration: 60, plan: c, fieldWidth: 330)
        // 14 in from the parent's band on the left, 8 more on the right.
        #expect(cf.bandX == pf.bandX + ScheduleMetrics.nestPx)
        #expect(cf.bandX + cf.bandWidth == pf.bandX + pf.bandWidth - ScheduleMetrics.nestRightPx)
        #expect(cf.paneX == cf.bandX + ScheduleMetrics.lanePx)
        // The parent's title sits in the band above the child.
        #expect(pf.contentTop == 0 && pf.contentHeight < pf.paneHeight)
    }

    /// The content band is pane-relative and only moves when the plan says so.
    @Test func theContentBandIsThePlansOrTheWholePane() {
        var plan = OverlapPlan.lone
        plan.contentTop = 40
        plan.contentHeight = 60
        let f = blockFrame(startMin: 540, duration: 180, plan: plan, fieldWidth: 330)
        #expect(f.contentTop == 40 && f.contentHeight == 60 && f.isTall)
        plan.contentTop = nil
        #expect(blockFrame(startMin: 540, duration: 180, plan: plan, fieldWidth: 330).contentTop == 0)
        plan.contentHeight = nil
        plan.contentTop = 40
        #expect(blockFrame(startMin: 540, duration: 180, plan: plan, fieldWidth: 330).contentTop == 0)
    }

    @Test func aFieldNarrowerThanItsInsetsDrawsNothingNegative() {
        let f = blockFrame(startMin: 540, duration: 60, fieldWidth: 10)
        #expect(f.bandWidth == 6 && f.paneWidth == 0)
        #expect(blockFrame(startMin: 540, duration: 60, fieldWidth: 0).bandWidth == 0)
    }
}

/// Rules no fixture case reaches, each pinned by a hand case. Every expected
/// value is what the real lib/schedule-overlap.ts `planOverlaps` answered for
/// the same entries (Day, 75pt an hour, a grid from midnight), copied here.
/// Each case breaks a plausible slip in the port that every fixture case
/// would still match.
@Suite struct OverlapRuleTests {
    private struct Row {
        let id: Int
        let depth: Int
        let left: BandLength
        let right: BandLength
        let z: Int
        let widthFraction: Double
        var contentTop: Double? = nil
        var contentHeight: Double? = nil
    }

    private func check(_ plans: OverlapPlans, _ rows: [Row], _ label: String) {
        #expect(plans.ids == rows.map { uid($0.id) }, "\(label)")
        for r in rows {
            guard let p = plans[uid(r.id)] else {
                Issue.record("\(label): no plan for \(r.id)")
                continue
            }
            #expect(p.depth == r.depth && p.z == r.z, "\(label) \(r.id)")
            #expect(p.left == r.left && p.right == r.right, "\(label) \(r.id)")
            #expect(p.widthFraction == r.widthFraction, "\(label) \(r.id)")
            #expect(p.contentTop == r.contentTop && p.contentHeight == r.contentHeight, "\(label) \(r.id)")
        }
    }

    private static let half = 0.5

    /// A longer block hosts a shorter one only if it keeps a free stretch of
    /// at least 30 minutes AND 15% of its own span. 5 hours with 30 minutes
    /// free at each end fails the 45-minute share, so the two sit side by
    /// side; an hour free above passes, and the shorter one nests.
    @Test func aContainerMustKeepAShareOfItsOwnTime() {
        check(planOverlaps([
            OverlapEntry(id: uid(1), startMin: 555, duration: 240),
            OverlapEntry(id: uid(2), startMin: 525, duration: 300),
        ], fieldWidth: 330), [
            Row(id: 2, depth: 0, left: BandLength(pct: 0, px: 0), right: BandLength(pct: 50, px: 4),
                z: 2, widthFraction: Self.half),
            Row(id: 1, depth: 0, left: BandLength(pct: 50, px: 4), right: BandLength(pct: 0, px: 4),
                z: 2, widthFraction: Self.half),
        ], "30 minutes free of 5 hours")
        let nested = planOverlaps([
            OverlapEntry(id: uid(1), startMin: 585, duration: 240),
            OverlapEntry(id: uid(2), startMin: 525, duration: 300),
        ], fieldWidth: 330)
        check(nested, [
            Row(id: 2, depth: 0, left: BandLength(pct: 0, px: 0), right: BandLength(pct: 0, px: 4),
                z: 2, widthFraction: 1, contentTop: 0, contentHeight: 75),
            Row(id: 1, depth: 1, left: BandLength(pct: 0, px: 14), right: BandLength(pct: 0, px: 12),
                z: 4, widthFraction: 1),
        ], "an hour free of 5 hours")
        #expect(nested[uid(2)]?.handleBottomLane == true && nested[uid(2)]?.handleTopLane == false)
    }

    /// First-fit columns: a column is free from the minute its last block
    /// ends, so a block starting at 10:00 reuses the column of one ending at
    /// 10:00 rather than opening a third.
    @Test func aBlockThatStartsAsAnotherEndsTakesItsColumn() {
        let plans = planOverlaps([
            OverlapEntry(id: uid(1), startMin: 540, duration: 60),
            OverlapEntry(id: uid(2), startMin: 555, duration: 60),
            OverlapEntry(id: uid(3), startMin: 600, duration: 30),
        ])
        check(plans, [
            Row(id: 1, depth: 0, left: BandLength(pct: 0, px: 0), right: BandLength(pct: 50, px: 4),
                z: 2, widthFraction: Self.half),
            Row(id: 2, depth: 0, left: BandLength(pct: 50, px: 4), right: BandLength(pct: 0, px: 4),
                z: 2, widthFraction: Self.half),
            Row(id: 3, depth: 0, left: BandLength(pct: 0, px: 0), right: BandLength(pct: 50, px: 4),
                z: 2, widthFraction: Self.half),
        ], "back to back in one column")
    }

    /// Who covers whom is tested on the TS's NOMINAL_FIELD (800 on Day),
    /// never on the real field. On a wide field three columns deep, the 12:00
    /// block's title only moves clear of the block stacked on it because the
    /// test runs at 800: at a phone's 330 the two narrow bands' pixel insets
    /// would keep them apart.
    @Test func whoCoversWhomIsTestedOnTheNominalField() {
        let plans = planOverlaps([
            OverlapEntry(id: uid(1), startMin: 720, duration: 135),
            OverlapEntry(id: uid(2), startMin: 585, duration: 345),
            OverlapEntry(id: uid(3), startMin: 705, duration: 255),
            OverlapEntry(id: uid(4), startMin: 735, duration: 75),
            OverlapEntry(id: uid(5), startMin: 600, duration: 255),
            OverlapEntry(id: uid(6), startMin: 825, duration: 225),
            OverlapEntry(id: uid(7), startMin: 615, duration: 150),
        ], fieldWidth: 1200)
        check(plans, [
            Row(id: 2, depth: 0, left: BandLength(pct: 0, px: 0), right: BandLength(pct: 66.66666666666667, px: 4),
                z: 2, widthFraction: 0.33333333333333326, contentTop: 333.5, contentHeight: 93.75),
            Row(id: 5, depth: 1, left: BandLength(pct: 0, px: 14), right: BandLength(pct: 66.66666666666667, px: 12),
                z: 4, widthFraction: 0.33333333333333326, contentTop: 0, contentHeight: 18.75),
            Row(id: 7, depth: 2, left: BandLength(pct: 0, px: 28), right: BandLength(pct: 83.33333333333334, px: 20),
                z: 6, widthFraction: 0.16666666666666657),
            Row(id: 1, depth: 2, left: BandLength(pct: 16.666666666666664, px: 32),
                right: BandLength(pct: 66.66666666666667, px: 20),
                z: 6, widthFraction: 0.1666666666666667, contentTop: 108.5, contentHeight: 56.25),
            Row(id: 4, depth: 2, left: BandLength(pct: 16.666666666666664, px: 46),
                right: BandLength(pct: 66.66666666666667, px: 20), z: 8, widthFraction: 0.1666666666666667),
            Row(id: 3, depth: 0, left: BandLength(pct: 33.333333333333336, px: 4),
                right: BandLength(pct: 33.333333333333336, px: 4), z: 2, widthFraction: 0.3333333333333332),
            Row(id: 6, depth: 0, left: BandLength(pct: 66.66666666666667, px: 4), right: BandLength(pct: 0, px: 4),
                z: 2, widthFraction: 0.33333333333333326),
        ], "three columns on a 1200pt field")
    }
}
