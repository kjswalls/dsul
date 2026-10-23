import Foundation

// Port of lib/container-schedule.ts, who a container answers for. Keep in
// step: a change there without the same change here is drift, and the
// phone's count of a container's items disagrees with the web's. Checked
// against the web by ScheduleFixtureTests
// (tests/fixtures/organize/schedule.json).
//
// From O1 (Organize's list): `containerMemberIds` only, for the counts. The
// schedule itself (`deriveContainerSchedule`, the day rollups, the week
// totals) comes with the pages (O2). `weekStartOf` is already in Cadence.swift
// and day arithmetic is `DayString.adding(days:)`, so neither is repeated.
//
// A project holds items BY NAME (`items.project`), folded as every project
// lookup is (lib/container-registry.ts `sameContainerName`: `toLowerCase`, so
// `jsLowercased`, and never a trim), and compared code unit by code unit as
// JavaScript's `===` does.

/// The four container kinds Organize lists (lib/container-schedule.ts
/// `ScheduleContainer`'s `kind`, lib/container-registry.ts' kinds). Not the
/// item sheet's `ContainerKind` (ItemEdit.swift), which names only the two
/// membership kinds an item meets there.
public enum OrganizeKind: String, Hashable, CaseIterable, Sendable {
    case routine, season, goal, project
}

/// lib/container-schedule.ts `ScheduleContainer`: one container, whole.
public enum ScheduleContainer: Sendable, Hashable {
    case routine(Routine)
    case season(Season)
    case goal(Goal)
    case project(Project)

    public var kind: OrganizeKind {
        switch self {
        case .routine: return .routine
        case .season: return .season
        case .goal: return .goal
        case .project: return .project
        }
    }
}

/// lib/container-schedule.ts `containerMemberIds`: the item ids a container
/// answers for, ids of trashed items included (count them with `countLive`).
/// - a routine: its `itemIds`, in its own order;
/// - a season: its own `itemIds`, then each held routine's in `routineIds`
///   order (a routine not in `routines` is skipped), each id once, first
///   seen first;
/// - a goal: milestones, then check-ins, then supporting work, as stored;
/// - a project: the items in `items` whose `project` folds equal to its
///   name, in `items` order, done items and subtasks included. An empty
///   name is no project.
public func containerMemberIds(_ container: ScheduleContainer, items: [Item], routines: [Routine]) -> [UUID] {
    switch container {
    case .routine(let routine):
        return routine.itemIds
    case .season(let season):
        var seen = Set<UUID>()
        var ids: [UUID] = []
        func add(_ id: UUID) {
            if seen.insert(id).inserted { ids.append(id) }
        }
        season.itemIds.forEach(add)
        for routineId in season.routineIds {
            routines.first { $0.id == routineId }?.itemIds.forEach(add)
        }
        return ids
    case .goal(let goal):
        return goal.milestoneIds + goal.checkinIds + goal.memberIds
    case .project(let project):
        let folded = Array(jsLowercased(project.name).utf16)
        return items.filter { item in
            guard let name = item.project, !name.isEmpty else { return false }
            return jsLowercased(name).utf16.elementsEqual(folded)
        }.map(\.id)
    }
}
