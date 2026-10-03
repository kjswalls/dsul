import Foundation
import Testing
import DsulCore

// The web's own answers for the item sheet's edits and its Delete, checked
// against ItemEdit.swift. tests/unit/edit-writes-fixtures.test.ts drives the
// web's real gesture for each case (the dialog's mapper for the one key and
// the store action it names; `deleteTask` or `deleteHabit`) with the database
// mocked and the clock pinned, asks lib/item-edit.ts `editRefusal` for the
// refused ones, and writes tests/fixtures/day/edit-writes.json. Never edit the
// JSON by hand: regenerate it from the Vitest side (UPDATE_FIXTURES=1).
//
// The fixture's types, its loader, `JSONValue` and `phoneBody` are shared with
// ItemWriteBodyTests, which checks the same cases' wire bodies; their names
// say whose they are, since the other suites keep a private `Fixture` each.

/// Any JSON value. A null is `.null`, and a missing key is no entry at all,
/// so the two stay apart when an object is compared.
enum JSONValue: Decodable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let value = try? c.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? c.decode(Double.self) {
            self = .number(value)
        } else if let value = try? c.decode(String.self) {
            self = .string(value)
        } else if let value = try? c.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try c.decode([String: JSONValue].self))
        }
    }
}

/// A refusal's code (lib/item-edit.ts `EditRefusal`, `{code, status}`). A bare
/// code reads too.
struct EditWritesRefusal: Decodable, Sendable {
    let code: String

    private enum Key: String, CodingKey {
        case code
    }

    init(from decoder: Decoder) throws {
        if let code = try? decoder.singleValueContainer().decode(String.self) {
            self.code = code
            return
        }
        let c = try decoder.container(keyedBy: Key.self)
        self.code = try c.decode(String.self, forKey: .code)
    }
}

/// One case: an item (and, for a delete, its live subtasks), the body the
/// web's gesture would send, and what the server and the store made of it.
struct EditWritesCase: Decodable, Sendable {
    let name: String
    let item: Item
    /// The item's live subtasks, in the store's order; for a delete.
    let children: [Item]?
    /// The exact wire JSON: keys absent or null exactly as sent.
    let edit: JSONValue
    /// lib/item-edit.ts `editRefusal`'s answer, or the schema's `invalid`;
    /// null when the server takes it.
    let refusal: EditWritesRefusal?
    /// The store's end item; null when it was removed.
    let after: Item?
    /// The ids the store deleted, in its `dbDeleteItem` order; for a delete.
    let removed: [String]?
}

/// A `String.prototype.trim` answer.
struct EditWritesTrimCase: Decodable, Sendable {
    let input: String
    let expected: String
}

struct EditWritesFixture: Decodable, Sendable {
    let cases: [EditWritesCase]
    let trim: [EditWritesTrimCase]
}

enum EditWritesFixtureError: Error {
    case notFound(String)
}

/// Walks up from the calling source file to the repo root (see
/// RecurrenceFixtureTests.swift).
func loadEditWrites(_ here: String = #filePath) throws -> EditWritesFixture {
    let relative = "tests/fixtures/day/edit-writes.json"
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            let data: Data = try Data(contentsOf: candidate)
            return try JSONDecoder().decode(EditWritesFixture.self, from: data)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw EditWritesFixtureError.notFound("\(relative) above \(here)")
}

/// The body the phone would build to send `wire`: `.edit` for a field action,
/// `.delete` for a delete. Nil for a body the phone never builds (an action it
/// doesn't send, a key it doesn't write, a value of the wrong type), which
/// only a case the server refuses may hold.
func phoneBody(_ wire: JSONValue) -> ItemWriteBody? {
    guard case .object(let fields) = wire, case .string(let action)? = fields["action"] else { return nil }
    switch action {
    case "title":
        guard fields.count == 2, case .string(let title)? = fields["title"] else { return nil }
        return .edit(.title(title))
    case "notes":
        guard fields.count == 2, let notes = fields["notes"] else { return nil }
        switch notes {
        case .null: return .edit(.notes(nil))
        case .string(let text): return .edit(.notes(text))
        default: return nil
        }
    case "delete":
        return fields.count == 1 ? .delete : nil
    default:
        return nil
    }
}

extension EditWritesCase {
    /// The case's edit as the phone holds it; nil for a delete.
    fileprivate var phoneEdit: ItemEdit? {
        guard case .edit(let phone)? = phoneBody(edit) else { return nil }
        return phone
    }

    /// A title edit the server takes.
    fileprivate var takenTitle: Bool {
        guard case .title? = phoneEdit else { return false }
        return refusal == nil
    }

    /// A notes edit the server takes that clears them with null.
    fileprivate var clearsNotes: Bool {
        guard case .notes(let notes)? = phoneEdit, refusal == nil else { return false }
        return notes == nil
    }

    /// A notes edit the server takes, and trims first.
    fileprivate var trimsNotes: Bool {
        guard case .notes(let notes?)? = phoneEdit, refusal == nil else { return false }
        return jsTrim(notes) != notes
    }

    fileprivate var isDelete: Bool {
        guard case .delete? = phoneBody(edit) else { return false }
        return true
    }
}

