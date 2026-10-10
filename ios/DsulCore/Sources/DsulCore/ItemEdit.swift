import Foundation

// The item sheet's typed edits and its Delete: what each may change, the text
// it may send, and the item as the web's store holds it right after. Ports of:
// - lib/item-edit.ts, the server's rule for an edit: `editRefusal`'s
//   capability gate (`editAllowed`), its growth-only caps (`EditLimits`,
//   `growthLimit`, `withinGrowthLimit`'s arithmetic), and `editPatch` applied
//   to the item (`editing`), with `cleanNotes` and `String.prototype.trim`
//   (`jsTrim`) underneath. From 2c that covers the chips' three edits too:
//   a priority (`no_priority` without the field), a habit's times a day
//   (`no_count` without daily counts, and none reads as 1), and a reminder
//   (`not_remindable` on a subtask), whose two columns are written together
//   by `reminderPatch`, the dialog's own rule. From 2d, the Time chip
//   (`time`): a part of day, a specific time and a length, refused on a
//   subtask (`not_for_subtask`), on a date-anchored item with no date
//   (`not_dated`), and as a length on a type with none (`no_duration`), and
//   written as lib/item-edit.ts `timeEditPatch` writes it: the dialog's
//   `commitEdit` over the keys sent, its first pass the mappers through
//   lib/planner-store.ts `updateTask` / `updateHabit` (whose auto-correct
//   files a new time where it falls), its second `planTimeEdit` through
//   `scheduleTask` / `unscheduleTask` / `scheduleHabit`
//   (`scheduleTaskPatch`, `UNSCHEDULE_TASK_PATCH`, `scheduleHabitPatch`).
//   The date is not here: the Date chip writes through `move` (`moving`, in
//   VerbWrites.swift). From 2e, the Repeat chip (`repeat`): a frequency the
//   type offers, refused on a subtask (`not_for_subtask`) and outside the
//   type's frequencies (`frequency_not_allowed`), and written as
//   lib/item-edit.ts `repeatEditPatch` writes it: the dialog's save over the
//   keys sent, all three keys together through the dialog's own `repeatPatch`,
//   or nothing when the item already says it. From 2f, the Project chip
//   (`project`): a project by id, or none, refused on a subtask
//   (`not_for_subtask`) and on a type with no project axis (`no_project`), and
//   written as lib/item-edit.ts `projectRefilePatch` writes it, the bulk Move
//   to project's own rule (lib/planner-store.ts `setItemsProject`): the name
//   and the id, nothing when the item is already there by folded name and id,
//   and a task parked in its old project's block released from it
//   (`projectBlockRelease`), its own time and day back. From 2f-b, the
//   routine and season chips' gate (`collect`: lib/item-registry.ts
//   `isCollectible`, which lib/app-api.ts `collect` asks first, else
//   `not_collectible`). A membership is no field of the item, so `collect`
//   has no `ItemEdit` case and no step here: its body is ItemWriteBody.swift's
//   `.collect`, and the container's list moves by Membership.swift's
//   `settingMembership`;
// - lib/planner-store.ts `deleteTask` / `deleteHabit` (`deleting`): the item
//   and, for anything but a habit, its live subtasks, which is also the child
//   pass lib/app-api.ts `del` makes on the server, in the same order;
// - lib/planner-store.ts `addTask({title, parentItemId})`, as the Subtasks
//   section calls it (`subtaskItem`), which is also the row lib/app-api.ts
//   `addSubtask` inserts; and `resetHabitStreak` (`resettingStreak`), which
//   lib/item-edit.ts `resetStreakPatch` writes on the server;
// - the phone's own cleaning before it sends (`cleanTitle`, `cleanNotes`,
//   `cleanAnchor`, `clampUTF16`), which keeps a body inside what the server
//   takes, so a field never sends a request the route refuses.
// Keep in step: a change there without the same change here is drift, and the
// phone shows a state the server never wrote until the next fetch replaces it.
// Checked against the web by EditWritesFixtureTests
// (tests/fixtures/day/edit-writes.json), which drives the real store and
// lib/item-edit.ts.
//
// Text is measured in UTF-16 units, JavaScript's `length`, which is what every
// cap on the server counts. What the phone SENDS is the intent (POST
// /api/app/items/:id `title`, `notes`, `delete`, `addSubtask`, `resetStreak`,
// `priority`, `timesPerDay`, `reminder`, `time`, `repeat`, `project`,
// `collect`, built by ItemWriteBody.swift), never these items. `Place` and
// `reinserting` are the phone's alone: they put a deleted item back where it
// was when its delete fails.

