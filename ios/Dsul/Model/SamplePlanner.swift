import Accessibility
import DsulCore
import Foundation
import Observation

/// An item as the phone holds it: the web's camelCase `Item`
/// (packages/types `ItemSchema`), decoded and ruled on by DsulCore. The old
/// name stays because every view says it.
typealias SampleItem = Item

/// The chips above the List layout.
enum ListFilter: Hashable, Sendable {
    case all, tasks, habits
    case project(String)
}

/// One day of a week and its rows, in `SamplePlanner.dayItems(on:)` order:
/// what `weekRows(of:)` answers for Week × List and Week × Buckets.
struct WeekDayRows: Identifiable, Hashable, Sendable {
    let day: DayString
    let rows: [SampleItem]

    var id: DayString { day }
}

/// One section of the List layout: a routine (with done/total), a project,
/// or the day's loose items.
struct ListSection: Identifiable, Hashable, Sendable {
    enum Kind: Hashable, Sendable { case routine, project, loose }

    let id: String
    let title: String
    let kind: Kind
    let items: [SampleItem]
    let doneCount: Int
}

/// The sheets anything in the app can raise, one at a time. The braindump
/// sheet is not one of them: it stays up over Schedule, and these stack on it.
enum PlannerSheet: Identifiable, Hashable, Sendable {
    case capture, datePicker
    /// An item's sheet: what it is, and its verbs on `day`. Opened through
    /// `SamplePlanner.open`, and closed by `apply` or `restore` when the item
    /// is gone.
    case item(UUID, day: SheetDay)
    /// Delete account, from the avatar menu (signed in only): here so it rides
    /// the one slot and both hosts, the braindump sheet's too. A deletion
    /// drops the planner, and the sheet with it.
    case deleteAccount

    var id: String {
        switch self {
        case .capture: return "capture"
        case .datePicker: return "datePicker"
        case .item(let id, _): return "item-" + id.uuidString.lowercased()
        case .deleteAccount: return "deleteAccount"
        }
    }
}

/// The day an item sheet's per-day verbs (tick, skip, unskip) act on, kept by
/// name and read when a verb is tapped (`SamplePlanner.actingDay`), as the
/// web's verbs are handed "the day it acts on" (lib/item-verbs.ts):
/// - `selected`: the day Today shows. A row on List, Buckets, Schedule or the
///   braindump opens with it, so the sheet acts on the day the row was drawn on.
/// - `today`: the user's day now. Search opens with it: it has no day of its own.
/// - `on(day)`: that day, whatever Today has selected. A row in a Week section
///   opens with its own day, so Thursday's row ticks and skips Thursday while
///   the week's anchor is Monday (design W13).
/// Pause and Resume are dateless and read today either way.
enum SheetDay: Hashable, Sendable {
    case selected, today
    case on(DayString)
}

/// A one-line message over Today: "Signed in as …", or a write or fetch the
/// server didn't take. One at a time; a newer one replaces it.
struct PlannerBanner: Identifiable, Equatable, Sendable {
    let id: UUID
    let text: String
    let isError: Bool

    init(_ text: String, isError: Bool) {
        self.id = UUID()
        self.text = text
        self.isError = isError
    }
}

/// The planner the app draws: the sample day ("Try with sample data", the
/// drag spike, the hosted tests), or the signed-in user's own items. The name
/// predates sign-in.
///
/// What shows on a day is DsulCore's port of the web's rules (lib/active.ts,
/// lib/day-items.ts, day-schedule.tsx, lib/braindump-members.ts,
/// lib/grouping.ts), a tick is lib/item-toggle.ts, the item sheet's verbs are
/// lib/item-verbs.ts (their gates) and the store actions they run (DsulCore
/// VerbWrites.swift), and its title, notes, priority, times a day, reminder,
/// time, repeat, project and Delete are lib/item-edit.ts and the store's
/// `deleteTask` / `deleteHabit` (the time as the dialog's `commitEdit` saves
/// it; the date is Reschedule's `move`; the project as the bulk Move to
/// project files it), Add a subtask the store's `addTask`, Reset streak its
/// `resetHabitStreak` (DsulCore ItemEdit.swift), the routine and season
/// toggles its `setItemsCollected` (DsulCore Membership.swift) and Move to
/// Braindump its `unscheduleTask` (DsulCore VerbWrites.swift), so the phone
/// and the web agree on the same data. Every change here is optimistic and
/// immediate; when signed in, `sync` then sends it to the server
/// (PlannerSync). A verb or an edit re-reads its item and asks its gate again
/// before it writes, whatever the sheet drew; a refusal changes nothing and
/// sends nothing.
@Observable @MainActor
final class SamplePlanner {
    /// Every item, braindump and subtasks included, as the server sent them
    /// (or the sample). A capture appends, as the web's does.
    var items: [SampleItem]
    /// The project containers, in the order the chips and sections show them.
    /// Their recurring time blocks place `inProjectBlock` tasks on the grid.
    private(set) var projectRecords: [Project]
    /// In the server's order (sort_order), which is the order a routine claims
    /// an item in when two hold it (lib/grouping.ts).
    private(set) var routines: [Routine]
    /// In the server's order. An item in a season is hidden on a day the
    /// season isn't live (`inactiveItemIdsOn`).
    private(set) var seasons: [Season]
    /// The user's goals, in the server's order (sort_order): Organize's Goals
    /// section. Nil until the first fetch lands, and when the server couldn't
    /// read them (`PlannerPayload.goals`), which hides the section rather
    /// than saying there are none. Decoded whatever `settings.goalsEnabled`
    /// says: the switch is a display gate, as on the web. A goal gates
    /// nothing on a day; the one rule here that reads them is Move to
    /// Braindump's, which never takes a milestone (`milestoneIds`).
    private(set) var goals: [Goal]? = nil
    /// The user's trips (`PlannerPayload.awayPeriods`, vacation mode): asked
    /// first by every "is this live" question here, as on the web, so a trip
    /// hides what the web hides. Empty for the sample and for a server older
    /// than the field.
    private(set) var awayPeriods: [AwayPeriod] = []
    private(set) var settings: PlannerSettings
    /// The user's day now. Moves at midnight and on returning to the app
    /// (`refreshToday`), and when the stored timezone changes, never from a
    /// view's body.
    private(set) var today: DayString
    var selectedDay: DayString
    var showBraindumpSheet = false
    /// The one sheet up besides the braindump, if any. The single source of
    /// truth: the two hosts below read it, and a dismissal clears it.
    var activeSheet: PlannerSheet? = nil
    /// Signed in: false until the first fetch lands. The sample starts loaded.
    private(set) var hasLoaded: Bool
    /// Signed in: why the first fetch failed, for the empty state.
    private(set) var loadError: String? = nil
    var banner: PlannerBanner? = nil
    /// The signed-in user; nil for the sample.
    let userId: UUID?
    /// The clock: what `refreshToday` reads, and a pause's stamp and "today".
    /// Injected so a test pins the instant; the app's is the device's.
    let now: () -> Date
    /// The item writes the server takes (`PlannerPayload.writes`). Nil until
    /// the first fetch lands, or from a server older than the list.
    private(set) var writes: [String]? = nil
    /// The user's own item types by slug (`PlannerPayload.itemTypes`): a
    /// custom item's noun, title placeholder and Delete's words read them
    /// (`caps(for:)`). Empty for the sample and for a server that sent none,
    /// so a custom type reads as its slug, capitalised.
    private(set) var typeLabels: [String: ItemTypeLabel] = [:]
    /// The same types in the server's order (`PlannerPayload.itemTypes`):
    /// Organize's Item types row and page. Empty for the sample; nil when the
    /// server couldn't read them, which the page says rather than "No custom
    /// types yet."
    private(set) var itemTypes: [ItemTypeLabel]? = []
    /// What the Trash routes take (`PlannerPayload.trashWrites`, O14). Nil
    /// until the first fetch lands, and from a server older than the routes,
    /// which hides the Trash row (`offersTrash`).
    private(set) var trashWrites: [String]? = nil
    /// What POST /api/app/containers/:kind/:id takes, by kind
    /// (`PlannerPayload.containerWrites`, O8a). Nil until the first fetch
    /// lands, and from a server older than the route, which hides every
    /// container editor and Paused's container Resume (`containerTakes`).
    private(set) var containerWrites: ContainerWrites? = nil
    /// Sends this planner's writes and fetches its data. Nil for the sample,
    /// whose changes last until the app quits.
    @ObservationIgnored private(set) var sync: PlannerSync? = nil
    /// The server's snoozes (`PlannerPayload.snoozes`): what this iPhone's
    /// notification plan arms besides the cues. Empty for the sample, and
    /// when the server couldn't read them.
    private(set) var snoozes: [PlanSnooze] = []
    /// Told whenever what the notification plan reads may have moved: a
    /// fetch applied (`fetched` true), or a write queued (after its
    /// optimistic step) or a revert (false). NotificationHub listens (AppGate
    /// attaches it); nil for the sample.
    @ObservationIgnored var onChange: (@MainActor (_ fetched: Bool) -> Void)? = nil
    #if DEBUG
    /// How many days `derive` has worked out, for tests only: a ghost step
    /// on the Schedule must not move it (design §5.1, "What reads what").
    /// Ignored by Observation, so counting re-renders nothing.
    @ObservationIgnored private(set) var derivations = 0
    #endif

    /// What RootView presents: the sheet, unless the braindump sheet is up,
    /// since a view can't present over a sheet its own subtree put up.
    var sheetOverApp: PlannerSheet? {
        get { showBraindumpSheet ? nil : activeSheet }
        set { activeSheet = newValue }
    }

    /// What the braindump sheet presents, stacked on itself, while it is up.
    var sheetOverBraindump: PlannerSheet? {
        get { showBraindumpSheet ? activeSheet : nil }
        set { activeSheet = newValue }
    }

    /// Is an item's sheet up? It draws the banner itself, so Today doesn't.
    var isShowingItemSheet: Bool {
        if case .item(_, _)? = activeSheet { return true }
        return false
    }

    /// A test's sample planner, pinned to `todayString`. Pass a `now` on that
    /// day too: a pause, and opening a sheet from Search, read the clock.
    convenience init(todayString: String, now: @escaping () -> Date = { Date() }) {
        self.init(today: DayString(todayString), now: now)
    }

