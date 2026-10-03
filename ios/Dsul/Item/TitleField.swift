import DsulCore
import SwiftUI

/// The item's title as a field, in the title's place when the server takes
/// `title` (every type, a subtask's page included): what it says is the
/// page's draft (`ItemDetail`), filled from the planner whenever the field
/// doesn't have focus, so a fetch shows through.
///
/// - **Return** ends the edit, and the page sends the change: a vertical
///   field takes Return as a line break, so `ItemSheetModel.titleEntry`
///   reads a typed one out of the text rather than trusting `.onSubmit`,
///   which may not fire for one (`.onSubmit` ends it too, if it does).
///   A pasted line break becomes a space, as the web's one-line input reads
///   it, and typing past `growthLimit` of the stored title is cut.
/// - **Lime**: the caret and the selection are the tint, so the field tints
///   itself in the label colour; the accent is a 1.5:1 lime.
/// - **VoiceOver**: "Title", a text field, and still the page's heading.
struct TitleField: View {
    @Binding var draft: String
    /// The title as stored (`planner.item(id)?.title`): it may grow to the
    /// cap, or stay as long as this when it is longer. What the route
    /// measures against, never the seed, which after a commit that kept focus
    /// is the raw draft and may be longer than the trimmed title stored.
    let stored: String
    /// The type's own prompt ("What needs to be done?", "Add a side quest…").
    let placeholder: String
    var focus: FocusState<SheetField?>.Binding

    var body: some View {
        TextField("Title", text: $draft, prompt: Text(placeholder), axis: .vertical)
            .font(.title2.weight(.semibold))
            .focused(focus, equals: .title)
            .submitLabel(.done)
            .tint(Color.primary)
            .accessibilityAddTraits(.isHeader)
            .onSubmit {
                focus.wrappedValue = nil
            }
            .onChange(of: draft) { previous, next in
                // Typing only: the page fills the draft from the planner while
                // the field doesn't have focus, and that is never an entry.
                guard focus.wrappedValue == .title else { return }
                let limit = growthLimit(cap: EditLimits.title, stored: stored)
                let entry = ItemSheetModel.titleEntry(previous: previous, next: next, limit: limit)
                if entry.draft != next { draft = entry.draft }
                if entry.commit { focus.wrappedValue = nil }
            }
    }
}