/// One typed edit, as the phone sends it (lib/item-edit.ts `ItemEdit`). Each
/// is its own server action, so a server that doesn't list one in `writes`
/// never gets it.
public enum ItemEdit: Sendable, Hashable {
    /// The new title, already cleaned (`cleanTitle`).
    case title(String)
    /// The new notes, already cleaned (`cleanNotes`); nil clears them.
    case notes(String?)
    /// "low", "medium" or "high"; nil clears it.
    case priority(String?)
    /// A habit's times a day, 1...`EditLimits.timesPerDayMax`.
    case timesPerDay(Int)
    /// The reminder. `time` is "HH:mm", or nil to turn the reminder off,
    /// which clears both columns whatever `anchor` says. `anchor` is the cue
    /// words: nil keeps the stored ones and is left off the wire (the seed
    /// rule: words never typed are never sent); `.set` sends the cleaned
    /// words (`cleanAnchor`); `.clear` sends null.
    case reminder(time: String?, anchor: ColumnWrite?)
    /// The Time chip. Each key nil when it didn't change, and then left off
    /// the wire: `bucket` .set("anytime" | "morning" | "afternoon" |
    /// "evening") or .clear (none, a habit's only, which the sheet never
    /// offers); `startTime` .set("HH:mm") or .clear (no specific time);
    /// `duration` minutes, 1...`EditLimits.durationMax`. A key the edit
    /// doesn't send is the item's own when the server resolves it, and when
    /// `editing` replays it.
    case time(bucket: ColumnWrite?, startTime: ColumnWrite?, duration: Int?)
    /// The Repeat chip: one of the type's frequencies ("none", "daily",
    /// "weekdays", "weekends", "monthly", "custom"), with `days` (0 = Sun …
    /// 6 = Sat, ascending, at least one) for "custom" alone and `monthDay`
    /// (1...31) for "monthly" alone; nil otherwise, and then left off the
    /// wire. The server writes all three keys together.
    case repeats(frequency: String, days: [Int]?, monthDay: Int?)
    /// The project chip: the project's id and its name, both nil for No
    /// project. The name is for the optimistic step alone; the wire carries
    /// the id (the route reads the name).
    case project(id: String?, name: String?)

    /// The server's `action` name, which is also what `writes` lists.
    public var action: String {
        switch self {
        case .title: "title"
        case .notes: "notes"
        case .priority: "priority"
        case .timesPerDay: "timesPerDay"
        case .reminder: "reminder"
        case .time: "time"
        case .repeats: "repeat"
        case .project: "project"
        }
    }
}

/// A routine or a season, the two containers an item joins by membership (2f-b).
public enum ContainerKind: String, Sendable, Hashable {
    case routine, season
}

/// lib/item-edit.ts `sameProjectName`: is `current` the same project as
/// `name`, folded as the project kind folds (`CONTAINER_KINDS.project`
/// `caseFold`, `toLowerCase`, so `jsLowercased`)? With no name, is there no
/// name either? The two arguments read "" differently, as the TS does
/// (`name ? … : current == null`): a nil or "" `name` is no name, while a
/// `current` of "" is a name, since an unfiled habit reads "" (lib/db.ts
/// `itemFromRow`) and its clear always writes. So (nil, "") is true and
/// ("", "") is false, on both sides.
public func sameProjectName(_ current: String?, _ name: String?) -> Bool {
    guard let name, !name.isEmpty else { return current == nil }
    guard let current else { return false }
    return jsLowercased(current) == jsLowercased(name)
}

