import Foundation
import Testing
import DsulCore

// The web's own answers for the item sheet's edits (the fields, and from 2c the
// priority, times a day and reminder chips), its Delete, Add a subtask and
// Reset streak, checked against ItemEdit.swift, Registry.swift's
// `canAddSubtask` and `isRemindable` and EditCopy.swift.
// tests/unit/edit-writes-fixtures.test.ts drives the web's real gesture for
// each case (the item panel's draft, seeded as the panel seeds it, changed as
// the field or chip changes it, through the dialog's mapper to the store action
// it names; `deleteTask` or `deleteHabit`; the Subtasks section's `addTask`;
// the Reset streak verb) with the database mocked and the clock pinned, asks
// lib/item-edit.ts `editRefusal`, `subtaskRefusal` and `resetStreakRefusal`
// for the refused ones (and the route's schema for the one body it refuses, an
// anchor with no time), and writes tests/fixtures/day/edit-writes.json. Never
// edit the JSON by hand: regenerate it from the Vitest side
// (UPDATE_FIXTURES=1).
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
/// (`timesPerDayMax`); and lib/bulk-add.ts `MAX_BULK_ITEMS` (`bulkMax`), in
/// lines. Read on its own, so only the test that pins them depends on it.
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
    }

    let limits: Limits
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
    }

    struct StreakRun: Decodable, Sendable {
        let streak: Int
        let text: String
    }

    let copy: Copy
    let streakRun: [StreakRun]
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

/// The body the phone would build to send `wire`: `.edit` for a field or chip
/// action, `.delete`, `.addSubtask` and `.resetStreak` for theirs. Nil for a
/// body the phone never builds (an action it doesn't send, a key it doesn't
/// write, a value of the wrong type, an id that isn't a uuid, a count that
/// isn't whole, words with no time), which only a case the server refuses may
/// hold.
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
    default:
        return nil
    }
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
    /// (`priority`, `timesPerDay`, `reminder`), the phone's body or not.
    fileprivate var isFieldEdit: Bool {
        guard let action else { return false }
        return ["title", "notes", "priority", "timesPerDay", "reminder"].contains(action)
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
}

/// Would the route take this edit's values: its schema (a title that trims to
/// something, text inside the outer limits, a known priority, a count from 1
/// to the most, a time that is HH:mm) and lib/item-edit.ts `editRefusal`'s
/// growth caps, on the trimmed text against what is stored. A reminder turned
/// off carries no words on the wire, so only its time is measured.
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
    /// one turned off, one refused on a subtask, and words with no time.
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
    }

    /// `editAllowed` answers the type's refusals (`no_notes`, `no_priority`,
    /// `no_count`, `not_remindable`), and the field's growth cap (`fits`) the
    /// `invalid` ones, or the body is one the phone never builds; everything
    /// else is taken.
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
            case .reminder?, .priority?, .timesPerDay?:
                // Nothing typed to clean.
                continue
            case nil:
                continue
            }
        }
    }

    /// The optimistic step is the store's end state: the whole decoded item,
    /// so a field the edit must not touch is pinned too (a habit's
    /// `dailyCounts` under a new times a day, the words under a time alone).
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
        #expect(words.streakRun.contains { $0.streak == 0 } && words.streakRun.contains { $0.streak == 1 })
        for run in words.streakRun {
            #expect(streakRunText(run.streak) == run.text, "streak \(run.streak)")
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
