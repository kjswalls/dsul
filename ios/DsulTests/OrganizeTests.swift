import DsulCore
import Foundation
import Testing
@testable import Dsul

/// The Organize list's rules (OrganizeModel), on Thursday 2026-10-01: which
/// sections show under which switches, in what order, with what header
/// counts; each row's subtitle, tile and spoken label; and the quiet rows
/// (loading, "Nothing here yet." and the switched-off note), which never
/// stand in for each other. The words under the rows are DsulCore's ports,
/// pinned against the web by their own fixtures; these pin how the list puts
/// them together.
@MainActor
@Suite struct OrganizeTests {
    private let today = DayString("2026-10-01")!
    private let zone = "America/New_York"

    private func uid(_ n: Int) -> UUID {
        return UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", n))!
    }

    private func task(_ n: Int, _ title: String, project: String? = nil, parent: UUID? = nil,
                      status: String = "pending") -> Item {
        return Item(id: uid(n), type: "task", title: title, status: status, project: project,
                    parentItemId: parent.map(lowerID), isScheduled: false)
    }

    /// Five items: three filed under Work (one "work", lowercase, and one a
    /// subtask of another), one under Home, one loose.
    private var items: [Item] {
        return [
            task(1, "Draft the plan", project: "Work"),
            task(2, "Standup", project: "work"),
            task(3, "Pull the numbers", project: "Work", parent: uid(1)),
            task(4, "Groceries", project: "Home", status: "completed"),
            task(5, "Read"),
        ]
    }

    private func snapshot(organize: Bool = true, goalsOn: Bool = true, timeFormat: TimeFormat = .twelveHour,
                          items: [Item]? = nil, routines: [Routine] = [], seasons: [Season] = [],
                          goals: [Goal]? = nil, projects: [Project] = []) -> OrganizeSnapshot {
        return OrganizeSnapshot(settings: PlannerSettings(timeFormat: timeFormat, organizeEnabled: organize,
                                                          goalsEnabled: goalsOn),
                                today: today, timeZone: zone, items: items ?? self.items, routines: routines,
                                seasons: seasons, goals: goals, projects: projects)
    }

    private func list(_ content: OrganizeContent) -> (sections: [OrganizeSection], nothingYet: OrganizeNote?,
                                                       switchedOff: OrganizeNote?)? {
        guard case .list(let sections, let nothingYet, let switchedOff) = content else { return nil }
        return (sections, nothingYet, switchedOff)
    }

    private var morning: Routine {
        Routine(id: "r-morning", name: "Morning routine", icon: "icon:Sunrise", color: "var(--accent-8)",
                sortOrder: 0, usualTime: "07:00", itemIds: [uid(1), uid(5), uid(99)])
    }

    private var everything: OrganizeSnapshot {
        let paused = Routine(id: "r-evening", name: "Evening", sortOrder: 1, pausedAt: "2026-09-20T15:00:00+00:00",
                             pausedUntil: "2026-10-30", itemIds: [])
        let autumn = Season(id: "s-autumn", name: "Autumn", icon: "icon:Leaf", color: "var(--accent-1)",
                            itemIds: [uid(5)], routineIds: ["r-morning"])
        let ski = Season(id: "s-ski", name: "Ski", startsOn: "2026-12-01")
        let half = Goal(id: "g-half", name: "Run a half", targetOn: "2027-03-15", milestoneIds: [uid(4), uid(5)])
        let cooked = Goal(id: "g-cook", name: "Cook five dishes", state: "achieved")
        let spanish = Goal(id: "g-spanish", name: "Spanish", state: "abandoned")
        return snapshot(routines: [morning, paused], seasons: [autumn, ski], goals: [cooked, half, spanish],
                        projects: [Project(id: "p-work", name: "Work"), Project(id: "p-home", name: "Home")])
    }

    // MARK: Before the first fetch

    @Test func beforeTheFirstFetchItLoadsAndNeverSaysNothingYet() {
        var s = snapshot()
        s.hasLoaded = false
        #expect(OrganizeModel.content(s) == .loading)
        s.loadError = "Couldn't reach dsul."
        #expect(OrganizeModel.content(s) == .failed("Couldn't reach dsul."))
        #expect(OrganizeModel.loadingText == "Loading\u{2026}")
    }

