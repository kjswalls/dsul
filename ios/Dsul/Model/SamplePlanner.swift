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
enum PlannerSheet: String, Identifiable, Hashable, Sendable {
    case capture, datePicker

    var id: String { rawValue }
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
/// lib/grouping.ts), and a tick is lib/item-toggle.ts, so the phone and the web
/// agree on the same data. Every change here is optimistic and immediate; when
/// signed in, `sync` then sends it to the server (PlannerSync).
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
    private(set) var seasons: [Season]
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
    /// Sends this planner's writes and fetches its data. Nil for the sample,
    /// whose changes last until the app quits.
    @ObservationIgnored private(set) var sync: PlannerSync? = nil

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

    convenience init(todayString: String) {
        self.init(today: DayString(todayString))
    }

    /// The sample planner (SampleData), on `today` or the device's day.
    init(today: DayString? = nil) {
        let anchor: DayString = today ?? DayString.deviceToday
        let sample = SampleData.make(today: anchor)
        self.today = anchor
        selectedDay = anchor
        items = sample.items
        projectRecords = sample.projects
        routines = sample.routines
        seasons = []
        settings = PlannerSettings()
        hasLoaded = true
        userId = nil
    }

    /// The signed-in user's planner: empty until the first fetch lands. Its
    /// day is the device's until the user's stored timezone arrives with it.
    /// `isDragging` holds fetched data back while a braindump row is in the
    /// air (ScheduleDrag's `DragHold`).
    init(userId: UUID, api: APIClient, isDragging: @escaping @MainActor () -> Bool, todayString: String? = nil) {
        let anchor: DayString = todayString.flatMap { DayString($0) } ?? DayString.deviceToday
        self.today = anchor
        selectedDay = anchor
        items = []
        projectRecords = []
        routines = []
        seasons = []
        settings = PlannerSettings()
        hasLoaded = false
        self.userId = userId
        sync = PlannerSync(planner: self, api: api, userId: userId, isDragging: isDragging)
    }

    nonisolated static func uuid(_ n: Int) -> UUID {
        return SampleData.uuid(n)
    }

    /// Signed in, so writes go to the server and the sample-only switches
    /// (the 40 blocks) are off.
    var isLive: Bool { userId != nil }

    /// The project names, in container order: the chips, the sections, Organize.
    var projects: [String] { projectRecords.map(\.name) }

    // MARK: Days

    var isOnToday: Bool { selectedDay == today }
    var selectedDayString: String { selectedDay.description }

    func select(_ day: DayString) { selectedDay = day }
    func shiftDay(by days: Int) { selectedDay = selectedDay.adding(days: days) }
    func goToToday() { selectedDay = today }

    /// The zone every day here is read in: the stored one, trimmed, when this
    /// device knows it (`timezone?.trim() || device`, as the web's store and
    /// components/supabase-provider.tsx resolve it); the device's otherwise.
    var timeZoneID: String {
        return Self.storedZone(settings.timezone) ?? TimeZone.current.identifier
    }

    nonisolated private static func storedZone(_ raw: String?) -> String? {
        guard let id = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty,
              TimeZone(identifier: id) != nil
        else { return nil }
        return id
    }

