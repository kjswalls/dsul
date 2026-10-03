import DsulCore
import Foundation
import Testing
@testable import Dsul

/// The item sheet's words and slots (ItemSheetModel) and a row's VoiceOver
/// sentence, on the sample's Thursday 2026-10-01: which verbs sit in the bar
/// and which behind ⋯ (Delete last), the bar's short words, the "For …"
/// caption and the "Not due" line, the day picker's words, a counted habit's
/// tally, the chips in the web panel's order, the streak chip's week, and the
/// time ranges. From part 2: Delete's words, with a custom type's own label
/// and the subtasks that go with it, and the typed fields' rules (what a
/// keystroke may put in the title or the notes, and what leaving one sends).
/// From 2b: what the subtask field adds as it is typed in or pasted into, one
/// Return adding one subtask whichever way iOS reports it, the streak
/// popover's words, Reset never entering the bar or ⋯, and a row with Streaks
/// off. From 2c: which chips edit and how, what "+ Add property" offers and
/// says, where VoiceOver goes after a change, the menus' words, and the Remind
/// sheet's rules (the wheel's clock, what it opens on, what Done sends) and
/// words.
@MainActor
@Suite struct ItemSheetTests {
    private func makePlanner() -> SamplePlanner {
        SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
    }

    private func named(_ planner: SamplePlanner, _ title: String) throws -> SampleItem {
        let found = planner.items.first(where: { $0.title == title })
        return try #require(found)
    }

    /// What the sheet works out for `item` on `day` (today when nil): the
    /// context, the verbs the planner offers, and where they go.
    private func sheet(_ planner: SamplePlanner, _ item: SampleItem,
                       on day: DayString? = nil) -> (ctx: VerbContext, offered: [VerbID], verbs: SheetVerbs) {
        let ctx = planner.verbContext(for: item, on: day ?? planner.today)
        let offered = VerbID.allCases.filter { planner.offers($0, item, ctx) }
        return (ctx, offered, ItemSheetModel.verbs(item, ctx, offered: offered))
    }

    // MARK: The bar

    @Test func aOneOffTaskOffersTheTickTomorrowAndReschedule() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")
        let (ctx, _, verbs) = sheet(planner, roadmap)

