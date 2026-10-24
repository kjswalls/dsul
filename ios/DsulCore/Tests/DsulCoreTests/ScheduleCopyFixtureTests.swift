import Foundation
import Testing
import DsulCore

// The web's own answers for what a Schedule block and its gutter say, checked
// against BlockCopy.swift: components/views/day-schedule.tsx `formatClock`
// (12h and 24h, with and without the am/pm, wrapping past midnight) and
// `formatHourLabel`, and components/primitives/pills.tsx `formatDuration`.
// tests/unit/day-fixtures.test.ts runs every case through the real TS (the
// stored format through lib/use-time-format.ts `timeFormatPattern`) and
// commits the results to tests/fixtures/day/schedule-copy.json. Never edit
// the JSON by hand: regenerate it from the Vitest side (UPDATE_FIXTURES=1).
//
// A block's range and the now reading are composed in the web's JSX, not in
// a function, so the fixture has no section for them; they are pinned by hand
// below from day-schedule.tsx's markup.

private struct ClockCase: Decodable, Sendable {
    let name: String
    let minutes: Int
    let timeFormat: String
    let meridiem: Bool
    let expected: String
}

private struct HourCase: Decodable, Sendable {
    let name: String
    let hour: Int
    let timeFormat: String
    let expected: String
}

private struct DurationCase: Decodable, Sendable {
    let name: String
    let minutes: Int
    let expected: String
}

private struct Fixture: Decodable, Sendable {
    let formatClock: [ClockCase]
    let formatHourLabel: [HourCase]
    let formatDuration: [DurationCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/schedule-copy.json"
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

@Suite struct ScheduleCopyFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try loadFixture()
        for format in TimeFormat.allCases {
            #expect(f.formatClock.contains { $0.timeFormat == format.rawValue && $0.meridiem }, "\(format)")
            #expect(f.formatClock.contains { $0.timeFormat == format.rawValue && !$0.meridiem }, "\(format)")
            #expect(f.formatHourLabel.filter { $0.timeFormat == format.rawValue }.map(\.hour) == Array(0..<24),
                    "\(format): every hour of the gutter")
        }
        // The wrap both ways, and the day's own ends.
        let minutes = Set(f.formatClock.map(\.minutes))
        #expect(minutes.isSuperset(of: [0, 720, 1439, 1440, 2880, -15]))
        // A quarter hour through a whole day, and past it.
        let lengths = Set(f.formatDuration.map(\.minutes))
        #expect(lengths.isSuperset(of: Set(stride(from: 15, through: 1440, by: 15))))
        #expect(lengths.contains(0) && lengths.contains(1500))
    }

    @Test func formatClockMatchesTheWeb() throws {
        for c in try loadFixture().formatClock {
            let format = try #require(TimeFormat(rawValue: c.timeFormat), "\(c.name): unknown format \(c.timeFormat)")
            #expect(formatClock(c.minutes, timeFormat: format, meridiem: c.meridiem) == c.expected, "\(c.name)")
        }
    }

    @Test func formatHourLabelMatchesTheWeb() throws {
        for c in try loadFixture().formatHourLabel {
            let format = try #require(TimeFormat(rawValue: c.timeFormat), "\(c.name): unknown format \(c.timeFormat)")
            #expect(formatHourLabel(c.hour, timeFormat: format) == c.expected, "\(c.name)")
        }
    }

    @Test func formatDurationMatchesTheWeb() throws {
        for c in try loadFixture().formatDuration {
            #expect(formatDuration(c.minutes) == c.expected, "\(c.name)")
        }
    }

    /// The now reading is `formatClock(nowMin, tf)`: the am/pm is on unless
    /// a caller drops it.
    @Test func theClockKeepsItsMeridiemByDefault() throws {
        for c in try loadFixture().formatClock where c.meridiem {
            let format = try #require(TimeFormat(rawValue: c.timeFormat))
            #expect(formatClock(c.minutes, timeFormat: format) == c.expected, "\(c.name)")
        }
    }

    /// day-schedule.tsx's tall block: `formatClock(start, tf, false)`, an en
    /// dash, `formatClock(start + duration, tf, false)`.
    @Test func aRangeIsTwoClocksWithNoMeridiemAndAnEnDash() throws {
        #expect(formatClockRange(startMin: 600, duration: 120, timeFormat: .twelveHour) == "10:00\u{2013}12:00")
        #expect(formatClockRange(startMin: 600, duration: 120, timeFormat: .twentyFourHour) == "10:00\u{2013}12:00")
        #expect(formatClockRange(startMin: 810, duration: 90, timeFormat: .twelveHour) == "1:30\u{2013}3:00")
        #expect(formatClockRange(startMin: 810, duration: 90, timeFormat: .twentyFourHour) == "13:30\u{2013}15:00")
        // The end wraps past midnight.
        #expect(formatClockRange(startMin: 1410, duration: 60, timeFormat: .twelveHour) == "11:30\u{2013}12:30")
        #expect(formatClockRange(startMin: 1410, duration: 60, timeFormat: .twentyFourHour) == "23:30\u{2013}00:30")
        // Over every clock the fixture pins: no am/pm, no spaces, one dash.
        for c in try loadFixture().formatClock where !c.meridiem {
            let format = try #require(TimeFormat(rawValue: c.timeFormat))
            let range = formatClockRange(startMin: c.minutes, duration: 30, timeFormat: format)
            #expect(range.hasPrefix(c.expected + "\u{2013}"), "\(c.name)")
            #expect(range == c.expected + "\u{2013}" + formatClock(c.minutes + 30, timeFormat: format, meridiem: false))
            #expect(!range.contains(" ") && !range.contains("m"), "\(c.name)")
        }
    }
}
