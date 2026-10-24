import DsulCore
import SwiftUI

/// A season's page (O2, design §6.3): the header, its notes, the Status chip
/// (and Runs under Dates) with the web's sentence for its state, the routines
/// it holds (each pushing its page), its own items, and the last 14 days over
/// its items and its routines' items. What shows is
/// `ContainerPageModel.seasonPage`.
///
/// From O8a the Status chip is a menu of the three states where the server
/// takes the write; a pick is sent as picked (`setSeasonState`), and the
/// sentence under it follows the stepped season. From O8b, under Dates, the
/// Runs chip opens its two days (`RangeSheet`; "Runs" where none is set) and
/// the notes open their sheet (`ContainerNotesSheet`); from O9 the bar's ⋯
/// menu renames it and changes its look (the host's).
///
/// From O13 the Routines section is editable where the server takes
/// `holdRoutine`: "Add a routine…" opens the live routines this season doesn't
/// hold, and a pick that would take items off today asks first, in the web's
/// words ("This will hide 3 items for now"), with "Add it anyway" against the
/// system's Cancel. Swipe Take out hands a routine back; it asks nothing,
/// because nothing is hidden by it. The planner steps and sends both
/// (`holdRoutine`); a refusal shows as the banner and the section is as it
/// was.
struct SeasonPageView: View {
    let id: String
    @Binding var path: [OrganizeRoute]

    var body: some View {
        OrganizePageHost(route: .container(.season, id: id), path: $path,
                         load: { $0.seasonPage(id) }) { (page: SeasonPage) in
            SeasonPageRows(seasonId: id, page: page)
        }
    }
}

private struct SeasonPageRows: View {
    /// The season this page shows.
    let seasonId: String
    let page: SeasonPage

