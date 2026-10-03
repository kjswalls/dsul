import DsulCore
import SwiftUI

/// An item's sheet (H board): what the item is, its title and notes edited in
/// place, and its verbs, Delete among them. `PlannerSheetContent`'s `.item`
/// arm, so it opens over Today from List, Buckets, Schedule and Search, and
/// stacked on the braindump sheet from a braindump row, through the planner's
/// one sheet slot (`SamplePlanner.open`).
///
/// - Its own navigation: a subtask's title pushes the subtask's page.
/// - Detents medium and large; it opens large at the accessibility text sizes,
///   where medium leaves too little room for the content above the bar, and
///   goes large whenever a field on any page takes focus (`ItemDetail`).
/// - Its verbs act on the day it was opened with (`SheetDay`), read when one
///   is tapped. Pause until and Reschedule's Pick a date open a day picker
///   sheet of its own, and the reminder chip and Remind… the Remind sheet
///   (`SheetEditor`), never the planner's slot, which would close this one to
///   open it.
/// - It stays open after a verb, as the web's item panel does. When its item
///   is gone (deleted, or a fetch without it), the planner clears the slot
///   and it closes, still showing the item as it slides away.
struct ItemSheet: View {
    let id: UUID
    let day: SheetDay

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        ItemSheetStack(id: id, day: day, startsLarge: dynamicTypeSize.isAccessibilitySize)
    }
}

/// The sheet itself, once the starting detent is known (the environment
/// can't be read in an initializer, and a detent set after the sheet appears
/// would visibly jump).
private struct ItemSheetStack: View {
    let id: UUID
    let day: SheetDay

    @Environment(SamplePlanner.self) private var planner
    @State private var path: [UUID] = []
    @State private var detent: PresentationDetent
    /// The sheet open over this one (ItemSheetModel's `SheetEditor`), shared
    /// by every page of the stack.
    @State private var editor: SheetEditor? = nil

    init(id: UUID, day: SheetDay, startsLarge: Bool) {
        self.id = id
        self.day = day
        _detent = State(initialValue: startsLarge ? .large : .medium)
    }

    var body: some View {
        NavigationStack(path: $path) {
            ItemDetail(id: id, day: day, isRoot: true, path: $path, editor: $editor, detent: $detent)
                .navigationDestination(for: UUID.self) { child in
                    ItemDetail(id: child, day: day, isRoot: false, path: $path, editor: $editor,
                               detent: $detent)
                }
        }
        // No sheet-wide `.tint`: the done tick and "Now" are drawn in
        // `Color.accentColor`, which must stay lime. Each control tints
        // itself in the label colour instead (ItemDetail's toolbar buttons),
        // and the bar draws its slots in it (VerbBar). A text field above
        // all: its caret and its selection highlight are the tint, and a lime
        // caret is about 1.5:1 on white, so TitleField and NotesEditor tint
        // themselves too. The sheet's own sheets tint themselves: the day
        // pickers' calendar the system blue, since it draws a white number on
        // the tint, and ReminderSheet the label colour, since nothing in it
        // is lime.
        .sheet(item: $editor) { editor in
            editorSheet(editor)
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
    }

    /// The sheet's own sheets: the day pickers and the Remind sheet.
    ///
    /// Reschedule starts on the item's own day (or the day the sheet acts
    /// on, when it has none) and may pick any day, as the web's does; it is
    /// titled with the bar's word, Schedule for an undated item. Pause until
    /// starts, at the earliest, tomorrow: a pause has to end after today. A
    /// picker left open across midnight may confirm a day that is now today,
    /// so today is read again when it confirms, and a day no longer after it
    /// writes nothing and says so in the banner.
    ///
    /// The Remind sheet is handed the item as it is now, and keeps what it
    /// opened on (`ReminderSheet`): this runs again whenever the planner's
    /// items change, and a sheet whose item went would otherwise go blank
    /// under the user, so there is no `if let`. The planner closes the item
    /// sheet, and this one with it, when the item goes.
    @ViewBuilder
    private func editorSheet(_ editor: SheetEditor) -> some View {
        switch editor {
        case .reschedule(let itemID):
            DayPickSheet(words: rescheduleWords(itemID),
                         initial: planner.item(itemID)?.day ?? planner.actingDay(day), earliest: nil) { picked in
                withAnimation(.snappy) { planner.move(itemID, to: picked.description) }
            }
        case .pauseUntil(let itemID):
            DayPickSheet(words: ItemSheetModel.pauseUntilWords,
                         initial: planner.today.adding(days: 1), earliest: planner.today.adding(days: 1)) { picked in
                planner.refreshToday()
                if let refusal = ItemSheetModel.pauseUntilRefusal(picked, today: planner.today) {
                    planner.show(refusal, isError: true)
                    return
                }
                withAnimation(.snappy) { planner.pause(itemID, until: picked.description) }
            }
        case .reminder(let itemID):
            ReminderSheet(id: itemID, opening: planner.item(itemID))
        }
    }

    /// Reschedule's words for `itemID` on the sheet's day; a dated item's
    /// when it is gone, which then moves nothing.
    private func rescheduleWords(_ itemID: UUID) -> DayPickWords {
        guard let item = planner.item(itemID) else {
            return DayPickWords(title: "Reschedule", confirmVerb: "Move to", note: nil)
        }
        return ItemSheetModel.rescheduleWords(item, planner.verbContext(for: item, day: day))
    }
}
