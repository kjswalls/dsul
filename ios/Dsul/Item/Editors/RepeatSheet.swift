import Accessibility
import DsulCore
import SwiftUI

/// The Repeat sheet: the web panel's Repeat chip's Custom days keys and
/// Monthly days (item-dialog.tsx), opened by Custom days… and Monthly… in the
/// repeat chip's menu and in Add property's Repeat ▸, nested in the item sheet
/// (`SheetEditor.repeatDetail`). A `Form`, titled "Custom days" or "Monthly",
/// with Cancel and Done; what Done sends is `ItemSheetModel.repeatCommit`'s,
/// one `repeat` write, and the words are the web's where it has them.
///
/// - **Custom days**: seven keys in the user's Week starts on order
///   (`repeatDayKeys`, open question 2), worded as the web's ("Sun" … "Sat").
///   The stored days are picked, or today's alone when none are, as the web
///   picks it. With none picked, "Select at least one day" shows in red under
///   them, VoiceOver says it, and Done is off. From the xxLarge text size up
///   the keys are seven rows with the full day names and a check: there
///   "Wed" needs more than a seventh of the row.
/// - **Monthly**: the days 1 to 31 in seven columns, the stored day picked, or
///   the 1st, with the web's note under them. At the accessibility sizes, a
///   list from Day 1 to Day 31, scrolled to the picked day as it opens.
/// - **Done** writes once, and only when the item would change (a new
///   frequency, new days, a new day), measured against the item as stored
///   then. The web saves each tap; the phone's editor sheets write on Done
///   (open question 3).
/// - **Leaving.** A swipe down is refused once the days or the day moved from
///   how the sheet opened, and Cancel then asks "Discard changes?". A clean
///   sheet closes and sends nothing, so the item keeps its old repeat:
///   picking Custom days… by mistake costs nothing.
/// - **Lime.** Nothing here is lime: the sheet tints itself in the label
///   colour (Cancel, Done, the rows' checks). The picked keys and day are the
///   day picker's system blue under white (`DayPickSheet.calendarTint`, open
///   question 4), which darkens under Increase Contrast. "Select at least one
///   day" and Discard are the system red.
///
/// The toolbar and the discard confirm are TimeSheet's and ReminderSheet's,
/// a third copy on purpose, with Done off while there is nothing to save.
struct RepeatSheet: View {
    let id: UUID
    let detail: RepeatDetail

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

    /// The item as the sheet opened on it, and the seeds and drafts taken
    /// from it, each set once in `init` with `State(initialValue:)`, as
    /// TimeSheet's are: `editorSheet` runs again whenever the planner's items
    /// change and builds a new RepeatSheet, and `@State` keeps what the first
    /// one took. A fetch while the sheet is up changes neither; Done measures
    /// against the item as stored then (`repeatCommit`).
    @State private var opened: SampleItem?
    @State private var openedDays: Set<Int>
    @State private var days: Set<Int>
    @State private var openedMonthDay: Int
    @State private var monthDay: Int
    @State private var confirmingDiscard = false

    /// `item` and `today` are read here only; a later init, with the item as
    /// it is now or nil, changes nothing the sheet shows.
    init(id: UUID, detail: RepeatDetail, opening item: SampleItem?, today: DayString) {
        self.id = id
        self.detail = detail
        let seedDays = item.map { ItemSheetModel.repeatDaysSeed($0, today: today) } ?? []
        let seedDay = item.map { ItemSheetModel.monthDaySeed($0) } ?? 1
        _opened = State(initialValue: item)
        _openedDays = State(initialValue: seedDays)
        _days = State(initialValue: seedDays)
        _openedMonthDay = State(initialValue: seedDay)
        _monthDay = State(initialValue: seedDay)
    }

    /// What the sheet shows moved from how it opened. A clean sheet may still
    /// change the frequency on Done (Custom days… on a daily item), but a
    /// swipe on it sends nothing.
    private var isDirty: Bool {
        detail == .custom ? days != openedDays : monthDay != openedMonthDay
    }

