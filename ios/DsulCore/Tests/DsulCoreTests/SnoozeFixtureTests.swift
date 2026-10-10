import Foundation
import Testing
import DsulCore

// The web's own answers for lib/reminders/snooze.ts `snoozeFireInstant` and
// `ringsOnDay`, checked against ReminderSnooze.swift: the snooze's day gate
// (23:40 rings the same day, 23:50 is past midnight and rings never), the
// zone's own day, and what it cannot place. tests/unit/notification-plan-fixtures.test.ts writes
// tests/fixtures/day/notification-plan.json, whose `snoozeFireInstant` section
// this reads; never edit it by hand (UPDATE_FIXTURES=1).
//
// ReminderClockTests below pins lib/reminders/clock.ts's own answers (from
// tests/unit/reminders-plan.test.ts) for ReminderClock.swift, the crossing
// every planned instant passes through.

private struct SnoozeCase: Decodable, Sendable {
    let name: String
    let nowMs: Int
    let minutes: Int
    let timeZone: String
    let dayStr: String
    let expected: Int?
}

private struct Fixture: Decodable, Sendable {
    let snoozeFireInstant: [SnoozeCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/notification-plan.json"
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            let data: Data = try Data(contentsOf: candidate)
            return try JSONDecoder().decode(Fixture.self, from: data)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw FixtureError.notFound("\(relative) above \(here)")
}

@Suite struct SnoozeFixtureTests {
    @Test func hasCasesForBothAnswers() throws {
        let cases = try loadFixture().snoozeFireInstant
        #expect(cases.contains { $0.expected == nil })
        #expect(cases.contains { $0.expected != nil })
    }

    @Test func snoozeFireInstantMatchesTheWeb() throws {
        for c in try loadFixture().snoozeFireInstant {
            let got = snoozeFireInstant(nowMs: c.nowMs, minutes: c.minutes, zone: c.timeZone, dayStr: c.dayStr)
            #expect(got == c.expected, "\(c.name)")
        }
    }

    /// The day gate, both ways: §5.3's two named rows.
    @Test func theDayGateBothWays() throws {
        let cases = try loadFixture().snoozeFireInstant
        let late = try #require(cases.first { $0.name == "23:50 is past midnight: null" })
        let early = try #require(cases.first { $0.name == "23:40 rings the same day" })
        #expect(snoozeFireInstant(nowMs: late.nowMs, minutes: late.minutes, zone: late.timeZone, dayStr: late.dayStr) == nil)
        #expect(
            snoozeFireInstant(nowMs: early.nowMs, minutes: early.minutes, zone: early.timeZone, dayStr: early.dayStr)
                == early.nowMs + early.minutes * 60_000
        )
    }

    /// lib/reminders/snooze.ts `ringsOnDay`, the same gate for an instant
    /// already chosen (a snooze the planner payload carries): the web's own
    /// unit cases (tests/unit/reminders-snooze.test.ts).
    @Test func ringsOnDayIsTheSameGate() throws {
        let ny = "America/New_York"
        func at(_ iso: String) throws -> Int {
            let date = try #require(ISO8601DateFormatter().date(from: iso), "\(iso)")
            return Int(date.timeIntervalSince1970) * 1000
        }
        #expect(ringsOnDay(fireMs: try at("2026-08-11T03:59:00Z"), zone: ny, dayStr: "2026-08-10"))  // 23:59
        #expect(!ringsOnDay(fireMs: try at("2026-08-11T04:00:00Z"), zone: ny, dayStr: "2026-08-10"))  // midnight
        #expect(!ringsOnDay(fireMs: try at("2026-08-11T04:10:00Z"), zone: ny, dayStr: "2026-08-10"))  // 00:10
        #expect(ringsOnDay(fireMs: try at("2026-08-11T04:10:00Z"), zone: ny, dayStr: "2026-08-11"))
        // What it cannot place.
        #expect(!ringsOnDay(fireMs: try at("2026-08-10T12:00:00Z"), zone: "Not/AZone", dayStr: "2026-08-10"))
        #expect(!ringsOnDay(fireMs: try at("2026-08-10T12:00:00Z"), zone: ny, dayStr: "2026-8-10"))
        // snoozeFireInstant is the length, then this gate.
        for c in try loadFixture().snoozeFireInstant where c.minutes > 0 {
            let fire = c.nowMs + c.minutes * 60_000
            #expect((ringsOnDay(fireMs: fire, zone: c.timeZone, dayStr: c.dayStr) ? fire : nil) == c.expected, "\(c.name)")
        }
    }

