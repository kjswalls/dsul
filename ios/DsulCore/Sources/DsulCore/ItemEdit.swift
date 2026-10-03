import Foundation

// The item sheet's typed edits and its Delete: what each may change, the text
// it may send, and the item as the web's store holds it right after. Ports of:
// - lib/item-edit.ts, the server's rule for an edit: `editRefusal`'s
//   capability gate (`editAllowed`), its growth-only caps (`EditLimits`,
//   `growthLimit`, `withinGrowthLimit`'s arithmetic), and `editPatch` applied
//   to the item (`editing`), with `cleanNotes` and `String.prototype.trim`
//   (`jsTrim`) underneath;
// - lib/planner-store.ts `deleteTask` / `deleteHabit` (`deleting`): the item
//   and, for anything but a habit, its live subtasks, which is also the child
//   pass lib/app-api.ts `del` makes on the server, in the same order;
// - lib/planner-store.ts `addTask({title, parentItemId})`, as the Subtasks
//   section calls it (`subtaskItem`), which is also the row lib/app-api.ts
//   `addSubtask` inserts; and `resetHabitStreak` (`resettingStreak`), which
//   lib/item-edit.ts `resetStreakPatch` writes on the server;
// - the phone's own cleaning before it sends (`cleanTitle`, `cleanNotes`,
//   `clampUTF16`), which keeps a body inside what the server takes, so a field
//   never sends a request the route refuses.
// Keep in step: a change there without the same change here is drift, and the
// phone shows a state the server never wrote until the next fetch replaces it.
// Checked against the web by EditWritesFixtureTests
// (tests/fixtures/day/edit-writes.json), which drives the real store and
// lib/item-edit.ts.
//
// Text is measured in UTF-16 units, JavaScript's `length`, which is what every
// cap on the server counts. What the phone SENDS is the intent (POST
// /api/app/items/:id `title`, `notes`, `delete`, `addSubtask`, `resetStreak`,
// built by ItemWriteBody.swift), never these items. `Place` and `reinserting`
// are the phone's alone: they put a deleted item back where it was when its
// delete fails.

/// One typed edit, as the phone sends it (lib/item-edit.ts `ItemEdit`). Each
/// is its own server action, so a server that doesn't list one in `writes`
/// never gets it.
public enum ItemEdit: Sendable, Hashable {
    /// The new title, already cleaned (`cleanTitle`).
    case title(String)
    /// The new notes, already cleaned (`cleanNotes`); nil clears them.
    case notes(String?)

    /// The server's `action` name, which is also what `writes` lists.
    public var action: String {
        switch self {
        case .title: "title"
        case .notes: "notes"
        }
    }
}

/// lib/item-edit.ts `EDIT_LIMITS`, `OUTER_LIMITS` and `NEW_TITLE_LIMIT`, in
/// UTF-16 units, which edit-writes.json's `limits` pins. The first are
/// growth-only caps: nothing else in dsul caps these fields, so stored text may
/// already be longer, and it may stay as long but never grow (`growthLimit`).
/// The outer ones are what one request may carry at all; a stored value past
/// them is too long to edit on the phone. `newTitle` is the plain cap on a
/// title that has nothing stored to grow from: a new subtask, and a capture.
public enum EditLimits {
    public static let title = 500
    public static let notes = 50_000
    public static let outerTitle = 10_000
    public static let outerNotes = 200_000
    public static let newTitle = 500
}

/// The longest a field may grow to: `cap`, or what is stored when that is
/// longer (lib/item-edit.ts `withinGrowthLimit`: `next.length <=
/// Math.max(cap, stored?.length ?? 0)`).
public func growthLimit(cap: Int, stored: String?) -> Int {
    return max(cap, stored?.utf16.count ?? 0)
}

/// What `String.prototype.trim` strips: ECMAScript's WhiteSpace and
/// LineTerminator, which is also a JavaScript regex's `\s` (BulkLines.swift
/// reads it there). Not Foundation's `.whitespacesAndNewlines`, which keeps
/// U+FEFF and strips U+0085.
func isJSWhitespace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x0009...0x000D, 0x0020, 0x00A0, 0x1680, 0x2000...0x200A,
         0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
        return true
    default:
        return false
    }
}

