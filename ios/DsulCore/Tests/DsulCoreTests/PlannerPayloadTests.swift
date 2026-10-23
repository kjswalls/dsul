import Foundation
import Testing
import DsulCore

// GET /api/app/planner, decoded the way the phone decodes it. The response
// itself is pinned by tests/fixtures/app/planner-response.json, which
// tests/unit/app-planner.test.ts writes from mocked rows through the real route
// (UPDATE_FIXTURES=1); this file reads the same JSON, so a change to the route's
// shape that the phone can't read turns CI red. The rest of the file pins the
// lenient decoding on hand-written payloads.

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func fixtureData(_ here: String = #filePath) throws -> Data {
    let relative = "tests/fixtures/app/planner-response.json"
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            return try Data(contentsOf: candidate)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw FixtureError.notFound("\(relative) above \(here)")
}

private func decode(_ json: String) throws -> PlannerPayload {
    return try JSONDecoder().decode(PlannerPayload.self, from: Data(json.utf8))
}

private let user = "6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b"

/// A payload around the given JSON for each array.
private func payload(items: String, routines: String = "[]", seasons: String = "[]") -> String {
    return """
    {"v":1,"userId":"\(user)","fetchedAt":"2026-10-02T15:04:05.000Z",
     "settings":{"timezone":"America/Los_Angeles","showCompletedTasks":true},
     "items":[\(items)],"projects":[],"routines":\(routines),"seasons":\(seasons)}
    """
}

/// Any JSON value, kept as nothing; for counting the raw rows.
private struct AnyJSON: Decodable, Sendable {
    init(from decoder: Decoder) throws {}
}

private struct RawItems: Decodable, Sendable {
    let items: [AnyJSON]
}

