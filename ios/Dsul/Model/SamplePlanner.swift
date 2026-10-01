import DsulCore
import Foundation
import Observation

/// Tasks and habits, the two shipped item types. lib/item-registry.ts is the
/// web's answer to what each can do; the phone only needs the split for now.
enum ItemKind: String, Sendable, Hashable {
    case task, habit
}

/// A stand-in for a planner item until the app talks to the server.
/// Field names follow the web's `Item` where there is one.
struct SampleItem: Identifiable, Hashable, Sendable {
    let id: UUID
    var title: String
    var durationMin: Int
    var startMin: Int?
    var project: String?
    var kind: ItemKind = .task
    /// A task's day. nil is the braindump: captured, not yet placed.
    var day: DayString?
    /// A habit's repeat; `shouldShowOnDate` decides its days.
    var repeatRule: RepeatRule?
    /// A habit's completion, per date. Never a scalar status (CLAUDE.md).
    var completedDates: [String] = []
    /// A task's completion.
    var done = false
    /// A habit's stored streak: +1/-1 on a toggle, never recomputed.
    var streak = 0
    var routine: String?
    var bucket: DayBucket?
    /// The web's `order`, for untimed tasks.
    var order = 0

    var isHabit: Bool { kind == .habit }
}

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

/// Sample data for the shell, the layouts and the drag spike. No network,
/// no persistence: toggles and drops live until the app quits.
@Observable @MainActor
final class SamplePlanner {
    /// Every item, braindump included. New captures go to the front.
    var items: [SampleItem]
    /// The projects, in the order the chips and sections show them.
    let projects: [String]
    /// The device's day. Moves at midnight and on returning to the app
    /// (`refreshToday`), never from a view's body.
    private(set) var today: DayString
    var selectedDay: DayString
    var showBraindumpSheet = false
    /// The one sheet up besides the braindump, if any. The single source of
    /// truth: the two hosts below read it, and a dismissal clears it.
    var activeSheet: PlannerSheet?

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

    init(today: DayString? = nil) {
        let anchor: DayString = today ?? DayString.deviceToday
        self.today = anchor
        selectedDay = anchor
        projects = ["Work", "Home", "Writing", "dsul", "Health"]

        var n = 0
        func next() -> UUID {
            n += 1
            return SamplePlanner.uuid(n)
        }
        func task(_ title: String, _ duration: Int, at start: Int? = nil, _ project: String? = nil,
                  bucket: DayBucket? = nil, order: Int = 0) -> SampleItem {
            var filed: DayBucket = .anytime
            if let start { filed = DayBucket.owning(minute: start) }
            if let bucket { filed = bucket }
            return SampleItem(id: next(), title: title, durationMin: duration, startMin: start, project: project,
                              kind: .task, day: anchor, bucket: filed, order: order)
        }
        func habit(_ title: String, _ rule: RepeatRule, streak: Int, doneDaysAgo: [Int],
                   routine: String? = nil, _ project: String? = nil, bucket: DayBucket) -> SampleItem {
            SampleItem(id: next(), title: title, durationMin: 15, project: project, kind: .habit,
                       repeatRule: rule,
                       completedDates: doneDaysAgo.map { anchor.adding(days: -$0).description },
                       streak: streak, routine: routine, bucket: bucket)
        }

        // The day's blocks first: the drag spike's tests read scheduled[0].
        let blocks = [
            task("Morning pages", 30, at: 7 * 60, "Writing"),
            task("Draft Q4 roadmap", 120, at: 9 * 60, "Work"),
            task("Standup", 15, at: 11 * 60 + 15, "Work"),
            task("Lunch walk", 45, at: 12 * 60 + 30),
            task("Review PRs", 60, at: 13 * 60 + 30, "dsul"),
            task("Call the dentist", 15, at: 15 * 60, "Home"),
            task("Gym", 60, at: 17 * 60 + 30, "Health"),
            task("Cook dinner", 45, at: 19 * 60, "Home"),
            task("Read", 30, at: 21 * 60 + 30),
        ]
        let untimed = [
            task("Reply to Avery about pricing", 15, "Work", order: 1),
            task("Review design PR", 30, "Work", order: 2),
            task("Groceries", 45, "Home", order: 3),
        ]
        let daily = RepeatRule(frequency: "daily")
        let habits = [
            habit("Meds", daily, streak: 41, doneDaysAgo: [0, 1, 2], routine: "Morning routine", bucket: .morning),
            habit("Stretch 10 min", daily, streak: 12, doneDaysAgo: [0, 1], routine: "Morning routine", bucket: .morning),
            habit("Journal", daily, streak: 3, doneDaysAgo: [1, 2, 3], routine: "Morning routine", bucket: .morning),
            habit("Plan tomorrow", RepeatRule(frequency: "weekdays"), streak: 6, doneDaysAgo: [1], bucket: .evening),
            habit("Water the plants", RepeatRule(frequency: "custom", days: [0, 3]), streak: 2, doneDaysAgo: [],
                  "Home", bucket: .anytime),
        ]

        let durations = [15, 30, 45, 60, 90]
        let thoughts = [
            "Call the bank", "Renew passport", "Draft the launch post", "Fix the bike light",
            "Plan the weekend", "Email Sam back", "Sort the photo backlog", "Buy coffee beans",
            "Try the new pasta recipe", "Back up the laptop", "Book a haircut", "Repot the fern",
            "Outline the iOS onboarding", "Cancel the unused subscription", "Write a thank-you card",
            "Look into a standing desk", "Clean the inbox", "Pick up the parcel", "Stretch for 10 minutes",
            "Update the budget sheet", "Call Mum", "Return the library books", "Order printer ink",
            "Read the Swift drag docs", "Sketch the Organize page", "Charge the camera",
            "Fix the squeaky door", "Pay the electricity bill", "Plan Friday dinner", "Tidy the desk",
        ]
        let braindump = thoughts.enumerated().map { i, t in
            SampleItem(id: next(), title: t, durationMin: durations[i % durations.count])
        }
        items = blocks + untimed + habits + braindump
    }

