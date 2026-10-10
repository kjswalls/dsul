import DsulCore
import SwiftUI

/// The Remind sheet: the web panel's Remind popover (item-dialog.tsx), opened
/// by the reminder chip and by Remind… in Add property, nested in the item
/// sheet (`SheetEditor.reminder`). A `Form`, titled "Remind", with Cancel and
/// Done; what Done sends is `ItemSheetModel.reminderCommit`'s, and the words
/// are the web's where it has them.
///
/// - **Nudge me at**: a wheel, always up, on the stored time or, for a new
///   reminder, the item's start time or 9:00, which Done saves untouched
///   (Kirby's rule: adding a property opens its picker straight away). It
///   is the Time sheet's wheel too (`ClockWheel`), and runs in GMT
///   (`ItemSheetModel.wheelCalendar`), so a stored "08:00" is 8:00 whatever
///   the phone's zone, with the hour cycle from the web's Time format. A
///   dated type with no date says under it that it won't fire.
/// - **Right after**: the cue words, one line as the web's input is, sent
///   only when typed in (the seed rule), so a time-only change keeps what is
///   stored. Return lowers the keyboard and leaves the sheet up; nothing is
///   sent until Done.
/// - **The settings lines** (`reminderSettingsLines`), signed in only: Habit
///   reminders off on the web, notifications off in this iPhone's Settings,
///   what can quiet this iPhone's cue or let it ring late, and the last call
///   this iPhone can't ring yet.
/// - **Done** with a time set asks for permission to notify, the first time
///   only (never at launch, never provisionally), then re-plans.
/// - **No reminder**, when the item had one as the sheet opened: turns it
///   off at once, with no confirm, and closes the sheet.
/// - **Leaving.** A swipe down is refused once anything changed, and Cancel
///   then asks "Discard changes?". A clean sheet, a new reminder's included,
///   closes and sends nothing.
/// - **Lime.** Nothing here is lime: the sheet tints itself in the label
///   colour (Cancel, Done, the wheel, the field's caret). No reminder and
///   Discard are the system red.
struct ReminderSheet: View {
    let id: UUID

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss

    /// The item as the sheet opened on it, and the seeds and drafts taken from
    /// it, each set once in `init` with `State(initialValue:)`, as
    /// DayPickSheet's `picked` is. The sheet's content (`editorSheet`) is built
    /// again whenever the planner's items change (a fetch on coming back to
    /// the app, a drain's refetch, a revert), and `@State` keeps what the
    /// first one took, where seeds taken again from the new item would make
    /// an untouched sheet dirty. So a fetch while the sheet is up changes
    /// neither the seeds nor the drafts, and a sheet whose item went keeps
    /// drawing it.
    @State private var opened: SampleItem?
    /// The stored time as the sheet opened (`reminderSeedTime`): nil for a
    /// new reminder.
    @State private var timeSeed: String?
    /// The stored words as the sheet opened, "" for none.
    @State private var anchorSeed: String
    /// What the wheel opened on (`reminderOpeningTime`).
    @State private var openingTime: String
    @State private var timeDraft: String
    @State private var anchorDraft: String
    @State private var confirmingDiscard = false
    @FocusState private var anchorFocused: Bool

    /// `item` is read here alone; a later init, with the item as it is now or
    /// nil, changes nothing the sheet shows.
    init(id: UUID, opening item: SampleItem?) {
        self.id = id
        let opening = item.map { ItemSheetModel.reminderOpeningTime($0) } ?? "09:00"
        let anchor = item?.reminderAnchor ?? ""
        _opened = State(initialValue: item)
        _timeSeed = State(initialValue: item.flatMap { ItemSheetModel.reminderSeedTime($0) })
        _anchorSeed = State(initialValue: anchor)
        _openingTime = State(initialValue: opening)
        _timeDraft = State(initialValue: opening)
        _anchorDraft = State(initialValue: anchor)
    }

    /// Measured from how the sheet opened, so a new reminder's first time is
    /// not a change, and closes freely.
    private var isDirty: Bool {
        timeDraft != openingTime || anchorDraft != anchorSeed
    }

    var body: some View {
        if let opened {
            form(opened)
        } else {
            // Asked for an item that had already gone: nothing to show.
            Color.clear
                .onAppear { dismiss() }
        }
    }

