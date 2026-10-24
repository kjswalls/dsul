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
///
/// From O12 the steps themselves: the bar's Edit button puts one list of every
/// step, in the routine's own order, in place of Today and Other days, where a
/// drag or VoiceOver's Move up and Move down reorders them (`moveMember`,
/// whose anchor is the step it lands after, never an index). "Add from your
/// items…" opens the picker, whose pick is the item write an add is
/// (`collect`), and the resting rows swipe to Remove, which is that same write
/// the other way. The planner steps and sends each one; a refusal shows as the
/// banner and nothing moves.
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
    /// (O12) The page's Edit mode, the host's, handed down: its one list of
    /// steps in place of Today and Other days.
    @Environment(\.editMode) private var editMode
    /// The sheet a chip opened (Pause until's day picker, the usual time),
    /// while it is up.
    @State private var chipSheet: ChipSheet? = nil
    /// The notes sheet, while it is up.
    @State private var editingNotes: NotesEdit? = nil
    /// (O12) "Add from your items…", while its sheet is up. What it holds is
    /// the picker as the row was tapped; the sheet reads the live one, so a
    /// picked item leaves the list.
    @State private var picking: StepPicker? = nil

    /// Edit mode, as the host handed it down.
    private var editing: Bool { editMode?.wrappedValue.isEditing ?? false }

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

        if editing, let steps = page.steps {
            // (O12) Edit mode: one list of every step in the routine's own
            // order, in place of Today and Other days, under the heading the
            // web's member list carries. A list being reordered says nothing
            // about today, so these rows carry no tick.
            Section {
                if steps.reorders {
                    ForEach(steps.rows) { row in
                        stepRow(row)
                    }
                    // The grips, which the List draws in Edit mode. Only this
                    // branch has them: a grip on a list the server won't
                    // reorder is a grip that does nothing.
                    .onMove { source, destination in
                        guard let move = ContainerEditModel.stepDrag(steps.rows.map(\.id), from: source,
                                                                     to: destination)
                        else { return }
                        send(move)
                    }
                } else {
                    ForEach(steps.rows) { row in
                        stepRow(row)
                    }
                }
            } header: {
                PageSectionHeader(title: ContainerPageModel.itemsTitle)
            }
        } else {
            if let today = page.today {
                Section {
                    ForEach(today.rows) { row in
                        MemberRowView(row: row, onRemove: { remove(row.item.id) })
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
                        MemberRowView(row: row, onRemove: { remove(row.item.id) })
                    }
                } header: {
                    PageSectionHeader(title: ContainerPageModel.otherDaysTitle)
                }
            }
        }

        // (O12) The add row sits in its own section, under the steps and at
        // rest as well as in Edit mode, as the web's "Link existing" pill sits
        // beside its heading at all times. An empty routine says so first, in
        // the same section, so the page doesn't offer a list before it has
        // said there is none. One section for both, in one place: the first
        // pick into an empty routine takes the sentence away and leaves the
        // row where it was, so the picker it presents stays up. An empty
        // routine has no strip, so the sentence still ends its page.
        if page.empty != nil || page.steps?.add != nil {
            Section {
                if let empty = page.empty {
                    PageQuietText(text: empty)
                }
                if page.steps?.add != nil {
                    PageAddRow(title: ContainerEditModel.addStepWord) { picking = page.steps?.add }
                        .sheet(item: $picking) { picker in
                            StepPickerSheet(routineId: picker.routineId, initial: picker)
                        }
                }
            }
        }

        if let strip = page.strip {
            Section {
                DayStripView(strip: strip)
            } header: {
                PageSectionHeader(title: ContainerPageModel.stripTitle)
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

    /// (O12) One row of Edit mode, with its moves and its Remove wired up.
    @ViewBuilder
    private func stepRow(_ row: StepEditRow) -> some View {
        StepRowView(row: row, onMove: { to in send(StepMove(item: row.item.id, to: to)) },
                    onRemove: { remove(row.item.id) })
    }

    /// (O12) One step's move, dragged or spoken. The write names the step it
    /// is to land after, never an index, so what the server does is what was
    /// asked for even where its list is longer than the one on screen.
    private func send(_ move: StepMove) {
        withAnimation(.snappy) { planner.moveMember(routineId, item: move.item, after: move.to.id) }
    }

    /// (O12) Remove, swiped or spoken: the step leaves the routine and the
    /// item itself stays where it is, which is the item write an add is, the
    /// other way round.
    private func remove(_ item: UUID) {
        withAnimation(.snappy) { planner.collect(item, kind: .routine, containerId: routineId, member: false) }
    }
}

/// A step's title with its meta under it, with no circle and no tick: Edit
/// mode's row, and the picker's. Nothing is struck through here, because a
/// list being reordered, and a pool being picked from, say nothing about
/// today.
private struct StepLabel: View {
    let row: MemberRow

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.item.title)
                .foregroundStyle(Color.primary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            if let subline {
                Text(subline)
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
                    .multilineTextAlignment(.leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The hit shape overhangs the label to the row's edges, as the member
        // rows' does, and leaves the layout alone.
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .padding(.vertical, -11)
    }

    /// The meta, then why it is held off, as one line, as the member rows
    /// join them.
    private var subline: String? {
        let parts = [row.meta, row.hiddenNote].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: OrganizeModel.separator)
    }
}

/// (O12) One row of a routine's Edit mode: the step, and the grip the List
/// draws beside it where the order may be written. To VoiceOver it is one
/// element whose named actions are Move up, Move down and Remove, in the
/// design's short words (§6.8), and it opens nothing: a row being reordered
/// is not a row to walk away from.
private struct StepRowView: View {
    let row: StepEditRow
    /// Where this step is to go: Move up's anchor or Move down's.
    let onMove: (StepAnchor) -> Void
    let onRemove: () -> Void

    var body: some View {
        StepLabel(row: row.row)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(row.row.spokenLabel))
            .accessibilityActions {
                if let up = row.moveUp {
                    Button(ContainerEditModel.moveUpWord) { onMove(up) }
                }
                if let down = row.moveDown {
                    Button(ContainerEditModel.moveDownWord) { onMove(down) }
                }
                if row.removable {
                    Button(ContainerEditModel.removeStepWord) { onRemove() }
                }
            }
            .accessibilityInputLabels([Text(row.item.title)])
    }
}

