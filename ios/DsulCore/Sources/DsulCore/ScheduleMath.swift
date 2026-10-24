import Foundation

// The Schedule grid's numbers, and the arithmetic that puts a block on it,
// shared with the web:
// - lib/schedule-constants.ts: the hour height and the block geometry (the
//   lane, the pane's nudge, trim, floor, tall line and wrap width, and the
//   overlap pass's gaps, insets, line heights, shingle step, depth and channel
//   floor);
// - lib/schedule-resize.ts (Week and blocks PR 9, extracted from
//   day-schedule.tsx's resize handles): the 15-minute snap (`snapToQuarter`),
//   `minutesToTime`, and changing a block's length (`resizeDeltaMin`,
//   `resizePreview`, `resizeWrite`, the shortest a grip makes a block and the
//   day's end), with the top grip's part of day from lib/time-bucket.ts
//   `getBucketForTime` (DayBuckets.swift `bucketForTime`);
// - components/views/day-schedule.tsx: the autoscroll ramp, a block's pane
//   and rail on the grid (`paneRect`, the renderer's `startY`, `top` and
//   `height`), the rail, bead and now marker's sizes, and `ECLIPSE_PX`, the
//   hour label the now reading steps over (`eclipsedHour`).
// Every named web constant here (all but the drawing sizes, which are class
// values) is checked against tests/fixtures/day/overlap.json's `constants` by
// OverlapFixtureTests, and the resize helper's against
// tests/fixtures/day/resize.json's by ResizeFixtureTests.
// Keep in step: a change there without the same change here is drift, and a
// block sits at a different height, overlaps differently, or takes another
// length on the phone.

/// Numbers the Schedule grid shares with the web app.
public enum ScheduleMetrics {
    /// lib/schedule-constants.ts `HOUR_PX`.
    public static let hourPx: Double = 75
    /// The 15-minute snap: lib/schedule-resize.ts `RESIZE_SNAP_MIN`, which
    /// the phone's moves take too (design B14).
    public static let snapMin = 15
    /// lib/schedule-resize.ts `RESIZE_MIN_DURATION`: the shortest a grip
    /// makes a block, unless the day ends sooner.
    public static let resizeMinDuration = 15
    /// lib/schedule-resize.ts `DAY_END_MIN`: midnight at the end of the day,
    /// past which no grip moves an edge.
    public static let dayEndMin = 1440
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

/// lib/schedule-resize.ts `snapToQuarter`: the nearest 15 minutes, halves up
/// (JavaScript's `Math.round`, `jsRound`). Not a number reads as 0.
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

/// lib/schedule-resize.ts `minutesToTime`: minutes since midnight as the
/// stored "HH:mm" (570 is "09:30"). For a minute inside the day.
public func minutesToTime(_ minutes: Int) -> String {
    String(format: "%02d:%02d", minutes / 60, minutes % 60)
}

/// The part of day an hour of the grid belongs to: before 12:00 morning,
/// before 17:00 afternoon, else evening. It was day-schedule.tsx's inline
/// `bucketForMin`, which lib/schedule-resize.ts replaced with lib/time-bucket.ts
/// `getBucketForTime` (DayBuckets.swift `bucketForTime`); the two agree at
/// every minute of the day (tests/unit/schedule-resize.test.ts, and
/// ResizeFixtureTests here).
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

// MARK: - Changing a length (lib/schedule-resize.ts)

/// lib/schedule-resize.ts `ResizeEdge`: which grip is dragged. The bottom
/// one changes the length and keeps the start; the top one moves the start
/// and keeps the end.
public enum ResizeEdge: String, Sendable, Hashable, CaseIterable {
    case top, bottom
}

/// lib/schedule-resize.ts `BlockSpan`: a block's place on the grid, its start
/// and its length, in minutes (the start since midnight).
public struct BlockSpan: Sendable, Hashable {
    public var startMin: Int
    public var duration: Int

