import DsulCore
import Foundation

// What the item sheet says and offers, worked out apart from the views so the
// hosted tests can pin it. The rules are the web's, asked of DsulCore:
// lib/item-verbs.ts for the verbs (their gates, labels and details), the
// item-conversations table (Round 3) for which of them sit in the bar, and the
// item panel's property chips (components/planner/item-dialog.tsx, the
// "clearing field") for the chips, in its order, each shown only when set.
// The words are the web's own (DsulCore Cadence.swift, RowMoves.swift); the
// bar shortens a few, and that mapping is here.

/// One thing the sheet can do: the web's verbs it offers, plus Pause until
/// (the `pause` verb with a resume day, which the bar shows as its own slot).
enum SheetVerb: String, Hashable, Sendable, CaseIterable {
    case tick, skip, unskip, pause, pauseUntil, resume, nextDay, reschedule

    /// The web verb whose gate answers for it.
    var verb: VerbID {
        switch self {
        case .tick: .tick
        case .skip: .skip
        case .unskip: .unskip
        case .pause, .pauseUntil: .pause
        case .resume: .resume
        case .nextDay: .nextDay
        case .reschedule: .reschedule
        }
    }

    /// The bar slot it fills. A verb and its opposite share one, so a Skip that
    /// turns into Unskip (or Pause into Resume) keeps its place and VoiceOver's
    /// focus, rather than being torn down and rebuilt.
    var slotID: String {
        switch self {
        case .tick: "tick"
        case .skip, .unskip: "skip"
        case .pause, .resume: "pause"
        case .pauseUntil: "pauseUntil"
        case .nextDay: "nextDay"
        case .reschedule: "reschedule"
        }
    }
}

/// Where the sheet's verbs go: up to three in the bar, the rest of the pause
/// family behind ⋯, or, on a day a recurring item doesn't fall on, a "Not due"
/// line instead of the bar.
struct SheetVerbs: Hashable, Sendable {
    var bar: [SheetVerb]
    var menu: [SheetVerb]
    var notDue: Bool
}

/// Reschedule's menu: wall-clock today, the start of next week, or a day picked.
enum RescheduleChoice: Hashable, Sendable {
    case today, nextWeek, pick
}

/// The sheet's day picker's words: its title, the confirm button's verb
/// before the day ("Move to Thu, Oct 8"), and a note under the calendar.
struct DayPickWords: Hashable, Sendable {
    let title: String
    let confirmVerb: String
    let note: String?
}

/// One property chip: what it says, its symbol, and what VoiceOver says.
struct SheetChip: Identifiable, Hashable, Sendable {
    /// The web panel's properties, in its order: priority leads, the When
    /// cluster follows, the containers come last.
    enum Kind: String, Hashable, Sendable {
        case priority, date, time, timesPerDay, repeats, reminder, project, routine, season
    }

    let kind: Kind
    let text: String
    /// Nil for the project chip, which wears its colour dot instead.
    let systemImage: String?
    let spoken: String

    var id: Kind { kind }
}

/// One day of the streak chip's week.
enum StreakDot: Hashable, Sendable {
    /// Ticked that day.
    case done
    /// Skipped that day.
    case skipped
    /// Today, not ticked or skipped yet.
    case today
    /// Missed, still to come, or a day the habit doesn't fall on: all drawn
    /// alike, as a neutral dot.
    case rest
}

enum ItemSheetModel {
    // MARK: Verbs