/// (O12) "Add from your items…": the items the routine may take, searched as
/// the web's member picker searches them (`ContainerEditModel.matching`, over
/// the title alone). A pick is the item write an add is (`collect`), which
/// lands the step last in the routine.
///
/// The list is the pool as the planner has it NOW, not the one the row was
/// tapped with: a picked item leaves the list at once and the sheet stays up,
/// as the web's picker does, so several can be added without reopening it. The
/// sheet closes itself once the routine is gone or the write is no longer
/// taken; a refusal shows as the page's banner, which the page shows once the
/// sheet has gone.
private struct StepPickerSheet: View {
    let routineId: String
    /// The pool as the row was tapped: what is drawn while the planner can no
    /// longer say, so the list never blinks empty on its way out.
    let initial: StepPicker

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        let found = live
        let picker = found ?? initial
        let rows = ContainerEditModel.matching(picker.candidates, query: query)
        NavigationStack {
            List {
                if let none = picker.empty {
                    PageQuietText(text: none)
                } else if rows.isEmpty {
                    PageQuietText(text: ContainerEditModel.noStepMatches(query))
                } else {
                    ForEach(rows) { row in
                        Button {
                            add(row.item.id)
                        } label: {
                            StepLabel(row: row)
                        }
                        .buttonStyle(RowPressStyle())
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Text(row.spokenLabel))
                        .accessibilityAddTraits(.isButton)
                        .accessibilityInputLabels([Text(row.item.title)])
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(picker.title)
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: Text(picker.placeholder))
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .tint(Color.primary)
                }
            }
        }
        .tint(Color.primary)
        .presentationDetents([.medium, .large])
        .onChange(of: found == nil) { _, gone in
            if gone { dismiss() }
        }
    }

    /// The pool as the planner has it now; nil once the routine is gone, its
    /// switch is off, or the write is no longer taken. The planner builds the
    /// pool alone, not the page, since this is read on every keystroke.
    private var live: StepPicker? {
        return planner.stepPicker(routineId)
    }

    /// A pick: the step lands last in the routine and the row leaves the list.
    private func add(_ item: UUID) {
        withAnimation(.snappy) { planner.collect(item, kind: .routine, containerId: routineId, member: true) }
    }
}
