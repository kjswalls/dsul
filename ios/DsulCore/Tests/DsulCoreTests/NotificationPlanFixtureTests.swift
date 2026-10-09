import Foundation
import Testing
import DsulCore

// The web's own plans for lib/reminders/plan.ts, checked against
// ReminderPlan.swift: for every case, the whole plan (requests in order with
// their triggers, words, threads and userInfo; withdrawals sorted; notes in
// order), plus the identifiers and lib/reminders/clock.ts `changeoverMinutes`
// (ReminderClock.swift). Over every case this also asserts what the TS side
// asserts of its own output: no more PENDING requests than the budget (60 by
// default; a catch-up is delivered at once), no duplicate identifiers, each
// from its owner's identifiers, every withdrawal one of what was delivered, no
// spring-forward gap noted twice, every body ReminderCopy.swift's own words
// inside the copy contract, and every ring on its own minute, on a day its
// item occurs and wants doing.
// tests/unit/notification-plan-fixtures.test.ts writes
// tests/fixtures/day/notification-plan.json; never edit it by hand
// (UPDATE_FIXTURES=1). SnoozeFixtureTests reads the same file's snooze cases.

// MARK: - The fixture's shapes

private struct SnoozeInput: Decodable, Sendable {
    let itemId: String
    let until: String
    let date: String
}

private struct DeliveredInput: Decodable, Sendable {
    let id: String
    let deliveredAtMs: Int
    let dateStr: String?
}

private struct EodInput: Decodable, Sendable {
    let enabled: Bool
    let time: String
    let lastReviewDate: String?
}

/// lib/reminders/plan.ts `PlanInput` as JSON: the web's optional keys, absent
/// when unset.
private struct InputFixture: Decodable, Sendable {
    let nowMs: Int
    let timezone: String
    let items: [Item]
    let routines: [Routine]?
    let seasons: [Season]?
    let timeFormat: String?
    let remindersEnabled: Bool
    let eod: EodInput?
    let snoozes: [SnoozeInput]?
    let localSentKeys: [String]?
    let delivered: [DeliveredInput]?
    let graceMinutes: Int?
    let budget: Int?
}

/// A trigger as the web writes it: one object, `type` and that type's keys.
private struct TriggerFixture: Decodable, Sendable, Equatable, CustomStringConvertible {
    var type: String
    var hour: Int?
    var minute: Int?
    var weekday: Int?
    var day: Int?
    var repeats: Bool?
    var dateStr: String?
    var hhmm: String?
    var ms: Int?

    var description: String {
        let keys: [(String, Any?)] = [
            ("hour", hour), ("minute", minute), ("weekday", weekday), ("day", day), ("repeats", repeats),
            ("dateStr", dateStr), ("hhmm", hhmm), ("ms", ms),
        ]
        return type + "(" + keys.compactMap { k, v in v.map { "\(k): \($0)" } }.joined(separator: ", ") + ")"
    }
}

private struct UserInfoFixture: Decodable, Sendable, Equatable {
    var kind: String
    var itemId: String?
    var dateStr: String?
    var at: String?
}

private struct RequestFixture: Decodable, Sendable, Equatable {
    var id: String
    var kind: String
    var itemId: String?
    var dateStr: String?
    var trigger: TriggerFixture
    var firesAt: Int
    var title: String
    var body: String
    var threadId: String
    var summaryArgument: String
    var categoryId: String
    var level: String
    var relevance: Double
    var userInfo: UserInfoFixture

    /// Exact on everything but `relevance`, a ratio, which is compared to 1e-9.
    static func == (a: RequestFixture, b: RequestFixture) -> Bool {
        return a.id == b.id && a.kind == b.kind && a.itemId == b.itemId && a.dateStr == b.dateStr
            && a.trigger == b.trigger && a.firesAt == b.firesAt && a.title == b.title && a.body == b.body
            && a.threadId == b.threadId && a.summaryArgument == b.summaryArgument && a.categoryId == b.categoryId
            && a.level == b.level && abs(a.relevance - b.relevance) < 1e-9 && a.userInfo == b.userInfo
    }
}

private struct NoteFixture: Decodable, Sendable, Equatable {
    var code: String
    var value: String?
    var itemId: String?
    var dateStr: String?
    var at: String?
    var kept: Int?
}

private struct PlanFixture: Decodable, Sendable {
    let requests: [RequestFixture]
    let withdraw: [String]
    let notes: [NoteFixture]
}