/// Would the route take this edit's text: its schema (a title that trims to
/// something, inside the outer limits) and lib/item-edit.ts `editRefusal`'s
/// growth caps, on the trimmed text against what is stored.
private func fits(_ edit: ItemEdit, on item: Item) -> Bool {
    switch edit {
    case .title(let raw):
        let title = jsTrim(raw)
        return !title.isEmpty && title.utf16.count <= EditLimits.outerTitle
            && title.utf16.count <= growthLimit(cap: EditLimits.title, stored: item.title)
    case .notes(let raw):
        guard let raw else { return true }
        return raw.utf16.count <= EditLimits.outerNotes
            && jsTrim(raw).utf16.count <= growthLimit(cap: EditLimits.notes, stored: item.notes)
    }
}

@Suite struct EditWritesFixtureTests {
    /// The cases PR 2a is built on: a write, an edit already so, a refused
    /// growth, a clear, a trim, a cascade and a habit's delete, on a subtask
    /// and a custom type too.
    @Test func everyKindOfCaseIsThere() throws {
        let cases = try loadEditWrites().cases
        #expect(cases.contains { $0.takenTitle && $0.after?.title != $0.item.title }, "a title that writes")
        #expect(cases.contains { $0.takenTitle && $0.after == $0.item }, "a title already so")
        #expect(cases.contains { $0.refusal?.code == "invalid" }, "a refused growth")
        #expect(cases.contains { $0.clearsNotes }, "notes cleared with null")
        #expect(cases.contains { $0.trimsNotes }, "notes the server trims")
        #expect(cases.contains { $0.isDelete && ($0.children?.count ?? 0) >= 2 }, "a delete with two subtasks")
        #expect(cases.contains { $0.isDelete && $0.item.isHabit }, "a habit's delete")
        #expect(cases.contains { $0.item.parentItemId != nil }, "a subtask")
        #expect(cases.contains { $0.item.type == "custom" }, "a custom type")
    }

    /// `editAllowed` answers the type's refusals, and the field's growth cap
    /// (`fits`) the `invalid` ones; everything else is taken.
    @Test func theGatesRefuseWhatTheServerRefuses() throws {
        for c in try loadEditWrites().cases where !c.isDelete {
            guard let edit = c.phoneEdit else {
                #expect(c.refusal?.code == "invalid", "\(c.name): a body the phone never builds")
                continue
            }
            let allowed = editAllowed(edit, on: c.item, caps: caps(c.item.typeName))
            switch c.refusal?.code {
            case .none:
                #expect(allowed, "\(c.name): allowed")
                #expect(fits(edit, on: c.item), "\(c.name): fits")
            case .some("invalid"):
                #expect(allowed, "\(c.name): allowed")
                #expect(!fits(edit, on: c.item), "\(c.name): too long")
            default:
                #expect(!allowed, "\(c.name): refused as \(c.refusal?.code ?? "")")
            }
        }
    }

    /// Whatever a case sends, the phone's own cleaning of it is a body the
    /// server takes, measured against the stored text as the field seeds it.
    @Test func thePhonesCleaningAlwaysFits() throws {
        for c in try loadEditWrites().cases {
            switch c.phoneEdit {
            case .title(let raw)?:
                let limit = growthLimit(cap: EditLimits.title, stored: c.item.title)
                if let title = cleanTitle(raw, limit: limit) {
                    #expect(fits(ItemEdit.title(title), on: c.item), "\(c.name)")
                }
            case .notes(let raw)?:
                let limit = growthLimit(cap: EditLimits.notes, stored: c.item.notes)
                let notes = cleanNotes(raw ?? "", limit: limit)
                #expect(fits(ItemEdit.notes(notes), on: c.item), "\(c.name)")
            case nil:
                continue
            }
        }
    }

    /// The optimistic step is the store's end state: the whole decoded item,
    /// so a field the edit must not touch is pinned too.
    @Test func editingLandsWhereTheStoreDoes() throws {
        for c in try loadEditWrites().cases where c.refusal == nil && !c.isDelete {
            let edit = try #require(c.phoneEdit, "\(c.name): no edit")
            let after = try #require(c.after, "\(c.name): no after")
            #expect(editing(c.item, edit) == after, "\(c.name)")
            #expect((c.removed ?? []).isEmpty, "\(c.name): removes nothing")
        }
    }

    /// Delete takes what the store takes, in its order: the item, then (unless
    /// it is a habit) its subtasks. Put back, the list is as it was.
    @Test func deletingTakesWhatTheStoreDeletes() throws {
        for c in try loadEditWrites().cases where c.isDelete {
            let store = [c.item] + (c.children ?? [])
            let (kept, removed) = deleting(c.item.id, from: store)
            let want = try #require(c.removed, "\(c.name): no removed")
            #expect(removed.map { $0.item.id.uuidString.lowercased() } == want.map { $0.lowercased() }, "\(c.name)")
            let gone = Set(removed.map(\.item.id))
            #expect(kept == store.filter { !gone.contains($0.id) }, "\(c.name): kept")
            #expect(c.after == nil, "\(c.name): after")
            #expect(reinserting(removed, into: kept) == store, "\(c.name): put back")
        }
    }

    @Test func jsTrimIsStringPrototypeTrim() throws {
        let cases = try loadEditWrites().trim
        #expect(!cases.isEmpty)
        for t in cases {
            // By scalar: String's == would call some different strings equal.
            #expect(Array(jsTrim(t.input).unicodeScalars) == Array(t.expected.unicodeScalars),
                    "\(t.input.debugDescription)")
        }
    }
}
