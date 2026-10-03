import DsulCore
import SwiftUI

/// The item's notes, under its title: part 1's text (four lines and Show
/// all), and, where they may be edited, a field in its place.
///
/// - **Editable** (the type has notes and the server takes `notes`): the
///   text is a button, and so is "Notes" in `.secondary` where there are
///   none (the web panel's placeholder; a placeholder role, so held to the
///   system's placeholder contrast, which `.secondary` beats). Both read as a
///   button with the hint "Edits the notes". Activating either swaps in a
///   vertical `TextField` that focuses itself from its own `.onAppear` with
///   the caret at the end: SwiftUI can't map a tap on a `Text` to an offset
///   in it, so the caret never lands where the finger did.
/// - **Editing**: Return is a line break; the nav bar's Done, a drag down
///   the scroll, or leaving the page ends it, and `ItemDetail` sends the
///   change (`ItemSheetModel.commit`). Typing past `growthLimit` of the seed
///   is cut (`ItemSheetModel.notesEntry`).
/// - **Read-only**: an older server, a type without notes, or notes stored
///   longer than one request may carry (200,000 UTF-16 units), which say so
///   under them ("Too long to edit on the phone.").
///
/// The draft and the seed are `ItemDetail`'s, which commits them on focus
/// leaving, on `.onDisappear` and on the scene going inactive; this view only
/// draws them.
struct NotesEditor: View {
    /// The notes as stored (`planner.item(id)?.notes`).
    let stored: String?
    /// The type has notes and the server takes the write.
    let editable: Bool
    /// The field is up in place of the text.
    let editing: Bool
    @Binding var draft: String
    /// What the field showed when editing began: typing may grow the notes
    /// to the cap, or keep them as long as this when it is longer.
    let seed: String
    var focus: FocusState<SheetField?>.Binding
    /// A tap on the text or the placeholder: the page seeds the draft and
    /// swaps the field in.
    let onEdit: () -> Void

    @State private var selection: TextSelection? = nil

    var body: some View {
        let shown = (stored ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let tooLong = ItemSheetModel.tooLongToEdit(stored, kind: .notes)
        if editable && !tooLong {
            if editing {
                field
            } else if shown.isEmpty {
                placeholder
            } else {
                NotesText(text: shown, onEdit: onEdit)
            }
        } else if !shown.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                NotesText(text: shown, onEdit: nil)
                if editable {
                    Text(ItemSheetModel.tooLongNote)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// The notes as a field: the label colour for the text, the caret and
    /// the selection (the accent is a 1.5:1 lime), which the tint draws.
    private var field: some View {
        TextField("Notes", text: $draft, selection: $selection,
                  prompt: Text(ItemSheetModel.notesPlaceholder), axis: .vertical)
            .font(.body)
            .focused(focus, equals: .notes)
            .tint(Color.primary)
            .onAppear {
                selection = TextSelection(insertionPoint: draft.endIndex)
                focus.wrappedValue = .notes
            }
            .onChange(of: draft) { previous, next in
                // Typing only: the page fills the draft before the field
                // appears, never while it has focus.
                guard focus.wrappedValue == .notes else { return }
                let limit = growthLimit(cap: EditLimits.notes, stored: seed)
                let fitted = ItemSheetModel.notesEntry(previous: previous, next: next, limit: limit)
                if fitted != next { draft = fitted }
            }
    }

    /// "Notes" where there are none, hit over 44pt, though it lays out as one
    /// line of text: a frame, never an overhang into the rows around it.
    private var placeholder: some View {
        Button(action: onEdit) {
            Text(ItemSheetModel.notesPlaceholder)
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle(verticalBleed: 0))
        .accessibilityHint(Text(ItemSheetModel.notesHint))
    }
}

/// The notes, four lines at most until Show all. The button is there only
/// when the text runs longer, which two hidden copies measure: one held to
/// four lines, one not. VoiceOver reads the whole text either way, so the
/// button is hidden from it. With `onEdit`, the text is a button that edits
/// the notes; Show all stays its own, so a tap on it never starts editing.
private struct NotesText: View {
    let text: String
    let onEdit: (() -> Void)?

    @State private var expanded = false
    @State private var clippedHeight: CGFloat = 0
    @State private var fullHeight: CGFloat = 0

    private var truncates: Bool { fullHeight > clippedHeight + 0.5 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let onEdit {
                // Hit over at least 44pt: a one-line note is centred in it.
                Button(action: onEdit) {
                    notes
                        .frame(minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(RowPressStyle())
                .accessibilityHint(Text(ItemSheetModel.notesHint))
            } else {
                notes
            }

            if truncates {
                // Hit over 44pt, though it lays out as one line of text.
                Button {
                    withAnimation(.snappy) { expanded.toggle() }
                } label: {
                    Text(expanded ? "Show less" : "Show all")
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                        .padding(.vertical, -12)
                }
                .font(.subheadline.weight(.semibold))
                .tint(Color.primary)
                .accessibilityHidden(true)
            }
        }
    }

    /// The text, clipped to four lines until expanded, over the two hidden
    /// copies that measure whether it runs longer.
    private var notes: some View {
        Text(text)
            .font(.body)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.leading)
            .lineLimit(expanded ? nil : 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(alignment: .topLeading) {
                ZStack(alignment: .topLeading) {
                    Text(text)
                        .font(.body)
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                        .onGeometryChange(for: CGFloat.self) { proxy in
                            proxy.size.height
                        } action: { height in
                            clippedHeight = height
                        }
                    Text(text)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                        .onGeometryChange(for: CGFloat.self) { proxy in
                            proxy.size.height
                        } action: { height in
                            fullHeight = height
                        }
                }
                .hidden()
                .accessibilityHidden(true)
            }
    }
}
