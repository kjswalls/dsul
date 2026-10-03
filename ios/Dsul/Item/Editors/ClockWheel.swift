import DsulCore
import SwiftUI

/// A time of day on a wheel, as "HH:mm": the Remind sheet's "Nudge me at" and
/// the Time sheet's Specific time. It runs in GMT on a Gregorian calendar
/// (`ItemSheetModel.wheelCalendar`), so "08:00" is 8:00 whatever the phone's
/// zone and a stored value never shifts, with the hour cycle the user picked on
/// the web (`timeFormat`). Always up: a wheel has no empty state, so whether
/// there is a time at all is the sheet's to say. It tints with the sheet
/// around it, which is the label colour, never lime.
struct ClockWheel: View {
    /// Its name to VoiceOver; the wheel draws no label.
    let label: String
    @Binding var time: String
    let timeFormat: TimeFormat

    var body: some View {
        DatePicker(label, selection: Binding(
            // The time is always one; the epoch is only the type's due.
            get: { ItemSheetModel.wheelDate(time) ?? Date(timeIntervalSince1970: 0) },
            set: { time = ItemSheetModel.wheelClock($0) }
        ), displayedComponents: .hourAndMinute)
        .datePickerStyle(.wheel)
        .labelsHidden()
        .environment(\.calendar, ItemSheetModel.wheelCalendar)
        .environment(\.timeZone, ItemSheetModel.wheelCalendar.timeZone)
        .environment(\.locale, .clock(timeFormat))
    }
}

private extension Locale {
    /// The phone's locale with the hour cycle the user picked on the web
    /// (Settings, Your day, Time format), so the wheel and the chip read the
    /// same clock.
    static func clock(_ format: TimeFormat) -> Locale {
        var parts = Locale.Components(locale: .current)
        parts.hourCycle = format == .twentyFourHour ? .zeroToTwentyThree : .oneToTwelve
        return Locale(components: parts)
    }
}
