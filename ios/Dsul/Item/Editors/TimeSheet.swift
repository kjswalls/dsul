import DsulCore
import SwiftUI

/// The Time sheet: the web panel's Time chip (item-dialog.tsx), opened by the
/// time chip and by Time… in Add property, nested in the item sheet
/// (`SheetEditor.time`). A `Form`, titled "Time", with Cancel and Done; what
/// Done sends is `ItemSheetModel.timeCommit`'s, one `time` write with only the
/// keys that moved, and the words are the web's where it has them.
///
/// - **Part of day**: Anytime, Morning, Afternoon and Evening, each a row with
///   the check on where the item will file (`previewBucket`), so 3:00 pm under
///   Morning shows Afternoon checked. A tap that would leave the check where
///   it is changes nothing (`pickBucket`), so what is checked is what Done
///   sends: under a time only Anytime moves it, and a line under the rows says
///   the time sets the part of day. No "No specific bucket" for a habit (design
///   §2.3), whose none drops it from every day's list. Rows, not an inline
///   `Picker`: a habit with none stored has no check, where a `Picker` with no
///   row tagged for its selection logs "the selection is invalid"; and a tap
///   that changes nothing needs no selection written back.
/// - **Specific time**, under Morning, Afternoon and Evening alone: "Add a
///   time" first (a part of day with no time is a real state, and a wheel has
///   no empty one), which brings the wheel up at the part of day's start
///   (`addingTime`); then the wheel (`ClockWheel`, in GMT, with the web's
///   hour cycle) and No specific time. Turning the wheel past the part of
///   day's edge moves the check above it at once. Anytime drops the time.
/// - **Duration**, where the type has a length (`hasDuration`): the web's
///   lengths, and the stored one on a row of its own when it is none of them,
///   checked. Seeded with the stored length, or the type's default when none
///   is stored. No clear, as on the web.
/// - **Leaving.** A swipe down is refused once what the sheet shows moved
///   (`timeMoved`), and Cancel then asks "Discard changes?". A clean sheet
///   closes and sends nothing, a tap that left the check where it was
///   included.
/// - **Lime.** Nothing here is lime: the sheet tints itself in the label
///   colour (Cancel, Done, the checks, Add a time, No specific time, the
///   wheel). Discard is the system red.
struct TimeSheet: View {
    let id: UUID

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss

    /// The item as the sheet opened on it, and the seed and draft taken from
    /// it, each set once in `init` with `State(initialValue:)`, as
    /// ReminderSheet's are: `editorSheet` runs again whenever the planner's
    /// items change and builds a new TimeSheet, and `@State` keeps what the
    /// first one took. A fetch while the sheet is up changes neither (P3);
    /// Done measures against the item as stored then (`timeCommit`).
    @State private var opened: SampleItem?
    @State private var seed: TimeDraft
    @State private var draft: TimeDraft
    @State private var dateAnchored: Bool
    @State private var hasDuration: Bool
    @State private var confirmingDiscard = false
    /// Where VoiceOver goes when the time's rows change under it: to the wheel
    /// after Add a time (or No specific time, the fallback `focusSoon` names),
    /// back to Add a time after No specific time.
    @AccessibilityFocusState private var timeFocus: TimeRow?

    private enum TimeRow: Hashable {
        case addTime, wheel, noTime
    }

    /// `item` and `caps` (the planner's for it) are read here only; a later
    /// init, with the item as it is now or nil, changes nothing the sheet
    /// shows.
    init(id: UUID, opening item: SampleItem?, caps: ItemCaps?) {
        self.id = id
        let typeCaps = caps ?? item.map { DsulCore.caps($0.typeName) }
        let seed = item.flatMap { opening in typeCaps.map { ItemSheetModel.timeSeed(opening, caps: $0) } }
            ?? TimeDraft(bucket: nil, time: nil, duration: 0)
        _opened = State(initialValue: item)
        _seed = State(initialValue: seed)
        _draft = State(initialValue: seed)
        _dateAnchored = State(initialValue: typeCaps?.dateAnchored ?? false)
        _hasDuration = State(initialValue: typeCaps?.hasDuration ?? false)
    }

    /// What the sheet shows moved from how it opened, never the raw draft: a
    /// tap that left the check where it was is not a change
    /// (`ItemSheetModel.timeMoved`).
    private var isDirty: Bool {
        ItemSheetModel.timeMoved(draft: draft, seed: seed, dateAnchored: dateAnchored)
    }

    var body: some View {
        if opened != nil {
            form
        } else {
            // Asked for an item that had already gone: nothing to show.
            Color.clear
                .onAppear { dismiss() }
        }
    }

