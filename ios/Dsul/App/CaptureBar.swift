import SwiftUI

/// The capture bar in the tab view's bottom accessory: a button drawn as a
/// field (a real TextField there would sit under the keyboard), and the
/// braindump count. When the tab bar minimizes, the accessory moves inline
/// beside it and the bar shrinks to an icon, a short label and the count.
struct CaptureBar: View {
    var count: Int
    var onCapture: () -> Void
    var onTray: () -> Void

    @Environment(\.tabViewBottomAccessoryPlacement) private var placement

    private var isInline: Bool { placement == .inline }

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onCapture) {
                HStack(spacing: 10) {
                    Image(systemName: "plus")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                    Text(isInline ? "Capture" : "Get it out of your head")
                        .foregroundStyle(Color.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Capture a thought")

            Button(action: onTray) {
                HStack(spacing: 5) {
                    Image(systemName: "tray")
                    Text("\(count)")
                        .monospacedDigit()
                        .fontWeight(.semibold)
                }
                .font(isInline ? .footnote : .subheadline)
                .padding(.horizontal, isInline ? 8 : 10)
                .padding(.vertical, isInline ? 3 : 5)
                .background(Capsule().fill(Color(.tertiarySystemFill)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Braindump, \(count) items")
            .accessibilityHint("Opens the braindump over the schedule")
        }
        .padding(.horizontal, isInline ? 12 : 16)
    }
}

/// The small sheet a tap on the capture bar opens. The field stays focused
/// after each Return, so thoughts go in one after another; Done closes it.
/// However it closes, Done or a swipe down, what's typed is kept.
struct CaptureSheet: View {
    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var added = 0
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 8) {
                TextField("Get it out of your head", text: $text)
                    .focused($focused)
                    .submitLabel(.next)
                    .onSubmit(submit)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color(.secondarySystemBackground)))
                Text(added == 0 ? "Goes to your braindump." : "Added \(added) to your braindump.")
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.top, 4)
            .navigationTitle("Capture")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done", systemImage: "checkmark") {
                        commit()
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.height(190)])
        .onAppear { focused = true }
        // A swipe down closes the sheet without Done; the text still goes in.
        .onDisappear { commit() }
    }

    /// Return: capture, then keep typing.
    private func submit() {
        commit()
        focused = true
    }

    /// Captures what's typed, if anything, and clears the field.
    private func commit() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            planner.capture(trimmed)
            added += 1
        }
        text = ""
    }
}