    /// The bar and the ⋯ menu for `item` on `ctx`'s day, from the verbs the
    /// planner offers there (`SamplePlanner.offers`, so already narrowed to
    /// what the web's gates and the server allow), in this order:
    /// - paused today (wall-clock, in the user's zone): Resume alone;
    /// - a recurring item on a day it doesn't fall on: no bar, a "Not due"
    ///   line; Pause and Pause until move behind ⋯;
    /// - a habit: Skip or Unskip, Pause, Pause until (its tick is the title's
    ///   circle);
    /// - a one-off task-like item: the tick, Tomorrow, Reschedule;
    /// - a recurring task-like item: the tick, Skip or Unskip, Pause.
    /// ⋯ holds whatever of Pause, Pause until and Reschedule the bar doesn't:
    /// a series' Reschedule (lib/row-moves.ts `canReschedule`) moves its start,
    /// so it waits there rather than beside the day's verbs. A subtask is
    /// offered the tick alone, so it gets the tick alone.
    static func verbs(_ item: SampleItem, _ ctx: VerbContext, offered: [VerbID]) -> SheetVerbs {
        let has = Set(offered)
        let pausedToday = DayString(ctx.todayStr).map { isPausedOn(item, on: $0, timeZone: ctx.timeZone) } ?? false
        if pausedToday {
            return SheetVerbs(bar: has.contains(.resume) ? [.resume] : [], menu: [], notDue: false)
        }
        let pauseFamily: [SheetVerb] = has.contains(.pause) ? [.pause, .pauseUntil] : []
        let overflow: [SheetVerb] = pauseFamily + (has.contains(.reschedule) ? [.reschedule] : [])
        if item.recurs && ctx.occurrence == .absent {
            return SheetVerbs(bar: [], menu: overflow, notDue: true)
        }

        let skipSlot: SheetVerb? = has.contains(.unskip) ? .unskip : (has.contains(.skip) ? .skip : nil)
        let tick: SheetVerb? = has.contains(.tick) ? .tick : nil
        let nextDay: SheetVerb? = has.contains(.nextDay) ? .nextDay : nil
        let reschedule: SheetVerb? = has.contains(.reschedule) ? .reschedule : nil
        let pause: SheetVerb? = has.contains(.pause) ? .pause : nil
        var bar: [SheetVerb]
        if item.isHabit {
            bar = [skipSlot].compactMap { $0 } + pauseFamily
        } else if !item.recurs {
            bar = [tick, nextDay, reschedule].compactMap { $0 }
        } else {
            bar = [tick, skipSlot, pause].compactMap { $0 }
        }
        bar = Array(bar.prefix(3))
        return SheetVerbs(bar: bar, menu: overflow.filter { !bar.contains($0) }, notDue: false)
    }

    /// The web's `onDay` (item-context-menu.tsx): "today" in a label is only
    /// true on today, so off it the word goes ("Skip today" → "Skip").
    static func onDay(_ text: String, _ ctx: VerbContext) -> String {
        let suffix = " today"
        guard ctx.dateStr != ctx.todayStr, text.hasSuffix(suffix) else { return text }
        return String(text.dropLast(suffix.count))
    }

    /// The bar's short words for a verb. The web's own label (DsulCore
    /// `verbLabel`) where it fits, shortened where it doesn't: a one-off's
    /// "Mark done" is "Done", "Move to tomorrow" is "Tomorrow" ("Next day"
    /// when the carry lands later), and " today" goes off today.
    static func barLabel(_ verb: SheetVerb, _ item: SampleItem, _ ctx: VerbContext) -> String {
        switch verb {
        case .tick:
            if !item.recurs { return isDoneOn(item, on: ctx.dateStr) ? "Not done" : "Done" }
            return onDay(verbLabel(.tick, item, ctx), ctx)
        case .skip, .unskip:
            return onDay(verbLabel(verb.verb, item, ctx), ctx)
        case .pause:
            return "Pause"
        case .pauseUntil:
            return "Pause until"
        case .resume:
            return "Resume"
        case .nextDay:
            return verbLabel(.nextDay, item, ctx) == "Move to tomorrow" ? "Tomorrow" : "Next day"
        case .reschedule:
            return verbLabel(.reschedule, item, ctx)
        }
    }

    /// What VoiceOver calls the verb: the web's full label (off today without
    /// " today"), which says more than the bar has room for ("Mark done").
    static func spokenLabel(_ verb: SheetVerb, _ item: SampleItem, _ ctx: VerbContext) -> String {
        switch verb {
        case .tick, .skip, .unskip, .nextDay:
            return onDay(verbLabel(verb.verb, item, ctx), ctx)
        case .pauseUntil:
            return "Pause until a day"
        case .pause, .resume, .reschedule:
            return barLabel(verb, item, ctx)
        }
    }

    /// The carry's landing day ("Fri, Oct 2"), the web's `detail`, which the
    /// bar leaves to VoiceOver. Nil for every other verb.
    static func spokenValue(_ verb: SheetVerb, _ item: SampleItem, _ ctx: VerbContext) -> String? {
        guard verb == .nextDay else { return nil }
        return verbDetail(.nextDay, item, ctx)
    }

