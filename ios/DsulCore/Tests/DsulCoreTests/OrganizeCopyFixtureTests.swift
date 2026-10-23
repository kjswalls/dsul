import Foundation
import Testing
import DsulCore

// The web's own words for lib/organize-copy.ts, checked against
// OrganizeCopy.swift byte for byte: tests/fixtures/organize/copy.json. From
// O14 the Trash's words too (`whenGone`, `daysUntilPurge`, the row meta, the
// restore sentences and the phone's refusal words), each case with its `now`
// pinned; from O8a a refused container write's words (`containerRefusal`).
// The summary cards' lines are pinned by organize.json (OrganizeFixtureTests).

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
    let trashWindowDays: Int
    let trashKindLabels: [String: String]
    let nothingInTrash: String
    let trashTeaching: String
    let trashLoadFailed: String
    let restoreFailed: String
    let restoreGone: String
    let pauseRefused: String
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

private struct StampCase<Answer: Decodable & Sendable>: Decodable, Sendable {
    let name: String
    let deletedAt: String
    let now: String
    let expected: Answer
}

private struct RowMetaExpected: Decodable, Sendable {
    let kindLine: String
    let meta: String
}

private struct RowMetaCase: Decodable, Sendable {
    let name: String
    let kind: String
    let childCount: Int
    let memberCount: Int
    let deletedAt: String
    let now: String
    let expected: RowMetaExpected
}

private struct RestoreSentenceCase: Decodable, Sendable {
    let name: String
    let kind: String
    let memberCount: Int
    let expected: String
}

private struct RefusalCase: Decodable, Sendable {
    let name: String
    let code: String?
    let projectName: String
    let expected: String
}

private struct NameInTrashCase: Decodable, Sendable {
    let name: String
    let noun: String
    let heldName: String
    let expected: String
}

private struct ContainerRefusalCase: Decodable, Sendable {
    let name: String
    let code: String?
    /// Nil where the phone says what it says for any failed write.
    let expected: String?
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
    let whenGone: [StampCase<String>]
    let daysUntilPurge: [StampCase<Int>]
    let trashRowMeta: [RowMetaCase]
    let restoreSentence: [RestoreSentenceCase]
    let restoreRefusal: [RefusalCase]
    let nameInTrashSentence: [NameInTrashCase]
    let containerRefusal: [ContainerRefusalCase]
}

private func load() throws -> CopyFixture {
    return try loadOrganizeFixture(CopyFixture.self, "copy.json")
}

/// A case's `now`, an ISO instant.
private func instant(_ s: String, _ name: String) throws -> Date {
    return try #require(parseTimestamp(s), "\(name): bad now \(s)")
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
        #expect(!f.whenGone.isEmpty)
        #expect(f.daysUntilPurge.count == f.whenGone.count)
        #expect(!f.trashRowMeta.isEmpty)
        #expect(f.restoreSentence.count >= 4)
        #expect(f.restoreRefusal.count >= 5)
        #expect(!f.nameInTrashSentence.isEmpty)
        #expect(f.containerRefusal.count >= 3)
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
        #expect(OrganizeCopy.trashWindowDays == t.trashWindowDays)
        let kinds = Dictionary(TrashKind.allCases.map { ($0.rawValue, $0.label) }, uniquingKeysWith: { a, _ in a })
        #expect(kinds == t.trashKindLabels)
        #expect(OrganizeCopy.nothingInTrash == t.nothingInTrash)
        #expect(OrganizeCopy.trashTeaching == t.trashTeaching)
        #expect(OrganizeCopy.trashLoadFailed == t.trashLoadFailed)
        #expect(OrganizeCopy.restoreFailed == t.restoreFailed)
        #expect(OrganizeCopy.restoreGone == t.restoreGone)
        #expect(OrganizeCopy.pauseRefused == t.pauseRefused)
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

    /// How long ago, and how long is left, read from Postgres's stamps (six
    /// fractional digits, any offset), a stamp in the future and one that
    /// can't be read.
    @Test func theBinsClockMatchesTheWeb() throws {
        let f = try load()
        for c in f.whenGone {
            let now = try instant(c.now, c.name)
            #expect(OrganizeCopy.whenGone(c.deletedAt, now: now) == c.expected, "\(c.name)")
        }
        for c in f.daysUntilPurge {
            let now = try instant(c.now, c.name)
            #expect(OrganizeCopy.daysUntilPurge(c.deletedAt, now: now) == c.expected, "\(c.name)")
        }
    }

    @Test func theTrashRowsMetaMatchesTheWeb() throws {
        for c in try load().trashRowMeta {
            let kind = try #require(TrashKind(rawValue: c.kind), "\(c.name): bad kind")
            let now = try instant(c.now, c.name)
            #expect(
                OrganizeCopy.trashKindLine(kind, childCount: c.childCount, memberCount: c.memberCount) == c.expected.kindLine,
                "\(c.name): kindLine"
            )
            #expect(
                OrganizeCopy.trashRowMeta(
                    kind, childCount: c.childCount, memberCount: c.memberCount, deletedAt: c.deletedAt, now: now
                ) == c.expected.meta,
                "\(c.name): meta"
            )
            let row = TrashRow(
                kind: kind, id: "x", name: "X", deletedAt: c.deletedAt, childCount: c.childCount, memberCount: c.memberCount
            )
            #expect(OrganizeCopy.trashRowMeta(row, now: now) == c.expected.meta, "\(c.name): row")
        }
    }

    @Test func theRestoreWordsMatchTheWeb() throws {
        let f = try load()
        for c in f.restoreSentence {
            let kind = try #require(TrashKind(rawValue: c.kind)?.container, "\(c.name): not a container kind")
            #expect(OrganizeCopy.restoreSentence(kind, memberCount: c.memberCount) == c.expected, "\(c.name)")
        }
        for c in f.restoreRefusal {
            #expect(OrganizeCopy.restoreRefusal(code: c.code, name: c.projectName) == c.expected, "\(c.name)")
        }
        for c in f.nameInTrashSentence {
            #expect(OrganizeCopy.nameInTrashSentence(noun: c.noun, name: c.heldName) == c.expected, "\(c.name)")
        }
    }

    /// A refused container write's banner (O8a), for every intent the phone
    /// sends: the code alone decides it today.
    @Test func theContainerRefusalWordsMatchTheWeb() throws {
        let intents: [ContainerIntent] = [
            .pause(until: nil, timeZone: nil), .resume(timeZone: nil), .state(.paused),
        ]
        for c in try load().containerRefusal {
            for intent in intents {
                #expect(OrganizeCopy.refusal(code: c.code, for: intent) == c.expected, "\(c.name)")
            }
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
        words += [
            OrganizeCopy.nothingInTrash, OrganizeCopy.trashTeaching, OrganizeCopy.trashLoadFailed,
            OrganizeCopy.restoreFailed, OrganizeCopy.restoreGone, OrganizeCopy.pauseRefused,
        ]
        words += f.trashRowMeta.map(\.expected.meta)
        words += f.restoreSentence.map(\.expected)
        words += f.restoreRefusal.map(\.expected)
        words += f.nameInTrashSentence.map(\.expected)
        words += f.containerRefusal.compactMap(\.expected)
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
