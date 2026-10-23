import DsulCore
import Foundation

// What a container's page may edit beyond its Status chip, and in what words
// (design §6.3, O8b to O11): a routine's usual time, a season's Runs, a goal's
// window, the notes (a goal's why), the ⋯ menu's Rename…, Icon and colour…
// and Delete… (O10), and the list's + menu with its name sheet (O11). Worked
// out apart from the views so the hosted tests pin it (OrganizePageTests), as
// ContainerPageModel does for what a page shows. Foundation only: the shim
// compiles it on Linux.
//
// Every editor is offered only where the server takes its write and the
// kind's switch is on (`OrganizeModel.canEdit`), and every rule under it is
// DsulCore's: the intents and their checks (`ContainerIntent`), a project's
// folded clash (`projectNameClash`), the notes' and the name's cleaning
// (`cleanNotes`, `cleanTitle`), the picker grids (`ContainerLook.featured`,
// `.ramp`, `.swatches`). The planner steps and sends each edit
// (`SamplePlanner.editContainer` and the steps over it).
//
// The words are the web's where it has them: "Usually at" and "Clear time"
// (container-page.tsx), "Runs", "Starts", "Ends", "Window", "Started" and
// "Target" (`DateRangeChip`), "Add a note…" and "Why this matters…" and the
// notes' field names (container-fields.tsx), and the delete confirms and the
// create sheet's words (lib/organize-copy.ts, through DsulCore
// `OrganizeCopy`). No em dashes, and nothing here asks for a hue: the views
// draw a colour only as a swatch or a tile.

/// What a container page edits beyond its chips (O8b to O10): its notes (a
/// goal's why) and the ⋯ menu's three rows. Each nil while read-only.
struct PageEdits: Hashable, Sendable {
    let ref: ContainerRef
    /// The notes sheet; nil while the server doesn't take `notes` (a goal's
    /// `why`) or the switch is off.
    let notes: NotesEdit?
    /// Rename…; nil while `rename` isn't taken.
    let rename: RenameEdit?
    /// Icon and color…; nil while neither `icon` nor `color` is taken.
    let look: LookEdit?
    /// Delete… (O10); nil while `delete` isn't taken.
    var delete: DeleteEdit? = nil

    /// The ⋯ menu shows with a row in it.
    var hasMenu: Bool { rename != nil || look != nil || delete != nil }
}

/// Delete… (O10): the confirm, in the web's words per kind, worked out when
/// the menu is drawn and kept with the confirm, so what it counts is what
/// was on screen when it was asked.
struct DeleteEdit: Identifiable, Hashable, Sendable {
    let ref: ContainerRef
    /// "Delete this routine?", "Delete this season?", "Delete Run a half
    /// marathon?", `Delete “Home”?` (`OrganizeCopy.deleteTitle`).
    let title: String
    /// What happens, the phone's sentence (`OrganizeCopy.deleteConsequence`),
    /// which offers no undo and ends on the kind: "The routine stays in the
    /// Trash for 30 days."
    let message: String
    /// The destructive button: "Delete", a goal's "Delete goal".
    let confirmLabel: String
    /// What VoiceOver hears once the page has gone: "Routine deleted".
    let spoken: String

    var id: ContainerRef { ref }
}

/// + → New routine, New season, New goal or New project (O11): the name
/// sheet for one kind.
struct CreateEdit: Identifiable, Hashable, Sendable {
    let kind: OrganizeKind
    /// The sheet's eyebrow, placeholder, button and hint, the web's create
    /// form's (`OrganizeCopy.createCopy`).
    let copy: CreateCopy
    /// The + menu's row and the sheet's title: "New routine".
    let title: String
    /// The live projects a new project's name may not fold onto; empty for
    /// every other kind, whose names may repeat.
    let siblings: [Project]

    var id: OrganizeKind { kind }
}

