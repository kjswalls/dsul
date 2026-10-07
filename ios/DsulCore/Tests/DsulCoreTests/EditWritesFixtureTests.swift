import Foundation
import Testing
import DsulCore

// The web's own answers for the item sheet's edits (the fields, from 2c the
// priority, times a day and reminder chips, from 2d the time chip, from 2e
// the repeat chip, and from 2f the project chip), its Delete, Add a subtask
// and Reset streak, checked against ItemEdit.swift, Registry.swift's
// `canAddSubtask` and `isRemindable`, DayBuckets.swift's time-to-bucket rules,
// Cadence.swift's repeat words and EditCopy.swift (the container nouns too).
// tests/unit/edit-writes-fixtures.test.ts drives the web's real gesture for
// each case (the item panel's draft, seeded as the panel seeds it, changed as
// the field or chip changes it, saved by the dialog's own `commitEdit`, both
// its passes, to the store actions they name; for the project chip the bulk
// Move to project, `setItemsProject`, the rule's own home, with the fixture's
// `projects` in the store; `deleteTask` or `deleteHabit`; the Subtasks
// section's `addTask`; the Reset streak verb) with the database
// mocked and the clock pinned, asks lib/item-edit.ts `editRefusal`,
// `subtaskRefusal` and `resetStreakRefusal` for the refused ones (and the
// route's schema for the bodies it refuses: an anchor with no time, a time
// beside Anytime, an empty time edit, a repeat's days or day beside the wrong
// frequency or out of order, a project id that isn't a uuid), and writes
// tests/fixtures/day/edit-writes.json. Never edit the JSON by hand: regenerate
// it from the Vitest side (UPDATE_FIXTURES=1).
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

/// One case: an item (and, for a delete or a new subtask, its live
/// subtasks), the body the web's gesture would send, and what the server and
/// the store made of it.
struct EditWritesCase: Decodable, Sendable {
    let name: String
    let item: Item
    /// The item's live subtasks, in the store's order; for a delete, and for
    /// a new subtask, whose `order` counts the store's rows.
    let children: [Item]?
    /// The exact wire JSON: keys absent or null exactly as sent.
    let edit: JSONValue
    /// lib/item-edit.ts `editRefusal`'s answer (`subtaskRefusal`'s,
    /// `resetStreakRefusal`'s), or the schema's `invalid`; null when the
    /// server takes it.
    let refusal: EditWritesRefusal?
    /// The patch the store wrote, as the route writes it (`editPatch`): `{}`
    /// when nothing was written; null for a refusal.
    let updates: JSONValue?
    /// The store's end item; null when it was removed.
    let after: Item?
    /// The ids the store deleted, in its `dbDeleteItem` order; for a delete.
    let removed: [String]?
    /// The row the store created (`createItem`); for a new subtask the
    /// server takes, else null.
    let created: Item?
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

/// The fixture's `limits`: lib/item-edit.ts `EDIT_LIMITS` (`title`, `notes`,
/// `anchor`), `OUTER_LIMITS` (`outerTitle`, `outerNotes`, `outerAnchor`) and
/// `NEW_TITLE_LIMIT` (`newTitle`), in UTF-16 units; `TIMES_PER_DAY_MAX`
/// (`timesPerDayMax`); `MAX_DURATION_MINUTES` (`durationMax`), in minutes;
/// and lib/bulk-add.ts `MAX_BULK_ITEMS` (`bulkMax`), in lines. Read on its
/// own, so only the test that pins them depends on it.
private struct EditWritesLimits: Decodable, Sendable {
    struct Limits: Decodable, Sendable {
        let title: Int
        let notes: Int
        let outerTitle: Int
        let outerNotes: Int
        let newTitle: Int
        let bulkMax: Int
        let anchor: Int
        let outerAnchor: Int
        let timesPerDayMax: Int
        let durationMax: Int
    }

    let limits: Limits
}

/// The fixture's `buckets`: lib/time-bucket.ts `getBucketForTime` at a few
/// times (`forTime`), `autoCorrectBucket` at a few pairs (`corrected`, a null
/// bucket or answer kept as null), and `BUCKET_START_TIMES` (`starts`). Read
/// on its own, as `limits` is.
private struct EditWritesBuckets: Decodable, Sendable {
    struct ForTime: Decodable, Sendable {
        let time: String
        let bucket: String
    }

    struct Corrected: Decodable, Sendable {
        let time: String
        let bucket: String?
        let expected: String?
    }

    struct Starts: Decodable, Sendable {
        let morning: String
        let afternoon: String
        let evening: String
    }

    struct Buckets: Decodable, Sendable {
        let forTime: [ForTime]
        let corrected: [Corrected]
        let starts: Starts
    }

    let buckets: Buckets
}

/// The fixture's `durations`: lib/item-edit.ts `DURATION_ORDER` as numbers
/// (`presets`), and `durationLabel` at each preset and at a few other lengths
/// (`labels`). Read on its own, as `limits` is.
private struct EditWritesDurations: Decodable, Sendable {
    struct Label: Decodable, Sendable {
        let minutes: Int
        let label: String
    }

    struct Durations: Decodable, Sendable {
        let presets: [Int]
        let labels: [Label]
    }

    let durations: Durations
}

/// The fixture's words: lib/item-edit.ts `EDIT_COPY` (`copy`) and
/// `streakRunText` at a few streaks (`streakRun`). Read on their own, as
/// `limits` is.
private struct EditWritesWords: Decodable, Sendable {
    struct Copy: Decodable, Sendable {
        let resetStreakMessage: String
        let subtaskPlaceholder: String
        let subtaskPasteCapped: String
        let reminderAnchorPlaceholder: String
        let reminderAnchorHint: String
        let reminderNeedsDate: String
        let selectAtLeastOneDay: String
        let monthlyNote: String
    }

