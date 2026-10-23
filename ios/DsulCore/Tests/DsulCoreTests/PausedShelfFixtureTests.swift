import Foundation
import Testing
import DsulCore

// The web's own answers for lib/paused-shelf.ts, checked against
// PausedShelf.swift: tests/fixtures/organize/paused.json. O5 pins the shelf
// (grouped by return day, a container as one entry, a trip's rest left out),
// the Paused row's line (`pausedNote`), the day headings (`returnDayLabel`,
// `pausedDayLabel`), each entry's words (`pausedEntryName`, `entryKindLine`,
// `pausedStateLine`) and what comes back on a day (`backOn`).

private struct Tables: Decodable, Sendable {
    let noDate: String
    let nothingPaused: String
    let welcome: String
}

private struct World: Decodable, Sendable {
    let items: [Item]
    let routines: [Routine]
    let seasons: [Season]
}

private struct EntryExpected: Decodable, Sendable {
    let kind: String
    let key: String
    let id: String
    let name: String
    let until: String?
    let itemIds: [String]
    let kindLine: String
    let stateLine: String
}

private struct DayExpected: Decodable, Sendable {
    let key: String
    let until: String?
    let label: String
    let entries: [EntryExpected]
}

private struct ShelfExpected: Decodable, Sendable {
    let count: Int
    let note: String?
    let days: [DayExpected]
}

private struct ShelfCase: Decodable, Sendable {
    let name: String
    let items: [Item]
    let routines: [Routine]
    let seasons: [Season]
    let away: [AwayPeriod]
    let today: String
    let timeZone: String
    let expected: ShelfExpected
}

private struct NoteCase: Decodable, Sendable {
    let name: String
    let items: [Item]
    let today: String
    let timeZone: String
    let expected: String?
}

private struct DayLabelCase: Decodable, Sendable {
    let name: String
    let day: String
    let today: String
    let expected: String
}

/// An item row's kind line, asked of the web's registry once the user's
/// types are hydrated; `itemTypes` are those types, passed here as `labels`.
private struct KindLineCase: Decodable, Sendable {
    let name: String
    let item: Item
    let itemTypes: [ItemTypeLabel]
    let expected: String
}

private struct BackOnCase: Decodable, Sendable {
    let name: String
    let date: String
    let timeZone: String
    let expected: [String]
}

private struct PausedFixture: Decodable, Sendable {
    let tables: Tables
    let world: World
    let pausedShelf: [ShelfCase]
    let pausedNote: [NoteCase]
    let returnDayLabel: [DayLabelCase]
    let entryKindLine: [KindLineCase]
    let backOn: [BackOnCase]
}

private func load() throws -> PausedFixture {
    return try loadOrganizeFixture(PausedFixture.self, "paused.json")
}

/// One case's shelf, asked as the fixture's writer asked it: with its trips.
private func shelf(_ c: ShelfCase) throws -> (shelf: PausedShelf, today: DayString) {
    let today = try #require(DayString(c.today), "\(c.name): bad today")
    let answer = pausedShelf(
        c.items, on: today, timeZone: c.timeZone, routines: c.routines, seasons: c.seasons, away: c.away
    )
    return (answer, today)
}

