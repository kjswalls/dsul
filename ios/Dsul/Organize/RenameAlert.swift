import DsulCore
import SwiftUI

/// Rename… on a container's page (O9, design §6.3): an alert titled for the
/// kind ("Rename routine") with the name in a field, Cancel and Save.
///
/// Save is off while the name cleans to nothing (`cleanTitle`: one line,
/// trimmed) and, on a project, while another live project's name folds to
/// the same, the create sheet's check and the route's first step
/// (`ContainerEditModel.canSaveRename`, DsulCore `projectNameClash`). A
/// project changing only its own case may save. The route's 409 stays the
/// backstop for a clash made elsewhere meanwhile, and for a name a project in
/// the Trash still holds, which the phone can't see; its sentence shows as the
/// banner.
///
/// Save hands the draft to `onSave`, which the page sends through the planner
/// (`SamplePlanner.rename`): an unchanged name sends nothing, and a project's
/// rename re-files its items at once. The page seeds the draft with the name
/// as it opens the alert, so the field never shows an older one.
struct RenameAlert: ViewModifier {
    @Binding var edit: RenameEdit?
    @Binding var draft: String
    let onSave: (RenameEdit, String) -> Void

    func body(content: Content) -> some View {
        content
            .alert(edit?.title ?? "", isPresented: Binding(
                get: { edit != nil },
                set: { shown in if !shown { edit = nil } }
            ), presenting: edit) { edit in
                TextField(ContainerEditModel.nameField, text: $draft)
                    .textInputAutocapitalization(.sentences)
                    .accessibilityLabel(Text(ContainerEditModel.nameField))
                Button("Cancel", role: .cancel) {}
                Button(ContainerEditModel.saveWord) { onSave(edit, draft) }
                    .disabled(!ContainerEditModel.canSaveRename(draft, edit))
            }
    }
}

extension View {
    /// Presents Rename… while `edit` holds one.
    func renameAlert(_ edit: Binding<RenameEdit?>, draft: Binding<String>,
                     onSave: @escaping (RenameEdit, String) -> Void) -> some View {
        modifier(RenameAlert(edit: edit, draft: draft, onSave: onSave))
    }
}
