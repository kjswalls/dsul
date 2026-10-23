import DsulCore
import SwiftUI

/// Icon and color… on a container's page (O9, design §6.6 and §6.7): the
/// container's tile as the draft would draw it, then the icon grid, the web's
/// featured icons (`ContainerLook.featured`) as their SF Symbols, then the
/// colours, the ramp's eight by name (`ContainerLook.swatches`) and
/// Auto, which clears the colour so the name's hash colours it again.
/// The icon has no Auto: the web never clears a glyph. A half the server
/// doesn't take is left out (`LookEdit`).
///
/// A tap picks; nothing is written until Done, which sends the icon and the
/// colour that moved (`ContainerEditModel.lookIntents`), each through the
/// planner's gate (`editContainer`). After a pick a swipe down is refused and
/// Cancel asks "Discard changes?", as the item sheet's editors do (SwiftUI
/// tells a sheet nothing of a refused swipe, so only Cancel can ask). The
/// picked icon is the stored `icon:<Name>` token exactly, as the web's picker
/// checks it: a glyph the name derives, or a legacy emoji, checks nothing.
///
/// Hue is a mark here and never text: the tile, and each colour's swatch at
/// full strength (Lime is a swatch, never faded). The icons, the names and
/// the checks are the label colour; the sheet tints itself so.
struct LookSheet: View {
    let edit: LookEdit

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss
    @State private var draft: LookDraft
    @State private var confirmingDiscard = false
    @ScaledMetric(relativeTo: .body) private var cell: CGFloat = 44
    @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = 20
    @ScaledMetric(relativeTo: .body) private var swatch: CGFloat = 22

    init(edit: LookEdit) {
        self.edit = edit
        _draft = State(initialValue: LookDraft(glyph: edit.glyph, color: edit.color))
    }

    private var isDirty: Bool { !ContainerEditModel.lookIntents(edit, draft).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    preview
                }
                if !edit.icons.isEmpty {
                    Section {
                        iconGrid
                    } header: {
                        Text(ContainerEditModel.iconSection)
                    }
                }
                if !edit.colors.isEmpty {
                    Section {
                        ForEach(edit.colors) { choice in
                            colorRow(choice)
                        }
                    } header: {
                        Text(ContainerEditModel.colorSection)
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
                    Button("Done") { done() }
                        .tint(Color.primary)
                }
            }
            .confirmationDialog(ItemSheetModel.discardTitle, isPresented: $confirmingDiscard,
                                titleVisibility: .visible) {
                Button(ItemSheetModel.discardAction, role: .destructive) { dismiss() }
                Button(ItemSheetModel.keepEditing, role: .cancel) {}
            }
        }
        .tint(Color.primary)
        .interactiveDismissDisabled(isDirty)
        .presentationDetents([.large])
    }

    /// The tile and the name, as the page's header will draw them. One
    /// element to VoiceOver: the name; the tile is decorative.
    private var preview: some View {
        let header = ContainerEditModel.preview(edit, draft)
        return HStack(spacing: 12) {
            ContainerTile(symbol: header.symbol, accent: header.accent, side: 44)
            Text(edit.name)
                .font(.headline)
                .foregroundStyle(Color.primary)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    /// The featured icons, as many to a line as fit, each a 44pt button with
    /// the picked one ringed.
    private var iconGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: cell, maximum: cell + 12), spacing: 6)], spacing: 6) {
            ForEach(edit.icons) { choice in
                let picked = ContainerEditModel.isPicked(choice, draft)
                Button {
                    draft.glyph = ContainerLook.iconToken(choice.name)
                } label: {
                    Image(systemName: choice.symbol)
                        .font(.system(size: glyph, weight: .medium))
                        .foregroundStyle(Color.primary)
                        .frame(width: cell, height: cell)
                        .background {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(picked ? Color(.tertiarySystemFill) : Color.clear)
                        }
                        .overlay {
                            if picked {
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .strokeBorder(Color.primary, lineWidth: 1.5)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel(Text(choice.spoken))
                .accessibilityAddTraits(picked ? .isSelected : [])
            }
        }
        .padding(.vertical, 6)
        // Each cell answers its own taps, never the whole row's.
        .buttonStyle(.borderless)
    }

    /// One colour: its swatch, its name, and a check on the picked one,
    /// which VoiceOver reads as selected. Auto's swatch is the colour
    /// the name gives it.
    private func colorRow(_ choice: ColorChoice) -> some View {
        let picked = ContainerEditModel.isPicked(choice, draft)
        let accent = containerAccent(choice.token, name: edit.name)
        return Button {
            draft.color = choice.token
        } label: {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: swatch * 0.3, style: .continuous)
                    .fill(accent.color)
                    .frame(width: swatch, height: swatch)
                    .accessibilityHidden(true)
                Text(choice.label)
                    .foregroundStyle(Color.primary)
                Spacer(minLength: 8)
                if picked {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.primary)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(picked ? .isSelected : [])
    }

    private func cancel() {
        if isDirty {
            confirmingDiscard = true
        } else {
            dismiss()
        }
    }

    private func done() {
        let ref = edit.ref
        let intents = ContainerEditModel.lookIntents(edit, draft)
        withAnimation(.snappy) {
            for intent in intents {
                planner.editContainer(ref, intent)
            }
        }
        dismiss()
    }
}
