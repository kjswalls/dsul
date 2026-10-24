import Foundation

// A routine's or a season's members as the item sheet's toggles leave them
// (2f-b). Ports of:
// - lib/planner-store.ts `setItemsCollected` for one item (the bulk bar's Add
//   to / Remove from; the item panel's chips, item-dialog.tsx `toggleRoutine` /
//   `toggleSeason`, write the same end list through `updateRoutine` /
//   `updateSeason`): an add appends the item to the container's `itemIds`
//   and a remove filters it out, and either is the list unchanged when it
//   already says so (the store bails before its label then, and writes
//   nothing);
// - lib/db.ts `addContainerMember`, which the route's `collect` runs: the
//   server's add puts the new row last in a routine's order (the highest
//   `sort_order` plus one), so appending is where the next fetch shows it.
//   The one exception is a routine with members that have no place
//   (`sort_order` NULL, old data): the new row has none either and sorts
//   among them by its id, so the next fetch shows the server's order, not
//   this one. A season's members have no order at all (lib/db.ts
//   `fetchSeasons` reads them by id), so there the append is the store's
//   order alone, and a fetch may show another.
// Keep in step: a change there without the same change here is drift, and the
// phone shows the item in a container the server never put it in, or out of
// one it is still in, until the next fetch replaces it. Checked against the
// web by EditWritesFixtureTests (`membershipLandsWhereTheStoreDoes`, on
// tests/fixtures/day/edit-writes.json's collect cases, whose `member` holds
// the store's list before and after the toggle).
//
// `index` is the phone's alone: PlannerSync's revert of a failed toggle puts
// the item back where it stood before the toggle, which is where the server
// still holds it, since the toggle never landed.
//
// From O13 the same rule steps a season's routines (`routineIds`), one hold
// at a time: lib/app-containers.ts `holdRoutine` puts one season_routines row
// in or takes one out, the web's store appends the routine or filters it out
// of the list, and a hold already so writes nothing. Hence the generic id. A
// season's routines have no order either (lib/db.ts reads them by routine id),
// so a page draws them in the routines' own order, never this list's.
//
// From O12, `placingMember`: the phone's revert of a failed step move
// (design §6.4, `restoreMembership(after:)`), which puts a step back after
// the step a later landed move placed it after (`moveMemberAfter`), or at its
// old place once that step is gone.

/// `ids`, a container's `itemIds`, with `item` in it (`member`) or out of it.
/// Unchanged when it already says so; else an add appends the item, as the
/// store and the server's add put it, and a remove takes out every copy, as
/// the store's filter does. With `index`, which only a revert asks for, the
/// item is taken out wherever it stands and put back at `index`, clamped to
/// `0...ids.count` of the list without it, so a failed remove puts it back
/// where it stood even when a later toggle had put it at the end. `index` is
/// read only with `member`: a remove is the same whatever it says.
public func settingMembership<ID: Equatable>(_ ids: [ID], item: ID, member: Bool, at index: Int? = nil) -> [ID] {
    guard member else {
        return ids.contains(item) ? ids.filter { $0 != item } : ids
    }
    guard let index else {
        return ids.contains(item) ? ids : ids + [item]
    }
    var without = ids.filter { $0 != item }
    without.insert(item, at: min(max(index, 0), without.count))
    return without
}

/// A step put back in a routine's `itemIds` by the phone's revert (design
/// §6.4): right after `after` while `after` is still in `ids` and is not the
/// step itself (`moveMemberAfter`), first when `after` is nil, and otherwise
/// at `index` as `settingMembership` places it (clamped; with no index, left
/// where it stands, or last when it is not in). What a landed move's anchor
/// says once the moves around it have failed: the server placed the step
/// after that one, and an anchor taken out since leaves its old place as the
/// best word. A step not in `ids` goes in, since it is a member the revert
/// puts back.
public func placingMember<ID: Equatable>(_ ids: [ID], item: ID, after: ID?, orAt index: Int?) -> [ID] {
    if let after, after == item || !ids.contains(after) {
        return settingMembership(ids, item: item, member: true, at: index)
    }
    let present = ids.contains(item) ? ids : ids + [item]
    return moveMemberAfter(present, item: item, after: after)
}