@Suite struct PlannerPayloadFixtureTests {
    @Test func theRouteResponseDecodesWithNothingDropped() throws {
        let data = try fixtureData()
        let p = try JSONDecoder().decode(PlannerPayload.self, from: data)
        let raw = try JSONDecoder().decode(RawItems.self, from: data)
        #expect(p.v == 1)
        #expect(p.settings.appIcon == .lime)
        #expect(p.settings.weekStartDay == .monday)
        #expect(p.settings.timeFormat == .twentyFourHour)
        #expect(p.writes == [
            "complete", "schedule", "skip", "move", "pause", "title", "notes", "delete", "addSubtask", "resetStreak",
            "priority", "timesPerDay", "reminder", "time", "repeat", "project", "collect", "snooze",
        ])
        // The route's test turns Streaks off, a value no default gives.
        #expect(p.settings.streaksEnabled == false)
        // ... and Habit reminders on, a value no default gives either (a
        // missing row is false, a database behind on its migrations null).
        #expect(p.settings.remindersEnabled == true)
        // The last call and the review, on at hours no default gives.
        #expect(p.settings.lastCallEnabled == true)
        #expect(p.settings.lastCallTime == "20:45")
        #expect(p.settings.eodReviewEnabled == true)
        #expect(p.settings.eodReviewTime == "21:30")
        #expect(p.settings.lastEodReviewDate == "2026-10-01")
        #expect(p.settings.reminderGraceMinutes == reminderGraceMinutes)
        #expect(p.settings.planEod == PlanEod(enabled: true, time: "21:30", lastReviewDate: "2026-10-01"))
        // The one live snooze with a day, its instant as Postgres wrote it,
        // and the item it names in the payload.
        let snoozes = try #require(p.snoozes)
        #expect(snoozes.count == 1)
        let snooze = try #require(snoozes.first)
        #expect(snooze.date == "2026-10-02")
        #expect(parseTimestamp(snooze.until) != nil)
        #expect(p.items.contains { $0.id == snooze.itemId })
        #expect(p.droppedItems == 0)
        #expect(p.items.count == raw.items.count)
        #expect(!p.items.isEmpty)
        #expect(!p.fetchedAt.isEmpty)
        // The trips, newest first: an open-ended one from December, its jsonb
        // null on the server and empty here, and a week away with a keep list
        // and an easing wave.
        let trips = try #require(p.awayPeriods)
        #expect(trips.count == 2)
        let openEnded = try #require(trips.first)
        #expect(openEnded.startsOn == "2026-12-20")
        #expect(openEnded.endsOn == nil)
        #expect(openEnded.keep == AwayKeep())
        #expect(openEnded.returns.isEmpty)
        let week = try #require(trips.last)
        #expect(week.startsOn == "2026-10-10")
        #expect(week.endsOn == "2026-10-17")
        #expect(week.keep.itemIds.count == 1 && week.keep.routineIds.count == 1 && week.keep.projectIds.count == 1)
        #expect(week.keep.itemIds.allSatisfy { id in p.items.contains { $0.id == id } })
        #expect(week.returns.count == 1)
        #expect(week.returns.values.first == "2026-10-19")
        #expect(p.trips == trips)
    }

    /// The cases the route's fixture is built to cover (lib/app-api.ts).
    @Test func everyCoveredShapeReadsAsTheWebReadsIt() throws {
        let p = try JSONDecoder().decode(PlannerPayload.self, from: try fixtureData())

        // A counted habit.
        #expect(p.items.contains { $0.isHabit && ($0.timesPerDay ?? 0) > 1 && !$0.dailyCounts.isEmpty })
        // A recurring task and a one-off task.
        #expect(p.items.contains { !$0.isHabit && ($0.repeatFrequency ?? "none") != "none" })
        #expect(p.items.contains { !$0.isHabit && ($0.repeatFrequency ?? "none") == "none" && $0.startDate != nil })
        // A custom type answers with its slug.
        let custom = try #require(p.items.first { $0.type == "custom" })
        #expect(custom.customType != nil)
        #expect(custom.typeName == custom.customType)
        #expect(!custom.isHabit)
        // ... and its type is named by the user's own label.
        let types = try #require(p.itemTypes)
        let named = try #require(types.first { $0.name == custom.typeName }, "no itemTypes entry for the custom item")
        #expect(!named.label.isEmpty && !named.labelPlural.isEmpty)
        let labels = Dictionary(types.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        #expect(typeLabel(custom.typeName, labels: labels) == named.label)
        // A subtask is kept in items but never reaches Today.
        let subtask = try #require(p.items.first { $0.parentItemId != nil })
        let split = project(p.items)
        #expect(!split.tasks.contains { $0.id == subtask.id })
        #expect(split.tasks.contains { $0.type == "custom" })
        // A project block.
        #expect(p.projects.contains { $0.startTime != nil && $0.repeatFrequency != nil })
        // A pause stamped by Postgres, microseconds and offset, parses.
        let paused = try #require(p.items.first { $0.pausedAt != nil })
        #expect(parseTimestamp(paused.pausedAt ?? "") != nil)
        // A routine inside a season.
        #expect(p.routines.contains { r in p.seasons.contains { $0.routineIds.contains(r.id) } })
        // A subtask names its parent by the parent's lowercase id.
        #expect(p.items.contains { $0.id.uuidString.lowercased() == subtask.parentItemId })
        // A bucket the enum doesn't name stays text, and Today leaves it out.
        let noon = try #require(p.items.first { $0.timeBucket == "noon" })
        if let start = noon.startDate, let date = DayString(start) {
            let day = deriveDayItems(
                tasks: split.tasks, habits: split.habits, projects: p.projects, date: date,
                timeZone: p.settings.timezone ?? "UTC", showCompletedTasks: p.settings.showCompletedTasks, inactive: []
            )
            #expect(!flattenDayRows(day).contains { $0.id == noon.id })
        }
    }

    /// The item sheet's fields, on the rows the route's test gives them.
    @Test func theSheetsFieldsReadAsTheWebWroteThem() throws {
        let p = try JSONDecoder().decode(PlannerPayload.self, from: try fixtureData())
        func row(_ title: String) throws -> Item {
            return try #require(p.items.first { $0.title == title }, "no \(title)")
        }

        let plants = try row("Water the plants")
        #expect(plants.priority == "low")
        #expect(plants.notes == nil)

        let bank = try row("Call the bank")
        #expect(bank.priority == "high")
        #expect(bank.notes == "Ask about the wire fee.\nHave the card ready.")
        #expect(bank.reminderTime == "14:15")
        #expect(bank.reminderAnchor == nil)

        let meditate = try row("Meditate")
        #expect(meditate.notes == "Ten minutes, eyes closed.")
        #expect(meditate.reminderTime == "06:30")
        #expect(meditate.reminderAnchor == "I pour my coffee")
        #expect(meditate.priority == nil)

        let water = try row("Drink water")
        #expect(water.currentDayCount == 3)
        #expect(water.reminderTime == nil)

        // The project chip's fields: the id beside the name, a parked task's
        // stash, and the projects' own colour and emoji (decoded, drawn
        // nowhere yet).
        let admin = "22222222-2222-4222-8222-000000000001"
        let inbox = try row("Inbox zero")
        #expect(inbox.projectId == admin)
        #expect(inbox.inProjectBlock == true)
        #expect(inbox.previousStartTime == "16:00")
        #expect(inbox.previousStartDate == "2026-10-01")
        #expect(bank.projectId == admin)
        // An unfiled habit reads "" (itemFromRow), with no id.
        #expect(meditate.project == "")
        #expect(meditate.projectId == nil)
        // A text-only name: no project row behind it.
        let stretch = try row("Stretch")
        #expect(stretch.project == "Fitness")
        #expect(stretch.projectId == nil)
        let adminProject = try #require(p.projects.first { $0.id == admin }, "no Admin")
        #expect(adminProject.name == "Admin")
        #expect(adminProject.color == "blue")
        #expect(adminProject.emoji == "\u{1F4CB}")
        let health = try #require(p.projects.first { $0.name == "Health" }, "no Health")
        #expect(health.color == nil)
    }

    @Test func theWholePipelineRunsOverTheResponse() throws {
        let p = try JSONDecoder().decode(PlannerPayload.self, from: try fixtureData())
        let zone = p.settings.timezone ?? "UTC"
        let today = try #require(DayString(String(p.fetchedAt.prefix(10))))
        let inactive = inactiveItemIdsOn(
            items: p.items, date: today, timeZone: zone, routines: p.routines, seasons: p.seasons, away: p.trips
        )
        // Neither trip has begun on the fixture's day, so they hide nothing yet.
        #expect(inactive == inactiveItemIdsOn(items: p.items, date: today, timeZone: zone, routines: p.routines, seasons: p.seasons))
        let split = project(p.items)
        let day = deriveDayItems(
            tasks: split.tasks, habits: split.habits, projects: p.projects, date: today,
            timeZone: zone, showCompletedTasks: p.settings.showCompletedTasks, inactive: inactive
        )
        _ = deriveTimedEntries(day)
        _ = braindumpMembers(tasks: split.tasks, habits: split.habits, suppressed: inactive)
        _ = routineGroups(flattenDayRows(day), routines: p.routines)
        #expect(day.totalCount <= p.items.count)
    }

    /// Organize's fields (O1): the two extension flags, the containers' own
    /// glyph, colour, usual time, order and notes, and the goals, on the rows
    /// the route's test gives them.
    @Test func theOrganizeFieldsReadAsTheWebWroteThem() throws {
        let data = try fixtureData()
        let p = try JSONDecoder().decode(PlannerPayload.self, from: data)
        // Organize unset (the manifest default, on) and Goals switched on,
        // which no default gives.
        #expect(p.settings.organizeEnabled)
        #expect(p.settings.goalsEnabled)

        let morning = try #require(p.routines.first { $0.name == "Morning routine" })
        #expect(morning.icon == "icon:Sunrise")
        #expect(morning.color == "var(--accent-8)")
        #expect(morning.usualTime == "06:30")
        #expect(morning.notes == "Before the phone.")
        #expect(morning.sortOrder == 0)
        // A routine with none of them reads each as absent.
        let wind = try #require(p.routines.first { $0.name == "Wind-down" })
        #expect(wind.icon == nil && wind.color == nil && wind.usualTime == nil && wind.notes == nil)
        #expect(wind.sortOrder == 1)

        let autumn = try #require(p.seasons.first { $0.name == "Autumn" })
        #expect(autumn.icon == "icon:Leaf")
        #expect(autumn.color == "var(--accent-6)")
        #expect(autumn.sortOrder == 0)
        #expect(autumn.notes == "Until the clocks change.")
        let stamped = try #require(autumn.updatedAt)
        #expect(parseTimestamp(stamped) != nil)

        // Two goals, nothing dropped, in the route's order.
        struct RawGoals: Decodable { let goals: [AnyJSON] }
        let raw = try JSONDecoder().decode(RawGoals.self, from: data)
        let goals = try #require(p.goals)
        #expect(goals.count == raw.goals.count)
        #expect(goals.map(\.name) == ["Speak Spanish by spring", "Cook five dishes"])
        let spanish = goals[0]
        #expect(spanish.why == "For the trip to Madrid in April.")
        #expect(spanish.icon == "icon:Globe")
        #expect(spanish.color == nil)
        #expect(spanish.state == "active")
        #expect(spanish.startsOn == "2026-08-01")
        #expect(spanish.targetOn == "2027-04-01")
        #expect(spanish.sortOrder == 0)
        #expect(spanish.achievedAt == nil)
        #expect(spanish.memberIds.count == 1 && spanish.milestoneIds.count == 2 && spanish.checkinIds.count == 1)
        // Every member is an item the payload carries.
        for id in spanish.memberIds + spanish.milestoneIds + spanish.checkinIds {
            #expect(p.items.contains { $0.id == id }, "\(id)")
        }
        // One milestone reached (a completed task), one ahead (a custom type):
        // the list's subtitle reads 1/2.
        let progress = goalProgress(spanish, items: p.items)
        #expect(progress == GoalProgress(achieved: 1, total: 2, fraction: 0.5))
        #expect(progressLabel(spanish, progress) == "1/2")
        let cooked = goals[1]
        #expect(cooked.state == "achieved")
        #expect(!isGoalActive(cooked))
        #expect(parseTimestamp(cooked.achievedAt ?? "") != nil)
        #expect(cooked.color == "var(--accent-5)")
        #expect(cooked.sortOrder == 1)
        #expect(cooked.memberIds.isEmpty && cooked.milestoneIds.isEmpty && cooked.checkinIds.isEmpty)
        #expect(progressLabel(cooked, goalProgress(cooked, items: p.items)) == "No milestones yet")
        #expect(sortGoalsForDisplay(goals).map(\.id) == goals.map(\.id))
    }
}