@Suite struct PausedShelfFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try load()
        #expect(!f.world.items.isEmpty)
        #expect(f.pausedShelf.count >= 4)
        #expect(f.pausedNote.count >= 6)
        #expect(f.returnDayLabel.count >= 7)
        #expect(f.backOn.count >= 4)
        #expect(f.entryKindLine.count >= 5)
        // At least one case of every entry kind, and an undated group.
        let entries = f.pausedShelf.flatMap { $0.expected.days.flatMap(\.entries) }
        #expect(Set(entries.map(\.kind)) == ["item", "routine", "season"])
        #expect(f.pausedShelf.contains { c in c.expected.days.contains { $0.until == nil } })
    }

    @Test func theTablesAreTheWebs() throws {
        let t = try load().tables
        #expect(PausedShelf.noDate == t.noDate)
        #expect(PausedShelf.nothingPaused == t.nothingPaused)
        #expect(PausedShelf.welcome == t.welcome)
    }

    @Test func theShelfMatchesTheWeb() throws {
        for c in try load().pausedShelf {
            let (answer, today) = try shelf(c)
            #expect(answer.count == c.expected.count, "\(c.name): count")
            #expect(pausedNote(answer, today: today) == c.expected.note, "\(c.name): note")
            #expect(answer.days.map(\.key) == c.expected.days.map(\.key), "\(c.name): days")
            for (day, want) in zip(answer.days, c.expected.days) {
                let where_ = "\(c.name), \(want.key.isEmpty ? "no date" : want.key)"
                #expect(day.until == want.until, "\(where_): until")
                #expect(day.id == want.key, "\(where_): id")
                #expect(pausedDayLabel(day, today: today) == want.label, "\(where_): label")
                #expect(day.entries.map(\.key) == want.entries.map(\.key), "\(where_): entries")
                for (entry, e) in zip(day.entries, want.entries) {
                    let at = "\(where_), \(e.key)"
                    #expect(entry.kind.rawValue == e.kind, "\(at): kind")
                    #expect(entry.id == e.key, "\(at): id")
                    #expect(entry.subjectId == e.id, "\(at): subject")
                    #expect(pausedEntryName(entry) == e.name, "\(at): name")
                    #expect(entry.until == e.until, "\(at): until")
                    #expect(entry.items.map { $0.id.uuidString.lowercased() } == e.itemIds, "\(at): items")
                    #expect(entryKindLine(entry) == e.kindLine, "\(at): kindLine")
                    // The state line is asked with no trips, as the detail pane asks it.
                    let line = pausedStateLine(
                        entry, on: today, timeZone: c.timeZone, routines: c.routines, seasons: c.seasons
                    )
                    #expect(line == e.stateLine, "\(at): stateLine")
                }
            }
        }
    }

    /// The row's count is the number of items behind it, never of entries:
    /// a routine of two counts two.
    @Test func theCountIsItemsNotEntries() throws {
        for c in try load().pausedShelf {
            let (answer, _) = try shelf(c)
            let items = answer.days.flatMap(\.entries).map(\.items.count).reduce(0, +)
            #expect(answer.count == items, "\(c.name)")
        }
    }

    /// The caller's own hidden set gives the same shelf as the one it saves.
    @Test func aSuppliedHiddenSetGivesTheSameShelf() throws {
        for c in try load().pausedShelf {
            let (answer, today) = try shelf(c)
            let hidden = inactiveItemIdsOn(
                items: c.items, date: today, timeZone: c.timeZone, routines: c.routines, seasons: c.seasons,
                away: c.away
            )
            let supplied = pausedShelf(
                c.items, on: today, timeZone: c.timeZone, routines: c.routines, seasons: c.seasons, away: c.away,
                suppressed: hidden
            )
            #expect(supplied == answer, "\(c.name)")
        }
    }

    /// The row's line, asked of a shelf over the user's zone alone (no
    /// routines, seasons or trips).
    @Test func thePausedRowsLineMatchesTheWeb() throws {
        for c in try load().pausedNote {
            let today = try #require(DayString(c.today), "\(c.name): bad today")
            let answer = pausedShelf(c.items, on: today, timeZone: c.timeZone)
            #expect(pausedNote(answer, today: today) == c.expected, "\(c.name)")
        }
    }

    @Test func returnDayLabelMatchesTheWeb() throws {
        for c in try load().returnDayLabel {
            let today = try #require(DayString(c.today), "\(c.name): bad today")
            #expect(returnDayLabel(c.day, today: today) == c.expected, "\(c.name)")
        }
    }

    @Test func backOnMatchesTheWeb() throws {
        let f = try load()
        for c in f.backOn {
            let day = try #require(DayString(c.date), "\(c.name): bad date")
            let names = backOn(
                f.world.items, on: day, timeZone: c.timeZone, routines: f.world.routines, seasons: f.world.seasons
            )
            #expect(names == c.expected, "\(c.name)")
        }
    }

    /// The web's hydrated answers: a custom type as the user named it, its
    /// slug capitalised when the label is empty or the type has no row, and a
    /// built-in's own noun.
    @Test func anItemsKindLineMatchesTheHydratedWeb() throws {
        for c in try load().entryKindLine {
            let labels = Dictionary(c.itemTypes.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
            #expect(entryKindLine(.item(c.item, until: nil), labels: labels) == c.expected, "\(c.name)")
        }
    }

    /// A custom type the payload names reads as the user named it, as the
    /// web's hydrated registry does; one it doesn't name, capitalised.
    @Test func anItemsKindLineTakesThePayloadsLabels() throws {
        let f = try load()
        let book = try #require(f.world.items.first { $0.typeName == "book" })
        let entry = PausedEntry.item(book, until: nil)
        #expect(entryKindLine(entry) == "Book")
        let labels = ["book": ItemTypeLabel(name: "book", label: "Reading", labelPlural: "Reading")]
        #expect(entryKindLine(entry, labels: labels) == "Reading")
        // A built-in type keeps its own noun whatever the labels say.
        let task = try #require(f.world.items.first { $0.type == "task" })
        #expect(entryKindLine(.item(task, until: nil), labels: ["task": ItemTypeLabel(name: "task", label: "Chore", labelPlural: "")]) == "Task")
    }

    /// A container says "habits" only when every member it hides is one.
    @Test func aContainersKindLineCountsItsMembers() throws {
        let f = try load()
        let habits = f.world.items.filter { $0.type == "habit" }
        let task = try #require(f.world.items.first { $0.type == "task" && $0.parentItemId == nil })
        let routine = try #require(f.world.routines.first)
        let season = try #require(f.world.seasons.first)
        #expect(entryKindLine(.routine(routine, until: nil, items: Array(habits.prefix(1)))) == "Routine \u{00B7} 1 habit")
        #expect(entryKindLine(.routine(routine, until: nil, items: Array(habits.prefix(3)))) == "Routine \u{00B7} 3 habits")
        #expect(entryKindLine(.season(season, until: nil, items: [task])) == "Season \u{00B7} 1 item")
        #expect(entryKindLine(.season(season, until: nil, items: [habits[0], task])) == "Season \u{00B7} 2 items")
    }

    /// The guilt-free law and the copy rules: nothing on the shelf is late or
    /// missed, and no word carries an em dash.
    @Test func noWordBreaksTheCopyRules() throws {
        let f = try load()
        var words = [PausedShelf.noDate, PausedShelf.nothingPaused, PausedShelf.welcome]
        for c in f.pausedShelf {
            words += c.expected.note.map { [$0] } ?? []
            for day in c.expected.days {
                words.append(day.label)
                words += day.entries.flatMap { [$0.kindLine, $0.stateLine] }
            }
        }
        words += f.returnDayLabel.map(\.expected)
        for word in words {
            #expect(!word.unicodeScalars.contains("\u{2014}"), "\(word)")
            #expect(!word.lowercased().contains("missed"), "\(word)")
            #expect(!word.lowercased().contains("overdue"), "\(word)")
        }
    }
}
