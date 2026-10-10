import Foundation
import Testing
import DsulCore

// The web's own words for lib/reminders/copy.ts, checked against
// ReminderCopy.swift, and the copy contract itself: NEVER_SCOLDS
// (tests/unit/support/copy-contract.ts) travels in the fixture as a pattern
// and its flags, so the phone holds its own lines to the same rule through
// NSRegularExpression. `contract` pins what the pattern catches and what it
// lets through, its known false positive included, so an engine that reads the
// pattern differently fails here before it passes a scold.
// tests/unit/day-fixtures.test.ts writes tests/fixtures/day/copy.json; never
// edit it by hand: regenerate it from the Vitest side (UPDATE_FIXTURES=1).

private struct TextFixture: Decodable, Sendable, Equatable {
    let title: String
    let body: String
}

private struct PatternFixture: Decodable, Sendable {
    let source: String
    let flags: String
}

private struct ContractCase: Decodable, Sendable {
    let name: String
    let line: String
    let scolds: Bool
}

private struct StreakPhraseCase: Decodable, Sendable {
    let name: String
    let streak: Int
    let expected: String
}

private struct ReminderCopyCase: Decodable, Sendable {
    let name: String
    let item: Item
    let at: String
    let anchor: String?
    let snoozed: Bool
    let timeFormat: String
    let expected: TextFixture
}

private struct LastCallCopyCase: Decodable, Sendable {
    let name: String
    let items: [Item]
    let expected: TextFixture?
}

private struct Fixture: Decodable, Sendable {
    let neverScolds: PatternFixture
    let contract: [ContractCase]
    let streakPhrase: [StreakPhraseCase]
    let reminderCopy: [ReminderCopyCase]
    let lastCallCopy: [LastCallCopyCase]
    let eodCopy: TextFixture
}

private enum FixtureError: Error {
    case notFound(String)
    case badFlag(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/copy.json"
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

/// NEVER_SCOLDS as NSRegularExpression reads it. Only the flags the web's
/// pattern uses are known; any other fails loudly rather than being dropped.
private func neverScolds(_ p: PatternFixture) throws -> NSRegularExpression {
    var options: NSRegularExpression.Options = []
    for flag in p.flags {
        switch flag {
        case "i": options.insert(.caseInsensitive)
        default: throw FixtureError.badFlag(String(flag))
        }
    }
    return try NSRegularExpression(pattern: p.source, options: options)
}

private func scolds(_ regex: NSRegularExpression, _ line: String) -> Bool {
    let range = NSRange(line.startIndex..<line.endIndex, in: line)
    return regex.firstMatch(in: line, options: [], range: range) != nil
}

private func text(_ t: NotificationText) -> TextFixture {
    return TextFixture(title: t.title, body: t.body)
}

@Suite struct CopyFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try loadFixture()
        #expect(Set(f.contract.map(\.scolds)) == [true, false])
        #expect(!f.streakPhrase.isEmpty)
        #expect(!f.reminderCopy.isEmpty)
        #expect(f.lastCallCopy.contains { $0.expected == nil })
        #expect(f.lastCallCopy.contains { $0.expected != nil })
    }

    /// The pattern reads the same here as in JavaScript: each pinned line
    /// scolds, or doesn't, exactly as the web's RegExp said.
    @Test func neverScoldsReadsAsTheWebReadsIt() throws {
        let f = try loadFixture()
        let regex = try neverScolds(f.neverScolds)
        for c in f.contract {
            #expect(scolds(regex, c.line) == c.scolds, "\(c.name): \(c.line)")
        }
    }

    @Test func streakPhraseMatchesTheWeb() throws {
        for c in try loadFixture().streakPhrase {
            #expect(streakPhrase(c.streak) == c.expected, "\(c.name)")
        }
    }

    @Test func reminderCopyMatchesTheWeb() throws {
        for c in try loadFixture().reminderCopy {
            let format = try #require(TimeFormat(rawValue: c.timeFormat), "\(c.name): \(c.timeFormat)")
            let candidate = ReminderCandidate(item: c.item, at: c.at, anchor: c.anchor, snoozed: c.snoozed)
            #expect(text(reminderCopy(candidate, timeFormat: format)) == c.expected, "\(c.name)")
        }
    }

    @Test func lastCallCopyMatchesTheWeb() throws {
        for c in try loadFixture().lastCallCopy {
            #expect(lastCallCopy(c.items).map(text) == c.expected, "\(c.name)")
        }
    }

    @Test func eodCopyMatchesTheWeb() throws {
        let f = try loadFixture()
        // Compared as Strings: the title ends in an emoji (U+1F319).
        #expect(eodCopy.title == f.eodCopy.title)
        #expect(eodCopy.body == f.eodCopy.body)
    }

    /// Every line the Swift side says keeps the contract, whatever the fixture
    /// expects: the words are the intervention.
    @Test func everySwiftLineKeepsTheContract() throws {
        let f = try loadFixture()
        let regex = try neverScolds(f.neverScolds)
        var lines: [String] = [eodCopy.title, eodCopy.body]
        for c in f.reminderCopy {
            let format = TimeFormat(rawValue: c.timeFormat) ?? .twelveHour
            let words = reminderCopy(
                ReminderCandidate(item: c.item, at: c.at, anchor: c.anchor, snoozed: c.snoozed), timeFormat: format
            )
            lines += [words.title, words.body]
        }
        for c in f.lastCallCopy {
            if let words = lastCallCopy(c.items) { lines += [words.title, words.body] }
        }
        for line in lines {
            #expect(!scolds(regex, line), "\(line)")
        }
    }
}