    struct StreakRun: Decodable, Sendable {
        let streak: Int
        let text: String
    }

    let copy: Copy
    let streakRun: [StreakRun]
}

/// The fixture's `repeats`: lib/planner-types.ts `REPEAT_FREQUENCY_LABELS`'
/// entries in their order (`labels`) and `WEEKDAY_LABELS` (`weekdays`). Read on
/// its own, as `limits` is.
private struct EditWritesRepeats: Decodable, Sendable {
    struct Label: Decodable, Sendable {
        let frequency: String
        let label: String
    }

    struct Repeats: Decodable, Sendable {
        let labels: [Label]
        let weekdays: [String]
    }

    let repeats: Repeats
}

/// The fixture's `projects`: the generator's own, which it seeds into the
/// store for every project case, by `id` and `name`. Read on its own, as
/// `limits` is.
private struct EditWritesProjects: Decodable, Sendable {
    struct Project: Decodable, Sendable {
        let id: String
        let name: String
    }

    let projects: [Project]
}

/// The fixture's `containers`: lib/container-registry.ts `CONTAINER_KINDS`'
/// words for the three kinds an item meets, each kind's `label` and
/// `labelPlural`, and the project's `unsetLabel`. Read on its own, as `limits`
/// is.
private struct EditWritesContainers: Decodable, Sendable {
    struct Kind: Decodable, Sendable {
        let label: String
        let labelPlural: String
    }

    struct ProjectKind: Decodable, Sendable {
        let label: String
        let labelPlural: String
        let unsetLabel: String
    }

    struct Containers: Decodable, Sendable {
        let project: ProjectKind
        let routine: Kind
        let season: Kind
    }

    let containers: Containers
}

enum EditWritesFixtureError: Error {
    case notFound(String)
}

/// The fixture's bytes. Walks up from the calling source file to the repo
/// root (see RecurrenceFixtureTests.swift).
func editWritesData(_ here: String = #filePath) throws -> Data {
    let relative = "tests/fixtures/day/edit-writes.json"
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            return try Data(contentsOf: candidate)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw EditWritesFixtureError.notFound("\(relative) above \(here)")
}

func loadEditWrites(_ here: String = #filePath) throws -> EditWritesFixture {
    return try JSONDecoder().decode(EditWritesFixture.self, from: editWritesData(here))
}

/// The fixture's project names, by lowercase id, which a project body's id is
/// resolved against (`phoneBody`): the menu sends the id and holds the name.
/// Empty when the fixture has no `projects`.
private let fixtureProjectNames: [String: String] = {
    guard let data = try? editWritesData(),
          let projects = try? JSONDecoder().decode(EditWritesProjects.self, from: data).projects
    else { return [:] }
    return Dictionary(projects.map { ($0.id.lowercased(), $0.name) }, uniquingKeysWith: { first, _ in first })
}()

/// The body the phone would build to send `wire`: `.edit` for a field or chip
/// action, `.delete`, `.addSubtask` and `.resetStreak` for theirs. Nil for a
/// body the phone never builds (an action it doesn't send, a key it doesn't
/// write, a value of the wrong type, an id that isn't a uuid, a count that
/// isn't whole, words with no time, a time edit with no key, a time beside
/// Anytime or a null part of day, a length out of range, a frequency it
/// doesn't know, a repeat's days or day the route's schema refuses, a project
/// id that isn't a uuid), which only a case the server refuses may hold. A
/// project id is resolved against `projects` (lowercase id to name), as the
/// menu holds both; one it doesn't list is a body the phone never builds.
func phoneBody(_ wire: JSONValue, projects: [String: String] = fixtureProjectNames) -> ItemWriteBody? {
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
    case "addSubtask":
        guard fields.count == 3, case .string(let rawID)? = fields["id"], let id = UUID(uuidString: rawID),
              case .string(let title)? = fields["title"]
        else { return nil }
        return .addSubtask(id: id, title: title)
    case "resetStreak":
        return fields.count == 1 ? .resetStreak : nil
    case "priority":
        guard fields.count == 2, let priority = fields["priority"] else { return nil }
        switch priority {
        case .null: return .edit(.priority(nil))
        case .string(let level): return .edit(.priority(level))
        default: return nil
        }
    case "timesPerDay":
        guard fields.count == 2, case .number(let count)? = fields["timesPerDay"],
              let whole = Int(exactly: count)
        else { return nil }
        return .edit(.timesPerDay(whole))
    case "reminder":
        let time: String?
        switch fields["time"] {
        case .null?: time = nil
        case .string(let hhmm)?: time = hhmm
        default: return nil
        }
        let anchor: ColumnWrite?
        switch fields["anchor"] {
        case nil: anchor = nil
        case .null?: anchor = .clear
        case .string(let words)?: anchor = .set(words)
        default: return nil
        }
        guard fields.count == (anchor == nil ? 2 : 3) else { return nil }
        // The encoder never puts words beside a null time.
        if time == nil, anchor != nil { return nil }
        return .edit(.reminder(time: time, anchor: anchor))
    case "time":
        // A key the edit may leave off: absent is nil, null `.clear`; nil
        // for a value of the wrong type.
        func column(_ key: String) -> ColumnWrite?? {
            switch fields[key] {
            case nil: return .some(nil)
            case .null?: return .some(.clear)
            case .string(let value)?: return .some(.set(value))
            default: return nil
            }
        }
        guard let bucket = column("timeBucket"), let startTime = column("startTime") else { return nil }
        let duration: Int?
        switch fields["duration"] {
        case nil:
            duration = nil
        case .number(let minutes)?:
            guard let whole = Int(exactly: minutes), (1...EditLimits.durationMax).contains(whole) else { return nil }
            duration = whole
        default:
            return nil
        }
        let sent = [bucket != nil, startTime != nil, duration != nil].filter { $0 }.count
        guard sent > 0, fields.count == 1 + sent else { return nil }
        // The sheet never puts a time beside Anytime or none.
        if case .set? = startTime, bucket == .set("anytime") || bucket == .clear { return nil }
        return .edit(.time(bucket: bucket, startTime: startTime, duration: duration))
    case "repeat":
        guard case .string(let frequency)? = fields["frequency"] else { return nil }
        let days: [Int]?
        switch fields["days"] {
        case nil:
            days = nil
        case .array(let values)?:
            var whole: [Int] = []
            for value in values {
                guard case .number(let n) = value, let day = Int(exactly: n) else { return nil }
                whole.append(day)
            }
            days = whole
        default:
            return nil
        }
        let monthDay: Int?
        switch fields["monthDay"] {
        case nil:
            monthDay = nil
        case .number(let n)?:
            guard let whole = Int(exactly: n) else { return nil }
            monthDay = whole
        default:
            return nil
        }
        guard fields.count == 2 + (days == nil ? 0 : 1) + (monthDay == nil ? 0 : 1),
              isRepeatShape(frequency: frequency, days: days, monthDay: monthDay)
        else { return nil }
        return .edit(.repeats(frequency: frequency, days: days, monthDay: monthDay))
    case "project":
        guard fields.count == 2, let projectId = fields["projectId"] else { return nil }
        switch projectId {
        case .null:
            return .edit(.project(id: nil, name: nil))
        case .string(let id):
            guard UUID(uuidString: id) != nil, let name = projects[id.lowercased()] else { return nil }
            return .edit(.project(id: id, name: name))
        default:
            return nil
        }
    default:
        return nil
    }
}

