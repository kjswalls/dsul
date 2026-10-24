import Foundation
import Testing
import DsulCore

// The web's own answers for lib/block-moves.ts `planBlockDrop`, checked against
// BlockMoves.swift. tests/unit/block-moves-fixtures.test.ts runs every case
// through the real TS (every row of the Week and blocks design's move table for
// a one-off, a repeating task, one in a project block, a habit, a done, an
// in-block and a let-go one-off, a milestone, rows already in the braindump, a
// skipped occurrence and a custom dated type, with the edges beside them) and
// commits the results to tests/fixtures/day/block-moves.json. Never edit the
// JSON by hand: regenerate it from the Vitest side (UPDATE_FIXTURES=1).
//
// The case's own fields are decoded strictly: an unknown target, answer or
// refusal, a missing field (`milestoneIds` and Anytime's `date` included, which
// must be there even when null), or a milestone id that isn't a uuid fails the
// test rather than skipping the case. The `item` is decoded as the planner
// payload decodes one (leniently, `Item`'s own decoder), since that is the row
// the phone will hand the rule.

private struct FixtureError: Error, CustomStringConvertible {
    let description: String
}

private struct OriginJSON: Decodable, Sendable {
    let date: String
    let skipped: Bool
}

/// `{kind:"hour",date,startMin}` | `{kind:"anytime",date}` | `{kind:"braindump"}`.
private struct TargetJSON: Decodable, Sendable {
    let target: BlockTarget

    enum CodingKeys: String, CodingKey { case kind, date, startMin }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "hour":
            target = .hour(
                date: try c.decode(String.self, forKey: .date), startMin: try c.decode(Int.self, forKey: .startMin)
            )
        case "anytime":
            target = .anytime(date: try c.decode(String.self, forKey: .date))
        case "braindump":
            target = .braindump
        case let other:
            throw FixtureError(description: "unknown target kind \(other)")
        }
    }
}

/// planBlockDrop's answer as JSON. Anytime's `date` must be there, a day or
/// null (null keeps its date), never left out.
private struct DropJSON: Decodable, Sendable {
    let drop: BlockDrop

    enum CodingKeys: String, CodingKey { case kind, date, startMin, reason }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "place":
            drop = .place(
                date: try c.decode(String.self, forKey: .date), startMin: try c.decode(Int.self, forKey: .startMin)
            )
        case "retime":
            drop = .retime(startMin: try c.decode(Int.self, forKey: .startMin))
        case "anytime":
            guard c.contains(.date) else { throw FixtureError(description: "anytime without its date key") }
            drop = .anytime(date: try c.decodeNil(forKey: .date) ? nil : try c.decode(String.self, forKey: .date))
        case "braindump":
            drop = .braindump
        case "pause":
            drop = .pause
        case "none":
            drop = BlockDrop.none
        case "refused":
            let raw = try c.decode(String.self, forKey: .reason)
            guard let reason = BlockDropRefusal(rawValue: raw) else {
                throw FixtureError(description: "unknown refusal \(raw)")
            }
            drop = .refused(reason)
        case let other:
            throw FixtureError(description: "unknown answer kind \(other)")
        }
    }
}

private struct DropCase: Decodable, Sendable {
    let name: String
    let item: Item
    let from: OriginJSON
    let target: TargetJSON
    /// Sorted, [] for none known, null while unknown; the key is always there.
    let milestoneIds: [String]?
    let expected: DropJSON

