import Foundation
import Testing
import DsulCore

// The Trash's two routes as the phone reads and writes them (Trash.swift).
// GET /api/app/trash's answer is pinned by tests/fixtures/app/trash-response.json,
// which tests/unit/app-trash.test.ts writes through the real route
// (UPDATE_FIXTURES=1); this file reads the same JSON, so a change to the
// route's shape the phone can't read turns CI red. The rest pins the lenient
// reading, the restore body and the refusal words on hand-written JSON.

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func fixtureData(_ here: String = #filePath) throws -> Data {
    let relative = "tests/fixtures/app/trash-response.json"
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

private func list(_ json: String) throws -> TrashList {
    return try JSONDecoder().decode(TrashList.self, from: Data(json.utf8))
}

/// The raw rows, as JSON objects, to compare each decoded field with.
private func rawRows(_ data: Data) throws -> [[String: Any]] {
    let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    return try #require(object["entries"] as? [[String: Any]])
}

/// The body as the app's APIClient sends it (sorted keys), as a string.
private func wire(_ body: TrashRestoreBody) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return String(decoding: try encoder.encode(body), as: UTF8.self)
}

private let now = parseTimestamp("2026-10-23T12:00:00Z")!

@Suite struct TrashTests {
    @Test func theRouteResponseDecodesWithNothingDropped() throws {
        let data = try fixtureData()
        let bin = try JSONDecoder().decode(TrashList.self, from: data)
        let raw = try rawRows(data)
        #expect(bin.dropped == 0)
        #expect(bin.entries.count == raw.count)
        #expect(bin.entries.count == 9)
        for (row, json) in zip(bin.entries, raw) {
            let at = "\(row.key)"
            #expect(row.kind.rawValue == json["kind"] as? String, "\(at): kind")
            #expect(row.id == json["id"] as? String, "\(at): id")
            #expect(row.name == json["name"] as? String, "\(at): name")
            #expect(row.deletedAt == json["deletedAt"] as? String, "\(at): deletedAt")
            #expect(row.icon == json["icon"] as? String, "\(at): icon")
            #expect(row.color == json["color"] as? String, "\(at): color")
            #expect(row.itemType == json["itemType"] as? String, "\(at): itemType")
            #expect(row.childCount == (json["childCount"] as? Int ?? 0), "\(at): childCount")
            #expect(row.memberCount == (json["memberCount"] as? Int ?? 0), "\(at): memberCount")
            // Every stamp Postgres wrote reads as an instant.
            #expect(parseTimestamp(row.deletedAt) != nil, "\(at): stamp")
            // The route's shape: a type only on an item, a member count only
            // on a project or a goal, subtasks only on an item.
            #expect((json["itemType"] != nil) == (row.kind == .item), "\(at): itemType only on items")
            #expect((json["memberCount"] != nil) == (row.kind == .project || row.kind == .goal), "\(at): memberCount")
            if json["childCount"] != nil { #expect(row.kind == .item && row.childCount > 0, "\(at): childCount") }
        }
        // Every kind is in the bin, keys are unique, and it is newest first.
        #expect(Set(bin.entries.map(\.kind)) == Set(TrashKind.allCases))
        #expect(Set(bin.entries.map(\.key)).count == bin.entries.count)
        let stamps = bin.entries.compactMap { parseTimestamp($0.deletedAt) }
        #expect(stamps == stamps.sorted(by: >))
    }

    /// The rows as the page words them, at the fixture's own moment.
    @Test func theRoutesRowsReadAsThePageSaysThem() throws {
        let bin = try JSONDecoder().decode(TrashList.self, from: try fixtureData())
        func meta(_ name: String) throws -> String {
            let row = try #require(bin.entries.first { $0.name == name }, "no row \(name)")
            return OrganizeCopy.trashRowMeta(row, now: now)
        }
        #expect(try meta("Plan the trip") == "Item \u{00B7} 2 subtasks \u{00B7} 3d ago")
        #expect(try meta("Admin") == "Project \u{00B7} 2 items refile \u{00B7} 4d ago")
        #expect(try meta("Garden") == "Project \u{00B7} 13d ago")
        #expect(try meta("Run a half marathon") == "Goal \u{00B7} 3 items refile \u{00B7} 6d ago")
        // Two days less a fraction of a second: rounded down, 47 hours is one day.
        #expect(try meta("Morning") == "Routine \u{00B7} 1d ago")
        #expect(try meta("Autumn") == "Season \u{00B7} 8d ago")
        #expect(try meta("Dune") == "Item \u{00B7} 5d ago")
        let garden = try #require(bin.entries.first { $0.name == "Garden" })
        #expect(OrganizeCopy.daysUntilPurge(garden.deletedAt, now: now) == 17)
    }

    @Test func aRowIsReadLeniently() throws {
        let bin = try list(#"""
        {"entries":[
          {"kind":"item","id":"a","name":"A","deletedAt":"2026-10-20T09:00:00Z","childCount":2.0,"icon":""},
          {"kind":"project","id":"b","deletedAt":"2026-10-20T09:00:00Z","memberCount":-1,"color":7},
          {"kind":"widget","id":"c","name":"C","deletedAt":"2026-10-20T09:00:00Z"},
          {"kind":"routine","name":"No id","deletedAt":"2026-10-20T09:00:00Z"},
          {"kind":"season","id":"","name":"Blank id"},
          null,
          7,
          {"kind":"goal","id":"g","name":"G","deletedAt":5,"memberCount":"3"}
        ]}
        """#)
        #expect(bin.entries.map(\.key) == ["item:a", "project:b", "goal:g"])
        #expect(bin.dropped == 5)
        let item = bin.entries[0]
        #expect(item.childCount == 2)
        #expect(item.icon == nil)
        let project = bin.entries[1]
        #expect(project.name == "")
        #expect(project.memberCount == 0)
        #expect(project.color == nil)
        let goal = bin.entries[2]
        #expect(goal.deletedAt == "")
        #expect(goal.memberCount == 0)
        // A stamp that can't be read is "just now" and the whole window, as on the web.
        #expect(OrganizeCopy.whenGone(goal.deletedAt, now: now) == "just now")
        #expect(OrganizeCopy.daysUntilPurge(goal.deletedAt, now: now) == 30)
    }

    /// A bin the phone couldn't read is never shown as an empty one.
    @Test func anAnswerWithNoListFails() throws {
        #expect(throws: (any Error).self) { try list("{}") }
        #expect(throws: (any Error).self) { try list(#"{"entries":null}"#) }
        #expect(throws: (any Error).self) { try list(#"{"entries":{}}"#) }
        #expect(throws: (any Error).self) { try list("[]") }
        #expect(throws: (any Error).self) { try list("not json") }
        #expect(try list(#"{"entries":[]}"#).entries.isEmpty)
    }

    @Test func aRestoredRowLeavesTheList() throws {
        let bin = try JSONDecoder().decode(TrashList.self, from: try fixtureData())
        let first = try #require(bin.entries.first)
        let after = bin.removing(first)
        #expect(after.entries.count == bin.entries.count - 1)
        #expect(!after.entries.contains { $0.key == first.key })
        // Only that kind's row: an id shared across tables is another row.
        let twin = TrashRow(kind: .project, id: first.id, name: "Twin", deletedAt: first.deletedAt)
        let both = TrashList(entries: [first, twin])
        #expect(both.removing(first).entries == [twin])
    }

    /// `{"id":…,"kind":…}`: exactly the route's two keys, the id lowercase.
    @Test func theRestoreBodyIsTheRoutes() throws {
        #expect(try wire(TrashRestoreBody(kind: .project, id: "22222222-0000-4000-8000-00000000000A"))
            == #"{"id":"22222222-0000-4000-8000-00000000000a","kind":"project"}"#)
        let row = TrashRow(kind: .item, id: "11111111-0000-4000-8000-000000000001", name: "Plan", deletedAt: "")
        #expect(try wire(TrashRestoreBody(row)) == #"{"id":"11111111-0000-4000-8000-000000000001","kind":"item"}"#)
        for kind in TrashKind.allCases {
            #expect(try wire(TrashRestoreBody(kind: kind, id: "x")) == #"{"id":"x","kind":"\#(kind.rawValue)"}"#)
        }
    }

    /// The refusal's body, and the words the phone says for it.
    @Test func aRefusalIsReadAndWorded() {
        let taken = TrashRestoreRefusal.read(Data(#"{"error":"name_taken","project":{"id":"p1","name":"work"}}"#.utf8))
        #expect(taken == TrashRestoreRefusal(code: "name_taken", projectId: "p1", projectName: "work"))
        #expect(taken.sentence(rowName: "Work")
            == "You already have a project called \u{201C}work\u{201D}. Rename that one, then restore this one.")
        // No project in the body: the row's own name, which folds to the same.
        let bare = TrashRestoreRefusal.read(Data(#"{"error":"name_taken"}"#.utf8))
        #expect(bare.sentence(rowName: "Work")
            == "You already have a project called \u{201C}Work\u{201D}. Rename that one, then restore this one.")
        let parent = TrashRestoreRefusal.read(Data(#"{"error":"parent_gone"}"#.utf8))
        #expect(parent.sentence(rowName: "Find photos") == "Its parent is in the Trash too. Restore that instead.")
        // A 404: no longer in the bin, and the only refusal that drops the row.
        let gone = TrashRestoreRefusal.read(Data(#"{"error":"not_found"}"#.utf8))
        #expect(gone.isGone)
        #expect(gone.sentence(rowName: "X") == "It's no longer in the Trash.")
        #expect(!taken.isGone && !parent.isGone)
        for body in [#"{"error":"invalid"}"#, "", "nope", "[]", #"{"error":7}"#] {
            let refusal = TrashRestoreRefusal.read(Data(body.utf8))
            #expect(refusal.sentence(rowName: "X") == OrganizeCopy.restoreFailed, "\(body)")
            #expect(!refusal.isGone, "\(body)")
        }
        #expect(TrashRestoreRefusal.read(Data()).code == nil)
    }

    @Test func theTrashRowShowsOnlyWhenTheServerTakesBoth() {
        #expect(TrashRoutes.writes == ["list", "restore"])
        #expect(TrashRoutes.offered(nil) == false)
        #expect(TrashRoutes.offered([]) == false)
        #expect(TrashRoutes.offered(["list"]) == false)
        #expect(TrashRoutes.offered(["restore", "list"]) == true)
        #expect(TrashRoutes.offered(["list", "restore", "purge"]) == true)
        #expect(TrashRoutes.list == "/api/app/trash")
        #expect(TrashRoutes.restore == "/api/app/trash/restore")
    }

    @Test func theKindsAreTheBins() {
        #expect(TrashKind.allCases.map(\.rawValue) == ["item", "project", "routine", "season", "goal"])
        #expect(TrashKind.item.container == nil)
        for kind in OrganizeKind.allCases {
            #expect(TrashKind(kind).container == kind)
        }
        #expect(TrashKind.allCases.map(\.label) == ["Item", "Project", "Routine", "Season", "Goal"])
    }
}
