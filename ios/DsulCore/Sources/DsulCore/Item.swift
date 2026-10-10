import Foundation

// The planner's data as GET /api/app/planner serves it: the web app's camelCase
// `Item` (packages/types/src/schemas.ts `ItemSchema`, built by `itemFromRow` in
// lib/db.ts), its containers, the settings the phone reads, the user's own item
// types' names, and the writes the server takes. The route's shape is pinned by
// tests/fixtures/app/planner-response.json, which PlannerPayloadTests decodes.
//
// Decoding is lenient on purpose. One bad value in a strict decode fails the
// whole payload, and a blank app is a worse answer than a missing row:
// - items decode one at a time; a row without a uuid id, a type or a title is
//   dropped and counted in `PlannerPayload.droppedItems`;
// - free-text columns (`type`, `status`, `timeBucket`, `startTime`,
//   `repeatFrequency`) stay `String`, because the agent API can write values
//   the enums don't name, and the web reads an unknown one as "matches nothing";
// - a number may arrive as a Double and is truncated to an Int;
// - a null or missing array is empty, and a bad element in it is skipped
//   (`itemTypes` and `writes` excepted: there, missing is nil, which means
//   "a server older than the field", not "none");
// - `pausedAt` stays a string, parsed in Active.swift (`parseTimestamp`), so no
//   `dateDecodingStrategy` is involved and Linux and Darwin agree.

/// One item: a task, a habit, or a user-defined type. The web's union is
/// discriminated on `type` ('task' | 'habit' | 'custom', with the custom slug
/// in `customType`); here it is one struct and the rules ask `typeName` or
/// `isHabit`, as lib/item-registry.ts has them ask the registry.
public struct Item: Codable, Sendable, Hashable, Identifiable {
    public var id: UUID
    public var type: String
    public var customType: String?
    public var title: String
    public var status: String?
    /// yyyy-MM-dd (task-like only; a habit is never date-anchored).
    public var startDate: String?
    /// "HH:mm".
    public var startTime: String?
    public var timeBucket: String?
    public var repeatFrequency: String?
    /// The container's NAME, which is what the web displays and matches on.
    public var project: String?
    /// The project's id (items.project_id): nil for a name with no project row
    /// (a text-only reference) or none at all.
    public var projectId: String?
    public var parentItemId: String?
    /// The instant a pause began, as Postgres wrote it.
    public var pausedAt: String?
    /// The day the pause ends, exclusive (yyyy-MM-dd).
    public var pausedUntil: String?
    /// Free text, newlines kept; nil when empty on the web (a null column).
    public var notes: String?
    /// 'low' | 'medium' | 'high' on task-shaped types; habits have none.
    public var priority: String?
    /// The daily cue's time, "HH:mm".
    public var reminderTime: String?
    /// The cue's implementation intention ("I pour my coffee"), read as
    /// "After I pour my coffee".
    public var reminderAnchor: String?
    /// Minutes.
    public var duration: Int?
    public var order: Int?
    public var repeatMonthDay: Int?
    public var streak: Int?
    public var timesPerDay: Int?
    /// A habit's tally for its current day, as the store last wrote it. The
    /// per-date truth is `dailyCounts`.
    public var currentDayCount: Int?
    public var isScheduled: Bool?
    public var inProjectBlock: Bool?
    /// Where a task parked in its project's block stood before it was parked
    /// (moveTasksToProjectBlock), put back when it leaves the block.
    public var previousStartTime: String?
    public var previousStartDate: String?
    public var repeatDays: [Int]?
    public var completedDates: [String]
    public var skippedDates: [String]
    public var dailyCounts: [String: Int]