/// The notes sheet (O8b): a routine's, a season's or a project's notes, or a
/// goal's why, with the item sheet's notes behaviour (cut at the limit as
/// typed, cleaned as sent, too long to edit shown and never sent).
struct NotesEdit: Identifiable, Hashable, Sendable {
    let ref: ContainerRef
    /// As stored: what the draft starts from.
    let stored: String?
    /// The sheet's title and the field's name to VoiceOver: "Routine note",
    /// "Why this goal matters" (the web's field names).
    let title: String
    /// The page's line where there are none, and the field's placeholder:
    /// "Add a note…", "Why this matters…" (the web's).
    let placeholder: String
    /// What the notes, and their placeholder, do, as VoiceOver hints it.
    let hint: String
    /// Stored longer than one request may carry (`EditLimits.outerNotes`):
    /// shown, with `ItemSheetModel.tooLongNote` under it, and never edited.
    let tooLong: Bool

    var id: ContainerRef { ref }
}

/// Rename… (O9): an alert with the name in a field. Save is off while the
/// name cleans to nothing and, on a project, while another live project's
/// name folds to the same (`ContainerEditModel.canSaveRename`).
struct RenameEdit: Identifiable, Hashable, Sendable {
    let ref: ContainerRef
    /// The name as stored: the field's first text.
    let name: String
    /// "Rename routine".
    let title: String
    /// The live projects a project's new name may not fold onto; empty for
    /// every other kind, whose names may repeat.
    let siblings: [Project]

    var id: ContainerRef { ref }
}

/// Icon and color… (O9): the featured icons as SF Symbols (no Auto:
/// the web never clears a glyph), the eight ramp colours by name, and
/// Auto, which clears the colour so the name's hash colours it again.
struct LookEdit: Identifiable, Hashable, Sendable {
    let ref: ContainerRef
    let name: String
    /// The stored glyph (a project's `emoji`) and colour: the draft's seed.
    let glyph: String?
    let color: String?
    /// Empty while the server doesn't take `icon`.
    let icons: [IconChoice]
    /// Empty while the server doesn't take `color`.
    let colors: [ColorChoice]

    var id: ContainerRef { ref }

    /// The ⋯ menu's row: "Icon and color…", or the half the server takes.
    var menuLabel: String {
        if colors.isEmpty { return ContainerEditModel.lookIconOnly }
        if icons.isEmpty { return ContainerEditModel.lookColorOnly }
        return ContainerEditModel.lookBoth
    }

    /// The sheet's title: the menu row's words without the ellipsis.
    var title: String {
        if colors.isEmpty { return ContainerEditModel.iconSection }
        if icons.isEmpty { return ContainerEditModel.colorSection }
        return ContainerEditModel.lookTitle
    }
}

/// One cell of the icon grid: a library name (`ContainerLook.featured`), its
/// SF Symbol, and its name as VoiceOver says it ("Heart pulse").
struct IconChoice: Identifiable, Hashable, Sendable {
    let name: String
    let symbol: String
    let spoken: String

    var id: String { name }
}

/// One colour: a ramp token and its name ("var(--accent-2)", "Teal"), or
/// Auto (nil).
struct ColorChoice: Identifiable, Hashable, Sendable {
    let token: String?
    let label: String

    var id: String { token ?? "" }
}

/// What the Look sheet has picked so far, over what is stored.
struct LookDraft: Hashable, Sendable {
    var glyph: String?
    var color: String?
}

/// A routine's usual time sheet (O8b): the wheel, and Clear time where one
/// is stored.
struct UsualTimeEdit: Hashable, Sendable {
    /// "HH:mm" as stored; nil for none.
    let stored: String?
    /// Where the wheel starts: the stored time when the wheel can show it,
    /// else `ContainerEditModel.defaultUsualTime`.
    let initial: String
}

/// The words of a two-ended range: a season's Runs or a goal's window, the
/// web's `DateRangeChip`'s.
struct RangeWords: Hashable, Sendable {
    /// The sheet's title: "Runs", "Window".
    let title: String
    /// Each end's name: "Starts" and "Ends", "Started" and "Target".
    let startLabel: String
    let endLabel: String
    /// The chip with neither end set: "Runs", "Target".
    let empty: String
    /// What the chip does, as VoiceOver hints it.
    let hint: String
}

