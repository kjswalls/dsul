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
/// words. From 2d: the date chip as the Reschedule verb's menu and its days,
/// the time chip and Time… opening the Time sheet, where VoiceOver goes as a
/// sheet closes, and the Time sheet's rules (what it opens on, where the check
/// sits, what a tap changes, Add a time's start, the lengths, what Done sends)
/// and words. From 2e: the repeat chip's menu and Add property's Repeat ▸
/// (their rows, what a pick does), the Repeat sheet's rules (the days and the
/// day it opens on, the keys' order, what Done sends) and words, and where
/// VoiceOver goes as it closes. From 2f: the project chip's menu (its rows,
/// once per folded name; what it checks, a stored "none" read as no project;
/// what a pick sends; No project), Add property's Project ▸ while the user has
/// a project, where VoiceOver goes after a pick, and the container nouns,
/// which are the registry's (`ContainerWords`). From 2f-b: the routine and
/// season chips' menus (their rows, the membership a toggle reads at tap
/// time, which toggle closes the menu, Remove from's words), Add property's
/// Routine ▸ and Season ▸, and a toggle landing as the chip.
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

    /// Priority, times per day, the repeat, the project, the routines and
    /// the seasons are menus, the reminder and the time their sheets, each
    /// only where the type takes it: no priority on a habit, no count on a
    /// task, no reminder, no repeat, no project and no routine or season on a
    /// subtask, whose page still takes a priority (Q7 a). The date is offered
    /// no Reschedule here (`offered: []`), so it stays read-only;
    /// `theDateChipIsTheRescheduleVerb` gives it one. With nothing taken (an
    /// older server) every chip is read-only.
    @Test func aChipEditsOnlyWhereTheTypeTakesIt() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")   // a task
        let meds = try named(planner, "Meds")                  // a habit
        let pull = try named(planner, "Pull the September numbers")   // a subtask
        let takesNothing: (String) -> Bool = { _ in false }

        #expect(ItemSheetModel.chipEditor(.priority, roadmap, offered: [], canEdit: gate(roadmap)) == ChipEditor.menu)
        #expect(ItemSheetModel.chipEditor(.priority, meds, offered: [], canEdit: gate(meds)) == nil)
        #expect(ItemSheetModel.chipEditor(.priority, pull, offered: [], canEdit: gate(pull)) == ChipEditor.menu)
        #expect(ItemSheetModel.chipEditor(.timesPerDay, meds, offered: [], canEdit: gate(meds)) == ChipEditor.menu)
        #expect(ItemSheetModel.chipEditor(.timesPerDay, roadmap, offered: [], canEdit: gate(roadmap)) == nil)
        #expect(ItemSheetModel.chipEditor(.reminder, roadmap, offered: [], canEdit: gate(roadmap))
                == ChipEditor.sheet(.reminder(roadmap.id)))
        #expect(ItemSheetModel.chipEditor(.reminder, meds, offered: [], canEdit: gate(meds))
                == ChipEditor.sheet(.reminder(meds.id)))
        #expect(ItemSheetModel.chipEditor(.reminder, pull, offered: [], canEdit: gate(pull)) == nil)
        #expect(ItemSheetModel.chipEditor(.time, roadmap, offered: [], canEdit: gate(roadmap))
                == ChipEditor.sheet(.time(roadmap.id)))
        #expect(ItemSheetModel.chipEditor(.time, meds, offered: [], canEdit: gate(meds))
                == ChipEditor.sheet(.time(meds.id)))
        #expect(ItemSheetModel.chipEditor(.repeats, roadmap, offered: [], canEdit: gate(roadmap)) == ChipEditor.menu)
        #expect(ItemSheetModel.chipEditor(.repeats, meds, offered: [], canEdit: gate(meds)) == ChipEditor.menu)
        #expect(ItemSheetModel.chipEditor(.repeats, pull, offered: [], canEdit: gate(pull)) == nil)
        #expect(ItemSheetModel.chipEditor(.project, roadmap, offered: [], canEdit: gate(roadmap)) == ChipEditor.menu)
        #expect(ItemSheetModel.chipEditor(.project, meds, offered: [], canEdit: gate(meds)) == ChipEditor.menu)
        #expect(ItemSheetModel.chipEditor(.project, pull, offered: [], canEdit: gate(pull)) == nil)
        for kind: SheetChip.Kind in [.routine, .season] {
            #expect(ItemSheetModel.chipEditor(kind, roadmap, offered: [], canEdit: gate(roadmap)) == ChipEditor.menu)
            #expect(ItemSheetModel.chipEditor(kind, meds, offered: [], canEdit: gate(meds)) == ChipEditor.menu)
            #expect(ItemSheetModel.chipEditor(kind, pull, offered: [], canEdit: gate(pull)) == nil)
        }

        // Offered no Reschedule, the date is the one chip left read-only.
        #expect(ItemSheetModel.chipEditor(.date, roadmap, offered: [], canEdit: gate(roadmap)) == nil)
        #expect(ItemSheetModel.chipEditor(.date, meds, offered: [], canEdit: gate(meds)) == nil)
        let every: [SheetChip.Kind] = [.priority, .date, .time, .timesPerDay, .repeats, .reminder, .project,
                                       .routine, .season]
        for kind in every {
            #expect(ItemSheetModel.chipEditor(kind, roadmap, offered: [], canEdit: takesNothing) == nil)
            #expect(ItemSheetModel.chipEditor(kind, meds, offered: [], canEdit: takesNothing) == nil)
        }
    }

    /// Add property holds what is unset and editable, in chip order: a bare
    /// task has Priority, Repeat and Remind…, a habit with neither Times per
    /// day and Remind…, Meds (a reminder already) Times per day alone, and a
    /// subtask Priority alone. A habit counted once a day has no times chip,
    /// so its count is offered; one counted three times has the chip. A
    /// priority the chips can't name has no chip either, so it is offered
    /// too. A one-off task is offered Repeat; a habit draws its repeat chip,
    /// and a subtask has no repeat. Offered no Reschedule (`offered: []`), so
    /// no Date: `addPropertyOffersTheDateAndTheTime` offers it. Call the bank
    /// is undated, so it has no Time… either, and Journal, Meds and the
    /// roadmap draw a time chip.
    @Test func addPropertyHoldsWhatIsUnsetAndEditable() throws {
        let planner = makePlanner()
        let bank = try named(planner, "Call the bank")   // a braindump task: nothing set
        var journal = try named(planner, "Journal")      // a habit with no count and no reminder
        let meds = try named(planner, "Meds")
        let bets = try named(planner, "Write the three bets")   // a subtask
        var roadmap = try named(planner, "Draft Q4 roadmap")   // high, no reminder
        let takesNothing: (String) -> Bool = { _ in false }

        // Offered no Reschedule, so never Date.
        func unset(_ item: SampleItem) -> [SheetChip.Kind] {
            return ItemSheetModel.unsetProperties(item, shown: shown(planner, item), offered: [], canEdit: gate(item))
        }

        #expect(shown(planner, bank).isEmpty)
        #expect(unset(bank) == [.priority, .repeats, .reminder])
        #expect(unset(journal) == [.timesPerDay, .reminder])
        #expect(unset(meds) == [.timesPerDay])
        #expect(unset(bets) == [.priority])
        #expect(unset(roadmap) == [.repeats, .reminder])

        journal.timesPerDay = 1
        #expect(unset(journal) == [.timesPerDay, .reminder])
        journal.timesPerDay = 3
        #expect(unset(journal) == [.reminder])

        roadmap.priority = "urgent"
        #expect(unset(roadmap) == [.priority, .repeats, .reminder])

        for item in [bank, journal, meds, bets, roadmap] {
            #expect(ItemSheetModel.unsetProperties(item, shown: shown(planner, item), offered: [],
                                                   canEdit: takesNothing).isEmpty)
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
    /// entries are the web's, Remind… and Time… with an ellipsis since each
    /// opens a sheet, and each wears its chip's own symbol. Repeat is the web
    /// seed's own label, a submenu, so with no ellipsis. The containers'
    /// entries are the registry's nouns (`ContainerWords`, which
    /// edit-writes.json's `containers` pins to lib/container-registry.ts).
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
        #expect(ItemSheetModel.seedEntry(.project) == "Project")
        #expect(ItemSheetModel.seedEntry(.routine) == "Routine")
        #expect(ItemSheetModel.seedEntry(.season) == "Season")
        #expect(ItemSheetModel.seedEntry(.project) == ContainerWords.project)
        #expect(ItemSheetModel.seedEntry(.routine) == ContainerWords.routine)
        #expect(ItemSheetModel.seedEntry(.season) == ContainerWords.season)

        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")
        let meds = try named(planner, "Meds")
        var journal = try named(planner, "Journal")
        journal.timesPerDay = 3
        let drawn = shown(planner, roadmap) + shown(planner, journal) + shown(planner, meds)
        let symbols = drawn.reduce(into: [SheetChip.Kind: String]()) { $0[$1.kind] = $1.systemImage }
        // Meds' routine chip and Journal's season chip (Autumn) too.
        for kind: SheetChip.Kind in [.priority, .date, .time, .timesPerDay, .repeats, .reminder, .routine, .season] {
            #expect(symbols[kind] == ItemSheetModel.seedSymbol(kind))
        }
    }

    /// The menus: None, Low, Medium and High, the web's; "1× a day" to "5× a
    /// day", and a stored count above 5 on a row of its own; VoiceOver hears
    /// "3 times a day" in the menu as on the chip; and each editable chip's
    /// hint, the containers' with the registry's nouns, plural for the
    /// routines and the seasons.
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
        #expect(ItemSheetModel.chipHint(.date) == "Changes the date")
        #expect(ItemSheetModel.chipHint(.time) == "Changes the time")
        #expect(ItemSheetModel.chipHint(.repeats) == "Changes how it repeats")
        #expect(ItemSheetModel.chipHint(.project) == "Changes the project")
        #expect(ItemSheetModel.chipHint(.project) == "Changes the " + jsLowercased(ContainerWords.project))
        #expect(ItemSheetModel.chipHint(.routine) == "Changes the routines")
        #expect(ItemSheetModel.chipHint(.season) == "Changes the seasons")
        #expect(ItemSheetModel.chipHint(.routine) == "Changes the " + jsLowercased(ContainerWords.routines))
        #expect(ItemSheetModel.chipHint(.season) == "Changes the " + jsLowercased(ContainerWords.seasons))
    }

    // MARK: The date chip

    /// The date chip is the bar's Reschedule by another door (Q3 a): a menu
    /// exactly where that verb is offered, read-only elsewhere. The verb's
    /// gate, not the bar's slots: ticked done, Groceries is offered no
    /// Reschedule and its chip goes read-only; paused, its bar is Resume
    /// alone, but the verb is still offered (`canReschedule` has no pause
    /// test), so its chip still edits, as the web's does.
    @Test func theDateChipIsTheRescheduleVerb() throws {
        let planner = makePlanner()
        let groceries = try named(planner, "Groceries")   // dated today, Anytime
        let takesAll: (String) -> Bool = { _ in true }

        #expect(ItemSheetModel.chipEditor(.date, groceries, offered: [.reschedule], canEdit: takesAll)
                == ChipEditor.menu)
        #expect(ItemSheetModel.chipEditor(.date, groceries, offered: [], canEdit: takesAll) == nil)

        let open = planner.offeredVerbs(for: groceries, day: .today)
        #expect(ItemSheetModel.chipEditor(.date, groceries, offered: open, canEdit: gate(groceries))
                == ChipEditor.menu)
        planner.toggle(groceries.id, on: planner.today)
        let done = try #require(planner.item(groceries.id))
        let finished = planner.offeredVerbs(for: done, day: .today)
        #expect(!finished.contains(.reschedule))
        #expect(ItemSheetModel.chipEditor(.date, done, offered: finished, canEdit: gate(done)) == nil)

        let other = makePlanner()
        other.pause(groceries.id, until: nil)
        let paused = try #require(other.item(groceries.id))
        let pausedOffered = other.offeredVerbs(for: paused, day: .today)
        let bar = ItemSheetModel.verbs(paused, other.verbContext(for: paused, day: .today), offered: pausedOffered).bar
        #expect(bar == [.resume])
        #expect(ItemSheetModel.chipEditor(.date, paused, offered: pausedOffered, canEdit: gate(paused))
                == ChipEditor.menu)
    }

    /// The time chip, and Time…, open the Time sheet wherever the type takes
    /// a time: a timed task, an Anytime task and a habit; never an undated
    /// task, which has no day for a time yet, nor a subtask. With nothing
    /// taken (an older server), never.
    @Test func theTimeChipOpensTheTimeSheet() throws {
        let planner = makePlanner()
        let takesNothing: (String) -> Bool = { _ in false }
        for title in ["Draft Q4 roadmap", "Groceries", "Meds"] {
            let item = try named(planner, title)
            #expect(ItemSheetModel.chipEditor(.time, item, offered: [], canEdit: gate(item))
                    == ChipEditor.sheet(.time(item.id)))
            #expect(ItemSheetModel.chipEditor(.time, item, offered: [], canEdit: takesNothing) == nil)
        }
        for title in ["Call the bank", "Write the three bets"] {
            let item = try named(planner, title)
            #expect(ItemSheetModel.chipEditor(.time, item, offered: [], canEdit: gate(item)) == nil)
        }
    }

    /// Add property, as the page asks it (the planner's own `offeredVerbs`
    /// and `canEdit`): an undated task is offered Date and no Time…, an
    /// Anytime task Time… (part 1 draws no chip for Anytime), a dated task
    /// with a time neither, and a subtask neither. A one-off task, dated or
    /// not, is offered Repeat, and a subtask isn't. Offered no Reschedule, the
    /// date goes and nothing else moves.
    @Test func addPropertyOffersTheDateAndTheTime() throws {
        let planner = makePlanner()
        let bank = try named(planner, "Call the bank")         // undated, nothing set
        let groceries = try named(planner, "Groceries")        // dated today, Anytime
        let roadmap = try named(planner, "Draft Q4 roadmap")   // dated, 9:00, high
        let bets = try named(planner, "Write the three bets")  // a subtask
        func unset(_ item: SampleItem, offered: [VerbID]? = nil) -> [SheetChip.Kind] {
            let verbs = offered ?? planner.offeredVerbs(for: item, day: .today)
            return ItemSheetModel.unsetProperties(item, shown: shown(planner, item), offered: verbs,
                                                  canEdit: { planner.canEdit($0, item) })
        }

        #expect(unset(bank) == [.priority, .date, .repeats, .reminder])
        #expect(unset(groceries) == [.priority, .time, .repeats, .reminder])
        #expect(unset(roadmap) == [.repeats, .reminder])
        #expect(unset(bets) == [.priority])
        #expect(unset(bank, offered: []) == [.priority, .repeats, .reminder])
        #expect(unset(groceries, offered: []) == [.priority, .time, .repeats, .reminder])
    }

    /// After a date pick, or Pick a date… or the Time sheet closing,
    /// VoiceOver goes to that chip, or to Add property when the chip went
    /// (Anytime takes the time chip). Only the page whose item the sheet
    /// edited moves it, and the bar's Reschedule and Pause until move
    /// nothing.
    @Test func aClosingSheetSendsVoiceOverToItsChip() throws {
        let one = SampleData.uuid(1)
        let two = SampleData.uuid(2)
        #expect(ItemSheetModel.chipKind(closing: .pickDate(one), on: one) == SheetChip.Kind.date)
        #expect(ItemSheetModel.chipKind(closing: .time(one), on: one) == SheetChip.Kind.time)
        #expect(ItemSheetModel.chipKind(closing: .reminder(one), on: one) == SheetChip.Kind.reminder)
        let elsewhere: [SheetEditor] = [.pickDate(two), .time(two), .reminder(two), .reschedule(one), .pauseUntil(one)]
        for editor in elsewhere {
            #expect(ItemSheetModel.chipKind(closing: editor, on: one) == nil)
        }

        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")
        let groceries = try named(planner, "Groceries")   // Anytime: no time chip
        #expect(ItemSheetModel.voiceOverTarget(after: .date, shown: shown(planner, roadmap)) == ChipFocus.chip(.date))
        #expect(ItemSheetModel.voiceOverTarget(after: .time, shown: shown(planner, groceries)) == ChipFocus.seed)
        #expect(ItemSheetModel.voiceOverTarget(after: .time, shown: shown(planner, roadmap)) == ChipFocus.chip(.time))
    }

    /// The Date menu: Today, Tomorrow and Next week, each with its day under
    /// it as the web's shortcuts name it, then Pick a date… with no day. Next
    /// week is the first day of next week by Week starts on (Q4 a): Sunday
    /// Oct 4 on the sample, Monday Oct 5 once the week starts on Monday. On
    /// the week's last day Tomorrow and Next week name the same day, and both
    /// stay.
    @Test func theDateMenusWordsAndDays() throws {
        let oct1 = try #require(DayString("2026-10-01"))
        let oct3 = try #require(DayString("2026-10-03"))
        let oct4 = try #require(DayString("2026-10-04"))

        let options = ItemSheetModel.dateOptions(today: oct1, nextWeekStart: oct4)
        let subtitles: [String?] = ["Oct 1", "Oct 2", "Oct 4", nil]
        #expect(options.map(\.choice) == [.today, .tomorrow, .nextWeek, .pick])
        #expect(options.map(\.word) == ["Today", "Tomorrow", "Next week", "Pick a date\u{2026}"])
        #expect(options.map(\.subtitle) == subtitles)
        #expect(options.map(\.symbol) == ["sun.max", "sunrise", "calendar.badge.plus", "calendar"])

        let lastDay = ItemSheetModel.dateOptions(today: oct3, nextWeekStart: oct4)
        #expect(lastDay.count == 4)
        #expect(lastDay[1].subtitle == "Oct 4")
        #expect(lastDay[2].subtitle == "Oct 4")

        #expect(ItemSheetModel.dateTarget(.today, today: oct1, nextWeekStart: oct4) == oct1)
        #expect(ItemSheetModel.dateTarget(.tomorrow, today: oct1, nextWeekStart: oct4)?.description == "2026-10-02")
        #expect(ItemSheetModel.dateTarget(.nextWeek, today: oct1, nextWeekStart: oct4) == oct4)
        #expect(ItemSheetModel.dateTarget(.pick, today: oct1, nextWeekStart: oct4) == nil)

        let planner = makePlanner()
        #expect(planner.nextWeekStart == oct4)
        planner.apply(PlannerPayload(userId: UUID(), fetchedAt: "monday",
                                     settings: PlannerSettings(weekStartDay: .monday), items: planner.items))
        #expect(planner.nextWeekStart.description == "2026-10-05")
        let monday = ItemSheetModel.dateOptions(today: planner.today, nextWeekStart: planner.nextWeekStart)
        #expect(monday[2].subtitle == "Oct 5")
    }

    /// Pick a date… is titled "Date", its button the bar's own verb: "Move
    /// to" on a dated item, "Schedule for" on an undated one.
    @Test func pickADateIsTitledDate() throws {
        let planner = makePlanner()
        let groceries = try named(planner, "Groceries")
        let bank = try named(planner, "Call the bank")   // undated
        #expect(ItemSheetModel.dateWords(groceries, planner.verbContext(for: groceries, on: planner.today))
                == DayPickWords(title: "Date", confirmVerb: "Move to", note: nil))
        #expect(ItemSheetModel.dateWords(bank, planner.verbContext(for: bank, on: planner.today))
                == DayPickWords(title: "Date", confirmVerb: "Schedule for", note: nil))
    }

    // MARK: The Remind sheet

    /// The wheel (the Remind and Time sheets' `ClockWheel`) reads and
    /// writes a time of day in GMT, so a stored time comes back as it went in
    /// whatever the phone's zone, and the day under it never matters. Only a
    /// 24-hour "HH:mm", the server's rule, is a time.
    @Test func theWheelsClockRoundTrips() throws {
        #expect(ItemSheetModel.wheelCalendar.timeZone.secondsFromGMT() == 0)
        for hhmm in ["00:00", "08:05", "23:59"] {
            let date = try #require(ItemSheetModel.wheelDate(hhmm))
            #expect(ItemSheetModel.wheelClock(date) == hhmm)
        }
        #expect(ItemSheetModel.wheelDate("08:00") == Date(timeIntervalSince1970: 8 * 3_600))
        #expect(ItemSheetModel.wheelDate("24:00") == nil)
        #expect(ItemSheetModel.wheelDate("8:00") == nil)
        #expect(ItemSheetModel.wheelDate("") == nil)
        #expect(ItemSheetModel.wheelDate("08:60") == nil)

        let anotherDay = Date(timeIntervalSince1970: 400 * 86_400 + 8 * 3_600 + 5 * 60)
        #expect(ItemSheetModel.wheelClock(anotherDay) == "08:05")
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

    /// Each sheet the item sheet opens over itself has its own id, the two
    /// Repeat sheets included, and two items' Remind, Pick a date…, Time and
    /// Repeat sheets differ.
    @Test func eachSheetEditorHasItsOwnID() {
        let one = SampleData.uuid(1)
        let two = SampleData.uuid(2)
        let ids = [SheetEditor.reschedule(one), SheetEditor.pauseUntil(one), SheetEditor.reminder(one),
                   SheetEditor.pickDate(one), SheetEditor.time(one), SheetEditor.repeatDetail(one, .custom),
                   SheetEditor.repeatDetail(one, .monthly)].map(\.id)
        #expect(Set(ids).count == 7)
        #expect(SheetEditor.reminder(one).id != SheetEditor.reminder(two).id)
        #expect(SheetEditor.pickDate(one).id != SheetEditor.pickDate(two).id)
        #expect(SheetEditor.time(one).id != SheetEditor.time(two).id)
        #expect(SheetEditor.repeatDetail(one, .custom).id != SheetEditor.repeatDetail(two, .custom).id)
        #expect(SheetEditor.repeatDetail(one, .monthly).id != SheetEditor.repeatDetail(two, .monthly).id)
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

    // MARK: The Time sheet

    /// The sheet opens on what is stored, as the dialog seeds it: the part of
    /// day, the time as the chip reads it, put as the wheel's "HH:mm", and
    /// the length, or the type's default with none stored.
    @Test func theTimeSheetOpensOnWhatIsStored() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")   // Morning, 9:00, 2 hours
        var groceries = try named(planner, "Groceries")        // Anytime, 45 min
        let meds = try named(planner, "Meds")                  // Morning, no time, 15 min

        #expect(ItemSheetModel.timeSeed(roadmap, caps: planner.caps(for: roadmap))
                == TimeDraft(bucket: .morning, time: "09:00", duration: 120))
        #expect(ItemSheetModel.timeSeed(groceries, caps: planner.caps(for: groceries))
                == TimeDraft(bucket: .anytime, time: nil, duration: 45))
        #expect(ItemSheetModel.timeSeed(meds, caps: planner.caps(for: meds))
                == TimeDraft(bucket: .morning, time: nil, duration: 15))

        groceries.duration = nil
        #expect(planner.caps(for: groceries).defaultBlockMinutes == 30)
        #expect(ItemSheetModel.timeSeed(groceries, caps: planner.caps(for: groceries)).duration == 30)

        for (stored, seeded) in [("9:00", "09:00"), ("09:00:00", "09:00"), ("14:5", "14:05")] {
            var agents = roadmap
            agents.startTime = stored
            #expect(ItemSheetModel.timeSeed(agents, caps: planner.caps(for: agents)).time == seeded)
        }
        for unreadable in ["25:00", "9:00 PM", "x", ""] {
            var odd = roadmap
            odd.startTime = unreadable
            #expect(ItemSheetModel.timeSeed(odd, caps: planner.caps(for: odd)).time == nil)
        }
    }

    /// A time an agent stored as text the wheel can't take ("9:00") opens as
    /// the chip reads it, so the check, the footer and the no-op rule follow
    /// the time the server will file by: Evening under it leaves Morning
    /// checked and sends nothing, as on a time the phone wrote, and the
    /// untouched wheel never rewrites the stored text.
    @Test func anAgentsTimeFilesWhereTheCheckShows() throws {
        let planner = makePlanner()
        var roadmap = try named(planner, "Draft Q4 roadmap")   // Morning, 9:00, 2 hours
        roadmap.startTime = "9:00"
        let typeCaps = planner.caps(for: roadmap)
        let opened = ItemSheetModel.timeSeed(roadmap, caps: typeCaps)
        #expect(opened == TimeDraft(bucket: .morning, time: "09:00", duration: 120))
        #expect(ItemSheetModel.showsSpecificTime(opened, dateAnchored: true))

        let evening = ItemSheetModel.pickBucket(opened, .evening, dateAnchored: true)
        #expect(evening == opened)
        #expect(ItemSheetModel.previewBucket(evening, dateAnchored: true) == DayBucket.morning)
        #expect(ItemSheetModel.timeCommit(draft: evening, seed: opened, stored: roadmap, dateAnchored: true) == nil)

        var longer = opened
        longer.duration = 60
        let edit = try #require(ItemSheetModel.timeCommit(draft: longer, seed: opened, stored: roadmap,
                                                          dateAnchored: true))
        #expect(edit == ItemEdit.time(bucket: nil, startTime: nil, duration: 60))
        #expect(editing(roadmap, edit).startTime == "9:00")
    }

    /// Text the chip can't read ("9:00 PM", "x") shows no time, so a part of
    /// day sent over it clears it, and the item files where the check shows
    /// rather than where `autoCorrectBucket` reads the text (Morning for
    /// "9:00 PM", Anytime for "x"). A task and a habit alike; a length alone
    /// leaves the text be.
    @Test func aTimeTheSheetCantShowIsClearedWithThePartOfDay() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")   // a dated task
        let meds = try named(planner, "Meds")                  // a habit
        for base in [roadmap, meds] {
            let typeCaps = planner.caps(for: base)
            for unreadable in ["9:00 PM", "x"] {
                var stored = base
                stored.timeBucket = "evening"
                stored.startTime = unreadable
                let opened = ItemSheetModel.timeSeed(stored, caps: typeCaps)
                #expect(opened.time == nil)
                #expect(ItemSheetModel.previewBucket(opened, dateAnchored: typeCaps.dateAnchored) == DayBucket.evening)

                let afternoon = ItemSheetModel.pickBucket(opened, .afternoon, dateAnchored: typeCaps.dateAnchored)
                #expect(ItemSheetModel.previewBucket(afternoon, dateAnchored: typeCaps.dateAnchored)
                        == DayBucket.afternoon)
                let edit = try #require(ItemSheetModel.timeCommit(draft: afternoon, seed: opened, stored: stored,
                                                                  dateAnchored: typeCaps.dateAnchored))
                #expect(edit == ItemEdit.time(bucket: .set("afternoon"), startTime: .clear, duration: nil))
                #expect(editAllowed(edit, on: stored, caps: typeCaps))
                let filed = editing(stored, edit)
                #expect(filed.timeBucket == "afternoon")
                #expect(filed.startTime == nil)

                var longer = opened
                longer.duration = opened.duration + 15
                #expect(ItemSheetModel.timeCommit(draft: longer, seed: opened, stored: stored,
                                                  dateAnchored: typeCaps.dateAnchored)
                        == ItemEdit.time(bucket: nil, startTime: nil, duration: opened.duration + 15))
            }
        }
    }

    /// The check shows where the item will file: a time under a part of day
    /// files where the time says, a dated task with none in Anytime, and a
    /// habit with none nowhere. Specific time shows under Morning, Afternoon
    /// and Evening alone.
    @Test func theCheckShowsWhereTheItemWillFile() {
        func draft(_ bucket: DayBucket?, _ time: String? = nil) -> TimeDraft {
            return TimeDraft(bucket: bucket, time: time, duration: 30)
        }
        #expect(ItemSheetModel.previewBucket(draft(.morning, "15:00"), dateAnchored: true) == DayBucket.afternoon)
        #expect(ItemSheetModel.previewBucket(draft(.morning), dateAnchored: true) == DayBucket.morning)
        #expect(ItemSheetModel.previewBucket(draft(.anytime), dateAnchored: true) == DayBucket.anytime)
        #expect(ItemSheetModel.previewBucket(draft(nil), dateAnchored: true) == DayBucket.anytime)
        #expect(ItemSheetModel.previewBucket(draft(nil), dateAnchored: false) == nil)
        #expect(ItemSheetModel.previewBucket(draft(.evening, "09:00"), dateAnchored: false) == DayBucket.morning)

        #expect(!ItemSheetModel.showsSpecificTime(draft(.anytime), dateAnchored: true))
        #expect(!ItemSheetModel.showsSpecificTime(draft(nil), dateAnchored: true))
        #expect(!ItemSheetModel.showsSpecificTime(draft(nil), dateAnchored: false))
        #expect(ItemSheetModel.showsSpecificTime(draft(.morning), dateAnchored: false))
        #expect(ItemSheetModel.showsSpecificTime(draft(.morning, "15:00"), dateAnchored: true))
    }

    /// What is checked is what is sent: a tap that would leave the check
    /// where it is changes nothing. Anytime under a time drops the time;
    /// Evening with no time lands; Evening under 9:00 am, or Afternoon under
    /// 3:00 pm (already checked), changes nothing; Anytime on a dated task
    /// with none (already checked) changes nothing; Morning on a habit with
    /// none lands.
    @Test func whatIsCheckedIsWhatIsSent() {
        let atThree = TimeDraft(bucket: .morning, time: "15:00", duration: 120)
        #expect(ItemSheetModel.pickBucket(atThree, .anytime, dateAnchored: true)
                == TimeDraft(bucket: .anytime, time: nil, duration: 120))
        #expect(ItemSheetModel.pickBucket(atThree, .afternoon, dateAnchored: true) == atThree)

        let morning = TimeDraft(bucket: .morning, time: nil, duration: 15)
        #expect(ItemSheetModel.pickBucket(morning, .evening, dateAnchored: false)
                == TimeDraft(bucket: .evening, time: nil, duration: 15))

        let roadmap = TimeDraft(bucket: .morning, time: "09:00", duration: 120)
        let evening = ItemSheetModel.pickBucket(roadmap, .evening, dateAnchored: true)
        #expect(evening == roadmap)
        #expect(ItemSheetModel.previewBucket(evening, dateAnchored: true) == DayBucket.morning)

        let none = TimeDraft(bucket: nil, time: nil, duration: 30)
        #expect(ItemSheetModel.pickBucket(none, .anytime, dateAnchored: true) == none)
        #expect(ItemSheetModel.pickBucket(none, .morning, dateAnchored: false)
                == TimeDraft(bucket: .morning, time: nil, duration: 30))
    }

    /// The sheet has changed only when what it shows moved: a tap that left
    /// the check where it was is not a change, nor is the long way round back
    /// to the time it opened on; the wheel, a length and No specific time
    /// are.
    @Test func aTapThatLeavesTheCheckIsNotAChange() {
        let seed = TimeDraft(bucket: .morning, time: "09:00", duration: 120)
        func moved(_ draft: TimeDraft) -> Bool {
            return ItemSheetModel.timeMoved(draft: draft, seed: seed, dateAnchored: true)
        }
        #expect(!moved(ItemSheetModel.pickBucket(seed, .evening, dateAnchored: true)))
        #expect(!moved(TimeDraft(bucket: .evening, time: "09:00", duration: 120)))
        #expect(moved(TimeDraft(bucket: .morning, time: "15:00", duration: 120)))
        #expect(moved(TimeDraft(bucket: .morning, time: "09:00", duration: 60)))
        #expect(moved(TimeDraft(bucket: .morning, time: nil, duration: 120)))
    }

    /// Add a time starts the wheel where the part of day starts as the web
    /// offers it (open question 2): 5:00 am, 12:00 pm, 5:00 pm, which file
    /// where they were, so the check stays. Under Anytime, and on a habit
    /// with none, there is no Add a time, and the draft stays as it was.
    @Test func addATimeStartsWhereThePartOfDayDoes() {
        let starts: [(DayBucket, String)] = [(.morning, "05:00"), (.afternoon, "12:00"), (.evening, "17:00")]
        for (bucket, start) in starts {
            let added = ItemSheetModel.addingTime(TimeDraft(bucket: bucket, time: nil, duration: 30),
                                                  dateAnchored: true)
            #expect(added == TimeDraft(bucket: bucket, time: start, duration: 30))
            #expect(added.time == bucketStartTime(bucket))
            #expect(ItemSheetModel.previewBucket(added, dateAnchored: true) == bucket)
        }
        let anytime = TimeDraft(bucket: .anytime, time: nil, duration: 30)
        #expect(ItemSheetModel.addingTime(anytime, dateAnchored: true) == anytime)
        let none = TimeDraft(bucket: nil, time: nil, duration: 30)
        #expect(ItemSheetModel.addingTime(none, dateAnchored: false) == none)
    }

    /// Duration's rows are the web's lengths, and a stored length that is
    /// none of them on a row of its own, in order. Their words are the web's;
    /// VoiceOver hears "min" in full, with the visible words still in the
    /// label.
    @Test func theLengthsAreTheWebs() {
        let presets = [15, 30, 45, 60, 90, 120]
        #expect(EditCopy.durationPresets == presets)
        #expect(ItemSheetModel.durationChoices(seed: 45) == presets)
        #expect(ItemSheetModel.durationChoices(seed: 50) == [15, 30, 45, 50, 60, 90, 120])
        #expect(ItemSheetModel.durationChoices(seed: 180) == presets + [180])
        #expect(presets.map { ItemSheetModel.durationWord($0) }
                == ["15 min", "30 min", "45 min", "1 hour", "1.5 hours", "2 hours"])
        #expect(ItemSheetModel.durationWord(50) == "50 min")

        #expect(ItemSheetModel.durationSpoken(1) == "1 minute")
        #expect(ItemSheetModel.durationSpoken(45) == "45 minutes")
        #expect(ItemSheetModel.durationSpoken(60) == "1 hour")
        #expect(ItemSheetModel.durationSpoken(75) == "75 minutes")
        #expect(ItemSheetModel.durationSpoken(90) == "1.5 hours")
        #expect(ItemSheetModel.durationSpoken(120) == "2 hours")
        for n in presets + [1, 50, 75] {
            #expect(ItemSheetModel.durationSpoken(n).contains(ItemSheetModel.durationWord(n)))
        }
    }

    /// What Done sends: nothing unmoved; only the keys that moved from the
    /// seed; a part of day only when a tap moved the check, so the wheel
    /// crossing into another part of day, and the long way round with a new
    /// time, send the time alone; the long way round back to the time it
    /// opened on, or a draft changed and changed back, nothing. Every edit
    /// sent passes the planner's gate.
    @Test func doneSendsOnlyTheKeysThatMoved() throws {
        let planner = makePlanner()
        let roadmap = try named(planner, "Draft Q4 roadmap")   // Morning, 9:00, 2 hours
        let groceries = try named(planner, "Groceries")        // Anytime, 45 min
        let meds = try named(planner, "Meds")                  // Morning, no time, 15 min
        func seed(_ item: SampleItem) -> TimeDraft {
            return ItemSheetModel.timeSeed(item, caps: planner.caps(for: item))
        }
        func commit(_ draft: TimeDraft, on stored: SampleItem) -> ItemEdit? {
            let typeCaps = planner.caps(for: stored)
            let edit = ItemSheetModel.timeCommit(draft: draft, seed: seed(stored), stored: stored,
                                                 dateAnchored: typeCaps.dateAnchored)
            if let edit { #expect(editAllowed(edit, on: stored, caps: typeCaps)) }
            return edit
        }
        let opened = seed(roadmap)
        #expect(commit(opened, on: roadmap) == nil)

        // A time added under Morning: the time alone.
        var medsTimed = seed(meds)
        medsTimed.time = "08:30"
        #expect(commit(medsTimed, on: meds) == ItemEdit.time(bucket: nil, startTime: .set("08:30"), duration: nil))

        // A new part of day and a time: both.
        var groceriesTimed = ItemSheetModel.pickBucket(seed(groceries), .morning, dateAnchored: true)
        groceriesTimed = ItemSheetModel.addingTime(groceriesTimed, dateAnchored: true)
        #expect(groceriesTimed.time == "05:00")
        groceriesTimed.time = "08:30"
        #expect(commit(groceriesTimed, on: groceries)
                == ItemEdit.time(bucket: .set("morning"), startTime: .set("08:30"), duration: nil))

        // Anytime over a time: the part of day, and the time cleared.
        let anytime = ItemSheetModel.pickBucket(opened, .anytime, dateAnchored: true)
        #expect(commit(anytime, on: roadmap)
                == ItemEdit.time(bucket: .set("anytime"), startTime: .clear, duration: nil))

        // No specific time alone; a length alone.
        var noTime = opened
        noTime.time = nil
        #expect(commit(noTime, on: roadmap) == ItemEdit.time(bucket: nil, startTime: .clear, duration: nil))
        var longer = opened
        longer.duration = 60
        #expect(commit(longer, on: roadmap) == ItemEdit.time(bucket: nil, startTime: nil, duration: 60))

        // The wheel crossing into the afternoon: the time alone.
        var crossed = opened
        crossed.time = "15:00"
        #expect(ItemSheetModel.previewBucket(crossed, dateAnchored: true) == DayBucket.afternoon)
        #expect(commit(crossed, on: roadmap) == ItemEdit.time(bucket: nil, startTime: .set("15:00"), duration: nil))

        // The long way round: No specific time, Evening, Add a time, the
        // wheel to 10:00 am. The check is back on Morning, so the time alone.
        var longWay = ItemSheetModel.pickBucket(noTime, .evening, dateAnchored: true)
        longWay = ItemSheetModel.addingTime(longWay, dateAnchored: true)
        longWay.time = "10:00"
        #expect(longWay == TimeDraft(bucket: .evening, time: "10:00", duration: 120))
        #expect(commit(longWay, on: roadmap) == ItemEdit.time(bucket: nil, startTime: .set("10:00"), duration: nil))
        // And back to 9:00 am: nothing moved that the sheet shows.
        longWay.time = "09:00"
        #expect(commit(longWay, on: roadmap) == nil)

        // Anytime, then Morning, then Add a time and the wheel back to 9:00.
        var back = ItemSheetModel.pickBucket(opened, .anytime, dateAnchored: true)
        back = ItemSheetModel.pickBucket(back, .morning, dateAnchored: true)
        back = ItemSheetModel.addingTime(back, dateAnchored: true)
        back.time = "09:00"
        #expect(back == opened)
        #expect(commit(back, on: roadmap) == nil)
    }

    /// Done keeps the body one the server takes against what is stored at
    /// Done, a fetch having landed while the sheet was up: a time added under
    /// a part of day the web has since set to Anytime, or none, takes the
    /// drafted part of day with it; Anytime picked where the web has since
    /// added a time clears it too; and the same time already stored sends
    /// nothing. Every edit sent passes the planner's gate.
    @Test func doneKeepsTheBodyValidAgainstWhatIsStored() throws {
        let planner = makePlanner()
        let meds = try named(planner, "Meds")   // Morning, no time, 15 min
        let typeCaps = planner.caps(for: meds)
        let opened = ItemSheetModel.timeSeed(meds, caps: typeCaps)
        func commit(_ draft: TimeDraft, on stored: SampleItem) -> ItemEdit? {
            let edit = ItemSheetModel.timeCommit(draft: draft, seed: opened, stored: stored, dateAnchored: false)
            if let edit { #expect(editAllowed(edit, on: stored, caps: typeCaps)) }
            return edit
        }

        var timed = opened
        timed.time = "08:30"
        let stored: [String?] = ["anytime", nil, ""]
        for bucket in stored {
            var changed = meds
            changed.timeBucket = bucket
            #expect(commit(timed, on: changed)
                    == ItemEdit.time(bucket: .set("morning"), startTime: .set("08:30"), duration: nil))
        }

        let anytime = ItemSheetModel.pickBucket(opened, .anytime, dateAnchored: false)
        #expect(anytime == TimeDraft(bucket: .anytime, time: nil, duration: 15))
        #expect(commit(anytime, on: meds) == ItemEdit.time(bucket: .set("anytime"), startTime: nil, duration: nil))
        var gainedTime = meds
        gainedTime.startTime = "07:00"
        #expect(commit(anytime, on: gainedTime)
                == ItemEdit.time(bucket: .set("anytime"), startTime: .clear, duration: nil))

        var same = meds
        same.startTime = "08:30"
        #expect(commit(timed, on: same) == nil)
    }

    /// The Time sheet's words: the web's where it has them (the title, the
    /// three headers, No specific time, the parts of day, the lengths), the
    /// phone's own otherwise (Add a time, the wheel's name, the line under
    /// Part of day, the chips' hints), and no em dash in any, the Date menu's
    /// included.
    @Test func theTimeSheetsWords() {
        #expect(ItemSheetModel.timeTitle == "Time")
        #expect(ItemSheetModel.partOfDayHeader == "Part of day")
        #expect(ItemSheetModel.specificTimeHeader == "Specific time")
        #expect(ItemSheetModel.addTime == "Add a time")
        #expect(ItemSheetModel.noSpecificTime == "No specific time")
        #expect(ItemSheetModel.durationHeader == "Duration")
        #expect(ItemSheetModel.timeWheelLabel == "Time")
        #expect(ItemSheetModel.timeSetsPartOfDay == "The time sets the part of day.")
        #expect(ItemSheetModel.dateTitle == "Date")
        #expect(bucketOrder.map(\.label) == ["Anytime", "Morning", "Afternoon", "Evening"])

        let planner = makePlanner()
        let dates = ItemSheetModel.dateOptions(today: planner.today, nextWeekStart: planner.nextWeekStart)
        let words = [
            ItemSheetModel.timeTitle, ItemSheetModel.partOfDayHeader, ItemSheetModel.specificTimeHeader,
            ItemSheetModel.addTime, ItemSheetModel.noSpecificTime, ItemSheetModel.durationHeader,
            ItemSheetModel.timeWheelLabel, ItemSheetModel.timeSetsPartOfDay, ItemSheetModel.dateTitle,
            ItemSheetModel.chipHint(.date) ?? "", ItemSheetModel.chipHint(.time) ?? "",
            ItemSheetModel.seedEntry(.date), ItemSheetModel.seedEntry(.time),
        ]
        let all = words + dates.map(\.word) + bucketOrder.map(\.label)
            + EditCopy.durationPresets.map { ItemSheetModel.durationSpoken($0) }
        let dashed = all.filter { $0.contains("\u{2014}") }
        #expect(dashed.isEmpty)
    }

    // MARK: The repeat chip and the Repeat sheet

    /// The repeat menu: the type's frequencies in the web's order and words,
    /// Monthly… and Custom days… with an ellipsis; a habit's without No
    /// repeat. A stored frequency the type doesn't list (a legacy "weekly")
    /// gets a row of its own in its own word, so the Picker's selection has a
    /// tag, and picking it is a write the gate refuses; a habit at "none"
    /// draws no chip and adds no row. Add property's Repeat ▸ has no No
    /// repeat.
    @Test func theRepeatMenusRows() throws {
        let six = ["No repeat", "Daily", "Weekdays", "Weekends", "Monthly\u{2026}", "Custom days\u{2026}"]
        let task = ItemCaps.task.allowedFrequencies
        let habit = ItemCaps.habit.allowedFrequencies
        #expect(ItemSheetModel.repeatChoices(allowed: task, stored: "daily").map(\.word) == six)
        #expect(ItemSheetModel.repeatChoices(allowed: task, stored: "daily").map(\.frequency) == repeatFrequencyOrder)
        #expect(ItemSheetModel.repeatChoices(allowed: habit, stored: "daily").map(\.word) == Array(six.dropFirst()))
        #expect(ItemSheetModel.repeatChoices(allowed: task, stored: nil).map(\.word) == six)
        #expect(ItemSheetModel.repeatChoices(allowed: task, stored: "custom").map(\.word) == six)

        let weekly = ItemSheetModel.repeatChoices(allowed: task, stored: "weekly")
        #expect(weekly.count == 7)
        #expect(weekly.last == RepeatChoice(frequency: "weekly", word: "weekly"))
        #expect(ItemSheetModel.repeatChoices(allowed: habit, stored: "none").count == 5)
        #expect(ItemSheetModel.repeatChoices(allowed: habit, stored: "").count == 5)

        let planner = makePlanner()
        var groceries = try named(planner, "Groceries")
        groceries.repeatFrequency = "weekly"
        guard case .write(let edit) = ItemSheetModel.repeatPick("weekly") else {
            Issue.record("a frequency with no sheet is a write")
            return
        }
        #expect(!planner.canEdit(edit, groceries))

        #expect(ItemSheetModel.repeatSeedChoices(allowed: task).map(\.frequency)
                == ["daily", "weekdays", "weekends", "monthly", "custom"])
        #expect(ItemSheetModel.repeatSeedChoices(allowed: habit).map(\.frequency)
                == ["daily", "weekdays", "weekends", "monthly", "custom"])
    }

    /// No repeat, Daily, Weekdays and Weekends write at once, the days and
    /// the day left off; Monthly… and Custom days… open their sheet.
    @Test func aRepeatPickWritesOrOpensTheSheet() {
        for frequency in ["none", "daily", "weekdays", "weekends"] {
            #expect(ItemSheetModel.repeatPick(frequency)
                    == RepeatPick.write(.repeats(frequency: frequency, days: nil, monthDay: nil)))
        }
        #expect(ItemSheetModel.repeatPick("monthly") == RepeatPick.open(.monthly))
        #expect(ItemSheetModel.repeatPick("custom") == RepeatPick.open(.custom))
    }

    /// A pick lands as the chip, on the sample: Weekdays from Add property on
    /// Groceries draws a "Weekdays" chip that edits, takes Repeat out of Add
    /// property and sends VoiceOver to the chip; No repeat takes the chip
    /// away again, Repeat comes back, and VoiceOver goes to Add property.
    /// Groceries keeps its date and its status throughout. Every key picked
    /// reads as Daily on the chip (`cadenceLabel`), while the menu checks
    /// Custom days…, the frequency stored.
    @Test func aRepeatPickLandsAsTheChip() throws {
        let planner = makePlanner()
        let groceries = try named(planner, "Groceries")   // a one-off, dated today
        func unset() throws -> [SheetChip.Kind] {
            let item = try #require(planner.item(groceries.id))
            return ItemSheetModel.unsetProperties(item, shown: shown(planner, item),
                                                  offered: planner.offeredVerbs(for: item, day: .today),
                                                  canEdit: { planner.canEdit($0, item) })
        }
        let before = try unset()
        #expect(before.contains(.repeats))

        guard case .write(let weekdays) = ItemSheetModel.repeatPick("weekdays") else {
            Issue.record("Weekdays is a write")
            return
        }
        planner.edit(groceries.id, weekdays)
        let repeating = try #require(planner.item(groceries.id))
        let repeatingChips = shown(planner, repeating)
        let chip = try #require(repeatingChips.first(where: { $0.kind == .repeats }))
        #expect(chip.text == "Weekdays")
        #expect(chip.spoken == "Repeats: Weekdays")
        #expect(ItemSheetModel.chipEditor(.repeats, repeating, offered: [],
                                          canEdit: { planner.canEdit($0, repeating) }) == ChipEditor.menu)
        let afterWeekdays = try unset()
        #expect(!afterWeekdays.contains(.repeats))
        #expect(ItemSheetModel.voiceOverTarget(after: .repeats, shown: repeatingChips) == ChipFocus.chip(.repeats))
        #expect(repeating.startDate == groceries.startDate)
        #expect(repeating.status == groceries.status)

        guard case .write(let none) = ItemSheetModel.repeatPick("none") else {
            Issue.record("No repeat is a write")
            return
        }
        planner.edit(groceries.id, none)
        let oneOff = try #require(planner.item(groceries.id))
        let oneOffChips = shown(planner, oneOff)
        #expect(oneOff.repeatFrequency == nil)
        #expect(!oneOffChips.contains(where: { $0.kind == .repeats }))
        let afterNone = try unset()
        #expect(afterNone.contains(.repeats))
        #expect(ItemSheetModel.voiceOverTarget(after: .repeats, shown: oneOffChips) == ChipFocus.seed)

        let plants = try named(planner, "Water the plants")
        let everyDay = try #require(ItemSheetModel.repeatCommit(.custom, days: Set(0...6), monthDay: 1,
                                                                stored: plants))
        planner.edit(plants.id, everyDay)
        let daily = try #require(planner.item(plants.id))
        #expect(daily.repeatFrequency == "custom")
        #expect(shown(planner, daily).first(where: { $0.kind == .repeats })?.text == "Daily")
    }

    /// Custom days open on the stored days, or today's alone when none are
    /// (the web's own pick), a stored day out of range read as none; Monthly
    /// on the stored day, or the 1st when none, 0 or one past 31 is stored.
    @Test func theRepeatSheetOpensOnWhatIsStored() throws {
        let planner = makePlanner()
        let plants = try named(planner, "Water the plants")   // Sundays and Wednesdays
        let stretch = try named(planner, "Stretch 10 min")    // daily, no days
        let rent = try named(planner, "Pay rent")             // monthly, on the 1st
        let today = planner.today
        #expect(today.weekday == 4)

        #expect(ItemSheetModel.repeatDaysSeed(plants, today: today) == Set([0, 3]))
        #expect(ItemSheetModel.repeatDaysSeed(stretch, today: today) == Set([today.weekday]))
        var odd = plants
        odd.repeatDays = [9]
        #expect(ItemSheetModel.repeatDaysSeed(odd, today: today) == Set([today.weekday]))

        #expect(ItemSheetModel.monthDaySeed(rent) == 1)
        var fifteenth = rent
        fifteenth.repeatMonthDay = 15
        #expect(ItemSheetModel.monthDaySeed(fifteenth) == 15)
        for stored: Int? in [nil, 0, 40] {
            var other = rent
            other.repeatMonthDay = stored
            #expect(ItemSheetModel.monthDaySeed(other) == 1)
        }
    }

    /// What Done sends: nothing for Custom days with no day; the days picked,
    /// ascending; the day picked; and nothing when the item already says it
    /// (the stored days, the stored day, a monthly item with no day and the
    /// 1st). A clean sheet on another frequency sends: Custom days… on a
    /// daily item, Done at once. Every edit sent passes the planner's gate.
    @Test func repeatDoneSendsOnlyAChange() throws {
        let planner = makePlanner()
        let plants = try named(planner, "Water the plants")   // custom, [0, 3]
        let stretch = try named(planner, "Stretch 10 min")    // daily
        let rent = try named(planner, "Pay rent")             // monthly, on the 1st
        func commit(_ detail: RepeatDetail, days: Set<Int> = [], monthDay: Int = 1,
                    on stored: SampleItem) -> ItemEdit? {
            let edit = ItemSheetModel.repeatCommit(detail, days: days, monthDay: monthDay, stored: stored)
            if let edit { #expect(editAllowed(edit, on: stored, caps: planner.caps(for: stored))) }
            return edit
        }

        #expect(commit(.custom, days: [], on: stretch) == nil)
        #expect(commit(.custom, days: [5, 1, 3], on: stretch)
                == ItemEdit.repeats(frequency: "custom", days: [1, 3, 5], monthDay: nil))
        #expect(commit(.custom, days: [0, 3], on: plants) == nil)
        #expect(commit(.monthly, monthDay: 31, on: rent)
                == ItemEdit.repeats(frequency: "monthly", days: nil, monthDay: 31))
        #expect(commit(.monthly, monthDay: 1, on: rent) == nil)
        var noDay = rent
        noDay.repeatMonthDay = nil
        #expect(commit(.monthly, monthDay: 1, on: noDay) == nil)

        let seed = ItemSheetModel.repeatDaysSeed(stretch, today: planner.today)
        #expect(commit(.custom, days: seed, on: stretch)
                == ItemEdit.repeats(frequency: "custom", days: [planner.today.weekday], monthDay: nil))
        #expect(commit(.monthly, monthDay: ItemSheetModel.monthDaySeed(stretch), on: stretch)
                == ItemEdit.repeats(frequency: "monthly", days: nil, monthDay: 1))
    }

    /// Custom days' keys run in the user's week: from Sunday, or Mon to Sun
    /// in a Monday week (open question 2).
    @Test func theKeysRunInTheUsersWeek() {
        #expect(ItemSheetModel.repeatDayKeys(weekStartDay: .sunday) == [0, 1, 2, 3, 4, 5, 6])
        #expect(ItemSheetModel.repeatDayKeys(weekStartDay: .monday) == [1, 2, 3, 4, 5, 6, 0])
        #expect(ItemSheetModel.repeatDayKeys(weekStartDay: .saturday) == [6, 0, 1, 2, 3, 4, 5])
    }

    /// The Repeat sheet, as it closes, sends VoiceOver to the repeat chip of
    /// the page it edited, or to Add property where there is none; another
    /// page's sheet moves nothing.
    @Test func theRepeatSheetClosingSendsVoiceOverToTheChip() throws {
        let one = SampleData.uuid(1)
        let two = SampleData.uuid(2)
        #expect(ItemSheetModel.chipKind(closing: .repeatDetail(one, .custom), on: one) == SheetChip.Kind.repeats)
        #expect(ItemSheetModel.chipKind(closing: .repeatDetail(one, .monthly), on: one) == SheetChip.Kind.repeats)
        #expect(ItemSheetModel.chipKind(closing: .repeatDetail(two, .custom), on: one) == nil)
        #expect(ItemSheetModel.chipKind(closing: .repeatDetail(two, .monthly), on: one) == nil)

        let planner = makePlanner()
        let meds = try named(planner, "Meds")             // a repeat chip
        let groceries = try named(planner, "Groceries")   // a one-off: none
        #expect(ItemSheetModel.voiceOverTarget(after: .repeats, shown: shown(planner, meds))
                == ChipFocus.chip(.repeats))
        #expect(ItemSheetModel.voiceOverTarget(after: .repeats, shown: shown(planner, groceries)) == ChipFocus.seed)
    }

    /// The Repeat sheet's words: the web's keys ("Sun" … "Sat"), each day in
    /// full beginning with its key's word, "Day 12" for a day of the month,
    /// the titles without the menu's ellipsis, the web's two sentences, and
    /// no em dash in any.
    @Test func theRepeatSheetsWords() {
        let keys = (0...6).map { ItemSheetModel.repeatDayWord($0) }
        let names = (0...6).map { ItemSheetModel.repeatDayName($0) }
        #expect(keys == ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"])
        #expect(names == ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"])
        for day in 0...6 {
            #expect(names[day].hasPrefix(keys[day]))
        }
        #expect(ItemSheetModel.monthDayWord(1) == "Day 1")
        #expect(ItemSheetModel.monthDayWord(12) == "Day 12")
        #expect(ItemSheetModel.repeatTitle(.custom) == "Custom days")
        #expect(ItemSheetModel.repeatTitle(.monthly) == "Monthly")
        #expect(ItemSheetModel.selectAtLeastOneDay == "Select at least one day")
        #expect(ItemSheetModel.monthlyNote == "For months with fewer days, it will occur on the last day.")
        #expect(ItemSheetModel.selectAtLeastOneDay == EditCopy.selectAtLeastOneDay)
        #expect(ItemSheetModel.monthlyNote == EditCopy.monthlyNote)

        let words = keys + names + [
            ItemSheetModel.monthDayWord(31), ItemSheetModel.repeatTitle(.custom), ItemSheetModel.repeatTitle(.monthly),
            ItemSheetModel.selectAtLeastOneDay, ItemSheetModel.monthlyNote, ItemSheetModel.chipHint(.repeats) ?? "",
            ItemSheetModel.seedEntry(.repeats),
        ]
        let rows = ItemSheetModel.repeatChoices(allowed: ItemCaps.task.allowedFrequencies, stored: nil)
        let all = words + rows.map(\.word)
        let dashed = all.filter { $0.contains("\u{2014}") }
        #expect(dashed.isEmpty)
    }

    // MARK: The project chip

    /// The project menu's rows, and Project ▸'s: the user's projects in
    /// payload order, the first of each folded name, so "Work" and "work"
    /// (names are unique exactly, not folded) give one row, never two
    /// checked. On the sample, its five.
    @Test func theProjectMenusRows() throws {
        let rows = ItemSheetModel.projectChoices([
            Project(id: "a", name: "Work"), Project(id: "b", name: "work"), Project(id: "c", name: "Home"),
        ])
        #expect(rows == [ProjectChoice(id: "a", name: "Work"), ProjectChoice(id: "c", name: "Home")])
        #expect(rows.map(\.key) == ["work", "home"])
        #expect(ItemSheetModel.projectChoices([]).isEmpty)

        let planner = makePlanner()
        #expect(ItemSheetModel.projectChoices(planner.projectRecords).map(\.name)
                == ["Work", "Home", "Writing", "dsul", "Health"])
    }

    /// What the menu checks: the stored name folded as JavaScript folds it,
    /// so "work" checks Work, a final sigma included; nothing for no project,
    /// "" (an unfiled habit) and the web dialog's "none", matched exactly, so
    /// a project named "None" is a name. A name no project has checks no row.
    /// On the sample, Standup's key is Work's row's.
    @Test func theProjectMenuChecksTheFoldedName() throws {
        #expect(ItemSheetModel.legacyNoProject == "none")
        #expect(ItemSheetModel.projectKey(nil) == nil)
        #expect(ItemSheetModel.projectKey("") == nil)
        #expect(ItemSheetModel.projectKey("none") == nil)
        #expect(ItemSheetModel.projectKey("Work") == "work")
        #expect(ItemSheetModel.projectKey("None") == "none")
        let upper = "\u{03A3}\u{03A4}\u{039F}\u{03A7}\u{039F}\u{03A3}"
        let lower = "\u{03C3}\u{03C4}\u{03BF}\u{03C7}\u{03BF}\u{03C2}"
        #expect(ItemSheetModel.projectKey(upper) == ProjectChoice(id: "x", name: lower).key)

        let planner = makePlanner()
        let choices = ItemSheetModel.projectChoices(planner.projectRecords)
        let work = try #require(choices.first(where: { $0.name == "Work" }))
        let standup = try named(planner, "Standup")
        #expect(ItemSheetModel.projectKey(standup.project) == work.key)
        let fitness = ItemSheetModel.projectKey("Fitness")
        #expect(fitness != nil)
        #expect(!choices.contains(where: { $0.key == fitness }))
    }

    /// A stored "none" (habits saved before #373 can carry it) is no project,
    /// as the web's dialog reads it, and so is "" (an unfiled habit): no
    /// chip, and Project in Add property. "None", capitalised, is a name: its
    /// chip reads it, and Project isn't offered.
    @Test func aStoredNoneIsNoProject() throws {
        let planner = makePlanner()
        var meds = try named(planner, "Meds")
        func offersProject() -> Bool {
            return ItemSheetModel.unsetProperties(meds, shown: shown(planner, meds), offered: [], canEdit: gate(meds),
                                                  containers: [.project]).contains(.project)
        }

        for stored in ["none", ""] {
            meds.project = stored
            #expect(!shown(planner, meds).contains(where: { $0.kind == .project }))
            #expect(offersProject())
        }

        meds.project = "None"
        let chip = try #require(shown(planner, meds).first(where: { $0.kind == .project }))
        #expect(chip.text == "None")
        #expect(!offersProject())
    }

    /// Add property offers the containers last, project first, each only
    /// while the user has one (`ownedContainers`) and the item has none: Call
    /// the bank, Meds and Journal are offered Project, Groceries (filed under
    /// Home) isn't, nor a subtask; Call the bank and Groceries are offered
    /// Routine and Season, Meds (in Morning routine) Season alone, and
    /// Journal (in Morning routine and Autumn) neither. With no container,
    /// nothing is offered any of the three, and with projects alone,
    /// Groceries is offered neither Routine nor Season. As the page asks it,
    /// Call the bank's seed ends in Project, Routine and Season.
    @Test func addPropertyOffersTheContainers() throws {
        let planner = makePlanner()
        let bank = try named(planner, "Call the bank")
        let groceries = try named(planner, "Groceries")
        let meds = try named(planner, "Meds")             // in Morning routine
        let journal = try named(planner, "Journal")       // in Morning routine and Autumn
        let bets = try named(planner, "Write the three bets")   // a subtask
        let all = ItemSheetModel.ownedContainers(projects: 5, routines: 2, seasons: 1)
        let noContainers = ItemSheetModel.ownedContainers(projects: 0, routines: 0, seasons: 0)
        let every: Set<SheetChip.Kind> = [.project, .routine, .season]
        let projectOnly: Set<SheetChip.Kind> = [.project]
        let memberships: Set<SheetChip.Kind> = [.routine, .season]
        #expect(all == every)
        #expect(noContainers.isEmpty)
        #expect(ItemSheetModel.ownedContainers(projects: 1, routines: 0, seasons: 0) == projectOnly)
        #expect(ItemSheetModel.ownedContainers(projects: 0, routines: 1, seasons: 1) == memberships)

        // Offered no Reschedule, so never Date.
        func unset(_ item: SampleItem, _ containers: Set<SheetChip.Kind>) -> [SheetChip.Kind] {
            return ItemSheetModel.unsetProperties(item, shown: shown(planner, item), offered: [], canEdit: gate(item),
                                                  containers: containers)
        }
        #expect(unset(bank, all) == [.priority, .repeats, .reminder, .project, .routine, .season])
        #expect(unset(groceries, all) == [.priority, .time, .repeats, .reminder, .routine, .season])
        #expect(unset(meds, all) == [.timesPerDay, .project, .season])
        #expect(unset(journal, all) == [.timesPerDay, .reminder, .project])
        #expect(unset(bets, all) == [.priority])
        #expect(unset(bank, noContainers) == [.priority, .repeats, .reminder])
        #expect(unset(groceries, projectOnly) == [.priority, .time, .repeats, .reminder])

        let owned = ItemSheetModel.ownedContainers(projects: ItemSheetModel.projectChoices(planner.projectRecords).count,
                                                   routines: planner.routines.count, seasons: planner.seasons.count)
        #expect(owned == every)
        let page = ItemSheetModel.unsetProperties(bank, shown: shown(planner, bank),
                                                  offered: planner.offeredVerbs(for: bank, day: .today),
                                                  canEdit: { planner.canEdit($0, bank) }, containers: owned)
        #expect(page == [.priority, .date, .repeats, .reminder, .project, .routine, .season])
    }

    /// A pick sends the project's id and its name, and No project both nil;
    /// each passes the gate on a task. No project is offered on every shipped
    /// type, never on one whose container is required, where the gate refuses
    /// it too. Its words are the registry's, with no em dash.
    @Test func aProjectPickIsOneEdit() throws {
        let planner = makePlanner()
        let groceries = try named(planner, "Groceries")
        let work = ProjectChoice(id: "sample-work", name: "Work")
        let filed = ItemSheetModel.projectEdit(work)
        let cleared = ItemSheetModel.projectEdit(nil)
        #expect(filed == ItemEdit.project(id: "sample-work", name: "Work"))
        #expect(cleared == ItemEdit.project(id: nil, name: nil))
        #expect(filed.action == "project")
        #expect(editAllowed(filed, on: groceries, caps: .task))
        #expect(editAllowed(cleared, on: groceries, caps: .task))

        #expect(ItemSheetModel.offersNoProject(.task))
        #expect(ItemSheetModel.offersNoProject(.habit))
        var mustFile = ItemCaps.task
        mustFile.containerRequired = true
        #expect(!ItemSheetModel.offersNoProject(mustFile))
        #expect(!editAllowed(cleared, on: groceries, caps: mustFile))

        #expect(ItemSheetModel.noProject == "No project")
        #expect(ItemSheetModel.noProject == ContainerWords.noProject)
        let words = [ItemSheetModel.noProject, ItemSheetModel.chipHint(.project) ?? "",
                     ItemSheetModel.seedEntry(.project)]
        #expect(!words.contains(where: { $0.contains("\u{2014}") }))
    }

    /// The container chips' spoken words take their nouns from the registry:
    /// "Project: Home", "Routine: Morning routine", "Routines: Morning
    /// routine and 1 more", and a season's likewise.
    @Test func theContainerChipsSayTheRegistrysNouns() throws {
        let planner = makePlanner()
        let groceries = try named(planner, "Groceries")   // Home
        let meds = try named(planner, "Meds")
        let project = try #require(shown(planner, groceries).first(where: { $0.kind == .project }))
        #expect(project.spoken == "Project: Home")
        #expect(project.spoken == "\(ContainerWords.project): Home")

        func spoken(_ kind: SheetChip.Kind, routines: [String], seasons: [String]) -> String? {
            let chips = ItemSheetModel.chips(meds, today: planner.today, timeFormat: .twelveHour,
                                             routineNames: routines, seasonNames: seasons)
            return chips.first(where: { $0.kind == kind })?.spoken
        }
        #expect(spoken(.routine, routines: ["Morning routine"], seasons: []) == "Routine: Morning routine")
        #expect(spoken(.routine, routines: ["Morning routine", "Wind down"], seasons: [])
                == "Routines: Morning routine and 1 more")
        #expect(spoken(.season, routines: [], seasons: ["Autumn"]) == "Season: Autumn")
        #expect(spoken(.season, routines: [], seasons: ["Autumn", "Winter"]) == "Seasons: Autumn and 1 more")
        #expect(spoken(.routine, routines: ["Wind down"], seasons: []) == "\(ContainerWords.routine): Wind down")
        #expect(spoken(.routine, routines: ["A", "B"], seasons: []) == "\(ContainerWords.routines): A and 1 more")
        #expect(spoken(.season, routines: [], seasons: ["Autumn"]) == "\(ContainerWords.season): Autumn")
        #expect(spoken(.season, routines: [], seasons: ["A", "B"]) == "\(ContainerWords.seasons): A and 1 more")
    }

    /// After a project pick, VoiceOver goes to the project chip while there
    /// is one (Groceries, filed under Home), and to Add property once No
    /// project took it (Call the bank, filed nowhere). With no project to
    /// offer, Add property holds no Project, so after No project on a
    /// text-only name, for a user with no projects, there may be no seed to
    /// land on, and VoiceOver stays where iOS puts it.
    @Test func voiceOverAfterAProjectPick() throws {
        let planner = makePlanner()
        let groceries = try named(planner, "Groceries")
        let bank = try named(planner, "Call the bank")
        #expect(ItemSheetModel.voiceOverTarget(after: .project, shown: shown(planner, groceries))
                == ChipFocus.chip(.project))
        #expect(ItemSheetModel.voiceOverTarget(after: .project, shown: shown(planner, bank)) == ChipFocus.seed)

        var filed = bank
        filed.project = "Fitness"   // a text-only name, which no project has
        #expect(shown(planner, filed).contains(where: { $0.kind == .project }))
        let cleared = editing(filed, ItemSheetModel.projectEdit(nil))
        #expect(cleared.project == nil)
        #expect(!shown(planner, cleared).contains(where: { $0.kind == .project }))
        let noContainers = ItemSheetModel.ownedContainers(projects: 0, routines: 0, seasons: 0)
        let offered = ItemSheetModel.unsetProperties(cleared, shown: shown(planner, cleared), offered: [],
                                                     canEdit: gate(cleared), containers: noContainers)
        #expect(!offered.contains(.project))
    }

    /// A pick lands as the chip, on the sample: Work on Groceries (Home)
    /// reads "Work" at once, linked to Work's row, and VoiceOver goes to the
    /// chip; No project takes the chip away, Project comes back into Add
    /// property, and VoiceOver goes there; Project ▸ Writing files it again.
    /// Groceries keeps its date, its part of day and its status throughout.
    /// On Standup, Work is checked by its folded name, and picking it reads
    /// "Work", linked.
    @Test func aProjectPickLandsAsTheChip() throws {
        let planner = makePlanner()
        let groceries = try named(planner, "Groceries")   // Home, dated today, Anytime
        let choices = ItemSheetModel.projectChoices(planner.projectRecords)
        let work = try #require(choices.first(where: { $0.name == "Work" }))
        let writing = try #require(choices.first(where: { $0.name == "Writing" }))
        let owned = ItemSheetModel.ownedContainers(projects: choices.count, routines: planner.routines.count,
                                                   seasons: planner.seasons.count)
        func unset() throws -> [SheetChip.Kind] {
            let item = try #require(planner.item(groceries.id))
            return ItemSheetModel.unsetProperties(item, shown: shown(planner, item),
                                                  offered: planner.offeredVerbs(for: item, day: .today),
                                                  canEdit: { planner.canEdit($0, item) }, containers: owned)
        }
        #expect(ItemSheetModel.chipEditor(.project, groceries, offered: [],
                                          canEdit: { planner.canEdit($0, groceries) }) == ChipEditor.menu)
        let before = try unset()
        #expect(!before.contains(.project))

        planner.edit(groceries.id, ItemSheetModel.projectEdit(work))
        let filed = try #require(planner.item(groceries.id))
        let filedChips = shown(planner, filed)
        #expect(filed.project == "Work")
        #expect(filed.projectId == work.id)
        #expect(filedChips.first(where: { $0.kind == .project })?.text == "Work")
        #expect(ItemSheetModel.projectKey(filed.project) == work.key)
        #expect(ItemSheetModel.voiceOverTarget(after: .project, shown: filedChips) == ChipFocus.chip(.project))

        planner.edit(groceries.id, ItemSheetModel.projectEdit(nil))
        let unfiled = try #require(planner.item(groceries.id))
        let unfiledChips = shown(planner, unfiled)
        #expect(unfiled.project == nil)
        #expect(unfiled.projectId == nil)
        #expect(!unfiledChips.contains(where: { $0.kind == .project }))
        let afterNone = try unset()
        #expect(afterNone.contains(.project))
        #expect(ItemSheetModel.voiceOverTarget(after: .project, shown: unfiledChips) == ChipFocus.seed)

        planner.edit(groceries.id, ItemSheetModel.projectEdit(writing))
        let refiled = try #require(planner.item(groceries.id))
        #expect(shown(planner, refiled).first(where: { $0.kind == .project })?.text == "Writing")
        let afterWriting = try unset()
        #expect(!afterWriting.contains(.project))
        #expect(refiled.startDate == groceries.startDate)
        #expect(refiled.timeBucket == groceries.timeBucket)
        #expect(refiled.status == groceries.status)

        let standup = try named(planner, "Standup")
        #expect(ItemSheetModel.projectKey(standup.project) == work.key)
        planner.edit(standup.id, ItemSheetModel.projectEdit(work))
        let relinked = try #require(planner.item(standup.id))
        #expect(relinked.project == "Work")
        #expect(relinked.projectId == work.id)
    }

    // MARK: The routine and season chips

    /// A routine chip's rows, and Routine ▸'s: every routine in the
    /// planner's order, each checked while it holds the item; a season's
    /// likewise, by the season's own members. On the sample, Meds is in
    /// Morning routine and not in Wind down, Journal is in Autumn, and
    /// Groceries is in none. Remove from's words are the web's. Only the
    /// routine and season chips join by membership.
    @Test func theMembershipMenusRows() throws {
        let a = UUID()
        let rows = ItemSheetModel.routineChoices([
            Routine(id: "r1", name: "Morning routine", itemIds: [UUID(), a]), Routine(id: "r2", name: "Wind down"),
        ], item: a)
        #expect(rows == [
            MembershipChoice(kind: .routine, id: "r1", name: "Morning routine", member: true),
            MembershipChoice(kind: .routine, id: "r2", name: "Wind down", member: false),
        ])
        let seasonRows = ItemSheetModel.seasonChoices([
            Season(id: "s1", name: "Autumn"), Season(id: "s2", name: "Winter", itemIds: [a]),
        ], item: a)
        #expect(seasonRows == [
            MembershipChoice(kind: .season, id: "s1", name: "Autumn", member: false),
            MembershipChoice(kind: .season, id: "s2", name: "Winter", member: true),
        ])
        #expect(ItemSheetModel.routineChoices([], item: a).isEmpty)

        let planner = makePlanner()
        let meds = try named(planner, "Meds")
        let journal = try named(planner, "Journal")
        let groceries = try named(planner, "Groceries")
        let medsRoutines = ItemSheetModel.routineChoices(planner.routines, item: meds.id)
        #expect(medsRoutines.map(\.name) == ["Morning routine", "Wind down"])
        #expect(medsRoutines.map(\.id) == planner.routines.map(\.id))
        #expect(medsRoutines.map(\.member) == [true, false])
        let journalSeasons = ItemSheetModel.seasonChoices(planner.seasons, item: journal.id)
        #expect(journalSeasons.map(\.name) == ["Autumn"])
        #expect(journalSeasons.map(\.member) == [true])
        #expect(journalSeasons.allSatisfy { $0.kind == .season })
        #expect(!ItemSheetModel.routineChoices(planner.routines, item: groceries.id).contains(where: { $0.member }))
        #expect(!ItemSheetModel.seasonChoices(planner.seasons, item: groceries.id).contains(where: { $0.member }))

        #expect(ItemSheetModel.removeFromWord("Wind down") == "Remove from Wind down")
        #expect(ItemSheetModel.removeFromWord("Morning routine") == "Remove from Morning routine")
        #expect(!ItemSheetModel.removeFromWord("Autumn").contains("\u{2014}"))

        #expect(ItemSheetModel.containerKind(.routine) == ContainerKind.routine)
        #expect(ItemSheetModel.containerKind(.season) == ContainerKind.season)
        for kind: SheetChip.Kind in [.priority, .date, .time, .timesPerDay, .repeats, .reminder, .project] {
            #expect(ItemSheetModel.containerKind(kind) == nil)
        }
    }

    /// A toggle reads the membership when it is tapped, from the planner's
    /// lists, never the row's `member`, which is what the menu showed when it
    /// was built: Meds' Morning routine row built unchecked still reads as a
    /// member, and a Wind down row built unchecked reads as one once Meds
    /// has joined. A container the lists no longer hold reads nil, and so
    /// does a season's id asked as a routine's.
    @Test func aToggleReadsTheMembershipNow() throws {
        let planner = makePlanner()
        let meds = try named(planner, "Meds")
        let journal = try named(planner, "Journal")
        let morning = try #require(planner.routines.first(where: { $0.name == "Morning routine" }))
        let windDown = try #require(planner.routines.first(where: { $0.name == "Wind down" }))
        let autumn = try #require(planner.seasons.first(where: { $0.name == "Autumn" }))
        func live(_ choice: MembershipChoice, _ item: UUID) -> Bool? {
            return ItemSheetModel.liveMember(choice, routines: planner.routines, seasons: planner.seasons, item: item)
        }

        let staleMorning = MembershipChoice(kind: .routine, id: morning.id, name: morning.name, member: false)
        #expect(live(staleMorning, meds.id) == true)
        let staleWindDown = MembershipChoice(kind: .routine, id: windDown.id, name: windDown.name, member: false)
        #expect(live(staleWindDown, meds.id) == false)
        let autumnRow = MembershipChoice(kind: .season, id: autumn.id, name: autumn.name, member: false)
        #expect(live(autumnRow, journal.id) == true)
        #expect(live(autumnRow, meds.id) == false)

        planner.collect(meds.id, kind: .routine, containerId: windDown.id, member: true)
        #expect(live(staleWindDown, meds.id) == true)

        let gone = MembershipChoice(kind: .routine, id: "gone", name: "Gone", member: true)
        #expect(live(gone, meds.id) == nil)
        let seasonAsRoutine = MembershipChoice(kind: .routine, id: autumn.id, name: autumn.name, member: true)
        #expect(live(seasonAsRoutine, journal.id) == nil)
    }

    /// Every toggle keeps its menu open, so several can change in one visit,
    /// but the one that would take the item's last membership off, which
    /// closes the menu before the chip goes, as Remove from does.
    @Test func onlyTheLastMembershipsToggleClosesTheMenu() {
        let member = MembershipChoice(kind: .routine, id: "r1", name: "Morning routine", member: true)
        let other = MembershipChoice(kind: .routine, id: "r2", name: "Wind down", member: false)
        #expect(!ItemSheetModel.toggleKeepsMenuOpen(member, members: 1))
        #expect(ItemSheetModel.toggleKeepsMenuOpen(member, members: 2))
        #expect(ItemSheetModel.toggleKeepsMenuOpen(other, members: 1))
        #expect(ItemSheetModel.toggleKeepsMenuOpen(other, members: 2))
    }

    /// A toggle lands as the chip, on the sample. Routine ▸ Wind down on
    /// Groceries draws "Wind down", and Routine leaves Add property; Season ▸
    /// Autumn likewise. On Meds, Wind down toggled on reads "Morning routine
    /// +1", both rows checked and each keeping the menu open; Morning routine
    /// toggled off reads "Wind down", whose row is now the one that closes;
    /// Remove from Wind down takes the chip away, Routine comes back into
    /// Add property, and VoiceOver goes there. Nothing else moves on either
    /// item.
    @Test func aToggleLandsAsTheChip() throws {
        let planner = makePlanner()
        let groceries = try named(planner, "Groceries")
        let meds = try named(planner, "Meds")
        let morning = try #require(planner.routines.first(where: { $0.name == "Morning routine" }))
        let windDown = try #require(planner.routines.first(where: { $0.name == "Wind down" }))
        let autumn = try #require(planner.seasons.first(where: { $0.name == "Autumn" }))
        let owned = ItemSheetModel.ownedContainers(projects: ItemSheetModel.projectChoices(planner.projectRecords).count,
                                                   routines: planner.routines.count, seasons: planner.seasons.count)
        // What the page draws for the item now: its chips, and what Add
        // property offers.
        func page(_ id: UUID) throws -> (item: SampleItem, chips: [SheetChip], unset: [SheetChip.Kind]) {
            let item = try #require(planner.item(id))
            let chips = shown(planner, item)
            let unset = ItemSheetModel.unsetProperties(item, shown: chips,
                                                       offered: planner.offeredVerbs(for: item, day: .today),
                                                       canEdit: { planner.canEdit($0, item) }, containers: owned)
            return (item, chips, unset)
        }
        func routineRows(_ id: UUID) -> [MembershipChoice] {
            return ItemSheetModel.routineChoices(planner.routines, item: id)
        }

        #expect(ItemSheetModel.chipEditor(.routine, groceries, offered: [],
                                          canEdit: { planner.canEdit($0, groceries) }) == ChipEditor.menu)
        let first = try page(groceries.id)
        #expect(first.unset.contains(.routine))
        #expect(first.unset.contains(.season))

        let join = try #require(routineRows(groceries.id).first(where: { $0.name == "Wind down" }))
        #expect(!join.member)
        planner.collect(groceries.id, kind: join.kind, containerId: join.id, member: true)
        let joined = try page(groceries.id)
        let joinedChip = try #require(joined.chips.first(where: { $0.kind == .routine }))
        #expect(joinedChip.text == "Wind down")
        #expect(joinedChip.spoken == "Routine: Wind down")
        #expect(!joined.unset.contains(.routine))
        #expect(ItemSheetModel.voiceOverTarget(after: .routine, shown: joined.chips) == ChipFocus.chip(.routine))

        planner.collect(groceries.id, kind: .season, containerId: autumn.id, member: true)
        let inSeason = try page(groceries.id)
        #expect(inSeason.chips.first(where: { $0.kind == .season })?.text == "Autumn")
        #expect(!inSeason.unset.contains(.season))
        #expect(inSeason.item == groceries)

        planner.collect(meds.id, kind: .routine, containerId: windDown.id, member: true)
        let both = try page(meds.id)
        let bothChip = try #require(both.chips.first(where: { $0.kind == .routine }))
        #expect(bothChip.text == "Morning routine +1")
        #expect(bothChip.spoken == "Routines: Morning routine and 1 more")
        let twoRows = routineRows(meds.id)
        #expect(twoRows.map(\.member) == [true, true])
        #expect(twoRows.allSatisfy { ItemSheetModel.toggleKeepsMenuOpen($0, members: 2) })

        planner.collect(meds.id, kind: .routine, containerId: morning.id, member: false)
        let one = try page(meds.id)
        #expect(one.chips.first(where: { $0.kind == .routine })?.text == "Wind down")
        let oneRow = try #require(routineRows(meds.id).first(where: { $0.member }))
        #expect(oneRow.name == "Wind down")
        #expect(!ItemSheetModel.toggleKeepsMenuOpen(oneRow, members: 1))

        planner.collect(meds.id, kind: .routine, containerId: windDown.id, member: false)
        let left = try page(meds.id)
        #expect(!left.chips.contains(where: { $0.kind == .routine }))
        #expect(left.unset.contains(.routine))
        #expect(ItemSheetModel.voiceOverTarget(after: .routine, shown: left.chips) == ChipFocus.seed)
        #expect(left.item == meds)
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