    public init(
        id: UUID,
        type: String = "task",
        customType: String? = nil,
        title: String,
        status: String? = nil,
        startDate: String? = nil,
        startTime: String? = nil,
        timeBucket: String? = nil,
        repeatFrequency: String? = nil,
        project: String? = nil,
        projectId: String? = nil,
        parentItemId: String? = nil,
        pausedAt: String? = nil,
        pausedUntil: String? = nil,
        notes: String? = nil,
        priority: String? = nil,
        reminderTime: String? = nil,
        reminderAnchor: String? = nil,
        duration: Int? = nil,
        order: Int? = nil,
        repeatMonthDay: Int? = nil,
        streak: Int? = nil,
        timesPerDay: Int? = nil,
        currentDayCount: Int? = nil,
        isScheduled: Bool? = nil,
        inProjectBlock: Bool? = nil,
        previousStartTime: String? = nil,
        previousStartDate: String? = nil,
        repeatDays: [Int]? = nil,
        completedDates: [String] = [],
        skippedDates: [String] = [],
        dailyCounts: [String: Int] = [:]
    ) {
        self.id = id
        self.type = type
        self.customType = customType
        self.title = title
        self.status = status
        self.startDate = startDate
        self.startTime = startTime
        self.timeBucket = timeBucket
        self.repeatFrequency = repeatFrequency
        self.project = project
        self.projectId = projectId
        self.parentItemId = parentItemId
        self.pausedAt = pausedAt
        self.pausedUntil = pausedUntil
        self.notes = notes
        self.priority = priority
        self.reminderTime = reminderTime
        self.reminderAnchor = reminderAnchor
        self.duration = duration
        self.order = order
        self.repeatMonthDay = repeatMonthDay
        self.streak = streak
        self.timesPerDay = timesPerDay
        self.currentDayCount = currentDayCount
        self.isScheduled = isScheduled
        self.inProjectBlock = inProjectBlock
        self.previousStartTime = previousStartTime
        self.previousStartDate = previousStartDate
        self.repeatDays = repeatDays
        self.completedDates = completedDates
        self.skippedDates = skippedDates
        self.dailyCounts = dailyCounts
    }

    /// lib/item-registry.ts `itemTypeName`: the name the registry answers for,
    /// the custom slug rather than 'custom'.
    public var typeName: String {
        if type == "custom" { return customType ?? "custom" }
        return type
    }

    public var isHabit: Bool { type == "habit" }

    /// The repeat fields as Recurrence.swift reads them. Internal, so it can't
    /// collide with an app-side accessor.
    var rule: RepeatRule {
        RepeatRule(frequency: repeatFrequency, days: repeatDays, monthDay: repeatMonthDay)
    }

    enum CodingKeys: String, CodingKey {
        case id, type, customType, title, status, startDate, startTime, timeBucket
        case repeatFrequency, project, projectId, parentItemId, pausedAt, pausedUntil
        case notes, priority, reminderTime, reminderAnchor
        case duration, order, repeatMonthDay, streak, timesPerDay, currentDayCount
        case isScheduled, inProjectBlock, previousStartTime, previousStartDate
        case repeatDays, completedDates, skippedDates, dailyCounts
    }

    /// Throws only for what makes a row meaningless: no uuid id, no type, no
    /// title. Everything else degrades to nil or empty.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rawId = try c.decode(String.self, forKey: .id)
        guard let id = UUID(uuidString: rawId) else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "not a uuid: \(rawId)")
        }
        self.id = id
        self.type = try c.decode(String.self, forKey: .type)
        self.title = try c.decode(String.self, forKey: .title)
        self.customType = c.lenientString(.customType)
        self.status = c.lenientString(.status)
        self.startDate = c.lenientString(.startDate)
        self.startTime = c.lenientString(.startTime)
        self.timeBucket = c.lenientString(.timeBucket)
        self.repeatFrequency = c.lenientString(.repeatFrequency)
        self.project = c.lenientString(.project)
        self.projectId = c.lenientString(.projectId)
        self.parentItemId = c.lenientString(.parentItemId)
        self.pausedAt = c.lenientString(.pausedAt)
        self.pausedUntil = c.lenientString(.pausedUntil)
        self.notes = c.lenientString(.notes)
        self.priority = c.lenientString(.priority)
        self.reminderTime = c.lenientString(.reminderTime)
        self.reminderAnchor = c.lenientString(.reminderAnchor)
        self.duration = c.lenientInt(.duration)
        self.order = c.lenientInt(.order)
        self.repeatMonthDay = c.lenientInt(.repeatMonthDay)
        self.streak = c.lenientInt(.streak)
        self.timesPerDay = c.lenientInt(.timesPerDay)
        self.currentDayCount = c.lenientInt(.currentDayCount)
        self.isScheduled = c.lenientBool(.isScheduled)
        self.inProjectBlock = c.lenientBool(.inProjectBlock)
        self.previousStartTime = c.lenientString(.previousStartTime)
        self.previousStartDate = c.lenientString(.previousStartDate)
        self.repeatDays = c.lenientInts(.repeatDays)
        self.completedDates = c.lenientStrings(.completedDates) ?? []
        self.skippedDates = c.lenientStrings(.skippedDates) ?? []
        self.dailyCounts = c.lenientCounts(.dailyCounts)
    }
}