private struct PlanCase: Decodable, Sendable {
    let name: String
    let input: InputFixture
    let expected: PlanFixture
}

private struct IdentifiersCase: Decodable, Sendable {
    let name: String
    /// Null: the review's (`eodIdentifiers()`).
    let itemId: String?
    let expected: [String]
}

private struct RunFixture: Decodable, Sendable, Equatable {
    let start: Int
    let length: Int
}

private struct ChangeoverCase: Decodable, Sendable {
    let name: String
    let timeZone: String
    let fromMs: Int
    let days: Int
    let expected: [RunFixture]
}

private struct Fixture: Decodable, Sendable {
    let identifiers: [IdentifiersCase]
    let changeoverMinutes: [ChangeoverCase]
    let plans: [PlanCase]
}

/// copy.json's NEVER_SCOLDS, read here to hold every planned line to it.
private struct ContractFixture: Decodable, Sendable {
    struct Pattern: Decodable, Sendable {
        let source: String
        let flags: String
    }
    let neverScolds: Pattern
}

private enum FixtureError: Error {
    case notFound(String)
    case badInput(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func loadJSON<T: Decodable>(_ type: T.Type, _ relative: String, _ here: String = #filePath) throws -> T {
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            let data: Data = try Data(contentsOf: candidate)
            return try JSONDecoder().decode(T.self, from: data)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw FixtureError.notFound("\(relative) above \(here)")
}

private func loadFixture() throws -> Fixture {
    return try loadJSON(Fixture.self, "tests/fixtures/day/notification-plan.json")
}

private func neverScolds() throws -> NSRegularExpression {
    let p = try loadJSON(ContractFixture.self, "tests/fixtures/day/copy.json").neverScolds
    #expect(p.flags == "i")
    return try NSRegularExpression(pattern: p.source, options: [.caseInsensitive])
}

private func scolds(_ regex: NSRegularExpression, _ line: String) -> Bool {
    return regex.firstMatch(in: line, options: [], range: NSRange(line.startIndex..<line.endIndex, in: line)) != nil
}

// MARK: - Between the two shapes

private func wire(_ id: UUID?) -> String? {
    return id?.uuidString.lowercased()
}

private func planInput(_ f: InputFixture, _ name: String) throws -> PlanInput {
    let format: TimeFormat
    if let raw = f.timeFormat {
        guard let parsed = TimeFormat(rawValue: raw) else { throw FixtureError.badInput("\(name): timeFormat \(raw)") }
        format = parsed
    } else {
        format = .twelveHour
    }
    let snoozes = try (f.snoozes ?? []).map { s -> PlanSnooze in
        guard let id = UUID(uuidString: s.itemId) else { throw FixtureError.badInput("\(name): snooze id \(s.itemId)") }
        return PlanSnooze(itemId: id, until: s.until, date: s.date)
    }
    return PlanInput(
        nowMs: f.nowMs,
        timeZone: f.timezone,
        items: f.items,
        routines: f.routines ?? [],
        seasons: f.seasons ?? [],
        timeFormat: format,
        remindersEnabled: f.remindersEnabled,
        eod: f.eod.map { PlanEod(enabled: $0.enabled, time: $0.time, lastReviewDate: $0.lastReviewDate) },
        snoozes: snoozes,
        localSentKeys: Set(f.localSentKeys ?? []),
        delivered: (f.delivered ?? []).map { PlanDelivered(id: $0.id, deliveredAtMs: $0.deliveredAtMs, dateStr: $0.dateStr) },
        graceMinutes: f.graceMinutes ?? reminderGraceMinutes,
        budget: f.budget ?? notificationBudget
    )
}

private func fixture(_ t: PlannedTrigger) -> TriggerFixture {
    var out = TriggerFixture(type: t.type)
    switch t {
    case let .calendar(hour, minute, weekday, day):
        out.hour = hour
        out.minute = minute
        out.weekday = weekday
        out.day = day
        out.repeats = true
    case let .at(dateStr, hhmm):
        out.dateStr = dateStr
        out.hhmm = hhmm
    case let .afterMs(ms):
        out.ms = ms
    case .now:
        break
    }
    return out
}

private func fixture(_ r: PlannedRequest) -> RequestFixture {
    return RequestFixture(
        id: r.id, kind: r.kind.rawValue, itemId: wire(r.itemId), dateStr: r.dateStr, trigger: fixture(r.trigger),
        firesAt: r.firesAt, title: r.title, body: r.body, threadId: r.threadId, summaryArgument: r.summaryArgument,
        categoryId: r.categoryId, level: r.level.rawValue, relevance: r.relevance,
        userInfo: UserInfoFixture(
            kind: r.userInfo.kind.rawValue, itemId: wire(r.userInfo.itemId), dateStr: r.userInfo.dateStr,
            at: r.userInfo.at
        )
    )
}

private func fixture(_ n: PlanNote) -> NoteFixture {
    var out = NoteFixture(code: n.code)
    switch n {
    case let .badZone(value):
        out.value = value
    case let .badTime(itemId, value):
        out.itemId = wire(itemId)
        out.value = value
    case let .dstGap(itemId, dateStr, at):
        out.itemId = wire(itemId)
        out.dateStr = dateStr
        out.at = at
    case let .overBudget(itemId, kept):
        out.itemId = wire(itemId)
        out.kept = kept
    }
    return out
}

// MARK: - Tests

@Suite struct NotificationPlanFixtureTests {
    @Test func identifiersMatchTheWeb() throws {
        let cases = try loadFixture().identifiers
        #expect(!cases.isEmpty)
        for c in cases {
            if let raw = c.itemId {
                let id = try #require(UUID(uuidString: raw), "\(c.name)")
                #expect(identifiers(for: id) == c.expected, "\(c.name)")
                #expect(itemIdentifier(id) == c.expected.first, "\(c.name)")
            } else {
                #expect(eodIdentifiers() == c.expected, "\(c.name)")
                #expect(eodIdentifier == c.expected.first, "\(c.name)")
            }
        }
    }

    @Test func changeoverMinutesMatchTheWeb() throws {
        let cases = try loadFixture().changeoverMinutes
        #expect(cases.contains { $0.expected.isEmpty })
        #expect(cases.contains { !$0.expected.isEmpty })
        for c in cases {
            let got = try #require(changeoverMinutes(timeZone: c.timeZone, fromMs: c.fromMs, days: c.days), "\(c.name)")
            #expect(got.map { RunFixture(start: $0.start, length: $0.length) } == c.expected, "\(c.name)")
        }
        #expect(changeoverMinutes(timeZone: "Not/AZone", fromMs: 0, days: 1) == nil)
        // A run that wraps past midnight holds the minutes on both sides of it.
        let wrap = MinuteRun(start: 1410, length: 60)
        #expect(inMinuteRun(1439, wrap) && inMinuteRun(0, wrap) && inMinuteRun(29, wrap))
        #expect(!inMinuteRun(30, wrap) && !inMinuteRun(1409, wrap))
    }

    @Test func everyPlanMatchesTheWeb() throws {
        let cases = try loadFixture().plans
        #expect(cases.count > 0)
        for c in cases {
            let plan = planNotifications(try planInput(c.input, c.name))
            let got = plan.requests.map(fixture)
            #expect(got.count == c.expected.requests.count, "\(c.name): request count")
            for (i, pair) in zip(got, c.expected.requests).enumerated() {
                #expect(pair.0 == pair.1, "\(c.name): request \(i) (\(pair.1.id))")
            }
            #expect(plan.withdraw == c.expected.withdraw, "\(c.name): withdraw")
            #expect(plan.notes.map(fixture) == c.expected.notes, "\(c.name): notes")
        }
    }

    /// What the TS side asserts of its own plans, asserted of the Swift ones:
    /// the budget holds for what sits pending, each identifier is used once
    /// and belongs to the request's owner, every withdrawal was delivered, and
    /// no spring-forward gap is noted twice.
    @Test func everyPlanHoldsTheInvariants() throws {
        for c in try loadFixture().plans {
            let input = try planInput(c.input, c.name)
            let plan = planNotifications(input)
            let ids = plan.requests.map(\.id)
            let pending = plan.requests.filter { $0.trigger != .now }
            #expect(pending.count <= input.budget, "\(c.name)")
            #expect(Set(ids).count == ids.count, "\(c.name): duplicate identifiers")
            let delivered = Set(input.delivered.map(\.id))
            for id in plan.withdraw { #expect(delivered.contains(id), "\(c.name): \(id)") }
            let gaps = plan.notes.filter { $0.code == "dst-gap" }
            #expect(Set(gaps).count == gaps.count, "\(c.name): a gap noted twice")
            for r in plan.requests {
                let owned = r.itemId.map { identifiers(for: $0) } ?? eodIdentifiers()
                #expect(owned.contains(r.id), "\(c.name): \(r.id)")
                #expect(r.summaryArgument == r.title, "\(c.name): \(r.id)")
                #expect(r.userInfo.kind == r.kind && r.userInfo.itemId == r.itemId && r.userInfo.dateStr == r.dateStr,
                        "\(c.name): \(r.id)")
                #expect((0...1).contains(r.relevance), "\(c.name): \(r.id)")
            }
            #expect(plan.withdraw == plan.withdraw.sorted() && Set(plan.withdraw).count == plan.withdraw.count, "\(c.name)")
            let order = plan.requests.map { ($0.firesAt, $0.id) }
            #expect(zip(order, order.dropFirst()).allSatisfy { $0 < $1 }, "\(c.name): order")
        }
    }

    /// Every body the web planned is `reminderCopy`'s, as the Swift port words
    /// it (or the review's), and keeps the contract.
    @Test func everyBodyIsReminderCopys() throws {
        let regex = try neverScolds()
        for c in try loadFixture().plans {
            let input = try planInput(c.input, c.name)
            for r in c.expected.requests {
                let words: NotificationText
                if r.kind == PlannedKind.eod.rawValue {
                    words = eodCopy
                } else {
                    let item = try #require(input.items.first { wire($0.id) == r.itemId }, "\(c.name): \(r.id)")
                    let anchor = item.reminderAnchor.flatMap { $0.isEmpty ? nil : $0 }
                    words = reminderCopy(
                        ReminderCandidate(
                            item: item, at: item.reminderTime ?? "", anchor: anchor,
                            snoozed: r.kind == PlannedKind.snoozed.rawValue
                        ),
                        timeFormat: input.timeFormat
                    )
                }
                #expect(r.title == words.title, "\(c.name): \(r.id)")
                #expect(r.body == words.body, "\(c.name): \(r.id)")
                for line in [r.title, r.body] { #expect(!scolds(regex, line), "\(c.name): \(line)") }
            }
        }
    }

    /// The fixture reaches every rule §5.3 names, so a Swift port that passes
    /// it has met each one.
    @Test func theCasesReachEveryRule() throws {
        let plans = try loadFixture().plans
        let requests = plans.flatMap(\.expected.requests)
        #expect(Set(requests.map(\.kind)) == Set(PlannedKind.allCases.map(\.rawValue)))
        #expect(Set(requests.map(\.trigger.type)) == ["calendar", "at", "afterMs", "now"])
        #expect(Set(plans.flatMap(\.expected.notes).map(\.code)) == ["bad-zone", "bad-time", "dst-gap", "over-budget"])
        #expect(plans.contains { !$0.expected.withdraw.isEmpty })
        #expect(requests.contains { $0.trigger.type == "calendar" && $0.trigger.weekday != nil })
        #expect(requests.contains { $0.trigger.type == "calendar" && $0.trigger.day != nil })
        #expect(requests.contains { $0.id.hasSuffix("#next") })
        #expect(requests.contains { $0.id.hasSuffix("#snooze") })
        #expect(requests.contains { $0.id.hasSuffix("#now") })
    }

    /// §5.3's named rows, and the rules the redesign added, by name, as the
    /// TS side names them ("the cases reach every rule").
    @Test func theNamedRows() throws {
        let plans = try loadFixture().plans
        func plan(_ name: String) throws -> NotificationPlan {
            let c = try #require(plans.first { $0.name == name }, "\(name)")
            return planNotifications(try planInput(c.input, c.name))
        }
        func types(_ name: String) throws -> [String] {
            return try plan(name).requests.map(\.trigger.type)
        }
        /// The fixture's item n, as notification-plan-fixtures.test.ts `uid` writes it.
        func uid(_ n: Int) throws -> UUID {
            let hex = String(n, radix: 16)
            let raw = "00000000-0000-4000-8000-" + String(repeating: "0", count: 12 - hex.count) + hex
            return try #require(UUID(uuidString: raw), "\(raw)")
        }
        let vitamins = try uid(1001)

        // The budget case is the default budget, full.
        let full = try plan("61 daily habits: 60 and a note")
        #expect(full.requests.count == notificationBudget)
        #expect(full.notes == [.overBudget(itemId: try uid(1160), kept: 0)])

        let spring = try plan("Los Angeles 2026-03-08 02:30: absent, with a note")
        #expect(!spring.requests.contains { $0.dateStr == "2026-03-08" })
        #expect(spring.notes.contains { $0.code == "dst-gap" })
        let fall = try plan("Los Angeles 2026-11-01 01:30: exactly one instant")
        #expect(fall.requests.filter { $0.dateStr == "2026-11-01" }.count == 1)

        // The snooze day gate on a snooze the payload carries, both ways.
        #expect(try plan("a snooze maturing past midnight: nothing").requests.map(\.kind) == [.cue])
        #expect(try plan("a snooze ringing at 23:59: armed").requests.map(\.kind).contains(.snoozed))

        // A grace other than the default, closing the window and keeping it open.
        #expect(!(try plan("a ten-minute grace, closed at 07:45: no catch-up").requests.map(\.kind).contains(.catchUp)))
        #expect(try plan("an hour's grace, still open at 08:15: rings now").requests.map(\.kind).contains(.catchUp))

        // A changeover at midnight is a changeover: Santiago's 00:30 is
        // one-offs, and the night it skips is noted once.
        let midnight = try plan("Santiago, a 00:30 cue on its midnight changeover: one-offs, and a note")
        #expect(midnight.notes == [.dstGap(itemId: vitamins, dateStr: "2026-09-06", at: "00:30")])
        #expect(midnight.requests.map(\.trigger.type) == ["at", "at"])
        #expect(try plan("Santiago, a review at 0:30 on the same changeover: one-offs, and a note").notes
            == [.dstGap(itemId: nil, dateStr: "2026-09-06", at: "00:30")])
        #expect(try plan("Santiago, done before a 00:30 cue the night before its changeover: one note").notes
            == [.dstGap(itemId: vitamins, dateStr: "2026-09-06", at: "00:30")])
        for name in ["Santiago, its changeover earlier today: no note", "Los Angeles, its spring-forward earlier today: no note"] {
            #expect(try plan(name).notes.isEmpty, "\(name)")
        }

        // The changeover's edges in New York, and zones that never change.
        #expect(try types("00:59 is standing: New York's changeover starts at 01:00") == ["calendar"])
        #expect(try types("03:00 is standing: past New York's changeover") == ["calendar"])
        #expect(try types("a cue in New York's changeover minutes: one-offs") == ["at", "at"])
        #expect(try types("Kolkata never changes its clocks: a small-hours cue stands") == ["calendar"])
        #expect(try types("UTC never changes: a small-hours review stands") == ["calendar"])

        // A next wanted cue past the first two months.
        let awayCase = try #require(plans.first { $0.name == "paused until January: the next wanted cue is looked for a year ahead" })
        let away = planNotifications(try planInput(awayCase.input, awayCase.name))
        let firstAway = try #require(away.requests.first)
        #expect(firstAway.firesAt - awayCase.input.nowMs > 60 * 86_400_000)

        // The relevance clamp: a streak past relevanceFullStreak still scores 1.
        #expect(try plan("a streak past a month: relevance stops at 1").requests.map(\.relevance) == [1])

        // A held lone day of the month is the one-off series, never a repeat.
        #expect(try types("monthly on the 15th, done today: the one-off series") == ["at", "at"])
        // The 31st held by its ring after a short month, and a clamped day alone.
        #expect(try types("monthly on the 31st, its season ending before December's: October's alone") == ["at"])
        #expect(try types("monthly on the 31st, its season ending after January's: standing, November's clamped day beside it")
            == ["calendar", "at"])
        #expect(try plan("monthly on the 31st, its season ending in March: February's clamped 28th alone").requests.map(\.dateStr)
            == ["2027-02-28"])

