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

/// The world every suppression case is asked against, whole.
private struct SuppressionWorld: Decodable, Sendable {
    let items: [Item]
    let routines: [Routine]
    let seasons: [Season]
    let away: [AwayPeriod]
}

private struct ReasonExpected: Decodable, Sendable {
    let kind: String
    let until: String?
    let routineId: String?
    let seasonId: String?
    let short: String
    let long: String
}

private struct ReasonCase: Decodable, Sendable {
    let name: String
    let itemId: String
    let date: String
    let timeZone: String
    let expected: ReasonExpected?
}

private struct RevealedCase: Decodable, Sendable {
    let name: String
    let routineId: String
    let memberIds: [String]
    let date: String
    let timeZone: String
    let expected: [String]
}

private struct StandingFixture: Decodable, Sendable {
    let routineStandingOn: [StandingCase]
    let seasonResumeDate: [ResumeCase]
    let suppressionWorld: SuppressionWorld
    let suppressionReason: [ReasonCase]
    let membersRevealedByRemoving: [RevealedCase]
}

private func load() throws -> StandingFixture {
    return try loadOrganizeFixture(StandingFixture.self, "standing.json")
}

@Suite struct StandingFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try load()
        #expect(!f.routineStandingOn.isEmpty)
        #expect(!f.seasonResumeDate.isEmpty)
        #expect(!f.suppressionWorld.items.isEmpty)
        #expect(!f.suppressionReason.isEmpty)
        #expect(!f.membersRevealedByRemoving.isEmpty)
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

    /// lib/active.ts `suppressionReason` and `suppressionLabel` (short and
    /// long), each case asked against the WHOLE world, trips included.
    @Test func suppressionReasonMatchesTheWeb() throws {
        let f = try load()
        let w = f.suppressionWorld
        let byId = Dictionary(w.items.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        for c in f.suppressionReason {
            let day = try #require(DayString(c.date), "\(c.name): bad date \(c.date)")
            let id = try #require(UUID(uuidString: c.itemId), "\(c.name): bad id")
            let item = try #require(byId[id], "\(c.name): no item \(c.itemId)")
            let got = suppressionReason(
                item, on: day, timeZone: c.timeZone, routines: w.routines, seasons: w.seasons, away: w.away
            )
            let active = isItemActiveOn(
                item, on: day, timeZone: c.timeZone, routines: w.routines, seasons: w.seasons, away: w.away
            )
            // The explanation never disagrees with the grid: nil exactly when
            // the resolver shows the item.
            #expect((got == nil) == active, "\(c.name): the resolver disagrees")
            guard let expected = c.expected else {
                #expect(got == nil, "\(c.name): \(String(describing: got))")
                continue
            }
            let reason = try #require(got, "\(c.name): live, expected \(expected.kind)")
            #expect(reason.kind.rawValue == expected.kind, "\(c.name): kind")
            #expect(reason.until == expected.until, "\(c.name): until")
            #expect(reason.routine?.id == expected.routineId, "\(c.name): routine")
            #expect(reason.season?.id == expected.seasonId, "\(c.name): season")
            #expect(suppressionLabel(reason) == expected.short, "\(c.name): short")
            #expect(suppressionLabel(reason, long: true) == expected.long, "\(c.name): long")
        }
    }

    /// Every kind is covered, and so are a routine named through a season and
    /// the three "blocked twice" rankings.
    @Test func everyReasonIsCovered() throws {
        let f = try load()
        let kinds = Set(f.suppressionReason.compactMap { $0.expected?.kind })
        #expect(kinds == Set(SuppressionReason.Kind.allCases.map(\.rawValue)))
        #expect(f.suppressionReason.contains { $0.expected?.kind == "season" && $0.expected?.routineId != nil })
        #expect(f.suppressionReason.contains { $0.expected == nil })
        #expect(f.suppressionReason.filter { $0.name.hasPrefix("blocked twice") }.count == 3)
    }

    /// The trip-free labels, which the fixture's world cannot reach with
    /// every shape: a routine and a season named with no return day, and a
    /// paused item whose stored end is empty (no day, as the web's truthiness
    /// has it).
    @Test func theLabelsWithoutADay() {
        let routine = Routine(id: "r", name: "Piano")
        let season = Season(id: "s", name: "Winter", state: "paused")
        #expect(suppressionLabel(.routine(routine, until: nil), long: true) == "Hidden with your Piano routine")
        #expect(suppressionLabel(.season(season, routine: routine, until: nil)) == "Hidden with Winter")
        #expect(suppressionLabel(.paused(until: "")) == "Paused")
        #expect(suppressionLabel(.away(until: ""), long: true) == "Resting for vacation mode")
    }

    /// lib/active.ts `membersRevealedByRemoving`, asked as the routine pane
    /// asks it: routines, seasons and items, and NO trips.
    @Test func membersRevealedByRemovingMatchesTheWeb() throws {
        let f = try load()
        let w = f.suppressionWorld
        for c in f.membersRevealedByRemoving {
            let day = try #require(DayString(c.date), "\(c.name): bad date \(c.date)")
            let members = try #require(organizeUUIDs(c.memberIds), "\(c.name): a member id is not a uuid")
            let expected = try #require(organizeUUIDs(c.expected), "\(c.name): an expected id is not a uuid")
            let got = membersRevealedByRemoving(
                c.routineId, memberIds: members, items: w.items, on: day, timeZone: c.timeZone,
                routines: w.routines, seasons: w.seasons
            )
            #expect(got == expected, "\(c.name): \(got.map { $0.uuidString.lowercased() })")
        }
    }
}