/// The route's repeat body: a frequency `RepeatFrequencySchema` names; `days`
/// exactly with "custom", non-empty and strictly ascending within 0...6; and
/// `monthDay` exactly with "monthly", within 1...31. Whether the item's type
/// offers the frequency is `editRefusal`'s, not the schema's.
private func isRepeatShape(frequency: String, days: [Int]?, monthDay: Int?) -> Bool {
    guard repeatFrequencyOrder.contains(frequency) else { return false }
    if frequency == "custom" {
        guard let days, !days.isEmpty, days.allSatisfy({ (0...6).contains($0) }),
              zip(days, days.dropFirst()).allSatisfy({ $0 < $1 })
        else { return false }
    } else if days != nil {
        return false
    }
    if frequency == "monthly" {
        guard let monthDay, (1...31).contains(monthDay) else { return false }
    } else if monthDay != nil {
        return false
    }
    return true
}

/// The route's `TimeStrSchema`: a 24-hour "HH:mm", 00:00 to 23:59.
private func isTimeOfDay(_ s: String) -> Bool {
    let digits = Array(s.utf8)
    guard digits.count == 5, digits[2] == UInt8(ascii: ":") else { return false }
    func digit(_ i: Int) -> Int? {
        let d = digits[i]
        return d >= UInt8(ascii: "0") && d <= UInt8(ascii: "9") ? Int(d - UInt8(ascii: "0")) : nil
    }
    guard let h1 = digit(0), let h2 = digit(1), let m1 = digit(3), digit(4) != nil else { return false }
    return h1 * 10 + h2 <= 23 && m1 <= 5
}

extension EditWritesCase {
    /// The wire's `action`, whether or not the phone builds the body.
    fileprivate var action: String? {
        guard case .object(let fields) = edit, case .string(let action)? = fields["action"] else { return nil }
        return action
    }

    /// A typed edit's case, a field's (`title`, `notes`) or a chip's
    /// (`priority`, `timesPerDay`, `reminder`, `time`, `repeat`, `project`),
    /// the phone's body or not.
    fileprivate var isFieldEdit: Bool {
        guard let action else { return false }
        return ["title", "notes", "priority", "timesPerDay", "reminder", "time", "repeat", "project"]
            .contains(action)
    }

    /// The case's edit as the phone holds it; nil for anything but a field.
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

    /// The new subtask's id and title, as the phone would send them; nil
    /// for any other case.
    fileprivate var newSubtask: (id: UUID, title: String)? {
        guard case .addSubtask(let id, let title)? = phoneBody(edit) else { return nil }
        return (id, title)
    }

    fileprivate var isReset: Bool {
        guard case .resetStreak? = phoneBody(edit) else { return false }
        return true
    }

    /// A priority edit the server takes: `.some(level)`, with `.some(nil)`
    /// for a clear; nil for any other case.
    fileprivate var takenPriority: String?? {
        guard case .priority(let level)? = phoneEdit, refusal == nil else { return nil }
        return .some(level)
    }

    /// A times-a-day edit the server takes.
    fileprivate var takenCount: Int? {
        guard case .timesPerDay(let count)? = phoneEdit, refusal == nil else { return nil }
        return count
    }