    /// The sample planner (SampleData), on `today` or the clock's day.
    init(today: DayString? = nil, now: @escaping () -> Date = { Date() }) {
        let anchor: DayString = today ?? DayString(date: now())
        let sample = SampleData.make(today: anchor)
        self.today = anchor
        selectedDay = anchor
        items = sample.items
        projectRecords = sample.projects
        routines = sample.routines
        seasons = sample.seasons
        goals = sample.goals
        // Goals on, so every Organize section shows without signing in. A
        // signed-in account follows its own switch.
        settings = PlannerSettings(goalsEnabled: true)
        hasLoaded = true
        userId = nil
        self.now = now
    }

    /// The signed-in user's planner: empty until the first fetch lands. Its
    /// day is the device's until the user's stored timezone arrives with it.
    /// `isDragging` holds fetched data back while a braindump row is in the
    /// air (ScheduleDrag's `DragHold`). `backgroundTime` is what its writes
    /// ask iOS for when the app leaves the screen (AppGate passes UIKit's).
    init(userId: UUID, api: APIClient, isDragging: @escaping @MainActor () -> Bool, todayString: String? = nil,
         now: @escaping () -> Date = { Date() }, backgroundTime: BackgroundTime = .foregroundOnly) {
        let anchor: DayString = todayString.flatMap { DayString($0) } ?? DayString(date: now())
        self.today = anchor
        selectedDay = anchor
        items = []
        projectRecords = []
        routines = []
        seasons = []
        settings = PlannerSettings()
        hasLoaded = false
        self.userId = userId
        self.now = now
        sync = PlannerSync(planner: self, api: api, userId: userId, isDragging: isDragging, now: now,
                           backgroundTime: backgroundTime)
    }

    nonisolated static func uuid(_ n: Int) -> UUID {
        return SampleData.uuid(n)
    }

    /// Signed in, so writes go to the server and the sample-only switches
    /// (the 40 blocks) are off.
    var isLive: Bool { userId != nil }

    /// The project names, in container order: the chips, the sections, Organize.
    var projects: [String] { projectRecords.map(\.name) }

    /// The colour a project wears on Today and in the item sheet (O15): the
    /// dot on its List section, its filter chip and its Week caption, and on
    /// the sheet's project chip and each project menu row. DsulCore
    /// `projectAccent`, the web's grid rule (planner-store `getProjectColor`)
    /// over the project records, colours and all: the stored colour of the
    /// project the name folds to, else a legacy `--habit-*` token for a
    /// folded "wellness", "work" or "personal", else the folded name's ramp
    /// step. Folded as JavaScript does (`jsLowercased`), as the project menu
    /// checks its rows (`ProjectChoice.key`), so an item filed "work" wears
    /// Work's colour and the chip's dot and the menu's check agree on every
    /// name, a final sigma included. A name no project holds still has a
    /// colour, as on the web. Organize's tile is the other rule
    /// (`containerAccent`): the two differ, as they do on the web, where no
    /// colour the phone can read is stored and the name is Work, Personal or
    /// Wellness, or folds to another ramp step.
    func projectAccent(for name: String) -> ContainerAccent {
        return DsulCore.projectAccent(name, projects: projectRecords)
    }

    // MARK: Days

    var isOnToday: Bool { selectedDay == today }
    var selectedDayString: String { selectedDay.description }

    func select(_ day: DayString) { selectedDay = day }
    func shiftDay(by days: Int) { selectedDay = selectedDay.adding(days: days) }
    func goToToday() { selectedDay = today }

    /// The selected day's week, its first day first, by the user's Week starts
    /// on (DsulCore `weekDays`, the web's week views' start + i). Week draws
    /// these seven; `selectedDay` stays the anchor, so Go to date picks a day
    /// and the week follows.
    var selectedWeek: [DayString] {
        return weekDays(of: selectedDay, settings.weekStartDay)
    }

    /// Does the selected day's week hold today? Week's Today button shows
    /// only when it doesn't, as Day's does off today.
    var isOnTodaysWeek: Bool {
        return weekStartOf(selectedDay, settings.weekStartDay) == weekStartOf(today, settings.weekStartDay)
    }

    /// The zone every day here is read in: the stored one, trimmed, when this
    /// device knows it (`timezone?.trim() || device`, as the web's store and
    /// components/supabase-provider.tsx resolve it); the device's otherwise.
    var timeZoneID: String {
        return Self.storedZone(settings.timezone) ?? TimeZone.current.identifier
    }

    /// Does the account store a usable time zone? The reminder scan skips an
    /// account whose zone is null or unusable (lib/reminders/scan.ts). Since
    /// 2c the phone stores its own when it differs (NotificationHub, through
    /// POST /api/app/timezone), as the web does when opened.
    var hasStoredZone: Bool {
        return Self.storedZone(settings.timezone) != nil
    }

    nonisolated private static func storedZone(_ raw: String?) -> String? {
        guard let id = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty,
              TimeZone(identifier: id) != nil
        else { return nil }
        return id
    }

    /// Moves `today` to the user's day at `instant` (the clock's now when nil):
    /// in their stored zone when there is one, else in `calendar` (the
    /// device's). See `refreshToday(to:)`.
    func refreshToday(now instant: Date? = nil, calendar: Calendar = .current) {
        let at = instant ?? now()
        if let zone = Self.storedZone(settings.timezone), let day = toDateStr(at, timeZone: zone) {
            refreshToday(to: day)
        } else {
            refreshToday(to: DayString(date: at, calendar: calendar))
        }
    }

    /// Moves `today` to `newToday`. The selection follows only if it was on
    /// today; a day picked on purpose stays picked.
    func refreshToday(to newToday: DayString) {
        guard newToday != today else { return }
        if selectedDay == today { selectedDay = newToday }
        today = newToday
    }

