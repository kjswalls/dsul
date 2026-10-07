import DsulCore
import Foundation

// What the item sheet says and offers, worked out apart from the views so the
// hosted tests can pin it. The rules are the web's, asked of DsulCore:
// lib/item-verbs.ts for the verbs (their gates, labels and details), the
// item-conversations table (Round 3) for which of them sit in the bar, and the
// item panel's property chips (components/planner/item-dialog.tsx, the
// "clearing field") for the chips, in its order, each shown only when set.
// The words are the web's own (DsulCore Cadence.swift, RowMoves.swift); the
// bar shortens a few, and that mapping is here. From part 2, the typed fields'
// rules too: what a keystroke may put in the title or the notes, and what
// leaving a field sends (DsulCore ItemEdit.swift, lib/item-edit.ts), and
// Delete's words (lib/item-verbs.ts `deleteConfirmTitle` and the registry's
// `form.deleteDescription`, both in DsulCore Registry.swift). From 2b, what
// the subtask field adds as it is typed in or pasted into (DsulCore
// BulkLines.swift, lib/bulk-add.ts, as the web's Subtasks section reads a
// paste), and the streak popover's words, the web's where it has them
// (DsulCore EditCopy.swift, lib/item-edit.ts `EDIT_COPY`). From 2c, which
// chips edit and how (`chipEditor`, `unsetProperties`, the "+ Add property"
// seed of the item panel's clearing field), and the Remind sheet's rules and
// words, the web's where it has them (item-dialog.tsx's Remind popover,
// `EDIT_COPY`). From 2d, the date's menu (`dateOptions`, `dateWords`) and the
// Time sheet's rules and words, the web's where it has them (item-dialog.tsx's
// date and Time chips, `DATE_SHORTCUTS`, its Duration rows; DsulCore
// DayBuckets.swift and EditCopy.swift, lib/time-bucket.ts and
// lib/item-edit.ts). From 2e, the Repeat chip's menu (`repeatChoices`,
// `repeatPick`) and the Repeat sheet's rules and words, the web's where it
// has them (item-dialog.tsx's Repeat chip; DsulCore Cadence.swift and
// EditCopy.swift, lib/planner-types.ts `REPEAT_FREQUENCY_LABELS` and
// `WEEKDAY_LABELS`, lib/item-edit.ts `repeatEditPatch` and `EDIT_COPY`).

/// One thing the sheet can do: the web's verbs it offers, plus Pause until
/// (the `pause` verb with a resume day, which the bar shows as its own slot).
/// Delete is the web's last verb and sits last behind ⋯, never in the bar.
enum SheetVerb: String, Hashable, Sendable, CaseIterable {
    case tick, skip, unskip, pause, pauseUntil, resume, nextDay, reschedule, delete

    /// The web verb whose gate answers for it.
    var verb: VerbID {
        switch self {
        case .tick: .tick
        case .skip: .skip
        case .unskip: .unskip
        case .pause, .pauseUntil: .pause
        case .resume: .resume
        case .nextDay: .nextDay
        case .reschedule: .reschedule
        case .delete: .delete
        }
    }

    /// The bar slot it fills. A verb and its opposite share one, so a Skip that
    /// turns into Unskip (or Pause into Resume) keeps its place and VoiceOver's
    /// focus, rather than being torn down and rebuilt.
    var slotID: String {
        switch self {
        case .tick: "tick"
        case .skip, .unskip: "skip"
        case .pause, .resume: "pause"
        case .pauseUntil: "pauseUntil"
        case .nextDay: "nextDay"
        case .reschedule: "reschedule"
        case .delete: "delete"
        }
    }
}

/// Where the sheet's verbs go: up to three in the bar, the rest of the pause
/// family and Delete behind ⋯, or, on a day a recurring item doesn't fall
/// on, a "Not due" line instead of the bar.
struct SheetVerbs: Hashable, Sendable {
    var bar: [SheetVerb]
    var menu: [SheetVerb]
    var notDue: Bool
}

/// Reschedule's menu: wall-clock today, the start of next week, or a day picked.
enum RescheduleChoice: Hashable, Sendable {
    case today, nextWeek, pick
}

/// A typed field of the item sheet, and so where a page's focus can be: the
/// title, the notes, and the new subtask's field (`SubtaskField`), whose text
/// is never an edit of anything stored: each line of it becomes a subtask.
enum SheetField: Hashable, Sendable {
    case title, notes, subtask
}

/// Which report of the last Return the subtask field has acted on. iOS may
/// report a Return typed in a vertical field as a line break in the text, as
/// `.onSubmit`, or as both, in either order. The title can take both, since
/// its `.onSubmit` only ends the edit; an add can't, so whichever report
/// comes first adds the subtask and this lets the other go
/// (`ItemSheetModel.subtaskEntry`, `.subtaskSubmit`).
enum SubtaskReturn: Hashable, Sendable {
    case none
    /// The line break added the subtask; an `.onSubmit` after it does nothing.
    case fromText
    /// `.onSubmit` added this title; a line break after it, on a line that
    /// cleans to this title or to nothing, does nothing.
    case fromSubmit(String)
}

/// What the subtask field does after a change or a submit.
struct SubtaskStep: Hashable, Sendable {
    /// The subtasks to add, in order.
    var titles: [String]
    /// What the field holds now.
    var draft: String
    /// Entry ends: focus goes, and the "Add a subtask" row comes back.
    var end: Bool
    /// A paste held more lines than one paste adds (`maxBulkItems`).
    var capped: Bool
    /// Which report of a Return has acted, for the next change or submit.
    var lastReturn: SubtaskReturn
}

/// The sheet's day picker's words: its title, the confirm button's verb
/// before the day ("Move to Thu, Oct 8"), and a note under the calendar.
struct DayPickWords: Hashable, Sendable {
    let title: String
    let confirmVerb: String
    let note: String?
}

/// The sheets an item's page opens over itself, nested in the item sheet,
/// never the planner's slot, which holds the item sheet and would close it to
/// open one: the day pickers (Reschedule, Pause until), from 2c the Remind
/// sheet, from 2d the Date chip's day picker and the Time sheet, and, from
/// 2e, the Repeat sheet. Here, apart from the views, since `chipEditor` names
/// one.
enum SheetEditor: Identifiable, Hashable, Sendable {
    /// A new day for the item (Reschedule's Pick a date…).
    case reschedule(UUID)
    /// The day the item's pause ends (Pause until…).
    case pauseUntil(UUID)
    /// The item's reminder (`ReminderSheet`).
    case reminder(UUID)
    /// The Date chip's Pick a date… (`DayPickSheet`, titled "Date").
    case pickDate(UUID)
    /// The Time sheet (`TimeSheet`).
    case time(UUID)
    /// The Repeat sheet (`RepeatSheet`): Custom days… or Monthly….
    case repeatDetail(UUID, RepeatDetail)

    var id: String {
        switch self {
        case .reschedule(let id): return "reschedule-" + id.uuidString
        case .pauseUntil(let id): return "pause-until-" + id.uuidString
        case .reminder(let id): return "reminder-" + id.uuidString
        case .pickDate(let id): return "pick-date-" + id.uuidString
        case .time(let id): return "time-" + id.uuidString
        case .repeatDetail(let id, let detail): return "repeat-" + detail.rawValue + "-" + id.uuidString
        }
    }
}

/// Which Repeat sheet: Custom days' keys or Monthly's days.
enum RepeatDetail: String, Hashable, Sendable {
    case custom, monthly
}

/// One row of the Repeat menu: the frequency stored and its word.
struct RepeatChoice: Identifiable, Hashable, Sendable {
    let frequency: String
    /// The web's word (`repeatFrequencyLabel`), with an ellipsis for a row
    /// that opens a sheet: "Monthly…", "Custom days…".
    let word: String

    var id: String { frequency }
}

/// What a pick in the Repeat menu does: write at once, or open the sheet.
enum RepeatPick: Hashable, Sendable {
    case write(ItemEdit)
    case open(RepeatDetail)
}

/// The Date chip's choices (Q3 a, Q4 a): today and tomorrow, wall-clock days
/// in the user's zone; the first day of next week by Week starts on; or a day
/// picked.
enum DateChoice: Hashable, Sendable {
    case today, tomorrow, nextWeek, pick
}

/// One entry of the Date menu: its words, its day under them, and its symbol.
struct DateOption: Hashable, Sendable, Identifiable {
    let choice: DateChoice
    /// "Today", "Tomorrow", "Next week", "Pick a date…".
    let word: String
    /// Its day as the web's shortcuts name it ("Oct 2", DsulCore `formatDay`);
    /// nil for Pick a date….
    let subtitle: String?
    let symbol: String

    var id: DateChoice { choice }
}

/// The Time sheet's draft: the part of day (nil: none stored), the specific
/// time ("HH:mm", nil: none) and the length in minutes.
struct TimeDraft: Hashable, Sendable {
    var bucket: DayBucket?
    var time: String?
    var duration: Int
}

/// How an editable chip edits: a menu whose pick writes at once, or a sheet
/// of its own, with Cancel and Done.
enum ChipEditor: Hashable, Sendable {
    case menu
    case sheet(SheetEditor)
}

/// Where VoiceOver goes once a chip's property has changed: that property's
/// chip, or Add property when the chip went.
enum ChipFocus: Hashable, Sendable {
    case chip(SheetChip.Kind)
    case seed
}

/// One row of the priority menu: the value stored (nil for none) and its word.
struct PriorityChoice: Identifiable, Hashable, Sendable {
    let raw: String?
    let word: String

    var id: String { word }
}

/// One property chip: what it says, its symbol, and what VoiceOver says.
struct SheetChip: Identifiable, Hashable, Sendable {
    /// The web panel's properties, in its order: priority leads, the When
    /// cluster follows, the containers come last.
    enum Kind: String, Hashable, Sendable {
        case priority, date, time, timesPerDay, repeats, reminder, project, routine, season
    }

    let kind: Kind
    let text: String
    /// Nil for the project chip, which wears its colour dot instead.
    let systemImage: String?
    let spoken: String

    var id: Kind { kind }
}

