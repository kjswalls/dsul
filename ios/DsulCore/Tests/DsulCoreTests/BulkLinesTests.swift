import Foundation
import Testing
import DsulCore

// BulkLines.swift against the web's lib/bulk-add.ts. Each case in
// tests/fixtures/day/edit-writes.json's `bulk` is a pasted text with what the
// real `isBulkPaste` and `splitBulkLinesWithMeta` answered for it
// (tests/unit/edit-writes-fixtures.test.ts writes them). The hand-written
// tests after it pin what a direct translation would get wrong: "\r\n" as
// one break, a Unicode digit or space the web's regex doesn't read as one,
// and the marker's fallback.

/// One pasted text and the web's answers for it.
private struct BulkCase: Decodable, Sendable {
    let name: String
    let input: String
    let isBulk: Bool
    let titles: [String]
    let truncated: Bool
}

/// The fixture's `bulk`, read on its own, as `limits` is.
private struct BulkFixture: Decodable, Sendable {
    let bulk: [BulkCase]
}

/// By scalar: String's == would call some different strings equal.
private func scalars(_ titles: [String]) -> [[Unicode.Scalar]] {
    return titles.map { Array($0.unicodeScalars) }
}

@Suite struct BulkLinesFixtureTests {
    @Test func eachPasteSplitsAsTheWebSplitsIt() throws {
        let cases = try JSONDecoder().decode(BulkFixture.self, from: editWritesData()).bulk
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(isBulkPaste(c.input) == c.isBulk, "\(c.name): isBulk")
            let split = splitBulkLinesWithMeta(c.input)
            #expect(scalars(split.titles) == scalars(c.titles), "\(c.name): titles")
            #expect(split.truncated == c.truncated, "\(c.name): truncated")
        }
    }

    /// The cases the port needs: a paste past the cap, and text that isn't a
    /// list.
    @Test func theCasesReachEveryAnswer() throws {
        let cases = try JSONDecoder().decode(BulkFixture.self, from: editWritesData()).bulk
        #expect(cases.contains { $0.truncated && $0.titles.count == maxBulkItems }, "a paste past the cap")
        #expect(cases.contains { !$0.isBulk }, "not a list")
        #expect(cases.contains { $0.isBulk && !$0.truncated }, "a list")
    }
}

@Suite struct BulkLinesTests {
    /// "\r\n" is one break: Swift's one Character, the web's one match.
    @Test func crlfIsOneBreak() {
        #expect(splitBulkLinesWithMeta("a\r\nb").titles == ["a", "b"])
        #expect(splitBulkLinesWithMeta("a\rb").titles == ["a", "b"])
        #expect(splitBulkLinesWithMeta("a\n\n\nb").titles == ["a", "b"])
        #expect(splitBulkLinesWithMeta("a\r\n\r\nb\r\n").titles == ["a", "b"])
        #expect(isBulkPaste("a\r\nb"))
    }

    /// Only "\r" and "\n" break a line: U+2028 and U+0085 stay inside it,
    /// and U+2028 at a line's ends is trimmed, as JavaScript trims it.
    @Test func otherLineEndsDontSplit() {
        let joined = splitBulkLinesWithMeta("a\u{2028}b\nc")
        #expect(scalars(joined.titles) == scalars(["a\u{2028}b", "c"]))
        #expect(!isBulkPaste("a\u{2028}b"))
        #expect(!isBulkPaste("a\u{85}b"))
        #expect(scalars(splitBulkLinesWithMeta("\u{2028}a\u{2028}\nb").titles) == scalars(["a", "b"]))
    }

    @Test func eachBulletIsStripped() {
        for bullet in ["-", "*", "+", "\u{2022}", "\u{2013}", "\u{2014}", "1.", "12)", "123."] {
            #expect(splitBulkLinesWithMeta("\(bullet) a\n\(bullet)\tb").titles == ["a", "b"], "\(bullet)")
        }
    }

    @Test func checkboxesAreStripped() {
        #expect(splitBulkLinesWithMeta("- [ ] a\n- [x] b\n* [X] c\n+[ ] d").titles == ["a", "b", "c", "d"])
    }

    /// Without a space after the box, the checkbox doesn't match, and the
    /// bullet alone does: the box stays.
    @Test func aBoxWithoutASpaceFallsBackToTheBullet() {
        #expect(splitBulkLinesWithMeta("- [ ]task").titles == ["[ ]task"])
        #expect(splitBulkLinesWithMeta("-[ ]task").titles == ["-[ ]task"])
    }

    /// What isn't a marker stays: no space after it, four digits, a second
    /// dash (stripped once, never twice), and digits that aren't ASCII.
    @Test func whatIsntAMarkerStays() {
        #expect(splitBulkLinesWithMeta("-a").titles == ["-a"])
        #expect(splitBulkLinesWithMeta("1)a").titles == ["1)a"])
        #expect(splitBulkLinesWithMeta("1234. a").titles == ["1234. a"])
        #expect(splitBulkLinesWithMeta("- - hello").titles == ["- hello"])
        #expect(splitBulkLinesWithMeta("\u{661}. a").titles == ["\u{661}. a"])
        #expect(splitBulkLinesWithMeta("\u{FF11}. a").titles == ["\u{FF11}. a"])
    }

    /// JavaScript's whitespace before and after the marker, and around the
    /// line: NBSP and U+FEFF count, U+0085 doesn't.
    @Test func javaScriptsSpacesCount() {
        #expect(splitBulkLinesWithMeta("  - indented").titles == ["indented"])
        #expect(splitBulkLinesWithMeta("\u{A0}-\u{A0}a\u{FEFF}").titles == ["a"])
        #expect(splitBulkLinesWithMeta("\u{FEFF}1.\u{3000}b").titles == ["b"])
        #expect(scalars(splitBulkLinesWithMeta("-\u{85}a").titles) == scalars(["-\u{85}a"]))
    }

    /// One line is a plain paste, however long and with a break at its end;
    /// blank lines don't count.
    @Test func oneLineIsNoList() {
        #expect(!isBulkPaste("Eggs\n"))
        #expect(!isBulkPaste("\n\n  Eggs  \n\n"))
        #expect(!isBulkPaste(String(repeating: "x", count: 2_000)))
        #expect(!isBulkPaste("- \n* \n1. "))
        #expect(!isBulkPaste(""))
        #expect(splitBulkLinesWithMeta(" \n\t\n").titles.isEmpty)
        #expect(isBulkPaste("- Eggs\n- Milk"))
    }

    /// Past `maxBulkItems` lines, the first 500 and `truncated`; `isBulkPaste`
    /// isn't capped.
    @Test func aLongPasteIsCapped() {
        let lines = (1...501).map { "Line \($0)" }
        let split = splitBulkLinesWithMeta(lines.joined(separator: "\n"))
        #expect(split.titles == Array(lines.prefix(500)))
        #expect(split.truncated)
        let exact = splitBulkLinesWithMeta(lines.prefix(500).joined(separator: "\n"))
        #expect(exact.titles.count == 500)
        #expect(!exact.truncated)
        #expect(maxBulkItems == 500)
    }

    /// The titles are trimmed, never cut: a line's cap is the caller's.
    @Test func aLongLineIsKeptWhole() {
        let long = String(repeating: "y", count: 600)
        #expect(splitBulkLinesWithMeta("- \(long)\n- b").titles == [long, "b"])
    }
}
