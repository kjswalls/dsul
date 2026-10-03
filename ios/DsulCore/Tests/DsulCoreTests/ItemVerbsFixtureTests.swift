import Foundation
import Testing
import DsulCore

// The web's own answers for lib/item-verbs.ts, checked against ItemVerbs.swift.
// tests/unit/day-fixtures.test.ts asks the real `ITEM_VERBS` for each of the
// sheet's verbs (its gate, label, and the carry's detail and landing day) per
// item, day, today, zone, occurrence and Streaks switch, and `eligibleVerbs`
// in order, then writes tests/fixtures/day/verbs.json. Never edit the JSON by
// hand: regenerate it from the Vitest side (UPDATE_FIXTURES=1).

/// One verb's answer. `detail` and `target` are the carry's only.
private struct VerbAnswer: Decodable, Sendable {
    let eligible: Bool
    let label: String
    let detail: String?
    let target: String?
}

private struct VerbsCase: Decodable, Sendable {
    let name: String
    let item: Item
    let dateStr: String
    let todayStr: String
    let timeZone: String
    /// What the caller knew: an occurrence, "absent", or null for unknown.
    /// Taken as given, never recomputed.
    let occurrence: String?
    /// The Streaks extension, as lib/extension-gates.ts `streaksEnabled()`
    /// answered it for the case.
    let streaksEnabled: Bool
    let verbs: [String: VerbAnswer]
    let eligible: [String]
}

