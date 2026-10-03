import Foundation

// Port of lib/bulk-add.ts `MAX_BULK_ITEMS`, `isBulkPaste` and
// `splitBulkLinesWithMeta` (with `LIST_MARKER`): what a pasted list is, and the
// titles it holds. The item sheet's subtask field reads a paste through these,
// as the web's Subtasks section does. Keep in step: a change there without the
// same change here is drift, and a paste adds different subtasks on the phone.
// Checked against the web by BulkLinesTests (edit-writes.json's `bulk`, which
// the real functions compute).
//
// Two things a direct translation would get wrong:
// - Lines are split by Unicode scalar on "\r\n", "\r" and "\n", as the web's
//   `/\r\n|\r|\n/`. Swift's "\r\n" is one Character, so a split by Character
//   misses it; U+2028 and U+0085 are not breaks there and are not here.
// - The marker is matched by hand. NSRegularExpression's `\s` and `\d` are
//   Unicode-wide, where the web's regex (no `u` flag) reads `\s` as
//   JavaScript's whitespace (`isJSWhitespace`) and `\d` as ASCII 0-9 alone.

/// lib/bulk-add.ts `MAX_BULK_ITEMS`: the most titles one paste gives. Past it
/// the rest are dropped and `truncated` says so, so the caller can too.
public let maxBulkItems = 500

/// The bullets `LIST_MARKER` strips: `-`, `*`, `+`, `•`, `–` (U+2013) and `—`
/// (U+2014).
private func isBullet(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar {
    case "-", "*", "+", "\u{2022}", "\u{2013}", "\u{2014}":
        return true
    default:
        return false
    }
}

/// `\d` without the `u` flag: ASCII digits only, so "١. a" is no marker.
private func isASCIIDigit(_ scalar: Unicode.Scalar) -> Bool {
    return scalar.value >= 0x30 && scalar.value <= 0x39
}

/// `text.split(/\r\n|\r|\n/)`, by scalar: every line, empty ones included.
private func splitLines(_ text: String) -> [String] {
    var lines: [String] = []
    var line = String.UnicodeScalarView()
    var scalars = text.unicodeScalars.makeIterator()
    var pending = scalars.next()
    while let scalar = pending {
        pending = scalars.next()
        switch scalar {
        case "\r":
            // "\r\n" is one break, never two.
            if pending == "\n" { pending = scalars.next() }
            lines.append(String(line))
            line = String.UnicodeScalarView()
        case "\n":
            lines.append(String(line))
            line = String.UnicodeScalarView()
        default:
            line.append(scalar)
        }
    }
    lines.append(String(line))
    return lines
}

/// Where `LIST_MARKER` stops matching in `s`, or nil when it doesn't match:
/// `^\s*(?:[-*+•–—]\s*\[[ xX]\]|[-*+•–—]|\d{1,3}[.)])\s+`, its alternatives
/// tried in order, as the regex tries them:
/// 1. a bullet, `\s*`, then `[ ]`, `[x]` or `[X]`;
/// 2. a bullet alone;
/// 3. one to three ASCII digits directly followed by `.` or `)`.
/// Each must then be followed by at least one space. The first that is wins,
/// so `- [ ]task` (no space after the box) falls back to 2 and keeps `[ ]task`.
/// A run of four digits or more never matches: backtracking `\d{1,3}` leaves
/// a digit where `[.)]` must be. Backtracking the leading `\s*` never helps
/// either, since a bullet or a digit can't be whitespace.
private func listMarkerEnd(_ s: [Unicode.Scalar]) -> Int? {
    var start = 0
    while start < s.count, isJSWhitespace(s[start]) { start += 1 }

    /// `\s+` from `i`: where the spaces end, or nil when there are none.
    func spaces(from i: Int) -> Int? {
        var j = i
        while j < s.count, isJSWhitespace(s[j]) { j += 1 }
        return j > i ? j : nil
    }

    guard start < s.count else { return nil }
    if isBullet(s[start]) {
        // 1. The checkbox.
        var i = start + 1
        while i < s.count, isJSWhitespace(s[i]) { i += 1 }
        if i + 2 < s.count, s[i] == "[", s[i + 1] == " " || s[i + 1] == "x" || s[i + 1] == "X", s[i + 2] == "]",
           let end = spaces(from: i + 3) {
            return end
        }
        // 2. The bullet alone.
        return spaces(from: start + 1)
    }
    // 3. A number.
    var i = start
    while i < s.count, i - start < 3, isASCIIDigit(s[i]) { i += 1 }
    guard i > start, i < s.count, s[i] == "." || s[i] == ")" else { return nil }
    return spaces(from: i + 1)
}

/// `line.replace(LIST_MARKER, '').trim()`: the marker stripped once, never
/// twice ("- - hello" keeps its second dash), then `String.prototype.trim`.
private func bulkTitle(_ line: String) -> String {
    let scalars = Array(line.unicodeScalars)
    guard let end = listMarkerEnd(scalars) else { return jsTrim(line) }
    var rest = String.UnicodeScalarView()
    rest.append(contentsOf: scalars[end...])
    return jsTrim(String(rest))
}

/// lib/bulk-add.ts `splitBulkLinesWithMeta`: one title per non-empty line,
/// list markers stripped, in order, at most `maxBulkItems`; `truncated` when
/// the text held more. The titles are trimmed but not cut: a caller with a cap
/// of its own applies it (`cleanTitle`).
public func splitBulkLinesWithMeta(_ text: String) -> (titles: [String], truncated: Bool) {
    let titles = splitLines(text).map(bulkTitle).filter { !$0.isEmpty }
    return (Array(titles.prefix(maxBulkItems)), titles.count > maxBulkItems)
}

/// lib/bulk-add.ts `isBulkPaste`: does the text hold two or more lines that
/// survive parsing? Uncapped. One line, however long, is a plain paste, and so
/// is one line with a break at its end.
public func isBulkPaste(_ text: String) -> Bool {
    var count = 0
    for line in splitLines(text) where !bulkTitle(line).isEmpty {
        count += 1
        if count > 1 { return true }
    }
    return false
}
