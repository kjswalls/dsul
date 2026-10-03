import Foundation

// The JSON body of POST /api/app/items/:id for the item sheet's edits and its
// Delete, as lib/app-api.ts `ItemWriteActions` takes them:
// - `{"action":"title","title":…}`;
// - `{"action":"notes","notes":…}`, where clearing sends `"notes":null`, never
//   a missing key: the route's schema is `.nullable()`, not `.optional()`, so
//   a body without the key is refused;
// - `{"action":"delete"}`.
// Every action is `.strict()` there, so a key the route doesn't name is a 400,
// and `encode(to:)` is written out by hand rather than synthesized, so it
// writes exactly these keys. Checked against the web by ItemWriteBodyTests,
// which compares each body with the wire JSON the web's gesture would send
// (tests/fixtures/day/edit-writes.json) as a JSON value, so null and absent
// stay apart on Linux as well as on a phone.
//
// The app's APIClient sends it; part 1's verbs keep their own bodies there.

/// One write the item sheet sends, ready to encode.
public enum ItemWriteBody: Encodable, Sendable, Hashable {
    /// A typed edit: `title` or `notes`.
    case edit(ItemEdit)
    /// Delete: the item, and, unless it is a habit, its subtasks.
    case delete

    /// The route's `action`, which is also the name `writes` lists.
    public var action: String {
        switch self {
        case .edit(let edit): edit.action
        case .delete: "delete"
        }
    }

    private enum Key: String, CodingKey {
        case action, title, notes
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(action, forKey: .action)
        switch self {
        case .edit(.title(let title)):
            try c.encode(title, forKey: .title)
        case .edit(.notes(let notes)):
            if let notes {
                try c.encode(notes, forKey: .notes)
            } else {
                try c.encodeNil(forKey: .notes)
            }
        case .delete:
            break
        }
    }
}