/// One day of the streak chip's week.
enum StreakDot: Hashable, Sendable {
    /// Ticked that day.
    case done
    /// Skipped that day.
    case skipped
    /// Today, not ticked or skipped yet.
    case today
    /// Missed, still to come, or a day the habit doesn't fall on: all drawn
    /// alike, as a neutral dot.
    case rest
}

/// The form the streak chip's popover takes: a popover, or a sheet.
enum StreakPopoverStyle: Hashable, Sendable {
    case popover, sheet
}

enum ItemSheetModel {
    // MARK: Verbs

    /// The bar and the ⋯ menu for `item` on `ctx`'s day, from the verbs the
    /// planner offers there (`SamplePlanner.offers`, so already narrowed to
    /// what the web's gates and the server allow), in this order:
    /// - paused today (wall-clock, in the user's zone): Resume alone;
    /// - a recurring item on a day it doesn't fall on: no bar, a "Not due"
    ///   line; Pause and Pause until move behind ⋯;
    /// - a habit: Skip or Unskip, Pause, Pause until (its tick is the title's
    ///   circle);
    /// - a one-off task-like item: the tick, Tomorrow, Reschedule;
    /// - a recurring task-like item: the tick, Skip or Unskip, Pause.
    /// ⋯ holds whatever of Pause, Pause until and Reschedule the bar doesn't:
    /// a series' Reschedule (lib/row-moves.ts `canReschedule`) moves its start,
    /// so it waits there rather than beside the day's verbs. Then Delete,
    /// last, in every case it is offered (paused and not due included), as
    /// the web declares it: a habit's ⋯ is Delete alone. A subtask is offered
    /// the tick and Delete, so it gets the tick and ⋯ → Delete. A server that
    /// doesn't take `delete` leaves ⋯ as part 1 had it.
    static func verbs(_ item: SampleItem, _ ctx: VerbContext, offered: [VerbID]) -> SheetVerbs {
        let has = Set(offered)
        let delete: [SheetVerb] = has.contains(.delete) ? [.delete] : []
        let pausedToday = DayString(ctx.todayStr).map { isPausedOn(item, on: $0, timeZone: ctx.timeZone) } ?? false
        if pausedToday {
            return SheetVerbs(bar: has.contains(.resume) ? [.resume] : [], menu: delete, notDue: false)
        }
        let pauseFamily: [SheetVerb] = has.contains(.pause) ? [.pause, .pauseUntil] : []
        let overflow: [SheetVerb] = pauseFamily + (has.contains(.reschedule) ? [.reschedule] : [])
        if item.recurs && ctx.occurrence == .absent {
            return SheetVerbs(bar: [], menu: overflow + delete, notDue: true)
        }

        let skipSlot: SheetVerb? = has.contains(.unskip) ? .unskip : (has.contains(.skip) ? .skip : nil)
        let tick: SheetVerb? = has.contains(.tick) ? .tick : nil
        let nextDay: SheetVerb? = has.contains(.nextDay) ? .nextDay : nil
        let reschedule: SheetVerb? = has.contains(.reschedule) ? .reschedule : nil
        let pause: SheetVerb? = has.contains(.pause) ? .pause : nil
        var bar: [SheetVerb]
        if item.isHabit {
            bar = [skipSlot].compactMap { $0 } + pauseFamily
        } else if !item.recurs {
            bar = [tick, nextDay, reschedule].compactMap { $0 }
        } else {
            bar = [tick, skipSlot, pause].compactMap { $0 }
        }
        bar = Array(bar.prefix(3))
        return SheetVerbs(bar: bar, menu: overflow.filter { !bar.contains($0) } + delete, notDue: false)
    }

    /// The web's `onDay` (item-context-menu.tsx): "today" in a label is only
    /// true on today, so off it the word goes ("Skip today" → "Skip").
    static func onDay(_ text: String, _ ctx: VerbContext) -> String {
        let suffix = " today"
        guard ctx.dateStr != ctx.todayStr, text.hasSuffix(suffix) else { return text }
        return String(text.dropLast(suffix.count))
    }

    /// The bar's short words for a verb. The web's own label (DsulCore
    /// `verbLabel`) where it fits, shortened where it doesn't: a one-off's
    /// "Mark done" is "Done", "Move to tomorrow" is "Tomorrow" ("Next day"
    /// when the carry lands later), and " today" goes off today.
    static func barLabel(_ verb: SheetVerb, _ item: SampleItem, _ ctx: VerbContext) -> String {
        switch verb {
        case .tick:
            if !item.recurs { return isDoneOn(item, on: ctx.dateStr) ? "Not done" : "Done" }
            return onDay(verbLabel(.tick, item, ctx), ctx)
        case .skip, .unskip:
            return onDay(verbLabel(verb.verb, item, ctx), ctx)
        case .pause:
            return "Pause"
        case .pauseUntil:
            return "Pause until"
        case .resume:
            return "Resume"
        case .nextDay:
            return verbLabel(.nextDay, item, ctx) == "Move to tomorrow" ? "Tomorrow" : "Next day"
        case .reschedule:
            return verbLabel(.reschedule, item, ctx)
        case .delete:
            return verbLabel(.delete, item, ctx)
        }
    }

    /// What VoiceOver calls the verb: the web's full label (off today without
    /// " today"), which says more than the bar has room for ("Mark done").
    static func spokenLabel(_ verb: SheetVerb, _ item: SampleItem, _ ctx: VerbContext) -> String {
        switch verb {
        case .tick, .skip, .unskip, .nextDay:
            return onDay(verbLabel(verb.verb, item, ctx), ctx)
        case .pauseUntil:
            return "Pause until a day"
        case .pause, .resume, .reschedule, .delete:
            return barLabel(verb, item, ctx)
        }
    }

    /// The carry's landing day ("Fri, Oct 2"), the web's `detail`, which the
    /// bar leaves to VoiceOver. Nil for every other verb.
    static func spokenValue(_ verb: SheetVerb, _ item: SampleItem, _ ctx: VerbContext) -> String? {
        guard verb == .nextDay else { return nil }
        return verbDetail(.nextDay, item, ctx)
    }

    /// The ⋯ menu's words. It only ever holds Pause, Pause until, a series'
    /// Reschedule and Delete, which ⋯ names after the type
    /// (`deleteMenuTitle`); the rest are named for completeness.
    static func menuTitle(_ verb: SheetVerb) -> String {
        switch verb {
        case .pause: "Pause"
        case .pauseUntil: "Pause until\u{2026}"
        case .resume: "Resume"
        case .tick: "Done"
        case .skip: "Skip"
        case .unskip: "Unskip"
        case .nextDay: "Tomorrow"
        case .reschedule: "Reschedule"
        case .delete: "Delete"
        }
    }

    /// The verb's SF Symbol.
    static func symbol(_ verb: SheetVerb, _ item: SampleItem, _ ctx: VerbContext) -> String {
        switch verb {
        case .tick: isDoneOn(item, on: ctx.dateStr) ? "arrow.uturn.backward" : "checkmark"
        case .skip: "forward.end"
        case .unskip: "arrow.uturn.backward"
        case .pause: "pause"
        case .pauseUntil: "calendar.badge.clock"
        case .resume: "play"
        case .nextDay: "arrow.right"
        case .reschedule: "calendar"
        case .delete: "trash"
        }
    }

    /// "For Thu, Oct 8" above the bar when the bar holds a per-day verb (the
    /// tick, Skip, Unskip) that acts on a day other than today, which the
    /// bar's words no longer say. Asked of the bar, not of what is offered: a
    /// habit's tick is the title's circle, never a slot, and Pause, Pause
    /// until and Resume act on today whatever the day, so a bar of those
    /// alone gets no caption. Nil on today and for a one-off (whose tick has
    /// no day).
    static func dayCaption(_ item: SampleItem, _ ctx: VerbContext, bar: [SheetVerb]) -> String? {
        guard ctx.dateStr != ctx.todayStr, item.recurs,
              bar.contains(where: { $0 == .tick || $0 == .skip || $0 == .unskip })
        else { return nil }
        return "For " + formatTargetDay(ctx.dateStr)
    }

    /// "For Wed, Sep 30" under the title when its circle ticks a day other
    /// than today and the bar doesn't hold the tick, so the bar's caption
    /// doesn't speak for it: a habit, whose tick is only ever the circle, or
    /// an item whose bar has given way to Resume. Nil on today, for a one-off
    /// and with no circle.
    static func titleDayNote(_ item: SampleItem, _ ctx: VerbContext, offered: [VerbID],
                             bar: [SheetVerb]) -> String? {
        guard ctx.dateStr != ctx.todayStr, item.recurs, offered.contains(.tick), !bar.contains(.tick)
        else { return nil }
        return "For " + formatTargetDay(ctx.dateStr)
    }

    /// A counted habit's tally on the day under its title, "1/3", so a tap
    /// on the circle that counts one without finishing the day still shows.
    /// The web panel's count (item-dialog.tsx, beside its −/+ stepper): the
    /// day's stored count, or the target once the day is done with none
    /// stored. Nil unless the type keeps a per-day tally and the item wants
    /// more than one a day.
    static func tally(_ item: SampleItem, on dateStr: String) -> String? {
        guard caps(item.typeName).dailyCounts, let target = item.timesPerDay, target > 1 else { return nil }
        let raw = item.dailyCounts[dateStr] ?? 0
        let count = item.completedDates.contains(dateStr) && raw == 0 ? target : raw
        return "\(count)/\(target)"
    }

    /// The line under the title: the tally, then the day the circle ticks
    /// ("1/3 · For Wed, Sep 30"), whichever there are. Under the title
    /// rather than beside it, since a title field takes the full width. Nil
    /// with neither.
    static func titleNote(tally: String?, dayNote: String?) -> String? {
        let parts = [tally, dayNote].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }

    /// The line in place of the bar on a day the item doesn't fall on.
    static func notDueLine(_ ctx: VerbContext) -> String {
        if ctx.dateStr == ctx.todayStr { return "Not due today" }
        return "Not due " + formatTargetDay(ctx.dateStr)
    }

    // MARK: Delete