/// A season's Runs or a goal's window (O8b): two optional days, sent
/// together (`dates`, `window`).
struct RangeEdit: Identifiable, Hashable, Sendable {
    let ref: ContainerRef
    let words: RangeWords
    /// As stored, read as days; nil for none (or one the phone can't read).
    let start: DayString?
    let end: DayString?

    var id: ContainerRef { ref }

    var draft: RangeDraft { RangeDraft(start: start, end: end) }
}

/// The range a Runs or window sheet holds.
struct RangeDraft: Hashable, Sendable {
    var start: DayString?
    var end: DayString?
}

enum ContainerEditModel {
    // MARK: Words

    /// The ⋯ menu's name to VoiceOver.
    static let moreLabel = "More"
    static let renameWord = "Rename\u{2026}"
    static let lookBoth = "Icon and color\u{2026}"
    static let lookIconOnly = "Icon\u{2026}"
    static let lookColorOnly = "Color\u{2026}"
    static let lookTitle = "Icon and color"
    static let iconSection = "Icon"
    static let colorSection = "Color"
    /// The colour that follows the name, in the web's words: its swatch
    /// row's "Auto", as its chips say "Color" (color-swatch-picker.tsx,
    /// organizer-chips.tsx).
    static let automatic = "Auto"
    /// The rename alert's field: its placeholder and its name to VoiceOver.
    static let nameField = "Name"
    static let saveWord = "Save"
    /// The ⋯ menu's delete row (O10), which asks before anything goes.
    static let deleteWord = "Delete\u{2026}"
    /// The list's + menu to VoiceOver (O11).
    static let newLabel = "New"

    /// The web's notes placeholders.
    static let notePlaceholder = "Add a note\u{2026}"
    static let whyPlaceholder = "Why this matters\u{2026}"
    /// What the notes, and their placeholder, do when activated.
    static let notesHint = "Edits the note"
    static let whyHint = "Edits why this goal matters"

    /// A routine's usual time: the web's "Usually at" and "Clear time".
    static let usualTimeTitle = "Usually at"
    static let clearTime = "Clear time"
    /// The chip with no usual time, shown only where it may be set.
    static let noUsualTime = "No usual time"
    static let usualTimeHint = "Edits the usual time"
    /// Under the wheel: what a usual time is, and what it never does
    /// (routines.tsx: a label and an ordering, never a schedule).
    static let usualTimeNote = "It orders and labels the routine. Its items keep their own times."
    /// Where the wheel starts with none stored: a new reminder's 9:00 am
    /// (`ItemSheetModel.reminderStartTime`).
    static let defaultUsualTime = "09:00"

    /// The web's `DateRangeChip` words for a season's Runs and a goal's
    /// window.
    static let runsWords = RangeWords(title: "Runs", startLabel: "Starts", endLabel: "Ends", empty: "Runs",
                                      hint: "Edits when it runs")
    static let windowWords = RangeWords(title: "Window", startLabel: "Started", endLabel: "Target", empty: "Target",
                                        hint: "Edits the window")

    /// "Rename routine", the kind's noun from `ContainerWords`.
    static func renameTitle(_ kind: OrganizeKind) -> String {
        return "Rename " + jsLowercased(OrganizeModel.noun(kind))
    }

    /// The notes' field name, the web's: "Routine note", "Season note",
    /// "Project note", "Why this goal matters".
    static func notesTitle(_ kind: OrganizeKind) -> String {
        return kind == .goal ? "Why this goal matters" : OrganizeModel.noun(kind) + " note"
    }

    // MARK: A container's stored fields

    /// The glyph a container stores: a project's `emoji`, everyone else's
    /// `icon`.
    static func glyph(of container: ContainerSnapshot) -> String? {
        switch container {
        case .routine(let routine): return routine.icon
        case .season(let season): return season.icon
        case .goal(let goal): return goal.icon
        case .project(let project): return project.emoji
        }
    }

    static func color(of container: ContainerSnapshot) -> String? {
        switch container {
        case .routine(let routine): return routine.color
        case .season(let season): return season.color
        case .goal(let goal): return goal.color
        case .project(let project): return project.color
        }
    }

    /// Its free text: the notes, or a goal's why.
    static func text(of container: ContainerSnapshot) -> String? {
        switch container {
        case .routine(let routine): return routine.notes
        case .season(let season): return season.notes
        case .goal(let goal): return goal.why
        case .project(let project): return project.notes
        }
    }