    @Environment(SamplePlanner.self) private var planner
    /// Runs' sheet, while it is up.
    @State private var chipSheet: ChipSheet? = nil
    /// The notes sheet, while it is up.
    @State private var editingNotes: NotesEdit? = nil
    /// (O13) "Add a routine…", while its list is up.
    @State private var adding: SeasonRoutinesEdit? = nil
    /// (O13) A routine picked whose join would take items off today, held
    /// while the sheet goes: a confirm cannot come up under one.
    @State private var picked: AttachConfirm? = nil
    /// (O13) That confirm, while it is up.
    @State private var confirming: AttachConfirm? = nil

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
                    if case .range(let edit) = sheet {
                        RangeSheet(edit: edit)
                    }
                }
            PageQuietText(text: page.stateNote)
                .pageTopRow()
        }

        if !page.routines.isEmpty || page.routinesEdit != nil {
            Section {
                ForEach(page.routines) { row in
                    // Take out only where the season may hand the routine
                    // back; everywhere else the row is a link and no more.
                    if page.routinesEdit != nil {
                        ContainerLinkRow(row: row, onTakeOut: { takeOut(row.containerId) })
                    } else {
                        ContainerLinkRow(row: row)
                    }
                }
                // (O13) The add row is last, and is drawn with nothing left to
                // add too, saying so, as the web's pill is.
                if let add = page.routinesEdit {
                    PageAddRow(title: add.title, none: add.none) { adding = add }
                        .sheet(item: $adding, onDismiss: { ask() }) { list in
                            RoutineChoiceSheet(edit: list, onPick: { choose($0) })
                        }
                        .confirmationDialog(confirming?.title ?? "", isPresented: Binding(
                            get: { confirming != nil },
                            set: { shown in if !shown { confirming = nil } }
                        ), titleVisibility: .visible, presenting: confirming) { confirm in
                            Button(confirm.confirmLabel) { attach(confirm.routineId) }
                            Button("Cancel", role: .cancel) {}
                        } message: { confirm in
                            Text(confirm.message)
                        }
                }
            } header: {
                PageSectionHeader(title: OrganizeModel.pluralNoun(.routine))
            }
        }

        if !page.items.isEmpty {
            Section {
                ForEach(page.items) { row in
                    MemberRowView(row: row)
                }
            } header: {
                PageSectionHeader(title: ContainerPageModel.itemsTitle)
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

    /// A Status pick: the state picked, sent as it is.
    private func pick(_ action: StatusAction) {
        switch action {
        case .state(let state):
            withAnimation(.snappy) { planner.setSeasonState(seasonId, state) }
        case .pause, .pauseUntil, .resume, .goalState:
            // A routine's and a goal's; a season's menu never offers them.
            break
        }
    }

    /// A tap on a chip that edits: Runs opens its two days.
    private func edit(_ kind: PageChip.Kind) {
        switch kind {
        case .runs:
            chipSheet = page.runs.map { ChipSheet.range($0) }
        case .usualTime, .status, .window, .items, .timeBlock:
            break
        }
    }

    /// (O13) Take out: the routine leaves this season and goes on running on
    /// its own. It asks nothing, because nothing the user can see is hidden by
    /// it; what the season was holding off comes back.
    private func takeOut(_ routineId: String) {
        withAnimation(.snappy) { planner.holdRoutine(seasonId, routineId: routineId, hold: false) }
    }

    /// (O13) A routine picked in the sheet: sent at once where the join would
    /// hide nothing on today, else held until the sheet has gone, since a
    /// confirm cannot come up under a sheet.
    private func choose(_ routineId: String) {
        guard let confirm = ContainerEditModel.attachConfirm(seasonId, routineId: routineId,
                                                             planner.organizeSnapshot)
        else {
            attach(routineId)
            return
        }
        picked = confirm
    }

    /// (O13) The sheet has gone: ask what it left to ask.
    private func ask() {
        guard let confirm = picked else { return }
        picked = nil
        confirming = confirm
    }

    /// (O13) The hold, sent: picked outright, or confirmed. The planner asks
    /// its gate and the routine again, so a switch turned off, or a season or
    /// routine gone since the sheet opened, shows as the banner and writes
    /// nothing.
    private func attach(_ routineId: String) {
        withAnimation(.snappy) { planner.holdRoutine(seasonId, routineId: routineId, hold: true) }
    }
}

/// (O13) "Add a routine…": the live routines this season doesn't hold, in the
/// routines' own order, each as its tile and its name, as the web's candidate
/// rows are. A pick goes to `onPick` and closes the sheet; nothing is written
/// here, because what a pick asks first is the page's to ask.
///
/// With none left the sheet is the web's line in place of the rows. It is
/// reachable only through the add row, which is itself inert then, so this is
/// the belt to that braces.
private struct RoutineChoiceSheet: View {
    let edit: SeasonRoutinesEdit
    let onPick: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let none = edit.none {
                    PageQuietText(text: none)
                } else {
                    ForEach(edit.candidates) { choice in
                        Button {
                            onPick(choice.id)
                            dismiss()
                        } label: {
                            RoutineChoiceLabel(choice: choice)
                        }
                        .buttonStyle(RowPressStyle())
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(Text(choice.name))
                        .accessibilityAddTraits(.isButton)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(ContainerEditModel.addRoutineTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .tint(Color.primary)
                }
            }
        }
        .tint(Color.primary)
        .presentationDetents([.medium, .large])
    }
}

/// (O13) One routine to pick: its tile and its name, nothing else. Hue is on
/// the tile and its glyph alone, as every container row draws it.
private struct RoutineChoiceLabel: View {
    let choice: RoutineChoice

    var body: some View {
        HStack(spacing: 12) {
            ContainerTile(symbol: choice.symbol, accent: choice.accent)
            Text(choice.name)
                .foregroundStyle(Color.primary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
        // The hit shape overhangs the label to the row's edges, as the member
        // rows' does, and leaves the layout alone.
        .padding(.vertical, 11)
        .contentShape(Rectangle())
        .padding(.vertical, -11)
    }
}
