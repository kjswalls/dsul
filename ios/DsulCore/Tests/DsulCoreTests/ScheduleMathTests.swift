import Testing
import DsulCore

@Suite struct ScheduleMathTests {
    @Test func jsRoundRoundsHalvesUp() {
        #expect(jsRound(7.5) == 8)
        #expect(jsRound(7.4) == 7)
        #expect(jsRound(-7.5) == -7)
        #expect(jsRound(-7.6) == -8)
    }

    @Test func snapsToFifteenMinutes() {
        #expect(snapMinutes(7.5) == 15)
        #expect(snapMinutes(7.4) == 0)
        #expect(snapMinutes(-7.5) == 0)
        #expect(snapMinutes(52) == 45)
        #expect(snapMinutes(53) == 60)
    }

    @Test func snappedStartCentresTheBlockOnTheFinger() {
        let px = ScheduleMetrics.hourPx  // 75pt an hour, 1.25pt a minute
        // A 60-minute block held at its middle, finger at 09:30.
        #expect(snappedStart(contentY: 9.5 * px, hourPx: px, durationMin: 60) == 9 * 60)
        // Near the top it stops at midnight.
        #expect(snappedStart(contentY: 5, hourPx: px, durationMin: 60) == 0)
        // Near the end it stops where the block still fits.
        #expect(snappedStart(contentY: 24 * px, hourPx: px, durationMin: 30) == 1410)
        // A block shorter than the snap still keeps 15 minutes of room.
        #expect(snappedStart(contentY: 24 * px, hourPx: px, durationMin: 5) == 1425)
    }

    @Test func degenerateInputsDoNotTrap() {
        #expect(snapMinutes(.nan) == 0)
        #expect(snapMinutes(.infinity) == 0)
        #expect(snappedStart(contentY: 500, hourPx: 0, durationMin: 30) == 0)
        #expect(snappedStart(contentY: .nan, hourPx: 75, durationMin: 30) == 0)
    }

    @Test func formatsTimes() {
        #expect(minutesToTime(0) == "00:00")
        #expect(minutesToTime(615) == "10:15")
        #expect(minutesToTime(1439) == "23:59")
    }

    @Test func bucketsBreakAtNoonAndFive() {
        #expect(bucketForMinute(11 * 60 + 59) == .morning)
        #expect(bucketForMinute(12 * 60) == .afternoon)
        #expect(bucketForMinute(16 * 60 + 59) == .afternoon)
        #expect(bucketForMinute(17 * 60) == .evening)
    }

    @Test func autoscrollRampsInsideTheEdgesOnly() {
        let frame = 1.0 / 60
        #expect(autoscrollStep(fingerY: 300, visibleTop: 0, visibleBottom: 600, dt: frame) == 0)
        // 30pt into the bottom zone: 30/3 = 10.
        #expect(abs(autoscrollStep(fingerY: 574, visibleTop: 0, visibleBottom: 600, dt: frame) - 10) < 1e-9)
        // Past the edge it caps at 16.
        #expect(abs(autoscrollStep(fingerY: 700, visibleTop: 0, visibleBottom: 600, dt: frame) - 16) < 1e-9)
        // The top edge scrolls up.
        #expect(abs(autoscrollStep(fingerY: 26, visibleTop: 0, visibleBottom: 600, dt: frame) + 10) < 1e-9)
        // At 120Hz each step is half as far, so the speed is the same.
        #expect(abs(autoscrollStep(fingerY: 700, visibleTop: 0, visibleBottom: 600, dt: 1.0 / 120) - 8) < 1e-9)
    }

    /// day-schedule.tsx's block: the rail on the true extent, the pane nudged
    /// down 3, trimmed 4 and floored at 34.
    @Test func aPaneSitsOnItsTimeWithASeam() {
        let hour = paneRect(startMin: 540, duration: 60)
        #expect(hour == PaneRect(startY: 675, spanHeight: 75, top: 678, height: 71))
        // Two back-to-back hours leave a 4pt seam between their panes.
        let next = paneRect(startMin: 600, duration: 60)
        #expect(next.top - (hour.top + hour.height) == ScheduleMetrics.paneTrim)
        // A quarter hour is floored; its rail keeps its true 18.75.
        let quarter = paneRect(startMin: 540, duration: 15)
        #expect(quarter.spanHeight == 18.75 && quarter.height == 34)
        // A grid that starts later moves everything up by its start.
        #expect(paneRect(startMin: 540, duration: 60, gridStartMin: 480).startY == 75)
        #expect(paneRect(startMin: 540, duration: 60, hourPx: 40).startY == 360)
    }

    /// day-schedule.tsx's `eclipsedHour`: within 34pt below an hour line the
    /// now reading takes that hour's label's place. At 75pt an hour that is
    /// the first 27 minutes.
    @Test func theNowReadingStepsOverTheHourItIsNear() {
        #expect(eclipsedHour(nowMin: 540) == 9)
        #expect(eclipsedHour(nowMin: 567) == 9)
        #expect(eclipsedHour(nowMin: 568) == nil)
        #expect(eclipsedHour(nowMin: 599) == nil)
        #expect(eclipsedHour(nowMin: 5) == 0)
        #expect(eclipsedHour(nowMin: 1439) == nil)
        // A shorter hour reaches further into it.
        #expect(eclipsedHour(nowMin: 590, hourPx: 40) == 9)
    }

    @Test func clampsTheScrollOffset() {
        #expect(clampScrollOffset(-10, contentH: 1800, viewportH: 600) == 0)
        #expect(clampScrollOffset(5000, contentH: 1800, viewportH: 600) == 1200)
        #expect(clampScrollOffset(50, contentH: 300, viewportH: 600) == 0)
    }
}