    /// The action a container's free text is written by: a goal's `why`,
    /// everyone else's `notes`.
    static func textAction(_ kind: OrganizeKind) -> ContainerAction {
        return kind == .goal ? .why : .notes
    }

    // MARK: The page's edits

    /// What `container`'s page may edit beyond its chips, each behind
    /// `OrganizeModel.canEdit`.
    static func pageEdits(_ container: ContainerSnapshot, _ s: OrganizeSnapshot) -> PageEdits {
        let ref = container.ref
        let kind = ref.kind
        func can(_ action: ContainerAction) -> Bool {
            return OrganizeModel.canEdit(action, on: kind, takes: s.containerTakes, settings: s.settings)
        }
        var notes: NotesEdit? = nil
        if can(textAction(kind)) {
            let stored = text(of: container)
            notes = NotesEdit(ref: ref, stored: stored, title: notesTitle(kind),
                              placeholder: kind == .goal ? whyPlaceholder : notePlaceholder,
                              hint: kind == .goal ? whyHint : notesHint,
                              tooLong: ItemSheetModel.tooLongToEdit(stored, kind: .notes))
        }
        let rename = can(.rename)
            ? RenameEdit(ref: ref, name: container.name, title: renameTitle(kind),
                         siblings: kind == .project ? s.projects : [])
            : nil
        let icons = can(.icon) ? ContainerLook.featured.map { iconChoice($0, kind: kind) } : []
        let colors = can(.color) ? colorChoices : []
        let look = icons.isEmpty && colors.isEmpty
            ? nil
            : LookEdit(ref: ref, name: container.name, glyph: glyph(of: container), color: color(of: container),
                       icons: icons, colors: colors)
        let delete = can(.delete) ? deleteEdit(container, s) : nil
        return PageEdits(ref: ref, notes: notes, rename: rename, look: look, delete: delete)
    }

    // MARK: Notes

    /// The notes field after a change from `previous` to `next`: the item
    /// sheet's rule (`ItemSheetModel.notesEntry`), growth past what one
    /// request may carry cut from what was put in. Container notes have no
    /// smaller cap.
    static func notesEntry(previous: String, next: String) -> String {
        return ItemSheetModel.notesEntry(previous: previous, next: next, limit: EditLimits.outerNotes)
    }

    /// What Done sends for `draft`: the notes cleaned (`cleanNotes`: trimmed,
    /// blank is none), as `notes`, or a goal's `why`. Nil when that is what is
    /// stored, so an untouched sheet sends nothing.
    static func notesIntent(_ draft: String, kind: OrganizeKind, stored: String?) -> ContainerIntent? {
        let clean = cleanNotes(draft, limit: EditLimits.outerNotes)
        guard clean != stored else { return nil }
        return kind == .goal ? .why(clean) : .notes(clean)
    }

    // MARK: Rename

    /// The name `draft` saves as: the title's cleaning (`cleanTitle`: one
    /// line, trimmed, within what one request may carry); nil when nothing
    /// is left.
    static func renamedName(_ draft: String) -> String? {
        return cleanTitle(draft, limit: EditLimits.outerTitle)
    }

    /// Is Save on? The draft cleans to a name, and on a project no other live
    /// project's name folds to it (`projectNameClash`, the create sheet's
    /// check and the route's first step). A project changing only its own
    /// case is not a clash.
    static func canSaveRename(_ draft: String, _ edit: RenameEdit) -> Bool {
        guard let name = renamedName(draft) else { return false }
        if edit.ref.kind == .project, projectNameClash(name, among: edit.siblings, except: edit.ref.id) != nil {
            return false
        }
        return true
    }

    /// What Save sends (`SamplePlanner.rename`): `.rename` of the cleaned
    /// name; nil when it cleans to nothing or to the name `stored`. A
    /// project's clash is not checked here: Save is already off for one
    /// (`canSaveRename`), and the planner refuses one made meanwhile with the
    /// route's words (`editContainer`).
    static func renameIntent(_ draft: String, stored: String) -> ContainerIntent? {
        guard let name = renamedName(draft), name != stored else { return nil }
        return .rename(name)
    }