/// lib/item-edit.ts `EDIT_LIMITS`, `OUTER_LIMITS` and `NEW_TITLE_LIMIT`, the
/// text caps in UTF-16 units, `TIMES_PER_DAY_MAX`, a count, and
/// `MAX_DURATION_MINUTES`, in minutes, which edit-writes.json's `limits` pins.
/// The first are growth-only caps: nothing else in dsul caps these fields, so
/// stored text may already be longer, and it may stay as long but never grow
/// (`growthLimit`). The outer ones are what one request may carry at all; a
/// stored value past them is too long to edit on the phone. `newTitle` is the
/// plain cap on a title that has nothing stored to grow from: a new subtask,
/// and a capture. `timesPerDayMax` is the most a habit's times a day may be
/// set to, the last of the web chip's "1× a day" to "5× a day". `durationMax`
/// is the longest one request may set a length to, a day: the web's chip
/// offers 15 to 120 minutes and a block resized on the grid stores any
/// length, so it is only what the route's schema takes.
public enum EditLimits {
    public static let title = 500
    public static let notes = 50_000
    /// A reminder's cue words ("I pour my coffee").
    public static let anchor = 500
    public static let outerTitle = 10_000
    public static let outerNotes = 200_000
    public static let outerAnchor = 10_000
    public static let newTitle = 500
    public static let timesPerDayMax = 5
    public static let durationMax = 1440
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

/// One line of text as the phone sends it: every newline a space, trimmed,
/// cut to `limit` and trimmed again, so a cut can't leave a trailing space for
/// the server to strip. Nil when nothing is left.
private func cleanLine(_ raw: String, limit: Int) -> String? {
    let oneLine = String(raw.map { $0.isNewline ? Character(" ") : $0 })
    let line = jsTrim(clampUTF16(jsTrim(oneLine), limit))
    return line.isEmpty ? nil : line
}

/// A typed or pasted title as the phone sends it: every newline a space (the
/// web's title is one line), trimmed, cut to `limit` and trimmed again, so a
/// cut can't leave a trailing space for the server to strip. Nil when nothing
/// is left, which the field reads as "put the stored title back". Pass
/// `growthLimit(cap: EditLimits.title, stored:)` of the stored title, which
/// is what the route measures against.
public func cleanTitle(_ raw: String, limit: Int) -> String? {
    return cleanLine(raw, limit: limit)
}

/// A reminder's cue words as the phone sends them: the title's rule, since
/// the web's Right after field is one line too (an `<input>`): every newline
/// a space, trimmed, cut to `limit` and trimmed again. Nil when nothing is
/// left, which the Remind sheet sends as `.clear` (the dialog's
/// `reminderPatch` writes blank words as none). Pass
/// `growthLimit(cap: EditLimits.anchor, stored:)` of the stored words, which
/// is what the route measures against.
public func cleanAnchor(_ raw: String, limit: Int) -> String? {
    return cleanLine(raw, limit: limit)
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

/// lib/item-edit.ts `editRefusal`'s type gate, by the edit's action name: may
/// `item`'s type take that edit at all? Keyed by name so a chip can ask before
/// it has a value to send.
/// - `title`: every type's, a subtask's included.
/// - `notes`: a type's only when its schema has them (`caps.hasNotes`, the
///   server's `no_notes`).
/// - `priority`: `caps.hasPriority` (`no_priority`), so never a habit's, and a
///   subtask's too.
/// - `timesPerDay`: `caps.dailyCounts` (`no_count`), so a habit's alone.
/// - `reminder`: `isRemindable(_:caps:)` (`not_remindable`), so never a
///   subtask's.
/// - `time`: not a subtask (`not_for_subtask`), and a date-anchored type only
///   once it has a date (`not_dated`: the dialog shows Time only then), so a
///   habit's always, and an undated task's never.
/// - `repeat`: not a subtask (`not_for_subtask`: a subtask shows only in its
///   parent's sheet, so a repeat there would show nowhere), and a type with
///   more than one frequency (`caps.allowedFrequencies`; the web's chip shows
///   only then), so a task's, a habit's and a custom item's, dated or not.
/// - `project`: not a subtask (`not_for_subtask`), and a type with the project
///   axis (`caps.containerKind` "projects", else `no_project`), so every
///   shipped type's.
/// - `collect` (2f-b): not a subtask, and a collectible type
///   (lib/item-registry.ts `isCollectible`, else `not_collectible`), so every
///   shipped type's. The membership write, which has no `ItemEdit` case: it
///   changes no field of the item.
/// - any other name: false. Delete, Add a subtask and Reset streak have gates
///   of their own, and an action the phone doesn't know is never sent.
/// The growth caps are the field's to keep (`growthLimit`), not this gate's.
public func editAllowed(action: String, on item: Item, caps: ItemCaps) -> Bool {
    switch action {
    case "title":
        return true
    case "notes":
        return caps.hasNotes
    case "priority":
        return caps.hasPriority
    case "timesPerDay":
        return caps.dailyCounts
    case "reminder":
        return isRemindable(item, caps: caps)
    case "time":
        return !isSubtask(item) && (!caps.dateAnchored || !(item.startDate ?? "").isEmpty)
    case "repeat":
        return !isSubtask(item) && caps.allowedFrequencies.count > 1
    case "project":
        return !isSubtask(item) && caps.containerKind == "projects"
    case "collect":
        return !isSubtask(item) && caps.collectible
    default:
        return false
    }
}

/// `editAllowed(action:on:caps:)` for `edit`'s own action, and for `.time`
/// the body's own rules too, which no row is needed to judge: the route's
/// schema refuses an empty time edit and a time beside Anytime or none
/// (`invalid`), and a length outside 1...`EditLimits.durationMax`, and
/// `editRefusal` a length on a type with none (`no_duration`). The row's rule
/// (a time that would land beside a STORED Anytime or none) is the sheet's to
/// keep, as a growth cap is. For `.repeats`, likewise: the frequency is one of
/// the type's (`caps.allowedFrequencies`, else `frequency_not_allowed`), and
/// the schema's rules (`invalid`): `days` present exactly with "custom",
/// non-empty and strictly ascending within 0...6, as the dialog's keys sort
/// as they toggle and never hold a day twice; `monthDay` present exactly with
/// "monthly", within 1...31. For `.project`, the id and the name come
/// together, both set or both nil, and No project only where the type's
/// container isn't required (`caps.containerRequired`, else
/// `project_required`). A project that is gone is the route's to find
/// (`project_gone`), since only it reads the project.
public func editAllowed(_ edit: ItemEdit, on item: Item, caps: ItemCaps) -> Bool {
    guard editAllowed(action: edit.action, on: item, caps: caps) else { return false }
    switch edit {
    case .time(let bucket, let startTime, let duration):
        if bucket == nil && startTime == nil && duration == nil { return false }
        if case .set? = startTime, bucket == .set(DayBucket.anytime.rawValue) || bucket == .clear {
            return false
        }
        if let duration, !caps.hasDuration || !(1...EditLimits.durationMax).contains(duration) {
            return false
        }
        return true
    case .repeats(let frequency, let days, let monthDay):
        guard caps.allowedFrequencies.contains(frequency) else { return false }
        if frequency == "custom" {
            // Refused, never cleaned: the server answers a body that isn't
            // already what the dialog would hold with `invalid`.
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
    case .project(let id, let name):
        return (id == nil) == (name == nil) && (id != nil || !caps.containerRequired)
    case .title, .notes, .priority, .timesPerDay, .reminder:
        return true
    }
}

/// The item after `edit`: lib/item-edit.ts `editPatch` applied, which is what
/// the web's store holds after the dialog saves the same field, and what the
/// server writes. The optimistic step, and the rebase's replay of a landed
/// edit.
/// - title: trimmed (the route's schema trims). One that trims to nothing is
///   refused there, so the item is unchanged.
/// - notes: `cleanNotes`, so blank or nil clears them.
/// - priority: set, or cleared by nil.
/// - timesPerDay: set, except that a habit with none stored already reads as
///   1 (the dialog seeds it so), so 1 there changes nothing.
/// - reminder: `reminderPatch`. No time clears the time and the words
///   together, whatever `anchor` says. A time sets it, and the words are
///   `anchor`'s when it has one, else the stored ones, trimmed either way,
///   and none when blank: a time sent alone keeps the words, as the dialog's
///   draft holds them and writes both.
/// - time: `timeEditPatch` (`editingTime`), the dialog's two passes.
/// - repeats: `repeatEditPatch` (`editingRepeat`), the dialog's save over the
///   keys sent, all three keys or none.
/// - project: `projectRefilePatch` (`editingProject`), the bulk Move to
///   project's write, with the release of a parked task.
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
    case .priority(let priority):
        next.priority = priority
    case .timesPerDay(let count):
        guard (item.timesPerDay ?? 1) != count else { return item }
        next.timesPerDay = count
    case .reminder(let time, let anchor):
        if let time {
            let words = jsTrim(anchor.map { $0.value ?? "" } ?? item.reminderAnchor ?? "")
            next.reminderTime = time
            next.reminderAnchor = words.isEmpty ? nil : words
        } else {
            next.reminderTime = nil
            next.reminderAnchor = nil
        }
    case .time(let bucket, let startTime, let duration):
        return editingTime(item, bucket: bucket, startTime: startTime, duration: duration)
    case .repeats(let frequency, let days, let monthDay):
        return editingRepeat(item, frequency: frequency, days: days, monthDay: monthDay)
    case .project(let id, let name):
        return editingProject(item, id: id, name: name)
    }
    return next
}

/// lib/item-edit.ts `timeEditPatch` applied to the item: the dialog's Time
/// chip as components/planner/item-dialog.tsx `commitEdit` saves it, over the
/// keys sent.
/// 1. The draft is seeded as `draftFromItem` seeds it: the stored bucket, or
///    "none"; the stored time, or ""; the stored length, or the type's
///    `defaultBlockMinutes`. Each sent key goes over its seed (.clear is
///    "none" or ""), and a key is changed only when it differs from its seed,
///    as the dialog marks it. None changed: the item as it was.
/// 2. The first pass, the mappers through lib/planner-store.ts `updateTask` /
///    `updateHabit`: the length, and the time ("" is none), which, when there
///    is one, files the stored bucket where it falls (`autoCorrectBucket`).
/// 3. The second pass, `planTimeEdit`, only when the bucket or the time
///    changed, compared against the item as stored, never as the first pass
///    left it:
///    - a dated task-like item: its bucket ("none" reads as Anytime, the
///      dialog's `effectiveBucket`) different from the stored one, or the
///      item not scheduled (nil reads as not): `scheduleTaskPatch`, which
///      schedules it, files the time, and takes it out of any project block
///      (`inProjectBlock` false and the stash cleared, as
///      `scheduleTaskPatch` writes them).
///      Else a time different from the stored one, compared raw (a stored ""
///      is not nil, as `!==` has it): the time alone, through `updateTask`'s
///      auto-correct against the bucket as the first pass left it, so a
///      project block is kept;
///    - an undated, scheduled task-like item: `UNSCHEDULE_TASK_PATCH`, back
///      to the braindump. The gate refuses every undated date-anchored item
///      first (`not_dated`), so this is ported only so the two can't drift;
///    - a habit with a bucket: when it or the time differs from the stored
///      one, `scheduleHabitPatch`, the bucket auto-corrected to the time (so
///      Evening under a 9:00 time files back in Morning);
///    - a habit with "none" and a stored bucket: both cleared.
/// The server merges the two passes into one write; the end row is the same.
private func editingTime(_ item: Item, bucket: ColumnWrite?, startTime: ColumnWrite?, duration: Int?) -> Item {
    // The seed, as draftFromItem has it.
    let seedBucket = item.timeBucket.flatMap { $0.isEmpty ? nil : $0 } ?? "none"
    let seedTime = item.startTime ?? ""
    let seedDuration = item.duration ?? caps(item.typeName).defaultBlockMinutes
    // The draft: each sent key over its seed.
    let draftBucket = bucket.map { $0.value ?? "none" } ?? seedBucket
    let draftTime = startTime.map { $0.value ?? "" } ?? seedTime
    let draftDuration = duration ?? seedDuration
    // The keys the dialog would mark changed.
    let bucketMoved = draftBucket != seedBucket
    let timeMoved = draftTime != seedTime
    let durationMoved = draftDuration != seedDuration
    guard bucketMoved || timeMoved || durationMoved else { return item }

    // `d.startTime || undefined`.
    let time: String? = draftTime.isEmpty ? nil : draftTime
    var next = item

    // Pass 1: the mappers, then updateTask's / updateHabit's auto-correct
    // against the stored bucket.
    if durationMoved { next.duration = draftDuration }
    if timeMoved {
        next.startTime = time
        if let time { next.timeBucket = autoCorrectBucket(time, item.timeBucket) }
    }

    // Pass 2: planTimeEdit, which runs only when something schedule-shaped
    // moved.
    guard bucketMoved || timeMoved else { return next }
    if !item.isHabit {
        if !(item.startDate ?? "").isEmpty {
            let effective = draftBucket == "none" ? DayBucket.anytime.rawValue : draftBucket
            if effective != item.timeBucket || !(item.isScheduled ?? false) {
                // scheduleTaskPatch.
                next.isScheduled = true
                next.timeBucket = autoCorrectBucket(time, effective) ?? effective
                next.startTime = time
                next.inProjectBlock = false
                next.previousStartTime = nil
                next.previousStartDate = nil
            } else if time != item.startTime {
                // `updateTask(id, { startTime })`, its auto-correct against
                // the bucket as pass 1 left it.
                next.startTime = time
                if let time { next.timeBucket = autoCorrectBucket(time, next.timeBucket) }
            }
        } else if item.isScheduled ?? false {
            // UNSCHEDULE_TASK_PATCH.
            next.isScheduled = false
            next.timeBucket = nil
            next.startTime = nil
            next.startDate = nil
        }
    } else if draftBucket != "none" {
        // scheduleHabit writes unconditionally, so the dialog guards it.
        if draftBucket != item.timeBucket || time != item.startTime {
            next.timeBucket = autoCorrectBucket(time, draftBucket) ?? draftBucket
            next.startTime = time
        }
    } else if item.timeBucket != nil {
        next.timeBucket = nil
        next.startTime = nil
    }
    return next
}

/// lib/item-edit.ts `repeatEditPatch` applied to the item: the dialog's Repeat
/// chip as its save writes it, over the keys sent.
/// 1. The draft is seeded as `draftFromItem` seeds it: the stored frequency,
///    or the type's `defaultFrequency` ("none" for a task, "daily" for a
///    habit); the stored days, or none; the stored day of the month, or the
///    1st (JavaScript's `|| 1`, so a stored 0 reads as 1 too). The sent keys
///    go over it.
/// 2. The three fields are one control: when the frequency, the days (as an
///    ordered list, as `JSON.stringify` compares them) and the day all equal
///    their seeds, nothing is written, so a stale day under another frequency
///    stays as it is.
/// 3. Else all three, as the dialog's `repeatPatch` writes them: the
///    frequency, kept as given on a habit (it always repeats) and none for
///    "none" on any other type; the days with "custom" alone; the day with
///    "monthly" alone. `isHabit` is the stored type's test, the one lib/db.ts
///    `updatesToRow` makes to choose its mapper. Nothing else moves: not the
///    date, the status, the streak or the done days, so an undated task that
///    starts repeating stays in the braindump, and a finished one-off stays
///    finished.
private func editingRepeat(_ item: Item, frequency: String, days: [Int]?, monthDay: Int?) -> Item {
    // The seed, as draftFromItem has it.
    let seedFrequency = item.repeatFrequency ?? caps(item.typeName).defaultFrequency
    let seedDays = item.repeatDays ?? []
    let seedMonthDay = item.repeatMonthDay.flatMap { $0 == 0 ? nil : $0 } ?? 1
    // The draft: the sent keys over the seed.
    let draftDays = days ?? seedDays
    let draftMonthDay = monthDay ?? seedMonthDay
    guard frequency != seedFrequency || draftDays != seedDays || draftMonthDay != seedMonthDay else {
        return item
    }
    // repeatPatch.
    var next = item
    next.repeatFrequency = item.isHabit || frequency != "none" ? frequency : nil
    next.repeatDays = frequency == "custom" ? draftDays : nil
    next.repeatMonthDay = frequency == "monthly" ? draftMonthDay : nil
    return next
}

/// lib/item-edit.ts `projectRefilePatch` applied to the item: the bulk Move to
/// project's write for one item (lib/planner-store.ts `setItemsProject`, which
/// imports it back), which the route writes for the Project chip.
/// 1. Unmoved when the item is already there by folded name
///    (`sameProjectName`) AND id: nothing. A folded match whose id is stale,
///    or missing (a text-only reference), still writes, which repairs the
///    link. The id is compared and stored lowercase, as Postgres writes it.
/// 2. Else the project's own name and id, both nil for No project. A habit's
///    "" is a name, so its clear always writes, as the web's does.
/// 3. The release (`projectBlockRelease`), only when the item is parked in a
///    block (`inProjectBlock`) and the folded name moves: out of the block,
///    its own time and day back from the stash, and the stash cleared, as
///    `moveTaskOutOfProjectBlock` writes it. The part of day stays the
///    block's (the stash holds none), and nothing else moves: not
///    `isScheduled`, the status, the streak or the done days. A same-name
///    link repair keeps it in its own block.
/// Nothing here reads the frozen `group` column.
private func editingProject(_ item: Item, id: String?, name: String?) -> Item {
    let projectId = id?.lowercased()
    let sameName = sameProjectName(item.project, name)
    guard !sameName || item.projectId != projectId else { return item }
    var next = item
    next.project = name
    next.projectId = projectId
    if item.inProjectBlock == true && !sameName {
        next.inProjectBlock = false
        next.startTime = item.previousStartTime
        next.startDate = item.previousStartDate
        next.previousStartTime = nil
        next.previousStartDate = nil
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
