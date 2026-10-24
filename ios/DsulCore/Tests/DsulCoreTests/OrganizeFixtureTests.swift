import Foundation
import Testing
import DsulCore

// The web's own answers for lib/organize.ts, checked against Organize.swift:
// tests/fixtures/organize/organize.json. O4 pins the summary cards: THIS
// WEEK (`organizeWeek`, and its line through `weekCardSentence`) and NEXT
// MILESTONE (`nextMilestoneAcross`, and its line through `nextMilestoneLine`).
// O12 pins a routine step's new place (`moveMemberAfter`), and O13 what
// putting a routine in a season would hide (`wouldHideAttaching`, each row
// asked of the one `attachWorld`).

private struct Tables: Decodable, Sendable {
    let nothingOnThisWeek: String
}

private struct MilestoneWorld: Decodable, Sendable {
    let items: [Item]
}

private struct WeekExpected: Decodable, Sendable {
    let from: String
    let through: String
    let done: Int
    let counted: Int
    let sentence: String
}

private struct WeekCase: Decodable, Sendable {
    let name: String
    let items: [Item]
    let routines: [Routine]
    let seasons: [Season]
    let away: [AwayPeriod]
    let today: String
    let timeZone: String
    let weekStartDay: String
    let expected: WeekExpected
}

private struct MilestoneExpected: Decodable, Sendable {
    let goalId: String
    let itemId: String
    let date: String?
    let line: String
}

private struct MilestoneCase: Decodable, Sendable {
    let name: String
    let goals: [Goal]
    let expected: MilestoneExpected?
}

private struct SentenceCase: Decodable, Sendable {
    let name: String
    let done: Int
    let counted: Int
    let expected: String
}

/// The world every `wouldHideAttaching` row is asked of: the live routines
/// and seasons, and the items they hold.
private struct AttachWorld: Decodable, Sendable {
    let items: [Item]
    let routines: [Routine]
    let seasons: [Season]
    let timeZone: String
}

private struct MoveCase: Decodable, Sendable {
    let name: String
    let ids: [String]
    let item: String
    let after: String?
    let expected: [String]
}

private struct HideCase: Decodable, Sendable {
    let name: String
    let seasonId: String
    let routineId: String
    let today: String
    let expected: Int
}

private struct OrganizeFixture: Decodable, Sendable {
    let tables: Tables
    let milestoneWorld: MilestoneWorld
    let attachWorld: AttachWorld
    let organizeWeek: [WeekCase]
    let nextMilestoneAcross: [MilestoneCase]
    let moveMemberAfter: [MoveCase]
    let wouldHideAttaching: [HideCase]
    let weekCardSentence: [SentenceCase]
}

private func load() throws -> OrganizeFixture {
    return try loadOrganizeFixture(OrganizeFixture.self, "organize.json")
}

/// Each case's whole source, its `tasks` and `habits` the grid's projection
/// (`project`, subtasks left out), as the fixture's writer built it.
private func week(_ c: WeekCase) throws -> OrganizeWeek {
    let today = try #require(DayString(c.today), "\(c.name): bad today")
    let start = try #require(WeekStartDay(rawValue: c.weekStartDay), "\(c.name): bad weekStartDay")
    let source = ScheduleSource(
        items: c.items, routines: c.routines, seasons: c.seasons, away: c.away, timeZone: c.timeZone
    )
    return organizeWeek(source, today: today, weekStartDay: start)
}

