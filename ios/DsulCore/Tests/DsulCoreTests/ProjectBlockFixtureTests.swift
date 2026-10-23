import Foundation
import Testing
import DsulCore

// The web's own answers for lib/project-block.ts, checked against
// ProjectBlock.swift: tests/fixtures/organize/look.json, `blocks`.

private struct BlockExpected: Decodable, Sendable {
    let hasTimeBlock: Bool
    let when: String
    let summary: String?
}

private struct BlockCase: Decodable, Sendable {
    let name: String
    let project: Project
    let expected: BlockExpected
}

private struct BlocksFixture: Decodable, Sendable {
    let blocks: [BlockCase]
}

private func load() throws -> BlocksFixture {
    return try loadOrganizeFixture(BlocksFixture.self, "look.json")
}

@Suite struct ProjectBlockFixtureTests {
    @Test func everySectionHasCases() throws {
        let f = try load()
        #expect(!f.blocks.isEmpty)
        // A block and no block are both covered.
        #expect(f.blocks.contains { $0.expected.hasTimeBlock })
        #expect(f.blocks.contains { !$0.expected.hasTimeBlock })
    }

    @Test func theBlockMatchesTheWeb() throws {
        for c in try load().blocks {
            #expect(hasTimeBlock(c.project) == c.expected.hasTimeBlock, "\(c.name): hasTimeBlock")
            #expect(blockWhen(c.project) == c.expected.when, "\(c.name): when")
            #expect(timeBlockSummary(c.project) == c.expected.summary, "\(c.name): summary")
        }
    }

    /// The range is the web's en dash and the separator its middle dot, byte
    /// for byte.
    @Test func theDashAndTheDotAreTheWebs() throws {
        let c = try #require(try load().blocks.first { $0.expected.summary != nil })
        let summary = try #require(timeBlockSummary(c.project))
        #expect(summary.unicodeScalars.contains("\u{2013}"))
        #expect(summary.unicodeScalars.contains("\u{00B7}"))
        #expect(!summary.unicodeScalars.contains("\u{2014}"))
    }

    /// `/^(\d{1,2}):(\d{2})/`: one or two digits, a colon, two digits, then
    /// anything; everything else is midnight.
    @Test func minutesOfClockIsTheWebsPattern() {
        #expect(minutesOfClock("9:05") == 545)
        #expect(minutesOfClock("09:05") == 545)
        #expect(minutesOfClock("23:59:59") == 1439)
        #expect(minutesOfClock("123:45") == 0)
        #expect(minutesOfClock("9:5") == 0)
        #expect(minutesOfClock("") == 0)
        #expect(minutesOfClock("\u{0661}\u{0662}:00") == 0)
        // A negative length wraps back past midnight, as `clockLabel` does.
        #expect(clockLabel(-30) == "11:30pm")
        #expect(clockLabel(1440 + 65) == "1:05am")
    }

    /// The repeats are the editor's five, in its order, without `none`.
    @Test func theRepeatsAreTheEditors() {
        #expect(projectRepeats.map(\.value) == ["daily", "weekdays", "weekends", "monthly", "custom"])
        #expect(projectRepeats.map(\.label) == ["Every day", "Weekdays", "Weekends", "Monthly", "Chosen days"])
    }
}
