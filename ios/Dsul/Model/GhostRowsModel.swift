import DsulCore
import Foundation

/// Leftovers on Today (memory/plans/ghost-rows.md, phase 3): which items the
/// fold at the top of Today shows, and the five verbs that settle one. The
/// selection is DsulCore's port of lib/ghost-rows.ts (`selectGhostRows` over
/// `selectOverdue`), the gates are ghost-fold.tsx's (`ghostVerbAllowed`), and
/// every write is one this planner already makes: Keep for today, Move to
/// tomorrow and Reschedule are `move` (the store's `moveTaskToDate`), Send to
/// sidebar is `unschedule`'s write (`unscheduleTask`), and Let it go is the new
/// `letGo` (`letGoItems`). Showing a ghost writes nothing.
extension SamplePlanner {
    /// The ghosts on today, newest first, or none when the fold must not
    /// draw: before the first fetch lands (a failed load's empty planner is
    /// not the pile), with Leftovers on Today off (`settings.leftoversOnToday`,
    /// the account's `morning_check_enabled`), and while the goals are unread
    /// (`milestoneIds` nil), since a milestone must never ghost and the bulk
    /// verbs would walk or erase it. Read off TODAY in the user's zone, never
    /// the selected day; the views draw the fold on today alone.
    var ghostRows: [SampleItem] {
        guard hasLoaded, settings.leftoversOnToday, let milestones = milestoneIds else { return [] }
        let inactive = inactiveItemIdsOn(items: items, date: today, timeZone: timeZoneID, routines: routines,
                                         seasons: seasons, away: awayPeriods)
        return selectGhostRows(items, today: today.description, inactiveIds: inactive, milestoneIds: milestones)
    }

    /// Does the fold offer `verb` on `ghost`? The fold's own gate on the
    /// ghost's day (`ghostVerbAllowed`), and the server taking the write the
    /// verb sends (`canWrite`), so a control never no-ops. Send to sidebar
    /// asks `canSendToBraindump` alone, as the web's fold does, never Move to
    /// Braindump's "not already a braindump row": a dated row that is neither
    /// scheduled nor in a part of day ghosts too, and the verb clears its date.
    func ghostOffers(_ verb: GhostVerb, _ ghost: SampleItem) -> Bool {
        guard ghostVerbAllowed(verb, ghost, milestoneIds: milestoneIds ?? []) else { return false }
        switch verb {
        case .keep, .tomorrow, .reschedule: return canWrite("move")
        case .sidebar: return canWrite("unschedule")
        case .letGo: return canWrite(ItemWriteBody.letGo.action)
        }
    }

    /// Today's tomorrow, the day Move to tomorrow lands on whatever the
    /// ghost's own day was.
    var ghostTomorrow: DayString { today.adding(days: 1) }

    /// Runs `verb` on the ghost `id`; Reschedule lands on `day`, which the
    /// others ignore. Asked again here off the item as it is now. When it
    /// empties the fold, `ghostsSortedAt` marks the moment.
    func settleGhost(_ id: UUID, _ verb: GhostVerb, day: DayString? = nil) {
        noteSorted { runGhostVerb(verb, on: id, day: day) }
    }

    /// Keep all and Send all to sidebar: `verb` on every ghost that takes it,
    /// one write each (the phone has no bulk item route). Keep all lands as
    /// the web's bulk carry (`moveTasksToDate`) does: today, its bucket kept,
    /// and a stale clock time dropped, so a 9 AM leftover kept at 3 PM is an
    /// untimed row in its part of day, not a block in the past. That is the
    /// `move`, then the Time chip's own write clearing the time
    /// (`edit(.time)`, behind its own gate); Keep for today on one keeps the
    /// time, as the web's `moveTaskToDate` does.
    func settleAllGhosts(_ verb: GhostVerb) {
        noteSorted {
            for ghost in ghostRows where ghostOffers(verb, ghost) {
                runGhostVerb(verb, on: ghost.id, day: nil)
                if verb == .keep, item(ghost.id)?.startTime != nil {
                    edit(ghost.id, .time(bucket: nil, startTime: .clear, duration: nil))
                }
            }
        }
    }

    /// Would `verb` on `id` take the fold from its last ghost to none? The
    /// views send that change with no animation, so "All sorted, you got
    /// this" and its lime dot arrive at once (a List would fade the new row
    /// in through its own opacity).
    func ghostVerbEmptiesFold(_ verb: GhostVerb, _ id: UUID) -> Bool {
        let ghosts = ghostRows
        guard ghosts.count == 1, let ghost = ghosts.first, ghost.id == id else { return false }
        return ghostOffers(verb, ghost)
    }

    /// Would the bulk `verb` take every ghost? See `ghostVerbEmptiesFold`.
    func ghostBulkEmptiesFold(_ verb: GhostVerb) -> Bool {
        let ghosts = ghostRows
        return !ghosts.isEmpty && ghosts.allSatisfy { ghostOffers(verb, $0) }
    }

    /// Stamps `ghostsSortedAt` when `change` took the fold from some ghosts
    /// to none: the person's own verb cleared it.
    private func noteSorted(_ change: () -> Void) {
        let had = !ghostRows.isEmpty
        change()
        guard had && ghostRows.isEmpty else { return }
        let stamp = now()
        ghostsSortedAt = stamp
        // The line shows for `GhostCopy.doneSeconds`, then nothing; a later
        // sort keeps its own stamp, so this one never clears it early.
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(GhostCopy.doneSeconds))
            if self?.ghostsSortedAt == stamp { self?.ghostsSortedAt = nil }
        }
    }

    /// Does the fold draw anything on the selected day: its leftovers, or
    /// its "All sorted" line? Today only.
    var showsGhostFold: Bool {
        guard isOnToday else { return false }
        return !ghostRows.isEmpty || showsGhostsSorted
    }

    /// Is "All sorted, you got this" on screen? Only after the person's own
    /// verb emptied the fold, for a few seconds, and only while it stays empty.
    var showsGhostsSorted: Bool {
        return ghostsSortedAt != nil && ghostRows.isEmpty
    }

    private func runGhostVerb(_ verb: GhostVerb, on id: UUID, day: DayString?) {
        guard let ghost = item(id), ghostOffers(verb, ghost) else { return }
        switch verb {
        case .keep: move(id, to: today.description)
        case .tomorrow: move(id, to: ghostTomorrow.description)
        case .reschedule:
            guard let day else { return }
            move(id, to: day.description)
        case .sidebar:
            // `ghostOffers` was the gate; Move to Braindump's own would refuse
            // a dated row the braindump already lists.
            guard let i = items.firstIndex(where: { $0.id == id }) else { return }
            writeUnscheduling(at: i)
        case .letGo: letGo(id)
        }
    }

    /// Let it go (`letGoItems([id])`): the item cancelled and kept in
    /// history (DsulCore `lettingGo`), behind its gate (`canLetGo`: pending,
    /// not recurring, a type with a cancelled status) and the server taking
    /// `letGo`. Optimistic, then sent; a refusal reverts it.
    func letGo(_ id: UUID) {
        guard canWrite(ItemWriteBody.letGo.action), let i = items.firstIndex(where: { $0.id == id }) else { return }
        let before = items[i]
        guard canLetGo(before) else { return }
        let after = lettingGo(before)
        guard after != before else { return }
        items[i] = after
        sync?.enqueue(.letGo(id: id), snapshot: before)
    }
}
