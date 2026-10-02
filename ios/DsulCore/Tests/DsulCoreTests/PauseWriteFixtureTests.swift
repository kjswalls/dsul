import Foundation
import Testing
import DsulCore

// The web's own answers for lib/active.ts `resolvePauseWrite`, checked against
// Active.swift. tests/unit/day-fixtures.test.ts resolves every request through
// the real TS and commits the patch (or the refusal) to
// tests/fixtures/day/pause-write.json. Never edit the JSON by hand: regenerate
// it from the Vitest side (UPDATE_FIXTURES=1).
//
// `pausedUntil`, in a request and in a patch, has three states: the key absent
// (not sent; the column left alone), null (sent as no end; the column
// cleared), and a day. A plain optional can't tell the first two apart, so
// they decode through `contains` and `decodeNil`.

extension KeyedDecodingContainer {
    /// Absent is nil, null is `.clear`, a string is `.set`.
    fileprivate func columnWrite(_ key: Key) throws -> ColumnWrite? {
        guard contains(key) else { return nil }
        if try decodeNil(forKey: key) { return .clear }
        return .set(try decode(String.self, forKey: key))
    }
}

private struct Current: Decodable, Sendable {
    let pausedAt: String?
    let pausedUntil: String?
}

private struct Request: Decodable, Sendable {
    let paused: Bool?
    let pausedUntil: ColumnWrite?

    enum CodingKeys: String, CodingKey {
        case paused, pausedUntil
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        paused = try c.decodeIfPresent(Bool.self, forKey: .paused)
        pausedUntil = try c.columnWrite(.pausedUntil)
    }
}

private struct Patch: Decodable, Sendable {
    let pausedAt: ColumnWrite?
    let pausedUntil: ColumnWrite?

    enum CodingKeys: String, CodingKey {
        case pausedAt, pausedUntil
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pausedAt = try c.columnWrite(.pausedAt)
        pausedUntil = try c.columnWrite(.pausedUntil)
    }

    var value: PauseWindowPatch {
        PauseWindowPatch(pausedAt: pausedAt, pausedUntil: pausedUntil)
    }
}

/// `{ patch }` or `{ reason }`.
private struct Expected: Decodable, Sendable {
    let patch: Patch?
    let reason: String?

    var result: PauseWriteResult? {
        if let patch { return .patch(patch.value) }
        if let reason { return .refused(reason) }
        return nil
    }
}

private struct PauseWriteCase: Decodable, Sendable {
    let name: String
    let current: Current
    let req: Request
    let todayStr: String
    let nowIso: String
    let timeZone: String
    let expected: Expected
}

private struct Fixture: Decodable, Sendable {
    let cases: [PauseWriteCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/pause-write.json"
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

extension PauseWriteResult {
    /// The patch, or nil for a refusal.
    fileprivate var patchValue: PauseWindowPatch? {
        switch self {
        case .patch(let p): return p
        case .refused: return nil
        }
    }
}

@Suite struct PauseWriteFixtureTests {
    /// An empty patch, a refusal, a new stamp, and an explicit clear.
    @Test func hasEveryKindOfAnswer() throws {
        let results = try loadFixture().cases.compactMap { $0.expected.result }
        #expect(results.contains(.patch(PauseWindowPatch())))
        #expect(results.contains { $0.patchValue == nil })
        #expect(results.contains { $0.patchValue?.pausedAt != nil })
        #expect(results.contains { $0.patchValue?.pausedUntil == .clear })
    }

    @Test func everyCaseExpectsAPatchOrAReason() throws {
        for c in try loadFixture().cases {
            #expect(c.expected.result != nil, "\(c.name)")
        }
    }

    @Test func resolvePauseWriteMatchesTheWeb() throws {
        for c in try loadFixture().cases {
            let current = PauseWindow(pausedAt: c.current.pausedAt, pausedUntil: c.current.pausedUntil)
            let got = resolvePauseWrite(
                current: current, paused: c.req.paused, pausedUntil: c.req.pausedUntil,
                todayStr: c.todayStr, nowISO: c.nowIso, timeZone: c.timeZone
            )
            #expect(got == c.expected.result, "\(c.name)")
        }
    }

    /// A patch writes what it names and nothing else.
    @Test func aPatchAppliesColumnByColumn() {
        let item = Item(
            id: UUID(uuidString: "00000000-0000-4000-8000-000000000001")!, type: "habit", title: "Stretch",
            pausedAt: "2026-09-20T15:00:00Z", pausedUntil: "2026-10-09"
        )
        #expect(pausing(item, patch: PauseWindowPatch()) == item)
        let resumed = pausing(item, patch: PauseWindowPatch(pausedUntil: .set("2026-10-02")))
        #expect(resumed.pausedAt == "2026-09-20T15:00:00Z")
        #expect(resumed.pausedUntil == "2026-10-02")
        let restamped = pausing(item, patch: PauseWindowPatch(pausedAt: .set("2026-10-02T15:00:00.000Z"), pausedUntil: .clear))
        #expect(restamped.pausedAt == "2026-10-02T15:00:00.000Z")
        #expect(restamped.pausedUntil == nil)
    }
}