@Suite struct LenientDecodingTests {
    private let a = #"{"type":"task","id":"00000000-0000-4000-8000-000000000001","title":"A","status":"pending"}"#

    @Test func aBadRowIsDroppedAndCounted() throws {
        let p = try decode(payload(items: [
            a,
            #"{"type":"task","id":"not-a-uuid","title":"B"}"#,
            #"null"#,
            #"{"type":"task","title":"no id"}"#,
            #"42"#,
            #"{"id":"00000000-0000-4000-8000-000000000004","title":"no type"}"#,
            #"{"type":"task","id":"00000000-0000-4000-8000-000000000005"}"#,
            #"{"type":"habit","id":"00000000-0000-4000-8000-000000000006","title":"Z"}"#,
        ].joined(separator: ",")))
        // A bad row in the middle never takes the rows after it down with it.
        #expect(p.items.map(\.title) == ["A", "Z"])
        #expect(p.droppedItems == 6)
    }

    @Test func numbersMayArriveAsDoubles() throws {
        let p = try decode(payload(items: #"""
        {"type":"habit","id":"00000000-0000-4000-8000-000000000001","title":"H","duration":30.7,"order":2.0,
         "streak":4,"timesPerDay":3.0,"repeatDays":[1,2.9,"x",3],"dailyCounts":{"2026-10-02":2.0,"2026-10-01":"x","2026-09-30":1}}
        """#))
        let h = try #require(p.items.first)
        #expect(h.duration == 30)
        #expect(h.order == 2)
        #expect(h.streak == 4)
        #expect(h.timesPerDay == 3)
        #expect(h.repeatDays == [1, 2, 3])
        #expect(h.dailyCounts == ["2026-10-02": 2, "2026-09-30": 1])
    }

    @Test func nullsAndWrongTypesDegradeToEmpty() throws {
        let p = try decode(payload(items: #"""
        {"type":"task","id":"00000000-0000-4000-8000-000000000001","title":"T","status":null,
         "completedDates":null,"skippedDates":["2026-10-02",7],"dailyCounts":null,"duration":"30",
         "isScheduled":"yes","timeBucket":"noon","repeatDays":null,"unknownField":{"a":1}}
        """#, routines: "null"))
        let t = try #require(p.items.first)
        #expect(t.status == nil)
        #expect(t.completedDates.isEmpty)
        #expect(t.skippedDates == ["2026-10-02"])
        #expect(t.dailyCounts.isEmpty)
        #expect(t.duration == nil)
        #expect(t.isScheduled == nil)
        #expect(t.timeBucket == "noon")
        #expect(t.repeatDays == nil)
        #expect(p.routines.isEmpty)
    }

    @Test func nullContainersAreEmpty() throws {
        let json = """
        {"v":1,"userId":"\(user)","fetchedAt":"x","settings":{"timezone":null},
         "items":null,"projects":null,"routines":null,"seasons":null}
        """
        let p = try decode(json)
        #expect(p.items.isEmpty && p.projects.isEmpty && p.routines.isEmpty && p.seasons.isEmpty)
        #expect(p.droppedItems == 0)
        #expect(p.settings.timezone == nil)
        #expect(p.settings.showCompletedTasks)
        // A server older than the field: the pick is unknown, not Aurora.
        #expect(p.settings.appIcon == nil)
        // ... the week starts on Sunday, the clock is 12h, and it takes the
        // two writes it always took.
        #expect(p.settings.weekStartDay == .sunday)
        #expect(p.settings.timeFormat == .twelveHour)
        #expect(p.writes == nil)
        #expect(p.itemTypes == nil)
        // ... and Streaks is on, the extension's default, and whether
        // Habit reminders are on is unknown.
        #expect(p.settings.streaksEnabled)
        #expect(p.settings.remindersEnabled == nil)
        // ... and the rituals and the snoozes are unknown too.
        #expect(p.settings.lastCallEnabled == nil)
        #expect(p.settings.eodReviewEnabled == nil)
        #expect(p.settings.planEod == nil)
        #expect(p.settings.reminderGraceMinutes == nil)
        #expect(p.snoozes == nil)
        // ... and a server older than vacation mode sends no trips: none.
        #expect(p.awayPeriods == nil)
        #expect(p.trips.isEmpty)
        // ... and one older than Organize sends no goals (unknown, which
        // hides Goals) and no flags: Organize on, Goals off, the defaults.
        #expect(p.goals == nil)
        #expect(p.settings.organizeEnabled)
        #expect(!p.settings.goalsEnabled)
    }

    @Test func theWeekAndTheClockAreReadLeniently() throws {
        func settings(_ value: String) throws -> PlannerSettings {
            let json = """
            {"v":1,"userId":"\(user)","fetchedAt":"x","settings":\(value),
             "items":[],"projects":[],"routines":[],"seasons":[]}
            """
            return try decode(json).settings
        }
        let monday = try settings(#"{"weekStartDay":"monday","timeFormat":"24h"}"#)
        #expect(monday.weekStartDay == .monday)
        #expect(monday.timeFormat == .twentyFourHour)
        #expect(try settings(#"{"weekStartDay":"saturday"}"#).weekStartDay == .saturday)
        // Unknown values and wrong types read as the web's defaults.
        let odd = try settings(#"{"weekStartDay":"tuesday","timeFormat":"12"}"#)
        #expect(odd.weekStartDay == .sunday)
        #expect(odd.timeFormat == .twelveHour)
        let wrong = try settings(#"{"weekStartDay":1,"timeFormat":null}"#)
        #expect(wrong.weekStartDay == .sunday)
        #expect(wrong.timeFormat == .twelveHour)
    }

    /// The Streaks switch: missing (a server older than the field), null or
    /// not a bool reads as on, the extension's default; only a real false
    /// turns it off.
    @Test func theStreaksSwitchIsReadLeniently() throws {
        func streaks(_ value: String?) throws -> Bool {
            let field = value.map { #","streaksEnabled":"# + $0 } ?? ""
            let json = """
            {"v":1,"userId":"\(user)","fetchedAt":"x","settings":{"timezone":"UTC"\(field)},
             "items":[],"projects":[],"routines":[],"seasons":[]}
            """
            return try decode(json).settings.streaksEnabled
        }
        #expect(try streaks(nil))
        #expect(try streaks("null"))
        #expect(try streaks(#""yes""#))
        #expect(try streaks(#""false""#))
        #expect(try streaks("true"))
        #expect(try streaks("false") == false)
        // The inline payload has no key at all.
        #expect(try decode(payload(items: "")).settings.streaksEnabled)
    }

    /// The Habit reminders switch: missing (a server older than the field),
    /// null (a server that couldn't read the column) or not a bool reads as
    /// unknown, never as off; only a real bool is an answer.
    @Test func theRemindersSwitchIsReadLeniently() throws {
        func reminders(_ value: String?) throws -> Bool? {
            let field = value.map { #","remindersEnabled":"# + $0 } ?? ""
            let json = """
            {"v":1,"userId":"\(user)","fetchedAt":"x","settings":{"timezone":"UTC"\(field)},
             "items":[],"projects":[],"routines":[],"seasons":[]}
            """
            return try decode(json).settings.remindersEnabled
        }
        #expect(try reminders(nil) == nil)
        #expect(try reminders("null") == nil)
        #expect(try reminders(#""yes""#) == nil)
        #expect(try reminders(#""false""#) == nil)
        #expect(try reminders("true") == true)
        #expect(try reminders("false") == false)
        // The inline payload has no key at all.
        #expect(try decode(payload(items: "")).settings.remindersEnabled == nil)
    }

    /// The rituals' settings: each unknown when missing, null or the wrong
    /// type, and the review folded into what the plan takes.
    @Test func theRitualSettingsAreReadLeniently() throws {
        func settings(_ value: String) throws -> PlannerSettings {
            let json = """
            {"v":1,"userId":"\(user)","fetchedAt":"x","settings":\(value),
             "items":[],"projects":[],"routines":[],"seasons":[]}
            """
            return try decode(json).settings
        }
        let odd = try settings(
            #"{"lastCallEnabled":"yes","lastCallTime":2030,"eodReviewEnabled":null,"eodReviewTime":false,"reminderGraceMinutes":"30"}"#
        )
        #expect(odd.lastCallEnabled == nil)
        #expect(odd.lastCallTime == nil)
        #expect(odd.eodReviewEnabled == nil)
        #expect(odd.eodReviewTime == nil)
        #expect(odd.reminderGraceMinutes == nil)
        #expect(odd.planEod == nil)

        // Off is off, with whatever hour is stored, so the plan withdraws a
        // review still in the shade.
        let off = try settings(#"{"eodReviewEnabled":false,"eodReviewTime":"21:00","lastEodReviewDate":"2026-10-01"}"#)
        #expect(off.planEod == PlanEod(enabled: false, time: "21:00", lastReviewDate: "2026-10-01"))
        // On with no hour is off, as the scan reads it.
        let noHour = try settings(#"{"eodReviewEnabled":true,"eodReviewTime":null}"#)
        #expect(noHour.planEod == PlanEod(enabled: false, time: "", lastReviewDate: nil))
        // The looser hour lib/eod.ts reads is passed as it is, for the plan to parse.
        let loose = try settings(#"{"eodReviewEnabled":true,"eodReviewTime":"9:15","reminderGraceMinutes":45}"#)
        #expect(loose.planEod == PlanEod(enabled: true, time: "9:15", lastReviewDate: nil))
        #expect(loose.reminderGraceMinutes == 45)
    }

    /// The snoozes: a bad element is skipped, never the payload; null or the
    /// wrong type is unknown.
    @Test func theSnoozesAreReadLeniently() throws {
        func snoozes(_ value: String) throws -> [PlanSnooze]? {
            let json = """
            {"v":1,"userId":"\(user)","fetchedAt":"x","settings":{},"snoozes":\(value),
             "items":[],"projects":[],"routines":[],"seasons":[]}
            """
            return try decode(json).snoozes
        }
        let item = "11111111-1111-4111-8111-000000000001"
        let good = #"{"itemId":"\#(item)","until":"2026-10-02T15:19:05.123456+00:00","date":"2026-10-02"}"#
        #expect(try snoozes("[\(good)]") == [
            PlanSnooze(itemId: UUID(uuidString: item)!, until: "2026-10-02T15:19:05.123456+00:00", date: "2026-10-02"),
        ])
        let bad = [
            #"{"itemId":"nope","until":"2026-10-02T15:19:05Z","date":"2026-10-02"}"#,
            #"{"itemId":"\#(item)","date":"2026-10-02"}"#,
            #"{"itemId":"\#(item)","until":"2026-10-02T15:19:05Z","date":null}"#,
            "3",
            "null",
        ]
        #expect(try snoozes("[\(bad.joined(separator: ","))]")?.isEmpty == true)
        #expect(try snoozes("[\(bad[0]),\(good)]")?.count == 1)
        #expect(try snoozes("null") == nil)
        #expect(try snoozes(#""none""#) == nil)
        #expect(try snoozes("[]") == [])
    }

    /// The trips: a bad element is skipped, never the payload; null or the
    /// wrong type is none; a bad id in a keep list or a wave is skipped.
    @Test func theTripsAreReadLeniently() throws {
        func trips(_ value: String) throws -> [AwayPeriod]? {
            let json = """
            {"v":1,"userId":"\(user)","fetchedAt":"x","settings":{},"awayPeriods":\(value),
             "items":[],"projects":[],"routines":[],"seasons":[]}
            """
            return try decode(json).awayPeriods
        }
        let item = "11111111-1111-4111-8111-000000000001"
        let good = #"""
        {"id":"t1","startsOn":"2026-10-10","endsOn":"2026-10-17",
         "keep":{"itemIds":["\#(item)","not-a-uuid",7],"routineIds":["r1"],"projectIds":null},
         "returns":{"\#(item)":"2026-10-19","nope":"2026-10-20","11111111-1111-4111-8111-000000000002":3},
         "fromTrip":{},"settledAt":null}
        """#
        let read = try #require(try trips("[\(good)]"))
        let id = UUID(uuidString: item)!
        #expect(read == [
            AwayPeriod(
                id: "t1", startsOn: "2026-10-10", endsOn: "2026-10-17",
                keep: AwayKeep(itemIds: [id], routineIds: ["r1"], projectIds: []),
                returns: [id: "2026-10-19"]
            ),
        ])
        // No end, or an empty one, is open-ended; no keep list keeps nothing.
        #expect(try trips(#"[{"id":"t2","startsOn":"2026-11-01","endsOn":""}]"#) == [
            AwayPeriod(id: "t2", startsOn: "2026-11-01"),
        ])
        // A trip with no id or no start can't be placed, and is skipped.
        let bad = [#"{"startsOn":"2026-11-01"}"#, #"{"id":"t3"}"#, #"{"id":"t4","startsOn":5}"#, "3", "null"]
        #expect(try trips("[\(bad.joined(separator: ","))]")?.isEmpty == true)
        #expect(try trips("[\(bad[0]),\(good)]")?.count == 1)
        #expect(try trips("null") == nil)
        #expect(try trips(#""none""#) == nil)
        #expect(try trips("[]") == [])
    }

    @Test func theWritesListIsReadLeniently() throws {
        func writes(_ value: String) throws -> [String]? {
            let json = """
            {"v":1,"userId":"\(user)","fetchedAt":"x","settings":{},"writes":\(value),
             "items":[],"projects":[],"routines":[],"seasons":[]}
            """
            return try decode(json).writes
        }
        #expect(try writes(#"["complete","schedule","skip"]"#) == ["complete", "schedule", "skip"])
        #expect(try writes("null") == nil)
        #expect(try writes(#""complete""#) == nil)
        // A bad element is skipped, as in every other list.
        #expect(try writes(#"["complete",7,"move"]"#) == ["complete", "move"])
    }

    @Test func theItemTypesAreReadLeniently() throws {
        func itemTypes(_ value: String?) throws -> [ItemTypeLabel]? {
            let field = value.map { #","itemTypes":"# + $0 } ?? ""
            let json = """
            {"v":1,"userId":"\(user)","fetchedAt":"x","settings":{}\(field),
             "items":[],"projects":[],"routines":[],"seasons":[]}
            """
            return try decode(json).itemTypes
        }
        // A server older than the field, or one that couldn't read the table.
        #expect(try itemTypes(nil) == nil)
        #expect(try itemTypes("null") == nil)
        #expect(try itemTypes(#""book""#) == nil)
        #expect(try itemTypes("[]") == [])
        // A bad element is skipped; a missing label reads as empty, so the
        // slug answers for it.
        let read = try itemTypes(#"""
        [{"name":"book","label":"Book to read","labelPlural":"Books to read"},7,null,
         {"label":"No name"},{"name":"errand","label":null}]
        """#)
        #expect(read == [
            ItemTypeLabel(name: "book", label: "Book to read", labelPlural: "Books to read"),
            ItemTypeLabel(name: "errand", label: "", labelPlural: ""),
        ])
        let labels = Dictionary((read ?? []).map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        #expect(typeLabel("book", labels: labels) == "Book to read")
        #expect(typeLabel("errand", labels: labels) == "Errand")
    }

    @Test func theAppIconPickIsReadLeniently() throws {
        func icon(_ value: String) throws -> AppIcon? {
            let json = """
            {"v":1,"userId":"\(user)","fetchedAt":"x","settings":{"timezone":null,"appIcon":\(value)},
             "items":[],"projects":[],"routines":[],"seasons":[]}
            """
            return try decode(json).settings.appIcon
        }
        #expect(try icon(#""lime""#) == .lime)
        #expect(try icon(#""aurora""#) == .aurora)
        #expect(try icon("null") == nil)
        #expect(try icon(#""sunset""#) == .aurora)
        // A wrong type is dropped, like every other lenient field.
        #expect(try icon("7") == nil)
    }

    /// The two Organize flags: missing (a server older than the fields), null
    /// or not a bool reads as the manifest default, Organize on and Goals
    /// off; only a real bool is an answer.
    @Test func theOrganizeFlagsAreReadLeniently() throws {
        /// [organizeEnabled, goalsEnabled].
        func flags(_ fields: String) throws -> [Bool] {
            let json = """
            {"v":1,"userId":"\(user)","fetchedAt":"x","settings":{"timezone":"UTC"\(fields)},
             "items":[],"projects":[],"routines":[],"seasons":[]}
            """
            let settings = try decode(json).settings
            return [settings.organizeEnabled, settings.goalsEnabled]
        }
        #expect(try flags("") == [true, false])
        #expect(try flags(#","organizeEnabled":null,"goalsEnabled":null"#) == [true, false])
        #expect(try flags(#","organizeEnabled":"false","goalsEnabled":"true""#) == [true, false])
        #expect(try flags(#","organizeEnabled":false,"goalsEnabled":true"#) == [false, true])
        #expect(try flags(#","organizeEnabled":true,"goalsEnabled":false"#) == [true, false])
        // The inline payload has no keys at all.
        let inline = try decode(payload(items: "")).settings
        #expect(inline.organizeEnabled && !inline.goalsEnabled)
    }

    /// `goals`: missing or null is unknown (nil, which hides Goals), never
    /// none; [] is none. A goal without an id or a name is skipped, a member
    /// id that isn't a uuid is dropped, and a missing state is active.
    @Test func theGoalsAreReadLeniently() throws {
        func goals(_ value: String?) throws -> [Goal]? {
            let field = value.map { #","goals":"# + $0 } ?? ""
            let json = """
            {"v":1,"userId":"\(user)","fetchedAt":"x","settings":{}\(field),
             "items":[],"projects":[],"routines":[],"seasons":[]}
            """
            return try decode(json).goals
        }
        #expect(try goals(nil) == nil)
        #expect(try goals("null") == nil)
        #expect(try goals(#""none""#) == nil)
        #expect(try goals("[]") == [])
        let read = try #require(try goals(#"""
        [{"id":"g1","name":"Run a half","why":7,"sortOrder":2.0,"state":"achieved",
          "achievedAt":"2026-09-20T18:00:00.123456+00:00","targetOn":"2027-03-15",
          "memberIds":["00000000-0000-4000-8000-000000000001","junk",null],
          "milestoneIds":["00000000-0000-4000-8000-000000000002"],"checkinIds":null},
         7,null,{"name":"no id"},{"id":"g-no-name"},
         {"id":"g2","name":"Bare"}]
        """#))
        #expect(read.map(\.id) == ["g1", "g2"])
        let half = read[0]
        #expect(half.why == nil)
        #expect(half.sortOrder == 2)
        #expect(half.state == "achieved")
        #expect(half.targetOn == "2027-03-15")
        #expect(half.memberIds == [UUID(uuidString: "00000000-0000-4000-8000-000000000001")!])
        #expect(half.milestoneIds == [UUID(uuidString: "00000000-0000-4000-8000-000000000002")!])
        #expect(half.checkinIds.isEmpty)
        let bare = read[1]
        #expect(bare.state == "active")
        #expect(bare.why == nil && bare.icon == nil && bare.color == nil && bare.sortOrder == nil)
        #expect(bare.startsOn == nil && bare.targetOn == nil && bare.achievedAt == nil)
        #expect(bare.memberIds.isEmpty && bare.milestoneIds.isEmpty && bare.checkinIds.isEmpty)
    }

    /// Organize's container fields degrade to nil, as every lenient field does.
    @Test func theContainersOwnFieldsAreReadLeniently() throws {
        let p = try decode(payload(
            items: a,
            routines: #"""
            [{"id":"r1","name":"Morning","icon":"icon:Sunrise","color":null,"usualTime":630,"notes":"Quiet.",
              "sortOrder":1.0,"itemIds":[]},{"id":"r2","name":"Bare","itemIds":[]}]
            """#,
            seasons: #"""
            [{"id":"s1","name":"Autumn","icon":7,"color":"var(--accent-6)","sortOrder":"1","notes":null,
              "updatedAt":"2026-09-01T08:00:00.5+00:00","itemIds":[],"routineIds":[]},
             {"id":"s2","name":"Bare","itemIds":[],"routineIds":[]}]
            """#
        ))
        let morning = try #require(p.routines.first)
        #expect(morning.icon == "icon:Sunrise")
        #expect(morning.color == nil)
        #expect(morning.usualTime == nil)
        #expect(morning.notes == "Quiet.")
        #expect(morning.sortOrder == 1)
        let bareRoutine = try #require(p.routines.last)
        #expect(bareRoutine.icon == nil && bareRoutine.color == nil && bareRoutine.usualTime == nil && bareRoutine.notes == nil)
        let autumn = try #require(p.seasons.first)
        #expect(autumn.icon == nil)
        #expect(autumn.color == "var(--accent-6)")
        #expect(autumn.sortOrder == nil)
        #expect(autumn.notes == nil)
        #expect(autumn.updatedAt == "2026-09-01T08:00:00.5+00:00")
        let bareSeason = try #require(p.seasons.last)
        #expect(bareSeason.icon == nil && bareSeason.color == nil && bareSeason.sortOrder == nil)
        #expect(bareSeason.notes == nil && bareSeason.updatedAt == nil)
    }

    @Test func theContainersRoundTrip() throws {
        let id = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
        let routine = Routine(
            id: "r1", name: "Morning", icon: "icon:Sunrise", color: "var(--accent-8)", sortOrder: 0, usualTime: "06:30",
            pausedAt: "2026-10-20T13:00:00Z", pausedUntil: "2026-10-30", notes: "Before the phone.", itemIds: [id]
        )
        #expect(try JSONDecoder().decode(Routine.self, from: try JSONEncoder().encode(routine)) == routine)
        let season = Season(
            id: "s1", name: "Autumn", icon: "icon:Leaf", color: "#1a2b3c", sortOrder: 2, state: "paused",
            startsOn: "2026-09-01", endsOn: "2026-11-30", notes: "Leaves.", itemIds: [id], routineIds: ["r1"],
            updatedAt: "2026-09-01T08:00:00.5+00:00"
        )
        #expect(try JSONDecoder().decode(Season.self, from: try JSONEncoder().encode(season)) == season)
        let goal = Goal(
            id: "g1", name: "Speak Spanish", why: "Madrid.", icon: "icon:Globe", color: "var(--accent-2)", sortOrder: 0,
            state: "achieved", startsOn: "2026-08-01", targetOn: "2027-04-01", achievedAt: "2026-09-20T18:00:00Z",
            memberIds: [id], milestoneIds: [id], checkinIds: []
        )
        #expect(try JSONDecoder().decode(Goal.self, from: try JSONEncoder().encode(goal)) == goal)
    }

    @Test func containerMembersKeepOnlyUUIDs() throws {
        let p = try decode(payload(
            items: a,
            routines: #"""
            [{"id":"r1","name":"Morning","pausedAt":"2026-09-30T14:03:22.123456+00:00",
              "itemIds":["00000000-0000-4000-8000-000000000001","junk",null]},{"name":"no id"}]
            """#,
            seasons: #"[{"id":"s1","name":"Autumn","itemIds":[],"routineIds":["r1"]}]"#
        ))
        #expect(p.routines.count == 1)
        #expect(p.routines.first?.itemIds == [UUID(uuidString: "00000000-0000-4000-8000-000000000001")!])
        #expect(p.seasons.first?.state == "auto")
        #expect(p.seasons.first?.routineIds == ["r1"])
    }

    @Test func idsAreCaseInsensitive() throws {
        let p = try decode(payload(items: #"{"type":"task","id":"0000000A-0000-4000-8000-00000000000B","title":"U"}"#))
        #expect(p.items.first?.id == UUID(uuidString: "0000000a-0000-4000-8000-00000000000b"))
    }

    @Test func theEnvelopeIsStrict() {
        #expect(throws: (any Error).self) {
            _ = try decode(#"{"v":1,"fetchedAt":"x","items":[]}"#)
        }
        #expect(throws: (any Error).self) {
            _ = try decode(#"{"v":1,"userId":"nope","fetchedAt":"x","items":[]}"#)
        }
    }

    @Test func anItemRoundTrips() throws {
        let item = Item(
            id: UUID(uuidString: "00000000-0000-4000-8000-000000000001")!, type: "custom", customType: "errand",
            title: "Stamps", status: "pending", startDate: "2026-10-02",
            notes: "Two books.\nFirst class.", priority: "medium", reminderTime: "09:15", reminderAnchor: "I park",
            currentDayCount: 1, repeatDays: [1, 3],
            completedDates: ["2026-10-01"], dailyCounts: ["2026-10-02": 1]
        )
        let data = try JSONEncoder().encode(item)
        #expect(try JSONDecoder().decode(Item.self, from: data) == item)
    }

    @Test func theSettingsRoundTrip() throws {
        let settings = PlannerSettings(
            timezone: "Europe/Paris", showCompletedTasks: false, appIcon: .lime,
            weekStartDay: .saturday, timeFormat: .twentyFourHour, streaksEnabled: false,
            organizeEnabled: false, goalsEnabled: true, remindersEnabled: false
        )
        let data = try JSONEncoder().encode(settings)
        #expect(try JSONDecoder().decode(PlannerSettings.self, from: data) == settings)
        #expect(String(decoding: data, as: UTF8.self).contains(#""remindersEnabled":false"#))
        // The default round-trips too, and is written, not left to the reader.
        let defaults = try JSONEncoder().encode(PlannerSettings())
        let decoded = try JSONDecoder().decode(PlannerSettings.self, from: defaults)
        #expect(decoded == PlannerSettings())
        #expect(decoded.streaksEnabled)
        #expect(String(decoding: defaults, as: UTF8.self).contains(#""streaksEnabled":true"#))
        // The Organize flags, away from their defaults and back, are written
        // too: Organize on and Goals off by default.
        #expect(!decoded.goalsEnabled && decoded.organizeEnabled)
        #expect(String(decoding: defaults, as: UTF8.self).contains(#""organizeEnabled":true"#))
        #expect(String(decoding: defaults, as: UTF8.self).contains(#""goalsEnabled":false"#))
        let flipped = String(decoding: data, as: UTF8.self)
        #expect(flipped.contains(#""organizeEnabled":false"#) && flipped.contains(#""goalsEnabled":true"#))
        // Unknown writes no key, so it reads back unknown, never as off.
        #expect(decoded.remindersEnabled == nil)
        #expect(!String(decoding: defaults, as: UTF8.self).contains("remindersEnabled"))

        // The rituals round-trip, and unknown writes no key.
        let rituals = PlannerSettings(
            lastCallEnabled: true, lastCallTime: "20:45", eodReviewEnabled: false, eodReviewTime: "21:30",
            lastEodReviewDate: "2026-10-01", reminderGraceMinutes: 30
        )
        #expect(try JSONDecoder().decode(PlannerSettings.self, from: try JSONEncoder().encode(rituals)) == rituals)
        let keys = ["lastCallEnabled", "lastCallTime", "eodReviewEnabled", "eodReviewTime", "lastEodReviewDate", "reminderGraceMinutes"]
        for key in keys {
            #expect(!String(decoding: defaults, as: UTF8.self).contains(key), "\(key)")
        }
    }
}
