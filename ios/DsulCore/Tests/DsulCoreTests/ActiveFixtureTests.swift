import Foundation
import Testing
import DsulCore

// The web's own answers for lib/active.ts, checked against Active.swift.
// tests/unit/day-fixtures.test.ts runs every case through the real TS and
// commits the results to tests/fixtures/day/active.json; this file reads the
// same JSON. Never edit the JSON by hand: regenerate it from the Vitest side
// (UPDATE_FIXTURES=1).

private struct PauseCase: Decodable, Sendable {
    let name: String
    let pausedAt: String?
    let pausedUntil: String?
    let date: String
    let timeZone: String
    let expected: Bool
}

private struct SeasonCase: Decodable, Sendable {
    let name: String
    let season: Season
    let date: String
    let expected: Bool
}

private struct OpenLoopCase: Decodable, Sendable {
    let name: String
    let item: Item
    let date: String
    let expected: Bool
}

private struct WorldDay: Decodable, Sendable {
    let date: String
    let inactive: [String]
    let live: [String]
}

private struct World: Decodable, Sendable {
    let name: String
    let timeZone: String
    let items: [Item]
    let routines: [Routine]
    let seasons: [Season]
    let days: [WorldDay]
}

private struct Fixture: Decodable, Sendable {
    let isPausedOn: [PauseCase]
    let isSeasonActiveOn: [SeasonCase]
    let isOpenLoopOn: [OpenLoopCase]
    let worlds: [World]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root, the first directory that
/// holds the fixture (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/active.json"
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

private func ids(_ set: Set<UUID>) -> [String] {
    return set.map { $0.uuidString.lowercased() }.sorted()
}

@Suite struct ActiveFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try loadFixture()
        #expect(!f.isPausedOn.isEmpty)
        #expect(!f.isSeasonActiveOn.isEmpty)
        #expect(!f.isOpenLoopOn.isEmpty)
        #expect(!f.worlds.isEmpty)
        for world in f.worlds { #expect(!world.days.isEmpty, "\(world.name)") }
    }

    @Test func isPausedOnMatchesTheWeb() throws {
        for c in try loadFixture().isPausedOn {
            let day = try #require(DayString(c.date), "\(c.name): bad date \(c.date)")
            let window = PauseWindow(pausedAt: c.pausedAt, pausedUntil: c.pausedUntil)
            #expect(isPausedOn(window, on: day, timeZone: c.timeZone) == c.expected, "\(c.name)")
        }
    }

    @Test func isSeasonActiveOnMatchesTheWeb() throws {
        for c in try loadFixture().isSeasonActiveOn {
            let day = try #require(DayString(c.date), "\(c.name): bad date \(c.date)")
            #expect(isSeasonActiveOn(c.season, on: day) == c.expected, "\(c.name)")
        }
    }

    @Test func isOpenLoopOnMatchesTheWeb() throws {
        for c in try loadFixture().isOpenLoopOn {
            let day = try #require(DayString(c.date), "\(c.name): bad date \(c.date)")
            #expect(isOpenLoopOn(c.item, on: day) == c.expected, "\(c.name)")
        }
    }

    @Test func inactiveItemIdsOnMatchesTheWeb() throws {
        for world in try loadFixture().worlds {
            for d in world.days {
                let day = try #require(DayString(d.date), "\(world.name): bad date \(d.date)")
                let got = inactiveItemIdsOn(
                    items: world.items, date: day, timeZone: world.timeZone,
                    routines: world.routines, seasons: world.seasons
                )
                #expect(ids(got) == d.inactive, "\(world.name) on \(d.date)")
            }
        }
    }

    @Test func isItemActiveOnMatchesTheWeb() throws {
        for world in try loadFixture().worlds {
            for d in world.days {
                let day = try #require(DayString(d.date), "\(world.name): bad date \(d.date)")
                for item in world.items {
                    let live = isItemActiveOn(
                        item, on: day, timeZone: world.timeZone,
                        routines: world.routines, seasons: world.seasons
                    )
                    let expected = d.live.contains(item.id.uuidString.lowercased())
                    #expect(live == expected, "\(world.name) on \(d.date): \(item.title)")
                }
            }
        }
    }

    /// The bulk answer is the per-item one, inverted for speed: both must agree.
    @Test func theBulkSetIsThePerItemPredicate() throws {
        for world in try loadFixture().worlds {
            for d in world.days {
                let day = try #require(DayString(d.date))
                let bulk = inactiveItemIdsOn(
                    items: world.items, date: day, timeZone: world.timeZone,
                    routines: world.routines, seasons: world.seasons
                )
                let each = Set(world.items.filter {
                    isOpenLoopSuppressedOn($0, on: day, timeZone: world.timeZone, routines: world.routines, seasons: world.seasons)
                }.map(\.id))
                #expect(bulk == each, "\(world.name) on \(d.date)")
            }
        }
    }
}

@Suite struct TimestampTests {
    private func iso(_ date: Date?) -> String? {
        guard let date = date else { return nil }
        let f = ISO8601DateFormatter()
        f.timeZone = TimeZone(secondsFromGMT: 0)
        return f.string(from: date)
    }

    @Test func readsPostgresTimestamptz() {
        // load_planner's to_jsonb: microseconds and +00:00.
        #expect(iso(parseTimestamp("2026-09-30T14:03:22.123456+00:00")) == "2026-09-30T14:03:22Z")
        #expect(iso(parseTimestamp("2026-09-30T14:03:22+00:00")) == "2026-09-30T14:03:22Z")
    }

    @Test func readsOffsetsAndZ() {
        #expect(iso(parseTimestamp("2026-08-11T03:00:00+05:30")) == "2026-08-10T21:30:00Z")
        #expect(iso(parseTimestamp("2026-08-10T20:00:00-07:00")) == "2026-08-11T03:00:00Z")
        #expect(iso(parseTimestamp("2026-08-10T12:00:00.000Z")) == "2026-08-10T12:00:00Z")
        #expect(iso(parseTimestamp("2026-08-10T12:00:00+0530")) == "2026-08-10T06:30:00Z")
        #expect(iso(parseTimestamp("2026-08-10T12:00Z")) == "2026-08-10T12:00:00Z")
    }

    @Test func aBareDateIsUTCMidnight() {
        #expect(iso(parseTimestamp("2026-08-10")) == "2026-08-10T00:00:00Z")
    }

    @Test func keepsTheFractionWithoutRoundingIntoTomorrow() throws {
        let at = try #require(parseTimestamp("2026-08-10T23:59:59.999999Z"))
        #expect(toDateStr(at, timeZone: "UTC")?.description == "2026-08-10")
    }

    @Test(arguments: [
        "", "not a date", "2026-08-10T12:00:00",  // no zone: the web reads it in the runtime's
        "2026-02-30T12:00:00Z", "2026-08-10T25:00:00Z", "2026-08-10T12:00:00.Z",
        "2026-08-10T12:00:00+5:30", "2026-08-10T12:00:00Zjunk", "2026/08/10",
    ])
    func refusesWhatItCannotPin(_ s: String) {
        #expect(parseTimestamp(s) == nil)
    }

    @Test func anUnknownZoneIsNoPause() {
        let paused = PauseWindow(pausedAt: "2026-08-10T12:00:00Z")
        #expect(!isPausedOn(paused, on: DayString("2026-08-15")!, timeZone: "Bogus/Zone"))
        #expect(isPausedOn(paused, on: DayString("2026-08-15")!, timeZone: "UTC"))
    }
}
