import Foundation

// Port of lib/project-block.ts, a project's repeating time block in the two
// forms a page needs: whether it has one (`hasTimeBlock`) and the block in
// one line (`timeBlockSummary`, "Weekdays · 6pm–7pm"), with the hours
// (`blockWhen`) and the repeat words (`projectRepeats`) it is built from.
// Keep in step: a change there without the same change here is drift, and the
// phone's project page words its block differently from the web's console.
// Checked against the web by ProjectBlockFixtureTests
// (tests/fixtures/organize/look.json, `blocks`).
//
// The range's dash is the web's en dash (U+2013), the one place it survives
// in the phone's words, and the separator is U+00B7. Read-only on the phone
// (design §1.2): the block's editor is five coupled fields.

/// lib/project-block.ts `hasTimeBlock`: a block renders only when its start,
/// its part of the day AND its repeat are all set (DayItems.swift's own
/// rule). A legacy row missing its repeat draws on no day.
public func hasTimeBlock(_ project: Project) -> Bool {
    func set(_ s: String?) -> Bool { return !(s ?? "").isEmpty }
    return set(project.startTime) && set(project.timeBucket) && set(project.repeatFrequency)
}

/// lib/project-block.ts `minutesOfClock`: "18:30" → minutes after midnight,
/// by the web's `/^(\d{1,2}):(\d{2})/` (so "07:05:00" reads 7:05, and
/// anything else, "noon" or "123:45", reads 0).
public func minutesOfClock(_ time: String) -> Int {
    let b = Array(time.utf8)
    func digit(_ i: Int) -> Int? {
        guard i < b.count, b[i] >= 48, b[i] <= 57 else { return nil }
        return Int(b[i] - 48)
    }
    guard let h0 = digit(0) else { return 0 }
    var hours = h0
    var i = 1
    if let h1 = digit(1) {
        hours = h0 * 10 + h1
        i = 2
    }
    guard i < b.count, b[i] == UInt8(ascii: ":"), let m0 = digit(i + 1), let m1 = digit(i + 2) else { return 0 }
    return hours * 60 + m0 * 10 + m1
}

/// lib/project-block.ts `clockLabel`: minutes after midnight → "6:30pm",
/// "6pm", wrapping past midnight either way.
public func clockLabel(_ minutes: Int) -> String {
    let t = ((minutes % 1440) + 1440) % 1440
    let h = t / 60
    let m = t % 60
    let hour = h % 12 == 0 ? 12 : h % 12
    let mins = m == 0 ? "" : ":" + (m < 10 ? "0\(m)" : "\(m)")
    return "\(hour)\(mins)\(h < 12 ? "am" : "pm")"
}

/// lib/project-block.ts `blockWhen`: "6pm–7pm", the block's hours, the end
/// wrapping past midnight ("11pm–1am"). A missing start reads as midnight
/// and a missing duration as an hour; a 0 stays 0. Always a string, block or
/// not.
public func blockWhen(_ project: Project) -> String {
    let start = minutesOfClock(project.startTime ?? "00:00")
    return "\(clockLabel(start))\u{2013}\(clockLabel(start + (project.duration ?? 60)))"
}

/// One of `projectRepeats`.
public struct ProjectRepeat: Sendable, Hashable {
    /// The `repeatFrequency` value.
    public var value: String
    /// The editor's word for it.
    public var label: String

    public init(value: String, label: String) {
        self.value = value
        self.label = label
    }
}

/// lib/project-block.ts `PROJECT_REPEATS`: the repeats a block can take, in
/// the editor's order and words. `none` is absent on purpose: a block with no
/// repeat renders on no day.
public let projectRepeats: [ProjectRepeat] = [
    ProjectRepeat(value: "daily", label: "Every day"),
    ProjectRepeat(value: "weekdays", label: "Weekdays"),
    ProjectRepeat(value: "weekends", label: "Weekends"),
    ProjectRepeat(value: "monthly", label: "Monthly"),
    ProjectRepeat(value: "custom", label: "Chosen days"),
]

/// lib/project-block.ts `timeBlockSummary`: "Every day · 6pm–7pm", or nil
/// when there is no block (`hasTimeBlock`). A repeat outside the list (a
/// legacy "weekly", or "none", which `hasTimeBlock` still counts) is shown as
/// stored, as the web shows it.
public func timeBlockSummary(_ project: Project) -> String? {
    guard hasTimeBlock(project), let frequency = project.repeatFrequency else { return nil }
    let repeatLabel = projectRepeats.first { $0.value == frequency }?.label ?? frequency
    return "\(repeatLabel) \u{00B7} \(blockWhen(project))"
}
