import Foundation

// The Schedule grid's numbers, and the arithmetic that puts a block on it,
// shared with the web:
// - lib/schedule-constants.ts: the hour height and the block geometry (the
//   lane, the pane's nudge, trim, floor, tall line and wrap width, and the
//   overlap pass's gaps, insets, line heights, shingle step, depth and channel
//   floor);
// - components/views/day-schedule.tsx: the 15-minute snap, the autoscroll
//   ramp, `minToTime`, `bucketForMin`, a block's pane and rail on the grid
//   (`paneRect`, the renderer's `startY`, `top` and `height`), the rail, bead
//   and now marker's sizes, and `ECLIPSE_PX`, the hour label the now reading
//   steps over (`eclipsedHour`).
// Every named web constant here (all but the drawing sizes, which are class
// values) is checked against tests/fixtures/day/overlap.json's `constants` by
// OverlapFixtureTests.
// Keep in step: a change there without the same change here is drift, and a
// block sits at a different height, or overlaps differently, on the phone.

/// Numbers the Schedule grid shares with the web app.
public enum ScheduleMetrics {
    /// lib/schedule-constants.ts `HOUR_PX`.
    public static let hourPx: Double = 75
    /// The 15-minute snap of components/views/day-schedule.tsx.
    public static let snapMin = 15
    /// day-schedule.tsx autoscroll: the edge zone, and the most it moves per 60Hz frame.
    public static let edgeZone: Double = 56
    public static let maxStepPerFrame: Double = 16

    // MARK: A block (lib/schedule-constants.ts)

    /// `LANE_PX`: the lane the rail, bead and now marker live in. A pane starts
    /// this far into its band (or its tile), and so do the hour hairlines.
    public static let lanePx: Double = 12
    /// `PANE_OFFSET`: the pane sits this far below its true start...
    public static let paneOffset: Double = 3
    /// `PANE_TRIM`: ...and this much shorter than its length, so back-to-back
    /// blocks show a seam. The rail and bead ignore both.
    public static let paneTrim: Double = 4
    /// `PANE_MIN_H`: the shortest a pane draws, one line of text (17) plus its
    /// padding. The web's floor, with the overlap pass (design B13).
    public static let paneMinH: Double = 34
    /// `PANE_TALL_H`: a content band this tall or taller adds the second line
    /// (the mono range).
    public static let paneTallH: Double = 56
    /// `PANE_WRAP_PX`: a pane narrower than this (the field's width times the
    /// plan's `widthFraction`, day-schedule.tsx `narrow`) drops the length and
    /// the range, so the title keeps the width.
    public static let paneWrapPx: Double = 200

    // MARK: Overlap (lib/schedule-constants.ts, read by ScheduleOverlap.swift)

    /// `COL_GAP`: the grid showing between two crossing columns.
    public static let colGap: Double = 4
    /// `NEST_PX`: a nested child's left inset in its parent's band, the lane
    /// plus a 2pt seam.
    public static let nestPx: Double = 14
    /// `NEST_RIGHT_PX`: a nested child's right inset.
    public static let nestRightPx: Double = 8
    /// `LINE_H`: one line of block text. A free band shorter than this holds
    /// no title.
    public static let lineH: Double = 17
    /// `BAND_COMFORT`: a free band this tall centres a line with air around it.
    public static let bandComfort: Double = 29
    /// `SHINGLE_PX`: Week's step between overlapping plates.
    public static let shinglePx: Double = 10
    /// `MAX_DEPTH_DAY`: how deep Day nests before a child becomes a sibling.
    public static let maxDepthDay = 2
    /// `MIN_CHANNEL_PX`: the narrowest a channel (lane plus pane) may get.
    public static let minChannelPx: Double = 140

    // MARK: Drawing sizes (components/views/day-schedule.tsx)

    /// The rail's width (`w-[2px]`), drawn from its `railX` left edge.
    public static let railWidth: Double = 2
    /// The start bead's diameter (`h-[6px] w-[6px]`), drawn from its `beadX`
    /// left edge and centred on the block's true start.
    public static let beadSize: Double = 6
    /// The pane's corner radius (`rounded-[5px]`).
    public static let paneRadius: Double = 5
    /// The now marker: a diamond this wide (`h-[7px] w-[7px]`, turned 45°)
    /// centred on the lane's rail, and a stub of rule this long (`w-6`) from
    /// the lane's edge, never across a pane.
    public static let nowDiamondSize: Double = 7
    public static let nowStubWidth: Double = 24
    /// `ECLIPSE_PX`: how close below its hour line the live time may fall
    /// before that hour's label steps aside for the now reading.
    public static let eclipsePx: Double = 34
}

/// A block's pane and rail on the grid, in points from the grid's top: the
/// rail runs the TRUE extent (`startY`, `spanHeight`), and the pane is nudged
/// down by `paneOffset` and trimmed by `paneTrim`, never shorter than
/// `paneMinH`.
public struct PaneRect: Sendable, Hashable {
    /// Where the block's time starts: the rail's top and the bead's centre.
    public var startY: Double
    /// The block's length in points: the rail's height.
    public var spanHeight: Double
    /// The pane's top.
    public var top: Double
    /// The pane's height.
    public var height: Double