    /// Minutes since midnight at `date`, in the zone `today` is read in (the
    /// web's day schedule marks "now" with `useNowMinutes(timezone)`,
    /// lib/use-now-minutes.ts), so the "Now" row and the day agree.
    func minuteOfDay(_ date: Date) -> Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: timeZoneID) ?? TimeZone.current
        let c = calendar.dateComponents([.hour, .minute], from: date)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }

    // MARK: What shows on a day

    /// `date`'s rows as the web files them: DsulCore `deriveDayItems` over the
    /// task/habit split, with what is paused or out of season on `date` held
    /// back (`inactiveItemIdsOn`), and the phone's defaults (no filters).
    /// Internal, not private, so a hosted test can hold `week(of:)` to it.
    func derive(on date: DayString) -> DayItems {
        return derive(on: date, split: DsulCore.project(items), zone: timeZoneID)
    }

    /// One day of the pipeline over a split made once: `week(of:)` splits
    /// the items a single time for its seven days, as the web's
    /// `useDayItemsForDates` asks `deriveDayItems` once per date over one
    /// projection (hooks/use-day-items.ts).
    private func derive(on date: DayString, split: (tasks: [Item], habits: [Item]), zone: String) -> DayItems {
        #if DEBUG
        derivations += 1
        #endif
        let inactive = inactiveItemIdsOn(items: items, date: date, timeZone: zone, routines: routines, seasons: seasons,
                                         away: awayPeriods)
        return deriveDayItems(tasks: split.tasks, habits: split.habits, projects: projectRecords, date: date,
                              timeZone: zone, showCompletedTasks: settings.showCompletedTasks, inactive: inactive)
    }

    /// The seven days of `day`'s week (`weekDays`, from the user's Week starts
    /// on), each as `derive(on:)` answers it: `project(items)` once, then what
    /// is held back and what shows resolved at each day's own date, so a pause
    /// ending mid-week or a season starting Thursday lands on the right day
    /// (design §4.6; the web's week views do the same, per date).
    func week(of day: DayString) -> [DayString: DayItems] {
        let split = DsulCore.project(items)
        let zone = timeZoneID
        var out: [DayString: DayItems] = [:]
        for date in weekDays(of: day, settings.weekStartDay) {
            out[date] = derive(on: date, split: split, zone: zone)
        }
        return out
    }

    /// The seven days of `day`'s week, each with its rows in `dayItems(on:)`
    /// order, from one `week(of:)`: what Week × List and Week × Buckets draw,
    /// so a render derives the week once rather than once per question.
    func weekRows(of day: DayString) -> [WeekDayRows] {
        let week = week(of: day)
        return weekDays(of: day, settings.weekStartDay).map { date in
            WeekDayRows(day: date, rows: week[date].map(flattenDayRows) ?? [])
        }
    }

    /// `day`'s items: habits, then tasks, each in bucket and time order
    /// (lib/day-items.ts `flattenDayRows`).
    func dayItems(on day: DayString) -> [SampleItem] {
        return flattenDayRows(derive(on: day))
    }

    /// The selected day's items (`dayItems(on:)`).
    var dayItems: [SampleItem] {
        return dayItems(on: selectedDay)
    }

    /// Ticked on `day` (lib/item-toggle.ts `isRowDone`): a habit or a
    /// recurring task by its date, a one-off task by its status. A week row
    /// asks at its own day, never the anchor.
    func isDone(_ item: SampleItem, on day: DayString) -> Bool {
        return isRowDone(item, on: day)
    }

    /// Ticked on the selected day (`isDone(_:on:)`).
    func isDone(_ item: SampleItem) -> Bool {
        return isDone(item, on: selectedDay)
    }

    /// Skipped on `day`: drawn as a strip, and a tick on it is refused
    /// (`toggleRow`).
    func isSkipped(_ item: SampleItem, on day: DayString) -> Bool {
        return isRowSkipped(item, on: day)
    }

    /// Skipped on the selected day (`isSkipped(_:on:)`).
    func isSkipped(_ item: SampleItem) -> Bool {
        return isSkipped(item, on: selectedDay)
    }

    // MARK: Writes

    /// A row's tick on `day`: ticks or unticks an item there, as the web's row
    /// checkbox (`toggleRowDone`) does, with no verb gate. A week row ticks on
    /// its own day; the sheet's tick stays `toggle(_:on:)`, gated. See
    /// `tick(_:on:)`.
    func toggleRow(_ id: UUID, on day: DayString) {
        tick(id, on: day)
    }

    /// A row's tick on the selected day (`toggleRow(_:on:)`).
    func toggle(_ id: UUID) {
        toggleRow(id, on: selectedDay)
    }

    /// The tick on `day`, as lib/item-toggle.ts `toggleRowDone` resolves it
    /// (DsulCore `tickIntent`, then `applying` for the optimistic step): a
    /// habit's streak moves by one, a counted habit steps its tally, a
    /// recurring task flips its date, a one-off its status. A skipped
    /// occurrence is refused and nothing is sent. Ungated beyond that, as the
    /// web's row checkbox is; the sheet's `toggle(_:on:)` adds the verb's gate.
    private func tick(_ id: UUID, on day: DayString) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        let before = items[i]
        guard let intent = tickIntent(before, on: day) else { return }
        items[i] = applying(intent, to: before, on: day)
        sync?.enqueue(.complete(id: id, date: day.description, done: intent.done, count: intent.count),
                      snapshot: before)
    }

    /// Puts an item on the selected day's grid at `startMin`: a braindump row
    /// dropped on an hour (or VoiceOver's "Schedule at 9:00"), or a block
    /// moved. The web's hour drop (`placing`, lib/dnd/handle-drag-end.ts →
    /// `scheduleTask`): scheduled, the hour's bucket, the time, out of any
    /// project block (its stash cleared), and anchored to the day it was
    /// dropped on. Also ends the drag's hold on fetched data: the drop has
    /// landed.
    func schedule(_ id: UUID, startMin: Int) {
        DragHold.shared.releaseNow()
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        let before = items[i]
        // A habit isn't date-anchored, and the web's habit drop writes another
        // field set (`scheduleHabit`) the server doesn't take from the phone
        // (/api/app/items/:id answers not_schedulable). No sample habit is in
        // the braindump, and a real one almost never is.
        guard !before.isHabit else { return }
        let time = minutesToTime(startMin)
        items[i] = placing(before, on: selectedDayString, startMin: startMin)
        sync?.enqueue(.schedule(id: id, date: selectedDayString, startTime: time), snapshot: before)
    }

    /// Captures a thought into the braindump, as the web's `addTask` with no
    /// bucket: a pending, undated, unscheduled task appended after every
    /// task-like row (`order = tasks.length`). The id is made here, so a retry
    /// of the same capture is the same row on the server.
    func capture(_ title: String) {
        // The route trims as JavaScript does and takes at most
        // `EditLimits.newTitle` UTF-16 units (lib/app-api.ts `CaptureSchema`,
        // `NEW_TITLE_LIMIT`, new text's one cap). Cut by whole characters, then
        // trimmed again, so a cut can't leave a space the server strips.
        let clean = jsTrim(clampUTF16(jsTrim(title), EditLimits.newTitle))
        guard !clean.isEmpty else { return }
        let id = UUID()
        let order = DsulCore.project(items).tasks.count
        let created = Item(id: id, type: "task", title: clean, status: "pending", order: order, isScheduled: false)
        items.append(created)
        sync?.enqueue(.capture(id: id, title: clean), before: [.item(id): .absent(created: created)])
    }

    // MARK: The item sheet

    /// Raises `id`'s sheet, acting on `day`. From Search (`.today`) the day is
    /// first brought up to the clock (`refreshToday`), so a sheet opened just
    /// after midnight acts on the new day. A missing item opens nothing.
    func open(_ id: UUID, day: SheetDay) {
        guard item(id) != nil else { return }
        if day == .today { refreshToday() }
        activeSheet = .item(id, day: day)
    }

    /// The day a sheet opened with `day` acts on: the selected day, today, or
    /// the day it names. A read, so a view's body may ask it; `today` itself
    /// moves only in `refreshToday` (RootView's minute check, `open`, a pause
    /// or resume).
    func actingDay(_ day: SheetDay) -> DayString {
        switch day {
        case .selected: return selectedDay
        case .today: return today
        case .on(let named): return named
        }
    }

    /// What the web's verbs are handed for `item` on the sheet's day (see
    /// `verbContext(for:on:)`).
    func verbContext(for item: SampleItem, day: SheetDay) -> VerbContext {
        return verbContext(for: item, on: actingDay(day))
    }

    /// What the web's verbs are handed for `item` on `day`: the day, today,
    /// the zone, the item's state there (DsulCore `occurrenceOn`: absent when
    /// a recurring item doesn't fall on the day, else done, skipped, due from
    /// today on, or open before it; nil for a one-off), whether Streaks is
    /// on (`settings.streaksEnabled`, the web's `streaksEnabled()`), and the
    /// goals' milestones (`milestoneIds`, nil while goals are unread).
    func verbContext(for item: SampleItem, on day: DayString) -> VerbContext {
        let zone = timeZoneID
        let dateStr = day.description
        let todayStr = today.description
        return VerbContext(dateStr: dateStr, todayStr: todayStr, timeZone: zone,
                           occurrence: occurrenceOn(item, on: dateStr, today: todayStr, timeZone: zone),
                           streaksEnabled: settings.streaksEnabled, milestoneIds: milestoneIds)
    }

    /// (Week and blocks PR 3) The items that are some goal's milestone
    /// (DsulCore `milestoneItemIds` over `goals`, as the web's verbs read
    /// them off the store's raw goals, whatever the Goals switch says), which
    /// Move to Braindump never takes: a milestone's date is its target. Nil
    /// while goals are unread (before the first fetch, and from a server that
    /// couldn't read them or is older than the field), and then the verb is
    /// offered nowhere, rather than on a milestone the server would refuse.
    /// The sample's goals are its own, so it always knows.
    var milestoneIds: Set<UUID>? {
        return goals.map(milestoneItemIds)
    }

    /// The item writes a server older than `PlannerPayload.writes` takes.
    static let legacyWrites = ["complete", "schedule"]

    /// Does the server take this POST /api/app/items/:id `action`? The list
    /// the last fetch carried, or `legacyWrites` without one (or before the
    /// first fetch). The sample takes every action: nothing is sent.
    func canWrite(_ action: String) -> Bool {
        guard isLive else { return true }
        return (writes ?? Self.legacyWrites).contains(action)
    }

    /// May `item` take the edit `action` names? The server takes the action
    /// (`canWrite`) and the item's type has the field (DsulCore
    /// `editAllowed(action:on:caps:)`, lib/item-edit.ts `editRefusal`'s type
    /// gate: a habit has no priority, a task no count, a subtask no reminder,
    /// no time, no repeat and no project, a task no time until it has a date,
    /// and a project only on a type with the project axis; and for `collect`,
    /// `isCollectible`: a subtask joins no routine or season). The sheet asks
    /// it for a chip before it has a value to send, and `edit` asks the typed
    /// gate below before it writes, as `collect` asks this one.
    func canEdit(_ action: String, _ item: SampleItem) -> Bool {
        return canWrite(action) && editAllowed(action: action, on: item, caps: caps(for: item))
    }

    /// May `item` take `edit` itself? `canEdit(edit.action, item)`, and the
    /// body's own rules (DsulCore `editAllowed(_:on:caps:)`): the ones a time
    /// edit carries (no key at all, a time beside Anytime or none, a length
    /// out of range or on a type with none), the ones a repeat edit carries
    /// (a frequency its type doesn't offer, days or a day beside the wrong
    /// frequency, days out of order) and the ones a project edit carries (an
    /// id without its name, No project on a type whose container is
    /// required) are refused here, before any step, as the route refuses
    /// them. The row's rule, a time that would land beside a stored Anytime,
    /// is the sheet's to keep (`ItemSheetModel.timeCommit`).
    func canEdit(_ edit: ItemEdit, _ item: SampleItem) -> Bool {
        return canWrite(edit.action) && editAllowed(edit, on: item, caps: caps(for: item))
    }

    /// Does the server take the write `verb` sends?
    func canWrite(_ verb: VerbID) -> Bool {
        return canWrite(Self.writeAction(verb))
    }

    /// The `action` the write behind `verb` carries.
    nonisolated static func writeAction(_ verb: VerbID) -> String {
        switch verb {
        case .tick: return "complete"
        case .skip, .unskip: return "skip"
        case .pause, .resume: return "pause"
        case .nextDay, .reschedule: return "move"
        case .braindump: return "unschedule"
        case .resetStreak: return "resetStreak"
        case .delete: return "delete"
        }
    }

    /// May the sheet offer `verb` on `item` in `ctx`? Four answers, all yes
    /// (the third asked of Move to Braindump alone):
    /// - the web's gate (DsulCore `verbEligible`, lib/item-verbs.ts);
    /// - the server's own gate where it asks more (lib/app-api.ts): it never
    ///   skips, carries or unschedules a subtask, which has no day of its own,
    ///   pauses or resumes only what `isPausable` allows, and resets a streak
    ///   only on a type that keeps one (`streakCounter`, its `no_streak`),
    ///   where the web's gate asks only `isHabit`. Delete it takes on
    ///   anything, a subtask included;
    /// - for Move to Braindump, the surfaces' own rule (design B24): never on
    ///   a row the braindump already lists, neither scheduled nor in a part of
    ///   day (DsulCore `isTaskScheduled`, lib/braindump-members.ts's test),
    ///   as the web's row and mobile sheet ask before they offer it. The gate
    ///   itself (`verbEligible`) also needs the milestones known
    ///   (`ctx.milestoneIds`);
    /// - the server takes the write (`canWrite`).
    func offers(_ verb: VerbID, _ item: SampleItem, _ ctx: VerbContext) -> Bool {
        guard canWrite(verb), verbEligible(verb, item, ctx) else { return false }
        switch verb {
        case .tick: return true
        case .skip, .unskip: return isSkippable(item) && !item.isSubtask
        case .nextDay, .reschedule: return !item.isSubtask
        case .pause, .resume: return isPausable(item)
        case .braindump: return !item.isSubtask && isTaskScheduled(item)
        case .resetStreak: return caps(for: item).streakCounter
        case .delete: return true
        }
    }

    /// Every verb the sheet may offer `item` on its day, in the web's
    /// declaration order (tick, skip, unskip, pause, resume, nextDay,
    /// reschedule, braindump, resetStreak, delete). Which ones the bar shows,
    /// and in what slots, is the view's; Reset streak is the streak chip's,
    /// never the bar's or ⋯'s, and Move to Braindump is ⋯'s.
    func offeredVerbs(for item: SampleItem, day: SheetDay) -> [VerbID] {
        let ctx = verbContext(for: item, day: day)
        return VerbID.allCases.filter { offers($0, item, ctx) }
    }

    /// The sheet's tick on `day`: the row's write (`tick(_:on:)`), behind the
    /// web's `tick` gate, so it never ticks a cancelled item or a day a
    /// recurring item doesn't fall on. A subtask's circle uses it too (a
    /// one-off ignores the day).
    func toggle(_ id: UUID, on day: DayString) {
        guard let before = item(id), offers(.tick, before, verbContext(for: before, on: day)) else { return }
        tick(id, on: day)
    }

    /// Skip today: skips `id`'s occurrence on `day` (the store's
    /// `setItemSkipped(id, true)`, DsulCore `skipping`): a habit takes the
    /// 'skipped' status and gives back the day's completion with its streak
    /// day; a task-like item gains the date in `skippedDates`, loses that day's
    /// completion, and keeps its status.
    func skip(_ id: UUID, on day: DayString) {
        setSkipped(id, on: day, skipped: true)
    }

    /// Unskip today: the day back to open (a habit to 'pending').
    func unskip(_ id: UUID, on day: DayString) {
        setSkipped(id, on: day, skipped: false)
    }

    private func setSkipped(_ id: UUID, on day: DayString, skipped: Bool) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        let before = items[i]
        guard offers(skipped ? .skip : .unskip, before, verbContext(for: before, on: day)) else { return }
        let date = day.description
        let after = skipping(before, on: date, skipped: skipped)
        guard after != before else { return }
        items[i] = after
        sync?.enqueue(.skip(id: id, date: date, skipped: skipped), snapshot: before)
    }

    /// Tomorrow and Reschedule, and the Date chip's Today, Tomorrow, Next
    /// week and Pick a date… too: carries a task-like item to `dateStr` (the
    /// store's `moveTaskToDate`, DsulCore `moving`): that start date, its
    /// bucket kept (Anytime when it had none), its time and length kept. The
    /// caller picks the day (`nextDayOf` for Tomorrow); the gate is the web's
    /// `reschedule` one (lib/row-moves.ts `canReschedule`), asked off the
    /// item's own day or, undated, the target, as the server asks it. A
    /// recurring task may move: the day becomes its series start. A habit, a
    /// finished item, one in a project block and a subtask are refused.
    func move(_ id: UUID, to dateStr: String) {
        guard let target = DayString(dateStr), let i = items.firstIndex(where: { $0.id == id }) else { return }
        let before = items[i]
        guard offers(.reschedule, before, verbContext(for: before, on: target)) else { return }
        let date = target.description
        let after = moving(before, to: date)
        guard after != before else { return }
        items[i] = after
        sync?.enqueue(.move(id: id, date: date), snapshot: before)
    }

    /// Move to Braindump (⋯, Week and blocks PR 3): takes a dated one-off
    /// task off every day and back to the braindump, as the store's
    /// `unscheduleTask` does (DsulCore `unscheduling`): not scheduled, and no
    /// start date, part of day or time; its length, order, project, priority,
    /// notes and any pause kept. No `order` is written, so it shows in the
    /// braindump at its stored place. Behind `offers(.braindump)`, asked
    /// again here off the item as it is now: the web's gate (task-like, the
    /// type `braindumpEligible`, dated, not recurring, not in a project
    /// block, open, not a milestone, which needs the goals read), the server's
    /// (no subtask), not already a braindump row, and the server taking
    /// `unschedule`. The gate reads the row's own start date, so `day` (the
    /// sheet's) changes nothing today; it is the day the verb was drawn for.
    /// The write is the action alone; the server writes the same four
    /// columns.
    func unschedule(_ id: UUID, on day: DayString) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        let before = items[i]
        guard offers(.braindump, before, verbContext(for: before, on: day)) else { return }
        let after = unscheduling(before)
        guard after != before else { return }
        items[i] = after
        sync?.enqueue(.unschedule(id: id), snapshot: before)
    }

    /// Pause, or Pause until `until` (the exclusive resume day, yyyy-MM-dd; nil
    /// pauses with no end). See `setPaused`.
    func pause(_ id: UUID, until: String?) {
        if let until {
            guard let day = DayString(until) else { return }
            setPaused(id, paused: true, until: day.description)
        } else {
            setPaused(id, paused: true, until: nil)
        }
    }

    /// Resume: ends the pause today, keeping when it began.
    func resume(_ id: UUID) {
        setPaused(id, paused: false, until: nil)
    }

    /// The store's `setItemPaused`, as DsulCore `resolvePauseWrite` resolves
    /// it, the rule the server applies to the same request (lib/item-pause.ts).
    /// Dateless: today is brought up to the clock first, and today and the
    /// pause's stamp come off the one instant, as the server reads them, so
    /// the two can't straddle midnight. A refusal, or a request already
    /// satisfied (an empty patch), writes nothing.
    private func setPaused(_ id: UUID, paused: Bool, until: String?) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        let instant = now()
        refreshToday(now: instant)
        let before = items[i]
        guard offers(paused ? .pause : .resume, before, verbContext(for: before, on: today)) else { return }
        let zone = timeZoneID
        let result = resolvePauseWrite(current: before, paused: paused, pausedUntil: until.map { ColumnWrite.set($0) },
                                       todayStr: today.description, nowISO: toISOString(instant), timeZone: zone)
        guard case .patch(let patch) = result, !patch.isEmpty else { return }
        items[i] = pausing(before, patch: patch)
        sync?.enqueue(.pause(id: id, paused: paused, pausedUntil: until, timeZone: zone), snapshot: before)
    }

    /// The item sheet's edits (lib/item-edit.ts `editPatch`, DsulCore
    /// `editing`): the title trimmed; the notes trimmed and cleared when
    /// blank; the priority set or cleared; a habit's times a day (none reads
    /// as 1, so 1 on a habit with none writes nothing); a reminder's time,
    /// its cue words only when they changed (nil keeps the stored ones, as
    /// the server does), or off with both cleared; a part of day, a specific
    /// time and a length, only the keys that changed
    /// (`ItemSheetModel.timeCommit`), stepped as the server writes them
    /// (DsulCore `editing`, the dialog's `commitEdit`); a repeat, its three
    /// keys together (`ItemSheetModel.repeatCommit`, or a menu pick), and
    /// nothing when the item already says it; or a project, by its id and
    /// name, which also releases a task parked in its old project's block
    /// (`projectRefilePatch`), and nothing when the item is already there by
    /// folded name and id. The sheet sends only what changed, already cleaned
    /// and within its growth cap (`ItemSheetModel.commit`, `reminderCommit`).
    /// Behind `canEdit(edit, item)`: the server's list, its type gate and the
    /// body's own rules. A title that trims to nothing, or an edit that
    /// changes nothing, writes nothing.
    func edit(_ id: UUID, _ edit: ItemEdit) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        let before = items[i]
        guard canEdit(edit, before) else { return }
        let after = editing(before, edit)
        guard after != before else { return }
        items[i] = after
        sync?.enqueue(.edit(id: id, edit), snapshot: before)
    }

    /// Join or leave one routine or season (the routine and season chips, and
    /// Add property's Routine ▸ and Season ▸), at once: lib/planner-store.ts
    /// `setItemsCollected` for one item (DsulCore `settingMembership`), an add
    /// appended last as the server's is. Behind `canEdit("collect", item)`:
    /// the server's list, and DsulCore's `editAllowed` (`isCollectible`:
    /// never a subtask). A container the planner doesn't hold, and a change
    /// that changes nothing, send nothing. The write is the one membership
    /// row, never the list, and its revert puts the item back where it stood
    /// in the list (`restoreMembership`).
    func collect(_ id: UUID, kind: ContainerKind, containerId: String, member: Bool) {
        guard let current = item(id), canEdit("collect", current),
              let before = members(kind, containerId)
        else { return }
        let after = settingMembership(before, item: id, member: member)
        guard after != before else { return }
        setMembers(kind, containerId, after)
        sync?.enqueue(.collect(id: id, kind: kind, containerId: containerId, member: member),
                      before: [.member(kind, containerId: containerId, item: id):
                                .member(index: before.firstIndex(of: id))])
    }

    /// Puts one membership back as PlannerSync's rebase found the server
    /// holds it: `item` in the container's `itemIds` at `index` (clamped;
    /// last when nil, and left where it is when it is in already and no
    /// index is given), or out. A container the planner no longer holds
    /// changes nothing.
    func restoreMembership(_ kind: ContainerKind, _ containerId: String, item: UUID, member: Bool, at index: Int?) {
        guard let ids = members(kind, containerId) else { return }
        let next = settingMembership(ids, item: item, member: member, at: member ? index : nil)
        guard next != ids else { return }
        setMembers(kind, containerId, next)
        noteChanged()
    }

    /// (O12) Puts one step back as PlannerSync's rebase found the server
    /// holds it: right after the step `after` while the container still holds
    /// that step (DsulCore `placingMember`), first when `after` is nil, and
    /// otherwise at `index`, the place it held before its earliest failed
    /// move. The step goes back in when the list no longer holds it, since a
    /// move's revert is about a member. A container the planner no longer
    /// holds changes nothing.
    func restoreMembership(_ kind: ContainerKind, _ containerId: String, item: UUID, after: UUID?, at index: Int?) {
        guard let ids = members(kind, containerId) else { return }
        let next = placingMember(ids, item: item, after: after, orAt: index)
        guard next != ids else { return }
        setMembers(kind, containerId, next)
        noteChanged()
    }

    /// The `itemIds` of the routine or season `containerId` names; nil when
    /// the planner holds none.
    private func members(_ kind: ContainerKind, _ containerId: String) -> [UUID]? {
        switch kind {
        case .routine: return routines.first { $0.id == containerId }?.itemIds
        case .season: return seasons.first { $0.id == containerId }?.itemIds
        }
    }

    private func setMembers(_ kind: ContainerKind, _ containerId: String, _ ids: [UUID]) {
        switch kind {
        case .routine:
            guard let i = routines.firstIndex(where: { $0.id == containerId }) else { return }
            routines[i].itemIds = ids
        case .season:
            guard let i = seasons.firstIndex(where: { $0.id == containerId }) else { return }
            seasons[i].itemIds = ids
        }
    }

    // MARK: A routine's steps and a season's routines (O12, O13)

    /// A routine's step moved, from a drag in Edit mode or from Move up or
    /// Move down: `item` placed right after the step `after`, or first when
    /// `after` is nil, at once (lib/app-containers.ts `moveMember`, DsulCore
    /// `memberMoveResult` over the routine's own `itemIds`, the rule the route
    /// applies to the same request, so the step and the write agree). Behind
    /// the page's gate (`canWrite(kind:action:)`).
    ///
    /// A move the route would refuse is not sent: the planner's own list
    /// already says the step or its anchor has gone (another device moved or
    /// removed it since the page was drawn), and the banner says so
    /// (`changedElsewhere`), over the list as it stands. One that changes
    /// nothing writes nothing, so a step dropped back where it was is silent.
    /// The write names the one membership, never the list, so a step another
    /// device added in between keeps its place.
    func moveMember(_ routineId: String, item: UUID, after: UUID?) {
        guard canWrite(kind: .routine, action: .moveMember), let before = members(.routine, routineId) else { return }
        let intent = MembershipIntent.moveMember(item: item, after: after)
        switch memberMoveResult(before, item: item, after: after) {
        case .refused(let code, _):
            if let words = OrganizeCopy.refusal(code: code, for: intent) { show(words, isError: true) }
        case .members(let next):
            guard next != before else { return }
            setMembers(.routine, routineId, next)
            sync?.enqueue(.moveMember(routineId: routineId, item: item, after: after),
                          before: [.member(.routine, containerId: routineId, item: item):
                                    .member(index: before.firstIndex(of: item))])
        }
    }

    /// A season's routine put in ("Add a routine…") or taken out (Take out):
    /// one `season_routines` row, at once (lib/app-containers.ts
    /// `holdRoutine`, DsulCore `routineHoldResult`). Behind the page's gate
    /// (`canWrite(kind:action:)`).
    ///
    /// A routine the planner doesn't hold live is refused here as the route
    /// refuses it (409 `container_gone`), with the same words: the payload can
    /// carry a season's hold of a routine that is in the Trash, and a page
    /// never offers Take out for one it cannot find. A hold already so writes
    /// nothing. An optimistic hold appends the id; the server keeps a season's
    /// routines in no order, so a page draws them in the routines' own order.
    func holdRoutine(_ seasonId: String, routineId: String, hold: Bool) {
        guard canWrite(kind: .season, action: .holdRoutine),
              let i = seasons.firstIndex(where: { $0.id == seasonId })
        else { return }
        let before = seasons[i].routineIds
        let intent = MembershipIntent.holdRoutine(routineId: routineId, hold: hold)
        switch routineHoldResult(before, routineId: routineId, hold: hold,
                                 routineLive: routines.contains(where: { $0.id == routineId })) {
        case .refused(let code, _):
            if let words = OrganizeCopy.refusal(code: code, for: intent) { show(words, isError: true) }
        case .members(let next):
            guard next != before else { return }
            seasons[i].routineIds = next
            sync?.enqueue(.holdRoutine(seasonId: seasonId, routineId: routineId, hold: hold),
                          before: [.hold(seasonId: seasonId, routineId: routineId):
                                    .hold(held: before.contains(routineId),
                                          index: before.firstIndex(of: routineId))])
        }
    }

    /// (O13) Puts one season's hold of one routine back as PlannerSync's
    /// rebase found the server holds it: the routine in the season's
    /// `routineIds` at `index` (clamped; last when nil), or out. A season the
    /// planner no longer holds changes nothing. Whether the planner still
    /// holds the routine is not asked: the id is the season's row, and the
    /// page draws only the routines it finds.
    func restoreHold(_ seasonId: String, routineId: String, held: Bool, at index: Int?) {
        guard let i = seasons.firstIndex(where: { $0.id == seasonId }) else { return }
        let ids = seasons[i].routineIds
        let next = settingMembership(ids, item: routineId, member: held, at: held ? index : nil)
        guard next != ids else { return }
        seasons[i].routineIds = next
        noteChanged()
    }

    // MARK: Containers (O8a, O8b, O9, O10, O11)

    /// The container writes the server takes, resolved: every one for the
    /// sample, which sends nothing (`OrganizeModel.everyContainerWrite`); the
    /// last fetch's list signed in; none before the first fetch or from a
    /// server older than the route.
    var containerTakes: ContainerWrites {
        guard isLive else { return OrganizeModel.everyContainerWrite }
        return containerWrites ?? ContainerWrites()
    }

    /// Does the server take `action` on `kind`'s route? Asked by every
    /// container step, and alone by Paused's Resume, which no switch gates.
    func takes(_ action: ContainerAction, on kind: OrganizeKind) -> Bool {
        return containerTakes.takes(action, on: kind)
    }

    /// May a container's page offer `action` on `kind`? The server takes it
    /// and the kind's extension is on (`OrganizeModel.canEdit`): with
    /// Organize off no routine, season or project control shows, and with
    /// Goals off no goal control does. Paused's Resume asks `takes` alone.
    func canWrite(kind: OrganizeKind, action: ContainerAction) -> Bool {
        return OrganizeModel.canEdit(action, on: kind, takes: containerTakes, settings: settings)
    }

    /// The container `ref` names, as the planner holds it; nil when it holds
    /// none (or, for a goal, before goals were read).
    func container(_ ref: ContainerRef) -> ContainerSnapshot? {
        switch ref.kind {
        case .routine: return routines.first { $0.id == ref.id }.map(ContainerSnapshot.routine)
        case .season: return seasons.first { $0.id == ref.id }.map(ContainerSnapshot.season)
        case .goal: return goals?.first { $0.id == ref.id }.map(ContainerSnapshot.goal)
        case .project: return projectRecords.first { $0.id == ref.id }.map(ContainerSnapshot.project)
        }
    }

    /// Where `ref` stands in the planner's list of its kind.
    func containerIndex(_ ref: ContainerRef) -> Int? {
        switch ref.kind {
        case .routine: return routines.firstIndex { $0.id == ref.id }
        case .season: return seasons.firstIndex { $0.id == ref.id }
        case .goal: return goals?.firstIndex { $0.id == ref.id }
        case .project: return projectRecords.firstIndex { $0.id == ref.id }
        }
    }

    /// A routine's Pause (`until` nil) or Pause until `until`, the day it
    /// comes back; on a routine already paused, Pause until moves that day.
    /// A day no longer after today (a picker left open across midnight) is
    /// refused here, as the item sheet refuses it, with the same words.
    /// Behind the page's gate (`canWrite(kind:action:)`).
    func pauseRoutine(_ id: String, until: DayString?) {
        guard canWrite(kind: .routine, action: .pause) else { return }
        if let until {
            refreshToday()
            guard until > today else {
                show(OrganizeCopy.pauseRefused, isError: true)
                return
            }
        }
        applyContainer(ContainerRef(kind: .routine, id: id), .pause(until: until, timeZone: timeZoneID))
    }

    /// A routine's Resume: its pause ends today, keeping when it began.
    func resumeRoutine(_ id: String) {
        guard canWrite(kind: .routine, action: .pause) else { return }
        applyContainer(ContainerRef(kind: .routine, id: id), .resume(timeZone: timeZoneID))
    }

    /// A season's Status, stored exactly as picked: On is `.active`, Off
    /// `.paused`, Dates `.auto` (never `seasonStateForSwitch`, which is a
    /// switch's).
    func setSeasonState(_ id: String, _ state: SeasonState) {
        guard canWrite(kind: .season, action: .state) else { return }
        applyContainer(ContainerRef(kind: .season, id: id), .state(state))
    }

    /// Paused's Resume and its detail's "Resume now" or "Turn on now":
    /// lib/gate-toggle.ts `setGateOn(kind, id, true)`, DsulCore
    /// `gateSwitchIntent`. A paused routine resumes; a season that isn't live
    /// today gets `seasonStateForSwitch`, so a dated one keeps following its
    /// dates. Asks the server's list alone, never the switches, as the web's
    /// Paused does: it is the one way back the web keeps with Organize off.
    /// Already on, nothing is sent.
    func turnOn(_ ref: ContainerRef) {
        guard let current = container(ref) else { return }
        refreshToday()
        guard let intent = gateSwitchIntent(current, on: true, today: today, timeZone: timeZoneID) else { return }
        applyContainer(ref, intent)
    }

    /// One field write to one container, at once: lib/app-containers.ts
    /// `containerIntentPatch` (DsulCore), the rule the route applies to the
    /// same request, so the step and the write agree. Dateless, as the item
    /// pause is: today is brought up to the clock first, and today and a
    /// pause's or an achievement's stamp come off the one instant, read in
    /// the zone the server reads it in (`pauseZone`: the stored zone, else
    /// the device's, which the body carries). Behind `takes` (the callers add
    /// the switches, but for Paused). A refusal writes nothing and says why
    /// when the route has words for it (`pause_refused`); a request already
    /// satisfied writes and sends nothing. The write names the container's
    /// fields alone, never its member lists, and its revert puts back only
    /// those (`restoreContainer`).
    ///
    /// A project rename (O9) also re-files the project's items, as the route
    /// does after it renames: each item filed under it by `projectId` takes
    /// the new name (DsulCore `refiledItems`, `refiling`), at once, so Today's
    /// chips say it with no fetch. The write records them (`refiled`), each
    /// with its Before, so a failed rename puts every member's name back.
    ///
    /// A delete (O10) takes the container out of its kind's list at once,
    /// as the route takes it to the Trash, and nothing else: its items keep
    /// their fields (a project's members their name and id, so their chips
    /// still say it, the dot in the name's own colour, `projectAccent`, as on
    /// the web), and the join rows stay on the server, which
    /// is what a restore brings back. Its Before is the container whole and
    /// its place, so a failed one comes back where it stood.
    func applyContainer(_ ref: ContainerRef, _ intent: ContainerIntent) {
        guard intent.applies(to: ref.kind), takes(intent.action, on: ref.kind),
              let index = containerIndex(ref), let before = container(ref)
        else { return }
        let instant = now()
        refreshToday(now: instant)
        let zone = pauseZone(stored: settings.timezone, device: timeZoneID)
        switch containerIntentPatch(intent, on: before, now: instant, timeZone: zone, today: today.description) {
        case .refused(let code, _):
            if let words = OrganizeCopy.refusal(code: code, for: intent) { show(words, isError: true) }
        case .removed:
            removeContainer(ref)
            sync?.enqueue(.container(ref, intent, refiled: []),
                          before: [.container(ref): .container(before, index: index)])
        case .patch(let patch):
            guard !patch.isEmpty else { return }
            var befores: [PlannerSync.Subject: PlannerSync.Before] = [.container(ref): .container(before, index: index)]
            let refiled = refiledItems(intent, on: ref, items: items)
            if !refiled.isEmpty {
                let moving = Set(refiled)
                for (i, item) in items.enumerated() where moving.contains(item.id) {
                    let place = Place(of: item.id, in: items) ?? Place(index: i, after: i > 0 ? items[i - 1].id : nil)
                    befores[.item(item.id)] = .item(item, place)
                }
                items = items.map { moving.contains($0.id) ? refiling($0, by: intent, on: ref) : $0 }
            }
            replaceContainer(patch.applied(to: before))
            sync?.enqueue(.container(ref, intent, refiled: refiled), before: befores)
        }
    }

    /// One edit from a container's page (O8b, O9): behind the page's gate
    /// (`canWrite(kind:action:)`), then `applyContainer`. A project's rename
    /// onto a name another live project folds to is refused here, with the
    /// route's words (`name_taken`), as the alert's Save already refuses it:
    /// the route would answer 409, and the sample has no route to ask.
    func editContainer(_ ref: ContainerRef, _ intent: ContainerIntent) {
        guard canWrite(kind: ref.kind, action: intent.action) else { return }
        if ref.kind == .project, let name = intent.renamedTo,
           projectNameClash(name, among: projectRecords, except: ref.id) != nil {
            if let words = OrganizeCopy.refusal(code: "name_taken", for: intent) { show(words, isError: true) }
            return
        }
        applyContainer(ref, intent)
    }

    /// A routine's usual time, "HH:mm", or nil to clear it. Sends nothing
    /// when it is what is stored.
    func setUsualTime(_ id: String, _ time: String?) {
        guard let routine = routines.first(where: { $0.id == id }), routine.usualTime != time else { return }
        editContainer(ContainerRef(kind: .routine, id: id), .usualTime(time))
    }

    /// A season's Runs, both ends together. Sends nothing when that is what
    /// is stored.
    func setSeasonDates(_ id: String, startsOn: DayString?, endsOn: DayString?) {
        guard let season = seasons.first(where: { $0.id == id }),
              season.startsOn != startsOn?.description || season.endsOn != endsOn?.description
        else { return }
        editContainer(ContainerRef(kind: .season, id: id), .dates(startsOn: startsOn, endsOn: endsOn))
    }

    /// A goal's Status: Active, Achieved or Set aside. The state it already
    /// has writes nothing, so a goal achieved twice keeps its first stamp
    /// (`resolveGoalStateWrite`).
    func setGoalState(_ id: String, _ state: GoalState) {
        editContainer(ContainerRef(kind: .goal, id: id), .goalState(state))
    }

    /// A goal's window, both ends together. Sends nothing when that is what
    /// is stored.
    func setGoalWindow(_ id: String, startsOn: DayString?, targetOn: DayString?) {
        guard let goal = goals?.first(where: { $0.id == id }),
              goal.startsOn != startsOn?.description || goal.targetOn != targetOn?.description
        else { return }
        editContainer(ContainerRef(kind: .goal, id: id), .window(startsOn: startsOn, targetOn: targetOn))
    }

    /// A container's notes, or a goal's why, as typed: cleaned as the item
    /// sheet cleans notes (`cleanNotes`: trimmed, blank is none, within what
    /// one request may carry). Sends nothing when that is what is stored.
    func setNotes(_ ref: ContainerRef, _ raw: String) {
        guard let current = container(ref),
              let intent = ContainerEditModel.notesIntent(raw, kind: ref.kind,
                                                          stored: ContainerEditModel.text(of: current))
        else { return }
        editContainer(ref, intent)
    }

    /// A container's new name, as typed: cleaned as a title is (`cleanTitle`:
    /// one line, trimmed). Sends nothing when it cleans to nothing or to the
    /// name it has (`ContainerEditModel.renameIntent`).
    func rename(_ ref: ContainerRef, to raw: String) {
        guard let current = container(ref),
              let intent = ContainerEditModel.renameIntent(raw, stored: current.name)
        else { return }
        editContainer(ref, intent)
    }

    /// ⋯ → Delete… (O10), once its confirm is taken: the container to the
    /// Trash, behind the page's gate (`canWrite(kind:action:)`). Its page
    /// pops itself once it is gone (`isGone`).
    func deleteContainer(_ ref: ContainerRef) {
        editContainer(ref, .delete)
    }

    /// + → New routine, New season, New goal or New project (O11): a new
    /// container named `raw`, cleaned as a title is (`cleanTitle`, as the
    /// sheet's Create button reads it), made at once and sent to the kind's
    /// route with the phone's own id (`UUID().uuidString.lowercased()`, so
    /// the next fetch sees the same row). It is the web console's "+ New"
    /// with nothing picked (DsulCore `containerCreateRecord`): the kind's
    /// starting glyph, a goal's window opening today, no colour, no members.
    /// It goes last in its kind's list, where a new row sorts until the next
    /// fetch places it. Behind the + menu's gate (`canWrite(kind:action:)`);
    /// a goal waits for goals to be read. A project's name another live
    /// project folds to is refused here with the route's words
    /// (`name_taken`), as the sheet's Create already refuses it, and the
    /// server's 409 is the backstop for one made elsewhere meanwhile. Its
    /// Before is `.containerAbsent`, so a create that fails takes its page
    /// with it unless a later write proves it landed. Answers the new
    /// container's ref, or nil when nothing was made.
    @discardableResult
    func createContainer(_ kind: OrganizeKind, name raw: String) -> ContainerRef? {
        guard canWrite(kind: kind, action: .create),
              let name = ContainerEditModel.createdName(raw)
        else { return nil }
        if kind == .goal && goals == nil { return nil }
        refreshToday()
        guard let body = ContainerCreateBody(kind, id: UUID().uuidString.lowercased(), name: name, today: today)
        else { return nil }
        if kind == .project, projectNameClash(name, among: projectRecords) != nil {
            if let words = OrganizeCopy.refusal(code: "name_taken", for: body) { show(words, isError: true) }
            return nil
        }
        let record = containerCreateRecord(body)
        insertContainer(record, at: nil)
        sync?.enqueue(.createContainer(body), before: [.container(body.ref): .containerAbsent(created: record)])
        return body.ref
    }

    /// Puts one container back as PlannerSync's rebase found the server
    /// holds it. Nil removes it. One still here takes `snapshot`'s fields
    /// over the member lists it holds now (`withMembership(of:)`): those
    /// belong to the membership writes, and a toggle that landed must
    /// survive a failed pause. One that is gone comes back whole at `index`
    /// (clamped; last without one), its lists included, as a failed delete's
    /// revert. Changes nothing when it already matches.
    func restoreContainer(_ ref: ContainerRef, to snapshot: ContainerSnapshot?, index: Int?) {
        let live = container(ref)
        switch (snapshot, live) {
        case (nil, nil):
            return
        case (nil, .some):
            removeContainer(ref)
        case (let back?, let current?):
            let next = back.withMembership(of: current)
            guard next != current else { return }
            replaceContainer(next)
        case (let back?, nil):
            guard back.ref == ref else { return }
            insertContainer(back, at: index)
        }
        noteChanged()
    }

    /// `snapshot` in place of the container of its kind and id.
    private func replaceContainer(_ snapshot: ContainerSnapshot) {
        switch snapshot {
        case .routine(let routine):
            guard let i = routines.firstIndex(where: { $0.id == routine.id }) else { return }
            routines[i] = routine
        case .season(let season):
            guard let i = seasons.firstIndex(where: { $0.id == season.id }) else { return }
            seasons[i] = season
        case .goal(let goal):
            guard let i = goals?.firstIndex(where: { $0.id == goal.id }) else { return }
            goals?[i] = goal
        case .project(let project):
            guard let i = projectRecords.firstIndex(where: { $0.id == project.id }) else { return }
            projectRecords[i] = project
        }
    }

    /// `snapshot` back into its kind's list at `index`, clamped; last without
    /// one. A goal goes nowhere while goals are unread.
    private func insertContainer(_ snapshot: ContainerSnapshot, at index: Int?) {
        func place(_ count: Int) -> Int { min(max(index ?? count, 0), count) }
        switch snapshot {
        case .routine(let routine):
            routines.insert(routine, at: place(routines.count))
        case .season(let season):
            seasons.insert(season, at: place(seasons.count))
        case .goal(let goal):
            guard var read = goals else { return }
            read.insert(goal, at: place(read.count))
            goals = read
        case .project(let project):
            projectRecords.insert(project, at: place(projectRecords.count))
        }
    }

    private func removeContainer(_ ref: ContainerRef) {
        switch ref.kind {
        case .routine: routines.removeAll { $0.id == ref.id }
        case .season: seasons.removeAll { $0.id == ref.id }
        case .goal: goals?.removeAll { $0.id == ref.id }
        case .project: projectRecords.removeAll { $0.id == ref.id }
        }
    }

    /// Delete: takes `id` out, and, unless it is a habit, its subtasks with it
    /// (the store's `deleteTask` / `deleteHabit`, DsulCore `deleting`), as the
    /// server's `delete` does, to the Trash. The web's gate is always yes, so
    /// what refuses is the server's list. Each removed item's place goes with
    /// the write, so a delete that never lands puts them all back where they
    /// stood. An item sheet whose own item went closes; a subtask deleted from
    /// its page leaves its parent's sheet up.
    func deleteItem(_ id: UUID) {
        guard let before = item(id), offers(.delete, before, verbContext(for: before, on: today)) else { return }
        let (kept, removed) = deleting(id, from: items)
        guard !removed.isEmpty else { return }
        items = kept
        var snapshots: [PlannerSync.Subject: PlannerSync.Before] = [:]
        for placed in removed {
            snapshots[.item(placed.item.id)] = .item(placed.item, placed.place)
        }
        sync?.enqueue(.delete(id: id, removed: removed, cascades: !before.isHabit), before: snapshots)
        closeSheetIfItsItemIsGone()
    }

    /// Add a subtask: a new task under `parentID`, as the web's Subtasks
    /// section adds one (lib/planner-store.ts `addTask({ title, parentItemId })`,
    /// DsulCore `subtaskItem`), which is also the row the server's
    /// `addSubtask` inserts: a `task` whatever the parent's type, pending,
    /// unscheduled, and appended after every task-like row (`order` is
    /// `tasks.length`, which no subtask counts, so the lines of one paste share
    /// it and list in the order they were added). `title` is cleaned as new
    /// text is sent (`cleanTitle`: one line, trimmed, at most
    /// `EditLimits.newTitle` UTF-16 units). The id is made here and goes with
    /// the write, so a retry is the same row. Behind `canAddSubtask(to:)`.
    /// Returns the new subtask's id; nil when the gate refuses or the title is
    /// blank, and then nothing changes and nothing is sent. A pasted list is
    /// one call a line: each its own write, to the parent's route, in order.
    @discardableResult
    func addSubtask(_ parentID: UUID, title: String) -> UUID? {
        guard let parent = item(parentID), canAddSubtask(to: parent),
              let clean = cleanTitle(title, limit: EditLimits.newTitle)
        else { return nil }
        let id = UUID()
        let created = subtaskItem(id: id, title: clean, parent: parentID, order: DsulCore.project(items).tasks.count)
        items.append(created)
        sync?.enqueue(.addSubtask(id: id, parent: parentID, title: clean),
                      before: [.item(id): .absent(created: created)])
        return id
    }

    /// Reset streak, once the streak popover's confirm is taken: the counter
    /// to 0 and nothing else (lib/planner-store.ts `resetHabitStreak`, DsulCore
    /// `resettingStreak`), so the days already ticked stay ticked. Behind
    /// `offers(.resetStreak)`: a habit with a streak, while Streaks is on, on
    /// a server that takes it. Dateless, so asked on today. A streak already
    /// 0 is never offered, and would write nothing, as the server's
    /// `resetStreakPatch` writes nothing there.
    func resetStreak(_ id: UUID) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        let before = items[i]
        guard offers(.resetStreak, before, verbContext(for: before, on: today)) else { return }
        let after = resettingStreak(before)
        guard after != before else { return }
        items[i] = after
        sync?.enqueue(.resetStreak(id: id), snapshot: before)
    }

    /// What `item`'s type can do, and the words it lends the sheet (the
    /// title placeholder, Delete's confirm): lib/item-registry.ts
    /// `getItemTypeConfig` after `hydrateCustomTypes`, so a custom type reads
    /// with the user's own noun (`typeLabels`).
    func caps(for item: SampleItem) -> ItemCaps {
        return DsulCore.caps(item.typeName, labels: typeLabels)
    }

    /// `item`'s type noun ("Task", "Habit", or a custom type's own label),
    /// for the sheet's eyebrow and Delete's words.
    func typeLabel(for item: SampleItem) -> String {
        return DsulCore.typeLabel(item.typeName, labels: typeLabels)
    }

    /// May a subtask be added under `item`? The server's gate (DsulCore
    /// `canAddSubtask`, lib/item-edit.ts `subtaskRefusal`): its type grows
    /// subtasks and it isn't a subtask itself; and the server takes the write
    /// (`canWrite`). The sheet's "Add a subtask" row shows only then.
    func canAddSubtask(to item: SampleItem) -> Bool {
        return DsulCore.canAddSubtask(under: item, caps: caps(for: item)) && canWrite("addSubtask")
    }

    /// Does `item`'s sheet show the streak chip? Its type keeps a streak
    /// (`streakCounter`) and Streaks is on (`settings.streaksEnabled`): off,
    /// the web hides the streak everywhere. Today's rows read
    /// `settings.streaksEnabled` themselves, since a row already asks
    /// `isHabit`.
    func showsStreak(for item: SampleItem) -> Bool {
        return caps(for: item).streakCounter && settings.streaksEnabled
    }

    /// `id`'s subtasks, in stored order: the items whose `parentItemId` is
    /// its id (Postgres writes uuids lowercase). DsulCore `project` keeps them
    /// off every day and the braindump; they show only in their parent's sheet.
    func subtasks(of id: UUID) -> [SampleItem] {
        let parent = id.uuidString.lowercased()
        return items.filter { $0.parentItemId?.lowercased() == parent }
    }

    /// The routines holding `id`, by name, in the routines' own order
    /// (DsulCore `routinesForItem`).
    func routineNames(for id: UUID) -> [String] {
        return routinesForItem(id, routines: routines).map(\.name)
    }

    /// The seasons holding `id` directly, by name (DsulCore `seasonsForItem`).
    func seasonNames(for id: UUID) -> [String] {
        return seasonsForItem(id, seasons: seasons).map(\.name)
    }

    /// Reschedule's "Next week": the first day of the week after today's, by
    /// the user's Week starts on (item-context-menu.tsx: `weekStartOf(today,
    /// weekStartDay) + 7`).
    var nextWeekStart: DayString {
        return weekStartOf(today, settings.weekStartDay).adding(days: 7)
    }

    /// An item sheet whose item is gone (a fetch without it, a capture undone,
    /// a delete) closes: there is nothing left to show or act on.
    private func closeSheetIfItsItemIsGone() {
        if case .item(let id, _)? = activeSheet, item(id) == nil {
            activeSheet = nil
        }
    }

    // MARK: List layout

    func passes(_ item: SampleItem, _ filter: ListFilter) -> Bool {
        switch filter {
        case .all: true
        case .tasks: !item.isHabit
        case .habits: item.isHabit
        case .project(let name): Self.sameProject(item.project, name)
        }
    }

    /// The project kind folds case (lib/container-registry.ts `caseFold`):
    /// "Work" and "work" are one container.
    nonisolated private static func sameProject(_ itemProject: String?, _ name: String) -> Bool {
        guard let itemProject else { return false }
        return itemProject.lowercased() == name.lowercased()
    }

    /// The rows among `rows` that `filter` passes. Over a week's rows a daily
    /// habit counts seven, as the rows under the chips show it (design W16).
    func count(_ filter: ListFilter, in rows: [SampleItem]) -> Int {
        return rows.filter { passes($0, filter) }.count
    }

    /// The rows `filter` passes on `days`, each day's counted.
    func count(_ filter: ListFilter, on days: [DayString]) -> Int {
        return count(filter, in: days.flatMap { dayItems(on: $0) })
    }

    /// The rows `filter` passes on the selected day (`count(_:on:)`).
    func count(_ filter: ListFilter) -> Int {
        return count(filter, on: [selectedDay])
    }

    /// The projects something among `rows` is filed under, in container
    /// order, for the chips.
    func chipProjects(in rows: [SampleItem]) -> [String] {
        let present = Set(rows.compactMap { $0.project?.lowercased() })
        return projects.filter { present.contains($0.lowercased()) }
    }

    /// The projects with something on any of `days`.
    func dayProjects(on days: [DayString]) -> [String] {
        return chipProjects(in: days.flatMap { dayItems(on: $0) })
    }

    /// The projects with something on the selected day (`dayProjects(on:)`).
    var dayProjects: [String] {
        return dayProjects(on: [selectedDay])
    }

    /// The List layout on `day`: routines first (DsulCore `routineGroups`, the
    /// port of lib/grouping.ts: one row, one group, in the routine's own
    /// order), then one section per project, then the loose items. A routine's
    /// done count is at `day`. Week draws one day's worth per section, as the
    /// web groups each day of a week on its own (week-list.tsx).
    func listSections(_ filter: ListFilter, on day: DayString) -> [ListSection] {
        return listSections(filter, rows: dayItems(on: day), on: day)
    }

    /// `listSections(_:on:)` over `day`'s rows already derived (`weekRows`).
    func listSections(_ filter: ListFilter, rows dayRows: [SampleItem], on day: DayString) -> [ListSection] {
        let rows = sortedForList(dayRows.filter { passes($0, filter) })
        let grouped = routineGroups(rows, routines: routines)
        var sections: [ListSection] = []
        for (routine, members) in grouped.groups {
            sections.append(section(id: "routine:\(routine.id)", title: routine.name, kind: .routine,
                                    items: members, on: day))
        }
        let rest = grouped.loose
        for name in projects {
            let members = rest.filter { Self.sameProject($0.project, name) }
            guard !members.isEmpty else { continue }
            sections.append(section(id: "project:\(name)", title: name, kind: .project, items: members, on: day))
        }
        let known = Set(projects.map { $0.lowercased() })
        let loose = rest.filter { item in item.project.map { !known.contains($0.lowercased()) } ?? true }
        if !loose.isEmpty {
            sections.append(section(id: "loose", title: ContainerWords.noProject, kind: .loose, items: loose,
                                    on: day))
        }
        return sections
    }

    /// The List layout on the selected day (`listSections(_:on:)`).
    func listSections(_ filter: ListFilter) -> [ListSection] {
        return listSections(filter, on: selectedDay)
    }

    private func section(id: String, title: String, kind: ListSection.Kind, items: [SampleItem],
                         on day: DayString) -> ListSection {
        return ListSection(id: id, title: title, kind: kind, items: items,
                           doneCount: items.filter { isDone($0, on: day) }.count)
    }

    /// Timed rows first by time, then untimed by order (lib/day-items.ts
    /// `byTimeThenOrder`, through DsulCore).
    private func sortedForList(_ rows: [SampleItem]) -> [SampleItem] {
        let byID = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return sortedByTimeThenOrder(rows.map(Self.bucketRow)).compactMap { byID[$0.id] }
    }

    // MARK: Buckets layout

    /// `day` filed by bucket, each bucket in the web's row order (DsulCore
    /// `bucketDayRows`).
    func buckets(on day: DayString) -> [DayBucket: [SampleItem]] {
        return buckets(dayItems(on: day))
    }

    /// One day's rows (in `dayItems` order) filed by bucket.
    func buckets(_ rows: [SampleItem]) -> [DayBucket: [SampleItem]] {
        let byID = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let ids = bucketDayRows(rows.map(Self.bucketRow))
        var out: [DayBucket: [SampleItem]] = [:]
        for (bucket, list) in ids {
            out[bucket] = list.compactMap { byID[$0] }
        }
        return out
    }

    /// The selected day filed by bucket (`buckets(on:)`).
    func buckets() -> [DayBucket: [SampleItem]] {
        return buckets(on: selectedDay)
    }

    nonisolated private static func bucketRow(_ item: SampleItem) -> BucketRow<UUID> {
        BucketRow(id: item.id, isHabit: item.isHabit, bucket: item.bucket, startMin: item.startMin,
                  order: item.order ?? 0)
    }

    // MARK: Schedule layout and the braindump

    /// `day`'s blocks (day-schedule.tsx `deriveTimedEntries`): timed rows,
    /// plus tasks in a project's recurring block. Each comes back with the
    /// time and length it is DRAWN at, which for a project-block task is the
    /// block's; `item(_:)` still answers with the stored item.
    func scheduled(on day: DayString) -> [SampleItem] {
        return drawnTimedEntries(derive(on: day)).map(\.item)
    }

    /// The selected day's blocks (`scheduled(on:)`).
    var scheduled: [SampleItem] {
        return scheduled(on: selectedDay)
    }

    /// `day`'s rows off the hour grid (day-schedule.tsx `deriveUntimedRows`,
    /// through DsulCore): untimed habits, then untimed tasks not in a project
    /// block. A project-block task whose block is not on `day` is in neither
    /// this nor `scheduled(on:)`, as on the web; List and Buckets still show
    /// it. Day's Schedule draws it in the Anytime band (`daySchedule(on:)`,
    /// ScheduleLayout.swift, from the same derive as the blocks).
    func anytime(on day: DayString) -> [SampleItem] {
        return deriveUntimedRows(derive(on: day))
    }

    /// What's captured and not yet placed (DsulCore `braindumpMembers`), in
    /// stored order. Paused rows are held back as of TODAY, not the selected
    /// day: the braindump has no date of its own.
    var braindump: [SampleItem] {
        let split = DsulCore.project(items)
        let suppressed = inactiveItemIdsOn(items: items, date: today, timeZone: timeZoneID,
                                           routines: routines, seasons: seasons, away: awayPeriods)
        return braindumpMembers(tasks: split.tasks, habits: split.habits, suppressed: suppressed)
    }

    func item(_ id: UUID?) -> SampleItem? {
        guard let id else { return nil }
        return items.first { $0.id == id }
    }

    func isScheduled(_ id: UUID?) -> Bool {
        scheduled.contains { $0.id == id }
    }

    /// Fills the selected day to 40 blocks, for the spike's "no hitches on a
    /// busy day" test. Sample only: these ids exist nowhere on the server.
    /// Fresh ids each time: a fixed run would repeat across days.
    func stress() {
        guard !isLive else { return }
        var count = scheduled.count
        while count < 40 {
            let start = (count * 35) % (23 * 60)
            items.append(Item(id: UUID(), type: "task", title: "Block \(count + 1)", status: "pending",
                              startDate: selectedDayString, startTime: minutesToTime(start),
                              timeBucket: DayBucket.owning(minute: start).rawValue,
                              duration: [15, 30, 45][count % 3], isScheduled: true))
            count += 1
        }
    }

    // MARK: The server (signed in only)

    /// Fetches now: sign-in and pull to refresh. The sample has nothing to fetch.
    func refresh() async {
        guard let sync else { return }
        await sync.refresh()
    }

    /// Returning to the app: fetches unless the last fetch is under a minute old.
    func refreshIfStale() {
        sync?.refreshIfStale()
    }

    /// Sign-out or an account switch: nothing queued is sent, nothing in
    /// flight lands, and a drag's hold from the view tree going away can't
    /// hold back the next planner's first fetch.
    func stopSync() {
        sync?.stop()
        DragHold.shared.releaseNow()
    }

    /// A fetched planner replaces what is held. PlannerSync calls this only
    /// when no write and no drag could be undone by it.
    func apply(_ payload: PlannerPayload) {
        let zoneChanged = Self.storedZone(payload.settings.timezone) != Self.storedZone(settings.timezone)
        items = payload.items
        projectRecords = payload.projects
        routines = payload.routines
        seasons = payload.seasons
        goals = payload.goals
        awayPeriods = payload.trips
        settings = payload.settings
        snoozes = payload.snoozes ?? []
        writes = payload.writes
        trashWrites = payload.trashWrites
        containerWrites = payload.containerWrites
        typeLabels = Dictionary((payload.itemTypes ?? []).map { ($0.name, $0) },
                                uniquingKeysWith: { first, _ in first })
        itemTypes = payload.itemTypes
        hasLoaded = true
        loadError = nil
        if zoneChanged { refreshToday() }
        closeSheetIfItsItemIsGone()
        noteChanged(fetched: true)
    }

    /// Says the notification plan's inputs may have moved (`onChange`).
    func noteChanged(fetched: Bool = false) {
        onChange?(fetched)
    }

    // MARK: The Trash (O14, signed in only)

    /// Organize's Trash row shows: signed in, against a server that takes
    /// both routes (`TrashRoutes.offered`). The sample has no server bin.
    var offersTrash: Bool {
        return sync != nil && TrashRoutes.offered(trashWrites)
    }

    /// The bin, for the Trash page, which holds the rows itself (they never
    /// enter this planner). Throws `signedOut` for the sample.
    func fetchTrash() async throws -> TrashList {
        guard let sync else { throw APIError.signedOut }
        return try await sync.fetchTrash()
    }

    /// Restores `row` (PlannerSync's `restoreFromTrash`). Answers whether the
    /// page lets the row go: true once it is back (a fetch is already on its
    /// way), and true for a 404, which says in the banner that it is no
    /// longer in the Trash, since no retry can land. Any other refusal, or no
    /// answer, shows its sentence in the banner and answers false, keeping
    /// the row.
    func restoreFromTrash(_ row: TrashRow) async -> Bool {
        guard let sync else { return false }
        switch await sync.restoreFromTrash(row) {
        case .restored:
            return true
        case .gone(let sentence):
            show(sentence, isError: true)
            return true
        case .refused(let sentence):
            show(sentence, isError: true)
            return false
        case .unsent:
            return false
        }
    }

    // MARK: Notification buttons (signed in only)

    /// A notification's Done, on `dateStr`: ticks the item there if it still
    /// wants doing (`notificationDoneIntent`), through the same optimistic
    /// step and write as a row's tick. Answers false, sending nothing, when
    /// there is nothing to do: no sync, no such item, or already done,
    /// skipped or paused there. `settled` hears how a sent write ended.
    func notificationDone(_ id: UUID, on dateStr: String, timeZone: String,
                          settled: @escaping @MainActor (PlannerSync.Settled) -> Void) -> Bool {
        guard let sync, let day = DayString(dateStr), let i = items.firstIndex(where: { $0.id == id }) else {
            return false
        }
        let before = items[i]
        let ctx = ActivationContext(timeZone: timeZone, routines: routines, seasons: seasons, away: awayPeriods)
        guard let intent = notificationDoneIntent(before, on: day, ctx) else { return false }
        items[i] = applying(intent, to: before, on: day)
        sync.enqueue(.complete(id: id, date: dateStr, done: intent.done, count: intent.count), snapshot: before,
                     settled: settled)
        return true
    }

    /// A notification's Snooze: the `snooze` write, which changes nothing
    /// here. False, sending nothing, with no sync or no such item.
    func notificationSnooze(_ id: UUID, on dateStr: String, minutes: Int, timeZone: String,
                            settled: @escaping @MainActor (PlannerSync.Settled) -> Void) -> Bool {
        guard let sync, item(id) != nil else { return false }
        sync.enqueue(.snooze(id: id, date: dateStr, minutes: minutes, timeZone: timeZone), before: [:],
                     settled: settled)
        return true
    }

    /// Puts one subject back as PlannerSync's rebase found the server holds
    /// it: the item before the earliest write the server never took, with
    /// every write it took since played on it. The whole item is replaced
    /// where it stands; nil removes it (a capture that never landed, or a
    /// delete that did). One that is gone (a delete that never landed) comes
    /// back at `place`, through DsulCore `reinserting`: after the item it
    /// followed when that is here, else at its index; at the end without one.
    /// A membership comes back through `restoreMembership` instead, a
    /// season's hold of a routine through `restoreHold`, and a container's
    /// fields through `restoreContainer`, so none of the three does anything
    /// here.
    func restore(_ subject: PlannerSync.Subject, to item: SampleItem?, place: Place?) {
        switch subject {
        case .item(let id):
            if let item {
                let at = place ?? Place(index: items.count, after: nil)
                items = reinserting([PlacedItem(place: at, item: item)], into: items)
            } else {
                items.removeAll { $0.id == id }
            }
        case .member, .hold, .container:
            return
        }
        closeSheetIfItsItemIsGone()
        noteChanged()
    }

    /// The first fetch failed: what the empty state says, with a retry.
    func noteLoadFailure(_ message: String) {
        if !hasLoaded { loadError = message }
    }

    /// A fetch went out: before the first one lands, the empty state goes
    /// back to the spinner (a retry shows it is trying, not the old error).
    func noteLoadStarted() {
        if !hasLoaded { loadError = nil }
    }

    /// Shows `text` over Today (or over an item's sheet, while one is up) for
    /// five seconds, or until a newer one. VoiceOver says it too: the banner
    /// is drawn where focus isn't, and a refused write is otherwise only a
    /// slot's label quietly turning back. Said here, once, rather than by
    /// `BannerView`, which more than one view draws. An error interrupts
    /// whatever is being said, such as that slot's new label. The same words
    /// of the same kind over a banner still up replace it, so its five seconds
    /// start again, but aren't said again (`speaks`).
    func show(_ text: String, isError: Bool) {
        let aloud = Self.speaks(text, isError: isError, over: banner)
        let shown = PlannerBanner(text, isError: isError)
        banner = shown
        if aloud {
            var spoken = AttributedString(text)
            if isError { spoken.accessibilitySpeechAnnouncementPriority = .high }
            AccessibilityNotification.Announcement(spoken).post()
        }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            self?.dismissBanner(shown.id)
        }
    }

    /// Does a banner of `text` say itself aloud over `shown`, the one up now?
    /// Not when `shown` already says it, as the same kind: a paste of N lines
    /// sent offline fails N times, each with "Couldn't reach dsul. Checking
    /// what was saved…", and N high-priority announcements would each cut off
    /// the one before. Ticks that fail one after another are said once too.
    nonisolated static func speaks(_ text: String, isError: Bool, over shown: PlannerBanner?) -> Bool {
        guard let shown else { return true }
        return shown.text != text || shown.isError != isError
    }

    func dismissBanner(_ id: UUID) {
        if banner?.id == id { banner = nil }
    }
}

extension DayString {
    /// The calendar day `date` falls on in `calendar` (the device's by default).
    init(date: Date, calendar: Calendar = .current) {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        self = DayString(year: c.year ?? 2026, month: c.month ?? 1, day: c.day ?? 1)!
    }

    /// Local midnight of this day, for formatting and the date picker.
    func localDate(calendar: Calendar = .current) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day)) ?? Date()
    }
}