    /// Done waits for a day: Custom days with none picked is no rule at all.
    private var canSave: Bool {
        detail == .monthly || !days.isEmpty
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
        NavigationStack {
            ScrollViewReader { proxy in
                Form {
                    switch detail {
                    case .custom:
                        customDays
                    case .monthly:
                        monthly
                    }
                }
                // At the accessibility sizes Monthly is a list of 31 rows:
                // the picked day opens in view (Day 20, Day 31). Only as it
                // opens; a tap never scrolls.
                .onAppear {
                    guard detail == .monthly, typeSize.isAccessibilitySize else { return }
                    proxy.scrollTo(monthDay, anchor: .center)
                }
            }
            .navigationTitle(ItemSheetModel.repeatTitle(detail))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { cancel() }
                        .tint(Color.primary)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { done() }
                        .tint(Color.primary)
                        .disabled(!canSave)
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

    // MARK: Custom days

    /// The seven keys in one row below xxLarge, else seven rows; under them,
    /// while none is picked, the web's line in its red (`text-destructive`).
    private var customDays: some View {
        let keys = ItemSheetModel.repeatDayKeys(weekStartDay: planner.settings.weekStartDay)
        return Section {
            if typeSize >= .xxLarge {
                ForEach(keys, id: \.self) { day in
                    dayRow(day)
                }
            } else {
                HStack(spacing: 2) {
                    ForEach(keys, id: \.self) { day in
                        dayKey(day)
                    }
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
            }
        } footer: {
            if days.isEmpty {
                Text(ItemSheetModel.selectAtLeastOneDay)
                    .foregroundStyle(.red)
            }
        }
    }

    /// One key: the web's word ("Wed"), a seventh of the row wide and at
    /// least 44pt tall, the system blue under white when picked, else a gray
    /// fill under the label colour. Borderless, since a Form row holding
    /// several buttons fires them all on a tap unless each is. The word
    /// scales down to three quarters rather than truncate (Display Zoom at
    /// xLarge), so a key never reads "W…". VoiceOver hears the day in full
    /// ("Wednesday") and Voice Control takes either.
    private func dayKey(_ day: Int) -> some View {
        let picked = days.contains(day)
        return Button {
            toggle(day)
        } label: {
            Text(ItemSheetModel.repeatDayWord(day))
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .foregroundStyle(picked ? Color.white : Color.primary)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(picked ? DayPickSheet.calendarTint : Color(.tertiarySystemFill)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(Text(ItemSheetModel.repeatDayName(day)))
        .accessibilityInputLabels([Text(ItemSheetModel.repeatDayWord(day)),
                                   Text(ItemSheetModel.repeatDayName(day))])
        .accessibilityAddTraits(picked ? .isSelected : [])
    }

    /// One day as a row, from xxLarge up: its full name and, when picked, a
    /// check (`checkRow`).
    private func dayRow(_ day: Int) -> some View {
        let picked = days.contains(day)
        return Button {
            toggle(day)
        } label: {
            checkRow(ItemSheetModel.repeatDayName(day), checked: picked)
        }
        .accessibilityInputLabels([Text(ItemSheetModel.repeatDayName(day)),
                                   Text(ItemSheetModel.repeatDayWord(day))])
        .accessibilityAddTraits(picked ? .isSelected : [])
    }

    /// Picks `day`, or unpicks it. Unpicking the last says "Select at least
    /// one day" to VoiceOver at once: the line appearing under the keys is
    /// not announced, and Done dimming says nothing by itself.
    private func toggle(_ day: Int) {
        if days.contains(day) {
            days.remove(day)
            if days.isEmpty {
                AccessibilityNotification.Announcement(AttributedString(ItemSheetModel.selectAtLeastOneDay)).post()
            }
        } else {
            days.insert(day)
        }
    }

    // MARK: Monthly

    /// The days 1 to 31 in seven columns below the accessibility sizes, else
    /// 31 rows ("Day 1" … "Day 31"), each carrying its day as its `.id` for
    /// the opening scroll; under them, the web's note.
    private var monthly: some View {
        Section {
            if typeSize.isAccessibilitySize {
                ForEach(1...31, id: \.self) { n in
                    monthRow(n)
                }
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 7), spacing: 0) {
                    ForEach(1...31, id: \.self) { n in
                        monthCell(n)
                    }
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
            }
        } footer: {
            Text(ItemSheetModel.monthlyNote)
        }
    }

    /// One day of the grid: the bare number, as the web's grid shows it, a
    /// seventh of the row wide and 44pt tall; the picked one on a disc of the
    /// system blue under white, the calendar's own picked-day look, the rest
    /// in the label colour on nothing. Borderless, as the keys are. VoiceOver
    /// hears "Day 12", and Voice Control takes "12" or "Day 12".
    private func monthCell(_ n: Int) -> some View {
        let picked = monthDay == n
        let number = String(n)
        return Button {
            monthDay = n
        } label: {
            Text(number)
                .monospacedDigit()
                .foregroundStyle(picked ? Color.white : Color.primary)
                .frame(minWidth: 36, minHeight: 36)
                .background(Circle().fill(picked ? DayPickSheet.calendarTint : Color.clear))
                .frame(maxWidth: .infinity, minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(Text(ItemSheetModel.monthDayWord(n)))
        .accessibilityInputLabels([Text(number), Text(ItemSheetModel.monthDayWord(n))])
        .accessibilityAddTraits(picked ? .isSelected : [])
    }

    /// One day as a row, at the accessibility sizes: "Day 12" and, when
    /// picked, a check (`checkRow`), with its day as its `.id`.
    private func monthRow(_ n: Int) -> some View {
        let picked = monthDay == n
        return Button {
            monthDay = n
        } label: {
            checkRow(ItemSheetModel.monthDayWord(n), checked: picked)
        }
        .accessibilityInputLabels([Text(ItemSheetModel.monthDayWord(n)), Text(String(n))])
        .accessibilityAddTraits(picked ? .isSelected : [])
        .id(n)
    }

    // MARK: Rows, toolbar

    /// A row's label, as TimeSheet's part of day rows draw theirs: the words,
    /// then a check when picked, hidden from VoiceOver, which reads the
    /// selected trait instead ("Wednesday, selected", never "checkmark").
    private func checkRow(_ words: String, checked: Bool) -> some View {
        HStack {
            Text(words)
            Spacer(minLength: 8)
            if checked {
                Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .accessibilityHidden(true)
            }
        }
    }

    /// Sends the repeat if it would change the item, through the planner,
    /// which asks its gate again, measured against the item as stored now;
    /// then closes. Nothing is sent once the item has gone.
    private func done() {
        if let stored = planner.item(id),
           let edit = ItemSheetModel.repeatCommit(detail, days: days, monthDay: monthDay, stored: stored) {
            withAnimation(.snappy) { planner.edit(id, edit) }
        }
        dismiss()
    }

    /// Cancel: closes a sheet whose days or day are as it opened; on a
    /// changed one, asks first.
    private func cancel() {
        if isDirty {
            confirmingDiscard = true
        } else {
            dismiss()
        }
    }
}