    /// A reminder edit the server takes.
    fileprivate var takenReminder: (time: String?, anchor: ColumnWrite?)? {
        guard case .reminder(let time, let anchor)? = phoneEdit, refusal == nil else { return nil }
        return (time, anchor)
    }

    /// A time edit the server takes, its keys as sent.
    fileprivate var takenTime: (bucket: ColumnWrite?, startTime: ColumnWrite?, duration: Int?)? {
        guard case .time(let bucket, let startTime, let duration)? = phoneEdit, refusal == nil else { return nil }
        return (bucket, startTime, duration)
    }

    /// A repeat edit the server takes, its keys as sent.
    fileprivate var takenRepeat: (frequency: String, days: [Int]?, monthDay: Int?)? {
        guard case .repeats(let frequency, let days, let monthDay)? = phoneEdit, refusal == nil else { return nil }
        return (frequency, days, monthDay)
    }

    /// A project edit the server takes: the id sent and the name the menu
    /// holds for it, both nil for No project.
    fileprivate var takenProject: (id: String?, name: String?)? {
        guard case .project(let id, let name)? = phoneEdit, refusal == nil else { return nil }
        return (id, name)
    }

    /// The store wrote nothing (`updates` is `{}`).
    fileprivate var wroteNothing: Bool {
        return updates == .object([:])
    }
}

/// Would the route take this edit's values: its schema (a title that trims to
/// something, text inside the outer limits, a known priority, a count from 1
/// to the most, a time that is HH:mm) and lib/item-edit.ts `editRefusal`'s
/// growth caps, on the trimmed text against what is stored. A reminder turned
/// off carries no words on the wire, so only its time is measured. A time
/// edit's part of day is one of the four, its time HH:mm, and its length in
/// range; and the row's rule: the part of day and the time as they will be
/// once written (each sent, else the item's own) never put a time beside
/// Anytime or none. A repeat edit has no row rule: its body's shape is all
/// (`isRepeatShape`), and the type's frequencies and the subtask are the
/// gate's (`frequency_not_allowed`, `not_for_subtask`). A project edit has no
/// text and no row rule: its body's rules are the gate's.
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
    case .priority(let level):
        guard let level else { return true }
        return ["low", "medium", "high"].contains(level)
    case .timesPerDay(let count):
        return (1...EditLimits.timesPerDayMax).contains(count)
    case .reminder(let time, let anchor):
        guard let time else { return true }
        guard isTimeOfDay(time) else { return false }
        guard case .set(let words)? = anchor else { return true }
        return words.utf16.count <= EditLimits.outerAnchor
            && jsTrim(words).utf16.count <= growthLimit(cap: EditLimits.anchor, stored: item.reminderAnchor)
    case .time(let bucket, let startTime, let duration):
        if case .set(let value)? = bucket, DayBucket(rawValue: value) == nil { return false }
        if case .set(let value)? = startTime, !isTimeOfDay(value) { return false }
        if let duration, !(1...EditLimits.durationMax).contains(duration) { return false }
        guard bucket != nil || startTime != nil else { return true }
        let willBucket = bucket.map(\.value) ?? item.timeBucket
        let willTime = startTime.map(\.value) ?? item.startTime
        if let time = willTime, !time.isEmpty {
            return !(willBucket ?? "").isEmpty && willBucket != "anytime"
        }
        return true
    case .repeats(let frequency, let days, let monthDay):
        return isRepeatShape(frequency: frequency, days: days, monthDay: monthDay)
    case .project:
        return true
    }
}