    /// The ⋯ menu's words. It only ever holds Pause, Pause until and a
    /// series' Reschedule; the rest are named for completeness.
    static func menuTitle(_ verb: SheetVerb) -> String {
        switch verb {
        case .pause: "Pause"
        case .pauseUntil: "Pause until\u{2026}"
        case .resume: "Resume"
        case .tick: "Done"
        case .skip: "Skip"
        case .unskip: "Unskip"
        case .nextDay: "Tomorrow"
        case .reschedule: "Reschedule"
        }
    }

    /// The verb's SF Symbol.
    static func symbol(_ verb: SheetVerb, _ item: SampleItem, _ ctx: VerbContext) -> String {
        switch verb {
        case .tick: isDoneOn(item, on: ctx.dateStr) ? "arrow.uturn.backward" : "checkmark"
        case .skip: "forward.end"
        case .unskip: "arrow.uturn.backward"
        case .pause: "pause"
        case .pauseUntil: "calendar.badge.clock"
        case .resume: "play"
        case .nextDay: "arrow.right"
        case .reschedule: "calendar"
        }
    }

    /// "For Thu, Oct 8" above the bar when the bar holds a per-day verb (the
    /// tick, Skip, Unskip) that acts on a day other than today, which the
    /// bar's words no longer say. Asked of the bar, not of what is offered: a
    /// habit's tick is the title's circle, never a slot, and Pause, Pause
    /// until and Resume act on today whatever the day, so a bar of those
    /// alone gets no caption. Nil on today and for a one-off (whose tick has
    /// no day).
    static func dayCaption(_ item: SampleItem, _ ctx: VerbContext, bar: [SheetVerb]) -> String? {
        guard ctx.dateStr != ctx.todayStr, item.recurs,
              bar.contains(where: { $0 == .tick || $0 == .skip || $0 == .unskip })
        else { return nil }
        return "For " + formatTargetDay(ctx.dateStr)
    }

    /// "For Wed, Sep 30" under the title when its circle ticks a day other
    /// than today and the bar doesn't hold the tick, so the bar's caption
    /// doesn't speak for it: a habit, whose tick is only ever the circle, or
    /// an item whose bar has given way to Resume. Nil on today, for a one-off
    /// and with no circle.
    static func titleDayNote(_ item: SampleItem, _ ctx: VerbContext, offered: [VerbID],
                             bar: [SheetVerb]) -> String? {
        guard ctx.dateStr != ctx.todayStr, item.recurs, offered.contains(.tick), !bar.contains(.tick)
        else { return nil }
        return "For " + formatTargetDay(ctx.dateStr)
    }

    /// A counted habit's tally on the day beside its title, "1/3", so a tap
    /// on the circle that counts one without finishing the day still shows.
    /// The web panel's count (item-dialog.tsx, beside its −/+ stepper): the
    /// day's stored count, or the target once the day is done with none
    /// stored. Nil unless the type keeps a per-day tally and the item wants
    /// more than one a day.
    static func tally(_ item: SampleItem, on dateStr: String) -> String? {
        guard caps(item.typeName).dailyCounts, let target = item.timesPerDay, target > 1 else { return nil }
        let raw = item.dailyCounts[dateStr] ?? 0
        let count = item.completedDates.contains(dateStr) && raw == 0 ? target : raw
        return "\(count)/\(target)"
    }

    /// The line in place of the bar on a day the item doesn't fall on.
    static func notDueLine(_ ctx: VerbContext) -> String {
        if ctx.dateStr == ctx.todayStr { return "Not due today" }
        return "Not due " + formatTargetDay(ctx.dateStr)
    }

    // MARK: The day picker

    /// Reschedule's picker is titled with the bar's own word for the verb:
    /// "Schedule" for an undated item, which then is scheduled for the day
    /// picked, else "Reschedule", which moves it there.
    static func rescheduleWords(_ item: SampleItem, _ ctx: VerbContext) -> DayPickWords {
        let title = barLabel(.reschedule, item, ctx)
        return DayPickWords(title: title, confirmVerb: title == "Reschedule" ? "Move to" : "Schedule for", note: nil)
    }

    /// Pause until's picker. The day picked is the day the item is back, not
    /// its last day off, which the button alone ("Pause until Thu, Oct 8")
    /// leaves open; the note is the web's own (item-dialog.tsx's picker).
    static let pauseUntilWords = DayPickWords(
        title: "Pause until", confirmVerb: "Pause until",
        note: "It comes back on the day you pick, on its own. Nothing is lost meanwhile.")