    /// What Swift's Int could do that the web's number can't: overflow. It is
    /// nil, never a trap.
    @Test func anOverflowIsNil() {
        #expect(snoozeFireInstant(nowMs: Int.max - 1, minutes: 15, zone: "UTC", dayStr: "2026-08-10") == nil)
        #expect(snoozeFireInstant(nowMs: 0, minutes: Int.max, zone: "UTC", dayStr: "1970-01-01") == nil)
    }
}

@Suite struct ReminderClockTests {
    private let la = "America/Los_Angeles"

    /// A spring-forward minute is no instant at all; nothing moves it to 03:30.
    @Test func aSkippedMinuteIsNil() {
        #expect(instantOf("2026-03-08", minutes: 150, timeZone: la) == nil)
        #expect(instantOf("2026-03-08", minutes: 119, timeZone: la) == 1_772_963_940_000)  // 01:59 PST, 09:59Z
        #expect(instantOf("2026-03-08", minutes: 180, timeZone: la) == 1_772_964_000_000)  // 03:00 PDT, 10:00Z
        // Chile springs forward at midnight: the day has no 00:00.
        #expect(instantOf("2026-09-06", minutes: 0, timeZone: "America/Santiago") == nil)
    }

    /// A doubled minute is the earlier of its two instants.
    @Test func aDoubledMinuteIsTheEarlier() {
        #expect(instantOf("2026-11-01", minutes: 90, timeZone: la) == 1_793_521_800_000)  // 01:30 PDT, 08:30Z
    }

    @Test func whatItCannotReadIsNil() {
        #expect(instantOf("2026-10-05", minutes: 450, timeZone: "Not/AZone") == nil)
        #expect(instantOf("2026-02-30", minutes: 450, timeZone: la) == nil)
        #expect(localClock(nowMs: 0, timeZone: "Not/AZone") == nil)
    }

    @Test func localClockReadsTheZonesDayAndMinute() throws {
        let six = try #require(localClock(nowMs: 1_791_194_400_000, timeZone: "America/New_York"))
        #expect(six == LocalClock(
            dateStr: "2026-10-05", nowMinutes: 360, nowIso: "2026-10-05T10:00:00.000Z", nowMs: 1_791_194_400_000
        ))
        let tokyo = try #require(localClock(nowMs: 1_791_194_400_000, timeZone: "Asia/Tokyo"))
        #expect(tokyo.dateStr == "2026-10-05")
        #expect(tokyo.nowMinutes == 19 * 60)
        // A millisecond before midnight is still the day before, to the millisecond.
        let late = try #require(localClock(nowMs: 1_709_251_199_999, timeZone: "UTC"))
        #expect(late.dateStr == "2024-02-29")
        #expect(late.nowMinutes == 1439)
        #expect(late.nowIso == "2024-02-29T23:59:59.999Z")
        #expect(localClock(nowMs: -1, timeZone: "UTC")?.nowIso == "1969-12-31T23:59:59.999Z")
    }

    @Test func dayArithmeticIsLabelArithmetic() {
        #expect(addDays("2026-12-31", 1) == "2027-01-01")
        #expect(addDays("2024-02-28", 1) == "2024-02-29")
        #expect(addDays("2026-03-01", -1) == "2026-02-28")
        #expect(weekdayOf("2026-10-05") == 1)
        #expect(weekdayOf("2026-10-04") == 0)
        #expect(addDays("not a day", 1) == nil)
    }

    /// Every instant `instantOf` answers reads back as the day and minute asked for.
    @Test func instantOfRoundTripsThroughLocalClock() throws {
        for zone in ["America/New_York", la, "Europe/London", "Asia/Tokyo", "Australia/Lord_Howe"] {
            for day in ["2026-03-08", "2026-03-29", "2026-10-04", "2026-11-01"] {
                for minutes in stride(from: 0, to: 1440, by: 15) {
                    guard let at = instantOf(day, minutes: minutes, timeZone: zone) else { continue }
                    let back = try #require(localClock(nowMs: at, timeZone: zone))
                    #expect(back.dateStr == day && back.nowMinutes == minutes, "\(zone) \(day) \(minutes)")
                }
            }
        }
    }
}
