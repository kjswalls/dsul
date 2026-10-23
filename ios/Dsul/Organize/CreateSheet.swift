import DsulCore
import SwiftUI

/// + → New routine, New season, New goal or New project on the Organize list
/// (O11, design §6.3): a name sheet, the web console's create form on the
/// phone. The kind's eyebrow over one field with the web's placeholder ("Name
/// your routine…"), its hint under it, Cancel and Create.
///
/// Create stays off until the name cleans to something (`cleanTitle`: one
/// line, trimmed) and, for a project, while it folds onto a live project's
/// name: the field then says "You already have a project called “Work”.",
/// naming the one already there (`ContainerEditModel.createClashSentence`,
/// the store's guard and the route's 409). Return creates, as the button
/// does. The route's 409 stays the backstop for a clash made elsewhere
/// meanwhile, and for a name a project in the Trash still holds, which the
/// phone can't see; its sentence shows as the banner.
///
/// Create makes the container through the planner at once
/// (`SamplePlanner.createContainer`: the phone's own id, the kind's starting
/// glyph, a goal's window opening today), hands its ref to `onCreated` and
/// closes; the list pushes the new page once the sheet has gone. With a name
/// typed, a swipe down is refused and Cancel asks "Discard changes?"; with
/// nothing typed, either just closes, as the item sheet's editors do
/// (TimeSheet). SwiftUI tells a sheet nothing of a refused swipe, so only
/// Cancel can ask. The sheet tints itself the label colour, never lime.
struct CreateSheet: View {
    let edit: CreateEdit
    /// The new container, made: the list pushes its page.
    let onCreated: (ContainerRef) -> Void

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var confirmingDiscard = false
    @FocusState private var focused: Bool

    private var isDirty: Bool { !draft.isEmpty }

    var body: some View {
        let clash = ContainerEditModel.createClashSentence(draft, edit)
        NavigationStack {
            Form {
                Section {
                    TextField(edit.copy.placeholder, text: $draft)
                        .textInputAutocapitalization(.sentences)
                        .submitLabel(.done)
                        .focused($focused)
                        .onSubmit { create() }
                        .accessibilityLabel(Text(ContainerEditModel.nameField))
                } header: {
                    Text(edit.copy.eyebrow)
                } footer: {
                    VStack(alignment: .leading, spacing: 8) {
                        if let clash {
                            Text(clash)
                                .foregroundStyle(Color.primary)
                        }
                        Text(edit.copy.hint)
                    }
                }
            }
            .navigationTitle(edit.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { cancel() }
                        .tint(Color.primary)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(edit.copy.addLabel) { create() }
                        .disabled(!ContainerEditModel.canCreate(draft, edit))
                        .tint(Color.primary)
                }
            }
            .confirmationDialog(ItemSheetModel.discardTitle, isPresented: $confirmingDiscard,
                                titleVisibility: .visible) {
                Button(ItemSheetModel.discardAction, role: .destructive) { dismiss() }
                Button(ItemSheetModel.keepEditing, role: .cancel) {}
            }
            .onAppear { focused = true }
        }
        .tint(Color.primary)
        .interactiveDismissDisabled(isDirty)
        .presentationDetents([.medium, .large])
    }

    private func cancel() {
        if isDirty {
            confirmingDiscard = true
        } else {
            dismiss()
        }
    }

    /// Makes it, if Create is on, and closes. A planner that refuses it (a
    /// switch turned off or a clash that arrived with a fetch since the sheet
    /// opened) shows why in the banner, which the list shows once the sheet
    /// has gone.
    private func create() {
        guard ContainerEditModel.canCreate(draft, edit) else { return }
        let made = withAnimation(.snappy) { planner.createContainer(edit.kind, name: draft) }
        if let made { onCreated(made) }
        dismiss()
    }
}
