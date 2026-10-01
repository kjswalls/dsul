import Foundation
import Testing
import DsulCore

@Suite struct DayStringTests {
    @Test(arguments: ["", "2026", "2026-1-01", "2026-13-01", "2026-02-30", "2026-00-10", "abcd-ef-gh", "2026/10/01", "2026-+1-01", "+202-10-01", "2026-10-1x"])
    func rejectsJunk(_ s: String) {
        #expect(DayString(s) == nil)
    }

    @Test func trimsATimestampToItsDay() {
        #expect(DayString("2026-10-01T09:00")?.description == "2026-10-01")
    }

    @Test func roundTripsItsString() {
        #expect(DayString("2028-02-29")?.description == "2028-02-29")
    }

    @Test func weekdayMatchesJavaScriptGetDay() {
        // 0 = Sun … 6 = Sat
        #expect(DayString("2025-01-12")!.weekday == 0)
        #expect(DayString("2025-01-13")!.weekday == 1)
        #expect(DayString("2025-01-18")!.weekday == 6)
        #expect(DayString("2026-10-01")!.weekday == 4)
        #expect(DayString("2000-02-29")!.weekday == 2)
    }

    @Test func weekdaysCycleThroughAYear() {
        var d = DayString("2026-01-04")!  // a Sunday
        for i in 0..<366 {
            #expect(d.weekday == i % 7)
            d = d.adding(days: 1)
        }
    }

    @Test func monthLengths() {
        #expect(DayString("2026-02-01")!.daysInMonth == 28)
        #expect(DayString("2028-02-01")!.daysInMonth == 29)
        #expect(DayString("2100-02-01")!.daysInMonth == 28)
        #expect(DayString("2026-04-10")!.daysInMonth == 30)
        #expect(DayString("2026-12-31")!.daysInMonth == 31)
    }

    @Test func addingCrossesMonthAndYearEnds() {
        #expect(DayString("2026-12-31")!.adding(days: 1).description == "2027-01-01")
        #expect(DayString("2026-03-01")!.adding(days: -1).description == "2026-02-28")
    }

    @Test func ordersByDay() {
        #expect(DayString("2026-09-30")! < DayString("2026-10-01")!)
        #expect(!(DayString("2026-10-01")! < DayString("2026-10-01")!))
    }

    @Test func toDateStrResolvesTheZone() {
        // 2026-10-01T03:30:00Z
        let instant = Date(timeIntervalSince1970: 1_790_825_400)
        #expect(toDateStr(instant, timeZone: "UTC")?.description == "2026-10-01")
        #expect(toDateStr(instant, timeZone: "America/Los_Angeles")?.description == "2026-09-30")
        #expect(toDateStr(instant, timeZone: "Asia/Tokyo")?.description == "2026-10-01")
        #expect(toDateStr(instant, timeZone: "Bogus/Zone") == nil)
    }
}