    enum CodingKeys: String, CodingKey { case name, item, from, target, milestoneIds, expected }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        item = try c.decode(Item.self, forKey: .item)
        from = try c.decode(OriginJSON.self, forKey: .from)
        target = try c.decode(TargetJSON.self, forKey: .target)
        // A missing key would read as "unknown", which answers like a known
        // set wherever the braindump is not asked; so it must be spelled out.
        guard c.contains(.milestoneIds) else {
            throw FixtureError(description: "\(name): no milestoneIds key")
        }
        milestoneIds = try c.decodeNil(forKey: .milestoneIds) ? nil : try c.decode([String].self, forKey: .milestoneIds)
        expected = try c.decode(DropJSON.self, forKey: .expected)
    }

    var origin: BlockOrigin { BlockOrigin(date: from.date, skipped: from.skipped) }

    /// The case's context, every id a uuid.
    func context() throws -> BlockDropContext {
        guard let raw = milestoneIds else { return BlockDropContext(milestoneIds: nil) }
        var ids = Set<UUID>()
        for s in raw {
            guard let id = UUID(uuidString: s) else { throw FixtureError(description: "\(name): \(s) is not a uuid") }
            ids.insert(id)
        }
        return BlockDropContext(milestoneIds: ids)
    }

    func plan(_ item: Item? = nil, from origin: BlockOrigin? = nil, target: BlockTarget? = nil,
              context ctx: BlockDropContext? = nil) throws -> BlockDrop {
        return planBlockDrop(item ?? self.item, from: origin ?? self.origin, target: target ?? self.target.target,
                             context: try ctx ?? context())
    }
}

private struct Fixture: Decodable, Sendable {
    let cases: [DropCase]
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/block-moves.json"
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            let data: Data = try Data(contentsOf: candidate)
            return try JSONDecoder().decode(Fixture.self, from: data)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw FixtureError(description: "\(relative) not found above \(here)")
}

/// The answer's kind, as the fixture names it.
private func kindOf(_ drop: BlockDrop) -> String {
    switch drop {
    case .place: return "place"
    case .retime: return "retime"
    case .anytime: return "anytime"
    case .braindump: return "braindump"
    case .pause: return "pause"
    case .none: return "none"
    case .refused: return "refused"
    }
}

/// A dated series block, as the TS test reads one: a repeat, a start date,
/// and placed on the canvas (one still in the braindump is not a block yet).
private func isDatedSeries(_ item: Item) -> Bool {
    guard let f = item.repeatFrequency, !f.isEmpty, f != "none" else { return false }
    return !(item.startDate ?? "").isEmpty && isTaskScheduled(item)
}

@Suite struct BlockMovesFixtureTests {
    @Test func theCasesReachEveryAnswerAndEveryRefusal() throws {
        let cases = try loadFixture().cases
        #expect(!cases.isEmpty)
        #expect(Set(cases.map(\.name)).count == cases.count, "case names are unique")
        let kinds = Set(cases.map { kindOf($0.expected.drop) })
        #expect(kinds == ["place", "retime", "anytime", "braindump", "pause", "none", "refused"])
        // Every reason the port names is one the web answers, and the other
        // way round (an unknown reason already failed the decode).
        let reasons = Set(cases.compactMap { c -> BlockDropRefusal? in
            if case let .refused(reason) = c.expected.drop { return reason }
            return nil
        })
        #expect(reasons == Set(BlockDropRefusal.allCases))
        let anytimeDates = cases.compactMap { c -> String?? in
            if case let .anytime(date) = c.expected.drop { return .some(date) }
            return nil
        }
        #expect(anytimeDates.contains { $0 == nil }, "an Anytime that keeps its date")
        #expect(anytimeDates.contains { $0 != nil }, "an Anytime that moves the day")
        // A guard on the guard: the rows the registry and the strings matter for.
        #expect(cases.contains { $0.item.type == "custom" && $0.item.customType == "errand" })
        #expect(cases.contains { $0.item.startDate?.contains("T") == true })
        #expect(cases.contains { $0.milestoneIds == nil })
        #expect(cases.contains { $0.milestoneIds?.isEmpty == true })
        #expect(cases.contains { $0.from.skipped })
    }

    @Test func everyCaseMatchesTheWeb() throws {
        for c in try loadFixture().cases {
            #expect(try c.plan() == c.expected.drop, "\(c.name)")
        }
    }

    /// The registry decides, never the type's name: every custom dated row
    /// answers exactly as the same row would as a task.
    @Test func aCustomDatedTypeAnswersAsATaskDoes() throws {
        let cases = try loadFixture().cases.filter { $0.item.type == "custom" }
        #expect(!cases.isEmpty)
        for c in cases {
            var asTask = c.item
            asTask.type = "task"
            asTask.customType = nil
            #expect(try c.plan(asTask) == c.expected.drop, "\(c.name)")
        }
    }