    private func form(_ opened: SampleItem) -> some View {
        // What is stored now, read whenever the sheet is drawn.
        let current = planner.item(id) ?? opened
        let needsDate = reminderNeedsDate(current, caps: planner.caps(for: current))
        let lines = ItemSheetModel.reminderSettingsLines(remindersEnabled: planner.settings.remindersEnabled,
                                                         permission: NotificationHub.shared.permission,
                                                         lastCallEnabled: planner.settings.lastCallEnabled,
                                                         live: planner.isLive)
        return NavigationStack {
            Form {
                Section {
                    ClockWheel(label: ItemSheetModel.reminderTimeLabel, time: $timeDraft,
                               timeFormat: planner.settings.timeFormat)
                } header: {
                    Text(ItemSheetModel.reminderTimeHeader)
                } footer: {
                    if needsDate {
                        Text(ItemSheetModel.reminderNeedsDateNote)
                    }
                }

                anchorSection(opened)

                if !lines.isEmpty {
                    Section {
                        ForEach(lines, id: \.self) { line in
                            Text(line)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if timeSeed != nil {
                    Section {
                        Button(ItemSheetModel.noReminder, role: .destructive) {
                            turnOff()
                        }
                    }
                }
            }
            .navigationTitle(ItemSheetModel.reminderTitle)
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
        .task {
            if planner.isLive { await NotificationHub.shared.refreshPermission() }
        }
        .interactiveDismissDisabled(isDirty)
        .presentationDetents([.large])
    }

    /// Right after: the field, with the web's placeholder and, under it, what
    /// the words are for; or, for words stored longer than one request may
    /// carry, the words as text and a line saying so, and nothing to send.
    /// A time is always set here, so the field always shows (P8).
    @ViewBuilder
    private func anchorSection(_ opened: SampleItem) -> some View {
        if ItemSheetModel.anchorTooLong(opened.reminderAnchor) {
            Section {
                Text(opened.reminderAnchor ?? "")
            } header: {
                Text(ItemSheetModel.reminderAnchorHeader)
            } footer: {
                Text(ItemSheetModel.tooLongNote)
            }
        } else {
            Section {
                TextField(ItemSheetModel.reminderAnchorHeader, text: $anchorDraft,
                          prompt: Text(ItemSheetModel.reminderAnchorPlaceholder))
                    .submitLabel(.done)
                    .focused($anchorFocused)
                    .onSubmit { anchorFocused = false }
                    .onChange(of: anchorDraft) { previous, next in
                        let limit = growthLimit(cap: EditLimits.anchor, stored: opened.reminderAnchor)
                        let entry = ItemSheetModel.anchorEntry(previous: previous, next: next, limit: limit)
                        if entry != next { anchorDraft = entry }
                    }
            } header: {
                Text(ItemSheetModel.reminderAnchorHeader)
            } footer: {
                Text(ItemSheetModel.reminderAnchorHint)
            }
        }
    }

    /// Sends what changed, if anything, through the planner, which asks its
    /// gate again, measured against the item as stored now; then closes.
    private func done() {
        if let stored = planner.item(id),
           let edit = ItemSheetModel.reminderCommit(timeDraft: timeDraft, timeSeed: timeSeed,
                                                    anchorDraft: anchorDraft, anchorSeed: anchorSeed,
                                                    stored: stored) {
            withAnimation(.snappy) { planner.edit(id, edit) }
        }
        if planner.isLive {
            Task { await NotificationHub.shared.askPermissionIfNeeded() }
        }
        dismiss()
    }

    /// No reminder: off at once, both columns cleared, and the sheet closes.
    private func turnOff() {
        if let stored = planner.item(id),
           let edit = ItemSheetModel.reminderCommit(timeDraft: nil, timeSeed: timeSeed,
                                                    anchorDraft: anchorDraft, anchorSeed: anchorSeed,
                                                    stored: stored) {
            withAnimation(.snappy) { planner.edit(id, edit) }
        }
        dismiss()
    }

    /// Cancel: closes a clean sheet; on a changed one, asks first.
    private func cancel() {
        if isDirty {
            confirmingDiscard = true
        } else {
            dismiss()
        }
    }
}