    /// Delete's entry in ⋯: "Delete task", the type's noun lower-cased as
    /// JavaScript does (`jsLowercased`), a custom type's own ("Delete side
    /// quest"). No ellipsis: it only asks to confirm, it opens nothing to
    /// pick from.
    static func deleteMenuTitle(typeLabel: String) -> String {
        return "Delete " + jsLowercased(typeLabel)
    }

    /// The confirm's title: lib/item-verbs.ts `deleteConfirmTitle`, "Delete
    /// task?", which the web's own prompt uses (DsulCore's port, which
    /// caps.json pins).
    static func deleteConfirmTitle(typeLabel: String) -> String {
        return DsulCore.deleteConfirmTitle(typeLabel)
    }

    /// The confirm's message: the registry's `form.deleteDescription` for the
    /// type (`ItemCaps.deleteDescription`, which says the item goes to the
    /// Trash for 30 days), then, when the delete takes subtasks with it,
    /// one sentence saying so ("Its 2 subtasks go with it."): the phone has no
    /// undo, and the web's prompt never mentions them. `childCount` is
    /// `cascadeCount`.
    static func deleteConfirmMessage(_ item: SampleItem, _ caps: ItemCaps, childCount: Int) -> String {
        let text = caps.deleteDescription(item.title)
        if childCount == 1 { return text + " Its subtask goes with it." }
        if childCount > 1 { return text + " Its \(childCount) subtasks go with it." }
        return text
    }

    /// How many subtasks a delete of `item` takes with it: deleteTask's
    /// cascade (DsulCore `isDeletedWith`), none for a habit, whose delete
    /// never cascades.
    static func cascadeCount(_ item: SampleItem, in items: [SampleItem]) -> Int {
        guard !item.isHabit else { return 0 }
        return items.filter { isDeletedWith($0, parent: item.id) }.count
    }

    /// What VoiceOver hears once a delete has gone through: "Task deleted".
    /// No banner: the row going is what the eye sees.
    static func deletedAnnouncement(typeLabel: String) -> String {
        return typeLabel + " deleted"
    }

    // MARK: Typed fields

    /// The notes' placeholder, where an item has none (the web panel's
    /// "Notes", item-dialog.tsx), so VoiceOver has something to land on.
    static let notesPlaceholder = "Notes"

    /// What the notes, and their placeholder, do when activated.
    static let notesHint = "Edits the notes"

    /// Under a title or notes stored longer than one request may carry
    /// (`EditLimits.outerTitle`, `.outerNotes`), which are shown, not edited.
    static let tooLongNote = "Too long to edit on the phone."

    /// Is `stored` too long for the phone to send back as `kind`? Then the
    /// field stays text, with `tooLongNote` under it. Never for the subtask
    /// field, which starts empty and sends only new text.
    static func tooLongToEdit(_ stored: String?, kind: SheetField) -> Bool {
        let length = stored?.utf16.count ?? 0
        switch kind {
        case .title: return length > EditLimits.outerTitle
        case .notes: return length > EditLimits.outerNotes
        case .subtask: return false
        }
    }

    /// What the title field holds after a change from `previous` to `next`,
    /// asked only of the text put in (the change's middle, between what the
    /// two share at each end), so what was already there is never rewritten:
    /// - an insertion whose only line break is its last character is a typed
    ///   Return (an autocorrection may arrive with it): the break goes, and
    ///   the title commits;
    /// - any other inserted line break (a paste) becomes a space, as the web's
    ///   one-line input reads it;
    /// - growth past `limit` (UTF-16 units: `growthLimit` of the stored
    ///   title) is cut from the insertion, by whole characters.
    /// A line break already in the title (one the web stored) stays until a
    /// change is sent, where `cleanTitle` turns it into a space. Asked only
    /// while the field has focus, so a fill from the planner is never read
    /// as typing.
    static func titleEntry(previous: String, next: String, limit: Int) -> (draft: String, commit: Bool) {
        let change = splice(previous, next)
        var typed = change.inserted
        var commit = false
        if let last = typed.last, last.isNewline, !typed.dropLast().contains(where: \.isNewline) {
            typed.removeLast()
            commit = true
        }
        typed = String(typed.map { $0.isNewline ? Character(" ") : $0 })
        return (fitted(change.head, typed, change.tail, limit: limit), commit)
    }

    /// What the notes field holds after a change from `previous` to `next`:
    /// `next`, with growth past `limit` (`growthLimit` of the stored notes)
    /// cut from what was put in. Return is a line break there, kept.
    static func notesEntry(previous: String, next: String, limit: Int) -> String {
        guard next.utf16.count > limit else { return next }
        let change = splice(previous, next)
        return fitted(change.head, change.inserted, change.tail, limit: limit)
    }

    /// What leaving a typed field sends, if anything (`kind` says which):
    /// - nothing while the draft is still the seed, so focusing a field and
    ///   leaving it never writes, whatever is stored there: a 700-character
    ///   title, notes ending in a line break, a title the web stored with one;
    /// - otherwise the draft cleaned (`cleanTitle`, `cleanNotes`) within
    ///   `growthLimit` of what is stored, unless the result is what is
    ///   stored. The limit is the stored text's, as the route measures it,
    ///   never the seed's: after a commit that kept focus (the scene going
    ///   inactive) the seed is the raw draft, which may be longer than the
    ///   trimmed text stored.
    /// A title that cleans to nothing sends nothing: the server refuses a
    /// blank title, and the field shows the stored one again. Notes that clean
    /// to nothing clear them. The caller sends the edit through the planner,
    /// which gates it again, and then takes the draft as its new seed, so the
    /// next trigger (a scene change, then `.onDisappear`) sends nothing more.
    /// Never an edit for the subtask field: its text is a new item, added
    /// through the planner's `addSubtask`, never a change to one stored.
    static func commit(draft: String, seed: String, stored: String?, kind: SheetField) -> ItemEdit? {
        guard draft != seed else { return nil }
        switch kind {
        case .title:
            guard let title = cleanTitle(draft, limit: growthLimit(cap: EditLimits.title, stored: stored)),
                  title != stored
            else { return nil }
            return ItemEdit.title(title)
        case .notes:
            let notes = cleanNotes(draft, limit: growthLimit(cap: EditLimits.notes, stored: stored))
            guard notes != stored else { return nil }
            return ItemEdit.notes(notes)
        case .subtask:
            return nil
        }
    }

    /// `next` as `previous` with one run replaced: what the two share at the
    /// front, what was put in, and what they share at the end. Compared by
    /// Character, so an emoji or an accent is never split.
    private static func splice(_ previous: String, _ next: String) -> (head: String, inserted: String, tail: String) {
        let old = Array(previous)
        let new = Array(next)
        var front = 0
        while front < old.count, front < new.count, old[front] == new[front] {
            front += 1
        }
        var back = 0
        while back < old.count - front, back < new.count - front,
              old[old.count - 1 - back] == new[new.count - 1 - back] {
            back += 1
        }
        let end = new.count - back
        return (String(new[..<front]), String(new[front..<end]), String(new[end...]))
    }

    /// `head + inserted + tail`, `inserted` cut (`clampUTF16`) so the whole is
    /// at most `limit` UTF-16 units. What was already there is never cut.
    private static func fitted(_ head: String, _ inserted: String, _ tail: String, limit: Int) -> String {
        let room = max(0, limit - head.utf16.count - tail.utf16.count)
        return head + clampUTF16(inserted, room) + tail
    }

    // MARK: Add a subtask

    /// The Subtasks section's last row, after a plus, which swaps in the
    /// subtask field.
    static let subtaskRowTitle = "Add a subtask"

    /// The subtask field's name to VoiceOver.
    static let subtaskFieldLabel = "New subtask"

    /// The subtask field's placeholder: the web's ("Add subtask…",
    /// `EDIT_COPY.subtaskPlaceholder`).
    static let subtaskPlaceholder = EditCopy.subtaskPlaceholder

    /// What the subtask field does after a change from `previous` to `next`,
    /// asked, as `titleEntry` is, only of the text put in (`splice`), and only
    /// while the field has focus, so the page clearing it is never typing:
    /// 1. **Nothing put in**: a deletion, or the field's own write of a draft
    ///    this answered ("Eggs\n" → ""). The text as it is, and `lastReturn`
    ///    kept: the write that follows a typed Return must not reset it, or
    ///    the `.onSubmit` after it would read an empty field and end entry.
    /// 2. **An insertion whose only line break is its last character**: a
    ///    typed Return (an autocorrection may arrive with it), or one line
    ///    pasted with a break at its end, which is added at once, as a typed
    ///    Return would be (the web's one-line input keeps that line). The
    ///    whole line, the break gone, is the subtask (`cleanTitle` within
    ///    `EditLimits.newTitle`), and the field empties. A Return `.onSubmit`
    ///    has already taken, on a line that cleans to its title or to
    ///    nothing, adds nothing; one on a blank line ends entry.
    /// 3. **A pasted list** (`isBulkPaste`): one subtask per non-empty line,
    ///    list markers stripped, at most `maxBulkItems` (`capped` past it,
    ///    lib/bulk-add.ts `splitBulkLinesWithMeta`), each cut to 500 UTF-16
    ///    units and trimmed. What was typed before stays in the field, where
    ///    the web's clears it.
    /// 4. **Anything else** is typing: a pasted line break becomes a space,
    ///    and growth past `EditLimits.newTitle` is cut from what was put in.
    static func subtaskEntry(previous: String, next: String, lastReturn: SubtaskReturn) -> SubtaskStep {
        let change = splice(previous, next)
        let inserted = change.inserted
        if inserted.isEmpty {
            return SubtaskStep(titles: [], draft: next, end: false, capped: false, lastReturn: lastReturn)
        }
        if let last = inserted.last, last.isNewline, !inserted.dropLast().contains(where: \.isNewline) {
            let line = change.head + String(inserted.dropLast()) + change.tail
            let cleaned = cleanTitle(line, limit: EditLimits.newTitle)
            if case .fromSubmit(let taken) = lastReturn, cleaned == nil || cleaned == taken {
                return SubtaskStep(titles: [], draft: "", end: false, capped: false, lastReturn: .none)
            }
            guard let title = cleaned else {
                return SubtaskStep(titles: [], draft: "", end: true, capped: false, lastReturn: .none)
            }
            return SubtaskStep(titles: [title], draft: "", end: false, capped: false, lastReturn: .fromText)
        }
        if isBulkPaste(inserted) {
            let split = splitBulkLinesWithMeta(inserted)
            let titles = split.titles.compactMap { cleanTitle($0, limit: EditLimits.newTitle) }
            return SubtaskStep(titles: titles, draft: change.head + change.tail, end: false,
                               capped: split.truncated, lastReturn: .none)
        }
        let typed = String(inserted.map { $0.isNewline ? Character(" ") : $0 })
        return SubtaskStep(titles: [], draft: fitted(change.head, typed, change.tail, limit: EditLimits.newTitle),
                           end: false, capped: false, lastReturn: .none)
    }