/// packages/types `ProjectSchema`, the fields a recurring time block reads,
/// and from 2f the web's colour and emoji.
public struct Project: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var repeatFrequency: String?
    public var repeatDays: [Int]?
    public var repeatMonthDay: Int?
    public var timeBucket: String?
    public var startTime: String?
    public var duration: Int?
    /// The web's colour token and emoji. Decoded and drawn nowhere in part 2 (Q1 a).
    public var color: String?
    public var emoji: String?

    public init(
        id: String,
        name: String,
        repeatFrequency: String? = nil,
        repeatDays: [Int]? = nil,
        repeatMonthDay: Int? = nil,
        timeBucket: String? = nil,
        startTime: String? = nil,
        duration: Int? = nil,
        color: String? = nil,
        emoji: String? = nil
    ) {
        self.id = id
        self.name = name
        self.repeatFrequency = repeatFrequency
        self.repeatDays = repeatDays
        self.repeatMonthDay = repeatMonthDay
        self.timeBucket = timeBucket
        self.startTime = startTime
        self.duration = duration
        self.color = color
        self.emoji = emoji
    }

    enum CodingKeys: String, CodingKey {
        case id, name, repeatFrequency, repeatDays, repeatMonthDay, timeBucket, startTime, duration, color, emoji
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.repeatFrequency = c.lenientString(.repeatFrequency)
        self.repeatDays = c.lenientInts(.repeatDays)
        self.repeatMonthDay = c.lenientInt(.repeatMonthDay)
        self.timeBucket = c.lenientString(.timeBucket)
        self.startTime = c.lenientString(.startTime)
        self.duration = c.lenientInt(.duration)
        self.color = c.lenientString(.color)
        self.emoji = c.lenientString(.emoji)
    }
}

/// packages/types `RoutineSchema`: things done regularly, in order. `itemIds`
/// is the routine's own sequence (routine_items.sort_order).
public struct Routine: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var sortOrder: Int?
    public var pausedAt: String?
    public var pausedUntil: String?
    public var itemIds: [UUID]

    public init(
        id: String,
        name: String,
        sortOrder: Int? = nil,
        pausedAt: String? = nil,
        pausedUntil: String? = nil,
        itemIds: [UUID] = []
    ) {
        self.id = id
        self.name = name
        self.sortOrder = sortOrder
        self.pausedAt = pausedAt
        self.pausedUntil = pausedUntil
        self.itemIds = itemIds
    }

    enum CodingKeys: String, CodingKey {
        case id, name, sortOrder, pausedAt, pausedUntil, itemIds
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.sortOrder = c.lenientInt(.sortOrder)
        self.pausedAt = c.lenientString(.pausedAt)
        self.pausedUntil = c.lenientString(.pausedUntil)
        self.itemIds = (c.lenientStrings(.itemIds) ?? []).compactMap { UUID(uuidString: $0) }
    }
}

