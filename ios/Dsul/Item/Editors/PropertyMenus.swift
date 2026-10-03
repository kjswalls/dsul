import DsulCore
import SwiftUI

// The item sheet's chips that edit by menu, and the "+ Add property" seed at
// the end of the chip row: the web panel's priority, date and times chips and
// its clearing-field seed (components/planner/item-dialog.tsx), whose picks
// write at once. Which chips edit, what the seed holds and every word here are
// ItemSheetModel's (`chipEditor`, `unsetProperties`, `priorityChoices`,
// `timesChoices`, `dateOptions`), so the hosted tests pin them; these only
// draw them.
//
// Each is the editable-chip style: the chip in its 44pt hit frame
// (`chipHit()`) as the menu's label, scaling when pressed (`PressScaleStyle`)
// rather than fading, and drawn in the label colour, never the lime tint. The
// menu tints in the label colour too, so its checkmarks aren't lime. To
// VoiceOver each is one element with its own label, set on the menu itself,
// which adds the button trait. The page binds VoiceOver's focus to each
// (`ItemDetail.chipControl` for the chips, `ItemDetail.chipRow` for Add
// property), so it can land there once a pick has changed the row.

/// The priority chip as a menu: None, Low, Medium and High, the current one
/// checked. A pick writes at once (`onPick`, nil for None); None takes the
/// chip away, and Priority goes back into Add property. Offered on a task, a
/// custom item and a subtask's page, never on a habit (the page asks
/// `chipEditor`).
struct PriorityChipMenu: View {
    let chip: SheetChip
    let item: SampleItem
    let onPick: (String?) -> Void

    var body: some View {
        Menu {
            Picker(ItemSheetModel.seedEntry(.priority),
                   selection: Binding(get: { item.priority }, set: { onPick($0) })) {
                ForEach(ItemSheetModel.priorityChoices) { choice in
                    Text(choice.word)
                        .tag(choice.raw)
                }
            }
            .pickerStyle(.inline)
        } label: {
            ChipView(chip: chip, editable: true)
                .chipHit()
        }
        .menuOrder(.fixed)
        .menuStyle(.button)
        .buttonStyle(PressScaleStyle())
        .tint(Color.primary)
        .accessibilityLabel(Text(chip.spoken))
        .accessibilityHint(Text(ItemSheetModel.chipHint(.priority) ?? ""))
    }
}

/// The date chip as a menu, the bar's Reschedule by another door (Q3 a):
/// Today, Tomorrow and Next week, each with its day under it ("Oct 2"), then
/// Pick a date…, which opens the sheet's day picker titled "Date" (`onPick`
/// with `.pick`). A pick moves the item at once, through `move`. Offered
/// exactly where the Reschedule verb is (the page asks `chipEditor`), so a
/// finished task's date chip, a habit's and a subtask's stay read-only. No
/// checkmark: the web's shortcuts have none, and the chip already says the
/// day. No "No date".
struct DateChipMenu: View {
    let chip: SheetChip
    /// `ItemSheetModel.dateOptions`, worked out by the page as it draws.
    let options: [DateOption]
    let onPick: (DateChoice) -> Void

    var body: some View {
        Menu {
            DateMenuItems(options: options, onPick: onPick)
        } label: {
            ChipView(chip: chip, editable: true)
                .chipHit()
        }
        .menuOrder(.fixed)
        .menuStyle(.button)
        .buttonStyle(PressScaleStyle())
        .tint(Color.primary)
        .accessibilityLabel(Text(chip.spoken))
        .accessibilityHint(Text(ItemSheetModel.chipHint(.date) ?? ""))
    }
}

/// The Date menu's entries, shared by the date chip and Add property's Date ▸:
/// each a button with its word, its day as a second line (a menu button's
/// second `Text` is its subtitle), and its symbol. VoiceOver reads the word
/// and the day ("Tomorrow, Oct 2").
struct DateMenuItems: View {
    let options: [DateOption]
    let onPick: (DateChoice) -> Void

    var body: some View {
        ForEach(options) { option in
            Button {
                onPick(option.choice)
            } label: {
                Label {
                    Text(option.word)
                    if let subtitle = option.subtitle {
                        Text(subtitle)
                    }
                } icon: {
                    Image(systemName: option.symbol)
                }
            }
        }
    }
}

/// A habit's times per day chip ("3×") as a menu: "1× a day" to "5× a day",
/// the current count checked, and a stored count above 5 on a row of its
/// own, checked, so the menu never hides what is stored. A pick writes at
/// once (`onPick`); 1× a day takes the chip away (part 1 shows the count only
/// above 1), and Times per day goes back into Add property. VoiceOver reads
/// each row as "3 times a day".
struct TimesChipMenu: View {
    let chip: SheetChip
    let item: SampleItem
    let onPick: (Int) -> Void

