import DsulCore
import SwiftUI

/// The new subtask's field, at the end of the Subtasks section in place of
/// the "Add a subtask" row (`AddSubtaskLabel`), which the page swaps it for.
/// What it holds is the page's draft (`ItemDetail`); what it adds goes
/// through `onAdd` to the page, and on to the planner, which gates each one.
///
/// - **Return** adds the line as a subtask and keeps the keyboard, so subtasks
///   go in one after another, as the web's Enter does; Return on an empty
///   field ends entry. iOS may report a Return in a vertical field as a line
///   break in the text, as `.onSubmit`, or as both, in either order, so
///   `ItemSheetModel.subtaskEntry` and `.subtaskSubmit` (`lastReturn`) add
///   on whichever report comes first and let the other go: one Return, one
///   subtask.
/// - **A pasted list** adds one subtask per line, list markers stripped, as
///   the web's Subtasks section does (lib/bulk-add.ts); what was typed before
///   stays.
/// - **Leaving** (another field, Done, a drag down, the page going) is the
///   page's: it adds what is left in the field and brings the row back.
/// - **Lime**: the caret and the selection are the tint, so the field tints
///   itself in the label colour; the accent is a 1.5:1 lime.
/// - **VoiceOver**: "New subtask", a text field, with the web's placeholder.
struct SubtaskField: View {
    @Binding var draft: String
    var focus: FocusState<SheetField?>.Binding
    /// The subtasks to add, in order, and whether a paste held more lines
    /// than one paste adds.
    let onAdd: (_ titles: [String], _ capped: Bool) -> Void

    @State private var lastReturn: SubtaskReturn = .none

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            AddSubtaskLabel.plus
            TextField(ItemSheetModel.subtaskFieldLabel, text: $draft,
                      prompt: Text(ItemSheetModel.subtaskPlaceholder), axis: .vertical)
                .focused(focus, equals: .subtask)
                .submitLabel(.next)
                .tint(Color.primary)
                .onAppear {
                    focus.wrappedValue = .subtask
                }
                .onChange(of: draft) { previous, next in
                    // Typing only: the page clears the draft before the field
                    // appears and once entry ends, and that is never an entry.
                    guard focus.wrappedValue == .subtask else { return }
                    apply(ItemSheetModel.subtaskEntry(previous: previous, next: next, lastReturn: lastReturn))
                }
                .onSubmit {
                    let step = ItemSheetModel.subtaskSubmit(draft: draft, lastReturn: lastReturn)
                    apply(step)
                    // A submit may take focus from the field, which the page
                    // would read as leaving it: keep it, unless entry ended.
                    if !step.end { focus.wrappedValue = .subtask }
                }
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }

    /// Does what `step` says, in this order: notes which report acted, adds,
    /// sets the field (its own write, which `subtaskEntry` reads as nothing
    /// put in), and ends entry.
    private func apply(_ step: SubtaskStep) {
        lastReturn = step.lastReturn
        if !step.titles.isEmpty || step.capped {
            onAdd(step.titles, step.capped)
        }
        if step.draft != draft { draft = step.draft }
        if step.end { focus.wrappedValue = nil }
    }
}

/// "Add a subtask" after a plus, the Subtasks section's last row while
/// nothing is being added: the plus in the subtask circles' column and the
/// words in line with their titles, so the field that replaces it
/// (`SubtaskField`, which draws the same plus) doesn't shift. In `.secondary`,
/// as a placeholder is; the full width, at least 44pt tall, so a tap right
/// of the words still lands. VoiceOver reads the words alone.
struct AddSubtaskLabel: View {
    /// The plus, as wide as a subtask's circle (22pt), hidden from VoiceOver.
    static var plus: some View {
        Image(systemName: "plus")
            .foregroundStyle(.secondary)
            .frame(width: 22)
            .accessibilityHidden(true)
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Self.plus
            Text(ItemSheetModel.subtaskRowTitle)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
    }
}