    nonisolated static func uuid(_ n: Int) -> UUID {
        UUID(uuidString: String(format: "00000000-0000-0000-0000-%012d", n))!
    }

    // MARK: Days

    var isOnToday: Bool { selectedDay == today }
    var selectedDayString: String { selectedDay.description }

    func select(_ day: DayString) { selectedDay = day }
    func shiftDay(by days: Int) { selectedDay = selectedDay.adding(days: days) }
    func goToToday() { selectedDay = today }

    /// Moves `today` to the device's day now. See `refreshToday(to:)`.
    func refreshToday(now: Date = Date(), calendar: Calendar = .current) {
        refreshToday(to: DayString(date: now, calendar: calendar))
    }

    /// Moves `today` to `newToday`. The selection follows only if it was on
    /// today; a day picked on purpose stays picked.
    func refreshToday(to newToday: DayString) {
        guard newToday != today else { return }
        if selectedDay == today { selectedDay = newToday }
        today = newToday
    }

    /// Whether `item` is on `day`. Habits ask the repeat (lib/recurrence.ts
    /// `shouldShowOnDate`, as `deriveDayItems` does); tasks show on their day.
    func shows(_ item: SampleItem, on day: DayString) -> Bool {
        switch item.kind {
        case .habit:
            guard let rule = item.repeatRule else { return false }
            return shouldShowOnDate(rule, on: day)
        case .task:
            return item.day == day
        }
    }

    /// The selected day's items, in stored order.
    var dayItems: [SampleItem] {
        items.filter { shows($0, on: selectedDay) }
    }

    func isDone(_ item: SampleItem) -> Bool {
        switch item.kind {
        case .habit: isCompletedOnDate(item.completedDates, selectedDay)
        case .task: item.done
        }
    }

