import DsulCore
import SwiftUI

/// A routine's page (O2, design §6.3): the header, its notes, the Usual time
/// and Status chips with the paused or held note under them, the seasons that
/// hold it, today's members in its own order with their ticks and the web's
/// empty and finished lines, the members on other days with their cadence,
/// and the last 14 days. What shows is `ContainerPageModel.routinePage`.
///
/// From O8a the Status chip is a menu where the server takes the write:
/// Pause, or Resume, and Pause until…, which opens the item sheet's day
/// picker (`DayPickSheet`) on this page, titled "Pause until". Nothing is
/// written until its button names the day; the planner steps and sends it
/// (`pauseRoutine`, `resumeRoutine`).
struct RoutinePageView: View {
    let id: String
    @Binding var path: [OrganizeRoute]

    var body: some View {
        OrganizePageHost(route: .container(.routine, id: id), path: $path,
                         load: { $0.routinePage(id) }) { (page: RoutinePage) in
            RoutinePageRows(routineId: id, page: page)
        }
    }
}

private struct RoutinePageRows: View {
    /// The routine this page shows.
    let routineId: String
    let page: RoutinePage

    @Environment(SamplePlanner.self) private var planner
    /// Pause until's day picker, while it is up.
    @State private var pickingDay: PauseUntilPick? = nil

    var body: some View {
        Section {
            PageHeaderView(header: page.header)
                .pageTopRow()
            if let notes = page.notes {
                NotesText(text: notes, onEdit: nil)
                    .pageTopRow()
            }
            PageChipsView(chips: page.chips, status: page.statusMenu, onStatus: { pick($0) })
                .pageTopRow()
                .sheet(item: $pickingDay) { day in
                    // The earliest day moves at midnight while it is up.
                    DayPickSheet(words: ContainerPageModel.routinePauseUntilWords, initial: day.initial,
                                 earliest: page.statusMenu?.pauseUntil?.earliest ?? day.earliest) { picked in
                        withAnimation(.snappy) { planner.pauseRoutine(routineId, until: picked) }
                    }
                }
            if let note = page.statusNote {
                PageQuietText(text: note)
                    .pageTopRow()
            }
        }

        Section {
            ForEach(page.heldBy) { row in
                ContainerLinkRow(row: row)
            }
            if let none = page.heldByEmpty {
                PageQuietText(text: none)
            }
        } header: {
            PageSectionHeader(title: ContainerPageModel.heldByTitle)
        }

        if let today = page.today {
            Section {
                ForEach(today.rows) { row in
                    MemberRowView(row: row)
                }
                if let empty = today.empty {
                    PageQuietText(text: empty)
                }
            } header: {
                PageSectionHeader(title: ContainerPageModel.todayTitle, trailing: today.summary)
            } footer: {
                if let finished = today.finished {
                    Text(finished)
                }
            }
        }

        if !page.otherDays.isEmpty {
            Section {
                ForEach(page.otherDays) { row in
                    MemberRowView(row: row)
                }
            } header: {
                PageSectionHeader(title: ContainerPageModel.otherDaysTitle)
            }
        }

        if let strip = page.strip {
            Section {
                DayStripView(strip: strip)
            } header: {
                PageSectionHeader(title: ContainerPageModel.stripTitle)
            }
        }

        if let empty = page.empty {
            Section {
                PageQuietText(text: empty)
            }
        }
    }

    /// A Status pick: Pause and Resume at once, Pause until… by its picker.
    private func pick(_ action: StatusAction) {
        switch action {
        case .pause:
            withAnimation(.snappy) { planner.pauseRoutine(routineId, until: nil) }
        case .pauseUntil:
            pickingDay = page.statusMenu?.pauseUntil
        case .resume:
            withAnimation(.snappy) { planner.resumeRoutine(routineId) }
        case .state:
            // A season's; a routine's menu never offers it.
            break
        }
    }
}
