import Foundation
import Testing
import DsulCore

// ItemWriteBody.swift: the wire JSON of the item sheet's edits (the fields and
// the chips, the time chip's keys only when they changed), its Delete, Add a
// subtask and Reset streak.
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

/// A new subtask's id, as `UUID` holds it (uppercase when printed).
private let eggs = UUID(uuidString: "22222222-2222-4222-8222-22222222222A")!

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

    /// Clearing the notes sends `"notes":null`, clearing the priority
    /// `"priority":null`, and turning the reminder off `"time":null`. A
    /// missing key is refused: each of those fields is nullable, not optional.
    /// A time edit's clears are null too (no specific time, a habit's no part
    /// of day), since there a missing key keeps what is stored.
    @Test func aClearSendsNull() throws {
        let cleared = try json(ItemWriteBody.edit(ItemEdit.notes(nil)))
        #expect(cleared == JSONValue.object(["action": .string("notes"), "notes": .null]))
        let set = try json(ItemWriteBody.edit(ItemEdit.notes("Ask about the wire fee.\nHave the card ready.")))
        #expect(set == JSONValue.object([
            "action": .string("notes"), "notes": .string("Ask about the wire fee.\nHave the card ready."),
        ]))
        let unprioritized = try json(ItemWriteBody.edit(ItemEdit.priority(nil)))
        #expect(unprioritized == JSONValue.object(["action": .string("priority"), "priority": .null]))
        let off = try json(ItemWriteBody.edit(ItemEdit.reminder(time: nil, anchor: nil)))
        #expect(off == JSONValue.object(["action": .string("reminder"), "time": .null]))
        let unfiled = try json(ItemWriteBody.edit(ItemEdit.time(bucket: .clear, startTime: .clear, duration: nil)))
        #expect(unfiled == JSONValue.object(["action": .string("time"), "startTime": .null, "timeBucket": .null]))
    }

    /// Every action is `.strict()` on the server: a body carries its own keys
    /// and nothing else.
    @Test func aBodyCarriesItsOwnKeysAlone() throws {
        let title = try json(ItemWriteBody.edit(ItemEdit.title("Draft Q4 plan")))
        #expect(title == JSONValue.object(["action": .string("title"), "title": .string("Draft Q4 plan")]))
        let delete = try json(ItemWriteBody.delete)
        #expect(delete == JSONValue.object(["action": .string("delete")]))
        let add = try json(ItemWriteBody.addSubtask(id: eggs, title: "Eggs"))
        #expect(add == JSONValue.object([
            "action": .string("addSubtask"), "id": .string("22222222-2222-4222-8222-22222222222a"),
            "title": .string("Eggs"),
        ]))
        let reset = try json(ItemWriteBody.resetStreak)
        #expect(reset == JSONValue.object(["action": .string("resetStreak")]))

        let high = try json(ItemWriteBody.edit(ItemEdit.priority("high")))
        #expect(high == JSONValue.object(["action": .string("priority"), "priority": .string("high")]))
        let none = try json(ItemWriteBody.edit(ItemEdit.priority(nil)))
        #expect(none == JSONValue.object(["action": .string("priority"), "priority": .null]))
        let thrice = try json(ItemWriteBody.edit(ItemEdit.timesPerDay(3)))
        #expect(thrice == JSONValue.object(["action": .string("timesPerDay"), "timesPerDay": .number(3)]))
        // A time alone: no anchor key, so the stored words are kept.
        let retime = try json(ItemWriteBody.edit(ItemEdit.reminder(time: "08:00", anchor: nil)))
        #expect(retime == JSONValue.object(["action": .string("reminder"), "time": .string("08:00")]))
        let cue = try json(ItemWriteBody.edit(ItemEdit.reminder(time: "08:00", anchor: .set("I pour my coffee"))))
        #expect(cue == JSONValue.object([
            "action": .string("reminder"), "anchor": .string("I pour my coffee"), "time": .string("08:00"),
        ]))
        let uncue = try json(ItemWriteBody.edit(ItemEdit.reminder(time: "08:00", anchor: .clear)))
        #expect(uncue == JSONValue.object(["action": .string("reminder"), "anchor": .null, "time": .string("08:00")]))
        let off = try json(ItemWriteBody.edit(ItemEdit.reminder(time: nil, anchor: nil)))
        #expect(off == JSONValue.object(["action": .string("reminder"), "time": .null]))
        // Words beside a null time are a body the route refuses; they are
        // never sent, since off clears them anyway.
        let offWithWords = try json(ItemWriteBody.edit(ItemEdit.reminder(time: nil, anchor: .set("x"))))
        #expect(offWithWords == JSONValue.object(["action": .string("reminder"), "time": .null]))
        let offClearing = try json(ItemWriteBody.edit(ItemEdit.reminder(time: nil, anchor: .clear)))
        #expect(offClearing == JSONValue.object(["action": .string("reminder"), "time": .null]))

        // The time chip: each key only when it changed.
        let times: [(ItemEdit, [String: JSONValue])] = [
            (.time(bucket: nil, startTime: .set("10:30"), duration: nil), ["startTime": .string("10:30")]),
            (.time(bucket: .set("morning"), startTime: .set("07:00"), duration: nil),
             ["startTime": .string("07:00"), "timeBucket": .string("morning")]),
            (.time(bucket: .set("anytime"), startTime: .clear, duration: nil),
             ["startTime": .null, "timeBucket": .string("anytime")]),
            (.time(bucket: nil, startTime: .clear, duration: nil), ["startTime": .null]),
            (.time(bucket: nil, startTime: nil, duration: 45), ["duration": .number(45)]),
            (.time(bucket: .set("evening"), startTime: nil, duration: 60),
             ["duration": .number(60), "timeBucket": .string("evening")]),
            (.time(bucket: .clear, startTime: .clear, duration: nil), ["startTime": .null, "timeBucket": .null]),
        ]
        for (edit, keys) in times {
            let body = try json(ItemWriteBody.edit(edit))
            #expect(body == JSONValue.object(keys.merging(["action": .string("time")]) { a, _ in a }), "\(edit)")
        }
    }

    /// APIClient encodes with sorted keys; this is the request it sends.
    @Test func theSortedBytesAreTheRoutesBody() throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let cleared = try encoder.encode(ItemWriteBody.edit(ItemEdit.notes(nil)))
        #expect(String(decoding: cleared, as: UTF8.self) == #"{"action":"notes","notes":null}"#)
        let delete = try encoder.encode(ItemWriteBody.delete)
        #expect(String(decoding: delete, as: UTF8.self) == #"{"action":"delete"}"#)
        // The id lowercase, as Postgres stores it and the route parses it.
        let add = try encoder.encode(ItemWriteBody.addSubtask(id: eggs, title: "Eggs"))
        #expect(String(decoding: add, as: UTF8.self)
            == #"{"action":"addSubtask","id":"22222222-2222-4222-8222-22222222222a","title":"Eggs"}"#)
        let reset = try encoder.encode(ItemWriteBody.resetStreak)
        #expect(String(decoding: reset, as: UTF8.self) == #"{"action":"resetStreak"}"#)

        let bodies: [(ItemEdit, String)] = [
            (.priority("high"), #"{"action":"priority","priority":"high"}"#),
            (.priority(nil), #"{"action":"priority","priority":null}"#),
            (.timesPerDay(3), #"{"action":"timesPerDay","timesPerDay":3}"#),
            (.reminder(time: "08:00", anchor: nil), #"{"action":"reminder","time":"08:00"}"#),
            (.reminder(time: "08:00", anchor: .set("I pour my coffee")),
             #"{"action":"reminder","anchor":"I pour my coffee","time":"08:00"}"#),
            (.reminder(time: "08:00", anchor: .clear), #"{"action":"reminder","anchor":null,"time":"08:00"}"#),
            (.reminder(time: nil, anchor: nil), #"{"action":"reminder","time":null}"#),
            (.reminder(time: nil, anchor: .set("x")), #"{"action":"reminder","time":null}"#),
            (.time(bucket: nil, startTime: .set("10:30"), duration: nil), #"{"action":"time","startTime":"10:30"}"#),
            (.time(bucket: .set("morning"), startTime: .set("07:00"), duration: nil),
             #"{"action":"time","startTime":"07:00","timeBucket":"morning"}"#),
            (.time(bucket: .set("anytime"), startTime: .clear, duration: nil),
             #"{"action":"time","startTime":null,"timeBucket":"anytime"}"#),
            (.time(bucket: nil, startTime: .clear, duration: nil), #"{"action":"time","startTime":null}"#),
            (.time(bucket: nil, startTime: nil, duration: 45), #"{"action":"time","duration":45}"#),
            (.time(bucket: .set("evening"), startTime: nil, duration: 60),
             #"{"action":"time","duration":60,"timeBucket":"evening"}"#),
            (.time(bucket: .clear, startTime: .clear, duration: nil),
             #"{"action":"time","startTime":null,"timeBucket":null}"#),
        ]
        for (edit, wire) in bodies {
            let bytes = try encoder.encode(ItemWriteBody.edit(edit))
            #expect(String(decoding: bytes, as: UTF8.self) == wire, "\(edit)")
        }
    }

    /// The action is the name `writes` lists, so the app can ask `canWrite`
    /// before it builds anything.
    @Test func theBodyNamesItsAction() {
        #expect(ItemWriteBody.edit(ItemEdit.title("A")).action == "title")
        #expect(ItemWriteBody.edit(ItemEdit.notes(nil)).action == "notes")
        #expect(ItemWriteBody.delete.action == "delete")
        #expect(ItemWriteBody.addSubtask(id: eggs, title: "Eggs").action == "addSubtask")
        #expect(ItemWriteBody.resetStreak.action == "resetStreak")
        #expect(ItemEdit.title("A").action == "title")
        #expect(ItemEdit.notes("B").action == "notes")
        #expect(ItemWriteBody.edit(ItemEdit.priority("low")).action == "priority")
        #expect(ItemWriteBody.edit(ItemEdit.timesPerDay(2)).action == "timesPerDay")
        #expect(ItemWriteBody.edit(ItemEdit.reminder(time: nil, anchor: nil)).action == "reminder")
        #expect(ItemEdit.priority(nil).action == "priority")
        #expect(ItemEdit.timesPerDay(5).action == "timesPerDay")
        #expect(ItemEdit.reminder(time: "08:00", anchor: .clear).action == "reminder")
        #expect(ItemWriteBody.edit(ItemEdit.time(bucket: nil, startTime: nil, duration: 45)).action == "time")
        #expect(ItemEdit.time(bucket: .set("evening"), startTime: .clear, duration: nil).action == "time")
    }

    /// A time edit's key that didn't change is absent, never null: absent
    /// keeps what is stored, and null would clear it.
    @Test func anUnchangedKeyIsLeftOff() throws {
        let longer = ItemWriteBody.edit(ItemEdit.time(bucket: nil, startTime: nil, duration: 45))
        let value = try json(longer)
        #expect(value == JSONValue.object(["action": .string("time"), "duration": .number(45)]))
        guard case .object(let fields) = value else {
            Issue.record("not an object")
            return
        }
        #expect(fields["timeBucket"] == nil && fields["startTime"] == nil)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        #expect(String(decoding: try encoder.encode(longer), as: UTF8.self) == #"{"action":"time","duration":45}"#)
    }

    /// A count is a JSON number. `JSONValue` tries `Bool` before `Double`, and
    /// a decoder that read 1 as true would make the fixture's count of 1 a
    /// body the phone never builds; this pins that neither Linux's decoder
    /// nor Darwin's does.
    @Test func aCountIsANumber() throws {
        let one = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"timesPerDay":1}"#.utf8))
        #expect(one == JSONValue.object(["timesPerDay": .number(1)]))
        let zero = try JSONDecoder().decode(JSONValue.self, from: Data("0".utf8))
        #expect(zero == JSONValue.number(0))
        let yes = try JSONDecoder().decode(JSONValue.self, from: Data("true".utf8))
        #expect(yes == JSONValue.bool(true))

        let counts = try loadEditWrites().cases.compactMap { c -> JSONValue? in
            guard case .object(let fields) = c.edit, fields["action"] == .string("timesPerDay") else { return nil }
            return fields["timesPerDay"]
        }
        #expect(counts.contains(.number(1)), "the fixture's count of 1")
        for count in counts {
            if case .number = count { continue }
            Issue.record("a count that isn't a number: \(count)")
        }
        #expect(phoneBody(.object(["action": .string("timesPerDay"), "timesPerDay": .number(1)]))
            == .edit(.timesPerDay(1)))
    }
}
