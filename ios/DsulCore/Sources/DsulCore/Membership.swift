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

/// `ids`, a container's `itemIds`, with `item` in it (`member`) or out of it.
/// Unchanged when it already says so; else an add appends the item, as the
/// store and the server's add put it, and a remove takes out every copy, as
/// the store's filter does. With `index`, which only a revert asks for, the
/// item is taken out wherever it stands and put back at `index`, clamped to
/// `0...ids.count` of the list without it, so a failed remove puts it back
/// where it stood even when a later toggle had put it at the end. `index` is
/// read only with `member`: a remove is the same whatever it says.
public func settingMembership(_ ids: [UUID], item: UUID, member: Bool, at index: Int? = nil) -> [UUID] {
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
