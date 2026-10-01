import Foundation

/// Numbers the Schedule grid shares with the web app.
public enum ScheduleMetrics {
    /// lib/schedule-constants.ts `HOUR_PX`.
    public static let hourPx: Double = 75
    /// The 15-minute snap of components/views/day-schedule.tsx.
    public static let snapMin = 15
    /// day-schedule.tsx autoscroll: the edge zone, and the most it moves per 60Hz frame.
    public static let edgeZone: Double = 56
    public static let maxStepPerFrame: Double = 16
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
    Int(jsRound(minutes / Double(ScheduleMetrics.snapMin))) * ScheduleMetrics.snapMin
}

/// Where a block of `durationMin` starts when a finger at `contentY` (grid
/// content space) holds it at `anchor` of its height (0.5 = centred), snapped
/// to 15 minutes and kept inside the day.
public func snappedStart(contentY: Double, hourPx: Double, durationMin: Int, anchor: Double = 0.5) -> Int {
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
