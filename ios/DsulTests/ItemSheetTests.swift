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
                == "It comes back on the day you pick, on its own. Nothing is lost meanwhile — "
                + "your streak and history stay exactly as they are.")
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
}