    // MARK: Icon and color

    /// The colour row: the ramp's eight by name, then Auto.
    static let colorChoices: [ColorChoice] = zip(ContainerLook.ramp, ContainerLook.swatches).map {
        ColorChoice(token: $0.0, label: $0.1)
    } + [ColorChoice(token: nil, label: automatic)]

    static func iconChoice(_ name: String, kind: OrganizeKind) -> IconChoice {
        return IconChoice(name: name, symbol: ContainerLook.lucideToSymbol[name] ?? kind.fallbackSymbol,
                          spoken: spokenIconName(name))
    }

    /// A library name as VoiceOver says it: its words apart, in sentence
    /// case ("HeartPulse" is "Heart pulse", "Gamepad2" "Gamepad 2").
    static func spokenIconName(_ name: String) -> String {
        var words: [String] = []
        var word = ""
        for character in name {
            let startsWord = !word.isEmpty
                && (character.isUppercase || (character.isNumber && !(word.last?.isNumber ?? false)))
            if startsWord {
                words.append(word)
                word = ""
            }
            word.append(character)
        }
        if !word.isEmpty { words.append(word) }
        return words.enumerated().map { index, w in index == 0 ? w : w.lowercased() }.joined(separator: " ")
    }

    /// Is `choice` the glyph the draft holds? The stored token exactly, as
    /// the web's picker checks it: a glyph derived from the name, or a
    /// legacy emoji, checks nothing.
    static func isPicked(_ choice: IconChoice, _ draft: LookDraft) -> Bool {
        return draft.glyph == ContainerLook.iconToken(choice.name)
    }

    /// Is `choice` the colour the draft holds? A ramp token exactly, or
    /// Auto with none stored.
    static func isPicked(_ choice: ColorChoice, _ draft: LookDraft) -> Bool {
        return draft.color == choice.token
    }

    /// The draft as the header's tile draws it.
    static func preview(_ edit: LookEdit, _ draft: LookDraft) -> PageHeader {
        return ContainerPageModel.header(edit.ref.kind, name: edit.name, glyph: draft.glyph, color: draft.color)
    }

    /// What Done sends: the icon, then the colour, each only when the draft
    /// moved it from what is stored and the server takes it.
    static func lookIntents(_ edit: LookEdit, _ draft: LookDraft) -> [ContainerIntent] {
        var intents: [ContainerIntent] = []
        if !edit.icons.isEmpty, draft.glyph != edit.glyph, let glyph = draft.glyph {
            intents.append(.icon(glyph))
        }
        if !edit.colors.isEmpty, draft.color != edit.color {
            intents.append(.color(draft.color))
        }
        return intents
    }

    // MARK: Usual time

    /// A routine's usual time sheet, or nil while it is read-only.
    static func usualTimeEdit(_ routine: Routine, _ s: OrganizeSnapshot) -> UsualTimeEdit? {
        guard OrganizeModel.canEdit(.usualTime, on: .routine, takes: s.containerTakes, settings: s.settings) else {
            return nil
        }
        let stored = routine.usualTime.flatMap { $0.isEmpty ? nil : $0 }
        let readable = stored.flatMap { ItemSheetModel.wheelDate($0) == nil ? nil : $0 }
        return UsualTimeEdit(stored: stored, initial: readable ?? defaultUsualTime)
    }

    // MARK: Runs and window

    /// A season's Runs sheet, or nil while it is read-only. Under Dates
    /// alone, as the chip is: On and Off ignore the range.
    static func runsEdit(_ season: Season, _ s: OrganizeSnapshot) -> RangeEdit? {
        guard season.state == "auto",
              OrganizeModel.canEdit(.dates, on: .season, takes: s.containerTakes, settings: s.settings)
        else { return nil }
        return RangeEdit(ref: ContainerRef(kind: .season, id: season.id), words: runsWords,
                         start: season.startsOn.flatMap { DayString($0) }, end: season.endsOn.flatMap { DayString($0) })
    }