    /// What the subtask field does on `.onSubmit`, with `draft` as it stands:
    /// - the line break already added this Return (`.fromText`): nothing,
    ///   and the next Return is new;
    /// - a draft that cleans to a title: that subtask, and the field empties;
    ///   a line break arriving after this, on that line or a blank one, adds
    ///   nothing (`subtaskEntry`);
    /// - a blank draft: entry ends.
    static func subtaskSubmit(draft: String, lastReturn: SubtaskReturn) -> SubtaskStep {
        if lastReturn == .fromText {
            return SubtaskStep(titles: [], draft: draft, end: false, capped: false, lastReturn: .none)
        }
        if let title = cleanTitle(draft, limit: EditLimits.newTitle) {
            return SubtaskStep(titles: [title], draft: "", end: false, capped: false, lastReturn: .fromSubmit(title))
        }
        return SubtaskStep(titles: [], draft: "", end: true, capped: false, lastReturn: .none)
    }

    /// What VoiceOver hears once subtasks are added: "Added Eggs", or "Added
    /// 3 subtasks" for a paste. The new rows land above the field, away from
    /// VoiceOver's focus, so this is all that says so. Nil when none was.
    static func subtaskAddedAnnouncement(_ titles: [String]) -> String? {
        switch titles.count {
        case 0: return nil
        case 1: return "Added " + titles[0]
        default: return "Added \(titles.count) subtasks"
        }
    }

    // MARK: The day picker

    /// Reschedule's picker is titled with the bar's own word for the verb:
    /// "Schedule" for an undated item, which then is scheduled for the day
    /// picked, else "Reschedule", which moves it there.
    static func rescheduleWords(_ item: SampleItem, _ ctx: VerbContext) -> DayPickWords {
        let title = barLabel(.reschedule, item, ctx)
        return DayPickWords(title: title, confirmVerb: title == "Reschedule" ? "Move to" : "Schedule for", note: nil)
    }

    // MARK: The date

    /// The Date chip's name, the web's (item-dialog.tsx's date chip and its
    /// seed entry), which titles its Pick a date… picker.
    static let dateTitle = "Date"

    /// The Date menu, the chip's and Add property's Date ▸: Today, Tomorrow
    /// and Next week, the web's `DATE_SHORTCUTS`, each with its day under it
    /// as the web's shortcuts name it ("Oct 2", DsulCore `formatDay`), then
    /// Pick a date…. Today and Tomorrow are wall-clock days in the user's zone
    /// (`today`); Next week is the first day of next week by Week starts on
    /// (`nextWeekStart`, Q4 a), as the bar's Reschedule means it. On the
    /// week's last day Tomorrow and Next week are the same day and say so:
    /// both stay, as the web lists all three every day, and a menu that lost
    /// a row on one weekday would move the rows under the finger. No
    /// checkmark (the web's shortcuts have none), and no No date (Q3 a).
    static func dateOptions(today: DayString, nextWeekStart: DayString) -> [DateOption] {
        return [
            DateOption(choice: .today, word: "Today", subtitle: formatDay(today.description), symbol: "sun.max"),
            DateOption(choice: .tomorrow, word: "Tomorrow", subtitle: formatDay(today.adding(days: 1).description),
                       symbol: "sunrise"),
            DateOption(choice: .nextWeek, word: "Next week", subtitle: formatDay(nextWeekStart.description),
                       symbol: "calendar.badge.plus"),
            DateOption(choice: .pick, word: "Pick a date\u{2026}", subtitle: nil, symbol: "calendar"),
        ]
    }

    /// The day a Date menu choice moves the item to; nil for Pick a date…,
    /// which asks for one.
    static func dateTarget(_ choice: DateChoice, today: DayString, nextWeekStart: DayString) -> DayString? {
        switch choice {
        case .today: return today
        case .tomorrow: return today.adding(days: 1)
        case .nextWeek: return nextWeekStart
        case .pick: return nil
        }
    }

    /// Pick a date…'s picker: titled "Date", its button the bar's own verb
    /// for the move (`rescheduleWords`): "Move to Thu, Oct 8", or "Schedule
    /// for Thu, Oct 8" on an undated item, which the pick schedules.
    static func dateWords(_ item: SampleItem, _ ctx: VerbContext) -> DayPickWords {
        return DayPickWords(title: dateTitle, confirmVerb: rescheduleWords(item, ctx).confirmVerb, note: nil)
    }

    /// Pause until's picker. The day picked is the day the item is back, not
    /// its last day off, which the button alone ("Pause until Thu, Oct 8")
    /// leaves open; the note is the web's own (item-dialog.tsx's picker).
    static let pauseUntilWords = DayPickWords(
        title: "Pause until", confirmVerb: "Pause until",
        note: "It comes back on the day you pick, on its own. Nothing is lost meanwhile. "
            + "Your streak and history stay exactly as they are.")

    /// What the banner says when Pause until's day is no longer after today:
    /// the picker was left open across midnight. A pause has to end after
    /// today, so nothing is written. Nil while the day may still be picked.
    static func pauseUntilRefusal(_ until: DayString, today: DayString) -> String? {
        guard until <= today else { return nil }
        return "That day is no longer after today, so nothing was paused."
    }

    // MARK: Header

    /// "Habit · Morning routine": the type's noun (`typeLabel`, the
    /// registry's label with the payload's custom labels applied:
    /// `SamplePlanner.caps(for:)`) and the first routine holding the item. The
    /// view upper-cases it, so VoiceOver reads the words as written.
    static func eyebrow(typeLabel: String, routineNames: [String]) -> String {
        guard let routine = routineNames.first else { return typeLabel }
        return typeLabel + " \u{00B7} " + routine
    }

    /// The item's own pause, as the web's paused note words it ("Paused until
    /// Oct 8", the resume day by lib/active.ts `formatDay`; "Paused" with no
    /// end). Nil unless paused today in the user's zone. A routine's or a
    /// season's hold is not shown in part 1.
    static func pauseNote(_ item: SampleItem, today todayStr: String, timeZone: String) -> String? {
        guard let today = DayString(todayStr), isPausedOn(item, on: today, timeZone: timeZone) else { return nil }
        if let until = item.pausedUntil, !until.isEmpty { return "Paused until " + formatDay(until) }
        return "Paused"
    }

    // MARK: Chips

    /// The chips, in the web panel's order, each only when set: priority |
    /// date, time, times per day, repeat, reminder | project, routines,
    /// seasons. The streak chip (habits) is drawn ahead of these by the view.
    /// Each asks the registry what the type carries, never the type's name.
    static func chips(_ item: SampleItem, today: DayString, timeFormat: TimeFormat,
                      routineNames: [String], seasonNames: [String]) -> [SheetChip] {
        let typeCaps = caps(item.typeName)
        var out: [SheetChip] = []

        if typeCaps.hasPriority, let word = priorityWord(item.priority) {
            out.append(SheetChip(kind: .priority, text: word, systemImage: "flag", spoken: "\(word) priority"))
        }
        if typeCaps.dateAnchored, let start = item.startDate, let day = DayString(start) {
            let text = relativeDay(day, today: today)
            out.append(SheetChip(kind: .date, text: text, systemImage: "calendar", spoken: "Date: \(text)"))
        }
        if let time = timeText(item, dateAnchored: typeCaps.dateAnchored, timeFormat: timeFormat) {
            out.append(SheetChip(kind: .time, text: time, systemImage: "clock", spoken: "Time: " + spokenRange(time)))
        }
        if typeCaps.dailyCounts, let times = item.timesPerDay, times > 1 {
            out.append(SheetChip(kind: .timesPerDay, text: "\(times)\u{00D7}", systemImage: "arrow.2.squarepath",
                                 spoken: timesSpoken(times)))
        }
        if item.recurs {
            let cadence = cadenceLabel(item)
            out.append(SheetChip(kind: .repeats, text: cadence, systemImage: "repeat", spoken: "Repeats: \(cadence)"))
        }
        if let reminder = reminderText(item, timeFormat: timeFormat) {
            out.append(SheetChip(kind: .reminder, text: reminder, systemImage: "bell",
                                 spoken: "Reminder: " + reminder.replacingOccurrences(of: " \u{00B7} ", with: ", ")))
        }
        if let project = item.project, !project.isEmpty {
            out.append(SheetChip(kind: .project, text: project, systemImage: nil, spoken: "Project: \(project)"))
        }
        if let summary = membershipSummary(routineNames) {
            out.append(SheetChip(kind: .routine, text: summary, systemImage: "checklist",
                                 spoken: spokenMembership(routineNames, one: "Routine", many: "Routines")))
        }
        if let summary = membershipSummary(seasonNames) {
            out.append(SheetChip(kind: .season, text: summary, systemImage: "leaf",
                                 spoken: spokenMembership(seasonNames, one: "Season", many: "Seasons")))
        }
        return out
    }

    /// packages/types `PrioritySchema`'s three, as the panel's chip names them.
    private static func priorityWord(_ raw: String?) -> String? {
        switch raw {
        case "high": "High"
        case "medium": "Medium"
        case "low": "Low"
        default: nil
        }
    }

    /// "Today", "Tomorrow", "Yesterday", else "Thu, Oct 8" (`formatTargetDay`).
    static func relativeDay(_ day: DayString, today: DayString) -> String {
        if day == today { return "Today" }
        if day == today.adding(days: 1) { return "Tomorrow" }
        if day == today.adding(days: -1) { return "Yesterday" }
        return formatTargetDay(day.description)
    }