    public init(startY: Double, spanHeight: Double, top: Double, height: Double) {
        self.startY = startY
        self.spanHeight = spanHeight
        self.top = top
        self.height = height
    }
}

/// day-schedule.tsx's block arithmetic (`startY`, `spanH`, `top`, `height`),
/// which lib/schedule-overlap.ts's private `paneRect` repeats: a block of
/// `duration` minutes from `startMin` on a grid starting at `gridStartMin`.
public func paneRect(startMin: Int, duration: Int, hourPx: Double = ScheduleMetrics.hourPx,
                     gridStartMin: Int = 0) -> PaneRect {
    paneRect(startMin: Double(startMin), minutes: Double(duration), gridStartMin: Double(gridStartMin), hourPx: hourPx)
}

/// `paneRect` over a length in fractional minutes, which the overlap pass's
/// painted extent is.
func paneRect(startMin: Double, minutes: Double, gridStartMin: Double, hourPx: Double) -> PaneRect {
    let startY = ((startMin - gridStartMin) / 60) * hourPx
    let spanH = (minutes / 60) * hourPx
    return PaneRect(
        startY: startY,
        spanHeight: spanH,
        top: startY + ScheduleMetrics.paneOffset,
        height: max(spanH - ScheduleMetrics.paneTrim, ScheduleMetrics.paneMinH)
    )
}

/// day-schedule.tsx's `eclipsedHour` (a value in the view, no function of its
/// own there): the hour whose gutter label steps aside
/// for the now reading, which happens when the live time is less than
/// `eclipsePx` below that hour's line. Nil when no label needs to: the reading
/// sits clear of every hour mark. The phone's grid always holds the whole day,
/// so `nowMin` is always on it.
public func eclipsedHour(nowMin: Int, hourPx: Double = ScheduleMetrics.hourPx) -> Int? {
    let into = (Double(nowMin % 60) / 60) * hourPx
    guard into < ScheduleMetrics.eclipsePx else { return nil }
    return Int((Double(nowMin) / 60).rounded(.down))
}

public enum TimeBucket: String, Sendable, CaseIterable {
    case morning, afternoon, evening
}

/// JavaScript's `Math.round`: halves round up, toward +infinity, where Swift's
/// `.rounded()` rounds them away from zero. They differ at negative halves
/// (-7.5 is -7 in JS). Like the JS idiom `Math.floor(x + 0.5)` it is off for
/// 0.49999999999999994, which never matters for minutes.
public func jsRound(_ x: Double) -> Double {
    (x + 0.5).rounded(.down)
}

/// day-schedule.tsx `snap`: the nearest 15 minutes.
public func snapMinutes(_ minutes: Double) -> Int {
    // Int() traps on NaN or infinity, where JavaScript would carry NaN along.
    guard minutes.isFinite else { return 0 }
    return Int(jsRound(minutes / Double(ScheduleMetrics.snapMin))) * ScheduleMetrics.snapMin
}

/// Where a block of `durationMin` starts when a finger at `contentY` (grid
/// content space) holds it at `anchor` of its height (0.5 = centred), snapped
/// to 15 minutes and kept inside the day.
public func snappedStart(contentY: Double, hourPx: Double, durationMin: Int, anchor: Double = 0.5) -> Int {
    // Before layout settles the hour height can be 0.
    guard hourPx > 0, contentY.isFinite else { return 0 }
    let pxPerMin = hourPx / 60
    let ghostH = Double(durationMin) * pxPerMin
    let rawMin = (contentY - anchor * ghostH) / pxPerMin
    let snapped = snapMinutes(rawMin)
    return min(max(0, snapped), 24 * 60 - max(ScheduleMetrics.snapMin, durationMin))
}

/// day-schedule.tsx `minToTime`: "HH:mm".
public func minutesToTime(_ minutes: Int) -> String {
    String(format: "%02d:%02d", minutes / 60, minutes % 60)
}

/// day-schedule.tsx `bucketForMin`.
public func bucketForMinute(_ minutes: Int) -> TimeBucket {
    let h = minutes / 60
    return h < 12 ? .morning : h < 17 ? .afternoon : .evening
}

/// One autoscroll step, in points, for a finger at `fingerY` in viewport
/// space, where the visible part of the grid runs from `visibleTop` to
/// `visibleBottom`. Mirrors the web's ramp (a 56pt zone, a third of the depth,
/// capped at 16) and scales it by the frame time so 120Hz scrolls at 60Hz speed.
public func autoscrollStep(fingerY: Double, visibleTop: Double, visibleBottom: Double, dt: Double) -> Double {
    let edge = ScheduleMetrics.edgeZone
    let cap = ScheduleMetrics.maxStepPerFrame
    let k = dt * 60
    if fingerY > visibleBottom - edge {
        return min(cap, (fingerY - (visibleBottom - edge)) / 3) * k
    }
    if fingerY < visibleTop + edge {
        return -min(cap, (visibleTop + edge - fingerY) / 3) * k
    }
    return 0
}

/// A scroll offset kept between the top and the last full screen.
public func clampScrollOffset(_ y: Double, contentH: Double, viewportH: Double) -> Double {
    min(max(0, y), max(0, contentH - viewportH))
}