/// packages/types `SeasonSchema`: a period of life. `state` stays a string;
/// anything but 'active' or 'paused' follows the dates, as the web reads it.
public struct Season: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    public var state: String
    public var startsOn: String?
    public var endsOn: String?
    public var itemIds: [UUID]
    public var routineIds: [String]

    public init(
        id: String,
        name: String,
        state: String = "auto",
        startsOn: String? = nil,
        endsOn: String? = nil,
        itemIds: [UUID] = [],
        routineIds: [String] = []
    ) {
        self.id = id
        self.name = name
        self.state = state
        self.startsOn = startsOn
        self.endsOn = endsOn
        self.itemIds = itemIds
        self.routineIds = routineIds
    }

    enum CodingKeys: String, CodingKey {
        case id, name, state, startsOn, endsOn, itemIds, routineIds
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try c.decode(String.self, forKey: .id)
        self.name = try c.decode(String.self, forKey: .name)
        self.state = c.lenientString(.state) ?? "auto"
        self.startsOn = c.lenientString(.startsOn)
        self.endsOn = c.lenientString(.endsOn)
        self.itemIds = (c.lenientStrings(.itemIds) ?? []).compactMap { UUID(uuidString: $0) }
        self.routineIds = c.lenientStrings(.routineIds) ?? []
    }
}

/// The `user_settings` columns the phone reads. `timezone` is the stored value
/// untrimmed; the caller applies `timezone?.trim() || device`
/// (components/supabase-provider.tsx, lib/planner-store.ts).
public struct PlannerSettings: Codable, Sendable, Hashable {
    public var timezone: String?
    /// Defaults to true, as the web's store does when the row has none.
    public var showCompletedTasks: Bool
    /// The App icon pick; nil when never chosen, or from a server older than
    /// the field. An unknown slug reads as Aurora (`AppIcon(stored:)`).
    public var appIcon: AppIcon?
    /// Week starts on. Sunday, the web's default, when missing (a server older
    /// than the field) or not one of the three.
    public var weekStartDay: WeekStartDay
    /// 12h or 24h clock. 12h, the web's default, when missing or unknown.
    public var timeFormat: TimeFormat
    /// The Streaks extension (lib/extension-registry.ts `EXT_STREAKS`, read
    /// through `resolveEnabled`): off hides the sheet's streak chip and the
    /// flame on Today's rows, and Reset streak is never offered. Every current
    /// server sends it, resolved against the extension's default (off since
    /// 2026-10-10). True when missing (a server older than the field, which
    /// only ever had Streaks on) or not a bool.
    public var streaksEnabled: Bool
    /// Habit reminders (the web's Settings, Rituals; `habit_reminders_enabled`,
    /// migration 032), the switch that lets any reminder through: false when
    /// off or never set, as the reminder scan reads it. Nil is unknown: a
    /// server that couldn't read the column sends null, and one older than the
    /// field sends nothing, as does a value that isn't a bool. Unknown shows no
    /// line in the Remind sheet, so the phone never says "off" on a guess.
    public var remindersEnabled: Bool?
    /// The last call (`habit_last_call_enabled`, migration 032), as the scan
    /// reads it: only true is on. Nil is unknown, as for `remindersEnabled`.
    /// The phone never rings it before APNs (reminders-platforms.md §2.3); it
    /// reads it to say so.
    public var lastCallEnabled: Bool?
    /// `habit_last_call_time`, "HH:mm" as stored; nil when unset or unknown.
    public var lastCallTime: String?
    /// The end-of-day review's switch (`eod_review_enabled`): only true is on.
    /// Nil from a server older than the field.
    public var eodReviewEnabled: Bool?
    /// `eod_review_time` as stored: "HH:mm", or the looser "H:mm" lib/eod.ts
    /// reads. Nil when unset, or from a server older than the field.
    public var eodReviewTime: String?
    /// `last_eod_review_date`: the day the last review was FOR.
    public var lastEodReviewDate: String?
    /// The scan's grace after a cue's minute (`REMINDER_GRACE_MINUTES`), the
    /// catch-up window. Nil from a server older than the field, where the
    /// plan's own `reminderGraceMinutes` stands in.
    public var reminderGraceMinutes: Int?