    /// A goal's window sheet, or nil while it is read-only.
    static func windowEdit(_ goal: Goal, _ s: OrganizeSnapshot) -> RangeEdit? {
        guard OrganizeModel.canEdit(.window, on: .goal, takes: s.containerTakes, settings: s.settings) else {
            return nil
        }
        return RangeEdit(ref: ContainerRef(kind: .goal, id: goal.id), words: windowWords,
                         start: goal.startsOn.flatMap { DayString($0) }, end: goal.targetOn.flatMap { DayString($0) })
    }

    /// The draft with its start switched on, at today, or at its end when
    /// that comes first; off clears it.
    static func settingStart(_ draft: RangeDraft, on: Bool, today: DayString) -> RangeDraft {
        var next = draft
        if on {
            next.start = draft.end.map { Swift.min(today, $0) } ?? today
        } else {
            next.start = nil
        }
        return next
    }

    /// The draft with its end switched on, at today, or at its start when
    /// that comes later; off clears it.
    static func settingEnd(_ draft: RangeDraft, on: Bool, today: DayString) -> RangeDraft {
        var next = draft
        if on {
            next.end = draft.start.map { Swift.max(today, $0) } ?? today
        } else {
            next.end = nil
        }
        return next
    }

    /// A day picked for the start, kept no later than the end (the
    /// calendar's own fence, said again so a draft never inverts).
    static func pickingStart(_ draft: RangeDraft, _ day: DayString) -> RangeDraft {
        var next = draft
        next.start = draft.end.map { Swift.min(day, $0) } ?? day
        return next
    }

    /// A day picked for the end, kept no earlier than the start.
    static func pickingEnd(_ draft: RangeDraft, _ day: DayString) -> RangeDraft {
        var next = draft
        next.end = draft.start.map { Swift.max(day, $0) } ?? day
        return next
    }

    /// The line under a Runs sheet: the season's own sentence for the draft
    /// (`OrganizeCopy.seasonStateNote` under Dates), so a cleared end says at
    /// once what the season will do. Nil under a goal's window.
    static func rangeNote(_ edit: RangeEdit, _ draft: RangeDraft, season: Season?, today: DayString) -> String? {
        guard edit.ref.kind == .season, var next = season else { return nil }
        next.state = "auto"
        next.startsOn = draft.start?.description
        next.endsOn = draft.end?.description
        return OrganizeCopy.seasonStateNote(next, live: isSeasonActiveOn(next, on: today))
    }

    // MARK: Delete (O10)

    /// The confirm for deleting `container`: the web's title and button per
    /// kind, and the phone's consequence sentence, counted as the web's pane
    /// counts it.
    static func deleteEdit(_ container: ContainerSnapshot, _ s: OrganizeSnapshot) -> DeleteEdit {
        let kind = container.ref.kind
        return DeleteEdit(
            ref: container.ref,
            title: OrganizeCopy.deleteTitle(kind, name: container.name),
            message: OrganizeCopy.deleteConsequence(deleteInput(container, s)),
            confirmLabel: OrganizeCopy.deleteConfirmLabel(kind),
            spoken: deletedAnnouncement(kind)
        )
    }

    /// What the consequence sentence counts, as the web's pane counts it:
    /// - a routine: its live members (`countLive`), and whether taking it away
    ///   puts any of them back on today (`membersRevealedByRemoving`, read
    ///   against routines and seasons as routines.tsx reads it, with no trip);
    /// - a season: its live direct members and live routines, and whether it
    ///   is on today (`isSeasonActiveOn`);
    /// - a goal: nothing;
    /// - a project: the items its page and its list row count (filed under
    ///   its folded name, subtasks left out), so the confirm agrees with the
    ///   page it is asked from.
    static func deleteInput(_ container: ContainerSnapshot, _ s: OrganizeSnapshot) -> DeleteConsequenceInput {
        let liveItems = Set(s.items.map(\.id))
        switch container {
        case .routine(let routine):
            let revealed = membersRevealedByRemoving(
                routine.id, memberIds: routine.itemIds, items: s.items, on: s.today, timeZone: s.timeZone,
                routines: s.routines, seasons: s.seasons
            )
            return .routine(name: routine.name, liveCount: countLive(routine.itemIds, live: liveItems),
                            reappear: !revealed.isEmpty)
        case .season(let season):
            let liveRoutines = Set(s.routines.map(\.id))
            return .season(name: season.name, itemCount: countLive(season.itemIds, live: liveItems),
                           routineCount: countLive(season.routineIds, live: liveRoutines),
                           live: isSeasonActiveOn(season, on: s.today))
        case .goal:
            return .goal
        case .project(let project):
            let counts = OrganizeModel.listedByProject(s.items)
            return .project(name: project.name, itemCount: counts[Array(jsLowercased(project.name).utf16)] ?? 0)
        }
    }