        #expect(verbs.bar == [.tick, .nextDay, .reschedule])
        #expect(verbs.menu == [.pause, .pauseUntil, .delete])
        #expect(!verbs.notDue)
        #expect(ItemSheetModel.barLabel(.tick, roadmap, ctx) == "Done")
        #expect(ItemSheetModel.spokenLabel(.tick, roadmap, ctx) == "Mark done")
        #expect(ItemSheetModel.barLabel(.nextDay, roadmap, ctx) == "Tomorrow")
        #expect(ItemSheetModel.spokenValue(.nextDay, roadmap, ctx) == "Fri, Oct 2")
        #expect(ItemSheetModel.barLabel(.reschedule, roadmap, ctx) == "Reschedule")
        #expect(ItemSheetModel.dayCaption(roadmap, ctx, bar: verbs.bar) == nil)
    }

    @Test func aHabitOffersSkipAndThePauseFamilyAndDeleteAloneBehindMore() throws {
        let planner = makePlanner()
        let journal = try named(planner, "Journal")
        let (ctx, offered, verbs) = sheet(planner, journal)

        #expect(offered.contains(.tick))
        #expect(verbs.bar == [.skip, .pause, .pauseUntil])
        #expect(verbs.menu == [.delete])
        #expect(ItemSheetModel.barLabel(.skip, journal, ctx) == "Skip today")
        #expect(ItemSheetModel.spokenLabel(.tick, journal, ctx) == "Done today")
        #expect(ItemSheetModel.dayCaption(journal, ctx, bar: verbs.bar) == nil)
        #expect(ItemSheetModel.titleDayNote(journal, ctx, offered: offered, bar: verbs.bar) == nil)
    }

    /// The bar's words say "today" only on today; off it a caption names the
    /// day Skip acts on, and a line under the title the day the habit's
    /// circle ticks, since the bar doesn't hold the tick.
    @Test func offTodayTheWordTodayGoesAndACaptionNamesTheDay() throws {
        let planner = makePlanner()
        let journal = try named(planner, "Journal")
        let friday = planner.today.adding(days: 1)
        let (ctx, offered, verbs) = sheet(planner, journal, on: friday)

        #expect(verbs.bar == [.skip, .pause, .pauseUntil])
        #expect(ItemSheetModel.barLabel(.skip, journal, ctx) == "Skip")
        #expect(ItemSheetModel.dayCaption(journal, ctx, bar: verbs.bar) == "For Fri, Oct 2")
        #expect(ItemSheetModel.titleDayNote(journal, ctx, offered: offered, bar: verbs.bar) == "For Fri, Oct 2")
    }

    /// The caption follows what the bar holds, not what is offered. Journal
    /// was done yesterday, so on yesterday there is no Skip, and the bar is
    /// Pause and Pause until, which act on today: no caption over them. The
    /// circle still ticks yesterday, and the title says so.
    @Test func aBarOfDatelessVerbsHasNoCaption() throws {
        let planner = makePlanner()
        let journal = try named(planner, "Journal")   // done the three days before today
        let wednesday = planner.today.adding(days: -1)
        let (ctx, offered, verbs) = sheet(planner, journal, on: wednesday)

        #expect(ctx.occurrence == .done)
        #expect(offered.contains(.tick))
        #expect(verbs.bar == [.pause, .pauseUntil])
        #expect(ItemSheetModel.dayCaption(journal, ctx, bar: verbs.bar) == nil)
        #expect(ItemSheetModel.titleDayNote(journal, ctx, offered: offered, bar: verbs.bar) == "For Wed, Sep 30")
    }

    /// Paused today, the bar is Resume alone, which acts on today whatever
    /// day the sheet was opened on: no caption over it.
    @Test func resumeAloneOffTodayHasNoCaption() throws {
        let planner = makePlanner()
        var journal = try named(planner, "Journal")
        journal.pausedAt = "2026-09-30T12:00:00.000Z"
        journal.pausedUntil = "2026-10-08"
        let friday = "2026-10-02"
        let ctx = VerbContext(dateStr: friday, todayStr: "2026-10-01", timeZone: "UTC",
                              occurrence: occurrenceOn(journal, on: friday, today: "2026-10-01", timeZone: "UTC"))
        let verbs = ItemSheetModel.verbs(journal, ctx, offered: eligibleVerbs(journal, ctx))

        #expect(verbs.bar == [.resume])
        #expect(ItemSheetModel.dayCaption(journal, ctx, bar: verbs.bar) == nil)
    }

    @Test func aDayTheItemDoesNotFallOnHasANotDueLineInPlaceOfTheBar() throws {
        let planner = makePlanner()
        let weekdays = try named(planner, "Plan tomorrow")
        let saturday = try #require(DayString("2026-10-03"))
        let (ctx, _, verbs) = sheet(planner, weekdays, on: saturday)

        #expect(ctx.occurrence == .absent)
        #expect(verbs.notDue)
        #expect(verbs.bar.isEmpty)
        #expect(verbs.menu == [.pause, .pauseUntil, .delete])
        #expect(ItemSheetModel.notDueLine(ctx) == "Not due Sat, Oct 3")
        #expect(ItemSheetModel.dayCaption(weekdays, ctx, bar: verbs.bar) == nil)
    }

    /// A subtask's page ticks it and deletes it, and nothing else: it has no
    /// day of its own to skip, carry or pause on.
    @Test func aSubtaskIsOfferedTheTickAndDelete() throws {
        let planner = makePlanner()
        let subtask = try named(planner, "Write the three bets")
        let (_, offered, verbs) = sheet(planner, subtask)

        #expect(offered == [.tick, .delete])
        #expect(verbs.bar == [.tick])
        #expect(verbs.menu == [.delete])
    }

    /// Paused today, in the zone handed in: Resume alone in the bar, Delete
    /// alone behind ⋯, and the note says until when.
    @Test func aPausedItemOffersResumeAloneAndSaysUntilWhen() throws {
        let planner = makePlanner()
        var journal = try named(planner, "Journal")
        journal.pausedAt = "2026-09-30T12:00:00.000Z"
        journal.pausedUntil = "2026-10-08"
        let today = "2026-10-01"
        let ctx = VerbContext(dateStr: today, todayStr: today, timeZone: "UTC",
                              occurrence: occurrenceOn(journal, on: today, today: today, timeZone: "UTC"))
        let verbs = ItemSheetModel.verbs(journal, ctx, offered: eligibleVerbs(journal, ctx))

        #expect(verbs.bar == [.resume])
        #expect(verbs.menu == [.delete])
        #expect(ItemSheetModel.pauseNote(journal, today: today, timeZone: "UTC") == "Paused until Oct 8")
        // Not yet begun the day before, and over on the day it ends: no note.
        #expect(ItemSheetModel.pauseNote(journal, today: "2026-09-29", timeZone: "UTC") == nil)
        #expect(ItemSheetModel.pauseNote(journal, today: "2026-10-08", timeZone: "UTC") == nil)

        journal.pausedUntil = nil
        #expect(ItemSheetModel.pauseNote(journal, today: today, timeZone: "UTC") == "Paused")
    }

    @Test func aSkipAndItsUnskipShareASlot() {
        #expect(SheetVerb.skip.slotID == SheetVerb.unskip.slotID)
        #expect(SheetVerb.pause.slotID == SheetVerb.resume.slotID)
        #expect(SheetVerb.pause.slotID != SheetVerb.pauseUntil.slotID)
        #expect(SheetVerb.pauseUntil.verb == VerbID.pause)
        #expect(SheetVerb.delete.verb == VerbID.delete)
        #expect(SheetVerb.delete.slotID == "delete")
    }

    /// Reset streak is offered to a habit with a streak, and lives in the
    /// streak chip's popover alone: the bar and ⋯ are what they would be
    /// without it, done today or not.
    @Test func resetStreakNeverEntersTheBarOrMore() throws {
        let planner = makePlanner()
        for title in ["Meds", "Journal"] {   // done today with 41; not yet, with 3
            let habit = try named(planner, title)
            let (ctx, offered, verbs) = sheet(planner, habit)
            #expect(offered.contains(.resetStreak))
            #expect(verbs == ItemSheetModel.verbs(habit, ctx, offered: offered.filter { $0 != .resetStreak }))
            #expect(verbLabel(.resetStreak, habit, ctx) == "Reset streak")
        }
    }

    // MARK: ⋯ and Delete

    /// Delete is offered on everything, so ⋯ always shows, Delete last: a
    /// habit's ⋯ is Delete alone, a day the item doesn't fall on is Pause,
    /// Pause until… and Delete, and so is ⋯ on a one-off (its bar holds the
    /// rest). The view draws a divider before Delete when anything is above
    /// it.
    @Test func moreEndsWithDeleteWhateverTheItem() throws {
        let planner = makePlanner()
        let journal = try named(planner, "Journal")
        let weekdays = try named(planner, "Plan tomorrow")
        let roadmap = try named(planner, "Draft Q4 roadmap")
        let saturday = try #require(DayString("2026-10-03"))

        #expect(sheet(planner, journal).verbs.menu == [.delete])
        #expect(sheet(planner, weekdays, on: saturday).verbs.menu == [.pause, .pauseUntil, .delete])
        #expect(sheet(planner, roadmap).verbs.menu.last == SheetVerb.delete)
        #expect(sheet(planner, roadmap).verbs.bar.contains(SheetVerb.delete) == false)
        #expect(ItemSheetModel.menuTitle(.delete) == "Delete")
        #expect(ItemSheetModel.symbol(.delete, roadmap, planner.verbContext(for: roadmap, on: planner.today))
                == "trash")
    }

    /// A server whose `writes` lacks `delete` offers no Delete, and ⋯ is part
    /// 1's: empty (and so hidden) for a habit, the pause family for a one-off.
    @Test func withoutTheDeleteWriteMoreIsPartOnes() throws {
        let planner = makePlanner()
        let journal = try named(planner, "Journal")
        let roadmap = try named(planner, "Draft Q4 roadmap")
        let habit = sheet(planner, journal)
        let task = sheet(planner, roadmap)

        let habitVerbs = ItemSheetModel.verbs(journal, habit.ctx, offered: habit.offered.filter { $0 != .delete })
        let taskVerbs = ItemSheetModel.verbs(roadmap, task.ctx, offered: task.offered.filter { $0 != .delete })
        #expect(habitVerbs.menu.isEmpty)
        #expect(taskVerbs.menu == [.pause, .pauseUntil])
    }

    /// The confirm's words: lib/item-verbs.ts `deleteConfirmTitle`, the
    /// registry's description (to the Trash for 30 days; a habit's history
    /// with it), and the subtasks that go too, as deleteTask takes them.
    @Test func deletesWordsNameTheTypeAndWhatGoesWithIt() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")   // two subtasks
        let task = caps(roadmap.typeName)

        #expect(ItemSheetModel.deleteMenuTitle(typeLabel: task.label) == "Delete task")
        #expect(ItemSheetModel.deleteConfirmTitle(typeLabel: task.label) == "Delete task?")
        #expect(ItemSheetModel.cascadeCount(roadmap, in: planner.items) == 2)
        #expect(ItemSheetModel.deleteConfirmMessage(roadmap, task, childCount: 2)
                == "Moves \"Draft Q4 roadmap\" to Trash for 30 days, then deletes it for good. "
                + "Its 2 subtasks go with it.")
        #expect(ItemSheetModel.deleteConfirmMessage(roadmap, task, childCount: 1)
                == "Moves \"Draft Q4 roadmap\" to Trash for 30 days, then deletes it for good. "
                + "Its subtask goes with it.")
        #expect(ItemSheetModel.deleteConfirmMessage(roadmap, task, childCount: 0)
                == "Moves \"Draft Q4 roadmap\" to Trash for 30 days, then deletes it for good.")
        #expect(ItemSheetModel.deletedAnnouncement(typeLabel: task.label) == "Task deleted")

        let meds = try named(planner, "Meds")
        let habit = caps(meds.typeName)
        #expect(ItemSheetModel.deleteMenuTitle(typeLabel: habit.label) == "Delete habit")
        #expect(ItemSheetModel.deleteConfirmTitle(typeLabel: habit.label) == "Delete habit?")
        #expect(ItemSheetModel.cascadeCount(meds, in: planner.items) == 0)
        #expect(ItemSheetModel.deleteConfirmMessage(meds, habit, childCount: 0)
                == "Moves \"Meds\" and its history to Trash for 30 days, then deletes them for good.")

        // A subtask is a task, and takes nothing with it.
        let bets = try named(planner, "Write the three bets")
        let subtask = caps(bets.typeName)
        #expect(ItemSheetModel.deleteConfirmTitle(typeLabel: subtask.label) == "Delete task?")
        #expect(ItemSheetModel.cascadeCount(bets, in: planner.items) == 0)
        #expect(ItemSheetModel.deleteConfirmMessage(bets, subtask, childCount: 0)
                == "Moves \"Write the three bets\" to Trash for 30 days, then deletes it for good.")
    }

    /// A habit's delete never cascades, even over an item that names it as
    /// its parent; a task's takes its task-like children, however their
    /// parent's id is written, and never a habit.
    @Test func onlyATasksDeleteTakesItsSubtasks() throws {
        let planner = makePlanner()
        let meds = try named(planner, "Meds")
        let roadmap = try named(planner, "Draft Q4 roadmap")   // two subtasks
        let underHabit = Item(id: UUID(), type: "task", title: "Refill", status: "pending",
                              parentItemId: meds.id.uuidString.lowercased())
        let habitChild = Item(id: UUID(), type: "habit", title: "Review", status: "pending",
                              parentItemId: roadmap.id.uuidString.lowercased())
        let upperCased = Item(id: UUID(), type: "task", title: "Check the numbers", status: "pending",
                              parentItemId: roadmap.id.uuidString.uppercased())
        let items = planner.items + [underHabit, habitChild, upperCased]

        #expect(ItemSheetModel.cascadeCount(meds, in: items) == 0)
        #expect(ItemSheetModel.cascadeCount(roadmap, in: items) == 3)
    }

    /// A custom type is named with the user's own label when the payload
    /// carries it (`itemTypes`), and with its slug, capitalised, when it
    /// doesn't (the sample, an older server). The confirm's title is DsulCore
    /// `deleteConfirmTitle`, which RegistryCapsFixtureTests pins to caps.json's
    /// words for these labels ("Delete side quest?", "Delete book club?").
    @Test func aCustomTypeIsNamedWithItsOwnLabel() {
        let quest = Item(id: UUID(), type: "custom", customType: "side_quest", title: "Find the cave",
                         status: "pending")
        let labels = [
            "side_quest": ItemTypeLabel(name: "side_quest", label: "Side quest", labelPlural: "Side quests"),
            "book-club": ItemTypeLabel(name: "book-club", label: "Book Club", labelPlural: "Book Clubs"),
        ]
        let labelled = caps(quest.typeName, labels: labels)
        #expect(ItemSheetModel.eyebrow(typeLabel: labelled.label, routineNames: []) == "Side quest")
        #expect(labelled.titlePlaceholder == "Add a side quest\u{2026}")
        #expect(ItemSheetModel.deleteMenuTitle(typeLabel: labelled.label) == "Delete side quest")
        #expect(ItemSheetModel.deleteConfirmTitle(typeLabel: labelled.label) == "Delete side quest?")
        #expect(ItemSheetModel.deleteConfirmTitle(typeLabel: caps("book-club", labels: labels).label)
                == "Delete book club?")
        #expect(ItemSheetModel.deleteConfirmMessage(quest, labelled, childCount: 1)
                == "Moves \"Find the cave\" to Trash for 30 days, then deletes it for good. "
                + "Its subtask goes with it.")
        #expect(ItemSheetModel.deletedAnnouncement(typeLabel: labelled.label) == "Side quest deleted")

        let unlabelled = caps(quest.typeName)
        #expect(ItemSheetModel.eyebrow(typeLabel: unlabelled.label, routineNames: []) == "Side_quest")
        #expect(ItemSheetModel.deleteConfirmTitle(typeLabel: unlabelled.label) == "Delete side_quest?")
        #expect(ItemSheetModel.deleteConfirmMessage(quest, unlabelled, childCount: 0)
                == "Moves \"Find the cave\" to Trash for 30 days, then deletes it for good.")
    }

    // MARK: The day picker

    /// Reschedule's picker is titled with the bar's own word: Schedule for an
    /// undated item, Reschedule for a dated one, each with its verb on the
    /// button. Pause until's says the day picked is the day it comes back.
    @Test func theDayPickerUsesTheBarsWord() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")
        let bank = try named(planner, "Call the bank")   // a braindump row, undated
        let roadmapCtx = planner.verbContext(for: roadmap, on: planner.today)
        let bankCtx = planner.verbContext(for: bank, on: planner.today)

        #expect(ItemSheetModel.barLabel(.reschedule, bank, bankCtx) == "Schedule")
        #expect(ItemSheetModel.rescheduleWords(bank, bankCtx)
                == DayPickWords(title: "Schedule", confirmVerb: "Schedule for", note: nil))
        #expect(ItemSheetModel.rescheduleWords(roadmap, roadmapCtx)
                == DayPickWords(title: "Reschedule", confirmVerb: "Move to", note: nil))
        #expect(ItemSheetModel.pauseUntilWords.note
                == "It comes back on the day you pick, on its own. Nothing is lost meanwhile. "
                + "Your streak and history stay exactly as they are.")
    }

    /// A Pause until picker confirmed after midnight: a day that is now today,
    /// or before it, is refused with the banner's words; a later one isn't.
    @Test func pauseUntilRefusesADayNoLongerAfterToday() throws {
        let today = try #require(DayString("2026-10-02"))
        #expect(ItemSheetModel.pauseUntilRefusal(today, today: today)
                == "That day is no longer after today, so nothing was paused.")
        #expect(ItemSheetModel.pauseUntilRefusal(today.adding(days: -1), today: today) != nil)
        #expect(ItemSheetModel.pauseUntilRefusal(today.adding(days: 1), today: today) == nil)
    }

    // MARK: The title

    /// A counted habit's tally under its title, as the web panel counts it:
    /// the day's count, or the target once the day is done with none stored.
    /// None for a habit done once a day or a type that keeps no tally. The
    /// circle's label says the same count.
    @Test func aCountedHabitsTallyCountsAsTheWebPanelDoes() throws {
        let planner = makePlanner()
        var journal = try named(planner, "Journal")   // done the three days before today
        let today = planner.today.description
        #expect(ItemSheetModel.tally(journal, on: today) == nil)

        journal.timesPerDay = 3
        #expect(ItemSheetModel.tally(journal, on: today) == "0/3")
        journal.dailyCounts = [today: 1]
        #expect(ItemSheetModel.tally(journal, on: today) == "1/3")
        #expect(ItemSheetModel.spokenLabel(.tick, journal, planner.verbContext(for: journal, on: planner.today))
                == "Count one (1/3)")
        #expect(ItemSheetModel.tally(journal, on: "2026-09-30") == "3/3")

        var roadmap = try named(planner, "Draft Q4 roadmap")
        roadmap.timesPerDay = 3
        #expect(ItemSheetModel.tally(roadmap, on: today) == nil)
    }

    /// The tally and the day the circle ticks share the line under the title.
    @Test func theTallyAndTheDayShareTheLineUnderTheTitle() {
        #expect(ItemSheetModel.titleNote(tally: "1/3", dayNote: "For Wed, Sep 30") == "1/3 \u{00B7} For Wed, Sep 30")
        #expect(ItemSheetModel.titleNote(tally: "1/3", dayNote: nil) == "1/3")
        #expect(ItemSheetModel.titleNote(tally: nil, dayNote: "For Wed, Sep 30") == "For Wed, Sep 30")
        #expect(ItemSheetModel.titleNote(tally: nil, dayNote: nil) == nil)
    }

    // MARK: Typing

    /// A typed Return, at the end or in the middle, leaves the title as it
    /// was and ends the edit, which sends it.
    @Test func aTypedReturnCommitsTheTitle() {
        let atEnd = ItemSheetModel.titleEntry(previous: "Draft Q4 plan", next: "Draft Q4 plan\n", limit: 500)
        #expect(atEnd.draft == "Draft Q4 plan")
        #expect(atEnd.commit)

        let inside = ItemSheetModel.titleEntry(previous: "Draft plan", next: "Draft\n plan", limit: 500)
        #expect(inside.draft == "Draft plan")
        #expect(inside.commit)

        // An autocorrection arriving with the Return is kept.
        let corrected = ItemSheetModel.titleEntry(previous: "Call teh", next: "Call the\n", limit: 500)
        #expect(corrected.draft == "Call the")
        #expect(corrected.commit)
    }

    /// A pasted line break is a space, as the web's one-line title reads it,
    /// and the edit goes on.
    @Test func aPastedLineBreakBecomesASpace() {
        let paste = ItemSheetModel.titleEntry(previous: "Call ", next: "Call the bank\nabout the card", limit: 500)
        #expect(paste.draft == "Call the bank about the card")
        #expect(!paste.commit)

        let twoLines = ItemSheetModel.titleEntry(previous: "", next: "One\nTwo\n", limit: 500)
        #expect(twoLines.draft == "One Two ")
        #expect(!twoLines.commit)
    }

    /// Typing stops at 500 UTF-16 units, or at the stored title's length when
    /// that is longer: a stored title may stay as long, never grow. The cut
    /// takes whole characters from what was put in, never from what was there.
    @Test func typingStopsAtTheCapOrTheStoredLength() {
        let full = String(repeating: "a", count: 499)
        #expect(growthLimit(cap: EditLimits.title, stored: "Groceries") == 500)
        #expect(ItemSheetModel.titleEntry(previous: full, next: full + "bc", limit: 500).draft == full + "b")
        #expect(ItemSheetModel.titleEntry(previous: full, next: full + "\u{1F600}", limit: 500).draft == full)

        let middle = ItemSheetModel.titleEntry(previous: "ab", next: "a" + String(repeating: "z", count: 600) + "b",
                                               limit: 500)
        #expect(middle.draft.utf16.count == 500)
        #expect(String(middle.draft.prefix(2)) == "az")
        #expect(String(middle.draft.suffix(2)) == "zb")

        let stored = String(repeating: "x", count: 700)
        let limit = growthLimit(cap: EditLimits.title, stored: stored)
        #expect(limit == 700)
        let shorter = String(repeating: "x", count: 650)
        #expect(ItemSheetModel.titleEntry(previous: stored, next: shorter, limit: limit).draft == shorter)
        #expect(ItemSheetModel.titleEntry(previous: stored, next: stored + "y", limit: limit).draft == stored)
    }

    /// A line break the web stored stays while the title is typed in, and
    /// becomes a space only once the change is sent.
    @Test func aStoredLineBreakStaysUntilTheTitleIsSent() {
        let stored = "Plan the\nweekend"
        let typed = ItemSheetModel.titleEntry(previous: stored, next: stored + "!", limit: 500)
        #expect(typed.draft == "Plan the\nweekend!")
        #expect(!typed.commit)
        #expect(ItemSheetModel.commit(draft: typed.draft, seed: stored, stored: stored, kind: .title)
                == ItemEdit.title("Plan the weekend!"))
    }

    /// Notes take Return as a line break, and stop growing at 50,000.
    @Test func notesKeepTheirLineBreaksAndStopAtTheCap() {
        #expect(ItemSheetModel.notesEntry(previous: "Oat milk", next: "Oat milk\n", limit: 50_000) == "Oat milk\n")
        let full = String(repeating: "n", count: 50_000)
        #expect(ItemSheetModel.notesEntry(previous: full, next: full + "more", limit: 50_000) == full)
        #expect(ItemSheetModel.notesEntry(previous: full, next: "n" + full, limit: 50_000) == full)
    }

    // MARK: Leaving a field

    /// Focusing a field and leaving it sends nothing, whatever is stored: a
    /// 700-character title, notes ending in a line break, a title the web
    /// stored with one.
    @Test func focusingAndLeavingSendsNothing() {
        let long = String(repeating: "t", count: 700)
        #expect(ItemSheetModel.commit(draft: long, seed: long, stored: long, kind: .title) == nil)
        let notes = "Oat milk, eggs.\n"
        #expect(ItemSheetModel.commit(draft: notes, seed: notes, stored: notes, kind: .notes) == nil)
        let broken = "Plan the\nweekend"
        #expect(ItemSheetModel.commit(draft: broken, seed: broken, stored: broken, kind: .title) == nil)
    }

    /// A blank title sends nothing (the field shows the stored one again),
    /// and neither does a change that cleans back to what is stored.
    @Test func aBlankOrUnchangedTitleSendsNothing() {
        #expect(ItemSheetModel.commit(draft: "", seed: "Groceries", stored: "Groceries", kind: .title) == nil)
        #expect(ItemSheetModel.commit(draft: " \n ", seed: "Groceries", stored: "Groceries", kind: .title) == nil)
        #expect(ItemSheetModel.commit(draft: "Groceries ", seed: "Groceries", stored: "Groceries", kind: .title) == nil)
        #expect(ItemSheetModel.commit(draft: "Oat milk ", seed: "Oat milk", stored: "Oat milk", kind: .notes) == nil)
    }

    /// A change is sent cleaned: trimmed, and empty notes cleared. A title
    /// stored past the cap may be shortened and still sent whole.
    @Test func aChangeIsSentCleaned() {
        #expect(ItemSheetModel.commit(draft: "  Groceries and flowers ", seed: "Groceries", stored: "Groceries",
                                      kind: .title) == ItemEdit.title("Groceries and flowers"))
        #expect(ItemSheetModel.commit(draft: "Oat milk\n\n", seed: "", stored: nil, kind: .notes)
                == ItemEdit.notes("Oat milk"))
        #expect(ItemSheetModel.commit(draft: " \n", seed: "Oat milk", stored: "Oat milk", kind: .notes)
                == ItemEdit.notes(nil))

        let long = String(repeating: "t", count: 700)
        let shorter = String(repeating: "t", count: 650)
        #expect(ItemSheetModel.commit(draft: shorter, seed: long, stored: long, kind: .title)
                == ItemEdit.title(shorter))
    }

    /// The cap is the stored text's, as the route measures it, never the
    /// seed's. The scene went inactive mid-edit with trailing spaces typed:
    /// the trimmed title was sent and stored, and the seed kept the raw
    /// draft. A draft as long as that seed is cut to what is stored, so the
    /// route never refuses it. Notes past 50,000 the same.
    @Test func theCapIsTheStoredTextsNotTheSeeds() {
        let title = String(repeating: "a", count: 695)
        let titleSeed = title + "     "
        #expect(ItemSheetModel.commit(draft: String(repeating: "a", count: 700), seed: titleSeed, stored: title,
                                      kind: .title) == nil)
        let retitled = "b" + String(repeating: "a", count: 699)
        #expect(ItemSheetModel.commit(draft: retitled, seed: titleSeed, stored: title, kind: .title)
                == ItemEdit.title(String(retitled.prefix(695))))

        let notes = String(repeating: "n", count: 50_005)
        let notesSeed = notes + "\n\n\n\n\n"
        #expect(ItemSheetModel.commit(draft: String(repeating: "n", count: 50_010), seed: notesSeed, stored: notes,
                                      kind: .notes) == nil)
        let renoted = "m" + String(repeating: "n", count: 50_009)
        #expect(ItemSheetModel.commit(draft: renoted, seed: notesSeed, stored: notes, kind: .notes)
                == ItemEdit.notes(String(renoted.prefix(50_005))))
    }

    /// "Notes" where there are none, a button that "Edits the notes"; text
    /// past what one request may carry is shown, not edited.
    @Test func theNotesPlaceholderAndItsHint() {
        #expect(ItemSheetModel.notesPlaceholder == "Notes")
        #expect(ItemSheetModel.notesHint == "Edits the notes")
        #expect(ItemSheetModel.tooLongNote == "Too long to edit on the phone.")
        #expect(ItemSheetModel.tooLongToEdit(nil, kind: .notes) == false)
        #expect(ItemSheetModel.tooLongToEdit(String(repeating: "n", count: 200_000), kind: .notes) == false)
        #expect(ItemSheetModel.tooLongToEdit(String(repeating: "n", count: 200_001), kind: .notes) == true)
        #expect(ItemSheetModel.tooLongToEdit(String(repeating: "t", count: 10_000), kind: .title) == false)
        #expect(ItemSheetModel.tooLongToEdit(String(repeating: "t", count: 10_001), kind: .title) == true)
    }

    // MARK: Adding a subtask

    /// A typed Return adds the whole line, wherever the caret was, and the
    /// field empties for the next one; an autocorrection that arrives with
    /// the Return is kept.
    @Test func aTypedReturnAddsTheLine() {
        let added = SubtaskStep(titles: ["Eggs"], draft: "", end: false, capped: false, lastReturn: .fromText)
        #expect(ItemSheetModel.subtaskEntry(previous: "Eggs", next: "Eggs\n", lastReturn: .none) == added)
        #expect(ItemSheetModel.subtaskEntry(previous: "  Eggs ", next: "  Eggs \n", lastReturn: .none) == added)

        let inside = ItemSheetModel.subtaskEntry(previous: "Eggs and milk", next: "Eggs\n and milk", lastReturn: .none)
        #expect(inside == SubtaskStep(titles: ["Eggs and milk"], draft: "", end: false, capped: false,
                                      lastReturn: .fromText))

        let corrected = ItemSheetModel.subtaskEntry(previous: "Call teh", next: "Call the\n", lastReturn: .none)
        #expect(corrected.titles == ["Call the"])
        #expect(corrected.lastReturn == .fromText)
    }

    /// Return on an empty field, or one of spaces, ends entry and adds
    /// nothing.
    @Test func aReturnOnAnEmptyFieldEndsEntry() {
        let ended = SubtaskStep(titles: [], draft: "", end: true, capped: false, lastReturn: .none)
        #expect(ItemSheetModel.subtaskEntry(previous: "", next: "\n", lastReturn: .none) == ended)
        #expect(ItemSheetModel.subtaskEntry(previous: "  ", next: "  \n", lastReturn: .none) == ended)
        #expect(ItemSheetModel.subtaskSubmit(draft: "", lastReturn: .none) == ended)
        #expect(ItemSheetModel.subtaskSubmit(draft: " \n ", lastReturn: .none) == ended)
        // A second Return that only `.onSubmit` reports, on the field the
        // first one emptied.
        #expect(ItemSheetModel.subtaskSubmit(draft: "", lastReturn: .fromSubmit("Eggs")) == ended)
    }

    /// The field's own write of the draft a Return answered puts nothing in,
    /// so it keeps which report acted: the `.onSubmit` still to come finds
    /// the Return taken. A deletion is the same.
    @Test func theFieldsOwnWriteKeepsWhichReportActed() {
        #expect(ItemSheetModel.subtaskEntry(previous: "Eggs\n", next: "", lastReturn: .fromText)
                == SubtaskStep(titles: [], draft: "", end: false, capped: false, lastReturn: .fromText))
        #expect(ItemSheetModel.subtaskEntry(previous: "Milk", next: "Mil", lastReturn: .none)
                == SubtaskStep(titles: [], draft: "Mil", end: false, capped: false, lastReturn: .none))
    }

    /// One Return, one subtask, whichever way iOS reports it: the line break
    /// first and `.onSubmit` after, `.onSubmit` first and a late line break
    /// after (on the emptied field, or on the line it took), or `.onSubmit`
    /// alone. Each keeps entry going and leaves the next Return new.
    @Test func oneReturnAddsOnceWhicheverWayItIsReported() {
        // The line break first.
        let typed = ItemSheetModel.subtaskEntry(previous: "Eggs", next: "Eggs\n", lastReturn: .none)
        #expect(typed.titles == ["Eggs"])
        let ownWrite = ItemSheetModel.subtaskEntry(previous: "Eggs\n", next: "", lastReturn: typed.lastReturn)
        let thenSubmit = ItemSheetModel.subtaskSubmit(draft: ownWrite.draft, lastReturn: ownWrite.lastReturn)
        #expect(thenSubmit == SubtaskStep(titles: [], draft: "", end: false, capped: false, lastReturn: .none))

        // `.onSubmit` first.
        let submitted = ItemSheetModel.subtaskSubmit(draft: "Eggs", lastReturn: .none)
        #expect(submitted == SubtaskStep(titles: ["Eggs"], draft: "", end: false, capped: false,
                                         lastReturn: .fromSubmit("Eggs")))
        let letGo = SubtaskStep(titles: [], draft: "", end: false, capped: false, lastReturn: .none)
        #expect(ItemSheetModel.subtaskEntry(previous: "", next: "\n", lastReturn: submitted.lastReturn) == letGo)
        #expect(ItemSheetModel.subtaskEntry(previous: "", next: "Eggs\n", lastReturn: submitted.lastReturn)
                == letGo)

        // `.onSubmit` alone: a later line pasted with a break is its own.
        #expect(ItemSheetModel.subtaskEntry(previous: "", next: "Milk\n", lastReturn: submitted.lastReturn)
                == SubtaskStep(titles: ["Milk"], draft: "", end: false, capped: false, lastReturn: .fromText))
        // Typing after `.onSubmit` makes the next Return new.
        #expect(ItemSheetModel.subtaskEntry(previous: "", next: "M", lastReturn: submitted.lastReturn)
                == SubtaskStep(titles: [], draft: "M", end: false, capped: false, lastReturn: .none))
    }

    /// A pasted list adds one subtask per line, markers gone, and leaves what
    /// was typed in the field, where the web's clears it. "\r\n" is one
    /// break.
    @Test func aPastedListAddsALineEachAndKeepsWhatWasTyped() {
        let list = ItemSheetModel.subtaskEntry(previous: "Buy ", next: "Buy - Eggs\n- Milk\n- Bread", lastReturn: .none)
        #expect(list == SubtaskStep(titles: ["Eggs", "Milk", "Bread"], draft: "Buy ", end: false, capped: false,
                                    lastReturn: .none))

        let windows = ItemSheetModel.subtaskEntry(previous: "", next: "a\r\nb", lastReturn: .none)
        #expect(windows.titles == ["a", "b"])
        #expect(windows.draft == "")

        // A paste after `.onSubmit` is a paste.
        #expect(ItemSheetModel.subtaskEntry(previous: "", next: "1. Eggs\n2. Milk",
                                            lastReturn: .fromSubmit("Eggs")).titles == ["Eggs", "Milk"])
    }

    /// Past 500 lines, the first 500 and `capped`, for the banner; each line
    /// cut to 500 UTF-16 units, never splitting an emoji.
    @Test func aPasteIsCappedByLineAndByLength() {
        let lines = (1...501).map { "Item \($0)" }.joined(separator: "\n")
        let capped = ItemSheetModel.subtaskEntry(previous: "", next: lines, lastReturn: .none)
        #expect(capped.titles.count == 500)
        #expect(capped.titles.first == "Item 1")
        #expect(capped.titles.last == "Item 500")
        #expect(capped.capped)

        let long = String(repeating: "x", count: 600)
        let emoji = String(repeating: "y", count: 499) + "\u{1F600}"
        let cut = ItemSheetModel.subtaskEntry(previous: "", next: long + "\n" + emoji + "\nb", lastReturn: .none)
        #expect(cut.titles == [String(repeating: "x", count: 500), String(repeating: "y", count: 499), "b"])
        #expect(!cut.capped)
    }

    /// One line pasted with no break is typed text. One pasted with a break
    /// at its end is added at once, as a typed Return would be (the web's
    /// input keeps it): the line it lands on is the subtask.
    @Test func aOneLinePasteIsTextUnlessItEndsInABreak() {
        #expect(ItemSheetModel.subtaskEntry(previous: "Buy ", next: "Buy Eggs", lastReturn: .none)
                == SubtaskStep(titles: [], draft: "Buy Eggs", end: false, capped: false, lastReturn: .none))
        #expect(ItemSheetModel.subtaskEntry(previous: "Buy ", next: "Buy Eggs\n", lastReturn: .none)
                == SubtaskStep(titles: ["Buy Eggs"], draft: "", end: false, capped: false, lastReturn: .fromText))
    }

    /// A paste that isn't a list (one line that survives, with a break inside
    /// it) is text with its breaks as spaces; typing stops at 500 UTF-16
    /// units, cut from what was put in.
    @Test func aBreakInsideAPasteIsASpaceAndTypingStopsAtTheCap() {
        #expect(ItemSheetModel.subtaskEntry(previous: "Buy ", next: "Buy \nEggs", lastReturn: .none).draft
                == "Buy  Eggs")
        #expect(ItemSheetModel.subtaskEntry(previous: "Buy ", next: "Buy Eggs\n\n", lastReturn: .none)
                == SubtaskStep(titles: [], draft: "Buy Eggs  ", end: false, capped: false, lastReturn: .none))

        let full = String(repeating: "a", count: 499)
        #expect(EditLimits.newTitle == 500)
        #expect(ItemSheetModel.subtaskEntry(previous: full, next: full + "bc", lastReturn: .none).draft == full + "b")
        #expect(ItemSheetModel.subtaskEntry(previous: full, next: full + "\u{1F600}", lastReturn: .none).draft == full)
    }

    /// The subtask field is never an edit of anything stored, and never too
    /// long to type in.
    @Test func theSubtaskFieldIsNeverAnEdit() {
        #expect(ItemSheetModel.commit(draft: "Eggs", seed: "", stored: nil, kind: .subtask) == nil)
        #expect(ItemSheetModel.commit(draft: "Eggs", seed: "", stored: "Groceries", kind: .subtask) == nil)
        #expect(ItemSheetModel.tooLongToEdit(String(repeating: "s", count: 20_000), kind: .subtask) == false)
    }

    /// The row, the field and what VoiceOver hears once subtasks are added.
    @Test func theSubtaskWords() {
        #expect(ItemSheetModel.subtaskRowTitle == "Add a subtask")
        #expect(ItemSheetModel.subtaskFieldLabel == "New subtask")
        #expect(ItemSheetModel.subtaskPlaceholder == "Add subtask\u{2026}")
        #expect(ItemSheetModel.subtaskAddedAnnouncement([]) == nil)
        #expect(ItemSheetModel.subtaskAddedAnnouncement(["Eggs"]) == "Added Eggs")
        #expect(ItemSheetModel.subtaskAddedAnnouncement(["Eggs", "Milk", "Bread"]) == "Added 3 subtasks")
    }

    // MARK: The header and the chips

    @Test func theEyebrowNamesTheTypeAndTheFirstRoutine() throws {
        let planner = makePlanner()
        let meds = try named(planner, "Meds")
        let roadmap = try named(planner, "Draft Q4 roadmap")

        #expect(ItemSheetModel.eyebrow(typeLabel: planner.caps(for: meds).label,
                                       routineNames: planner.routineNames(for: meds.id))
                == "Habit \u{00B7} Morning routine")
        #expect(ItemSheetModel.eyebrow(typeLabel: planner.caps(for: roadmap).label,
                                       routineNames: planner.routineNames(for: roadmap.id)) == "Task")
    }

    @Test func aTasksChipsFollowTheWebPanelsOrder() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")
        let chips = ItemSheetModel.chips(roadmap, today: planner.today, timeFormat: .twelveHour,
                                         routineNames: [], seasonNames: [])

        #expect(chips.map(\.kind) == [.priority, .date, .time, .project])
        #expect(chips.map(\.text) == ["High", "Today", "9:00\u{2013}11:00 am", "Work"])
        #expect(chips[2].spoken == "Time: 9:00 to 11:00 am")
        #expect(chips[3].systemImage == nil)

        let dentist = try named(planner, "Call the dentist")
        let dentistChips = ItemSheetModel.chips(dentist, today: planner.today, timeFormat: .twelveHour,
                                                routineNames: [], seasonNames: [])
        #expect(dentistChips.map(\.text) == ["Medium", "Today", "3:00\u{2013}3:15 pm", "2:45 pm", "Home"])
    }

    /// An untimed task in Anytime has no Time chip: "Anytime" says nothing.
    @Test func anAnytimeTaskHasNoTimeChip() throws {
        let planner = makePlanner()
        let groceries = try named(planner, "Groceries")
        let chips = ItemSheetModel.chips(groceries, today: planner.today, timeFormat: .twelveHour,
                                         routineNames: [], seasonNames: [])
        #expect(chips.map(\.kind) == [.date, .project])
    }

    @Test func aHabitsChipsCarryItsBucketRepeatReminderAndRoutine() throws {
        let planner = makePlanner()
        let meds = try named(planner, "Meds")
        let chips = ItemSheetModel.chips(meds, today: planner.today, timeFormat: .twelveHour,
                                         routineNames: planner.routineNames(for: meds.id),
                                         seasonNames: planner.seasonNames(for: meds.id))

        #expect(chips.map(\.kind) == [.time, .repeats, .reminder, .routine])
        #expect(chips.map(\.text) == ["Morning", "Daily", "After I pour my coffee \u{00B7} 8:00 am", "Morning routine"])
        #expect(chips[2].spoken == "Reminder: After I pour my coffee, 8:00 am")
        #expect(chips[3].spoken == "Routine: Morning routine")
    }

    @Test func timeRangesReadAsTheUsersClockDoes() {
        #expect(ItemSheetModel.timeRange(startMin: 9 * 60, durationMin: 120, timeFormat: .twelveHour)
                == "9:00\u{2013}11:00 am")
        #expect(ItemSheetModel.timeRange(startMin: 11 * 60, durationMin: 120, timeFormat: .twelveHour)
                == "11:00 am\u{2013}1:00 pm")
        #expect(ItemSheetModel.timeRange(startMin: 23 * 60, durationMin: 120, timeFormat: .twelveHour)
                == "11:00 pm\u{2013}1:00 am")
        #expect(ItemSheetModel.timeRange(startMin: 9 * 60, durationMin: 120, timeFormat: .twentyFourHour)
                == "09:00\u{2013}11:00")
        #expect(ItemSheetModel.timeRange(startMin: 15 * 60, durationMin: 0, timeFormat: .twelveHour) == "3:00 pm")
    }

    // MARK: The streak chip

    @Test func theStreakChipDrawsThisWeek() throws {
        let planner = makePlanner()
        let meds = try named(planner, "Meds")   // done today and the two days before
        let sunday = ItemSheetModel.weekDots(meds, today: planner.today, weekStartDay: .sunday)
        #expect(sunday == [.rest, .rest, .done, .done, .done, .rest, .rest])
        #expect(ItemSheetModel.streakSpoken(streak: meds.streak ?? 0, dots: sunday) == "Streak 41; this week: 3 done")

        let monday = ItemSheetModel.weekDots(meds, today: planner.today, weekStartDay: .monday)
        #expect(monday == [.rest, .done, .done, .done, .rest, .rest, .rest])
    }

    @Test func todayIsARingUntilItIsTickedAndSkipsAreCounted() throws {
        let planner = makePlanner()
        var journal = try named(planner, "Journal")   // done the three days before today
        journal.skippedDates = ["2026-09-27"]
        let dots = ItemSheetModel.weekDots(journal, today: planner.today, weekStartDay: .sunday)

        #expect(dots == [.skipped, .done, .done, .done, .today, .rest, .rest])
        #expect(ItemSheetModel.streakSpoken(streak: 3, dots: dots) == "Streak 3; this week: 3 done, 1 skipped")
    }

    /// The chip's hint says what a tap shows; the popover's run is the web's
    /// flame tooltip; Reset's confirm is in sentence case with the web's
    /// message; and the popover is a sheet at the accessibility sizes.
    @Test func theStreakPopoversWords() {
        #expect(ItemSheetModel.streakHint(resetOffered: false) == "Shows this week")
        #expect(ItemSheetModel.streakHint(resetOffered: true) == "Shows this week, and Reset streak")
        #expect(ItemSheetModel.streakRun(0) == "No streak yet")
        #expect(ItemSheetModel.streakRun(1) == "1 day in a row")
        #expect(ItemSheetModel.streakRun(41) == "41 days in a row")
        #expect(ItemSheetModel.resetConfirmTitle == "Reset streak?")
        #expect(ItemSheetModel.resetConfirmMessage
                == "This will reset your streak counter to 0 days. Your completion history stays, so "
                + "days you already checked off remain checked.")
        #expect(ItemSheetModel.streakPopoverStyle(accessibilitySize: false) == .popover)
        #expect(ItemSheetModel.streakPopoverStyle(accessibilitySize: true) == .sheet)
    }

    // MARK: The chips as controls

    /// The real per-item gate, DsulCore's, with no planner: `chipEditor` and
    /// `unsetProperties` hold no type gate of their own, so a stub that took
    /// every action would give a habit a priority menu.
    private func gate(_ item: SampleItem) -> (String) -> Bool {
        return { editAllowed(action: $0, on: item, caps: caps(item.typeName)) }
    }

    /// The chips as the page draws them, on the 12-hour clock.
    private func shown(_ planner: SamplePlanner, _ item: SampleItem) -> [SheetChip] {
        return ItemSheetModel.chips(item, today: planner.today, timeFormat: .twelveHour,
                                    routineNames: planner.routineNames(for: item.id),
                                    seasonNames: planner.seasonNames(for: item.id))
    }

    /// Priority and times per day are menus, the reminder its sheet, each
    /// only where the type takes it: no priority on a habit, no count on a
    /// task, no reminder on a subtask, whose page still takes a priority
    /// (Q7 a). Every other chip stays read-only, and with nothing taken (an
    /// older server) every chip is.
    @Test func aChipEditsOnlyWhereTheTypeTakesIt() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")   // a task
        let meds = try named(planner, "Meds")                  // a habit
        let pull = try named(planner, "Pull the September numbers")   // a subtask
        let takesNothing: (String) -> Bool = { _ in false }

        #expect(ItemSheetModel.chipEditor(.priority, roadmap, canEdit: gate(roadmap)) == ChipEditor.menu)
        #expect(ItemSheetModel.chipEditor(.priority, meds, canEdit: gate(meds)) == nil)
        #expect(ItemSheetModel.chipEditor(.priority, pull, canEdit: gate(pull)) == ChipEditor.menu)
        #expect(ItemSheetModel.chipEditor(.timesPerDay, meds, canEdit: gate(meds)) == ChipEditor.menu)
        #expect(ItemSheetModel.chipEditor(.timesPerDay, roadmap, canEdit: gate(roadmap)) == nil)
        #expect(ItemSheetModel.chipEditor(.reminder, roadmap, canEdit: gate(roadmap))
                == ChipEditor.sheet(.reminder(roadmap.id)))
        #expect(ItemSheetModel.chipEditor(.reminder, meds, canEdit: gate(meds)) == ChipEditor.sheet(.reminder(meds.id)))
        #expect(ItemSheetModel.chipEditor(.reminder, pull, canEdit: gate(pull)) == nil)

        let readOnly: [SheetChip.Kind] = [.date, .time, .repeats, .project, .routine, .season]
        for kind in readOnly {
            #expect(ItemSheetModel.chipEditor(kind, roadmap, canEdit: gate(roadmap)) == nil)
            #expect(ItemSheetModel.chipEditor(kind, meds, canEdit: gate(meds)) == nil)
        }
        for kind in readOnly + [.priority, .timesPerDay, .reminder] {
            #expect(ItemSheetModel.chipEditor(kind, roadmap, canEdit: takesNothing) == nil)
            #expect(ItemSheetModel.chipEditor(kind, meds, canEdit: takesNothing) == nil)
        }
    }

    /// Add property holds what is unset and editable, in chip order: a bare
    /// task has Priority and Remind…, a habit with neither Times per day and
    /// Remind…, Meds (a reminder already) Times per day alone, and a subtask
    /// Priority alone. A habit counted once a day has no times chip, so its
    /// count is offered; one counted three times has the chip. A priority the
    /// chips can't name has no chip either, so it is offered too.
    @Test func addPropertyHoldsWhatIsUnsetAndEditable() throws {
        let planner = makePlanner()
        let bank = try named(planner, "Call the bank")   // a braindump task: nothing set
        var journal = try named(planner, "Journal")      // a habit with no count and no reminder
        let meds = try named(planner, "Meds")
        let bets = try named(planner, "Write the three bets")   // a subtask
        var roadmap = try named(planner, "Draft Q4 roadmap")   // high, no reminder
        let takesNothing: (String) -> Bool = { _ in false }

        #expect(shown(planner, bank).isEmpty)
        #expect(ItemSheetModel.unsetProperties(bank, shown: shown(planner, bank), canEdit: gate(bank))
                == [.priority, .reminder])
        #expect(ItemSheetModel.unsetProperties(journal, shown: shown(planner, journal), canEdit: gate(journal))
                == [.timesPerDay, .reminder])
        #expect(ItemSheetModel.unsetProperties(meds, shown: shown(planner, meds), canEdit: gate(meds))
                == [.timesPerDay])
        #expect(ItemSheetModel.unsetProperties(bets, shown: shown(planner, bets), canEdit: gate(bets))
                == [.priority])
        #expect(ItemSheetModel.unsetProperties(roadmap, shown: shown(planner, roadmap), canEdit: gate(roadmap))
                == [.reminder])

        journal.timesPerDay = 1
        #expect(ItemSheetModel.unsetProperties(journal, shown: shown(planner, journal), canEdit: gate(journal))
                == [.timesPerDay, .reminder])
        journal.timesPerDay = 3
        #expect(ItemSheetModel.unsetProperties(journal, shown: shown(planner, journal), canEdit: gate(journal))
                == [.reminder])

        roadmap.priority = "urgent"
        #expect(ItemSheetModel.unsetProperties(roadmap, shown: shown(planner, roadmap), canEdit: gate(roadmap))
                == [.priority, .reminder])

        for item in [bank, journal, meds, bets, roadmap] {
            #expect(ItemSheetModel.unsetProperties(item, shown: shown(planner, item), canEdit: takesNothing)
                    .isEmpty)
        }
    }

    /// After a change, VoiceOver goes to the property's chip while the page
    /// draws one, else to Add property, where the emptied property went.
    @Test func voiceOverLandsOnTheChipOrOnAddProperty() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")   // a priority chip
        let bank = try named(planner, "Call the bank")         // no chips
        let meds = try named(planner, "Meds")                  // a reminder chip
        var journal = try named(planner, "Journal")            // no times chip, no reminder

        #expect(ItemSheetModel.voiceOverTarget(after: .priority, shown: shown(planner, roadmap))
                == ChipFocus.chip(.priority))
        #expect(ItemSheetModel.voiceOverTarget(after: .priority, shown: shown(planner, bank)) == ChipFocus.seed)
        #expect(ItemSheetModel.voiceOverTarget(after: .reminder, shown: shown(planner, meds))
                == ChipFocus.chip(.reminder))
        #expect(ItemSheetModel.voiceOverTarget(after: .reminder, shown: shown(planner, journal)) == ChipFocus.seed)
        #expect(ItemSheetModel.voiceOverTarget(after: .timesPerDay, shown: shown(planner, journal)) == ChipFocus.seed)
        journal.timesPerDay = 3
        #expect(ItemSheetModel.voiceOverTarget(after: .timesPerDay, shown: shown(planner, journal))
                == ChipFocus.chip(.timesPerDay))
    }

    /// The seed reads "Add property" alone on its row and is a bare plus
    /// beside chips, and is "Add property" to VoiceOver either way; its
    /// entries are the web's, Remind… with an ellipsis since it opens a sheet,
    /// and each wears its chip's own symbol. The entries 2d to 2f will add
    /// already read as design §3.7 words them: Time… opens a sheet, and
    /// Repeat is the web seed's own label.
    @Test func theSeedsWords() throws {
        #expect(ItemSheetModel.seedLabel(rowHasOthers: false) == "Add property")
        #expect(ItemSheetModel.seedLabel(rowHasOthers: true) == nil)
        #expect(ItemSheetModel.seedSpoken == "Add property")
        #expect(ItemSheetModel.seedEntry(.priority) == "Priority")
        #expect(ItemSheetModel.seedEntry(.timesPerDay) == "Times per day")
        #expect(ItemSheetModel.seedEntry(.reminder) == "Remind\u{2026}")
        #expect(ItemSheetModel.seedEntry(.date) == "Date")
        #expect(ItemSheetModel.seedEntry(.time) == "Time\u{2026}")
        #expect(ItemSheetModel.seedEntry(.repeats) == "Repeat")

        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")
        let meds = try named(planner, "Meds")
        var journal = try named(planner, "Journal")
        journal.timesPerDay = 3
        let drawn = shown(planner, roadmap) + shown(planner, journal) + shown(planner, meds)
        let symbols = drawn.reduce(into: [SheetChip.Kind: String]()) { $0[$1.kind] = $1.systemImage }
        for kind: SheetChip.Kind in [.priority, .timesPerDay, .reminder] {
            #expect(symbols[kind] == ItemSheetModel.seedSymbol(kind))
        }
    }

    /// The menus: None, Low, Medium and High, the web's; "1× a day" to "5× a
    /// day", and a stored count above 5 on a row of its own; VoiceOver hears
    /// "3 times a day" in the menu as on the chip; and each editable chip's
    /// hint.
    @Test func theMenusWords() throws {
        let raws: [String?] = [nil, "low", "medium", "high"]
        #expect(ItemSheetModel.priorityChoices.map(\.word) == ["None", "Low", "Medium", "High"])
        #expect(ItemSheetModel.priorityChoices.map(\.raw) == raws)

        #expect(EditLimits.timesPerDayMax == 5)
        #expect(ItemSheetModel.timesChoices(stored: nil) == [1, 2, 3, 4, 5])
        #expect(ItemSheetModel.timesChoices(stored: 3) == [1, 2, 3, 4, 5])
        #expect(ItemSheetModel.timesChoices(stored: 7) == [1, 2, 3, 4, 5, 7])
        #expect(ItemSheetModel.timesWord(3) == "3\u{00D7} a day")
        #expect(ItemSheetModel.timesSpoken(1) == "1 time a day")
        #expect(ItemSheetModel.timesSpoken(3) == "3 times a day")

        let planner = makePlanner()
        var journal = try named(planner, "Journal")
        journal.timesPerDay = 3
        let drawn = shown(planner, journal).first(where: { $0.kind == .timesPerDay })
        let times = try #require(drawn)
        #expect(times.text == "3\u{00D7}")
        #expect(times.spoken == "3 times a day")

        #expect(ItemSheetModel.chipHint(.priority) == "Changes the priority")
        #expect(ItemSheetModel.chipHint(.timesPerDay) == "Changes how many times a day")
        #expect(ItemSheetModel.chipHint(.reminder) == "Changes the reminder")
        #expect(ItemSheetModel.chipHint(.date) == nil)
        #expect(ItemSheetModel.chipHint(.project) == nil)
    }

    // MARK: The Remind sheet

    /// The wheel reads and writes a time of day in GMT, so a stored time
    /// comes back as it went in whatever the phone's zone, and the day under
    /// it never matters. Only a 24-hour "HH:mm", the server's rule, is a time.
    @Test func theWheelsClockRoundTrips() throws {
        #expect(ItemSheetModel.reminderCalendar.timeZone.secondsFromGMT() == 0)
        for hhmm in ["00:00", "08:05", "23:59"] {
            let date = try #require(ItemSheetModel.reminderDate(hhmm))
            #expect(ItemSheetModel.reminderClock(date) == hhmm)
        }
        #expect(ItemSheetModel.reminderDate("08:00") == Date(timeIntervalSince1970: 8 * 3_600))
        #expect(ItemSheetModel.reminderDate("24:00") == nil)
        #expect(ItemSheetModel.reminderDate("8:00") == nil)
        #expect(ItemSheetModel.reminderDate("") == nil)
        #expect(ItemSheetModel.reminderDate("08:60") == nil)

        let anotherDay = Date(timeIntervalSince1970: 400 * 86_400 + 8 * 3_600 + 5 * 60)
        #expect(ItemSheetModel.reminderClock(anotherDay) == "08:05")
    }

    /// The sheet opens on the stored time; a new reminder on the item's own
    /// start time, else 9:00. No stored time ("" included) is no reminder.
    @Test func theSheetOpensOnATime() throws {
        let planner = makePlanner()
        var meds = try named(planner, "Meds")                  // 08:00, "I pour my coffee"
        var dentist = try named(planner, "Call the dentist")   // at 15:00, reminded at 14:45
        let journal = try named(planner, "Journal")            // no time, no reminder

        #expect(ItemSheetModel.reminderSeedTime(meds) == "08:00")
        #expect(ItemSheetModel.reminderOpeningTime(meds) == "08:00")
        #expect(ItemSheetModel.reminderOpeningTime(dentist) == "14:45")
        #expect(ItemSheetModel.reminderStartTime(dentist) == "15:00")
        #expect(ItemSheetModel.reminderStartTime(journal) == "09:00")
        #expect(ItemSheetModel.reminderOpeningTime(journal) == "09:00")

        dentist.reminderTime = nil
        #expect(ItemSheetModel.reminderSeedTime(dentist) == nil)
        #expect(ItemSheetModel.reminderOpeningTime(dentist) == "15:00")
        dentist.startTime = "25:00"
        #expect(ItemSheetModel.reminderStartTime(dentist) == "09:00")

        meds.reminderTime = ""
        #expect(ItemSheetModel.reminderSeedTime(meds) == nil)
        meds.reminderTime = nil
        #expect(ItemSheetModel.reminderSeedTime(meds) == nil)
    }

    /// Right after is one line: a pasted line break is a space, typing stops
    /// at 500, and stored words longer than that keep their length, never
    /// grow. Words past what one request carries are shown, not edited.
    @Test func rightAfterIsOneLineWithinItsCap() {
        #expect(ItemSheetModel.anchorEntry(previous: "I pour", next: "I pour my\ncoffee", limit: 500)
                == "I pour my coffee")
        let full = String(repeating: "a", count: 499)
        #expect(ItemSheetModel.anchorEntry(previous: full, next: full + "bc", limit: 500) == full + "b")

        let stored = String(repeating: "w", count: 700)
        let limit = growthLimit(cap: EditLimits.anchor, stored: stored)
        #expect(limit == 700)
        #expect(ItemSheetModel.anchorEntry(previous: stored, next: stored + "x", limit: limit) == stored)
        let shorter = String(repeating: "w", count: 650)
        #expect(ItemSheetModel.anchorEntry(previous: stored, next: shorter, limit: limit) == shorter)

        #expect(ItemSheetModel.anchorTooLong(nil) == false)
        #expect(ItemSheetModel.anchorTooLong(String(repeating: "w", count: 10_000)) == false)
        #expect(ItemSheetModel.anchorTooLong(String(repeating: "w", count: 10_001)) == true)
    }

    /// What Done sends: nothing unmoved; a new time alone, which keeps the
    /// stored words; typed words cleaned, or cleared when erased; nothing for
    /// words that clean back to what is stored; off when the time goes; and
    /// typed words clamped to the stored words' cap.
    @Test func doneSendsOnlyWhatMoved() throws {
        let planner = makePlanner()
        let meds = try named(planner, "Meds")   // 08:00, "I pour my coffee"
        let words = "I pour my coffee"
        func commit(_ time: String?, _ anchor: String, on stored: SampleItem) -> ItemEdit? {
            return ItemSheetModel.reminderCommit(timeDraft: time, timeSeed: "08:00", anchorDraft: anchor,
                                                 anchorSeed: words, stored: stored)
        }

        #expect(commit("08:00", words, on: meds) == nil)
        #expect(commit("07:30", words, on: meds) == ItemEdit.reminder(time: "07:30", anchor: nil))
        #expect(commit("08:00", "  I boil the kettle ", on: meds)
                == ItemEdit.reminder(time: "08:00", anchor: .set("I boil the kettle")))
        #expect(commit("08:00", "", on: meds) == ItemEdit.reminder(time: "08:00", anchor: .clear))
        #expect(commit("08:00", words + " ", on: meds) == nil)
        #expect(commit(nil, words, on: meds) == ItemEdit.reminder(time: nil, anchor: nil))
        #expect(commit(nil, "I boil the kettle", on: meds) == ItemEdit.reminder(time: nil, anchor: nil))

        let long = String(repeating: "z", count: 600)
        #expect(commit("08:00", long, on: meds)
                == ItemEdit.reminder(time: "08:00", anchor: .set(String(repeating: "z", count: 500))))
    }

    /// A new reminder (no seed): Done saves the time the wheel opened on,
    /// untouched; a time added and taken away again, or words typed with no
    /// time, send nothing on an item with no reminder.
    @Test func aNewReminderSavesTheWheelsTime() throws {
        let planner = makePlanner()
        let journal = try named(planner, "Journal")   // no reminder

        #expect(ItemSheetModel.reminderCommit(timeDraft: "09:00", timeSeed: nil, anchorDraft: "", anchorSeed: "",
                                              stored: journal)
                == ItemEdit.reminder(time: "09:00", anchor: nil))
        #expect(ItemSheetModel.reminderCommit(timeDraft: "09:00", timeSeed: nil, anchorDraft: "I sit down",
                                              anchorSeed: "", stored: journal)
                == ItemEdit.reminder(time: "09:00", anchor: .set("I sit down")))
        #expect(ItemSheetModel.reminderCommit(timeDraft: nil, timeSeed: nil, anchorDraft: "", anchorSeed: "",
                                              stored: journal) == nil)
        #expect(ItemSheetModel.reminderCommit(timeDraft: nil, timeSeed: nil, anchorDraft: "I sit down",
                                              anchorSeed: "", stored: journal) == nil)
    }

    /// A change made on the web while the sheet was up is never put back:
    /// words typed with the time untouched send the time stored now, not the
    /// one the sheet opened with, and nothing once the reminder was turned
    /// off; a time moved with the words untouched keeps the words stored now.
    @Test func doneNeverPutsBackAChangeMadeOnTheWeb() throws {
        let planner = makePlanner()
        var retimed = try named(planner, "Meds")   // opened at 08:00, "I pour my coffee"
        retimed.reminderTime = "07:00"
        #expect(ItemSheetModel.reminderCommit(timeDraft: "08:00", timeSeed: "08:00", anchorDraft: "I take my pills",
                                              anchorSeed: "I pour my coffee", stored: retimed)
                == ItemEdit.reminder(time: "07:00", anchor: .set("I take my pills")))

        var cleared = retimed
        cleared.reminderTime = nil
        cleared.reminderAnchor = nil
        #expect(ItemSheetModel.reminderCommit(timeDraft: "08:00", timeSeed: "08:00", anchorDraft: "I take my pills",
                                              anchorSeed: "I pour my coffee", stored: cleared) == nil)

        var reworded = try named(planner, "Meds")
        reworded.reminderAnchor = "I brew tea"
        let edit = try #require(ItemSheetModel.reminderCommit(timeDraft: "07:30", timeSeed: "08:00",
                                                              anchorDraft: "I pour my coffee",
                                                              anchorSeed: "I pour my coffee", stored: reworded))
        #expect(edit == ItemEdit.reminder(time: "07:30", anchor: nil))
        #expect(editing(reworded, edit).reminderAnchor == "I brew tea")
    }

    /// The settings lines: signed in alone; Habit reminders off, then no time
    /// zone, in that order; an unknown switch says nothing.
    @Test func theSettingsLinesShowWhenAReminderCannotFire() {
        let off = ItemSheetModel.remindersOffLine
        let zone = ItemSheetModel.noZoneLine
        #expect(ItemSheetModel.reminderSettingsLines(remindersEnabled: false, hasStoredZone: true, live: true) == [off])
        #expect(ItemSheetModel.reminderSettingsLines(remindersEnabled: nil, hasStoredZone: true, live: true).isEmpty)
        #expect(ItemSheetModel.reminderSettingsLines(remindersEnabled: true, hasStoredZone: true, live: true).isEmpty)
        #expect(ItemSheetModel.reminderSettingsLines(remindersEnabled: true, hasStoredZone: false, live: true)
                == [zone])
        #expect(ItemSheetModel.reminderSettingsLines(remindersEnabled: false, hasStoredZone: false, live: true)
                == [off, zone])
        #expect(ItemSheetModel.reminderSettingsLines(remindersEnabled: false, hasStoredZone: false, live: false)
                .isEmpty)
    }

    /// A dated type with no date gets the needs-a-date note; a dated task and
    /// a habit don't.
    @Test func anUndatedTaskSaysItNeedsADate() throws {
        let planner = makePlanner()
        let bank = try named(planner, "Call the bank")
        let dentist = try named(planner, "Call the dentist")
        let meds = try named(planner, "Meds")
        #expect(reminderNeedsDate(bank, caps: planner.caps(for: bank)))
        #expect(!reminderNeedsDate(dentist, caps: planner.caps(for: dentist)))
        #expect(!reminderNeedsDate(meds, caps: planner.caps(for: meds)))
    }

    /// Each sheet the item sheet opens over itself has its own id, and two
    /// items' Remind sheets differ.
    @Test func eachSheetEditorHasItsOwnID() {
        let one = SampleData.uuid(1)
        let two = SampleData.uuid(2)
        let ids = [SheetEditor.reschedule(one), SheetEditor.pauseUntil(one), SheetEditor.reminder(one)].map(\.id)
        #expect(Set(ids).count == 3)
        #expect(SheetEditor.reminder(one).id != SheetEditor.reminder(two).id)
    }

    /// The Remind sheet's words: the web's where it has them (the three
    /// shared sentences are EditCopy's), the phone's own otherwise, and no em
    /// dash in any.
    @Test func theRemindSheetsWords() {
        #expect(ItemSheetModel.reminderTitle == "Remind")
        #expect(ItemSheetModel.reminderTimeHeader == "Nudge me at")
        #expect(ItemSheetModel.reminderTimeLabel == "Time")
        #expect(ItemSheetModel.reminderAnchorHeader == "Right after")
        #expect(ItemSheetModel.noReminder == "No reminder")
        #expect(ItemSheetModel.reminderAnchorPlaceholder == EditCopy.reminderAnchorPlaceholder)
        #expect(ItemSheetModel.reminderAnchorPlaceholder == "I pour my coffee")
        #expect(ItemSheetModel.reminderAnchorHint == EditCopy.reminderAnchorHint)
        #expect(ItemSheetModel.reminderNeedsDateNote == EditCopy.reminderNeedsDate)
        #expect(ItemSheetModel.remindersOffLine
                == "Habit reminders are off in dsul's settings on the web, under Rituals, so this won't fire.")
        #expect(ItemSheetModel.noZoneLine
                == "Reminders need your time zone, which dsul picks up when you open it on the web.")
        #expect(ItemSheetModel.discardTitle == "Discard changes?")
        #expect(ItemSheetModel.discardAction == "Discard")
        #expect(ItemSheetModel.keepEditing == "Keep editing")

        let all = [
            ItemSheetModel.reminderTitle, ItemSheetModel.reminderTimeHeader, ItemSheetModel.reminderTimeLabel,
            ItemSheetModel.reminderAnchorHeader, ItemSheetModel.reminderAnchorPlaceholder,
            ItemSheetModel.reminderAnchorHint, ItemSheetModel.reminderNeedsDateNote, ItemSheetModel.noReminder,
            ItemSheetModel.remindersOffLine, ItemSheetModel.noZoneLine, ItemSheetModel.discardTitle,
            ItemSheetModel.discardAction, ItemSheetModel.keepEditing, ItemSheetModel.seedSpoken,
        ]
        let dashed = all.filter { $0.contains("\u{2014}") }
        #expect(dashed.isEmpty)
    }

    // MARK: A row to VoiceOver

    @Test func aRowsTimeIsSpokenAsItReads() {
        #expect(PlannerFormat.spokenRowTime(startMin: 9 * 60, durationMin: 120) == "9 to 11 AM")
        #expect(PlannerFormat.spokenRowTime(startMin: 11 * 60, durationMin: 120) == "11 AM to 1 PM")
        #expect(PlannerFormat.spokenRowTime(startMin: 15 * 60, durationMin: 15) == "3 PM")
        #expect(PlannerFormat.spokenRowTime(startMin: nil, durationMin: 30) == nil)
    }

    @Test func aRowIsOneSentence() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")
        let meds = try named(planner, "Meds")

        #expect(PlannerFormat.rowLabel(roadmap, isNow: false) == "Draft Q4 roadmap, 9 to 11 AM")
        #expect(PlannerFormat.rowLabel(roadmap, isNow: true) == "Draft Q4 roadmap, now, 9 to 11 AM")
        #expect(PlannerFormat.rowLabel(meds, isNow: false) == "Meds, streak 41")
    }

    /// With Streaks off, a habit's row says nothing of its streak, as it
    /// draws none; a task's row is the same either way.
    @Test func aRowWithStreaksOffSaysNoStreak() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")
        let meds = try named(planner, "Meds")

        #expect(PlannerFormat.rowLabel(meds, isNow: false, streaksEnabled: false) == "Meds")
        #expect(PlannerFormat.rowLabel(meds, isNow: false, streaksEnabled: true) == "Meds, streak 41")
        #expect(PlannerFormat.rowLabel(roadmap, isNow: true, streaksEnabled: false)
                == "Draft Q4 roadmap, now, 9 to 11 AM")
    }
}