    public init(
        timezone: String? = nil,
        showCompletedTasks: Bool = true,
        appIcon: AppIcon? = nil,
        weekStartDay: WeekStartDay = .sunday,
        timeFormat: TimeFormat = .twelveHour,
        streaksEnabled: Bool = true,
        remindersEnabled: Bool? = nil,
        lastCallEnabled: Bool? = nil,
        lastCallTime: String? = nil,
        eodReviewEnabled: Bool? = nil,
        eodReviewTime: String? = nil,
        lastEodReviewDate: String? = nil,
        reminderGraceMinutes: Int? = nil
    ) {
        self.timezone = timezone
        self.showCompletedTasks = showCompletedTasks
        self.appIcon = appIcon
        self.weekStartDay = weekStartDay
        self.timeFormat = timeFormat
        self.streaksEnabled = streaksEnabled
        self.remindersEnabled = remindersEnabled
        self.lastCallEnabled = lastCallEnabled
        self.lastCallTime = lastCallTime
        self.eodReviewEnabled = eodReviewEnabled
        self.eodReviewTime = eodReviewTime
        self.lastEodReviewDate = lastEodReviewDate
        self.reminderGraceMinutes = reminderGraceMinutes
    }

    /// The review as `planNotifications` takes it. Nil while its switch is
    /// unknown (a server older than the field), which plans no review and
    /// withdraws none. A review switched on with no hour is off, as the scan
    /// reads it (lib/reminders/scan.ts asks for a time before it rings).
    public var planEod: PlanEod? {
        guard let enabled = eodReviewEnabled else { return nil }
        guard enabled, let time = eodReviewTime else {
            return PlanEod(enabled: false, time: eodReviewTime ?? "", lastReviewDate: lastEodReviewDate)
        }
        return PlanEod(enabled: true, time: time, lastReviewDate: lastEodReviewDate)
    }

    enum CodingKeys: String, CodingKey {
        case timezone, showCompletedTasks, appIcon, weekStartDay, timeFormat, streaksEnabled, remindersEnabled
        case lastCallEnabled, lastCallTime, eodReviewEnabled, eodReviewTime, lastEodReviewDate, reminderGraceMinutes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.timezone = c.lenientString(.timezone)
        self.showCompletedTasks = c.lenientBool(.showCompletedTasks) ?? true
        self.appIcon = AppIcon(stored: c.lenientString(.appIcon))
        self.weekStartDay = c.lenientString(.weekStartDay).flatMap { WeekStartDay(rawValue: $0) } ?? .sunday
        self.timeFormat = c.lenientString(.timeFormat).flatMap { TimeFormat(rawValue: $0) } ?? .twelveHour
        self.streaksEnabled = c.lenientBool(.streaksEnabled) ?? true
        self.remindersEnabled = c.lenientBool(.remindersEnabled)
        self.lastCallEnabled = c.lenientBool(.lastCallEnabled)
        self.lastCallTime = c.lenientString(.lastCallTime)
        self.eodReviewEnabled = c.lenientBool(.eodReviewEnabled)
        self.eodReviewTime = c.lenientString(.eodReviewTime)
        self.lastEodReviewDate = c.lenientString(.lastEodReviewDate)
        self.reminderGraceMinutes = c.lenientInt(.reminderGraceMinutes)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(timezone, forKey: .timezone)
        try c.encode(showCompletedTasks, forKey: .showCompletedTasks)
        try c.encodeIfPresent(appIcon?.rawValue, forKey: .appIcon)
        try c.encode(weekStartDay.rawValue, forKey: .weekStartDay)
        try c.encode(timeFormat.rawValue, forKey: .timeFormat)
        try c.encode(streaksEnabled, forKey: .streaksEnabled)
        try c.encodeIfPresent(remindersEnabled, forKey: .remindersEnabled)
        try c.encodeIfPresent(lastCallEnabled, forKey: .lastCallEnabled)
        try c.encodeIfPresent(lastCallTime, forKey: .lastCallTime)
        try c.encodeIfPresent(eodReviewEnabled, forKey: .eodReviewEnabled)
        try c.encodeIfPresent(eodReviewTime, forKey: .eodReviewTime)
        try c.encodeIfPresent(lastEodReviewDate, forKey: .lastEodReviewDate)
        try c.encodeIfPresent(reminderGraceMinutes, forKey: .reminderGraceMinutes)
    }
}

