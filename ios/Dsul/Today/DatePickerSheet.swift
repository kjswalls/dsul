import DsulCore
import SwiftUI

/// Go to date: what a tap on the Today title opens (G board). Picking a day
/// moves Today to it and closes the sheet.
struct DatePickerSheet: View {
    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss
    @State private var picked = Date()

    var body: some View {
        NavigationStack {
            DatePicker("Date", selection: $picked, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .labelsHidden()
                .padding(.horizontal)
                .navigationTitle("Go to date")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Today") {
                            planner.goToToday()
                            dismiss()
                        }
                        .disabled(planner.isOnToday)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done", systemImage: "checkmark") { dismiss() }
                    }
                }
        }
        .presentationDetents([.medium, .large])
        .onAppear {
            picked = planner.selectedDay.localDate()
        }
        .onChange(of: picked) { _, newValue in
            let day = DayString(date: newValue)
            guard day != planner.selectedDay else { return }
            planner.select(day)
            dismiss()
        }
    }
}
