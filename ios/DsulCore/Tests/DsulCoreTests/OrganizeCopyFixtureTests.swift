import Foundation
import Testing
import DsulCore

// The web's own words for lib/organize-copy.ts, checked against
// OrganizeCopy.swift byte for byte: tests/fixtures/organize/copy.json.

private struct StateTables: Decodable, Sendable {
    let routine: [String: String]
    let season: [String: String]
    let goal: [String: String]
}

private struct Tables: Decodable, Sendable {
    let stateLabels: StateTables
    let nothingInItYet: String
    let heldByNone: String
    let routineTodayFinished: String
    let routineTodayNext: String
    let noCheckinYet: String
    let noMilestonesYet: String
    let noSupportingWork: String
}

private struct HeldWorld: Decodable, Sendable {
    let items: [Item]
}

private struct SwitchedOffCase: Decodable, Sendable {
    let name: String
    let title: String
    let body: String
    let sentence: String
}

private struct PausedNoteCase: Decodable, Sendable {
    let name: String
    let routine: Routine
    let expected: String
}

private struct HeldNoteExpected: Decodable, Sendable {
    let hiddenHere: Int
    let note: String?
}

private struct HeldNoteCase: Decodable, Sendable {
    let name: String
    let routines: [Routine]
    let seasons: [Season]
    let routineId: String
    let today: String
    let timeZone: String
    let expected: HeldNoteExpected
}

private struct HeldByCase: Decodable, Sendable {
    let name: String
    let season: Season
    let today: String
    let expected: String
}

private struct SummaryCase: Decodable, Sendable {
    let name: String
    let done: Int
    let total: Int
    let skipped: Int
    let expected: String?
}

private struct EmptyCase: Decodable, Sendable {
    let name: String
    let routineName: String
    let memberCount: Int
    let expected: String
}

private struct StateNoteCase: Decodable, Sendable {
    let name: String
    let season: Season
    let today: String
    let live: Bool
    let expected: String
}

private struct RunsCase: Decodable, Sendable {
    let name: String
    let startsOn: String?
    let endsOn: String?
    let expected: String?
}

private struct EndedCase: Decodable, Sendable {
    let name: String
    let goal: Goal
    let expected: String?
}

private struct WindDownCase: Decodable, Sendable {
    let name: String
    let state: String
    let count: Int
    let expected: String?
}

private struct CheckinCase: Decodable, Sendable {
    let name: String
    let item: Item
    let cadence: String
    let lastDone: String?
    let expected: String
}

private struct TickCase: Decodable, Sendable {
    let name: String
    let title: String
    let reached: Bool
    let expected: String
}

private struct CopyFixture: Decodable, Sendable {
    let tables: Tables
    let heldWorld: HeldWorld
    let switchedOff: [SwitchedOffCase]
    let routinePausedNote: [PausedNoteCase]
    let routineHeldNote: [HeldNoteCase]
    let heldByState: [HeldByCase]
    let routineTodaySummary: [SummaryCase]
    let routineTodayEmpty: [EmptyCase]
    let seasonStateNote: [StateNoteCase]
    let seasonRunsLabel: [RunsCase]
    let goalEndedNote: [EndedCase]
    let windDownSentence: [WindDownCase]
    let checkinMeta: [CheckinCase]
    let milestoneTickLabel: [TickCase]
}

private func load() throws -> CopyFixture {
    return try loadOrganizeFixture(CopyFixture.self, "copy.json")
}

private func table(_ states: [StateLabel]) -> [String: String] {
    return Dictionary(states.map { ($0.value, $0.label) }, uniquingKeysWith: { first, _ in first })
}

