import Foundation
import Testing
import DsulCore

// ItemWriteBody.swift: the wire JSON of the item sheet's edits and its Delete.
// Each case in tests/fixtures/day/edit-writes.json records the exact body the
// web's gesture means (keys absent or null exactly as sent), and lib/app-api.ts
// parses every one of them through `ItemWriteSchema`; the phone's body for the
// same edit must be that JSON. Compared as JSON values (`JSONValue`, in
// EditWritesFixtureTests.swift), since neither encoder promises key order, and
// a missing key and a null are different requests to a `.nullable()` field.

/// `body` as the JSON it encodes to.
private func json(_ body: ItemWriteBody) throws -> JSONValue {
    let data = try JSONEncoder().encode(body)
    return try JSONDecoder().decode(JSONValue.self, from: data)
}

@Suite struct ItemWriteBodyTests {
    @Test func eachBodyIsTheWireJSON() throws {
        let cases = try loadEditWrites().cases
        #expect(!cases.isEmpty)
        for c in cases {
            guard let body = phoneBody(c.edit) else {
                // Only a body the server refuses may be one the phone never builds.
                #expect(c.refusal?.code == "invalid", "\(c.name): a body the phone never builds")
                continue
            }
            #expect(try json(body) == c.edit, "\(c.name)")
        }
    }

    /// Clearing the notes sends `"notes":null`. A missing key is refused:
    /// the route's field is nullable, not optional.
    @Test func aClearSendsNull() throws {
        let cleared = try json(ItemWriteBody.edit(ItemEdit.notes(nil)))
        #expect(cleared == JSONValue.object(["action": .string("notes"), "notes": .null]))
        let set = try json(ItemWriteBody.edit(ItemEdit.notes("Ask about the wire fee.\nHave the card ready.")))
        #expect(set == JSONValue.object([
            "action": .string("notes"), "notes": .string("Ask about the wire fee.\nHave the card ready."),
        ]))
    }

    /// Every action is `.strict()` on the server: a body carries its own keys
    /// and nothing else.
    @Test func aBodyCarriesItsOwnKeysAlone() throws {
        let title = try json(ItemWriteBody.edit(ItemEdit.title("Draft Q4 plan")))
        #expect(title == JSONValue.object(["action": .string("title"), "title": .string("Draft Q4 plan")]))
        let delete = try json(ItemWriteBody.delete)
        #expect(delete == JSONValue.object(["action": .string("delete")]))
    }

    /// APIClient encodes with sorted keys; this is the request it sends.
    @Test func theSortedBytesAreTheRoutesBody() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let cleared = try encoder.encode(ItemWriteBody.edit(ItemEdit.notes(nil)))
        #expect(String(decoding: cleared, as: UTF8.self) == #"{"action":"notes","notes":null}"#)
        let delete = try encoder.encode(ItemWriteBody.delete)
        #expect(String(decoding: delete, as: UTF8.self) == #"{"action":"delete"}"#)
    }

    /// The action is the name `writes` lists, so the app can ask `canWrite`
    /// before it builds anything.
    @Test func theBodyNamesItsAction() {
        #expect(ItemWriteBody.edit(ItemEdit.title("A")).action == "title")
        #expect(ItemWriteBody.edit(ItemEdit.notes(nil)).action == "notes")
        #expect(ItemWriteBody.delete.action == "delete")
        #expect(ItemEdit.title("A").action == "title")
        #expect(ItemEdit.notes("B").action == "notes")
    }
}