/// GET /api/app/planner (lib/app-api.ts), version 1.
public struct PlannerPayload: Decodable, Sendable, Hashable {
    public var v: Int
    public var userId: UUID
    public var fetchedAt: String
    public var settings: PlannerSettings
    public var items: [Item]
    public var projects: [Project]
    public var routines: [Routine]
    public var seasons: [Season]
    /// The `action`s POST /api/app/items/:id takes (`ITEM_WRITES`), e.g.
    /// ["complete", "schedule", "skip", "move", "pause"]. Nil from a server
    /// older than the list, which takes "complete" and "schedule" only; the
    /// app hides any verb whose write isn't listed.
    public var writes: [String]?
    /// The user's own item types, named (`itemTypes`, from item_types): a
    /// custom item's label, title placeholder and delete words read them
    /// through `caps(_:labels:)`. Nil when the server couldn't read the table,
    /// or is older than the field; either way a custom type is its slug,
    /// capitalised. A bad element is skipped.
    public var itemTypes: [ItemTypeLabel]?
    /// Every pending snooze on a live item (`snoozes`, lib/app-api.ts), as
    /// `planNotifications` takes them. Nil when the server couldn't read them,
    /// or is older than the field; the plan then arms none. A bad element is
    /// skipped.
    public var snoozes: [PlanSnooze]?
    /// Item rows that couldn't be read and were left out.
    public var droppedItems: Int

    public init(
        v: Int = 1,
        userId: UUID,
        fetchedAt: String,
        settings: PlannerSettings = PlannerSettings(),
        items: [Item] = [],
        projects: [Project] = [],
        routines: [Routine] = [],
        seasons: [Season] = [],
        writes: [String]? = nil,
        itemTypes: [ItemTypeLabel]? = nil,
        snoozes: [PlanSnooze]? = nil,
        droppedItems: Int = 0
    ) {
        self.v = v
        self.userId = userId
        self.fetchedAt = fetchedAt
        self.settings = settings
        self.items = items
        self.projects = projects
        self.routines = routines
        self.seasons = seasons
        self.writes = writes
        self.itemTypes = itemTypes
        self.snoozes = snoozes
        self.droppedItems = droppedItems
    }

    enum CodingKeys: String, CodingKey {
        case v, userId, fetchedAt, settings, items, projects, routines, seasons, writes, itemTypes, snoozes
    }

    /// The envelope is strict (a payload with no user can't be trusted to be
    /// this user's); its arrays are not.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.v = c.lenientInt(.v) ?? 1
        let rawUser = try c.decode(String.self, forKey: .userId)
        guard let userId = UUID(uuidString: rawUser) else {
            throw DecodingError.dataCorruptedError(forKey: .userId, in: c, debugDescription: "not a uuid: \(rawUser)")
        }
        self.userId = userId
        self.fetchedAt = try c.decode(String.self, forKey: .fetchedAt)
        self.settings = (try? c.decodeIfPresent(PlannerSettings.self, forKey: .settings)) ?? PlannerSettings()
        let items: (values: [Item], dropped: Int) = c.lossyArray(Item.self, .items)
        self.items = items.values
        self.droppedItems = items.dropped
        self.projects = c.lossyArray(Project.self, .projects).values
        self.routines = c.lossyArray(Routine.self, .routines).values
        self.seasons = c.lossyArray(Season.self, .seasons).values
        self.writes = c.lenientStrings(.writes)
        self.itemTypes = c.lossyArrayIfPresent(ItemTypeLabel.self, .itemTypes)
        self.snoozes = c.lossyArrayIfPresent(PlanSnooze.self, .snoozes)
    }
}

// MARK: - Lenient decoding

/// Decodes anything and keeps nothing: steps an unkeyed container past an
/// element that failed to decode as what it should have been.
private struct Skip: Decodable {
    init(from decoder: Decoder) throws {}
}