@Suite struct EditWritesFixtureTests {
    /// The cases PR 2a is built on: a write, an edit already so, a refused
    /// growth, a clear, a trim, a cascade and a habit's delete, on a subtask
    /// and a custom type too. And 2b's: a new subtask under a task and under a
    /// custom type, refused under a habit and under a subtask; a reset, one at
    /// 0, and one refused on a task. And 2c's: a priority set and cleared, and
    /// refused on a habit; a times a day changed, one with none stored at 1,
    /// and one refused on a task; a reminder's time alone keeping its words,
    /// one turned off, one refused on a subtask, and words with no time. And
    /// 2d's: a time that schedules an unscheduled task, one alone in its own
    /// part of day and one crossing into another, Anytime dropping a time, a
    /// habit's part of day and a habit's cleared, a project block released
    /// and one kept, a length alone, a time on a custom item, an edit equal to
    /// the seed that writes nothing, a write that ends where it began, and
    /// each refusal (`not_dated`, `not_for_subtask`, the row's `invalid` and
    /// the schema's two). And 2e's: a repeat to none and to each of the other
    /// five, a habit's and a custom item's, one that writes nothing, stored
    /// days in another order written in order, a stale day kept, and each
    /// refusal (`frequency_not_allowed`, `not_for_subtask` and the schema's).
    /// And 2f's: a project set, one already there by folded name that writes
    /// nothing, a stale id repaired, a text-only name linked, a clear, a
    /// habit's always-written clear, a custom item's, a release from a
    /// project block and a same-name repair that keeps it, and each refusal
    /// (`not_for_subtask` and the schema's).
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
        #expect(cases.contains { $0.newSubtask != nil && $0.refusal == nil }, "a new subtask")
        #expect(cases.contains { $0.newSubtask != nil && $0.refusal == nil && $0.item.type == "custom" },
                "a new subtask under a custom type")
        #expect(cases.contains { $0.newSubtask != nil && $0.refusal?.code == "no_subtasks" }, "a habit's subtask")
        #expect(cases.contains { $0.newSubtask != nil && $0.refusal?.code == "nested" }, "a subtask's subtask")
        #expect(cases.contains { $0.isReset && $0.refusal == nil && $0.after != $0.item }, "a reset that writes")
        #expect(cases.contains { $0.isReset && $0.refusal == nil && $0.after == $0.item }, "a reset at 0")
        #expect(cases.contains { $0.isReset && $0.refusal?.code == "no_streak" }, "a task's reset")

        #expect(cases.contains { ($0.takenPriority ?? nil) != nil && $0.after?.priority != $0.item.priority },
                "a priority set")
        #expect(cases.contains { $0.takenPriority == .some(nil) && $0.item.priority != nil && $0.after?.priority == nil },
                "a priority cleared with null")
        #expect(cases.contains { $0.action == "priority" && $0.item.isHabit && $0.refusal?.code == "no_priority" },
                "a habit's priority")
        #expect(cases.contains { $0.takenCount != nil && $0.after?.timesPerDay != $0.item.timesPerDay },
                "a times a day that writes")
        #expect(cases.contains { $0.takenCount == 1 && $0.item.timesPerDay == nil && $0.after == $0.item },
                "a times a day of 1 with none stored")
        #expect(cases.contains { $0.action == "timesPerDay" && $0.refusal?.code == "no_count" }, "a task's count")
        #expect(cases.contains { c in
            guard let r = c.takenReminder, r.time != nil, r.anchor == nil, let words = c.item.reminderAnchor else {
                return false
            }
            return c.after?.reminderTime == r.time && c.after?.reminderAnchor == words
        }, "a time alone that keeps the words")
        #expect(cases.contains { c in
            guard let r = c.takenReminder, r.time == nil else { return false }
            return c.item.reminderTime != nil && c.after?.reminderTime == nil && c.after?.reminderAnchor == nil
        }, "a reminder turned off")
        #expect(cases.contains {
            $0.action == "reminder" && $0.item.parentItemId != nil && $0.refusal?.code == "not_remindable"
        }, "a subtask's reminder")
        #expect(cases.contains { $0.action == "reminder" && $0.phoneEdit == nil && $0.refusal?.code == "invalid" },
                "words with no time, which the schema refuses")

        #expect(cases.contains { c in
            c.takenTime != nil && c.item.isScheduled == false && c.after?.isScheduled == true
        }, "a time that schedules an unscheduled task")
        #expect(cases.contains { c in
            guard let t = c.takenTime, t.bucket == nil, case .set(let time)? = t.startTime,
                  let stored = c.item.startTime, stored != time, !c.item.isHabit else { return false }
            return c.after?.startTime == time && c.after?.timeBucket == c.item.timeBucket
        }, "a new time alone in its own part of day")
        #expect(cases.contains { c in
            guard let t = c.takenTime, t.bucket == nil, case .set(let time)? = t.startTime else { return false }
            return c.after?.startTime == time && c.after?.timeBucket != c.item.timeBucket
        }, "a time that crosses parts of day")
        #expect(cases.contains { c in
            guard let t = c.takenTime, t.bucket == .set("anytime"), t.startTime == .clear else { return false }
            return c.item.startTime != nil && c.after?.startTime == nil && c.after?.timeBucket == "anytime"
        }, "Anytime dropping a time")
        #expect(cases.contains { c in
            guard let t = c.takenTime, case .set? = t.bucket, c.item.isHabit else { return false }
            return c.after?.timeBucket != c.item.timeBucket
        }, "a habit's part of day")
        #expect(cases.contains { c in
            guard let t = c.takenTime, t.bucket == .clear, t.startTime == .clear, c.item.isHabit else { return false }
            return c.item.timeBucket != nil && c.after?.timeBucket == nil && c.after?.startTime == nil
        }, "a habit's part of day and time cleared with null")
        #expect(cases.contains { c in
            c.takenTime != nil && c.item.inProjectBlock == true && c.after?.inProjectBlock == false
        }, "a project block released")
        #expect(cases.contains { c in
            c.takenTime != nil && c.item.inProjectBlock == true && c.after?.inProjectBlock == true
                && c.after != c.item
        }, "a project block kept")
        #expect(cases.contains { c in
            guard let t = c.takenTime, t.bucket == nil, t.startTime == nil, let minutes = t.duration else {
                return false
            }
            return c.after?.duration == minutes && c.after?.isScheduled == c.item.isScheduled && c.after != c.item
        }, "a length alone")
        #expect(cases.contains { $0.takenTime != nil && $0.item.type == "custom" && $0.after != $0.item },
                "a time on a custom item")
        #expect(cases.contains { $0.takenTime != nil && $0.wroteNothing && $0.after == $0.item },
                "a time edit that writes nothing")
        #expect(cases.contains { $0.takenTime != nil && !$0.wroteNothing && $0.after == $0.item },
                "a time edit that writes and ends where it began")
        #expect(cases.contains { $0.action == "time" && $0.refusal?.code == "not_dated" }, "an undated task's time")
        #expect(cases.contains { $0.action == "time" && $0.refusal?.code == "not_for_subtask" }, "a subtask's time")
        #expect(cases.contains { $0.action == "time" && $0.phoneEdit != nil && $0.refusal?.code == "invalid" },
                "a time beside a stored Anytime, which the row refuses")
        #expect(cases.filter { $0.action == "time" && $0.phoneEdit == nil && $0.refusal?.code == "invalid" }.count >= 2,
                "a time beside Anytime and an empty time edit, which the schema refuses")

        #expect(cases.contains { c in
            guard let r = c.takenRepeat, r.frequency == "none", let stored = c.item.repeatFrequency else { return false }
            return stored != "none" && c.after?.repeatFrequency == nil && c.after?.repeatDays == nil
                && c.after?.repeatMonthDay == nil
        }, "a repeat to none, which clears all three")
        for frequency in ["daily", "weekdays", "weekends", "monthly", "custom"] {
            #expect(cases.contains { c in
                c.takenRepeat?.frequency == frequency && !c.wroteNothing && c.after?.repeatFrequency == frequency
            }, "a repeat to \(frequency)")
        }
        #expect(cases.contains { $0.takenRepeat != nil && $0.item.isHabit && $0.after != $0.item }, "a habit's repeat")
        #expect(cases.contains { $0.takenRepeat != nil && $0.item.type == "custom" && $0.after != $0.item },
                "a custom item's repeat")
        #expect(cases.contains { $0.takenRepeat != nil && $0.wroteNothing && $0.after == $0.item },
                "a repeat edit that writes nothing")
        #expect(cases.contains { c in
            guard let r = c.takenRepeat, let sent = r.days, let stored = c.item.repeatDays else { return false }
            return stored != sent && stored.sorted() == sent && c.after?.repeatDays == sent
        }, "stored days in another order, written in order")
        #expect(cases.contains { c in
            guard let r = c.takenRepeat, r.frequency != "monthly", let day = c.item.repeatMonthDay else { return false }
            return c.wroteNothing && c.after?.repeatMonthDay == day
        }, "a stale day of the month kept")
        #expect(cases.contains { $0.action == "repeat" && $0.refusal?.code == "frequency_not_allowed" },
                "a frequency the type doesn't offer")
        #expect(cases.contains { $0.action == "repeat" && $0.refusal?.code == "not_for_subtask" }, "a subtask's repeat")
        #expect(cases.filter { $0.action == "repeat" && $0.phoneEdit == nil && $0.refusal?.code == "invalid" }.count >= 9,
                "each of the schema's repeat rules")

        #expect(cases.contains { c in
            guard let p = c.takenProject, let name = p.name else { return false }
            return c.item.project == nil && c.after?.project == name && c.after?.projectId == p.id
        }, "a project set")
        #expect(cases.contains { c in
            guard let p = c.takenProject, let name = p.name, let stored = c.item.project else { return false }
            return stored != name && sameProjectName(stored, name) && c.wroteNothing && c.after == c.item
        }, "a project already there by folded name, which writes nothing")
        #expect(cases.contains { c in
            guard let p = c.takenProject, let id = p.id, let stored = c.item.projectId else { return false }
            return stored != id && sameProjectName(c.item.project, p.name) && c.after?.projectId == id
        }, "a stale project id repaired")
        #expect(cases.contains { c in
            guard let p = c.takenProject, let id = p.id, c.item.project != nil, c.item.projectId == nil else {
                return false
            }
            return sameProjectName(c.item.project, p.name) && c.after?.projectId == id
        }, "a text-only project name linked")
        #expect(cases.contains { c in
            guard let p = c.takenProject, p.id == nil, !c.item.isHabit, c.item.project != nil else { return false }
            return c.after?.project == nil && c.after?.projectId == nil
        }, "a project cleared")
        #expect(cases.contains { c in
            guard let p = c.takenProject, p.id == nil, c.item.isHabit, c.item.project == "" else { return false }
            return !c.wroteNothing && c.after?.project == nil
        }, "a habit's clear, which always writes")
        #expect(cases.contains { $0.takenProject != nil && $0.item.type == "custom" && $0.after != $0.item },
                "a custom item's project")
        #expect(cases.contains { c in
            guard c.takenProject != nil, c.item.inProjectBlock == true, let stash = c.item.previousStartTime else {
                return false
            }
            return c.after?.inProjectBlock == false && c.after?.startTime == stash
                && c.after?.previousStartTime == nil && c.after?.timeBucket == c.item.timeBucket
        }, "a parked task released from its block")
        #expect(cases.contains { c in
            c.takenProject != nil && c.item.inProjectBlock == true && c.after?.inProjectBlock == true
                && c.after != c.item
        }, "a same-name repair that keeps the block")
        #expect(cases.contains { $0.action == "project" && $0.refusal?.code == "not_for_subtask" }, "a subtask's project")
        #expect(cases.contains { $0.action == "project" && $0.phoneEdit == nil && $0.refusal?.code == "invalid" },
                "a project id that isn't a uuid, which the schema refuses")
    }

    /// `editAllowed` answers the type's refusals (`no_notes`, `no_priority`,
    /// `no_count`, `not_remindable`, `not_for_subtask`, `not_dated`,
    /// `frequency_not_allowed`; the project chip's `not_for_subtask`), and the
    /// field's growth cap or the time's row rule (`fits`) the `invalid` ones,
    /// or the body is one the phone never builds; everything else is taken.
    @Test func theGatesRefuseWhatTheServerRefuses() throws {
        for c in try loadEditWrites().cases where c.isFieldEdit {
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
            case .reminder(let time, .set(let raw)?)?:
                let limit = growthLimit(cap: EditLimits.anchor, stored: c.item.reminderAnchor)
                let anchor = cleanAnchor(raw, limit: limit).map(ColumnWrite.set) ?? .clear
                #expect(fits(ItemEdit.reminder(time: time, anchor: anchor), on: c.item), "\(c.name)")
            case .reminder?, .priority?, .timesPerDay?, .time?, .repeats?, .project?:
                // Nothing typed to clean.
                continue
            case nil:
                continue
            }
        }
    }

    /// The optimistic step is the store's end state: the whole decoded item,
    /// so a field the edit must not touch is pinned too (a habit's
    /// `dailyCounts` under a new times a day, the words under a time alone, a
    /// project block under a new time, the day under every time edit, the
    /// status, the day and the streak under every repeat edit, and the part
    /// of day, the stash and the id under every project edit).
    @Test func editingLandsWhereTheStoreDoes() throws {
        for c in try loadEditWrites().cases where c.refusal == nil && c.isFieldEdit {
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

    /// A new subtask is the row the store created, whole: a `task` under any
    /// parent, pending, unscheduled, at the store's count of tasks, naming
    /// its parent, and nothing inherited. The parent itself is unchanged.
    @Test func aNewSubtaskIsTheStoresTask() throws {
        for c in try loadEditWrites().cases where c.refusal == nil {
            guard let sent = c.newSubtask else { continue }
            let created = try #require(c.created, "\(c.name): no created")
            let order = project([c.item] + (c.children ?? [])).tasks.count
            let child = subtaskItem(id: sent.id, title: sent.title, parent: c.item.id, order: order)
            #expect(child == created, "\(c.name)")
            #expect(created.type == "task", "\(c.name): a task, whatever the parent")
            #expect(c.after == c.item, "\(c.name): the parent is unchanged")
            #expect((c.removed ?? []).isEmpty, "\(c.name): removes nothing")
        }
    }

    /// `canAddSubtask` refuses exactly where the server does: a type without
    /// subtasks (`no_subtasks`) and a subtask (`nested`). A refused add
    /// creates nothing and leaves the item as it was.
    @Test func addingASubtaskIsRefusedWhereTheServerIs() throws {
        for c in try loadEditWrites().cases where c.action == "addSubtask" {
            let allowed = canAddSubtask(under: c.item, caps: caps(c.item.typeName))
            switch c.refusal?.code {
            case .none:
                #expect(allowed, "\(c.name): allowed")
            case .some("no_subtasks"), .some("nested"):
                #expect(!allowed, "\(c.name): refused as \(c.refusal?.code ?? "")")
                #expect(c.created == nil, "\(c.name): creates nothing")
                #expect(c.after == c.item, "\(c.name): unchanged")
            default:
                Issue.record("\(c.name): a refusal the gate doesn't answer: \(c.refusal?.code ?? "")")
            }
        }
    }

    /// The reset is the store's end state, the case at 0 included, where
    /// nothing changes. The completion history is never touched. The verb is
    /// offered (Streaks on) exactly where the store wrote something.
    @Test func resettingLandsWhereTheStoreDoes() throws {
        for c in try loadEditWrites().cases where c.isReset && c.refusal == nil {
            let after = try #require(c.after, "\(c.name): no after")
            #expect(resettingStreak(c.item) == after, "\(c.name)")
            #expect(after.completedDates == c.item.completedDates, "\(c.name): completedDates")
            #expect(after.dailyCounts == c.item.dailyCounts, "\(c.name): dailyCounts")
            #expect(c.created == nil && (c.removed ?? []).isEmpty, "\(c.name): creates and removes nothing")
            let ctx = VerbContext(dateStr: "2026-10-01", todayStr: "2026-10-01", timeZone: "UTC")
            #expect(verbEligible(.resetStreak, c.item, ctx) == (after != c.item), "\(c.name): offered")
        }
    }

    /// The server refuses a reset on a type that keeps no streak
    /// (`no_streak`), and takes it on every type that does.
    @Test func resetIsRefusedWhereTheServerIs() throws {
        for c in try loadEditWrites().cases where c.action == "resetStreak" {
            #expect(caps(c.item.typeName).streakCounter == (c.refusal == nil), "\(c.name)")
            if let code = c.refusal?.code {
                #expect(code == "no_streak", "\(c.name)")
            }
        }
    }

    /// `EditLimits` is the web's: the cases are built from the same
    /// constants, so a cap moved there would carry them with it and leave
    /// every other test here green.
    @Test func theLimitsAreTheWebs() throws {
        let limits = try JSONDecoder().decode(EditWritesLimits.self, from: editWritesData()).limits
        #expect(EditLimits.title == limits.title, "EDIT_LIMITS.title")
        #expect(EditLimits.notes == limits.notes, "EDIT_LIMITS.notes")
        #expect(EditLimits.outerTitle == limits.outerTitle, "OUTER_LIMITS.title")
        #expect(EditLimits.outerNotes == limits.outerNotes, "OUTER_LIMITS.notes")
        #expect(EditLimits.newTitle == limits.newTitle, "NEW_TITLE_LIMIT")
        #expect(maxBulkItems == limits.bulkMax, "MAX_BULK_ITEMS")
        #expect(EditLimits.anchor == limits.anchor, "EDIT_LIMITS.anchor")
        #expect(EditLimits.outerAnchor == limits.outerAnchor, "OUTER_LIMITS.anchor")
        #expect(EditLimits.timesPerDayMax == limits.timesPerDayMax, "TIMES_PER_DAY_MAX")
        #expect(EditLimits.durationMax == limits.durationMax, "MAX_DURATION_MINUTES")
    }

    /// lib/time-bucket.ts's rules are the web's at every time the fixture
    /// asks, its JavaScript edges included ("9:30" by `parseInt`, "24:00",
    /// none at all), and the parts of day start where the web's do.
    @Test func theBucketRulesAreTheWebs() throws {
        let buckets = try JSONDecoder().decode(EditWritesBuckets.self, from: editWritesData()).buckets
        #expect(!buckets.forTime.isEmpty && !buckets.corrected.isEmpty)
        for t in buckets.forTime {
            #expect(bucketForTime(t.time).rawValue == t.bucket, "getBucketForTime(\(t.time.debugDescription))")
        }
        for c in buckets.corrected {
            #expect(autoCorrectBucket(c.time, c.bucket) == c.expected,
                    "autoCorrectBucket(\(c.time.debugDescription), \(c.bucket ?? "nil"))")
        }
        #expect(bucketStartTime(.morning) == buckets.starts.morning, "BUCKET_START_TIMES.morning")
        #expect(bucketStartTime(.afternoon) == buckets.starts.afternoon, "BUCKET_START_TIMES.afternoon")
        #expect(bucketStartTime(.evening) == buckets.starts.evening, "BUCKET_START_TIMES.evening")
        #expect(bucketStartTime(.anytime) == nil)
    }

    /// The Time sheet's lengths and their words are the web's, character for
    /// character.
    @Test func theLengthsAreTheWebs() throws {
        let durations = try JSONDecoder().decode(EditWritesDurations.self, from: editWritesData()).durations
        #expect(EditCopy.durationPresets == durations.presets, "DURATION_ORDER")
        #expect(durations.presets.allSatisfy { p in durations.labels.contains { $0.minutes == p } },
                "a label for every preset")
        for l in durations.labels {
            // By scalar, as theCopyIsTheWebs compares.
            #expect(Array(EditCopy.durationLabel(l.minutes).unicodeScalars) == Array(l.label.unicodeScalars),
                    "durationLabel(\(l.minutes))")
        }
    }

    /// The words the phone shares with the web are the web's, character for
    /// character (the dashes and the ellipsis included).
    @Test func theCopyIsTheWebs() throws {
        let words = try JSONDecoder().decode(EditWritesWords.self, from: editWritesData())
        // By scalar: String's == would call some different strings equal.
        func same(_ a: String, _ b: String) -> Bool {
            return Array(a.unicodeScalars) == Array(b.unicodeScalars)
        }
        #expect(same(EditCopy.resetStreakMessage, words.copy.resetStreakMessage), "resetStreakMessage")
        #expect(same(EditCopy.subtaskPlaceholder, words.copy.subtaskPlaceholder), "subtaskPlaceholder")
        #expect(same(EditCopy.subtaskPasteCapped, words.copy.subtaskPasteCapped), "subtaskPasteCapped")
        #expect(same(EditCopy.reminderAnchorPlaceholder, words.copy.reminderAnchorPlaceholder),
                "reminderAnchorPlaceholder")
        #expect(same(EditCopy.reminderAnchorHint, words.copy.reminderAnchorHint), "reminderAnchorHint")
        #expect(same(EditCopy.reminderNeedsDate, words.copy.reminderNeedsDate), "reminderNeedsDate")
        #expect(same(EditCopy.selectAtLeastOneDay, words.copy.selectAtLeastOneDay), "selectAtLeastOneDay")
        #expect(same(EditCopy.monthlyNote, words.copy.monthlyNote), "monthlyNote")
        #expect(words.streakRun.contains { $0.streak == 0 } && words.streakRun.contains { $0.streak == 1 })
        for run in words.streakRun {
            #expect(streakRunText(run.streak) == run.text, "streak \(run.streak)")
        }
    }

    /// The Repeat chip's frequencies, in the web's order and words, and the
    /// Custom days keys' words, character for character.
    @Test func theRepeatWordsAreTheWebs() throws {
        let repeats = try JSONDecoder().decode(EditWritesRepeats.self, from: editWritesData()).repeats
        #expect(repeats.labels.map(\.frequency) == repeatFrequencyOrder, "REPEAT_FREQUENCY_LABELS' order")
        for l in repeats.labels {
            // By scalar, as theCopyIsTheWebs compares.
            #expect(Array(repeatFrequencyLabel(l.frequency).unicodeScalars) == Array(l.label.unicodeScalars),
                    "repeatFrequencyLabel(\(l.frequency))")
        }
        #expect(repeats.weekdays.count == 7, "WEEKDAY_LABELS")
        for (day, word) in repeats.weekdays.enumerated() {
            #expect(Array(weekdayLabel(day).unicodeScalars) == Array(word.unicodeScalars), "weekdayLabel(\(day))")
        }
    }

    /// The container nouns are lib/container-registry.ts `CONTAINER_KINDS`',
    /// character for character, so the phone never spells one on its own.
    @Test func theContainerWordsAreTheWebs() throws {
        let words = try JSONDecoder().decode(EditWritesContainers.self, from: editWritesData()).containers
        // By scalar, as theCopyIsTheWebs compares.
        func same(_ a: String, _ b: String) -> Bool {
            return Array(a.unicodeScalars) == Array(b.unicodeScalars)
        }
        #expect(same(ContainerWords.project, words.project.label), "project.label")
        #expect(same(ContainerWords.projects, words.project.labelPlural), "project.labelPlural")
        #expect(same(ContainerWords.noProject, words.project.unsetLabel), "project.unsetLabel")
        #expect(same(ContainerWords.routine, words.routine.label), "routine.label")
        #expect(same(ContainerWords.routines, words.routine.labelPlural), "routine.labelPlural")
        #expect(same(ContainerWords.season, words.season.label), "season.label")
        #expect(same(ContainerWords.seasons, words.season.labelPlural), "season.labelPlural")
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
