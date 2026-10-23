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
/// (`pauseRoutine`, `resumeRoutine`). From O8b the usual time chip opens its
/// wheel (`UsualTimeSheet`; "No usual time" where none is set) and the notes
/// open their sheet (`ContainerNotesSheet`); from O9 the bar's ⋯ menu renames
/// it and changes its look (the host's).
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
    /// The sheet a chip opened (Pause until's day picker, the usual time),
    /// while it is up.
    @State private var chipSheet: ChipSheet? = nil
    /// The notes sheet, while it is up.
    @State private var editingNotes: NotesEdit? = nil

    var body: some View {
        Section {
            PageHeaderView(header: page.header)
                .pageTopRow()
            if page.notes != nil || page.edits?.notes != nil {
                PageNotesView(text: page.notes, edit: page.edits?.notes, onEdit: { editingNotes = page.edits?.notes })
                    .pageTopRow()
                    .sheet(item: $editingNotes) { edit in
                        ContainerNotesSheet(edit: edit)
                    }
            }
            PageChipsView(chips: page.chips, status: page.statusMenu, onStatus: { pick($0) },
                          onEdit: { edit($0) })
                .pageTopRow()
                .sheet(item: $chipSheet) { sheet in
                    switch sheet {
                    case .pauseUntil(let day):
                        // The earliest day moves at midnight while it is up.
                        DayPickSheet(words: ContainerPageModel.routinePauseUntilWords, initial: day.initial,
                                     earliest: page.statusMenu?.pauseUntil?.earliest ?? day.earliest) { picked in
                            withAnimation(.snappy) { planner.pauseRoutine(routineId, until: picked) }
                        }
                    case .usualTime(let edit):
                        UsualTimeSheet(routineId: routineId, edit: edit)
                    case .range(let edit):
                        // A season's or a goal's; a routine's chips never open it.
                        RangeSheet(edit: edit)
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
            chipSheet = page.statusMenu?.pauseUntil.map { ChipSheet.pauseUntil($0) }
        case .resume:
            withAnimation(.snappy) { planner.resumeRoutine(routineId) }
        case .state, .goalState:
            // A season's and a goal's; a routine's menu never offers them.
            break
        }
    }

    /// A tap on a chip that edits: the usual time opens its wheel.
    private func edit(_ kind: PageChip.Kind) {
        switch kind {
        case .usualTime:
            chipSheet = page.usualTime.map { ChipSheet.usualTime($0) }
        case .status, .runs, .window, .items, .timeBlock:
            break
        }
    }
}
