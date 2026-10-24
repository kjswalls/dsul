import DsulCore
import Foundation

// Week × Schedule's rules (Week and blocks PR 10, design §4.5): how many
// columns show and how wide, which one shows first, how tall the week's
// shared head is, what a strip and a compact block say, and the sideways
// autoscroll's dwell. Foundation only, so the shim tests it on Linux; the
// SwiftUI side is WeekSchedule.swift, ScheduleColumn and BlockView.

enum WeekScheduleRules {
    /// Columns across at the default sizes (Kirby's Q1, three days)...
    static let across = 3
    /// ...and from the first accessibility text size up, two (design §5.10).
    static let acrossAtAccessibilitySizes = 2

    static func across(accessibilitySize: Bool) -> Int {
        return accessibilitySize ? acrossAtAccessibilitySizes : across
    }

    /// How many columns a viewport `viewportW` wide holds at `columnWidth`
    /// each, at least one.
    static func across(viewportW: Double, columnWidth: Double) -> Int {
        guard columnWidth > 0, viewportW.isFinite else { return 1 }
        return max(1, Int((viewportW / columnWidth).rounded()))
    }

    /// The space right of the columns, as Day keeps right of its field.
    static let trailingMargin: Double = 8

    /// A column's width: the columns' viewport (the screen less the gutter
    /// and `trailingMargin`) shared by `across`, so a column keeps it
    /// whatever it holds (design §4.5: about 111pt on a 393pt phone).
    static func columnWidth(viewportW: Double, across: Int) -> Double {
        guard across > 0, viewportW.isFinite else { return 0 }
        return max(0, viewportW / Double(across))
    }

    /// The column at the leading edge for a sideways offset: the nearest
    /// whole column, kept where a full screen of columns still shows.
    static func leadingIndex(offsetX: Double, columnWidth: Double, count: Int, across: Int) -> Int {
        guard columnWidth > 0, offsetX.isFinite, count > 0 else { return 0 }
        let index = Int((offsetX / columnWidth).rounded())
        return min(max(0, index), max(0, count - across))
    }

    /// The column under a point `x` across the columns' content.
    static func columnIndex(atContentX x: Double, columnWidth: Double, count: Int) -> Int {
        guard columnWidth > 0, x.isFinite, count > 0 else { return 0 }
        return min(max(0, Int((x / columnWidth).rounded(.down))), count - 1)
    }

    /// The column Week × Schedule opens on (W15): the selected day as far
    /// toward the leading edge as the week allows, since a scroll view stops
    /// at its end, so the week's last day shows third. The week's first day
    /// when the selection is not in `days`.
    static func openingIndex(selected: DayString, days: [DayString], across: Int) -> Int {
        guard let index = days.firstIndex(of: selected) else { return 0 }
        return min(index, max(0, days.count - across))
    }

    /// The opening column's day (`openingIndex`), to scroll to.
    static func openingDay(selected: DayString, days: [DayString], across: Int) -> DayString? {
        guard !days.isEmpty else { return nil }
        return days[openingIndex(selected: selected, days: days, across: across)]
    }

    // MARK: The strips

    /// A strip's rows, at most; more is a "+N more" line (design §4.5).
    static let stripRows = 3
    /// ...and one from the first accessibility text size up, as Day's band
    /// keeps one there (`AnytimeBandRules.visibleRows`), so the pinned heads
    /// leave the hours their room on a small phone.
    static let stripRowsAtAccessibilitySizes = 1

    static func stripRows(accessibilitySize: Bool) -> Int {
        return accessibilitySize ? stripRowsAtAccessibilitySizes : stripRows
    }

    /// The rows `count` untimed items show in a strip of at most `limit`.
    static func shownRows(_ count: Int, limit: Int = stripRows) -> Int {
        return min(max(0, count), max(0, limit))
    }

    /// The items a strip of at most `limit` rows leaves to its "+N more" line.
    static func overflow(_ count: Int, limit: Int = stripRows) -> Int {
        return max(0, count - max(0, limit))
    }

    /// The overflow line: "+2 more" (the copy inventory). Nil with none.
    static func moreLine(_ count: Int, limit: Int = stripRows) -> String? {
        let more = overflow(count, limit: limit)
        return more > 0 ? "+\(more) more" : nil
    }

    /// One head height for the week (design §4.5): every strip takes the
    /// tallest one's rows, capped at `limit`, and the "+N more" line if any
    /// day has one, so the seven hour grids share one baseline. At least one
    /// row, so a week with nothing untimed still has a strip to drop on.
    static func stripLines(counts: [Int], limit: Int = stripRows) -> (rows: Int, more: Bool) {
        let rows = max(1, counts.map { shownRows($0, limit: limit) }.max() ?? 0)
        let more = counts.contains { overflow($0, limit: limit) > 0 }
        return (rows, more)
    }

    /// An empty strip's word, so the place to drop a time-free item says
    /// what it is: the band's own ("Anytime").
    static var emptyStrip: String { DayBucket.anytime.label }

    // MARK: The compact block

    /// A Week block shows its start time under its title from this length
    /// up (design §4.5, "one line of title; the mono start time under it
    /// from 45 minutes up").
    static let startLineFromMin = 45

    /// The line under a Week block's title: its start in the block's own
    /// clock (`formatClock`, "12:30 pm" or "12:30") from `startLineFromMin`
    /// up, nil below.
    static func startLine(_ block: ScheduleBlock, timeFormat: TimeFormat) -> String? {
        guard block.duration >= startLineFromMin else { return nil }
        return formatClock(block.startMin, timeFormat: timeFormat)
    }
}

/// The dwell behind Week × Schedule's sideways autoscroll (PR 10): while a
/// drag's finger rests in a side edge of the columns, one column that way
/// each `dwell`, never a smooth slide, so the columns stay day-aligned and a
/// finger aiming at the third column has time to let go before anything
/// moves. The zone is narrower than the vertical one (`ScheduleMetrics.
/// edgeZone`, 56pt), which on a 111pt column would be half of it.
struct SideAutoscroll: Equatable, Sendable {
    /// The side zone, from each edge of the columns' viewport.
    static let zone: Double = 32
    /// How long the finger rests in a zone before each step, in seconds.
    static let dwell: Double = 0.6

    /// Which zone the finger is resting in: -1 the leading, 1 the trailing,
    /// 0 neither.
    private(set) var direction = 0
    /// How long it has rested there since the last step.
    private(set) var held: Double = 0

    /// One frame, `dt` seconds long, with the finger `fingerX` across the
    /// columns' viewport, `viewportW` wide: -1 or 1 to step a column that
    /// way, 0 to wait.
    mutating func step(fingerX: Double, viewportW: Double, dt: Double) -> Int {
        let now: Int
        if !fingerX.isFinite || viewportW <= 2 * Self.zone {
            now = 0
        } else if fingerX >= viewportW - Self.zone {
            now = 1
        } else if fingerX <= Self.zone {
            now = -1
        } else {
            now = 0
        }
        guard now != 0 else {
            reset()
            return 0
        }
        if now != direction {
            direction = now
            held = 0
        }
        held += max(0, dt)
        guard held >= Self.dwell else { return 0 }
        held = 0
        return now
    }

    mutating func reset() {
        direction = 0
        held = 0
    }
}
