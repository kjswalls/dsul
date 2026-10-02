import DsulCore
import SwiftUI

/// An item's sheet (H board): what the item is, read-only in part 1, and its
/// verbs. `PlannerSheetContent`'s `.item` arm, so it opens over Today from
/// List, Buckets, Schedule and Search, and stacked on the braindump sheet
/// from a braindump row, through the planner's one sheet slot
/// (`SamplePlanner.open`).
///
/// - Its own navigation: a subtask's title pushes the subtask's page.
/// - Detents medium and large; it opens large at the accessibility text sizes,
///   where medium leaves too little room for the content above the bar.
/// - Its verbs act on the day it was opened with (`SheetDay`), read when one
///   is tapped. Pause until and Reschedule's Pick a date open a day picker
///   sheet of its own (`DayPick`), never the planner's slot, which would close
///   this one to open it.
/// - It stays open after a verb, as the web's item panel does. When its item
///   is gone (a fetch without it), the planner clears the slot and it closes.
struct ItemSheet: View {
    let id: UUID
    let day: SheetDay

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        ItemSheetStack(id: id, day: day, startsLarge: dynamicTypeSize.isAccessibilitySize)
    }
}

/// What the sheet's own day picker is choosing for: a new day for the item,
/// or the day its pause ends.
enum DayPick: Identifiable, Hashable, Sendable {
    case reschedule(UUID)
    case pauseUntil(UUID)

    var id: String {
        switch self {
        case .reschedule(let id): return "reschedule-" + id.uuidString
        case .pauseUntil(let id): return "pause-until-" + id.uuidString
        }
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
    @State private var dayPick: DayPick? = nil

    init(id: UUID, day: SheetDay, startsLarge: Bool) {
        self.id = id
        self.day = day
        _detent = State(initialValue: startsLarge ? .large : .medium)
    }

    var body: some View {
        NavigationStack(path: $path) {
            ItemDetail(id: id, day: day, isRoot: true, path: $path, dayPick: $dayPick)
                .navigationDestination(for: UUID.self) { child in
                    ItemDetail(id: child, day: day, isRoot: false, path: $path, dayPick: $dayPick)
                }
        }
        // No sheet-wide `.tint`: the done tick and "Now" are drawn in
        // `Color.accentColor`, which must stay lime. Each text control tints
        // itself in the label colour instead (ItemDetail, DayPickSheet), and
        // the bar draws its slots in it (VerbBar).
        .sheet(item: $dayPick) { pick in
            dayPicker(pick)
        }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
    }

    /// Reschedule starts on the item's own day (or the day the sheet acts
    /// on, when it has none) and may pick any day, as the web's does. Pause
    /// until starts, at the earliest, tomorrow: a pause has to end after today.
    @ViewBuilder
    private func dayPicker(_ pick: DayPick) -> some View {
        switch pick {
        case .reschedule(let itemID):
            DayPickSheet(title: "Reschedule", confirmVerb: "Move to",
                         initial: planner.item(itemID)?.day ?? planner.actingDay(day), earliest: nil) { picked in
                withAnimation(.snappy) { planner.move(itemID, to: picked.description) }
            }
        case .pauseUntil(let itemID):
            DayPickSheet(title: "Pause until", confirmVerb: "Pause until",
                         initial: planner.today.adding(days: 1), earliest: planner.today.adding(days: 1)) { picked in
                withAnimation(.snappy) { planner.pause(itemID, until: picked.description) }
            }
        }
    }
}
