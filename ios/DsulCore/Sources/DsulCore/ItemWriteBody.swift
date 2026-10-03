import Foundation

// The JSON body of POST /api/app/items/:id for the item sheet's edits, its
// Delete, Add a subtask and Reset streak, as lib/app-api.ts `ItemWriteActions`
// takes them:
// - `{"action":"title","title":…}`;
// - `{"action":"notes","notes":…}`, where clearing sends `"notes":null`, never
//   a missing key: the route's schema is `.nullable()`, not `.optional()`, so
//   a body without the key is refused;
// - `{"action":"delete"}`;
// - `{"action":"addSubtask","id":…,"title":…}`, sent to the PARENT's route,
//   with the new subtask's id, lowercase (the route lowercases it too, so the
//   parsed body is what was sent);
// - `{"action":"resetStreak"}`;
// - `{"action":"priority","priority":…}`, where clearing sends
//   `"priority":null`, as for the notes;
// - `{"action":"timesPerDay","timesPerDay":…}`, a JSON number;
// - `{"action":"reminder","time":…}`, with `"anchor":…` (a string, or null to
//   clear the words) only when the words changed, since an absent anchor keeps
//   the stored one. A null time turns the reminder off and never carries an
//   anchor: the route's schema refuses that body, so the phone can't build it;
// - `{"action":"time"}` with `"timeBucket":…`, `"startTime":…` and
//   `"duration":…`, each only when it changed (a key left off is the row's
//   own on the server): a part of day (a string, or null for none), a
//   specific time ("HH:mm", or null for none) and a length (a JSON number).
//   At least one, and never a time beside Anytime or a null part of day,
//   which the route's schema refuses (`editAllowed` keeps the phone from
//   building either).
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
    /// A typed edit: `title`, `notes`, `priority`, `timesPerDay`,
    /// `reminder` or `time`.
    case edit(ItemEdit)
    /// Delete: the item, and, unless it is a habit, its subtasks.
    case delete
    /// A new subtask under the item the route names: the phone's own id for
    /// it, and its title, already cleaned (`cleanTitle` with
    /// `EditLimits.newTitle`).
    case addSubtask(id: UUID, title: String)
    /// Reset streak: the counter to 0, the completion history kept.
    case resetStreak

    /// The route's `action`, which is also the name `writes` lists.
    public var action: String {
        switch self {
        case .edit(let edit): edit.action
        case .delete: "delete"
        case .addSubtask: "addSubtask"
        case .resetStreak: "resetStreak"
        }
    }

    private enum Key: String, CodingKey {
        case action, id, title, notes, priority, timesPerDay, time, anchor
        case timeBucket, startTime, duration
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
        case .edit(.priority(let priority)):
            if let priority {
                try c.encode(priority, forKey: .priority)
            } else {
                try c.encodeNil(forKey: .priority)
            }
        case .edit(.timesPerDay(let count)):
            try c.encode(count, forKey: .timesPerDay)
        case .edit(.reminder(let time, let anchor)):
            if let time {
                try c.encode(time, forKey: .time)
                switch anchor {
                case .set(let words)?:
                    try c.encode(words, forKey: .anchor)
                case .clear?:
                    try c.encodeNil(forKey: .anchor)
                case nil:
                    break
                }
            } else {
                // Off: both columns cleared, so the words have nothing to say.
                try c.encodeNil(forKey: .time)
            }
        case .edit(.time(let bucket, let startTime, let duration)):
            // Each key only when it changed; a clear is null, never absent.
            for (write, key) in [(bucket, Key.timeBucket), (startTime, Key.startTime)] {
                switch write {
                case .set(let value)?:
                    try c.encode(value, forKey: key)
                case .clear?:
                    try c.encodeNil(forKey: key)
                case nil:
                    break
                }
            }
            if let duration {
                try c.encode(duration, forKey: .duration)
            }
        case .addSubtask(let id, let title):
            try c.encode(id.uuidString.lowercased(), forKey: .id)
            try c.encode(title, forKey: .title)
        case .delete, .resetStreak:
            break
        }
    }
}