@Suite struct OrganizeCopyFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try load()
        #expect(!f.heldWorld.items.isEmpty)
        #expect(f.switchedOff.count == 2)
        #expect(!f.routinePausedNote.isEmpty)
        #expect(!f.routineHeldNote.isEmpty)
        #expect(!f.heldByState.isEmpty)
        #expect(!f.routineTodaySummary.isEmpty)
        #expect(!f.routineTodayEmpty.isEmpty)
        #expect(!f.seasonStateNote.isEmpty)
        #expect(!f.seasonRunsLabel.isEmpty)
        #expect(!f.goalEndedNote.isEmpty)
        #expect(!f.windDownSentence.isEmpty)
        #expect(!f.checkinMeta.isEmpty)
        #expect(!f.milestoneTickLabel.isEmpty)
    }

    @Test func theTablesAreTheWebs() throws {
        let t = try load().tables
        #expect(table(OrganizeCopy.routineStates) == t.stateLabels.routine)
        #expect(table(OrganizeCopy.seasonStates) == t.stateLabels.season)
        #expect(table(OrganizeCopy.goalStates) == t.stateLabels.goal)
        #expect(OrganizeCopy.routineStates.count == t.stateLabels.routine.count)
        #expect(OrganizeCopy.seasonStates.count == t.stateLabels.season.count)
        #expect(OrganizeCopy.goalStates.count == t.stateLabels.goal.count)
        #expect(OrganizeCopy.label("abandoned", in: OrganizeCopy.goalStates) == "Set aside")
        #expect(OrganizeCopy.label("someday", in: OrganizeCopy.goalStates) == nil)
        #expect(OrganizeCopy.nothingInItYet == t.nothingInItYet)
        #expect(OrganizeCopy.heldByNone == t.heldByNone)
        #expect(OrganizeCopy.routineTodayFinished == t.routineTodayFinished)
        #expect(OrganizeCopy.routineTodayNext == t.routineTodayNext)
        #expect(OrganizeCopy.noCheckinYet == t.noCheckinYet)
        #expect(OrganizeCopy.noMilestonesYet == t.noMilestonesYet)
        #expect(OrganizeCopy.noSupportingWork == t.noSupportingWork)
    }

    @Test func switchedOffMatchesTheWeb() throws {
        for c in try load().switchedOff {
            let off: SwitchedOff = c.name == "goals" ? OrganizeCopy.goalsOff : OrganizeCopy.organizeOff
            #expect(off.title == c.title, "\(c.name): title")
            #expect(off.body == c.body, "\(c.name): body")
            #expect(off.sentence == c.sentence, "\(c.name): sentence")
        }
    }

    @Test func routinePausedNoteMatchesTheWeb() throws {
        for c in try load().routinePausedNote {
            #expect(OrganizeCopy.routinePausedNote(c.routine) == c.expected, "\(c.name)")
        }
    }

    /// The held note, with its count asked as the routine pane asks it (no
    /// trips) over the fixture's held world.
    @Test func routineHeldNoteMatchesTheWeb() throws {
        let f = try load()
        for c in f.routineHeldNote {
            let today = try #require(DayString(c.today), "\(c.name): bad today")
            let routine = try #require(c.routines.first { $0.id == c.routineId }, "\(c.name): no routine")
            let hidden = OrganizeCopy.hiddenHere(
                routine, items: f.heldWorld.items, routines: c.routines, seasons: c.seasons, on: today, timeZone: c.timeZone
            )
            #expect(hidden == c.expected.hiddenHere, "\(c.name): hiddenHere")
            let standing = routineStandingOn(routine, seasons: c.seasons, on: today, timeZone: c.timeZone)
            #expect(OrganizeCopy.routineHeldNote(standing, hiddenHere: c.expected.hiddenHere, today: today) == c.expected.note, "\(c.name)")
        }
    }

    @Test func heldByStateMatchesTheWeb() throws {
        for c in try load().heldByState {
            let today = try #require(DayString(c.today), "\(c.name): bad today")
            #expect(OrganizeCopy.heldByState(c.season, today: today) == c.expected, "\(c.name)")
        }
    }

    @Test func routineTodayLinesMatchTheWeb() throws {
        let f = try load()
        for c in f.routineTodaySummary {
            #expect(OrganizeCopy.routineTodaySummary(done: c.done, total: c.total, skipped: c.skipped) == c.expected, "\(c.name)")
        }
        for c in f.routineTodayEmpty {
            #expect(OrganizeCopy.routineTodayEmpty(name: c.routineName, memberCount: c.memberCount) == c.expected, "\(c.name)")
        }
    }

    @Test func seasonWordsMatchTheWeb() throws {
        let f = try load()
        for c in f.seasonStateNote {
            let today = try #require(DayString(c.today), "\(c.name): bad today")
            // `live` is an input; the phone's own answer agrees with it.
            #expect(isSeasonActiveOn(c.season, on: today) == c.live, "\(c.name): live")
            #expect(OrganizeCopy.seasonStateNote(c.season, live: c.live) == c.expected, "\(c.name)")
        }
        for c in f.seasonRunsLabel {
            #expect(OrganizeCopy.seasonRunsLabel(startsOn: c.startsOn, endsOn: c.endsOn) == c.expected, "\(c.name)")
        }
    }

    @Test func goalWordsMatchTheWeb() throws {
        let f = try load()
        for c in f.goalEndedNote {
            #expect(OrganizeCopy.goalEndedNote(c.goal) == c.expected, "\(c.name)")
        }
        for c in f.windDownSentence {
            #expect(OrganizeCopy.windDownSentence(state: c.state, count: c.count) == c.expected, "\(c.name)")
            let goal = Goal(id: "g", name: "G", state: c.state)
            #expect(OrganizeCopy.windDownSentence(goal, count: c.count) == c.expected, "\(c.name): goal")
        }
        for c in f.milestoneTickLabel {
            #expect(OrganizeCopy.milestoneTickLabel(title: c.title, reached: c.reached) == c.expected, "\(c.name)")
        }
    }

    /// The check-in meta, with its two inputs pinned against the phone's own
    /// ports: `cadenceLabel` (Cadence.swift) and `lastDoneOn` (Goals.swift).
    @Test func checkinMetaMatchesTheWeb() throws {
        for c in try load().checkinMeta {
            #expect(cadenceLabel(c.item) == c.cadence, "\(c.name): cadence")
            #expect(lastDoneOn(c.item) == c.lastDone, "\(c.name): lastDone")
            #expect(OrganizeCopy.checkinMeta(cadence: c.cadence, lastDone: c.lastDone) == c.expected, "\(c.name)")
        }
    }

    /// The copy rules (design §6.9): no em dash and no "missed" in any word
    /// this file says.
    @Test func noWordBreaksTheCopyRules() throws {
        let f = try load()
        let today = try #require(DayString("2026-10-23"))
        var words: [String] = [
            OrganizeCopy.nothingInItYet, OrganizeCopy.heldByNone, OrganizeCopy.routineTodayFinished,
            OrganizeCopy.noCheckinYet, OrganizeCopy.noMilestonesYet, OrganizeCopy.noSupportingWork,
            OrganizeCopy.organizeOff.sentence, OrganizeCopy.goalsOff.sentence,
        ]
        words += f.routinePausedNote.map { OrganizeCopy.routinePausedNote($0.routine) }
        words += f.seasonStateNote.map { OrganizeCopy.seasonStateNote($0.season, live: $0.live) }
        words += f.heldByState.map { OrganizeCopy.heldByState($0.season, today: today) }
        words += f.goalEndedNote.compactMap { OrganizeCopy.goalEndedNote($0.goal) }
        words += f.windDownSentence.compactMap { OrganizeCopy.windDownSentence(state: $0.state, count: $0.count) }
        for word in words {
            #expect(!word.unicodeScalars.contains("\u{2014}"), "\(word)")
            #expect(!word.lowercased().contains("missed"), "\(word)")
        }
    }

    /// The Runs chip upper-cases the first UTF-16 unit and nothing else, as
    /// `span[0].toUpperCase()` does, including on a day `formatDay` hands
    /// back unread.
    @Test func theRunsChipCapitalisesOnlyTheFirstUnit() {
        #expect(OrganizeCopy.seasonRunsLabel(startsOn: "someday", endsOn: nil) == "From someday")
        #expect(OrganizeCopy.seasonRunsLabel(startsOn: "", endsOn: "") == nil)
        #expect(OrganizeCopy.seasonRunsLabel(startsOn: nil, endsOn: "2026-12-01T00:00:00Z") == "Until Dec 1")
    }
}
