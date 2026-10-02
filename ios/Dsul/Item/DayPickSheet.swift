import DsulCore
import SwiftUI

/// A day picker over the item sheet, for Reschedule's "Pick a date…" and for
/// Pause until. Nothing is written until the confirm button, which names the
/// day ("Move to Thu, Oct 8"): a stray tap on the calendar is not a write, and
/// the phone has no undo. Cancel or a swipe down leaves the item as it was.
///
/// Presented by the item sheet itself, not through the planner's sheet slot,
/// which holds the item sheet and would close it to open this.
struct DayPickSheet: View {
    let title: String
    /// The confirm button's verb, before the day: "Move to", "Pause until".
    let confirmVerb: String
    /// The first day that may be picked; nil for none.
    let earliest: DayString?
    let onPick: (DayString) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var picked: Date

    init(title: String, confirmVerb: String, initial: DayString, earliest: DayString?,
         onPick: @escaping (DayString) -> Void) {
        self.title = title
        self.confirmVerb = confirmVerb
        self.earliest = earliest
        self.onPick = onPick
        let start = earliest.map { Swift.max(initial, $0) } ?? initial
        _picked = State(initialValue: start.localDate())
    }

    /// The calendar day picked, as the picker shows it (the device's calendar).
    private var pickedDay: DayString { DayString(date: picked) }

    var body: some View {
        NavigationStack {
            ScrollView {
                calendar
                    .datePickerStyle(.graphical)
                    .labelsHidden()
                    .padding(.horizontal)
            }
            .safeAreaBar(edge: .bottom) {
                Button {
                    onPick(pickedDay)
                    dismiss()
                } label: {
                    Text(confirmVerb + " " + formatTargetDay(pickedDay.description))
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Color(.systemBackground))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Capsule().fill(Color.primary))
                        .contentShape(Capsule())
                }
                .buttonStyle(PressScaleStyle(scale: 0.97))
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", role: .cancel) { dismiss() }
                        .tint(Color.primary)
                }
            }
        }
        .presentationDetents([.large])
    }

    @ViewBuilder
    private var calendar: some View {
        if let earliest {
            DatePicker("Day", selection: $picked, in: earliest.localDate()..., displayedComponents: .date)
        } else {
            DatePicker("Day", selection: $picked, displayedComponents: .date)
        }
    }
}