        // A season's end: nothing standing that would ring past it.
        #expect(try types("a season ending Thursday: one-offs up to Thursday, nothing after") == ["at", "at", "at", "at"])
        #expect(try types("a season ending more than a month past the next ring: still standing") == ["calendar"])

        // A catch-up is never charged: thirty of them beside sixty pending.
        let caught = try plan("a catch-up for thirty and twenty-nine Wednesday habits: every item still armed")
        #expect(caught.requests.filter { $0.trigger == .now }.count == 30)
        #expect(caught.requests.filter { $0.trigger != .now }.count == notificationBudget)
        #expect(caught.notes.isEmpty)

        // A held review under a full budget still stands.
        #expect(try plan("a held review in exactly seven places: all seven, no note").requests.count == 7)

        // The shade: a day ticked elsewhere after its cue rang is withdrawn.
        let base = itemIdentifier(vitamins)
        #expect(try plan("done elsewhere after it rang yesterday: withdrawn").withdraw == [base])
        #expect(try plan("Monday still open when Wednesday is ticked: only Wednesday's withdrawn").withdraw == ["\(base)#4"])
        #expect(try plan("review answered after midnight: the night it answered withdrawn").withdraw == [eodIdentifier])
    }

    /// Every request rings on its item's cue minute (or the review's hour), on
    /// a day the item occurs: what a drifting repeating interval broke. A
    /// calendar trigger rings at its own hour and minute on its own days, so
    /// holding its first ring and its components here holds every ring. And
    /// every ring in the month after it (`lapseDays`), and the one after it
    /// however far off, wants doing: what a calendar trigger left standing past
    /// a season's end, a skip or a tick ahead broke.
    @Test func everyRequestRingsOnItsOwnMinute() throws {
        for c in try loadFixture().plans {
            let input = try planInput(c.input, c.name)
            for r in planNotifications(input).requests {
                let hhmm: String
                switch r.trigger {
                case .afterMs, .now:
                    continue
                case let .at(_, at):
                    hhmm = at
                case let .calendar(hour, minute, _, _):
                    hhmm = String(format: "%02d:%02d", hour, minute)
                }
                let place = "\(c.name): \(r.id)"
                let item = input.items.first { $0.id == r.itemId }
                let want: String?
                if r.kind == .eod {
                    let time = try #require(input.eod?.time, "\(place)")
                    want = String(repeating: "0", count: max(0, 5 - time.count)) + time
                } else {
                    want = item?.reminderTime
                }
                #expect(hhmm == want, "\(place)")
                let clock = try #require(localClock(nowMs: r.firesAt, timeZone: input.timeZone), "\(place)")
                let parts = hhmm.split(separator: ":").compactMap { Int($0) }
                #expect(parts.count == 2 && clock.nowMinutes == parts[0] * 60 + parts[1], "\(place)")
                if case let .at(dateStr, _) = r.trigger { #expect(dateStr == clock.dateStr, "\(place)") }
                if case let .calendar(_, _, weekday?, _) = r.trigger {
                    #expect(weekdayOf(clock.dateStr).map { $0 + 1 } == weekday, "\(place)")
                }
                if case let .calendar(_, _, _, day?) = r.trigger {
                    #expect(Int(clock.dateStr.suffix(2)) == day, "\(place)")
                }
                if let item {
                    #expect(occursOn(item, on: clock.dateStr, timeZone: input.timeZone), "\(place) on \(clock.dateStr)")
                }
                if r.kind == .eod { #expect(clock.dateStr != input.eod?.lastReviewDate, "\(place)") }

                // Its rings in the month after its first, and the one after its
                // first however far (the 31st's, two months on past a short one).
                let ctx = ActivationContext(timeZone: input.timeZone, routines: input.routines, seasons: input.seasons)
                let first = try #require(DayString(clock.dateStr), "\(place)")
                let monthOn = first.adding(days: 31)
                var days: [DayString] = [first]
                if case let .calendar(_, _, weekday, day) = r.trigger {
                    days = (0..<63).map { first.adding(days: $0) }
                        .filter { d in
                            (weekday == nil || d.weekday + 1 == weekday) && (day == nil || d.day == day)
                        }
                        .enumerated()
                        .filter { i, d in i < 2 || d <= monthOn }
                        .map(\.element)
                }
                for d in days {
                    if let item {
                        #expect(wantsDoingOn(item, on: d, ctx), "\(place) rings on \(d)")
                    } else {
                        #expect(d.description != input.eod?.lastReviewDate, "\(place) rings on \(d)")
                    }
                }
            }
        }
    }

    @Test func userInfoTravelsAsStrings() {
        let id = UUID(uuidString: "00000000-0000-4000-8000-0000000003E9")!
        let info = PlannedUserInfo(kind: .snoozed, itemId: id, dateStr: "2026-10-05", at: "07:30")
        #expect(info.dictionary == [
            "kind": "snoozed", "itemId": "00000000-0000-4000-8000-0000000003e9", "dateStr": "2026-10-05", "at": "07:30",
        ])
        #expect(PlannedUserInfo(kind: .eod).dictionary == ["kind": "eod"])
    }
}
