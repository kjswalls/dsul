import Foundation
import Testing
import DsulCore

// The web's own answers for lib/active.ts' explanations, checked against
// ActiveExplain.swift: tests/fixtures/organize/standing.json.

private struct StandingExpected: Decodable, Sendable {
    let localOn: Bool
    let effectiveOn: Bool
    let holderIds: [String]
    let blockerIds: [String]
    let soonestBlockerId: String?
}

private struct StandingCase: Decodable, Sendable {
    let name: String
    let routine: Routine
    let seasons: [Season]
    let date: String
    let timeZone: String
    let expected: StandingExpected
}

private struct ResumeCase: Decodable, Sendable {
    let name: String
    let season: Season
    let date: String
    let expected: String?
}

private struct StandingFixture: Decodable, Sendable {
    let routineStandingOn: [StandingCase]
    let seasonResumeDate: [ResumeCase]
}

private func load() throws -> StandingFixture {
    return try loadOrganizeFixture(StandingFixture.self, "standing.json")
}

@Suite struct StandingFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try load()
        #expect(!f.routineStandingOn.isEmpty)
        #expect(!f.seasonResumeDate.isEmpty)
    }

    @Test func seasonResumeDateMatchesTheWeb() throws {
        for c in try load().seasonResumeDate {
            let day = try #require(DayString(c.date), "\(c.name): bad date \(c.date)")
            #expect(seasonResumeDate(c.season, on: day) == c.expected, "\(c.name)")
        }
    }

    @Test func routineStandingOnMatchesTheWeb() throws {
        for c in try load().routineStandingOn {
            let day = try #require(DayString(c.date), "\(c.name): bad date \(c.date)")
            let got = routineStandingOn(c.routine, seasons: c.seasons, on: day, timeZone: c.timeZone)
            #expect(got.localOn == c.expected.localOn, "\(c.name): localOn")
            #expect(got.effectiveOn == c.expected.effectiveOn, "\(c.name): effectiveOn")
            #expect(got.holders.map(\.id) == c.expected.holderIds, "\(c.name): holders")
            #expect(got.blockers.map(\.id) == c.expected.blockerIds, "\(c.name): blockers")
            #expect(got.soonestBlocker?.id == c.expected.soonestBlockerId, "\(c.name): soonest")
        }
    }

    /// The ties the web's stable sort settles are in the fixture: two
    /// blockers back on the same day, and two with no return day, each going
    /// to the earlier holder.
    @Test func theTiesAreCovered() throws {
        var sameDay = false
        var noDay = false
        for c in try load().routineStandingOn {
            let day = try #require(DayString(c.date))
            let returns = c.seasons.filter { c.expected.blockerIds.contains($0.id) }.map { seasonResumeDate($0, on: day) }
            guard returns.count >= 2, Set(returns.map { $0 ?? "" }).count == 1 else { continue }
            #expect(c.expected.soonestBlockerId == c.expected.blockerIds.first, "\(c.name)")
            if returns[0] == nil { noDay = true } else { sameDay = true }
        }
        #expect(sameDay)
        #expect(noDay)
    }
}