    /// A skipped occurrence never moves, whatever the item and the target.
    @Test func aSkippedOriginIsAlwaysRefused() throws {
        for c in try loadFixture().cases {
            let skipped = BlockOrigin(date: c.from.date, skipped: true)
            #expect(try c.plan(from: skipped) == .refused(.skipped), "\(c.name)")
        }
    }

    /// Only the braindump reads the milestones, and only once it knows the row
    /// is neither listed already nor undated: unknown ids refuse exactly the
    /// rows Move to Braindump's gate would be asked about.
    @Test func onlyTheBraindumpReadsTheMilestones() throws {
        let unknown = BlockDropContext(milestoneIds: nil)
        var asked = 0
        for c in try loadFixture().cases {
            let answer = try c.plan(context: unknown)
            switch (c.target.target, c.expected.drop) {
            case (.braindump, .braindump), (.braindump, .refused(.notBraindump)):
                asked += 1
                #expect(answer == .refused(.milestonesUnknown), "\(c.name)")
            default:
                #expect(answer == c.expected.drop, "\(c.name)")
            }
        }
        #expect(asked > 0)
    }

    /// What keeps its date never reads the target's day: the drop lands on
    /// its own day from any column (the ghost stays home, the design's B18).
    @Test func aRetimeIgnoresTheColumnItWasDroppedOn() throws {
        let retimes = try loadFixture().cases.filter { c in
            if case .retime = c.expected.drop { return true }
            return false
        }
        #expect(!retimes.isEmpty)
        for c in retimes {
            guard case let .hour(_, startMin) = c.target.target else {
                Issue.record("\(c.name): a retime from a target that is not an hour")
                continue
            }
            for elsewhere in ["2026-07-01", "2026-12-31", "1999-01-01"] {
                #expect(try c.plan(target: .hour(date: elsewhere, startMin: startMin)) == c.expected.drop, "\(c.name)")
            }
        }
    }

    /// A dated series block never takes another date: a place lands on its
    /// own start (a project block's release) and an Anytime keeps its day.
    /// Anything else dated placed by an hour (a one-off, a series still in the
    /// braindump) lands on the hour's day. Every place and retime keeps the
    /// hour's own minute.
    @Test func aSeriesNeverTakesAnotherDate() throws {
        for c in try loadFixture().cases {
            let dated = caps(c.item.typeName).dateAnchored
            if isDatedSeries(c.item) {
                if case let .place(date, _) = c.expected.drop {
                    #expect(date == c.item.startDate?.split(separator: "T").first.map(String.init), "\(c.name)")
                }
                if case let .anytime(date) = c.expected.drop { #expect(date == nil, "\(c.name)") }
            }
            guard case let .hour(targetDate, startMin) = c.target.target else { continue }
            switch c.expected.drop {
            case let .place(date, minute):
                #expect(minute == startMin, "\(c.name)")
                if dated && !isDatedSeries(c.item) { #expect(date == targetDate, "\(c.name)") }
            case let .retime(minute):
                #expect(minute == startMin, "\(c.name)")
            default:
                break
            }
        }
    }

    @Test func startTimeOfSpellsTheStoredClock() {
        #expect(startTimeOf(0) == "00:00")
        #expect(startTimeOf(615) == "10:15")
        #expect(startTimeOf(1439) == "23:59")
        // Outside the day, as JavaScript spells it (the rule refuses these
        // before it asks).
        #expect(startTimeOf(1440) == "24:00")
        #expect(startTimeOf(-15) == "-1:-15")
        #expect(startTimeOf(-60) == "-1:00")
        #expect(startTimeOf(-61) == "-2:-1")
    }

    @Test func anOriginFromADayIsTheSameOrigin() throws {
        let day = try #require(DayString("2026-07-04"))
        #expect(BlockOrigin(day: day, skipped: false) == BlockOrigin(date: "2026-07-04", skipped: false))
        #expect(BlockOrigin(day: day, skipped: true).skipped)
    }
}