    /// What the banner says when Pause until's day is no longer after today:
    /// the picker was left open across midnight. A pause has to end after
    /// today, so nothing is written. Nil while the day may still be picked.
    static func pauseUntilRefusal(_ until: DayString, today: DayString) -> String? {
        guard until <= today else { return nil }
        return "That day is no longer after today, so nothing was paused."
    }

    // MARK: Header

    /// "Habit · Morning routine": the type's noun (the registry's label; a
    /// custom slug capitalised) and the first routine holding the item. The
    /// view upper-cases it, so VoiceOver reads the words as written.
    static func eyebrow(_ item: SampleItem, routineNames: [String]) -> String {
        let type = typeLabel(item.typeName)
        guard let routine = routineNames.first else { return type }
        return type + " \u{00B7} " + routine
    }

    /// The item's own pause, as the web's paused note words it ("Paused until
    /// Oct 8", the resume day by lib/active.ts `formatDay`; "Paused" with no
    /// end). Nil unless paused today in the user's zone. A routine's or a
    /// season's hold is not shown in part 1.
    static func pauseNote(_ item: SampleItem, today todayStr: String, timeZone: String) -> String? {
        guard let today = DayString(todayStr), isPausedOn(item, on: today, timeZone: timeZone) else { return nil }
        if let until = item.pausedUntil, !until.isEmpty { return "Paused until " + formatDay(until) }
        return "Paused"
    }

    // MARK: Chips

    /// The chips, in the web panel's order, each only when set: priority |
    /// date, time, times per day, repeat, reminder | project, routines,
    /// seasons. The streak chip (habits) is drawn ahead of these by the view.
    /// Each asks the registry what the type carries, never the type's name.
    static func chips(_ item: SampleItem, today: DayString, timeFormat: TimeFormat,
                      routineNames: [String], seasonNames: [String]) -> [SheetChip] {
        let typeCaps = caps(item.typeName)
        var out: [SheetChip] = []

        if typeCaps.hasPriority, let word = priorityWord(item.priority) {
            out.append(SheetChip(kind: .priority, text: word, systemImage: "flag", spoken: "\(word) priority"))
        }
        if typeCaps.dateAnchored, let start = item.startDate, let day = DayString(start) {
            let text = relativeDay(day, today: today)
            out.append(SheetChip(kind: .date, text: text, systemImage: "calendar", spoken: "Date: \(text)"))
        }
        if let time = timeText(item, dateAnchored: typeCaps.dateAnchored, timeFormat: timeFormat) {
            out.append(SheetChip(kind: .time, text: time, systemImage: "clock", spoken: "Time: " + spokenRange(time)))
        }
        if typeCaps.dailyCounts, let times = item.timesPerDay, times > 1 {
            out.append(SheetChip(kind: .timesPerDay, text: "\(times)\u{00D7}", systemImage: "arrow.2.squarepath",
                                 spoken: "\(times) times a day"))
        }
        if item.recurs {
            let cadence = cadenceLabel(item)
            out.append(SheetChip(kind: .repeats, text: cadence, systemImage: "repeat", spoken: "Repeats: \(cadence)"))
        }
        if let reminder = reminderText(item, timeFormat: timeFormat) {
            out.append(SheetChip(kind: .reminder, text: reminder, systemImage: "bell",
                                 spoken: "Reminder: " + reminder.replacingOccurrences(of: " \u{00B7} ", with: ", ")))
        }
        if let project = item.project, !project.isEmpty {
            out.append(SheetChip(kind: .project, text: project, systemImage: nil, spoken: "Project: \(project)"))
        }
        if let summary = membershipSummary(routineNames) {
            out.append(SheetChip(kind: .routine, text: summary, systemImage: "checklist",
                                 spoken: spokenMembership(routineNames, one: "Routine", many: "Routines")))
        }
        if let summary = membershipSummary(seasonNames) {
            out.append(SheetChip(kind: .season, text: summary, systemImage: "leaf",
                                 spoken: spokenMembership(seasonNames, one: "Season", many: "Seasons")))
        }
        return out
    }

    /// packages/types `PrioritySchema`'s three, as the panel's chip names them.
    private static func priorityWord(_ raw: String?) -> String? {
        switch raw {
        case "high": "High"
        case "medium": "Medium"
        case "low": "Low"
        default: nil
        }
    }