    /// Moves `today` to the user's day now: in their stored zone when there is
    /// one, else in `calendar` (the device's). See `refreshToday(to:)`.
    func refreshToday(now: Date = Date(), calendar: Calendar = .current) {
        if let zone = Self.storedZone(settings.timezone), let day = toDateStr(now, timeZone: zone) {
            refreshToday(to: day)
        } else {
            refreshToday(to: DayString(date: now, calendar: calendar))
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
    private func derive(on date: DayString) -> DayItems {
        let zone = timeZoneID
        let split = DsulCore.project(items)
        let inactive = inactiveItemIdsOn(items: items, date: date, timeZone: zone, routines: routines, seasons: seasons)
        return deriveDayItems(tasks: split.tasks, habits: split.habits, projects: projectRecords, date: date,
                              timeZone: zone, showCompletedTasks: settings.showCompletedTasks, inactive: inactive)
    }

    /// The selected day's items: habits, then tasks, each in bucket and time
    /// order (lib/day-items.ts `flattenDayRows`).
    var dayItems: [SampleItem] {
        return flattenDayRows(derive(on: selectedDay))
    }

    /// Ticked on the selected day (lib/item-toggle.ts `isRowDone`): a habit
    /// or a recurring task by its date, a one-off task by its status.
    func isDone(_ item: SampleItem) -> Bool {
        return isRowDone(item, on: selectedDay)
    }

    /// Skipped on the selected day: drawn as a strip, and a tick on it is
    /// refused (`toggle`).
    func isSkipped(_ item: SampleItem) -> Bool {
        return isRowSkipped(item, on: selectedDay)
    }

    // MARK: Writes

    /// Ticks or unticks an item on the selected day, as the web's
    /// `toggleRowDone` does (DsulCore `tickIntent`, then `applying` for the
    /// optimistic step): a habit's streak moves by one, a counted habit steps
    /// its tally, a recurring task flips its date, a one-off its status. A
    /// skipped occurrence is refused and nothing is sent.
    func toggle(_ id: UUID) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        let before = items[i]
        guard let intent = tickIntent(before, on: selectedDay) else { return }
        items[i] = applying(intent, to: before, on: selectedDay)
        sync?.enqueue(.complete(id: id, date: selectedDayString, done: intent.done, count: intent.count),
                      snapshot: before)
    }

    /// Puts an item on the selected day's grid at `startMin`: a braindump row
    /// dropped on an hour (or VoiceOver's "Schedule at 9:00"), or a block
    /// moved. The web's hour drop (lib/dnd/handle-drag-end.ts → `scheduleTask`):
    /// scheduled, the hour's bucket, the time, out of any project block, and
    /// anchored to the day it was dropped on. Also ends the drag's hold on
    /// fetched data: the drop has landed.
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
        var placed = before
        placed.isScheduled = true
        placed.timeBucket = DayBucket.owning(minute: startMin).rawValue
        placed.startTime = time
        placed.inProjectBlock = false
        placed.startDate = selectedDayString
        items[i] = placed
        sync?.enqueue(.schedule(id: id, date: selectedDayString, startTime: time), snapshot: before)
    }