    /// The Time chip: start to end ("9:00–11:00 am", the clock words of
    /// lib/reminders/copy.ts `formatCueTime` in the user's 12h or 24h), the
    /// end being the start plus the block's length; with no time, the bucket
    /// ("Evening"), but never "Anytime", which says nothing. Shown only where
    /// the web panel shows it: always for a type with no date, else once dated.
    static func timeText(_ item: SampleItem, dateAnchored: Bool, timeFormat: TimeFormat) -> String? {
        if dateAnchored && (item.startDate ?? "").isEmpty { return nil }
        if let start = item.startMin {
            return timeRange(startMin: start, durationMin: item.durationMin, timeFormat: timeFormat)
        }
        guard let bucket = item.bucket, bucket != .anytime else { return nil }
        return bucket.label
    }

    /// "9:00–11:00 am", or "11:00 am–1:00 pm" across noon; "09:00–11:00" on
    /// the 24-hour clock. The start alone for a block with no length.
    static func timeRange(startMin: Int, durationMin: Int, timeFormat: TimeFormat) -> String {
        let start = formatCueTime(minutesToTime(startMin), timeFormat: timeFormat)
        guard durationMin > 0 else { return start }
        let end = formatCueTime(minutesToTime((startMin + durationMin) % (24 * 60)), timeFormat: timeFormat)
        let startParts = start.split(separator: " ")
        let endParts = end.split(separator: " ")
        if startParts.count == 2, endParts.count == 2, startParts[1] == endParts[1] {
            return "\(startParts[0])\u{2013}\(end)"
        }
        return "\(start)\u{2013}\(end)"
    }

    /// A range as VoiceOver should say it: "9:00 to 11:00 am".
    static func spokenRange(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{2013}", with: " to ")
    }