    /// "Today", "Tomorrow", "Yesterday", else "Thu, Oct 8" (`formatTargetDay`).
    static func relativeDay(_ day: DayString, today: DayString) -> String {
        if day == today { return "Today" }
        if day == today.adding(days: 1) { return "Tomorrow" }
        if day == today.adding(days: -1) { return "Yesterday" }
        return formatTargetDay(day.description)
    }

    /// The Time chip: start to end ("9:00–11:00 am", the clock words of
    /// lib/reminders/copy.ts `formatCueTime` in the user's 12h or 24h), the
    /// end being the start plus the block's length; with no time, the bucket
    /// ("Evening"), but never "Anytime", which says nothing. Shown only where
    /// the web panel shows it: always for a type with no date, else once dated.
    static func timeText(_ item: SampleItem, dateAnchored: Bool, timeFormat: TimeFormat) -> String? {
        if dateAnchored && (item.startDate ?? "").isEmpty { return nil }
        if let start = item.startMin {
            return timeRange(startMin: start, durationMin: item.durationMin, timeFormat: timeFormat)
        }
        guard let bucket = item.bucket, bucket != .anytime else { return nil }
        return bucket.label
    }

    /// "9:00–11:00 am", or "11:00 am–1:00 pm" across noon; "09:00–11:00" on
    /// the 24-hour clock. The start alone for a block with no length.
    static func timeRange(startMin: Int, durationMin: Int, timeFormat: TimeFormat) -> String {
        let start = formatCueTime(minutesToTime(startMin), timeFormat: timeFormat)
        guard durationMin > 0 else { return start }
        let end = formatCueTime(minutesToTime((startMin + durationMin) % (24 * 60)), timeFormat: timeFormat)
        let startParts = start.split(separator: " ")
        let endParts = end.split(separator: " ")
        if startParts.count == 2, endParts.count == 2, startParts[1] == endParts[1] {
            return "\(startParts[0])\u{2013}\(end)"
        }
        return "\(start)\u{2013}\(end)"
    }

    /// A range as VoiceOver should say it: "9:00 to 11:00 am".
    static func spokenRange(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{2013}", with: " to ")
    }

    /// The Remind chip: "After I pour my coffee · 8:00 am", or the time alone
    /// with no cue words. Only for what the registry lets remind
    /// (`isRemindable`: not a subtask) and only with a time set.
    static func reminderText(_ item: SampleItem, timeFormat: TimeFormat) -> String? {
        guard isRemindable(item), let time = item.reminderTime, !time.isEmpty else { return nil }
        let clock = formatCueTime(time, timeFormat: timeFormat)
        let anchor = (item.reminderAnchor ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return anchor.isEmpty ? clock : "After \(anchor) \u{00B7} \(clock)"
    }

    /// "Routine: Wind down", or "Routines: Wind down and 1 more".
    private static func spokenMembership(_ names: [String], one: String, many: String) -> String {
        guard let first = names.first else { return "" }
        if names.count == 1 { return "\(one): \(first)" }
        return "\(many): \(first) and \(names.count - 1) more"
    }

    // MARK: Streak

    /// The streak chip's seven dots: THIS week (the week holding wall-clock
    /// today, starting on the user's Week starts on), first day first. Done
    /// wins over skipped, as the web's `drawnState` reads a day.
    static func weekDots(_ item: SampleItem, today: DayString, weekStartDay: WeekStartDay) -> [StreakDot] {
        let first = weekStartOf(today, weekStartDay)
        return (0..<7).map { (offset: Int) -> StreakDot in
            let day = first.adding(days: offset)
            let key = day.description
            if item.completedDates.contains(key) { return .done }
            if item.skippedDates.contains(key) { return .skipped }
            return day == today ? .today : .rest
        }
    }

    /// "Streak 3; this week: 4 done, 1 skipped" (the skips only when there
    /// are some): the chip as one VoiceOver element.
    static func streakSpoken(streak: Int, dots: [StreakDot]) -> String {
        let done = dots.filter { $0 == .done }.count
        let skipped = dots.filter { $0 == .skipped }.count
        var text = "Streak \(streak); this week: \(done) done"
        if skipped > 0 { text += ", \(skipped) skipped" }
        return text
    }
}