/// `String.prototype.trim`, by Unicode scalar rather than by Character, so a
/// space before a combining mark goes as it does in JavaScript.
public func jsTrim(_ s: String) -> String {
    let scalars = s.unicodeScalars
    guard let first = scalars.firstIndex(where: { !isJSWhitespace($0) }),
          let last = scalars.lastIndex(where: { !isJSWhitespace($0) })
    else { return "" }
    var kept = String.UnicodeScalarView()
    kept.append(contentsOf: scalars[first...last])
    return String(kept)
}

/// `s` cut to at most `max` UTF-16 units, by whole Characters from the end,
/// so an emoji at the limit goes whole rather than leaving half a surrogate
/// pair. The longest prefix that fits; `s` itself when it already does.
public func clampUTF16(_ s: String, _ max: Int) -> String {
    guard s.utf16.count > max else { return s }
    var used = 0
    var end = s.startIndex
    while end < s.endIndex {
        let next = s.index(after: end)
        let width = s[end..<next].utf16.count
        if used + width > max { break }
        used += width
        end = next
    }
    return String(s[..<end])
}

/// A typed or pasted title as the phone sends it: every newline a space (the
/// web's title is one line), trimmed, cut to `limit` and trimmed again, so a
/// cut can't leave a trailing space for the server to strip. Nil when nothing
/// is left, which the field reads as "put the stored title back". Pass
/// `growthLimit(cap: EditLimits.title, stored:)` of the stored title, which
/// is what the route measures against.
public func cleanTitle(_ raw: String, limit: Int) -> String? {
    let oneLine = String(raw.map { $0.isNewline ? Character(" ") : $0 })
    let title = jsTrim(clampUTF16(jsTrim(oneLine), limit))
    return title.isEmpty ? nil : title
}

/// Notes as the phone sends them: lib/item-edit.ts `cleanNotes` (trimmed, and
/// empty is none, so nil clears them), cut to `limit` with the title's
/// clamp-then-trim. Newlines inside are kept. Pass
/// `growthLimit(cap: EditLimits.notes, stored:)` of the stored notes, which
/// is what the route measures against.
public func cleanNotes(_ raw: String, limit: Int) -> String? {
    let notes = jsTrim(clampUTF16(jsTrim(raw), limit))
    return notes.isEmpty ? nil : notes
}

/// lib/item-edit.ts `editRefusal`'s type gate: may `item`'s type take `edit`
/// at all? A title is every type's, a subtask's included; notes are a type's
/// only when its schema has them (`caps.hasNotes`, the server's `no_notes`).
/// The growth caps are the field's to keep (`growthLimit`), not this gate's.
public func editAllowed(_ edit: ItemEdit, on item: Item, caps: ItemCaps) -> Bool {
    switch edit {
    case .title:
        return true
    case .notes:
        return caps.hasNotes
    }
}

/// The item after `edit`: lib/item-edit.ts `editPatch` applied, which is what
/// the web's store holds after the dialog saves the same field, and what the
/// server writes. The optimistic step, and the rebase's replay of a landed
/// edit.
/// - title: trimmed (the route's schema trims). One that trims to nothing is
///   refused there, so the item is unchanged.
/// - notes: `cleanNotes`, so blank or nil clears them.
/// No cap is applied: the server refuses growth rather than cutting it, and
/// the field never sends it.
public func editing(_ item: Item, _ edit: ItemEdit) -> Item {
    var next = item
    switch edit {
    case .title(let raw):
        let title = jsTrim(raw)
        guard !title.isEmpty else { return item }
        next.title = title
    case .notes(let raw):
        let notes = jsTrim(raw ?? "")
        next.notes = notes.isEmpty ? nil : notes
    }
    return next
}

// MARK: - Add a subtask, Reset streak

/// lib/planner-store.ts `addTask({ title, parentItemId })`, as the Subtasks
/// section calls it (components/planner/item-detail-sections.tsx `addSubtask`),
/// which is also the row lib/app-api.ts `addSubtask` inserts: a `task` whatever
/// the parent's type (a custom parent's subtask included), pending, unscheduled
/// (no bucket, so `isScheduled` is false), at `order`, naming its parent by the
/// lowercase id Postgres stores. Nothing else is set, and nothing is inherited
/// from the parent: no date, no project, no priority. `title` is already
/// cleaned (`cleanTitle` with `EditLimits.newTitle`). `order` is the web's
/// `get().tasks.length`, the count of task-like items that aren't subtasks
/// (`project(items).tasks.count`); the server counts the same rows
/// (`nextTaskOrder`).
public func subtaskItem(id: UUID, title: String, parent: UUID, order: Int) -> Item {
    return Item(
        id: id, type: "task", title: title, status: "pending",
        parentItemId: parent.uuidString.lowercased(), order: order, isScheduled: false
    )
}