private struct Fixture: Decodable, Sendable {
    let cases: [VerbsCase]
}

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadFixture(_ here: String = #filePath) throws -> Fixture {
    let relative = "tests/fixtures/day/verbs.json"
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

/// The case's context, its occurrence and Streaks switch read as given.
private func context(_ c: VerbsCase) throws -> VerbContext {
    var occurrence: Occurrence?
    if let raw = c.occurrence {
        occurrence = try #require(Occurrence(rawValue: raw), "\(c.name): unknown occurrence \(raw)")
    }
    return VerbContext(
        dateStr: c.dateStr, todayStr: c.todayStr, timeZone: c.timeZone, occurrence: occurrence,
        streaksEnabled: c.streaksEnabled
    )
}

@Suite struct ItemVerbsFixtureTests {
    /// Delete is the exception: always eligible, so the fixture has no
    /// refusal of it to show (day-fixtures.test.ts exempts it the same way).
    @Test func hasCasesForEveryVerbBothWays() throws {
        let cases = try loadFixture().cases
        #expect(!cases.isEmpty)
        for verb in VerbID.allCases where verb != .delete {
            let answers = cases.compactMap { $0.verbs[verb.rawValue]?.eligible }
            #expect(answers.contains(true), "\(verb.rawValue) is eligible somewhere")
            #expect(answers.contains(false), "\(verb.rawValue) is refused somewhere")
        }
        let deletes = cases.compactMap { $0.verbs[VerbID.delete.rawValue]?.eligible }
        #expect(deletes.count == cases.count, "delete answers in every case")
        #expect(deletes.allSatisfy { $0 }, "delete is always eligible")
        #expect(cases.contains { $0.occurrence == nil })
        #expect(cases.contains { $0.occurrence == "absent" })
    }

    /// Reset streak is declared after the ported verbs and before Delete
    /// (`braindump` before it and `leaveProjectBlock` after it aren't
    /// ported), so it sits just ahead of Delete, here and in every list the
    /// web answers with it.
    @Test func resetStreakComesJustBeforeDelete() throws {
        let all = VerbID.allCases
        let reset = try #require(all.firstIndex(of: .resetStreak))
        #expect(all.index(after: reset) == all.firstIndex(of: .delete))
        #expect(all.firstIndex(of: .reschedule).map { all.index(after: $0) } == reset)
        let cases = try loadFixture().cases
        for c in cases {
            if let i = c.eligible.firstIndex(of: VerbID.resetStreak.rawValue) {
                #expect(Array(c.eligible[(i + 1)...]) == [VerbID.delete.rawValue], "\(c.name): just before delete")
            }
        }
        // The extension's switch decides it: the same habit both ways.
        #expect(cases.contains { $0.streaksEnabled && $0.verbs[VerbID.resetStreak.rawValue]?.eligible == true })
        #expect(cases.contains { !$0.streaksEnabled && $0.item.isHabit && ($0.item.streak ?? 0) > 0 })
    }

    /// `ITEM_VERBS` declares delete last, so every eligible list ends with it,
    /// the web's and the port's.
    @Test func deleteIsAlwaysEligibleAndLast() throws {
        #expect(VerbID.allCases.last == .delete)
        for c in try loadFixture().cases {
            let ctx = try context(c)
            #expect(c.eligible.last == VerbID.delete.rawValue, "\(c.name): the web's")
            #expect(eligibleVerbs(c.item, ctx).last == .delete, "\(c.name): the port's")
        }
    }

    /// The fixture answers for exactly the sheet's verbs.
    @Test func everyCaseAnswersForEverySheetVerb() throws {
        for c in try loadFixture().cases {
            #expect(Set(c.verbs.keys) == Set(VerbID.allCases.map(\.rawValue)), "\(c.name)")
        }
    }

    @Test func eachGateMatchesTheWeb() throws {
        for c in try loadFixture().cases {
            let ctx = try context(c)
            for verb in VerbID.allCases {
                let want = try #require(c.verbs[verb.rawValue], "\(c.name): no \(verb.rawValue)")
                #expect(verbEligible(verb, c.item, ctx) == want.eligible, "\(c.name): \(verb.rawValue) eligible")
            }
        }
    }

    @Test func eachLabelMatchesTheWeb() throws {
        for c in try loadFixture().cases {
            let ctx = try context(c)
            for verb in VerbID.allCases {
                let want = try #require(c.verbs[verb.rawValue], "\(c.name): no \(verb.rawValue)")
                #expect(verbLabel(verb, c.item, ctx) == want.label, "\(c.name): \(verb.rawValue) label")
            }
        }
    }

    @Test func theCarryLandsWhereTheWebSays() throws {
        for c in try loadFixture().cases {
            let ctx = try context(c)
            let want = try #require(c.verbs[VerbID.nextDay.rawValue], "\(c.name): no nextDay")
            #expect(nextDayOf(c.item, ctx) == want.target, "\(c.name): target")
            #expect(verbDetail(.nextDay, c.item, ctx) == want.detail, "\(c.name): detail")
        }
    }

    @Test func onlyTheCarryHasADetail() throws {
        for c in try loadFixture().cases {
            let ctx = try context(c)
            for verb in VerbID.allCases where verb != .nextDay {
                #expect(verbDetail(verb, c.item, ctx) == nil, "\(c.name): \(verb.rawValue)")
            }
        }
    }

    @Test func eligibleVerbsMatchesTheWebInOrder() throws {
        for c in try loadFixture().cases {
            let ctx = try context(c)
            let got = eligibleVerbs(c.item, ctx).map(\.rawValue)
            #expect(got == c.eligible, "\(c.name)")
        }
    }
}

/// The predicates the gates share, on hand-written items.
@Suite struct VerbPredicateTests {
    private let id = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!

    @Test func doneMeansTheDateOrTheStatus() {
        let habit = Item(id: id, type: "habit", title: "Stretch", repeatFrequency: "daily", completedDates: ["2026-10-02"])
        #expect(isDoneOn(habit, on: "2026-10-02"))
        #expect(!isDoneOn(habit, on: "2026-10-01"))
        let oneOff = Item(id: id, type: "custom", customType: "errand", title: "Stamps", status: "completed")
        #expect(isDoneOn(oneOff, on: "2026-10-02"))
        let recurring = Item(id: id, title: "Water", status: "completed", repeatFrequency: "daily")
        // A recurring item's status is never the truth.
        #expect(!isDoneOn(recurring, on: "2026-10-02"))
    }

    @Test func onlyATaskLikeItemIsCancelled() {
        #expect(isCancelled(Item(id: id, title: "T", status: "cancelled")))
        #expect(!isCancelled(Item(id: id, type: "habit", title: "H", status: "cancelled")))
        #expect(isTaskLike(Item(id: id, type: "custom", customType: "errand", title: "E")))
        #expect(!isTaskLike(Item(id: id, type: "habit", title: "H")))
    }

    /// Reset streak wants a habit with a streak above 0, and the Streaks
    /// extension on. A context that doesn't say has it on, its default.
    @Test func resetStreakAsksForAStreakWithStreaksOn() {
        let on = VerbContext(dateStr: "2026-10-02", todayStr: "2026-10-02", timeZone: "UTC")
        let off = VerbContext(dateStr: "2026-10-02", todayStr: "2026-10-02", timeZone: "UTC", streaksEnabled: false)
        #expect(on.streaksEnabled)
        let meds = Item(id: id, type: "habit", title: "Meds", repeatFrequency: "daily", streak: 41)
        #expect(verbEligible(.resetStreak, meds, on))
        #expect(!verbEligible(.resetStreak, meds, off))
        #expect(verbLabel(.resetStreak, meds, on) == "Reset streak")
        #expect(verbDetail(.resetStreak, meds, on) == nil)
        var zero = meds
        zero.streak = 0
        #expect(!verbEligible(.resetStreak, zero, on))
        var none = meds
        none.streak = nil
        #expect(!verbEligible(.resetStreak, none, on))
        // Only a habit keeps a streak the verb resets.
        #expect(!verbEligible(.resetStreak, Item(id: id, title: "T", streak: 3), on))
    }

    /// Delete asks nothing of the item: a cancelled task, a day a habit
    /// doesn't fall on and a paused item may all be deleted.
    @Test func deleteTakesAnything() {
        let ctx = VerbContext(dateStr: "2026-10-03", todayStr: "2026-10-02", timeZone: "UTC", occurrence: .absent)
        let items = [
            Item(id: id, title: "T", status: "cancelled"),
            Item(id: id, type: "habit", title: "H", repeatFrequency: "weekdays"),
            Item(id: id, title: "P", pausedAt: "2026-09-30T14:03:22.123456+00:00"),
        ]
        for item in items {
            #expect(verbEligible(VerbID.delete, item, ctx), "\(item.title)")
            #expect(verbLabel(.delete, item, ctx) == "Delete", "\(item.title)")
            #expect(verbDetail(.delete, item, ctx) == nil, "\(item.title)")
        }
    }

    @Test func aDayContextComesFromThePlannersDays() {
        let ctx = VerbContext(day: DayString("2026-10-08")!, today: DayString("2026-10-02")!, timeZone: "UTC")
        #expect(ctx.dateStr == "2026-10-08")
        #expect(ctx.todayStr == "2026-10-02")
        #expect(ctx.occurrence == nil)
        #expect(ctx.streaksEnabled)
        let off = VerbContext(
            day: DayString("2026-10-08")!, today: DayString("2026-10-02")!, timeZone: "UTC", streaksEnabled: false
        )
        #expect(!off.streaksEnabled)
    }
}