@Suite struct OrganizeFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try load()
        #expect(!f.milestoneWorld.items.isEmpty)
        #expect(f.organizeWeek.count >= 10)
        #expect(f.nextMilestoneAcross.count >= 10)
        #expect(f.weekCardSentence.count == 4)
        // Every case names itself once, so a failure points at one.
        let names = f.organizeWeek.map(\.name) + f.nextMilestoneAcross.map(\.name) + f.weekCardSentence.map(\.name)
        #expect(Set(f.organizeWeek.map(\.name)).count == f.organizeWeek.count)
        #expect(Set(f.nextMilestoneAcross.map(\.name)).count == f.nextMilestoneAcross.count)
        #expect(names.allSatisfy { !$0.isEmpty })
    }

    @Test func theTablesAreTheWebs() throws {
        let t = try load().tables
        #expect(OrganizeCopy.nothingOnThisWeek == t.nothingOnThisWeek)
    }

    @Test func theWeekCardMatchesTheWeb() throws {
        for c in try load().organizeWeek {
            let answer = try week(c)
            #expect(answer.from.description == c.expected.from, "\(c.name): from")
            #expect(answer.through.description == c.expected.through, "\(c.name): through")
            #expect(answer.done == c.expected.done, "\(c.name): done")
            #expect(answer.counted == c.expected.counted, "\(c.name): counted")
            #expect(
                OrganizeCopy.weekCardSentence(done: answer.done, counted: answer.counted) == c.expected.sentence,
                "\(c.name): sentence"
            )
        }
    }

    /// The card's invariants, on every case: seven days, nothing done beyond
    /// what is counted, and a bar only when something is.
    @Test func theWeekIsSevenDaysAndNeverAShareOfNothing() throws {
        for c in try load().organizeWeek {
            let answer = try week(c)
            #expect(answer.through == answer.from.adding(days: 6), "\(c.name): seven days")
            #expect(answer.done <= answer.counted, "\(c.name): done within counted")
            if answer.counted == 0 {
                #expect(answer.fraction == nil, "\(c.name): no bar")
            } else {
                #expect(answer.fraction == Double(answer.done) / Double(answer.counted), "\(c.name): bar")
            }
            let today = try #require(DayString(c.today))
            #expect(answer.from <= today && today <= answer.through, "\(c.name): today is in its week")
        }
    }

    @Test func theNextMilestoneMatchesTheWeb() throws {
        let f = try load()
        let byId = Dictionary(f.milestoneWorld.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for c in f.nextMilestoneAcross {
            let answer = nextMilestoneAcross(c.goals, itemsById: byId)
            guard let expected = c.expected else {
                #expect(answer == nil, "\(c.name): no card")
                continue
            }
            let found = try #require(answer, "\(c.name): expected a card")
            #expect(found.goal.id == expected.goalId, "\(c.name): goal")
            #expect(found.milestone.id.uuidString.lowercased() == expected.itemId, "\(c.name): milestone")
            #expect(found.date == expected.date, "\(c.name): date")
            #expect(OrganizeCopy.nextMilestoneLine(date: found.date, goalName: found.goal.name) == expected.line, "\(c.name): line")
        }
    }

    @Test func theWeekCardSentenceMatchesTheWeb() throws {
        for c in try load().weekCardSentence {
            #expect(OrganizeCopy.weekCardSentence(done: c.done, counted: c.counted) == c.expected, "\(c.name)")
        }
    }

    /// O12: the web's own new order, over the ids as strings (as the TS asks
    /// it) and as a routine's `itemIds` (uuids).
    @Test func aStepsNewPlaceMatchesTheWeb() throws {
        let rows = try load().moveMemberAfter
        #expect(rows.count >= 10)
        #expect(rows.contains { $0.after == nil })
        #expect(rows.contains { $0.ids == $0.expected })
        #expect(rows.contains { $0.ids != $0.expected })
        for c in rows {
            #expect(moveMemberAfter(c.ids, item: c.item, after: c.after) == c.expected, "\(c.name)")
            let ids = try #require(organizeUUIDs(c.ids), "\(c.name): ids")
            let expected = try #require(organizeUUIDs(c.expected), "\(c.name): expected")
            let item = try #require(UUID(uuidString: c.item), "\(c.name): item")
            let after = try c.after.map { try #require(UUID(uuidString: $0), "\(c.name): after") }
            let moved = moveMemberAfter(ids, item: item, after: after)
            #expect(moved == expected, "\(c.name): uuids")
            // Nothing gained or lost, and a second send of the same move
            // writes nothing (design §5.7).
            #expect(moved.sorted { $0.uuidString < $1.uuidString } == ids.sorted { $0.uuidString < $1.uuidString },
                    "\(c.name): the same members")
            #expect(moveMemberAfter(moved, item: item, after: after) == moved, "\(c.name): a retry moved it")
        }
    }

    /// O13: the attach confirm's count, the resolver's delta, asked of the
    /// one world with each row's season, routine and day.
    @Test func whatAnAttachHidesMatchesTheWeb() throws {
        let f = try load()
        let w = f.attachWorld
        #expect(f.wouldHideAttaching.count >= 10)
        #expect(f.wouldHideAttaching.contains { $0.expected == 0 })
        #expect(f.wouldHideAttaching.contains { $0.expected == 1 })
        #expect(f.wouldHideAttaching.contains { $0.expected > 1 })
        for c in f.wouldHideAttaching {
            let day = try #require(DayString(c.today), "\(c.name): bad today")
            let hides = wouldHideAttaching(
                seasonId: c.seasonId, routineId: c.routineId, items: w.items, on: day, timeZone: w.timeZone,
                routines: w.routines, seasons: w.seasons
            )
            #expect(hides == c.expected, "\(c.name): \(hides)")
        }
    }

    /// The first-season rule, by hand: a routine an off season already holds
    /// is never asked about, whatever the season it joins would hide; and the
    /// count is the delta, so a world with nothing to hide hides nothing.
    @Test func onlyTheFirstSeasonIsAskedAbout() throws {
        let w = try load().attachWorld
        let day = try #require(DayString("2026-10-23"))
        func hides(_ season: String, _ routine: String, seasons: [Season]) -> Int {
            wouldHideAttaching(seasonId: season, routineId: routine, items: w.items, on: day, timeZone: w.timeZone,
                               routines: w.routines, seasons: seasons)
        }
        let alone = hides("s-shelf", "r-morning", seasons: w.seasons)
        #expect(alone > 0)
        // The same routine already in another season: nothing to say.
        let held = w.seasons.map { s -> Season in
            guard s.id == "s-always" else { return s }
            var h = s
            h.routineIds.append("r-morning")
            return h
        }
        #expect(hides("s-shelf", "r-morning", seasons: held) == 0)
        // No items: nothing hides.
        #expect(wouldHideAttaching(seasonId: "s-shelf", routineId: "r-morning", items: [], on: day,
                                   timeZone: w.timeZone, routines: w.routines, seasons: w.seasons) == 0)
    }

    /// The copy rules (design §6.9): no em dash and no "missed" in the cards.
    @Test func theCardsBreakNoCopyRule() throws {
        let f = try load()
        var words = [OrganizeCopy.nothingOnThisWeek]
        words += f.organizeWeek.map(\.expected.sentence)
        words += f.nextMilestoneAcross.compactMap { $0.expected?.line }
        for word in words {
            #expect(!word.unicodeScalars.contains("\u{2014}"), "\(word)")
            #expect(!word.lowercased().contains("missed"), "\(word)")
        }
    }
}