    private var form: some View {
        let preview = ItemSheetModel.previewBucket(draft, dateAnchored: dateAnchored)
        let showsTime = ItemSheetModel.showsSpecificTime(draft, dateAnchored: dateAnchored)
        return NavigationStack {
            Form {
                Section {
                    ForEach(bucketOrder, id: \.self) { bucket in
                        bucketRow(bucket, checked: preview == bucket)
                    }
                } header: {
                    Text(ItemSheetModel.partOfDayHeader)
                } footer: {
                    if showsTime && draft.time != nil {
                        Text(ItemSheetModel.timeSetsPartOfDay)
                    }
                }

                if showsTime {
                    Section {
                        timeRows
                    } header: {
                        Text(ItemSheetModel.specificTimeHeader)
                    }
                }

                if hasDuration {
                    Section {
                        Picker(ItemSheetModel.durationHeader, selection: $draft.duration) {
                            ForEach(ItemSheetModel.durationChoices(seed: seed.duration), id: \.self) { minutes in
                                Text(ItemSheetModel.durationWord(minutes))
                                    .accessibilityLabel(Text(ItemSheetModel.durationSpoken(minutes)))
                                    .tag(minutes)
                            }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    } header: {
                        Text(ItemSheetModel.durationHeader)
                    }
                }
            }
            .navigationTitle(ItemSheetModel.timeTitle)
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

    /// One part of day: its word and, where the item will file, a check,
    /// which VoiceOver reads as selected. A tap goes through `pickBucket`,
    /// which may change nothing, and then nothing moves, VoiceOver included.
    private func bucketRow(_ bucket: DayBucket, checked: Bool) -> some View {
        Button {
            draft = ItemSheetModel.pickBucket(draft, bucket, dateAnchored: dateAnchored)
        } label: {
            HStack {
                Text(bucket.label)
                Spacer(minLength: 8)
                if checked {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .accessibilityHidden(true)
                }
            }
        }
        .accessibilityAddTraits(checked ? .isSelected : [])
    }

    /// Specific time's rows: Add a time while none is drafted; else the wheel
    /// and No specific time, which takes the time away and brings Add a time
    /// back.
    @ViewBuilder
    private var timeRows: some View {
        if draft.time != nil {
            ClockWheel(label: ItemSheetModel.timeWheelLabel, time: wheelTime,
                       timeFormat: planner.settings.timeFormat)
                .accessibilityFocused($timeFocus, equals: .wheel)
            Button(ItemSheetModel.noSpecificTime) {
                draft.time = nil
                focusSoon(.addTime)
            }
            .accessibilityFocused($timeFocus, equals: .noTime)
        } else {
            Button(ItemSheetModel.addTime) {
                draft = ItemSheetModel.addingTime(draft, dateAnchored: dateAnchored)
                focusSoon(.wheel)
            }
            .accessibilityFocused($timeFocus, equals: .addTime)
        }
    }

    /// The wheel's time: the drafted one, which is always set while the wheel
    /// is up.
    private var wheelTime: Binding<String> {
        Binding(
            get: { draft.time ?? "" },
            set: { draft.time = $0 }
        )
    }

    /// Sends VoiceOver to `row` on the next main-actor turn, once the row it
    /// replaces has gone. Nothing is closing, so there is no 600 ms wait (that
    /// is for a menu or a sheet going). A wheel is a UIKit control whose
    /// columns are separate elements, so focus bound to the whole may find
    /// nothing to land on, and waiting longer wouldn't help. No specific time,
    /// the button right under it, is bound too (`.noTime`): if a device shows
    /// VoiceOver doesn't land on the wheel, Add a time sends it there instead,
    /// a one-line change (README, "Editing an item", check 13).
    private func focusSoon(_ row: TimeRow) {
        Task { @MainActor in
            timeFocus = row
        }
    }

    /// Sends what moved, if anything, through the planner, which asks its
    /// gate again, measured against the item as stored now; then closes.
    /// Nothing is sent once the item has gone.
    private func done() {
        if let stored = planner.item(id),
           let edit = ItemSheetModel.timeCommit(draft: draft, seed: seed, stored: stored,
                                                dateAnchored: dateAnchored) {
            withAnimation(.snappy) { planner.edit(id, edit) }
        }
        dismiss()
    }

    /// Cancel: closes a sheet whose check, time and length are as it opened;
    /// on a changed one, asks first.
    private func cancel() {
        if isDirty {
            confirmingDiscard = true
        } else {
            dismiss()
        }
    }
}