    /// The Remind chip: "After I pour my coffee · 8:00 am", or the time alone
    /// with no cue words. Only for what the registry lets remind
    /// (`isRemindable`: not a subtask) and only with a time set.
    static func reminderText(_ item: SampleItem, timeFormat: TimeFormat) -> String? {
        guard isRemindable(item), let time = item.reminderTime, !time.isEmpty else { return nil }
        let clock = formatCueTime(time, timeFormat: timeFormat)
        let anchor = (item.reminderAnchor ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return anchor.isEmpty ? clock : "After \(anchor) \u{00B7} \(clock)"
    }

    /// "Routine: Wind down", or "Routines: Wind down and 1 more".
    private static func spokenMembership(_ names: [String], one: String, many: String) -> String {
        guard let first = names.first else { return "" }
        if names.count == 1 { return "\(one): \(first)" }
        return "\(many): \(first) and \(names.count - 1) more"
    }

    // MARK: Editable chips

    /// How the chip of `kind` edits `item`, or nil when it is read-only (and
    /// drawn without a chevron). It edits when `canEdit` takes its action,
    /// which is the planner's `canEdit`: the server lists the action in
    /// `writes`, and DsulCore's `editAllowed` takes it for the item (a habit
    /// has no priority, a task no count, a subtask no reminder, no time and
    /// no repeat, an undated task no time). No type gate lives here:
    /// - priority and times per day: a menu, whose pick writes at once;
    /// - the date: a menu (`dateOptions`) whose pick moves the item at once,
    ///   offered exactly where the Reschedule verb is (`offered`, the page's
    ///   `offeredVerbs`, contains `.reschedule`; Q3 a): no finished item, no
    ///   project block, no habit, no subtask. The verb's gate, not the bar's
    ///   slots: a paused task is offered Reschedule (`canReschedule` has no
    ///   pause test) though its bar shows Resume alone, so its date chip
    ///   edits, as the web's date chip does;
    /// - the repeat: a menu (`repeatChoices`) whose No repeat, Daily,
    ///   Weekdays and Weekends write at once and whose Monthly… and Custom
    ///   days… open the Repeat sheet (`repeatPick`);
    /// - the reminder and the time: their sheets;
    /// - every other chip: read-only, until 2f.
    static func chipEditor(_ kind: SheetChip.Kind, _ item: SampleItem, offered: [VerbID],
                           canEdit: (String) -> Bool) -> ChipEditor? {
        switch kind {
        case .priority:
            return canEdit("priority") ? .menu : nil
        case .date:
            return offered.contains(.reschedule) ? .menu : nil
        case .time:
            return canEdit("time") ? .sheet(.time(item.id)) : nil
        case .timesPerDay:
            return canEdit("timesPerDay") ? .menu : nil
        case .repeats:
            return canEdit("repeat") ? .menu : nil
        case .reminder:
            return canEdit("reminder") ? .sheet(.reminder(item.id)) : nil
        case .project, .routine, .season:
            return nil
        }
    }

    /// What "+ Add property" offers for `item`, in chip order: each of
    /// priority, the date, the time, times per day, the repeat and the
    /// reminder that `shown` (`chips(…)`'s answer) has no chip for, and whose
    /// chip would edit (`chipEditor`), the web seed's order. Unset means no
    /// chip, so a habit counted once a day (part 1 shows its count only above
    /// 1) is offered Times per day, a stored priority the chips can't name is
    /// offered Priority, an undated task is offered Date (and no Time…: it has
    /// no day for a time yet), an Anytime item is offered Time… (part 1 draws
    /// no chip for Anytime), and a one-off task is offered Repeat (a recurring
    /// item, and every habit, draws its chip). Never drawn as dimmed
    /// placeholder chips (Q2 a).
    static func unsetProperties(_ item: SampleItem, shown: [SheetChip], offered: [VerbID],
                                canEdit: (String) -> Bool) -> [SheetChip.Kind] {
        let drawn = Set(shown.map(\.kind))
        var out: [SheetChip.Kind] = []
        let kinds: [SheetChip.Kind] = [.priority, .date, .time, .timesPerDay, .repeats, .reminder]
        for kind in kinds where !drawn.contains(kind) {
            if chipEditor(kind, item, offered: offered, canEdit: canEdit) != nil { out.append(kind) }
        }
        return out
    }

    /// Where VoiceOver goes once `kind`'s property has changed (a pick, the
    /// Remind sheet, the Time sheet or Pick a date… closing): its chip while
    /// the page, as drawn after the change (`shown`), has one, else Add
    /// property, where the emptied property went (Anytime takes the time
    /// chip). Left alone, iOS hands focus back to the menu's or the sheet's
    /// source, which may have gone.
    static func voiceOverTarget(after kind: SheetChip.Kind, shown: [SheetChip]) -> ChipFocus {
        return shown.contains(where: { $0.kind == kind }) ? .chip(kind) : .seed
    }

    /// The chip whose property a closing sheet edited on page `id`, so
    /// VoiceOver goes there (`voiceOverTarget`): the Remind sheet's reminder,
    /// Pick a date…'s date, the Time sheet's time, the Repeat sheet's repeat.
    /// Nil for any other editor (the bar's Reschedule and Pause until move no
    /// VoiceOver focus), and for another page's item.
    static func chipKind(closing editor: SheetEditor, on id: UUID) -> SheetChip.Kind? {
        switch editor {
        case .reminder(let itemID): return itemID == id ? .reminder : nil
        case .pickDate(let itemID): return itemID == id ? .date : nil
        case .time(let itemID): return itemID == id ? .time : nil
        case .repeatDetail(let itemID, _): return itemID == id ? .repeats : nil
        case .reschedule, .pauseUntil: return nil
        }
    }

    /// An editable chip's hint to VoiceOver, after its words and "button":
    /// what a tap changes. Nil for a chip that doesn't edit.
    static func chipHint(_ kind: SheetChip.Kind) -> String? {
        switch kind {
        case .priority: return "Changes the priority"
        case .date: return "Changes the date"
        case .time: return "Changes the time"
        case .timesPerDay: return "Changes how many times a day"
        case .repeats: return "Changes how it repeats"
        case .reminder: return "Changes the reminder"
        case .project, .routine, .season: return nil
        }
    }

    // MARK: Add property

    /// The words beside the seed's plus: "Add property" while the row has
    /// nothing else (no chip, no streak chip), as the web's seed reads; nil,
    /// a bare plus, once it has, since the chips beside it say what it is for
    /// (item-dialog.tsx's clearing field).
    static func seedLabel(rowHasOthers: Bool) -> String? {
        return rowHasOthers ? nil : "Add property"
    }

    /// What VoiceOver calls the seed, plus or words.
    static let seedSpoken = "Add property"

    /// A property's entry in the seed: the web seed's label, with an ellipsis
    /// for one that opens a sheet rather than a submenu ("Remind…", "Time…").
    /// 2e's seed holds the first six (`unsetProperties`); the rest carry the
    /// words design §3.7 gives their PRs (Project, Routine, Season). Repeat
    /// is a submenu, so its entry is "Repeat", with no ellipsis.
    static func seedEntry(_ kind: SheetChip.Kind) -> String {
        switch kind {
        case .priority: return "Priority"
        case .timesPerDay: return "Times per day"
        case .reminder: return "Remind\u{2026}"
        case .date: return "Date"
        case .time: return "Time\u{2026}"
        case .repeats: return "Repeat"
        case .project: return "Project"
        case .routine: return "Routine"
        case .season: return "Season"
        }
    }

    /// A property's symbol in the seed: its chip's own (`chips`), and for a
    /// project, whose chip wears a colour dot instead, a folder.
    static func seedSymbol(_ kind: SheetChip.Kind) -> String {
        switch kind {
        case .priority: return "flag"
        case .timesPerDay: return "arrow.2.squarepath"
        case .reminder: return "bell"
        case .date: return "calendar"
        case .time: return "clock"
        case .repeats: return "repeat"
        case .project: return "folder"
        case .routine: return "checklist"
        case .season: return "leaf"
        }
    }

    // MARK: The chips' menus

    /// The priority menu, the web's `PRIORITY_LABELS` in its order: None
    /// (nil, which clears it), Low, Medium, High. The seed's submenu takes
    /// the last three, since None is what an unset priority already is.
    static let priorityChoices: [PriorityChoice] = [
        PriorityChoice(raw: nil, word: "None"),
        PriorityChoice(raw: "low", word: "Low"),
        PriorityChoice(raw: "medium", word: "Medium"),
        PriorityChoice(raw: "high", word: "High"),
    ]

    /// The times per day menu: 1 to `EditLimits.timesPerDayMax`, the web
    /// chip's list, then a stored count above that, so it shows checked
    /// (picking it changes nothing). The seed's submenu takes 2 and up, since
    /// a habit with no count already reads as 1.
    static func timesChoices(stored: Int?) -> [Int] {
        let choices = Array(1...EditLimits.timesPerDayMax)
        guard let stored, stored > EditLimits.timesPerDayMax else { return choices }
        return choices + [stored]
    }

    /// "3× a day", as the web's times chip lists them.
    static func timesWord(_ n: Int) -> String {
        return "\(n)\u{00D7} a day"
    }

    /// "3 times a day", or "1 time a day": a count as VoiceOver hears it, on
    /// the chip and in its menu.
    static func timesSpoken(_ n: Int) -> String {
        return n == 1 ? "1 time a day" : "\(n) times a day"
    }

    /// The repeat menu: the type's frequencies (`allowed`, the registry's
    /// `allowedFrequencies`) in the web's order and words
    /// (`repeatFrequencyOrder` filtered, as the web's Repeat chip filters
    /// `REPEAT_FREQUENCY_LABELS`' entries), Monthly… and Custom days… with an
    /// ellipsis since each opens the Repeat sheet. Then a `stored` frequency
    /// that repeats (`isRecurring`'s test, the only case that draws the chip)
    /// and is none of those, on a row of its own in its own word, so the
    /// menu's Picker always has a row tagged for its selection and never
    /// hides what is stored, as `timesChoices(stored:)` keeps a count above
    /// five. The items table's CHECK keeps such a value out of a real row;
    /// the open text Item.swift keeps (a legacy "weekly") is what this
    /// guards. Picking that row changes nothing: `repeatPick` makes it a
    /// write the gate refuses (`frequency_not_allowed`).
    static func repeatChoices(allowed: [String], stored: String?) -> [RepeatChoice] {
        var out = repeatFrequencyOrder.filter { allowed.contains($0) }.map { frequency in
            RepeatChoice(frequency: frequency,
                         word: repeatFrequencyLabel(frequency) + (opensRepeatSheet(frequency) ? "\u{2026}" : ""))
        }
        if let stored, isRecurring(RepeatRule(frequency: stored)),
           !out.contains(where: { $0.frequency == stored }) {
            out.append(RepeatChoice(frequency: stored, word: repeatFrequencyLabel(stored)))
        }
        return out
    }

    /// Add property's Repeat ▸: the menu's rows with no stored value and
    /// without No repeat, since the seed holds Repeat only while nothing
    /// repeats.
    static func repeatSeedChoices(allowed: [String]) -> [RepeatChoice] {
        return repeatChoices(allowed: allowed, stored: nil).filter { $0.frequency != "none" }
    }

    /// What a pick in the repeat menu does: Monthly… and Custom days… open
    /// the Repeat sheet, and every other frequency is written at once, the
    /// days and the day left off (the server writes all three keys).
    static func repeatPick(_ frequency: String) -> RepeatPick {
        switch frequency {
        case "monthly": return .open(.monthly)
        case "custom": return .open(.custom)
        default: return .write(.repeats(frequency: frequency, days: nil, monthDay: nil))
        }
    }

    /// Does `frequency`'s row open the Repeat sheet (and so take an
    /// ellipsis, design §3.8)?
    private static func opensRepeatSheet(_ frequency: String) -> Bool {
        if case .open = repeatPick(frequency) { return true }
        return false
    }

    // MARK: Streak

    /// The streak chip's seven dots: THIS week (the week holding wall-clock
    /// today, starting on the user's Week starts on), first day first. Done
    /// wins over skipped, as the web's `drawnState` reads a day.
    static func weekDots(_ item: SampleItem, today: DayString, weekStartDay: WeekStartDay) -> [StreakDot] {
        let first = weekStartOf(today, weekStartDay)
        return (0..<7).map { (offset: Int) -> StreakDot in
            let day = first.adding(days: offset)
            let key = day.description
            if item.completedDates.contains(key) { return .done }
            if item.skippedDates.contains(key) { return .skipped }
            return day == today ? .today : .rest
        }
    }

    /// "Streak 3; this week: 4 done, 1 skipped" (the skips only when there
    /// are some): the chip as one VoiceOver element.
    static func streakSpoken(streak: Int, dots: [StreakDot]) -> String {
        let done = dots.filter { $0 == .done }.count
        let skipped = dots.filter { $0 == .skipped }.count
        var text = "Streak \(streak); this week: \(done) done"
        if skipped > 0 { text += ", \(skipped) skipped" }
        return text
    }

    /// The streak chip's hint, now that it is a button: what a tap shows,
    /// and Reset streak when the popover offers it.
    static func streakHint(resetOffered: Bool) -> String {
        return resetOffered ? "Shows this week, and Reset streak" : "Shows this week"
    }

    /// The popover's line under the week: the web's streak flame tooltip
    /// (DsulCore `streakRunText`, lib/item-edit.ts): "41 days in a row", or
    /// "No streak yet".
    static func streakRun(_ streak: Int) -> String {
        return streakRunText(streak)
    }

    /// Reset streak's confirm title, in sentence case as `deleteConfirmTitle`
    /// is, matching the verb's own label ("Reset streak", which its buttons
    /// carry); the web's dialog says "Reset Streak?".
    static let resetConfirmTitle = "Reset streak?"

    /// Reset streak's confirm message: the web's
    /// (`EDIT_COPY.resetStreakMessage`), which says the days already ticked
    /// stay ticked.
    static let resetConfirmMessage = EditCopy.resetStreakMessage

    /// The popover's form: a sheet at the accessibility text sizes, where a
    /// popover would crop the week and Reset, else a popover. Asked by the
    /// popover itself, since an adaptation applies only to presented content.
    static func streakPopoverStyle(accessibilitySize: Bool) -> StreakPopoverStyle {
        return accessibilitySize ? .sheet : .popover
    }

    // MARK: The wheel

    /// The Remind and Time sheets' wheel's calendar (`ClockWheel`):
    /// Gregorian, in GMT. The wheel shows and sets a time of day alone, read
    /// off a date in this calendar, so "08:00" is 8:00 on the wheel whatever
    /// the phone's zone and the stored time never shifts by an offset, as the
    /// web's time input has no zone either. The hour cycle is the view's
    /// (`Locale.Components` isn't promised on Linux).
    static let wheelCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "GMT")!
        return calendar
    }()

    /// "HH:mm" as the Remind and Time sheets' wheel's date: 1970-01-01 at
    /// that time in `wheelCalendar`. Nil unless it is a 24-hour "HH:mm", the
    /// server's rule (lib/app-api.ts `TimeStrSchema`), so "8:00" and "24:00"
    /// are nil.
    static func wheelDate(_ hhmm: String) -> Date? {
        guard let minutes = clockMinutes(hhmm) else { return nil }
        return Date(timeIntervalSince1970: TimeInterval(minutes * 60))
    }

    /// The Remind and Time sheets' wheel's date as "HH:mm": its hour and
    /// minute in `wheelCalendar`, whatever day it is on.
    static func wheelClock(_ date: Date) -> String {
        let parts = wheelCalendar.dateComponents([.hour, .minute], from: date)
        return minutesToTime((parts.hour ?? 0) * 60 + (parts.minute ?? 0))
    }

    /// A 24-hour "HH:mm" as minutes after midnight (`TimeStrSchema`: two
    /// digits, a colon, two digits, before 24:00); nil for anything else.
    private static func clockMinutes(_ hhmm: String) -> Int? {
        let bytes = Array(hhmm.utf8)
        guard bytes.count == 5, bytes[2] == UInt8(ascii: ":") else { return nil }
        let digits = [bytes[0], bytes[1], bytes[3], bytes[4]].map { Int($0) - Int(UInt8(ascii: "0")) }
        guard digits.allSatisfy({ (0...9).contains($0) }) else { return nil }
        let hour = digits[0] * 10 + digits[1]
        let minute = digits[2] * 10 + digits[3]
        guard hour < 24, minute < 60 else { return nil }
        return hour * 60 + minute
    }

    // MARK: The Remind sheet

    /// The stored reminder time, when it is one the wheel can show; nil for
    /// no reminder ("" included).
    static func reminderSeedTime(_ item: SampleItem) -> String? {
        guard let time = item.reminderTime, clockMinutes(time) != nil else { return nil }
        return time
    }

    /// Where a new reminder's wheel starts: the item's own start time when it
    /// has one, else 9:00 am (open question 2).
    static func reminderStartTime(_ item: SampleItem) -> String {
        if let start = item.startTime, clockMinutes(start) != nil { return start }
        return "09:00"
    }

    /// What the wheel shows as the sheet opens: the stored time, or, for a
    /// new reminder (Remind… in Add property), where a new one starts. The
    /// sheet always opens on a time, with no "Add a time" step first: the
    /// chip exists only for an item with a reminder, and adding a property
    /// opens its picker straight away (Kirby, open question 1).
    static func reminderOpeningTime(_ item: SampleItem) -> String {
        return reminderSeedTime(item) ?? reminderStartTime(item)
    }

    /// What Right after holds after a change from `previous` to `next`, asked,
    /// as `titleEntry` is, only of the text put in: a line break in it (a
    /// paste) becomes a space, as the web's one-line input reads it, and
    /// growth past `limit` (`growthLimit` of the stored words) is cut from it,
    /// by whole characters. What was already there is never rewritten.
    static func anchorEntry(previous: String, next: String, limit: Int) -> String {
        let change = splice(previous, next)
        let typed = String(change.inserted.map { $0.isNewline ? Character(" ") : $0 })
        return fitted(change.head, typed, change.tail, limit: limit)
    }

    /// Are the stored cue words longer than one request may carry
    /// (`EditLimits.outerAnchor`)? Then Right after is text, with
    /// `tooLongNote` under it, and the words are never sent.
    static func anchorTooLong(_ stored: String?) -> Bool {
        return (stored?.utf16.count ?? 0) > EditLimits.outerAnchor
    }

    /// What Done sends, if anything, or No reminder with `timeDraft` nil:
    /// 1. nothing while neither the time nor the words moved from their seeds;
    /// 2. no time: off, both columns cleared, unless `stored` has no reminder
    ///    to turn off;
    /// 3. the words only when they moved from their seed (the seed rule: words
    ///    never typed are never sent, so a time-only change keeps whatever is
    ///    stored, words typed on the web meanwhile included), cleaned
    ///    (`cleanAnchor`) within `growthLimit` of the stored words, and
    ///    `.clear` when they clean to nothing;
    /// 4. the time the wheel shows when it moved, else the time stored now:
    ///    the time is always sent, so when only the words changed, sending the
    ///    time the sheet opened with would put back a time changed on the web
    ///    while the sheet was up. When none is stored now (the web turned the
    ///    reminder off meanwhile), the edit is off, which step 5 drops;
    /// 5. nothing when the edit leaves `stored` as it is (DsulCore `editing`).
    /// `timeSeed` is the stored time as the sheet opened (`reminderSeedTime`),
    /// nil for a new reminder, so Done there saves the time the wheel shows,
    /// touched or not. `stored` is the item read when Done is tapped, so a
    /// fetch that landed while the sheet was up is what a change is measured
    /// against.
    static func reminderCommit(timeDraft: String?, timeSeed: String?, anchorDraft: String, anchorSeed: String,
                               stored: SampleItem) -> ItemEdit? {
        if timeDraft == timeSeed && anchorDraft == anchorSeed { return nil }
        guard let drafted = timeDraft else {
            return (stored.reminderTime ?? "").isEmpty ? nil : ItemEdit.reminder(time: nil, anchor: nil)
        }
        let anchor: ColumnWrite?
        if anchorDraft == anchorSeed {
            anchor = nil
        } else {
            let limit = growthLimit(cap: EditLimits.anchor, stored: stored.reminderAnchor)
            anchor = cleanAnchor(anchorDraft, limit: limit).map { ColumnWrite.set($0) } ?? ColumnWrite.clear
        }
        let time = drafted != timeSeed ? drafted : reminderSeedTime(stored)
        let edit = ItemEdit.reminder(time: time, anchor: time == nil ? nil : anchor)
        return editing(stored, edit) == stored ? nil : edit
    }

    /// The lines under the Remind sheet's fields saying a reminder can't fire,
    /// in this order: Habit reminders off on the web (`remindersEnabled`
    /// false; unknown, from an older server or a database behind on its
    /// migrations, says nothing), and no stored time zone (the reminder scan
    /// skips an account without one). Signed in only: the sample has neither,
    /// and its reminders were never going to fire (design Q9 a).
    static func reminderSettingsLines(remindersEnabled: Bool?, hasStoredZone: Bool, live: Bool) -> [String] {
        guard live else { return [] }
        var lines: [String] = []
        if remindersEnabled == false { lines.append(remindersOffLine) }
        if !hasStoredZone { lines.append(noZoneLine) }
        return lines
    }

    /// The Remind sheet's title, the web's ("Remind", item-dialog.tsx).
    static let reminderTitle = "Remind"

    /// The time's section, the web's ("Nudge me at").
    static let reminderTimeHeader = "Nudge me at"

    /// The wheel's name to VoiceOver; the wheel draws no label.
    static let reminderTimeLabel = "Time"

    /// The cue words' section, the web's ("Right after").
    static let reminderAnchorHeader = "Right after"

    /// Right after's placeholder, the web's (`EDIT_COPY`).
    static let reminderAnchorPlaceholder = EditCopy.reminderAnchorPlaceholder

    /// Under Right after: what the words are for, the web's (`EDIT_COPY`).
    static let reminderAnchorHint = EditCopy.reminderAnchorHint

    /// Under the time, for a dated type with no date (DsulCore
    /// `reminderNeedsDate`), the web's (`EDIT_COPY`).
    static let reminderNeedsDateNote = EditCopy.reminderNeedsDate

    /// Turns the reminder off, the web's ("No reminder").
    static let noReminder = "No reminder"

    /// Habit reminders are off. The switch lives on the web alone (Settings,
    /// Rituals, Habit reminders), so the line says where; the phone can't
    /// turn it on.
    static let remindersOffLine =
        "Habit reminders are off in dsul's settings on the web, under Rituals, so this won't fire."

    /// No stored time zone. The phone reads `user_settings.timezone` and
    /// never writes it; the web does, when it is opened.
    static let noZoneLine = "Reminders need your time zone, which dsul picks up when you open it on the web."

    /// Cancel on a changed sheet asks this, with Discard and Keep editing.
    static let discardTitle = "Discard changes?"
    static let discardAction = "Discard"
    static let keepEditing = "Keep editing"

    // MARK: The Time sheet

    /// The Time sheet's draft as it opens on `item`, as the dialog seeds its
    /// own (item-dialog.tsx `draftFromItem`): the stored part of day when it
    /// is one of the four (nil for none, and for text the web can't file
    /// either); the stored time as the time chip reads it (`startMin`), put
    /// as the wheel's 24-hour "HH:mm", so an agent's "9:00" or "09:00:00"
    /// opens the wheel at 9:00 and the check follows it as the server's
    /// auto-correct will (nil for none, and for text the chip can't read
    /// either, which `timeCommit` then clears); and the stored length, or the
    /// type's `defaultBlockMinutes` with none stored. An untouched wheel
    /// equals the seed, so the stored text is never rewritten unasked.
    static func timeSeed(_ item: SampleItem, caps: ItemCaps) -> TimeDraft {
        var time: String? = nil
        if let stored = item.startTime, let minutes = minutesAfterMidnight(stored) { time = minutesToTime(minutes) }
        return TimeDraft(bucket: item.timeBucket.flatMap { DayBucket(rawValue: $0) }, time: time,
                         duration: item.duration ?? caps.defaultBlockMinutes)
    }

    /// What Part of day's check shows, which is where the item will file:
    /// - a time under Morning, Afternoon or Evening files where the time says
    ///   (DsulCore `autoCorrectBucket`, lib/time-bucket.ts), so 3:00 pm under
    ///   Morning shows Afternoon;
    /// - a date-anchored type with none files in Anytime (item-dialog.tsx's
    ///   `effectiveBucket`: a dated item with no part of day lands there);
    /// - else the drafted part of day, nil for a habit with none, which shows
    ///   no check until one is picked.
    static func previewBucket(_ draft: TimeDraft, dateAnchored: Bool) -> DayBucket? {
        guard let bucket = draft.bucket else { return dateAnchored ? .anytime : nil }
        return autoCorrectBucket(draft.time, bucket.rawValue).flatMap { DayBucket(rawValue: $0) } ?? bucket
    }

    /// Is Specific time shown? While the check is on Morning, Afternoon or
    /// Evening (item-dialog.tsx: `effectiveBucket` neither none nor Anytime).
    /// Anytime holds no time.
    static func showsSpecificTime(_ draft: TimeDraft, dateAnchored: Bool) -> Bool {
        guard let preview = previewBucket(draft, dateAnchored: dateAnchored) else { return false }
        return preview != .anytime
    }

    /// A tap on `bucket` in Part of day: the draft with that part of day, and
    /// Anytime drops the time too, as the web's Anytime row does
    /// (item-dialog.tsx). But a tap that would leave the check where it is
    /// changes nothing, so what is checked is what Done sends (open question
    /// 1):
    /// - under a drafted time, only Anytime moves the check. Evening under
    ///   9:00 am leaves Morning checked and the draft as it was (the time sets
    ///   the part of day, `timeSetsPartOfDay`), and Afternoon under 3:00 pm,
    ///   checked once the wheel crossed, changes nothing either, so it can't
    ///   turn a time edit into a part-of-day edit and release a project block
    ///   unseen;
    /// - on a dated task with none stored, Anytime is already checked, so its
    ///   tap sends nothing;
    /// - with no time, every other row moves the check and lands.
    static func pickBucket(_ draft: TimeDraft, _ bucket: DayBucket, dateAnchored: Bool) -> TimeDraft {
        var next = draft
        next.bucket = bucket
        if bucket == .anytime { next.time = nil }
        let moved = previewBucket(next, dateAnchored: dateAnchored) != previewBucket(draft, dateAnchored: dateAnchored)
        return moved ? next : draft
    }

    /// Has what the sheet shows moved from how it opened (`seed`)? The check
    /// (`previewBucket`), the time or the length; never the raw draft, so a
    /// draft whose part of day moved but whose check didn't (the long way
    /// round: No specific time, Evening, Add a time, the wheel back to 9:00
    /// am) is unchanged, closes on a swipe and sends nothing. The sheet's
    /// `isDirty`, and `timeCommit`'s first test.
    static func timeMoved(draft: TimeDraft, seed: TimeDraft, dateAnchored: Bool) -> Bool {
        return previewBucket(draft, dateAnchored: dateAnchored) != previewBucket(seed, dateAnchored: dateAnchored)
            || draft.time != seed.time
            || draft.duration != seed.duration
    }

    /// Add a time: the drafted time set to where the checked part of day
    /// starts as the web offers it (DsulCore `bucketStartTime`,
    /// lib/time-bucket.ts `BUCKET_START_TIMES`: Morning 5:00 am, Afternoon
    /// 12:00 pm, Evening 5:00 pm; open question 2), which files where it was,
    /// so the check stays. The draft as it was under Anytime or none, where
    /// Add a time never shows.
    static func addingTime(_ draft: TimeDraft, dateAnchored: Bool) -> TimeDraft {
        guard let preview = previewBucket(draft, dateAnchored: dateAnchored),
              let start = bucketStartTime(preview)
        else { return draft }
        var next = draft
        next.time = start
        return next
    }

    /// Duration's rows: the web's lengths (DsulCore `EditCopy.durationPresets`,
    /// lib/item-edit.ts `DURATION_ORDER`), and the length the sheet opened on
    /// too when it is none of them (75 minutes, from a block resized on the
    /// web's grid), in order, so the row checked is always there. No clear,
    /// as on the web.
    static func durationChoices(seed: Int) -> [Int] {
        let presets = EditCopy.durationPresets
        return presets.contains(seed) ? presets : (presets + [seed]).sorted()
    }

    /// A length as the web's Duration rows and time chip name it (DsulCore
    /// `EditCopy.durationLabel`, lib/item-edit.ts `durationLabel`): "15 min",
    /// "1 hour", "1.5 hours", "2 hours", and any other length "N min".
    static func durationWord(_ n: Int) -> String {
        return EditCopy.durationLabel(n)
    }

    /// A length as VoiceOver hears it: its visible words with "min" said in
    /// full ("45 minutes", and "1 minute" for 1), so the label holds the
    /// words shown and Voice Control's "Tap 45 min" still matches. Words
    /// with no "min" are themselves ("1 hour", "1.5 hours").
    static func durationSpoken(_ n: Int) -> String {
        let word = durationWord(n)
        let short = " min"
        guard word.hasSuffix(short) else { return word }
        return String(word.dropLast(short.count)) + (n == 1 ? " minute" : " minutes")
    }

    /// What Done sends, if anything:
    /// 1. nothing while what the sheet shows hasn't moved (`timeMoved`);
    /// 2. the part of day only when the drafted one differs from the seed's
    ///    and the check moved: a tap moved it. The wheel crossing into
    ///    another part of day moves the check but not the part of day, so it
    ///    sends the time alone, which the server files where the time says
    ///    (the dialog's auto-correct) and which keeps a project block. The
    ///    long way round with the time moved too (Evening at 10:00 am over
    ///    Morning at 9:00 am) sends the time alone, and the server files it in
    ///    Morning, which is what the check shows. The time, `.set` or `.clear`
    ///    (No specific time, Anytime), when it differs from the seed's; the
    ///    length when it does. A key that didn't move is nil, left off the
    ///    wire, and `timeMoved` leaves at least one;
    /// 3. kept valid against `stored`, the item read when Done is tapped, so a
    ///    fetch that landed while the sheet was up is what the server will
    ///    read. A time sent alone, where `stored` has no part of day or
    ///    Anytime (changed on the web meanwhile), takes the drafted part of
    ///    day with it; Anytime sent alone, where `stored` has a time (added on
    ///    the web meanwhile), takes `startTime: .clear` with it. So the server
    ///    never meets a time beside Anytime or none (`invalid`). And a part of
    ///    day sent where the sheet showed no time but `stored` has text the
    ///    chip can't read ("9:00 PM", from an agent) takes `startTime: .clear`
    ///    too, or the server would file it by that text (`autoCorrectBucket`
    ///    reads "9:00 PM" as Morning, "x" as Anytime), not where the check is;
    /// 4. nothing when the edit leaves `stored` as it is (DsulCore `editing`):
    ///    the web made the same change while the sheet was up. On a task, a
    ///    part of day sent always passes this, even where the time files it
    ///    back where it was: `editing`'s `scheduleTaskPatch` arm sets
    ///    `isScheduled` and `inProjectBlock` false, which most rows hold as
    ///    NULL, as the web's commitEdit writes it. Step 2 sends a part of day
    ///    only when the check moved, so the sheet meets that only on a stale
    ///    `stored`.
    /// `seed` is `timeSeed` of the item as the sheet opened, so the draft is
    /// measured against what the user saw, and step 3 against what is stored.
    static func timeCommit(draft: TimeDraft, seed: TimeDraft, stored: SampleItem, dateAnchored: Bool) -> ItemEdit? {
        guard timeMoved(draft: draft, seed: seed, dateAnchored: dateAnchored) else { return nil }
        let checkMoved = previewBucket(draft, dateAnchored: dateAnchored)
            != previewBucket(seed, dateAnchored: dateAnchored)
        var bucket: ColumnWrite? = nil
        if let picked = draft.bucket, picked != seed.bucket, checkMoved {
            bucket = .set(picked.rawValue)
        }
        var startTime: ColumnWrite? = nil
        if draft.time != seed.time {
            startTime = draft.time.map { ColumnWrite.set($0) } ?? ColumnWrite.clear
        }
        let duration: Int? = draft.duration != seed.duration ? draft.duration : nil

        let storedBucket = stored.timeBucket ?? ""
        if case .set? = startTime, bucket == nil,
           storedBucket.isEmpty || storedBucket == DayBucket.anytime.rawValue,
           let picked = draft.bucket, picked != .anytime {
            bucket = .set(picked.rawValue)
        }
        if bucket == .set(DayBucket.anytime.rawValue), startTime == nil, !(stored.startTime ?? "").isEmpty {
            startTime = .clear
        }
        if bucket != nil, startTime == nil, seed.time == nil,
           let unread = stored.startTime, !unread.isEmpty, minutesAfterMidnight(unread) == nil {
            startTime = .clear
        }

        let edit = ItemEdit.time(bucket: bucket, startTime: startTime, duration: duration)
        return editing(stored, edit) == stored ? nil : edit
    }

    /// The Time sheet's title, the web's (item-dialog.tsx's Time chip).
    static let timeTitle = "Time"

    /// The part of day's section, the web's (the project time block's).
    static let partOfDayHeader = "Part of day"

    /// The time's section, the web's ("Specific time").
    static let specificTimeHeader = "Specific time"

    /// Brings the wheel up where a part of day has no time. The web's time
    /// input can be empty; a wheel can't, so this row is what keeps a time
    /// from being chosen for the user (open question 3).
    static let addTime = "Add a time"

    /// Drops the time and keeps the part of day, the web's ("No specific
    /// time").
    static let noSpecificTime = "No specific time"

    /// The length's section, the web's ("Duration").
    static let durationHeader = "Duration"

    /// The wheel's name to VoiceOver; the wheel draws no label.
    static let timeWheelLabel = "Time"

    /// Under Part of day while a time is drafted under Morning, Afternoon or
    /// Evening, when a tap on another part of day (Anytime aside) changes
    /// nothing (`pickBucket`), so the check that doesn't move has a reason on
    /// screen. The web has none, since its rows always move the check.
    static let timeSetsPartOfDay = "The time sets the part of day."

    // MARK: The Repeat sheet

    /// The days Custom days' keys open on: the stored ones within 0...6 when
    /// any are stored, else today's alone, as the web's Repeat chip picks
    /// `currentDayOfWeek` in the user's zone when its draft holds none
    /// (item-dialog.tsx). `today` is the planner's, the user's day now.
    static func repeatDaysSeed(_ item: SampleItem, today: DayString) -> Set<Int> {
        let stored = Set((item.repeatDays ?? []).filter { (0...6).contains($0) })
        return stored.isEmpty ? Set([today.weekday]) : stored
    }

    /// The day Monthly's grid opens on: the stored one when within 1...31,
    /// else the 1st (item-dialog.tsx `draftFromItem`'s `|| 1`).
    static func monthDaySeed(_ item: SampleItem) -> Int {
        guard let day = item.repeatMonthDay, (1...31).contains(day) else { return 1 }
        return day
    }

    /// What Done sends, if anything: Custom days with the days picked,
    /// ascending (the order the server takes, as the dialog's keys sort as
    /// they toggle), or Monthly with the day picked; nil for Custom days with
    /// no day, which Done is never offered for, and nil when the edit leaves
    /// `stored` as it is (DsulCore `editing`, lib/item-edit.ts
    /// `repeatEditPatch`: the frequency, the days and the day all as
    /// stored). `stored` is the item read when Done is tapped, so a change
    /// the web made while the sheet was up is measured too. A clean sheet on
    /// another frequency still sends (Custom days… on a daily item, Done at
    /// once): its frequency moves. From the sheet's keys (0...6) and grid
    /// (1...31), every edit returned passes `editAllowed`: the days a set, so
    /// each once, sorted.
    static func repeatCommit(_ detail: RepeatDetail, days: Set<Int>, monthDay: Int,
                             stored: SampleItem) -> ItemEdit? {
        let edit: ItemEdit
        switch detail {
        case .custom:
            guard !days.isEmpty else { return nil }
            edit = .repeats(frequency: "custom", days: days.sorted(), monthDay: nil)
        case .monthly:
            edit = .repeats(frequency: "monthly", days: nil, monthDay: monthDay)
        }
        return editing(stored, edit) == stored ? nil : edit
    }

    /// Custom days' keys, 0 = Sun … 6 = Sat, in the user's Week starts on
    /// order (DsulCore `weekdayOrder`; open question 2), so a Monday week
    /// reads Mon to Sun, as the week dots do. The web's always run from Sun.
    static func repeatDayKeys(weekStartDay: WeekStartDay) -> [Int] {
        return weekdayOrder(weekStartDay)
    }

    /// A key's word, the web's (DsulCore `weekdayLabel`, lib/planner-types.ts
    /// `WEEKDAY_LABELS`): "Sun" … "Sat".
    static func repeatDayWord(_ day: Int) -> String {
        return weekdayLabel(day)
    }

    /// A key's day in full, for VoiceOver and the rows at the larger text
    /// sizes: "Sunday" … "Saturday", spelled in English as the rest of the
    /// sheet is. Each begins with its word (`repeatDayWord`), so what
    /// VoiceOver says holds what the key shows. "" outside 0...6.
    static func repeatDayName(_ day: Int) -> String {
        let names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
        return (0...6).contains(day) ? names[day] : ""
    }

    /// A day of the month as the web's chip names it ("Day 12",
    /// item-dialog.tsx `repeatValue`): the grid's VoiceOver label, and the
    /// row at the accessibility sizes. The grid itself shows the bare
    /// number, as the web's does.
    static func monthDayWord(_ day: Int) -> String {
        return "Day \(day)"
    }

    /// The Repeat sheet's title: the web's word for its frequency, without
    /// the menu's ellipsis ("Custom days", "Monthly").
    static func repeatTitle(_ detail: RepeatDetail) -> String {
        return repeatFrequencyLabel(detail.rawValue)
    }

    /// Under Custom days' keys while none is picked, the web's (`EDIT_COPY`).
    static let selectAtLeastOneDay = EditCopy.selectAtLeastOneDay

    /// Under Monthly's days, the web's (`EDIT_COPY`).
    static let monthlyNote = EditCopy.monthlyNote
}