    /// Ticks or unticks an item on the selected day. A habit's streak moves
    /// by one (DsulCore `settingHabitCompletion`); a task flips its flag.
    func toggle(_ id: UUID) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        let item = items[i]
        switch item.kind {
        case .habit:
            let mark = settingHabitCompletion(HabitMark(completedDates: item.completedDates, streak: item.streak),
                                              done: !isDone(item), on: selectedDay)
            items[i].completedDates = mark.completedDates
            items[i].streak = mark.streak
        case .task:
            items[i].done.toggle()
        }
    }

    // MARK: List layout

    func passes(_ item: SampleItem, _ filter: ListFilter) -> Bool {
        switch filter {
        case .all: true
        case .tasks: item.kind == .task
        case .habits: item.kind == .habit
        case .project(let name): item.project == name
        }
    }

    func count(_ filter: ListFilter) -> Int {
        dayItems.filter { passes($0, filter) }.count
    }

    /// The projects with something on the selected day, for the chips.
    var dayProjects: [String] {
        let present = Set(dayItems.compactMap(\.project))
        return projects.filter { present.contains($0) }
    }

    /// The List layout: routines first, then one section per project, then
    /// the loose items. A routine claims its members ahead of their project.
    func listSections(_ filter: ListFilter) -> [ListSection] {
        let rows = sortedForList(dayItems.filter { passes($0, filter) })
        var sections: [ListSection] = []
        var routines: [String] = []
        for item in rows {
            if let r = item.routine, !routines.contains(r) { routines.append(r) }
        }
        for r in routines {
            let members = rows.filter { $0.routine == r }
            sections.append(ListSection(id: "routine:\(r)", title: r, kind: .routine, items: members,
                                        doneCount: members.filter { isDone($0) }.count))
        }
        let rest = rows.filter { $0.routine == nil }
        for p in projects {
            let members = rest.filter { $0.project == p }
            guard !members.isEmpty else { continue }
            sections.append(ListSection(id: "project:\(p)", title: p, kind: .project, items: members,
                                        doneCount: members.filter { isDone($0) }.count))
        }
        let loose = rest.filter { item in item.project.map { !projects.contains($0) } ?? true }
        if !loose.isEmpty {
            sections.append(ListSection(id: "loose", title: "No project", kind: .loose, items: loose,
                                        doneCount: loose.filter { isDone($0) }.count))
        }
        return sections
    }

    /// Timed rows first by time, then untimed by order (lib/day-items.ts
    /// `byTimeThenOrder`, through DsulCore).
    private func sortedForList(_ rows: [SampleItem]) -> [SampleItem] {
        let byID = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
        return sortedByTimeThenOrder(rows.map(Self.bucketRow)).compactMap { byID[$0.id] }
    }

    // MARK: Buckets layout

    /// The selected day filed by bucket (DsulCore `bucketDayRows`).
    func buckets() -> [DayBucket: [SampleItem]] {
        let day = dayItems
        let byID = Dictionary(uniqueKeysWithValues: day.map { ($0.id, $0) })
        let ids = bucketDayRows(day.map(Self.bucketRow))
        var out: [DayBucket: [SampleItem]] = [:]
        for (bucket, list) in ids {
            out[bucket] = list.compactMap { byID[$0] }
        }
        return out
    }

    nonisolated private static func bucketRow(_ item: SampleItem) -> BucketRow<UUID> {
        BucketRow(id: item.id, isHabit: item.isHabit, bucket: item.bucket, startMin: item.startMin, order: item.order)
    }

    // MARK: Schedule layout and the braindump

    /// The selected day's timed items: the Schedule grid's blocks.
    var scheduled: [SampleItem] {
        dayItems.filter { $0.startMin != nil }
    }

    /// Captured tasks with no day yet, newest first.
    var braindump: [SampleItem] {
        items.filter { $0.kind == .task && $0.day == nil }
    }

    func item(_ id: UUID?) -> SampleItem? {
        guard let id else { return nil }
        return items.first { $0.id == id }
    }

    func isScheduled(_ id: UUID?) -> Bool {
        scheduled.contains { $0.id == id }
    }

    /// Moves a braindump item onto the selected day's grid, or moves a block.
    /// The bucket follows the hour, as a drop on `hour:{H}` does on the web
    /// (lib/dnd/handle-drag-end.ts).
    func schedule(_ id: UUID, startMin: Int) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        if items[i].kind == .task, items[i].day == nil {
            items[i].day = selectedDay
        }
        items[i].startMin = startMin
        items[i].bucket = DayBucket.owning(minute: startMin)
    }

    func capture(_ title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        items.insert(SampleItem(id: UUID(), title: trimmed, durationMin: 30), at: 0)
    }

    /// Fills the selected day to 40 blocks, for the spike's "no hitches on a busy day" test.
    /// Fresh ids each time: a fixed run would repeat across days.
    func stress() {
        var count = scheduled.count
        while count < 40 {
            let start = (count * 35) % (23 * 60)
            items.append(SampleItem(id: UUID(), title: "Block \(count + 1)",
                                    durationMin: [15, 30, 45][count % 3], startMin: start,
                                    day: selectedDay, bucket: DayBucket.owning(minute: start)))
            count += 1
        }
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