    /// Captures a thought into the braindump, as the web's `addTask` with no
    /// bucket: a pending, undated, unscheduled task appended after every
    /// task-like row (`order = tasks.length`). The id is made here, so a retry
    /// of the same capture is the same row on the server.
    func capture(_ title: String) {
        var trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // The route takes at most 500 UTF-16 units, JavaScript's string length.
        while trimmed.utf16.count > 500 { trimmed.removeLast() }
        let id = UUID()
        let order = DsulCore.project(items).tasks.count
        items.append(Item(id: id, type: "task", title: trimmed, status: "pending", order: order, isScheduled: false))
        sync?.enqueue(.capture(id: id, title: trimmed), snapshot: nil)
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

    func count(_ filter: ListFilter) -> Int {
        dayItems.filter { passes($0, filter) }.count
    }

    /// The projects with something on the selected day, for the chips.
    var dayProjects: [String] {
        let present = Set(dayItems.compactMap { $0.project?.lowercased() })
        return projects.filter { present.contains($0.lowercased()) }
    }

    /// The List layout: routines first (DsulCore `routineGroups`, the port of
    /// lib/grouping.ts: one row, one group, in the routine's own order), then
    /// one section per project, then the loose items.
    func listSections(_ filter: ListFilter) -> [ListSection] {
        let rows = sortedForList(dayItems.filter { passes($0, filter) })
        let grouped = routineGroups(rows, routines: routines)
        var sections: [ListSection] = []
        for (routine, members) in grouped.groups {
            sections.append(section(id: "routine:\(routine.id)", title: routine.name, kind: .routine,
                                    items: members))
        }
        let rest = grouped.loose
        for name in projects {
            let members = rest.filter { Self.sameProject($0.project, name) }
            guard !members.isEmpty else { continue }
            sections.append(section(id: "project:\(name)", title: name, kind: .project, items: members))
        }
        let known = Set(projects.map { $0.lowercased() })
        let loose = rest.filter { item in item.project.map { !known.contains($0.lowercased()) } ?? true }
        if !loose.isEmpty {
            sections.append(section(id: "loose", title: "No project", kind: .loose, items: loose))
        }
        return sections
    }

    private func section(id: String, title: String, kind: ListSection.Kind, items: [SampleItem]) -> ListSection {
        return ListSection(id: id, title: title, kind: kind, items: items,
                           doneCount: items.filter { isDone($0) }.count)
    }

    /// Timed rows first by time, then untimed by order (lib/day-items.ts
    /// `byTimeThenOrder`, through DsulCore).
    private func sortedForList(_ rows: [SampleItem]) -> [SampleItem] {
        let byID = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return sortedByTimeThenOrder(rows.map(Self.bucketRow)).compactMap { byID[$0.id] }
    }

    // MARK: Buckets layout

    /// The selected day filed by bucket, each bucket in the web's row order
    /// (DsulCore `bucketDayRows`).
    func buckets() -> [DayBucket: [SampleItem]] {
        let day = dayItems
        let byID = Dictionary(day.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let ids = bucketDayRows(day.map(Self.bucketRow))
        var out: [DayBucket: [SampleItem]] = [:]
        for (bucket, list) in ids {
            out[bucket] = list.compactMap { byID[$0] }
        }
        return out
    }

    nonisolated private static func bucketRow(_ item: SampleItem) -> BucketRow<UUID> {
        BucketRow(id: item.id, isHabit: item.isHabit, bucket: item.bucket, startMin: item.startMin,
                  order: item.order ?? 0)
    }

    // MARK: Schedule layout and the braindump

    /// The selected day's blocks (day-schedule.tsx `deriveTimedEntries`):
    /// timed rows, plus tasks in a project's recurring block. Each comes back
    /// with the time and length it is DRAWN at, which for a project-block task
    /// is the block's; `item(_:)` still answers with the stored item.
    var scheduled: [SampleItem] {
        var seen = Set<UUID>()
        var blocks: [SampleItem] = []
        for entry in deriveTimedEntries(derive(on: selectedDay)) {
            guard seen.insert(entry.item.id).inserted else { continue }
            var block = entry.item
            block.startTime = minutesToTime(entry.startMin)
            block.duration = entry.duration
            blocks.append(block)
        }
        return blocks
    }

    /// What's captured and not yet placed (DsulCore `braindumpMembers`), in
    /// stored order. Paused rows are held back as of TODAY, not the selected
    /// day: the braindump has no date of its own.
    var braindump: [SampleItem] {
        let split = DsulCore.project(items)
        let suppressed = inactiveItemIdsOn(items: items, date: today, timeZone: timeZoneID,
                                           routines: routines, seasons: seasons)
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
        settings = payload.settings
        hasLoaded = true
        loadError = nil
        if zoneChanged { refreshToday() }
    }

    /// Puts an item back as it was before a write the server never took. Nil
    /// removes it: a capture that never landed.
    func restore(_ id: UUID, to snapshot: SampleItem?) {
        if let snapshot {
            if let i = items.firstIndex(where: { $0.id == id }) {
                items[i] = snapshot
            } else {
                items.append(snapshot)
            }
        } else {
            items.removeAll { $0.id == id }
        }
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

    /// Shows `text` over Today for five seconds, or until a newer one.
    func show(_ text: String, isError: Bool) {
        let shown = PlannerBanner(text, isError: isError)
        banner = shown
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            self?.dismissBanner(shown.id)
        }
    }

    func dismissBanner(_ id: UUID) {
        if banner?.id == id { banner = nil }
    }
}

extension DayString {
    /// The device's calendar day now.
    static var deviceToday: DayString {
        DayString(date: Date())
    }

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
