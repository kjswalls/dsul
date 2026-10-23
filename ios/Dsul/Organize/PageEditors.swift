import DsulCore
import SwiftUI

// A container page's editors (design §6.3, O8b): the notes (a goal's why) in
// a sheet with a `TextEditor`, a routine's usual time on a wheel, and a
// season's Runs or a goal's window as two optional days. What each offers and
// says is ContainerEditModel (Foundation only, pinned by OrganizePageTests);
// the planner steps and sends the edit (`setNotes`, `setUsualTime`,
// `setSeasonDates`, `setGoalWindow`), so nothing here writes on its own.
//
// Each sheet is a `Form` with Cancel and Done, as the item sheet's editors
// are (TimeSheet): Done sends what moved and nothing when nothing did; a swipe
// down is refused once the draft moved, and Cancel then asks "Discard
// changes?". Nothing here is lime: each sheet tints itself the label colour
// (Cancel, Done, the toggles, the caret), and the calendars the system blue
// the day pickers use (`DayPickSheet.calendarTint`). Discard is the system
// red.

/// A sheet a container page's chips open: Pause until's day picker (O8a), a
/// routine's usual time, a season's Runs or a goal's window (O8b). One slot
/// per page, so one chip row never carries two sheets.
enum ChipSheet: Hashable, Identifiable {
    case pauseUntil(PauseUntilPick)
    case usualTime(UsualTimeEdit)
    case range(RangeEdit)

    var id: Self { self }
}

/// A container's notes on its page, or a goal's why: the text, four lines
/// and Show all (`NotesText`). Where they may be edited the text is a button
/// that opens the notes sheet, and with none there the web's placeholder
/// ("Add a note…", "Why this matters…") stands in `.secondary`, a button
/// too. Notes stored longer than one request may carry are shown, never
/// edited, with the item sheet's words under them.
struct PageNotesView: View {
    /// The notes as the page shows them (trimmed); nil for none.
    let text: String?
    let edit: NotesEdit?
    let onEdit: () -> Void

    var body: some View {
        if let edit, !edit.tooLong {
            if let text {
                NotesText(text: text, onEdit: onEdit, hint: edit.hint)
            } else {
                placeholder(edit)
            }
        } else if let text {
            VStack(alignment: .leading, spacing: 6) {
                NotesText(text: text, onEdit: nil)
                if edit?.tooLong == true {
                    Text(ItemSheetModel.tooLongNote)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// The placeholder, hit over 44pt, though it lays out as one line of
    /// text: a frame, never an overhang into the rows around it.
    private func placeholder(_ edit: NotesEdit) -> some View {
        Button(action: onEdit) {
            Text(edit.placeholder)
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(RowPressStyle(verticalBleed: 0))
        .accessibilityLabel(Text(edit.title))
        .accessibilityHint(Text(edit.hint))
    }
}

/// The notes sheet (O8b): a `TextEditor` titled with the field's name
/// ("Routine note", "Why this goal matters"), the web's placeholder over it
/// while it is empty, focused as it opens. The item sheet's notes behaviour:
/// Return is a line break, typing past what one request may carry is cut
/// (`ContainerEditModel.notesEntry`), and Done sends the notes cleaned
/// (`cleanNotes`: trimmed, blank clears them), nothing when that is what is
/// stored (`SamplePlanner.setNotes`).
///
/// The draft is taken once, in `init`: a fetch while the sheet is up
/// changes nothing it shows.
struct ContainerNotesSheet: View {
    let edit: NotesEdit

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss
    @State private var draft: String
    @State private var confirmingDiscard = false
    @FocusState private var focused: Bool

    init(edit: NotesEdit) {
        self.edit = edit
        _draft = State(initialValue: edit.stored ?? "")
    }

    private var isDirty: Bool { draft != (edit.stored ?? "") }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $draft)
                        .font(.body)
                        .frame(minHeight: 180)
                        .focused($focused)
                        .overlay(alignment: .topLeading) {
                            if draft.isEmpty {
                                // Where the editor's first line starts.
                                Text(edit.placeholder)
                                    .font(.body)
                                    .foregroundStyle(.secondary)
                                    .padding(.top, 8)
                                    .padding(.leading, 5)
                                    .allowsHitTesting(false)
                                    .accessibilityHidden(true)
                            }
                        }
                        .accessibilityLabel(Text(edit.title))
                        .onChange(of: draft) { previous, next in
                            let fitted = ContainerEditModel.notesEntry(previous: previous, next: next)
                            if fitted != next { draft = fitted }
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
            .onAppear { focused = true }
        }
        .tint(Color.primary)
        .interactiveDismissDisabled(isDirty)
        .presentationDetents([.large])
    }

    private func cancel() {
        if isDirty {
            confirmingDiscard = true
        } else {
            dismiss()
        }
    }

    private func done() {
        withAnimation(.snappy) { planner.setNotes(edit.ref, draft) }
        dismiss()
    }
}

/// A routine's usual time (O8b, the web's "Usually at"): the wheel
/// (`ClockWheel`, in GMT, with the web's hour cycle), at the stored time or
/// 9:00 am with none, and "Clear time" where one is stored, which clears it
/// at once. Done sends the wheel's time, nothing when it is what is stored
/// (`SamplePlanner.setUsualTime`). The line under it says what a usual time
/// is: a label and an order, never a member's time.
struct UsualTimeSheet: View {
    let routineId: String
    let edit: UsualTimeEdit

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss
    @State private var time: String
    @State private var confirmingDiscard = false

    init(routineId: String, edit: UsualTimeEdit) {
        self.routineId = routineId
        self.edit = edit
        _time = State(initialValue: edit.initial)
    }

    private var isDirty: Bool { time != edit.initial }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ClockWheel(label: ContainerEditModel.usualTimeTitle, time: $time,
                               timeFormat: planner.settings.timeFormat)
                    if edit.stored != nil {
                        Button(ContainerEditModel.clearTime) { clear() }
                    }
                } footer: {
                    Text(ContainerEditModel.usualTimeNote)
                }
            }
            .navigationTitle(ContainerEditModel.usualTimeTitle)
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
        .presentationDetents([.medium, .large])
    }

