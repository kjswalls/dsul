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
            "priority", "timesPerDay", "reminder", "time", "repeat", "project",
        ])
        // The route's test turns Streaks off, a value no default gives.
        #expect(p.settings.streaksEnabled == false)
        // ... and Habit reminders on, a value no default gives either (a
        // missing row is false, a database behind on its migrations null).
        #expect(p.settings.remindersEnabled == true)
        #expect(p.droppedItems == 0)
        #expect(p.items.count == raw.items.count)
        #expect(!p.items.isEmpty)
        #expect(!p.fetchedAt.isEmpty)
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
        let inactive = inactiveItemIdsOn(items: p.items, date: today, timeZone: zone, routines: p.routines, seasons: p.seasons)
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
            weekStartDay: .saturday, timeFormat: .twentyFourHour, streaksEnabled: false, remindersEnabled: false
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
        // Unknown writes no key, so it reads back unknown, never as off.
        #expect(decoded.remindersEnabled == nil)
        #expect(!String(decoding: defaults, as: UTF8.self).contains("remindersEnabled"))
    }
}