extension UnkeyedDecodingContainer {
    /// Steps past the current element, whatever it is. A failed `decode` leaves
    /// the container where it was, so a lossy loop must call this or spin. A
    /// null goes through `decodeNil`, which some decoders require. False when
    /// even that can't move on, and the loop has to stop.
    fileprivate mutating func skipElement() -> Bool {
        if let isNull = try? decodeNil(), isNull { return true }
        return (try? decode(Skip.self)) != nil
    }
}

/// Any JSON object key.
private struct AnyKey: CodingKey {
    var stringValue: String
    var intValue: Int?
    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }
    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}

/// A JSON number as an Int: whole numbers as they are, others truncated toward
/// zero. Nil for anything that isn't a finite number in range.
private func truncatedInt(_ d: Double) -> Int? {
    guard d.isFinite, abs(d) < 9.0e15 else { return nil }
    return Int(d)
}

extension KeyedDecodingContainer {
    // `try?` flattens: each of these is nil for a missing key, a null and a
    // value of the wrong type alike.
    fileprivate func lenientString(_ key: Key) -> String? {
        return try? decodeIfPresent(String.self, forKey: key)
    }

    fileprivate func lenientBool(_ key: Key) -> Bool? {
        return try? decodeIfPresent(Bool.self, forKey: key)
    }

    fileprivate func lenientInt(_ key: Key) -> Int? {
        if let whole = try? decodeIfPresent(Int.self, forKey: key) { return whole }
        if let real = try? decodeIfPresent(Double.self, forKey: key) { return truncatedInt(real) }
        return nil
    }

    /// Nil when the key is missing, null or not an array; otherwise the
    /// elements that are strings.
    fileprivate func lenientStrings(_ key: Key) -> [String]? {
        guard var list = try? nestedUnkeyedContainer(forKey: key) else { return nil }
        var out: [String] = []
        while !list.isAtEnd {
            if let s = try? list.decode(String.self) {
                out.append(s)
            } else if !list.skipElement() {
                break
            }
        }
        return out
    }

    /// Nil when the key is missing, null or not an array; otherwise the
    /// elements that are numbers, truncated.
    fileprivate func lenientInts(_ key: Key) -> [Int]? {
        guard var list = try? nestedUnkeyedContainer(forKey: key) else { return nil }
        var out: [Int] = []
        while !list.isAtEnd {
            if let i = try? list.decode(Int.self) {
                out.append(i)
            } else if let d = try? list.decode(Double.self) {
                if let i = truncatedInt(d) { out.append(i) }
            } else if !list.skipElement() {
                break
            }
        }
        return out
    }

    /// `dailyCounts`: a date → count map, keeping the entries that are numbers.
    fileprivate func lenientCounts(_ key: Key) -> [String: Int] {
        guard let map = try? nestedContainer(keyedBy: AnyKey.self, forKey: key) else { return [:] }
        var out: [String: Int] = [:]
        for k in map.allKeys {
            if let i = map.lenientInt(k) { out[k.stringValue] = i }
        }
        return out
    }

    /// Nil when the key is missing, null or not an array; otherwise the
    /// elements that decode, each on its own (`lossyArray`).
    fileprivate func lossyArrayIfPresent<T: Decodable>(_ type: T.Type, _ key: Key) -> [T]? {
        guard (try? nestedUnkeyedContainer(forKey: key)) != nil else { return nil }
        return lossyArray(type, key).values
    }

    /// Each element decoded on its own; one that fails is skipped and counted.
    /// A missing, null or non-array value is an empty list.
    fileprivate func lossyArray<T: Decodable>(_ type: T.Type, _ key: Key) -> (values: [T], dropped: Int) {
        guard var list = try? nestedUnkeyedContainer(forKey: key) else { return ([], 0) }
        var values: [T] = []
        var dropped = 0
        while !list.isAtEnd {
            if let value = try? list.decode(T.self) {
                values.append(value)
            } else {
                dropped += 1
                if !list.skipElement() { break }
            }
        }
        return (values, dropped)
    }
}
