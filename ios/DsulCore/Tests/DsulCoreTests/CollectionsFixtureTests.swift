import Foundation
import Testing
import DsulCore

// The web's own answers for lib/collections.ts, checked against
// Collections.swift: tests/fixtures/organize/labels.json.

private struct CountLiveCase: Decodable, Sendable {
    let name: String
    let ids: [String]
    let live: [String]
    let expected: Int
}

private struct RoutinePillCase: Decodable, Sendable {
    let name: String
    let routine: Routine
    let seasons: [Season]
    let today: String
    let timeZone: String
    let expected: String?
}

private struct SeasonPillCase: Decodable, Sendable {
    let name: String
    let season: Season
    let today: String
    let expected: String?
}

private struct LabelsFixture: Decodable, Sendable {
    let countLive: [CountLiveCase]
    let routinePillLabel: [RoutinePillCase]
    let seasonPillLabel: [SeasonPillCase]
}

private func load() throws -> LabelsFixture {
    return try loadOrganizeFixture(LabelsFixture.self, "labels.json")
}

@Suite struct CollectionsFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try load()
        #expect(!f.countLive.isEmpty)
        #expect(!f.routinePillLabel.isEmpty)
        #expect(!f.seasonPillLabel.isEmpty)
    }

    @Test func countLiveMatchesTheWeb() throws {
        for c in try load().countLive {
            #expect(countLive(c.ids, live: Set(c.live)) == c.expected, "\(c.name)")
            // The same count over member arrays, where the ids are uuids.
            if let ids = organizeUUIDs(c.ids), let live = organizeUUIDs(c.live) {
                #expect(countLive(ids, live: Set(live)) == c.expected, "\(c.name) as uuids")
            }
        }
    }

    @Test func routinePillLabelMatchesTheWeb() throws {
        for c in try load().routinePillLabel {
            let today = try #require(DayString(c.today), "\(c.name): bad date \(c.today)")
            let got = routinePillLabel(c.routine, today: today, timeZone: c.timeZone, seasons: c.seasons)
            // By scalar, so the separator's U+00B7 is checked, not a lookalike.
            #expect(got.map { Array($0.unicodeScalars) } == c.expected.map { Array($0.unicodeScalars) }, "\(c.name): \(String(describing: got))")
        }
    }

    @Test func seasonPillLabelMatchesTheWeb() throws {
        for c in try load().seasonPillLabel {
            let today = try #require(DayString(c.today), "\(c.name): bad date \(c.today)")
            let got = seasonPillLabel(c.season, today: today)
            #expect(got == c.expected, "\(c.name): \(String(describing: got))")
        }
    }

    /// The routine pill with no seasons answers the pause alone, as the web's
    /// does when the list is left out.
    @Test func noSeasonsAnswersThePauseAlone() throws {
        for c in try load().routinePillLabel where c.seasons.isEmpty {
            let today = try #require(DayString(c.today))
            #expect(routinePillLabel(c.routine, today: today, timeZone: c.timeZone, seasons: []) == c.expected, "\(c.name)")
        }
    }
}