    @Test func aSignedInPlannerLoadsThenLists() async throws {
        let server = FakeServer()
        await server.on(plannerRoute,
                        .status(200, PlannerJSON.payload()),
                        .status(200, PlannerJSON.payload(fetchedAt: "fetch-2", goalsEnabled: true,
                                                         goals: [PlannerJSON.goalJSON("g-1", "Run a half")])))
        let planner = makeLivePlanner(server)
        #expect(planner.organize == .loading)

        // An older server's payload: no switches (Organize on, Goals off) and
        // no goals, so Goals is neither shown nor counted.
        await planner.refresh()
        let first = try #require(list(planner.organize))
        #expect(first.sections.isEmpty)
        #expect(first.nothingYet == OrganizeNote(title: "Nothing here yet.",
                                                 detail: "Routines, seasons and projects you make on the web show up here."))
        #expect(first.switchedOff == nil)

        // Goals switched on on the web, then a pull: Goals appears.
        await planner.refresh()
        #expect(planner.goals?.map(\.id) == ["g-1"])
        let second = try #require(list(planner.organize))
        #expect(second.sections.map(\.kind) == [.goals])
        #expect(second.nothingYet == nil)
    }

    // MARK: Sections

    @Test func everySectionInOrderWithItsHeaderCount() throws {
        let content = try #require(list(OrganizeModel.content(everything)))
        #expect(content.sections.map(\.kind) == [.routines, .seasons, .goals, .ended, .projects])
        #expect(content.sections.map(\.title) == ["Routines", "Seasons", "Goals", "Ended", "Projects"])
        // Seasons count the ones on today: Ski starts in December.
        #expect(content.sections.map(\.count) == ["2", "1 on", "1", "2", "2"])
        #expect(content.sections.map(\.spokenLabel)
            == ["Routines, 2", "Seasons, 1 on", "Goals, 1", "Ended, 2", "Projects, 2"])
        #expect(content.nothingYet == nil)
        #expect(content.switchedOff == nil)
    }

    @Test func routinesSeasonsAndProjectsKeepThePayloadsOrder() throws {
        let content = try #require(list(OrganizeModel.content(everything)))
        #expect(content.sections[0].rows.map(\.title) == ["Morning routine", "Evening"])
        #expect(content.sections[1].rows.map(\.title) == ["Autumn", "Ski"])
        #expect(content.sections[4].rows.map(\.title) == ["Work", "Home"])
    }

    /// `sortGoalsForDisplay`: active first, then the ended ones in the order
    /// they came, under their own header.
    @Test func endedGoalsSitUnderTheirOwnHeader() throws {
        let content = try #require(list(OrganizeModel.content(everything)))
        #expect(content.sections[2].rows.map(\.title) == ["Run a half"])
        #expect(content.sections[3].rows.map(\.title) == ["Cook five dishes", "Spanish"])
    }

    /// With no active goal the ended ones stay under Goals, with no Ended
    /// header (the web's divider shows only below an active goal).
    @Test func withNoActiveGoalEndedGoalsStayUnderGoals() throws {
        let done = Goal(id: "g-cook", name: "Cook five dishes", state: "achieved")
        let content = try #require(list(OrganizeModel.content(snapshot(goals: [done]))))
        #expect(content.sections.map(\.kind) == [.goals])
        #expect(content.sections[0].count == "1")
        #expect(content.sections[0].rows.map(\.subtitle) == ["Achieved"])
    }

    @Test func emptySectionsAreLeftOut() throws {
        let content = try #require(list(OrganizeModel.content(snapshot(routines: [morning], goals: []))))
        #expect(content.sections.map(\.kind) == [.routines])
        #expect(content.nothingYet == nil)
    }

    // MARK: The switches

    /// Goals off hides goals the payload still carries: a display gate.
    @Test func goalsOffHidesGoals() throws {
        var s = everything
        s.settings.goalsEnabled = false
        let content = try #require(list(OrganizeModel.content(s)))
        #expect(content.sections.map(\.kind) == [.routines, .seasons, .projects])
    }

    /// Organize off hides Routines, Seasons and Projects and says why. Goals
    /// follows its own switch.
    @Test func organizeOffSaysSoAndKeepsGoals() throws {
        var s = everything
        s.settings.organizeEnabled = false
        let content = try #require(list(OrganizeModel.content(s)))
        #expect(content.sections.map(\.kind) == [.goals, .ended])
        #expect(content.nothingYet == nil)
        #expect(content.switchedOff == OrganizeNote(
            title: "Organize is switched off.",
            detail: "Your routines, seasons and projects are still here. Switch it back on in Settings on the web."))

        s.settings.goalsEnabled = false
        let neither = try #require(list(OrganizeModel.content(s)))
        #expect(neither.sections.isEmpty)
        // A switch that hides a kind never reads as emptiness.
        #expect(neither.nothingYet == nil)
        #expect(neither.switchedOff != nil)
    }

    /// "Nothing here yet." only when every kind the switches allow is empty,
    /// naming only those kinds.
    @Test func nothingYetNamesOnlyWhatTheSwitchesAllow() throws {
        let all = try #require(list(OrganizeModel.content(snapshot(goals: []))))
        #expect(all.nothingYet?.detail == "Routines, seasons, goals and projects you make on the web show up here.")
        #expect(all.nothingYet?.spokenLabel
            == "Nothing here yet. Routines, seasons, goals and projects you make on the web show up here.")

        let goalsOnly = try #require(list(OrganizeModel.content(snapshot(organize: false, goals: []))))
        #expect(goalsOnly.nothingYet?.detail == "Goals you make on the web show up here.")
        #expect(goalsOnly.switchedOff != nil)

        // Goals the server couldn't read are unknown, not none.
        let unknown = try #require(list(OrganizeModel.content(snapshot(goals: nil))))
        #expect(unknown.nothingYet?.detail == "Routines, seasons and projects you make on the web show up here.")
        let unknownAlone = try #require(list(OrganizeModel.content(snapshot(organize: false, goals: nil))))
        #expect(unknownAlone.nothingYet == nil)

        // One goal is enough to say nothing of the kind.
        let one = Goal(id: "g", name: "G")
        let some = try #require(list(OrganizeModel.content(snapshot(goals: [one]))))
        #expect(some.nothingYet == nil)
    }

    /// From O11, where the + menu makes them, the second line says so,
    /// naming only what it makes; a server older than the create route keeps
    /// the web's line.
    @Test func nothingYetPointsAtThePlusWhereItMakesThem() throws {
        func detail(_ s: OrganizeSnapshot) throws -> String? {
            return try #require(list(OrganizeModel.content(s))).nothingYet?.detail
        }
        var all = snapshot(goals: [])
        all.containerTakes = OrganizeModel.everyContainerWrite
        #expect(try detail(all) == "Make a routine, season, goal or project with +.")
        var unread = snapshot(goals: nil)
        unread.containerTakes = OrganizeModel.everyContainerWrite
        #expect(try detail(unread) == "Make a routine, season or project with +.")
        var goalsOnly = snapshot(organize: false, goals: [])
        goalsOnly.containerTakes = OrganizeModel.everyContainerWrite
        #expect(try detail(goalsOnly) == "Make a goal with +.")
        var older = snapshot(goals: [])
        older.containerTakes = ContainerWrites(routine: ["rename"], season: ["rename"], goal: ["rename"],
                                               project: ["rename"])
        #expect(try detail(older) == "Routines, seasons, goals and projects you make on the web show up here.")
        #expect(OrganizeModel.englishList(["a", "b", "c"], conjunction: "or") == "a, b or c")
        #expect(OrganizeModel.article("idea") == "an")
        #expect(OrganizeModel.article("routine") == "a")
    }

    // MARK: Rows

    /// The usual time in the payload's format, and only the live items: a
    /// trashed member (its join row outlives it) is not counted.
    @Test func aRoutineRowsSubtitle() throws {
        let row = OrganizeModel.routineRow(morning, snapshot(), liveItems: Set(items.map(\.id)))
        #expect(row.subtitle == "7:00 am \u{00B7} 2 items")
        #expect(row.trailing == nil)
        #expect(row.spokenLabel == "Morning routine, routine, 7:00 am, 2 items")
        let clock = OrganizeModel.routineRow(morning, snapshot(timeFormat: .twentyFourHour),
                                             liveItems: Set(items.map(\.id)))
        #expect(clock.subtitle == "07:00 \u{00B7} 2 items")

        let empty = Routine(id: "r-wind", name: "Wind down", itemIds: [])
        #expect(OrganizeModel.routineRow(empty, snapshot(), liveItems: []).subtitle == "Nothing in it yet")
    }

    /// A paused routine wears the web's pill first; one a season holds off
    /// wears "Held", with the day the season comes back.
    @Test func aRoutinesStatePill() throws {
        let live = Set(items.map(\.id))
        let paused = Routine(id: "r-evening", name: "Evening", pausedAt: "2026-09-20T15:00:00+00:00",
                             pausedUntil: "2026-10-30", itemIds: [uid(5)])
        #expect(OrganizeModel.routineRow(paused, snapshot(), liveItems: live).subtitle
            == "Until Oct 30 \u{00B7} 1 item")

        let ski = Season(id: "s-ski", name: "Ski", startsOn: "2026-11-01", routineIds: ["r-morning"])
        let held = OrganizeModel.routineRow(morning, snapshot(seasons: [ski]), liveItems: live)
        #expect(held.subtitle == "Held \u{00B7} Nov 1 \u{00B7} 7:00 am \u{00B7} 2 items")
        #expect(held.spokenLabel == "Morning routine, routine, Held, Nov 1, 7:00 am, 2 items")
    }

    /// A season counts its live routines and its own live items (not its
    /// routines' items), and says "Nothing in it yet" with neither.
    @Test func aSeasonRowsSubtitle() throws {
        let s = snapshot(routines: [morning])
        let live = Set(items.map(\.id))
        let routines = Set(["r-morning"])
        let autumn = Season(id: "s-autumn", name: "Autumn", itemIds: [uid(5), uid(98)],
                            routineIds: ["r-morning", "r-gone"])
        #expect(OrganizeModel.seasonRow(autumn, s, liveItems: live, liveRoutines: routines).subtitle
            == "1 routine \u{00B7} 1 item")
        let off = Season(id: "s-off", name: "Off", state: "paused")
        #expect(OrganizeModel.seasonRow(off, s, liveItems: live, liveRoutines: routines).subtitle
            == "Paused \u{00B7} Nothing in it yet")
        let later = Season(id: "s-later", name: "Later", startsOn: "2026-11-01", itemIds: [uid(1), uid(2)])
        let row = OrganizeModel.seasonRow(later, s, liveItems: live, liveRoutines: routines)
        #expect(row.subtitle == "From Nov 1 \u{00B7} 2 items")
        #expect(row.spokenLabel == "Later, season, From Nov 1, 2 items")
    }

    /// An active goal: its target day, then its progress in the web's words.
    /// An ended one wears its state alone.
    @Test func aGoalRowsSubtitle() throws {
        let byId = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        let half = Goal(id: "g-half", name: "Run a half", targetOn: "2027-03-15", milestoneIds: [uid(4), uid(5)])
        let row = OrganizeModel.goalRow(half, itemsById: byId)
        #expect(row.subtitle == "Mar 15 \u{00B7} 1/2")
        #expect(row.spokenLabel == "Run a half, goal, target Mar 15, 1 of 2 milestones reached")

        let reached = Goal(id: "g-r", name: "Reached", milestoneIds: [uid(4)])
        let soFar = OrganizeModel.goalRow(reached, itemsById: byId)
        #expect(soFar.subtitle == "1/1 so far")
        #expect(soFar.spokenLabel == "Reached, goal, 1 of 1 milestones reached so far")

        let bare = Goal(id: "g-b", name: "Bare")
        #expect(OrganizeModel.goalRow(bare, itemsById: byId).subtitle == "No milestones yet")
        #expect(OrganizeModel.goalRow(bare, itemsById: byId).spokenLabel == "Bare, goal, No milestones yet")

        let aside = Goal(id: "g-a", name: "Aside", state: "abandoned", targetOn: "2027-03-15")
        #expect(OrganizeModel.goalRow(aside, itemsById: byId).subtitle == "Set aside")
        let achieved = Goal(id: "g-c", name: "Done", state: "achieved", milestoneIds: [uid(4)])
        #expect(OrganizeModel.goalRow(achieved, itemsById: byId).subtitle == "Achieved")
    }

    /// A project counts what its page lists: every item filed under its
    /// folded name, done ones included, subtasks left out.
    @Test func aProjectCountsItsItemsWithoutSubtasks() throws {
        let s = snapshot()
        let work = OrganizeModel.projectRow(Project(id: "p-work", name: "Work"), s)
        #expect(work.subtitle == "2 items")
        #expect(work.spokenLabel == "Work, project, 2 items")
        #expect(OrganizeModel.projectRow(Project(id: "p-home", name: "Home"), s).subtitle == "1 item")
        #expect(OrganizeModel.projectRow(Project(id: "p-x", name: "Errands"), s).subtitle == "Nothing in it yet")
    }

    /// The one-pass count is `containerMemberIds` less subtasks, name by
    /// name: folded, never trimmed, code unit by code unit, and an empty
    /// parent id is no parent.
    @Test func theProjectCountIsTheMemberRule() throws {
        let edges = items + [
            Item(id: uid(6), type: "task", title: "Café run", project: "CAFÉ", isScheduled: false),
            Item(id: uid(7), type: "task", title: "Decomposed", project: "Cafe\u{301}", isScheduled: false),
            Item(id: uid(8), type: "task", title: "Trailing", project: "Work ", isScheduled: false),
            Item(id: uid(9), type: "task", title: "Empty parent", project: "Home", parentItemId: "",
                 isScheduled: false),
            Item(id: uid(10), type: "task", title: "No name", project: "", isScheduled: false),
        ]
        let projects = ["Work", "work ", "Home", "Café", "Cafe\u{301}", "Errands", ""].enumerated().map {
            Project(id: "p-\($0.offset)", name: $0.element)
        }
        let s = snapshot(items: edges, projects: projects)
        let counts = OrganizeModel.listedByProject(edges)
        for project in projects {
            let members = containerMemberIds(.project(project), items: edges, routines: [])
            let expected = members.filter { id in
                (edges.first { $0.id == id }?.parentItemId ?? "").isEmpty
            }.count
            let row = OrganizeModel.projectRow(project, s, listedByProject: counts)
            #expect(row == OrganizeModel.projectRow(project, s), "\(project.name)")
            #expect(row.subtitle == OrganizeModel.itemsSegment(expected), "\(project.name)")
        }
        // The edges land where the web puts them.
        #expect(counts[Array("café".utf16)] == 1)
        #expect(counts[Array("cafe\u{301}".utf16)] == 1)
        #expect(counts[Array("home".utf16)] == 2)
    }

    // MARK: Tiles

    /// The stored colour and icon, else the name's: Organize's tile rule.
    @Test func aTileTakesItsStoredLookElseItsNames() throws {
        let routine = OrganizeModel.routineRow(morning, snapshot(), liveItems: [])
        #expect(routine.symbol == "sunrise")
        #expect(routine.accent.token == "var(--accent-8)")
        #expect(routine.accent.source == .token)

        let work = OrganizeModel.projectRow(Project(id: "p-work", name: "Work"), snapshot())
        #expect(work.symbol == "briefcase")
        #expect(work.accent.source == .name)
        #expect(work.accent.token == accentColorForName("Work"))

        // A legacy emoji is ignored and the glyph derives from the name; a
        // raw hex is drawn as it is.
        let home = OrganizeModel.projectRow(Project(id: "p-home", name: "Home", color: "#3366CC", emoji: "🏠"),
                                            snapshot())
        #expect(home.symbol == containerSymbol(glyph: nil, name: "Home", kind: .project))
        #expect(home.accent.source == .hex)
        #expect(home.accent.light.hex == "#3366cc")
    }

    @Test func rowIdsAreUniqueAcrossKinds() throws {
        let content = try #require(list(OrganizeModel.content(everything)))
        let ids = content.sections.flatMap { $0.rows.map(\.id) }
        #expect(Set(ids).count == ids.count)
        #expect(ids.first == "routine/r-morning")
    }

    // MARK: Words

    @Test func listsReadAsEnglish() {
        #expect(OrganizeModel.englishList([]) == "")
        #expect(OrganizeModel.englishList(["goals"]) == "goals")
        #expect(OrganizeModel.englishList(["routines", "seasons"]) == "routines and seasons")
        #expect(OrganizeModel.englishList(["routines", "seasons", "projects"]) == "routines, seasons and projects")
        #expect(OrganizeModel.capitalizedFirst("goals you make") == "Goals you make")
    }

    /// No em dash anywhere the list can say.
    @Test func noEmDashInTheListsWords() throws {
        let content = try #require(list(OrganizeModel.content(everything)))
        var words = content.sections.flatMap { section in
            [section.title, section.count, section.spokenLabel]
                + section.rows.flatMap { [$0.title, $0.subtitle ?? "", $0.spokenLabel] }
        }
        words += [OrganizeModel.switchedOff.spokenLabel, OrganizeModel.loadingText]
        #expect(words.allSatisfy { !$0.contains("\u{2014}") })
    }
}