/// lib/planner-store.ts `resetHabitStreak`: the streak counter to 0 and nothing
/// else. `completedDates` and `dailyCounts` are completion history and survive
/// it, as the confirm's words promise. A streak already 0 (or never stored) is
/// 0 after, which is what the server writes: lib/item-edit.ts
/// `resetStreakPatch` answers `{}` there, and the item is unchanged.
public func resettingStreak(_ item: Item) -> Item {
    guard (item.streak ?? 0) != 0 else { return item }
    var next = item
    next.streak = 0
    return next
}

// MARK: - Delete

/// Where an item stood in the planner's list: its index, and the item just
/// before it (nil at the front). A delete records it, so a failed delete can
/// put the item back where it was (`reinserting`).
public struct Place: Sendable, Hashable {
    public let index: Int
    public let after: UUID?

    public init(index: Int, after: UUID?) {
        self.index = index
        self.after = after
    }

    /// `id`'s place in `items`; nil when it isn't there.
    public init?(of id: UUID, in items: [Item]) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
        self.init(index: index, after: index > 0 ? items[index - 1].id : nil)
    }
}

/// An item taken out of the list, with the place it was taken from.
public struct PlacedItem: Sendable, Hashable {
    public let place: Place
    public let item: Item

    public init(place: Place, item: Item) {
        self.place = place
        self.item = item
    }
}

/// `deleteTask`'s cascade: is `item` one of `parent`'s live subtasks, which a
/// delete of `parent` takes with it? Anything but a habit whose
/// `parentItemId` names `parent`. The web compares ids as stored (lowercase,
/// as Postgres writes them); `uuidString` is uppercase, so both sides are
/// lower-cased here.
public func isDeletedWith(_ item: Item, parent: UUID) -> Bool {
    guard !item.isHabit, item.id != parent, let parentID = item.parentItemId else { return false }
    return parentID.lowercased() == parent.uuidString.lowercased()
}

/// lib/planner-store.ts `deleteTask` / `deleteHabit` (lib/item-verbs.ts `del`
/// picks between them by `isHabit`): the list without `id`, and, unless it is
/// a habit, without its subtasks (`isDeletedWith`). `removed` is in the order
/// the store calls `dbDeleteItem` and the route `deleteItem`: the item, then
/// its subtasks in list order, each with the place it held in `items`. An id
/// not in `items` removes nothing.
public func deleting(_ id: UUID, from items: [Item]) -> (kept: [Item], removed: [PlacedItem]) {
    guard let index = items.firstIndex(where: { $0.id == id }) else { return (items, []) }
    let target = items[index]
    var removedAt = [index]
    if !target.isHabit {
        removedAt += items.indices.filter { isDeletedWith(items[$0], parent: id) }
    }
    let removed = removedAt.map { i in
        PlacedItem(place: Place(index: i, after: i > 0 ? items[i - 1].id : nil), item: items[i])
    }
    let gone = Set(removed.map(\.item.id))
    return (items.filter { !gone.contains($0.id) }, removed)
}

/// Puts deleted items back: in ascending `Place.index`, each right after the
/// item recorded before it when that item is in the list, else at its index,
/// clamped to the end. Ascending, so a subtask that stood after its parent
/// finds the parent already back; by predecessor first, so another row
/// removed or added meanwhile doesn't shift it. Ascending is right for one
/// delete's `removed`, whose places were all recorded against one list;
/// separate deletes go back newest first (PlannerSync's `put`). An item
/// already in the list (a fetch brought it back) is replaced where it stands,
/// never doubled.
public func reinserting(_ removed: [PlacedItem], into items: [Item]) -> [Item] {
    var out = items
    // Sorted by index, ties in the order given, which `sorted` alone doesn't
    // promise.
    let ordered = removed.enumerated().sorted { a, b in
        a.element.place.index != b.element.place.index
            ? a.element.place.index < b.element.place.index
            : a.offset < b.offset
    }
    for (_, placed) in ordered {
        if let present = out.firstIndex(where: { $0.id == placed.item.id }) {
            out[present] = placed.item
        } else if let after = placed.place.after, let before = out.firstIndex(where: { $0.id == after }) {
            out.insert(placed.item, at: before + 1)
        } else {
            out.insert(placed.item, at: min(max(placed.place.index, 0), out.count))
        }
    }
    return out
}