    private func cancel() {
        if isDirty {
            confirmingDiscard = true
        } else {
            dismiss()
        }
    }

    private func done() {
        withAnimation(.snappy) { planner.setUsualTime(routineId, time) }
        dismiss()
    }

    private func clear() {
        withAnimation(.snappy) { planner.setUsualTime(routineId, nil) }
        dismiss()
    }
}

/// A season's Runs or a goal's window (O8b): each end a toggle named as the
/// web names it ("Starts" and "Ends", "Started" and "Target"), with its
/// calendar under it while it is on. Switched on, an end starts at today, or
/// at the other end when today would invert the range; each calendar is
/// fenced by the other end, so the range never inverts. Under a season's
/// Runs, the season's own sentence for the draft ("Runs Oct 1 to Mar 15,
/// inclusive. On now."), so clearing an end says at once what the season
/// will do. Done sends both ends together, nothing when they are what is
/// stored (`setSeasonDates`, `setGoalWindow`).
struct RangeSheet: View {
    let edit: RangeEdit

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss
    @State private var draft: RangeDraft
    @State private var confirmingDiscard = false

    init(edit: RangeEdit) {
        self.edit = edit
        _draft = State(initialValue: edit.draft)
    }

    private var isDirty: Bool { draft != edit.draft }

    var body: some View {
        let words = edit.words
        let today = planner.today
        let season: Season? = edit.ref.kind == .season
            ? planner.seasons.first(where: { $0.id == edit.ref.id })
            : nil
        return NavigationStack {
            Form {
                Section {
                    Toggle(words.startLabel, isOn: Binding(
                        get: { draft.start != nil },
                        set: { draft = ContainerEditModel.settingStart(draft, on: $0, today: today) }
                    ))
                    if let start = draft.start {
                        calendar(words.startLabel, day: start, earliest: nil, latest: draft.end) { day in
                            draft = ContainerEditModel.pickingStart(draft, day)
                        }
                    }
                }
                Section {
                    Toggle(words.endLabel, isOn: Binding(
                        get: { draft.end != nil },
                        set: { draft = ContainerEditModel.settingEnd(draft, on: $0, today: today) }
                    ))
                    if let end = draft.end {
                        calendar(words.endLabel, day: end, earliest: draft.start, latest: nil) { day in
                            draft = ContainerEditModel.pickingEnd(draft, day)
                        }
                    }
                } footer: {
                    if let note = ContainerEditModel.rangeNote(edit, draft, season: season, today: today) {
                        Text(note)
                    }
                }
            }
            .navigationTitle(words.title)
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

    /// One end's calendar, on `day`, fenced by the other end: the device's
    /// calendar, as the day pickers read it, in their blue.
    @ViewBuilder
    private func calendar(_ label: String, day: DayString, earliest: DayString?, latest: DayString?,
                          pick: @escaping (DayString) -> Void) -> some View {
        let selection = Binding<Date>(get: { day.localDate() }, set: { pick(DayString(date: $0)) })
        Group {
            if let earliest {
                DatePicker(label, selection: selection, in: earliest.localDate()..., displayedComponents: .date)
            } else if let latest {
                DatePicker(label, selection: selection, in: ...latest.localDate(), displayedComponents: .date)
            } else {
                DatePicker(label, selection: selection, displayedComponents: .date)
            }
        }
        .datePickerStyle(.graphical)
        .labelsHidden()
        .tint(DayPickSheet.calendarTint)
    }

    private func cancel() {
        if isDirty {
            confirmingDiscard = true
        } else {
            dismiss()
        }
    }

    private func done() {
        withAnimation(.snappy) {
            switch edit.ref.kind {
            case .season:
                planner.setSeasonDates(edit.ref.id, startsOn: draft.start, endsOn: draft.end)
            case .goal:
                planner.setGoalWindow(edit.ref.id, startsOn: draft.start, targetOn: draft.end)
            case .routine, .project:
                break
            }
        }
        dismiss()
    }
}