    var body: some View {
        Menu {
            Picker(ItemSheetModel.seedEntry(.timesPerDay),
                   selection: Binding(get: { item.timesPerDay ?? 1 }, set: { onPick($0) })) {
                ForEach(ItemSheetModel.timesChoices(stored: item.timesPerDay), id: \.self) { count in
                    Text(ItemSheetModel.timesWord(count))
                        .accessibilityLabel(Text(ItemSheetModel.timesSpoken(count)))
                        .tag(count)
                }
            }
            .pickerStyle(.inline)
        } label: {
            ChipView(chip: chip, editable: true)
                .chipHit()
        }
        .menuOrder(.fixed)
        .menuStyle(.button)
        .buttonStyle(PressScaleStyle())
        .tint(Color.primary)
        .accessibilityLabel(Text(chip.spoken))
        .accessibilityHint(Text(ItemSheetModel.chipHint(.timesPerDay) ?? ""))
    }
}

/// "+ Add property": the properties that are unset and editable (`kinds`,
/// `ItemSheetModel.unsetProperties`, in chip order). Adding one opens its
/// picker straight away (Kirby, 2026-09-24): a menu property is a submenu set
/// in one pick, listing only what would change it (Priority ▸ Low, Medium,
/// High; Date ▸ Today, Tomorrow, Next week, or Pick a date…, which opens the
/// day picker; Times per day ▸ 2× to 5× a day), Time… opens the Time sheet
/// (`onTime`), and Remind… opens the Remind sheet with its wheel already on a
/// time (`onRemind`). Its plus carries "Add property" while the row has
/// nothing else (`label`), and is bare after the chips; VoiceOver always hears
/// "Add property". No chevron: the plus already says what it does.
struct AddPropertyMenu: View {
    let kinds: [SheetChip.Kind]
    /// `ItemSheetModel.seedLabel`: the words beside the plus, or nil.
    let label: String?
    /// `ItemSheetModel.dateOptions`, for Date ▸.
    let dates: [DateOption]
    let onPriority: (String?) -> Void
    let onDate: (DateChoice) -> Void
    let onTime: () -> Void
    let onTimes: (Int) -> Void
    let onRemind: () -> Void

    var body: some View {
        Menu {
            ForEach(kinds, id: \.self) { kind in
                entry(kind)
            }
        } label: {
            // A hidden line of text sets the capsule's height, so a bare plus
            // stands as tall as the chips beside it.
            ZStack {
                Text(verbatim: "A")
                    .hidden()
                HStack(spacing: 5) {
                    Image(systemName: "plus")
                        .foregroundStyle(.secondary)
                    if let label {
                        Text(label)
                    }
                }
            }
            .font(.subheadline)
            .foregroundStyle(Color.primary)
            .chipBackground()
            .chipHit()
        }
        .menuOrder(.fixed)
        .menuStyle(.button)
        .buttonStyle(PressScaleStyle())
        .tint(Color.primary)
        .accessibilityLabel(Text(ItemSheetModel.seedSpoken))
    }

    /// One property's entry: a submenu for a menu property, a button for the
    /// time and the reminder, each of which opens its sheet. The seed holds no
    /// other kind until 2e.
    @ViewBuilder
    private func entry(_ kind: SheetChip.Kind) -> some View {
        switch kind {
        case .priority:
            Menu(ItemSheetModel.seedEntry(.priority), systemImage: ItemSheetModel.seedSymbol(.priority)) {
                ForEach(ItemSheetModel.priorityChoices.dropFirst()) { choice in
                    Button(choice.word) { onPriority(choice.raw) }
                }
            }
        case .date:
            Menu(ItemSheetModel.seedEntry(.date), systemImage: ItemSheetModel.seedSymbol(.date)) {
                DateMenuItems(options: dates, onPick: onDate)
            }
        case .time:
            Button(ItemSheetModel.seedEntry(.time), systemImage: ItemSheetModel.seedSymbol(.time)) {
                onTime()
            }
        case .timesPerDay:
            Menu(ItemSheetModel.seedEntry(.timesPerDay), systemImage: ItemSheetModel.seedSymbol(.timesPerDay)) {
                ForEach(2...EditLimits.timesPerDayMax, id: \.self) { count in
                    Button {
                        onTimes(count)
                    } label: {
                        Text(ItemSheetModel.timesWord(count))
                            .accessibilityLabel(Text(ItemSheetModel.timesSpoken(count)))
                    }
                }
            }
        case .reminder:
            Button(ItemSheetModel.seedEntry(.reminder), systemImage: ItemSheetModel.seedSymbol(.reminder)) {
                onRemind()
            }
        case .repeats, .project, .routine, .season:
            EmptyView()
        }
    }
}
