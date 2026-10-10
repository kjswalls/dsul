import Foundation

// Port of lib/reminders/copy.ts: what a nudge actually says. Keep in step: a
// change there without the same change here is drift, and the phone's lock
// screen words a cue differently from the web's push. Checked against the web
// by CopyFixtureTests (tests/fixtures/day/copy.json), which also holds every
// line here to the copy contract's own pattern (NEVER_SCOLDS).
//
// THE COPY CONTRACT, as copy.ts states it: name the behavior, never the
// failure ("Vitamins", not "You still haven't taken your vitamins"), and state
// a stake only as a fact, never as a threat ("12 days", not "Don't lose your
// streak!"). The words are the intervention, so no surface composes its own.
//
// Ported: `streakPhrase`, `reminderCopy`, `lastCallCopy` and `EOD_COPY`
// (`eodCopy`). `formatCueTime` is already in Cadence.swift and is reused, not
// re-ported. Not ported: `spokenLine` and `smsLine`, the speaker's and the
// text message's registers, which take lib/reminders/nudge.ts's `Nudge` and
// which no phone surface says.

/// Interpunct with spaces, the separator the app's chips already use.
let reminderDot = " \u{00B7} "

/// How many names the last call spells out before it starts counting instead.
let lastCallNameLimit = 3

/// A notification's two lines, as copy.ts returns them: `{ title, body }`.
public struct NotificationText: Sendable, Hashable {
    public var title: String
    public var body: String

    public init(title: String, body: String) {
        self.title = title
        self.body = body
    }
}

/// lib/reminders/copy.ts `streakPhrase`: "12 days", "1 day", the stake stated
/// as the fact it is.
public func streakPhrase(_ streak: Int) -> String {
    return "\(streak) \(streak == 1 ? "day" : "days")"
}

/// lib/reminders/copy.ts `reminderCopy`: the cue notification. The title is
/// the item alone; the body leads with the implementation intention when there
/// is one, else the stated time in the user's format, then the streak when
/// there is one ("7:30 am · 12 days"). An empty `at` (a snooze on an item with
/// no cue of its own) echoes no time.
public func reminderCopy(_ candidate: ReminderCandidate, timeFormat: TimeFormat = .twelveHour) -> NotificationText {
    var parts: [String] = []
    if let anchor = truthyText(candidate.anchor) {
        parts.append(anchor)
    } else if !candidate.at.isEmpty {
        parts.append(formatCueTime(candidate.at, timeFormat: timeFormat))
    }
    let streak = streakOf(candidate.item)
    if streak > 0 { parts.append(streakPhrase(streak)) }
    return NotificationText(title: candidate.item.title, body: parts.joined(separator: reminderDot))
}

/// lib/reminders/copy.ts `lastCallCopy`: the streak-at-risk last call, ONE
/// message naming what is still open ("Reading, Stretch and 2 more · 12 days
/// riding on it"), the first item's streak as the stake. Nil when nothing is
/// open: the caller sends nothing at all, never a cheerful "all done!".
public func lastCallCopy(_ items: [Item]) -> NotificationText? {
    guard let first = items.first else { return nil }

    let named = items.prefix(lastCallNameLimit).map(\.title)
    let rest = items.count - named.count
    let list: String
    if rest > 0 {
        list = "\(named.joined(separator: ", ")) and \(rest) more"
    } else if named.count == 1 {
        list = named[0]
    } else {
        list = "\(named.dropLast().joined(separator: ", ")) and \(named[named.count - 1])"
    }

    let top = streakOf(first)
    let body = top > 0 ? "\(list)\(reminderDot)\(streakPhrase(top)) riding on it" : list
    return NotificationText(title: items.count == 1 ? "Still open today" : "\(items.count) still open", body: body)
}

/// lib/reminders/copy.ts `EOD_COPY`: the end-of-day review's invitation,
/// word for word. It asks; it does not tally the day.
public let eodCopy = NotificationText(title: "End of day \u{1F319}", body: "How'd today go?")