    public init(startMin: Int, duration: Int) {
        self.startMin = startMin
        self.duration = duration
    }
}

extension TimedEntry {
    /// The block as a grip is pressed on it: the web's resize starts from the
    /// timed entry (its length already the type's default when the item has
    /// none), as the phone's does.
    public var span: BlockSpan { BlockSpan(startMin: startMin, duration: duration) }
}

/// lib/schedule-resize.ts `resizeDeltaMin`: a travel of `deltaPx` points at
/// `hourPx` to the hour, in minutes, not snapped (`(deltaPx / hourPx) * 60`,
/// in that order, so it is the web's to the bit). The phone's travel is the
/// finger's movement plus the scroll's since the grip engaged, at
/// `ScheduleMetrics.hourPx`. A zero hour height answers infinity or NaN, as
/// the TS does; `resizePreview` reads infinity as a travel past a stop and
/// NaN as none.
public func resizeDeltaMin(_ deltaPx: Double, hourPx: Double) -> Double {
    (deltaPx / hourPx) * 60
}

/// The most travel `resizePreview` reads, either way: past a day either edge
/// is already at a stop, and `Int(_:)` traps past `Int.max` where JavaScript
/// would carry the number along.
private let maxResizeTravel: Double = 1_000_000

/// lib/schedule-resize.ts `resizePreview`: where the dragged edge puts a
/// block of `duration` minutes from `startMin`, `deltaMin` minutes from where
/// it was pressed (positive is later). In this order, as the TS:
///
/// - bottom: a start outside the day (before 0:00, or 24:00 and after, as
///   the web's old maths could store) has no length that ends inside it, so
///   the block stays as it was. Otherwise the length plus the travel, snapped
///   to 15 and never under 15, then cut so the end stops at 24:00 (the day
///   wins over the floor, so a block starting after 23:45 runs to midnight
///   and no further). The start stays.
/// - top: the end stays, held to 24:00 (a block stored past midnight comes
///   back to it, so no length is ever over a day, the route's cap). An end
///   at or before 0:00 has no start before it, so the block stays as it was.
///   Otherwise the start plus the travel, snapped to 15, never later than 15
///   minutes before that end, and then never before 0:00 (so a block ending
///   before 0:15 can only start at 0:00). The length is the end less the new
///   start.
///
/// An answer that differs from the block as pressed starts at 0:00 or
/// later, ends at 24:00 or sooner and is at least a minute long, so its write
/// is one the `time` intent takes (`editAllowed`).
///
/// It snaps with no travel too: a block pressed at 9:10 answers 9:15 from the
/// top grip at 0. The web never shows that answer for a press alone, since
/// ScheduleBlock asks only on a pointer move or an autoscroll step, so a
/// press let go unmoved writes nothing; a caller shows the block as pressed
/// (`from`) until the finger or the grid has moved. A travel that is NaN (a
/// zero hour height) reads as none, where `Int(_:)` would trap and the TS
/// answers NaN; an infinite one is a travel past a stop, as in the TS.
public func resizePreview(edge: ResizeEdge, startMin: Int, duration: Int, deltaMin: Double) -> BlockSpan {
    let travel = deltaMin.isNaN ? 0 : min(max(deltaMin, -maxResizeTravel), maxResizeTravel)
    let held = BlockSpan(startMin: startMin, duration: duration)
    switch edge {
    case .bottom:
        if startMin < 0 || startMin >= ScheduleMetrics.dayEndMin { return held }
        let length = max(ScheduleMetrics.resizeMinDuration, snapMinutes(Double(duration) + travel))
        return BlockSpan(startMin: startMin, duration: min(length, ScheduleMetrics.dayEndMin - startMin))
    case .top:
        let end = min(startMin + duration, ScheduleMetrics.dayEndMin)
        if end <= 0 { return held }
        let latest = end - ScheduleMetrics.resizeMinDuration
        let start = max(0, min(snapMinutes(Double(startMin) + travel), latest))
        return BlockSpan(startMin: start, duration: end - start)
    }
}

/// `resizePreview` from a block as it was pressed.
public func resizePreview(edge: ResizeEdge, from span: BlockSpan, deltaMin: Double) -> BlockSpan {
    resizePreview(edge: edge, startMin: span.startMin, duration: span.duration, deltaMin: deltaMin)
}

/// lib/schedule-resize.ts `ResizeWrite`: what letting go of a grip writes,
/// through the `time` intent (POST /api/app/items/:id), whose keys these are.
public enum ResizeWrite: Sendable, Hashable {
    /// The bottom grip: `{"duration": n}`, the length alone.
    case duration(Int)
    /// The top grip: `{"startTime": "HH:mm", "duration": n, "timeBucket": …}`,
    /// the start with its length and the start's part of day, since a time
    /// sent without its bucket beside a stored Anytime is refused
    /// (lib/item-edit.ts `editRefusal`, `invalid`).
    case start(startTime: String, duration: Int, timeBucket: DayBucket)

    /// The same write as the Time chip's edit (ItemEdit.swift), for
    /// `editing`, `editAllowed` and ItemWriteBody.swift: the keys a grip
    /// doesn't send are nil, so they stay off the wire.
    public var edit: ItemEdit {
        switch self {
        case .duration(let duration):
            return .time(bucket: nil, startTime: nil, duration: duration)
        case .start(let startTime, let duration, let timeBucket):
            return .time(bucket: .set(timeBucket.rawValue), startTime: .set(startTime), duration: duration)
        }
    }
}

/// lib/schedule-resize.ts `resizeWrite`: the write a grip ends in, `from` the
/// block as it was pressed `to` where it was let go (`resizePreview`'s
/// answer), or nil when nothing changed. The bottom grip compares the length
/// alone; the top grip both fields, and files the new start under its own
/// part of day (`bucketForTime`, lib/time-bucket.ts `getBucketForTime`).
public func resizeWrite(edge: ResizeEdge, from: BlockSpan, to: BlockSpan) -> ResizeWrite? {
    switch edge {
    case .bottom:
        return to.duration != from.duration ? .duration(to.duration) : nil
    case .top:
        if to == from { return nil }
        let startTime = minutesToTime(to.startMin)
        return .start(startTime: startTime, duration: to.duration, timeBucket: bucketForTime(startTime))
    }
}
