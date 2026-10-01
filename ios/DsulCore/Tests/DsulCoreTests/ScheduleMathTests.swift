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

    @Test func clampsTheScrollOffset() {
        #expect(clampScrollOffset(-10, contentH: 1800, viewportH: 600) == 0)
        #expect(clampScrollOffset(5000, contentH: 1800, viewportH: 600) == 1200)
        #expect(clampScrollOffset(50, contentH: 300, viewportH: 600) == 0)
    }
}