    /// "Routine deleted", said once the page has gone.
    static func deletedAnnouncement(_ kind: OrganizeKind) -> String {
        return OrganizeModel.noun(kind) + " deleted"
    }

    // MARK: Create (O11)

    /// The + menu's rows: each kind the server creates and the switches
    /// show, in the list's order (routine, season, goal, project). A goal only
    /// once goals are read, as the list shows them. None before the first
    /// fetch. Empty hides the +.
    static func createEdits(_ s: OrganizeSnapshot) -> [CreateEdit] {
        guard s.hasLoaded else { return [] }
        return OrganizeModel.shownKinds(s)
            .filter { OrganizeModel.canEdit(.create, on: $0, takes: s.containerTakes, settings: s.settings) }
            .map { kind in
                CreateEdit(kind: kind, copy: OrganizeCopy.createCopy(kind), title: OrganizeCopy.newMenuLabel(kind),
                           siblings: kind == .project ? s.projects : [])
            }
    }

    /// The + menu row's glyph: the symbol of the glyph the new container
    /// starts with (`CreateCopy.icon`), so a project's row shows the
    /// briefcase its tile will wear; the kind's own (`fallbackSymbol`) where
    /// that glyph has no symbol, as a season's `CalendarRange` has none.
    static func createSymbol(_ edit: CreateEdit) -> String {
        let token = edit.copy.icon
        let prefix = ContainerLook.iconTokenPrefix
        guard token.hasPrefix(prefix) else { return edit.kind.fallbackSymbol }
        return ContainerLook.lucideToSymbol[String(token.dropFirst(prefix.count))] ?? edit.kind.fallbackSymbol
    }

    /// The name `draft` creates: the title's cleaning, as Rename's
    /// (`cleanTitle`); nil when nothing is left.
    static func createdName(_ draft: String) -> String? {
        return renamedName(draft)
    }

    /// The live project a new project named `draft` would fold onto, nil
    /// when none does or the kind isn't a project (the store's guard,
    /// planner-store.ts `addProject`, and the route's 409).
    static func createClash(_ draft: String, _ edit: CreateEdit) -> Project? {
        guard edit.kind == .project, let name = createdName(draft) else { return nil }
        return projectNameClash(name, among: edit.siblings)
    }

    /// Under the field while the name clashes: "You already have a project
    /// called “Work”.", naming the project already there, as the web's
    /// rename field does (labels.tsx `takenBy`). Nil while there is none.
    static func createClashSentence(_ draft: String, _ edit: CreateEdit) -> String? {
        guard let clash = createClash(draft, edit) else { return nil }
        return OrganizeCopy.nameTakenSentence(noun: jsLowercased(ContainerWords.project), name: clash.name)
    }

    /// Is Create on? The name cleans to something, and a project's folds
    /// onto no live project's.
    static func canCreate(_ draft: String, _ edit: CreateEdit) -> Bool {
        return createdName(draft) != nil && createClash(draft, edit) == nil
    }

    /// "Routine created", said once the new page has settled.
    static func createdAnnouncement(_ kind: OrganizeKind) -> String {
        return OrganizeModel.noun(kind) + " created"
    }

    // MARK: Chips

    /// What an editable chip does, as VoiceOver hints it.
    static func chipHint(_ kind: PageChip.Kind) -> String? {
        switch kind {
        case .usualTime: return usualTimeHint
        case .runs: return runsWords.hint
        case .window: return windowWords.hint
        case .status: return ContainerPageModel.statusHint
        case .items, .timeBlock: return nil
        }
    }
}
