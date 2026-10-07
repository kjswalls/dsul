import Foundation
import Testing
import DsulCore

// ItemEdit.swift on hand-written text and lists: the cleaners at their limits,
// JavaScript's trim, the growth caps, the type gate and the chips' edits (the
// time chip's with the time-to-bucket rules under it, from DayBuckets.swift,
// and the lengths' words, from EditCopy.swift; the repeat chip's, with the
// Repeat sheet's two sentences; the project chip's, with its folded name test
// and the container nouns), a new subtask and a streak reset, and where a
// failed delete puts things back. The web's own answers for
// the same functions are in EditWritesFixtureTests; these restate them.

/// 00000000-0000-4000-8000-000000000012 for 12.
private func uuid(_ n: Int) -> UUID {
    let digits = String(n)
    let tail = String(repeating: "0", count: max(0, 12 - digits.count)) + digits
    return UUID(uuidString: "00000000-0000-4000-8000-" + tail)!
}

private func task(_ n: Int, _ title: String, parent: Int? = nil) -> Item {
    return Item(id: uuid(n), title: title, parentItemId: parent.map { uuid($0).uuidString.lowercased() })
}

@Suite struct CleaningTests {
    private let a499 = String(repeating: "a", count: 499)

    @Test func aTitleIsOneLine() {
        #expect(cleanTitle("Buy\nmilk", limit: 500) == "Buy milk")
        #expect(cleanTitle("Buy\r\nmilk", limit: 500) == "Buy milk")
        #expect(cleanTitle("Buy\u{2028}milk", limit: 500) == "Buy milk")
        // Leading and trailing newlines go with the trim, not as spaces.
        #expect(cleanTitle("\n\nBuy milk\n", limit: 500) == "Buy milk")
    }

    @Test func aBlankTitleIsNothing() {
        #expect(cleanTitle("", limit: 500) == nil)
        #expect(cleanTitle("  \n\t ", limit: 500) == nil)
        #expect(cleanTitle("\u{FEFF}\u{A0}", limit: 500) == nil)
    }

    /// 500 UTF-16 units with a two-unit emoji across the boundary: the emoji
    /// goes whole, never half a surrogate pair.
    @Test func anEmojiAtTheLimitGoesWhole() {
        let over = a499 + "😀"
        #expect(over.utf16.count == 501)
        #expect(cleanTitle(over, limit: 500) == a499)
        let fits = String(repeating: "a", count: 498) + "😀"
        #expect(cleanTitle(fits, limit: 500) == fits)
    }

    /// Clamp, then trim again: a cut that ends on a space never sends it.
    @Test func aSpaceAtTheLimitIsTrimmed() {
        let title = cleanTitle(a499 + " tail", limit: 500)
        #expect(title == a499)
        #expect(cleanNotes(a499 + " tail", limit: 500) == a499)
    }

    /// The trim comes before the clamp too, so leading space costs nothing.
    @Test func leadingSpaceIsNotCounted() {
        #expect(cleanTitle("   " + a499 + "b", limit: 500) == a499 + "b")
    }

    /// A stored title over the cap may stay as long (`growthLimit`).
    @Test func aLongStoredTitleKeepsItsLength() {
        let stored = String(repeating: "x", count: 700)
        let limit = growthLimit(cap: EditLimits.title, stored: stored)
        #expect(cleanTitle(stored, limit: limit) == stored)
        #expect(cleanTitle(stored + "y", limit: limit) == stored)
    }

    /// The cue words are one line, as the web's `<input>` is: the title's
    /// rule, newlines to spaces, clamp then trim, an emoji going whole.
    @Test func cueWordsAreOneLine() {
        #expect(cleanAnchor("I pour\nmy coffee", limit: 500) == "I pour my coffee")
        #expect(cleanAnchor("  I pour my coffee \r\n", limit: 500) == "I pour my coffee")
        #expect(cleanAnchor("", limit: 500) == nil)
        #expect(cleanAnchor(" \n\t\u{A0}", limit: 500) == nil)
        #expect(cleanAnchor(a499 + " tail", limit: 500) == a499)
        #expect(cleanAnchor(a499 + "😀", limit: 500) == a499)
        let fits = String(repeating: "a", count: 498) + "😀"
        #expect(cleanAnchor(fits, limit: 500) == fits)
        // Stored words over the cap may keep their length (`growthLimit`).
        let stored = String(repeating: "w", count: 700)
        let limit = growthLimit(cap: EditLimits.anchor, stored: stored)
        #expect(cleanAnchor(stored + "x", limit: limit) == stored)
    }

    @Test func notesKeepTheirLines() {
        #expect(cleanNotes("  Ask about the fee.\nHave the card ready.\n\n", limit: 500)
            == "Ask about the fee.\nHave the card ready.")
        #expect(cleanNotes("\n \n", limit: 500) == nil)
        #expect(cleanNotes("", limit: 500) == nil)
        let long = String(repeating: "n", count: EditLimits.notes + 1)
        #expect(cleanNotes(long, limit: EditLimits.notes)?.utf16.count == EditLimits.notes)
    }
}

@Suite struct JSTrimTests {
    @Test func itStripsWhatJavaScriptStrips() {
        #expect(jsTrim("\u{FEFF} hi ") == "hi")
        #expect(jsTrim("\u{A0}hi\u{A0}") == "hi")
        #expect(jsTrim("\u{2028}hi\u{2029}") == "hi")
        #expect(jsTrim("\u{3000}\u{2000}\u{200A}hi\u{202F}\u{205F}\u{1680}") == "hi")
        #expect(jsTrim("\t\u{0B}\u{0C}\r\nhi\r\n") == "hi")
        #expect(jsTrim("") == "")
        #expect(jsTrim(" \n ") == "")
        #expect(jsTrim("a b") == "a b")
    }

    /// U+0085 is a newline to Foundation but not to JavaScript, and U+180E
    /// stopped being a space in Unicode 6.3.
    @Test func itKeepsWhatJavaScriptKeeps() {
        #expect(Array(jsTrim("\u{85}hi\u{85}").unicodeScalars) == Array("\u{85}hi\u{85}".unicodeScalars))
        #expect(Array(jsTrim("\u{180E}hi").unicodeScalars) == Array("\u{180E}hi".unicodeScalars))
        #expect(Array(jsTrim("\u{200B}hi").unicodeScalars) == Array("\u{200B}hi".unicodeScalars))
    }

    /// By scalar, not by Character: a space before a combining mark is one
    /// Character to Swift, and JavaScript still strips the space.
    @Test func itTrimsByScalar() {
        let trimmed = jsTrim(" \u{301}x")
        #expect(Array(trimmed.unicodeScalars) == Array("\u{301}x".unicodeScalars))
    }
}

@Suite struct ClampTests {
    @Test func itCutsWholeCharacters() {
        #expect(clampUTF16("abc", 2) == "ab")
        #expect(clampUTF16("abc", 3) == "abc")
        #expect(clampUTF16("abc", 0) == "")
        // A family is eight UTF-16 units and one Character.
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"
        #expect(family.utf16.count == 8)
        #expect(clampUTF16("a" + family, 8) == "a")
        #expect(clampUTF16("a" + family, 9) == "a" + family)
    }

    @Test func theGrowthLimitIsTheCapOrTheStoredLength() {
        #expect(growthLimit(cap: 500, stored: nil) == 500)
        #expect(growthLimit(cap: 500, stored: "Buy milk") == 500)
        #expect(growthLimit(cap: 500, stored: String(repeating: "x", count: 700)) == 700)
        // UTF-16 units, as JavaScript's length counts them.
        #expect(growthLimit(cap: 500, stored: String(repeating: "😀", count: 300)) == 600)
        #expect(EditLimits.title == 500 && EditLimits.notes == 50_000)
        #expect(EditLimits.outerTitle == 10_000 && EditLimits.outerNotes == 200_000)
        // New text has nothing stored to grow from: the plain cap.
        #expect(EditLimits.newTitle == 500)
        #expect(EditLimits.anchor == 500 && EditLimits.outerAnchor == 10_000)
        #expect(EditLimits.timesPerDayMax == 5)
        #expect(EditLimits.durationMax == 1440)
    }
}

@Suite struct EditingTests {
    private let item = Item(id: uuid(1), title: "Buy milk", notes: "Two litres.", priority: "low")

    @Test func aTitleIsSetTrimmed() {
        let next = editing(item, ItemEdit.title(" Buy oat milk\u{A0}"))
        #expect(next.title == "Buy oat milk")
        var want = item
        want.title = "Buy oat milk"
        #expect(next == want)
    }

    /// The server refuses a title that trims to nothing; the step changes
    /// nothing either.
    @Test func aBlankTitleChangesNothing() {
        #expect(editing(item, ItemEdit.title("  ")) == item)
    }

    @Test func notesAreSetClearedOrBlankedToNone() {
        #expect(editing(item, ItemEdit.notes("  Oat.  ")).notes == "Oat.")
        #expect(editing(item, ItemEdit.notes(nil)).notes == nil)
        #expect(editing(item, ItemEdit.notes(" \n ")).notes == nil)
        #expect(editing(item, ItemEdit.notes(nil)).priority == "low")
    }

    @Test func notesAreEveryShippedTypes() {
        #expect(editAllowed(ItemEdit.notes("x"), on: item, caps: caps("task")))
        #expect(editAllowed(ItemEdit.notes("x"), on: item, caps: caps("habit")))
        #expect(editAllowed(ItemEdit.notes("x"), on: item, caps: caps("errand")))
        var noNotes = ItemCaps.task
        noNotes.hasNotes = false
        #expect(!editAllowed(ItemEdit.notes("x"), on: item, caps: noNotes))
        // A title is every type's.
        #expect(editAllowed(ItemEdit.title("x"), on: item, caps: noNotes))
    }
}

/// lib/item-edit.ts `editRefusal`'s type gate, asked by action name.
@Suite struct EditAllowedTests {
    private let roadmap = task(1, "Draft Q4 roadmap")
    private let numbers = task(2, "Pull the numbers", parent: 1)
    private let meds = Item(id: uuid(3), type: "habit", title: "Meds", repeatFrequency: "daily")
    private let errand = Item(id: uuid(4), type: "custom", customType: "errand", title: "Post office")

    private func allowed(_ action: String, _ item: Item) -> Bool {
        return editAllowed(action: action, on: item, caps: caps(item.typeName))
    }

    @Test func aTitleIsEveryones() {
        for item in [roadmap, numbers, meds, errand] {
            #expect(allowed("title", item), "\(item.title)")
        }
    }

    @Test func notesFollowTheSchema() {
        #expect(allowed("notes", roadmap) && allowed("notes", meds) && allowed("notes", errand))
        var noNotes = ItemCaps.task
        noNotes.hasNotes = false
        #expect(!editAllowed(action: "notes", on: roadmap, caps: noNotes))
    }

    /// A task's, a custom item's and a subtask's, never a habit's.
    @Test func aPriorityIsATaskShapedTypes() {
        #expect(allowed("priority", roadmap))
        #expect(allowed("priority", errand))
        #expect(allowed("priority", numbers))
        #expect(!allowed("priority", meds))
    }

    @Test func timesADayIsAHabitsAlone() {
        #expect(allowed("timesPerDay", meds))
        #expect(!allowed("timesPerDay", roadmap))
        #expect(!allowed("timesPerDay", errand))
        #expect(!allowed("timesPerDay", numbers))
    }

    /// Every remindable type, never a subtask.
    @Test func aReminderIsNeverASubtasks() {
        #expect(allowed("reminder", roadmap))
        #expect(allowed("reminder", meds))
        #expect(allowed("reminder", errand))
        #expect(!allowed("reminder", numbers))
        var quiet = ItemCaps.task
        quiet.remindable = false
        #expect(!editAllowed(action: "reminder", on: roadmap, caps: quiet))
    }

    /// The other writes have gates of their own, and a name the phone
    /// doesn't know is never an edit.
    @Test func anyOtherNameIsRefused() {
        for action in ["nonsense", "", "delete", "addSubtask", "resetStreak", "Priority"] {
            #expect(!allowed(action, roadmap), "\(action)")
        }
    }

    /// A time is any item's once it has a day to be on: a dated task's, a
    /// dated custom item's and a habit's (never date-anchored), never an
    /// undated task's (`not_dated`) or a subtask's (`not_for_subtask`).
    @Test func aTimeNeedsADayAndIsNeverASubtasks() {
        var dated = roadmap
        dated.startDate = "2026-10-01"
        var datedErrand = errand
        datedErrand.startDate = "2026-10-01"
        var datedNumbers = numbers
        datedNumbers.startDate = "2026-10-01"
        #expect(allowed("time", dated))
        #expect(allowed("time", datedErrand))
        #expect(allowed("time", meds))
        #expect(!allowed("time", roadmap), "undated")
        #expect(!allowed("time", errand), "undated")
        #expect(!allowed("time", numbers), "a subtask")
        #expect(!allowed("time", datedNumbers), "a subtask, dated or not")
        var blank = roadmap
        blank.startDate = ""
        #expect(!allowed("time", blank), "an empty date is none")
        #expect(!allowed("nonsense", dated))
    }

    /// The typed form asks the same question by the edit's own action.
    @Test func theTypedFormIsTheSameGate() {
        let edits: [ItemEdit] = [
            .title("x"), .notes(nil), .priority("high"), .timesPerDay(2), .reminder(time: "08:00", anchor: nil),
            .time(bucket: .set("evening"), startTime: nil, duration: 45),
            .repeats(frequency: "weekdays", days: nil, monthDay: nil),
        ]
        for item in [roadmap, numbers, meds, errand] {
            for edit in edits {
                #expect(editAllowed(edit, on: item, caps: caps(item.typeName)) == allowed(edit.action, item),
                        "\(item.title): \(edit.action)")
            }
        }
    }
}

/// `editing` for the chips: lib/item-edit.ts `editPatch`, and `reminderPatch`
/// under it.
@Suite struct ChipEditingTests {
    private let roadmap = Item(
        id: uuid(1), title: "Draft Q4 roadmap", startDate: "2026-10-01", timeBucket: "morning", priority: "high"
    )
    private let meds = Item(
        id: uuid(2), type: "habit", title: "Meds", repeatFrequency: "daily", reminderTime: "08:00",
        reminderAnchor: "I pour my coffee", streak: 41, dailyCounts: ["2026-10-01": 1]
    )

    @Test func aPriorityIsSetOrCleared() {
        var low = roadmap
        low.priority = "low"
        #expect(editing(roadmap, ItemEdit.priority("low")) == low)
        var none = roadmap
        none.priority = nil
        #expect(editing(roadmap, ItemEdit.priority(nil)) == none)
        #expect(editing(roadmap, ItemEdit.priority("high")) == roadmap)
    }

    /// A count is set, and nothing else moves: the day's tally stays.
    @Test func aCountIsSet() {
        var thrice = meds
        thrice.timesPerDay = 3
        #expect(editing(meds, ItemEdit.timesPerDay(3)) == thrice)
        #expect(editing(thrice, ItemEdit.timesPerDay(3)) == thrice)
        var once = thrice
        once.timesPerDay = 1
        // Back to 1 is written as 1, never cleared.
        #expect(editing(thrice, ItemEdit.timesPerDay(1)) == once)
        #expect(editing(thrice, ItemEdit.timesPerDay(1)).dailyCounts == meds.dailyCounts)
    }

    /// None stored reads as 1, so 1 there changes nothing (and 1 is not
    /// written in its place).
    @Test func noCountIsOne() {
        #expect(meds.timesPerDay == nil)
        #expect(editing(meds, ItemEdit.timesPerDay(1)) == meds)
        #expect(editing(meds, ItemEdit.timesPerDay(2)).timesPerDay == 2)
    }

    /// A time alone keeps the stored words, trimmed as the dialog writes
    /// them.
    @Test func aTimeAloneKeepsTheWords() {
        let next = editing(meds, ItemEdit.reminder(time: "07:30", anchor: nil))
        var want = meds
        want.reminderTime = "07:30"
        #expect(next == want)

        var spaced = meds
        spaced.reminderAnchor = "  I pour my coffee\u{A0}"
        let trimmed = editing(spaced, ItemEdit.reminder(time: "07:30", anchor: nil))
        #expect(trimmed.reminderTime == "07:30")
        #expect(trimmed.reminderAnchor == "I pour my coffee")

        // A first reminder has no words to keep.
        let fresh = editing(roadmap, ItemEdit.reminder(time: "09:00", anchor: nil))
        #expect(fresh.reminderTime == "09:00" && fresh.reminderAnchor == nil)
    }

    @Test func newWordsAreTrimmedAndBlankIsNone() {
        let set = editing(meds, ItemEdit.reminder(time: "08:00", anchor: .set("  I fill the kettle ")))
        #expect(set.reminderTime == "08:00" && set.reminderAnchor == "I fill the kettle")
        let cleared = editing(meds, ItemEdit.reminder(time: "08:00", anchor: .clear))
        #expect(cleared.reminderTime == "08:00" && cleared.reminderAnchor == nil)
        let blank = editing(meds, ItemEdit.reminder(time: "08:00", anchor: .set("   ")))
        #expect(blank.reminderTime == "08:00" && blank.reminderAnchor == nil)
        // The same values are the same item.
        #expect(editing(meds, ItemEdit.reminder(time: "08:00", anchor: .set("I pour my coffee"))) == meds)
        #expect(editing(meds, ItemEdit.reminder(time: "08:00", anchor: nil)) == meds)
    }

    /// No time turns it off: both columns go, whatever the words say, and
    /// nothing else moves.
    @Test func noTimeClearsBoth() {
        var off = meds
        off.reminderTime = nil
        off.reminderAnchor = nil
        #expect(editing(meds, ItemEdit.reminder(time: nil, anchor: nil)) == off)
        #expect(editing(meds, ItemEdit.reminder(time: nil, anchor: .set("I pour my coffee"))) == off)
        #expect(editing(meds, ItemEdit.reminder(time: nil, anchor: .clear)) == off)
        #expect(editing(off, ItemEdit.reminder(time: nil, anchor: nil)) == off)
    }
}

@Suite struct SubtaskItemTests {
    /// Every field the store sets, and nothing else: no date, no bucket, no
    /// project, no priority, no notes.
    @Test func itIsAPendingUnscheduledTaskUnderItsParent() {
        let child = subtaskItem(id: uuid(20), title: "Adapter plug", parent: uuid(3), order: 4)
        #expect(child == Item(
            id: uuid(20), type: "task", title: "Adapter plug", status: "pending",
            parentItemId: "00000000-0000-4000-8000-000000000003", order: 4, isScheduled: false
        ))
        #expect(child.customType == nil && child.startDate == nil && child.timeBucket == nil)
        #expect(child.project == nil && child.priority == nil && child.notes == nil)
        #expect(child.completedDates.isEmpty && child.skippedDates.isEmpty && child.dailyCounts.isEmpty)
    }

    /// A custom parent's subtask is a task, as `addTask` makes it, never the
    /// parent's type, and takes none of the parent's fields: built as the
    /// planner builds it, from the parent's id and the task count. The
    /// signature never sees the parent's type, so this holds by construction;
    /// the store's own answer is `subtask-under-custom` in
    /// `aNewSubtaskIsTheStoresTask`.
    @Test func aCustomParentsSubtaskIsATask() {
        let errand = Item(id: uuid(5), type: "custom", customType: "errand", title: "Post office",
                          startDate: "2026-10-01", timeBucket: "morning", project: "Home", priority: "high")
        #expect(canAddSubtask(under: errand, caps: caps(errand.typeName)))
        let child = subtaskItem(id: uuid(21), title: "Stamps", parent: errand.id, order: project([errand]).tasks.count)
        #expect(child.type == "task" && child.customType == nil && child.typeName == "task")
        #expect(!child.isHabit)
        #expect(child.startDate == nil && child.timeBucket == nil && child.project == nil && child.priority == nil)
        #expect(child.order == 1)
        #expect(isDeletedWith(child, parent: errand.id))
    }

    /// The parent is named by its lowercase id, as Postgres stores it, so the
    /// cascade and the Subtasks section find the child.
    @Test func theParentIdIsLowercase() {
        let parent = UUID(uuidString: "0000000A-0000-4000-8000-00000000000B")!
        let child = subtaskItem(id: uuid(22), title: "Passport", parent: parent, order: 1)
        #expect(child.parentItemId == "0000000a-0000-4000-8000-00000000000b")
        #expect(isDeletedWith(child, parent: parent))
        #expect(!canAddSubtask(under: child, caps: caps(child.typeName)))
    }

    /// A new subtask is never one of Today's tasks: the next one's `order`
    /// counts the same rows.
    @Test func itIsNotCountedInTheOrder() {
        let parent = task(1, "Pack for Lisbon")
        let first = subtaskItem(id: uuid(23), title: "Passport", parent: uuid(1), order: project([parent]).tasks.count)
        #expect(first.order == 1)
        #expect(project([parent, first]).tasks.count == 1)
    }
}

@Suite struct CanAddSubtaskTests {
    @Test func aTaskOrACustomItemMayGrowOne() {
        #expect(canAddSubtask(under: task(1, "Roadmap"), caps: caps("task")))
        let errand = Item(id: uuid(2), type: "custom", customType: "errand", title: "Post office")
        #expect(canAddSubtask(under: errand, caps: caps(errand.typeName)))
    }

    /// A habit grows none (`no_subtasks`), and a subtask none either
    /// (`nested`), whatever its type's caps say.
    @Test func aHabitOrASubtaskMayNot() {
        let habit = Item(id: uuid(1), type: "habit", title: "Floss", repeatFrequency: "daily")
        #expect(!canAddSubtask(under: habit, caps: caps("habit")))
        #expect(!canAddSubtask(under: task(2, "Passport", parent: 1), caps: caps("task")))
    }

    /// An empty `parentItemId` is no parent, as JavaScript's truthiness reads
    /// it.
    @Test func anEmptyParentIsNone() {
        let item = Item(id: uuid(1), title: "Roadmap", parentItemId: "")
        #expect(canAddSubtask(under: item, caps: caps("task")))
    }
}

@Suite struct ResettingStreakTests {
    private let meds = Item(
        id: uuid(1), type: "habit", title: "Meds", status: "pending", timeBucket: "morning",
        repeatFrequency: "daily", streak: 41, currentDayCount: 1,
        completedDates: ["2026-09-29", "2026-09-30"], skippedDates: ["2026-09-27"], dailyCounts: ["2026-09-30": 1]
    )

    /// The streak goes to 0 and nothing else moves: the done days, the
    /// skips and the counts are the habit's history.
    @Test func onlyTheStreakChanges() {
        var want = meds
        want.streak = 0
        #expect(resettingStreak(meds) == want)
    }

    /// Nil reads as 0: nothing to reset, so nothing changes, and a missing
    /// streak isn't written as 0 either, as the server writes nothing there.
    @Test func zeroOrNoneIsLeftAlone() {
        var zero = meds
        zero.streak = 0
        #expect(resettingStreak(zero) == zero)
        var none = meds
        none.streak = nil
        #expect(resettingStreak(none) == none)
        #expect(resettingStreak(none).streak == nil)
    }
}

@Suite struct DeletingTests {
    /// A parent at 3 with one subtask before it and one after: the item goes
    /// first, then its subtasks in list order, each with where it stood.
    @Test func aDeleteTakesItsSubtasksInStoreOrder() {
        let items = [
            task(1, "Inbox"), task(11, "Outline", parent: 3), task(2, "Stamps"),
            task(3, "Roadmap"), task(12, "Review", parent: 3),
        ]
        let (kept, removed) = deleting(uuid(3), from: items)
        #expect(removed.map(\.item.id) == [uuid(3), uuid(11), uuid(12)])
        #expect(removed.map(\.place) == [
            Place(index: 3, after: uuid(2)), Place(index: 1, after: uuid(1)), Place(index: 4, after: uuid(3)),
        ])
        #expect(kept.map(\.id) == [uuid(1), uuid(2)])
    }

    /// A habit takes nothing with it, and a habit is never a subtask that
    /// goes: `deleteHabit` has no cascade, and `deleteTask`'s skips habits.
    @Test func habitsNeverCascade() {
        let habit = Item(id: uuid(1), type: "habit", title: "Meds", repeatFrequency: "daily")
        let underHabit = task(2, "Oddity", parent: 1)
        #expect(deleting(uuid(1), from: [habit, underHabit]).removed.map(\.item.id) == [uuid(1)])

        let parent = task(3, "Roadmap")
        let habitChild = Item(id: uuid(4), type: "habit", title: "Odd", parentItemId: uuid(3).uuidString.lowercased())
        #expect(deleting(uuid(3), from: [parent, habitChild]).removed.map(\.item.id) == [uuid(3)])
    }

    /// The parent's id is matched however it was cased.
    @Test func theCascadeMatchesAnyCase() {
        let parent = task(3, "Roadmap")
        let child = Item(id: uuid(4), title: "Outline", parentItemId: uuid(3).uuidString.uppercased())
        #expect(isDeletedWith(child, parent: uuid(3)))
        #expect(deleting(uuid(3), from: [parent, child]).removed.count == 2)
        #expect(!isDeletedWith(parent, parent: uuid(3)))
    }

    @Test func aMissingItemRemovesNothing() {
        let items = [task(1, "Inbox")]
        let (kept, removed) = deleting(uuid(9), from: items)
        #expect(kept == items)
        #expect(removed.isEmpty)
    }

    @Test func aPlaceIsReadOffTheList() {
        let items = [task(1, "A"), task(2, "B")]
        #expect(Place(of: uuid(1), in: items) == Place(index: 0, after: nil))
        #expect(Place(of: uuid(2), in: items) == Place(index: 1, after: uuid(1)))
        #expect(Place(of: uuid(3), in: items) == nil)
    }
}

@Suite struct ReinsertingTests {
    /// Put back in ascending index, whatever order they were removed in, so a
    /// subtask that stood before its parent goes back before it.
    @Test func itPutsBackInAscendingOrder() {
        let items = [
            task(1, "Inbox"), task(11, "Outline", parent: 3), task(2, "Stamps"),
            task(3, "Roadmap"), task(12, "Review", parent: 3),
        ]
        let (kept, removed) = deleting(uuid(3), from: items)
        #expect(reinserting(removed, into: kept) == items)
        #expect(reinserting(Array(removed.reversed()), into: kept) == items)
    }

    /// After its predecessor, wherever that now stands: a row added in front
    /// meanwhile doesn't shift it.
    @Test func thePredecessorWinsOverTheIndex() {
        let items = [task(1, "A"), task(2, "B"), task(3, "C")]
        let (kept, removed) = deleting(uuid(2), from: items)
        let grown = [task(9, "New")] + kept
        #expect(reinserting(removed, into: grown).map(\.id) == [uuid(9), uuid(1), uuid(2), uuid(3)])
    }

    /// A predecessor that is gone falls back to the index.
    @Test func aMissingPredecessorFallsBackToTheIndex() {
        let gone = PlacedItem(place: Place(index: 1, after: uuid(8)), item: task(2, "B"))
        let out = reinserting([gone], into: [task(1, "A"), task(3, "C")])
        #expect(out.map(\.id) == [uuid(1), uuid(2), uuid(3)])
    }

    /// An index past the end lands at the end.
    @Test func anIndexPastTheEndIsClamped() {
        let far = PlacedItem(place: Place(index: 40, after: uuid(8)), item: task(2, "B"))
        #expect(reinserting([far], into: [task(1, "A")]).map(\.id) == [uuid(1), uuid(2)])
        let first = PlacedItem(place: Place(index: 0, after: nil), item: task(2, "B"))
        #expect(reinserting([first], into: [task(1, "A")]).map(\.id) == [uuid(2), uuid(1)])
        #expect(reinserting([far], into: []).map(\.id) == [uuid(2)])
    }

    /// An item already back (a fetch brought it) is replaced where it stands,
    /// never doubled.
    @Test func anItemAlreadyThereIsReplaced() {
        let old = PlacedItem(place: Place(index: 0, after: nil), item: task(2, "Old title"))
        let out = reinserting([old], into: [task(1, "A"), task(2, "New title")])
        #expect(out.map(\.id) == [uuid(1), uuid(2)])
        #expect(out[1].title == "Old title")
    }
}

/// The Time chip's body rules, which `editAllowed` judges with no row: the
/// route's schema (`invalid`) and `editRefusal`'s `no_duration`.
@Suite struct TimeEditAllowedTests {
    private let roadmap = Item(
        id: uuid(1), title: "Draft Q4 roadmap", startDate: "2026-10-01", startTime: "09:00", timeBucket: "morning",
        duration: 120, isScheduled: true
    )
    private let meds = Item(id: uuid(2), type: "habit", title: "Meds", timeBucket: "morning", duration: 15)

    private func allowed(_ edit: ItemEdit, _ item: Item, caps: ItemCaps? = nil) -> Bool {
        return editAllowed(edit, on: item, caps: caps ?? DsulCore.caps(item.typeName))
    }

    @Test func eachKeyAloneIsTaken() {
        #expect(allowed(.time(bucket: .set("evening"), startTime: nil, duration: nil), roadmap))
        #expect(allowed(.time(bucket: nil, startTime: .set("10:30"), duration: nil), roadmap))
        #expect(allowed(.time(bucket: nil, startTime: .clear, duration: nil), roadmap))
        #expect(allowed(.time(bucket: nil, startTime: nil, duration: 45), roadmap))
        #expect(allowed(.time(bucket: .set("anytime"), startTime: .clear, duration: nil), roadmap))
        #expect(allowed(.time(bucket: .set("morning"), startTime: .set("07:00"), duration: 60), roadmap))
        // A habit's none, both keys null: the server takes it, though the
        // sheet never offers it.
        #expect(allowed(.time(bucket: .clear, startTime: .clear, duration: nil), meds))
    }

    @Test func anEmptyEditIsRefused() {
        #expect(!allowed(.time(bucket: nil, startTime: nil, duration: nil), roadmap))
        #expect(!allowed(.time(bucket: nil, startTime: nil, duration: nil), meds))
    }

    /// Anytime and none hold no time: the schema refuses a time sent beside
    /// either, whatever is stored.
    @Test func aTimeBesideAnytimeOrNoneIsRefused() {
        #expect(!allowed(.time(bucket: .set("anytime"), startTime: .set("09:00"), duration: nil), roadmap))
        #expect(!allowed(.time(bucket: .clear, startTime: .set("09:00"), duration: nil), meds))
        #expect(!allowed(.time(bucket: .clear, startTime: .set("09:00"), duration: nil), roadmap))
    }

    /// A length is 1 minute to a day, and only on a type that keeps one.
    @Test func aLengthIsInRangeAndTheTypes() {
        #expect(!allowed(.time(bucket: nil, startTime: nil, duration: 0), roadmap))
        #expect(!allowed(.time(bucket: nil, startTime: nil, duration: -15), roadmap))
        #expect(!allowed(.time(bucket: nil, startTime: nil, duration: 1441), roadmap))
        #expect(allowed(.time(bucket: nil, startTime: nil, duration: 1), roadmap))
        #expect(allowed(.time(bucket: nil, startTime: nil, duration: 1440), roadmap))
        let noLength = ItemCaps(
            label: "Note", doneStatus: "completed", skipStatus: nil, defaultFrequency: "none", defaultBlockMinutes: 30,
            dateAnchored: true, dateAddressable: true, skippable: true, pausable: true, remindable: true,
            collectible: true, braindumpEligible: true, subtasks: true, streakCounter: false, dailyCounts: false,
            hasPriority: true, hasDuration: false
        )
        #expect(!allowed(.time(bucket: nil, startTime: nil, duration: 45), roadmap, caps: noLength), "no_duration")
        // Without a length sent, the type's lack of one doesn't matter.
        #expect(allowed(.time(bucket: .set("evening"), startTime: nil, duration: nil), roadmap, caps: noLength))
        #expect(ItemCaps.task.hasDuration && ItemCaps.habit.hasDuration && ItemCaps.custom.hasDuration)
    }

    /// The type gate still comes first: a body the schema takes is refused on
    /// an undated task and on a subtask.
    @Test func theTypeGateComesFirst() {
        var undated = roadmap
        undated.startDate = nil
        #expect(!allowed(.time(bucket: nil, startTime: nil, duration: 45), undated))
        var numbers = roadmap
        numbers.parentItemId = uuid(9).uuidString.lowercased()
        #expect(!allowed(.time(bucket: nil, startTime: nil, duration: 45), numbers))
    }
}

/// `editing(.time)`: lib/item-edit.ts `timeEditPatch`, the dialog's
/// `commitEdit` over the keys sent, on hand-built items.
@Suite struct TimeEditingTests {
    /// A timed task: Morning at 9:00, two hours, scheduled.
    private let roadmap = Item(
        id: uuid(1), title: "Draft Q4 roadmap", startDate: "2026-10-01", startTime: "09:00", timeBucket: "morning",
        duration: 120, isScheduled: true
    )
    /// The same in a project block.
    private var block: Item {
        var item = roadmap
        item.startTime = nil
        item.inProjectBlock = true
        return item
    }
    private let meds = Item(id: uuid(2), type: "habit", title: "Meds", timeBucket: "morning", duration: 15)

    private func time(_ bucket: ColumnWrite? = nil, _ startTime: ColumnWrite? = nil,
                      _ duration: Int? = nil) -> ItemEdit {
        return .time(bucket: bucket, startTime: startTime, duration: duration)
    }

    /// A new time in its own part of day is the time alone.
    @Test func aTimeInItsOwnPartOfDayIsTheTimeAlone() {
        var want = roadmap
        want.startTime = "10:30"
        #expect(editing(roadmap, time(nil, .set("10:30"))) == want)
    }

    /// A time past its part of day files where it falls (pass 1's
    /// auto-correct), and nothing else moves.
    @Test func aTimeAcrossPartsOfDayFilesWhereItFalls() {
        var want = roadmap
        want.startTime = "15:00"
        want.timeBucket = "afternoon"
        #expect(editing(roadmap, time(nil, .set("15:00"))) == want)
    }

    /// A new part of day is the store's `scheduleTask`: scheduled, the time
    /// kept and filed, and out of any project block.
    @Test func aPartOfDaySchedulesAndReleasesABlock() {
        var released = block
        released.timeBucket = "afternoon"
        released.inProjectBlock = false
        #expect(editing(block, time(.set("afternoon"))) == released)

        var moved = roadmap
        moved.timeBucket = "evening"
        moved.startTime = "19:00"
        moved.inProjectBlock = false
        #expect(editing(roadmap, time(.set("evening"), .set("19:00"))) == moved)
    }

    /// On a task, a part of day the time overrules still writes: the time
    /// files it back in Morning, and `scheduleTask` sets `inProjectBlock`
    /// false where nothing was stored, so the item is not the same.
    @Test func aPartOfDayUnderATimeStillWritesOnATask() {
        let next = editing(roadmap, time(.set("evening")))
        #expect(next.timeBucket == "morning" && next.startTime == "09:00")
        #expect(next.inProjectBlock == false && roadmap.inProjectBlock == nil)
        #expect(next != roadmap)
    }

    /// A new time alone keeps a project block, in its part of day or across.
    @Test func aNewTimeKeepsAProjectBlock() {
        var within = block
        within.startTime = "09:30"
        #expect(editing(block, time(nil, .set("09:30"))) == within)
        var across = block
        across.startTime = "15:00"
        across.timeBucket = "afternoon"
        #expect(editing(block, time(nil, .set("15:00"))) == across)
    }

    /// Anytime drops the time, and schedules.
    @Test func anytimeDropsTheTime() {
        var want = roadmap
        want.timeBucket = "anytime"
        want.startTime = nil
        want.inProjectBlock = false
        #expect(editing(roadmap, time(.set("anytime"), .clear)) == want)
    }

    /// No specific time in its own part of day: the time alone, cleared.
    @Test func noSpecificTimeClearsTheTime() {
        var want = roadmap
        want.startTime = nil
        #expect(editing(roadmap, time(nil, .clear)) == want)
    }

    /// `isScheduled` nil reads as not scheduled, so a time schedules it.
    @Test func noIsScheduledReadsAsNot() {
        var unknown = roadmap
        unknown.startTime = nil
        unknown.isScheduled = nil
        var want = unknown
        want.startTime = "10:00"
        want.isScheduled = true
        want.inProjectBlock = false
        #expect(editing(unknown, time(nil, .set("10:00"))) == want)
        var unscheduled = unknown
        unscheduled.isScheduled = false
        #expect(editing(unscheduled, time(nil, .set("10:00"))) == want)
    }

    /// A stored "" time is compared raw, as `!==` compares it: Anytime's
    /// "none" picked over a stored Anytime marks the bucket changed, and the
    /// time (none) differs from "", so it is written as none.
    @Test func aStoredEmptyTimeIsComparedRaw() {
        var blankTime = roadmap
        blankTime.timeBucket = "anytime"
        blankTime.startTime = ""
        var want = blankTime
        want.startTime = nil
        #expect(editing(blankTime, time(.clear)) == want)
        // Its seed is "" too, so clearing the time alone changes nothing.
        #expect(editing(blankTime, time(nil, .clear)) == blankTime)
    }

    /// A length alone is the length: never a schedule, never a day.
    @Test func aLengthAloneNeverSchedules() {
        var groceries = roadmap
        groceries.timeBucket = "anytime"
        groceries.startTime = nil
        groceries.duration = nil
        groceries.isScheduled = false
        var want = groceries
        want.duration = 45
        #expect(editing(groceries, time(nil, nil, 45)) == want)
        var longer = roadmap
        longer.duration = 90
        #expect(editing(roadmap, time(nil, nil, 90)) == longer)
        #expect(editing(meds, time(nil, nil, 30)).duration == 30)
    }

    /// What equals the seed changes nothing: the stored values sent back, and
    /// the type's default length where none is stored.
    @Test func anEditEqualToTheSeedChangesNothing() {
        #expect(editing(roadmap, time(.set("morning"), .set("09:00"), 120)) == roadmap)
        var unlengthed = roadmap
        unlengthed.duration = nil
        #expect(editing(unlengthed, time(nil, nil, 30)) == unlengthed)
        var unfiled = meds
        unfiled.timeBucket = nil
        #expect(editing(unfiled, time(.clear, .clear)) == unfiled)
    }

    /// An undated, scheduled task is unscheduled, as `commitEdit` would; the
    /// gate refuses it first (`not_dated`), so this only keeps the port whole.
    @Test func anUndatedScheduledTaskIsUnscheduled() {
        var undated = roadmap
        undated.startDate = nil
        var want = undated
        want.isScheduled = false
        want.timeBucket = nil
        want.startTime = nil
        #expect(editing(undated, time(nil, .set("10:00"))) == want)
        var braindump = undated
        braindump.isScheduled = false
        braindump.timeBucket = nil
        braindump.startTime = nil
        var timed = braindump
        timed.startTime = "10:00"
        #expect(editing(braindump, time(nil, .set("10:00"))) == timed)
    }

    /// A habit's part of day, with the store's `scheduleHabit`.
    @Test func aHabitsPartOfDayIsSet() {
        var evening = meds
        evening.timeBucket = "evening"
        #expect(editing(meds, time(.set("evening"))) == evening)
        // A time with it files where the time falls.
        var late = meds
        late.timeBucket = "evening"
        late.startTime = "21:00"
        #expect(editing(meds, time(.set("morning"), .set("21:00"))) == late)
    }

    /// Under a time, a habit's part of day the time overrules is no change:
    /// `scheduleHabit` files it back where it was, and a habit has no block
    /// to release.
    @Test func aHabitsTimeOverrulesItsPartOfDay() {
        var timed = meds
        timed.startTime = "09:00"
        #expect(editing(timed, time(.set("evening"))) == timed)
    }

    @Test func aHabitsTimeOrPartOfDayIsCleared() {
        var timed = meds
        timed.startTime = "08:00"
        var untimed = timed
        untimed.startTime = nil
        #expect(editing(timed, time(nil, .clear)) == untimed)
        var unfiled = timed
        unfiled.timeBucket = nil
        unfiled.startTime = nil
        #expect(editing(timed, time(.clear, .clear)) == unfiled)
    }

    /// A custom item takes the task's path, and no time edit moves the day.
    @Test func aCustomItemIsTaskShaped() {
        let errand = Item(
            id: uuid(3), type: "custom", customType: "errand", title: "Post office", startDate: "2026-10-01",
            timeBucket: "afternoon", isScheduled: true
        )
        var want = errand
        want.timeBucket = "evening"
        want.inProjectBlock = false
        #expect(editing(errand, time(.set("evening"))) == want)
        let edits = [time(.set("evening")), time(nil, .set("15:00")), time(nil, nil, 45), time(.set("anytime"), .clear)]
        for edit in edits {
            #expect(editing(errand, edit).startDate == "2026-10-01")
            #expect(editing(roadmap, edit).startDate == "2026-10-01")
        }
    }
}

/// DayBuckets.swift's lib/time-bucket.ts rules, by hand. The fixture's
/// `buckets` (`theBucketRulesAreTheWebs`) is what pins them to the web.
@Suite struct TimeBucketRuleTests {
    @Test func aTimeFilesByItsHour() {
        #expect(bucketForTime("00:00") == .morning)
        #expect(bucketForTime("04:59") == .morning)
        #expect(bucketForTime("11:59") == .morning)
        #expect(bucketForTime("12:00") == .afternoon)
        #expect(bucketForTime("16:59") == .afternoon)
        #expect(bucketForTime("17:00") == .evening)
        #expect(bucketForTime("23:59") == .evening)
    }

    /// `parseInt`'s reading of the hour: leading digits, whitespace and a
    /// sign skipped, hex after "0x", and no digits at all NaN.
    @Test func theHourIsReadAsParseIntReadsIt() {
        #expect(bucketForTime("9:30") == .morning)
        #expect(bucketForTime("24:00") == .evening)
        #expect(bucketForTime("x") == .anytime)
        #expect(bucketForTime("") == .anytime)
        #expect(bucketForTime(":30") == .anytime)
        #expect(bucketForTime(" 9:00") == .morning)
        #expect(bucketForTime("12pm") == .afternoon)
        #expect(bucketForTime("-1:00") == .evening)
        #expect(bucketForTime("0x0f:00") == .afternoon)
        #expect(bucketForTime("99999999999999999999999:00") == .evening)
    }

    @Test func aTimeOverrulesAPartOfDay() {
        #expect(autoCorrectBucket("15:00", "morning") == "afternoon")
        #expect(autoCorrectBucket("09:00", "evening") == "morning")
        #expect(autoCorrectBucket("09:00", "morning") == "morning")
        #expect(autoCorrectBucket("x", "morning") == "anytime")
        // Anytime holds any time; no time or no bucket corrects nothing.
        #expect(autoCorrectBucket("09:00", "anytime") == "anytime")
        #expect(autoCorrectBucket(nil, "morning") == "morning")
        #expect(autoCorrectBucket("", "morning") == "morning")
        #expect(autoCorrectBucket("21:00", nil) == nil)
        #expect(autoCorrectBucket("21:00", "") == "")
    }

    @Test func eachPartOfDayStartsWhereTheWebsDoes() {
        #expect(bucketStartTime(.morning) == "05:00")
        #expect(bucketStartTime(.afternoon) == "12:00")
        #expect(bucketStartTime(.evening) == "17:00")
        #expect(bucketStartTime(.anytime) == nil)
        // Each start files in its own part of day.
        for bucket in [DayBucket.morning, .afternoon, .evening] {
            #expect(bucketStartTime(bucket).map(bucketForTime) == bucket, "\(bucket)")
        }
    }
}

/// The Repeat chip's gate: lib/item-edit.ts `editRefusal`'s `repeat` arm
/// (`not_for_subtask`, `frequency_not_allowed`), and the route's schema for
/// the body (`invalid`), which `editAllowed` judges with no row.
@Suite struct RepeatEditAllowedTests {
    private let roadmap = task(1, "Draft Q4 roadmap")
    private let numbers = task(2, "Pull the numbers", parent: 1)
    private let meds = Item(id: uuid(3), type: "habit", title: "Meds", repeatFrequency: "daily")
    private let errand = Item(id: uuid(4), type: "custom", customType: "errand", title: "Post office")

    private func allowed(_ action: String, _ item: Item, caps: ItemCaps? = nil) -> Bool {
        return editAllowed(action: action, on: item, caps: caps ?? DsulCore.caps(item.typeName))
    }

    private func allowed(_ frequency: String, days: [Int]? = nil, monthDay: Int? = nil, on item: Item) -> Bool {
        return editAllowed(.repeats(frequency: frequency, days: days, monthDay: monthDay), on: item,
                           caps: caps(item.typeName))
    }

    /// A task's, a habit's and a custom item's, dated or not; never a
    /// subtask's; and never a type with one frequency, whose chip the web
    /// doesn't offer.
    @Test func aRepeatIsAnyTypesButASubtasks() {
        #expect(allowed("repeat", roadmap), "an undated task")
        #expect(allowed("repeat", meds))
        #expect(allowed("repeat", errand))
        #expect(!allowed("repeat", numbers), "a subtask")
        var blank = roadmap
        blank.parentItemId = ""
        #expect(allowed("repeat", blank), "an empty parent is none")
        var once = ItemCaps.task
        once.allowedFrequencies = ["daily"]
        #expect(!allowed("repeat", roadmap, caps: once))
        #expect(!editAllowed(.repeats(frequency: "daily", days: nil, monthDay: nil), on: roadmap, caps: once))
    }

    /// The type's own frequencies: a habit has no "none", and a frequency no
    /// type lists (the legacy "weekly") is never sent.
    @Test func theFrequencyIsOneTheTypeOffers() {
        #expect(!allowed("none", on: meds), "frequency_not_allowed")
        #expect(allowed("none", on: roadmap))
        #expect(allowed("none", on: errand))
        for frequency in ["daily", "weekdays", "weekends"] {
            #expect(allowed(frequency, on: roadmap) && allowed(frequency, on: meds) && allowed(frequency, on: errand),
                    "\(frequency)")
        }
        #expect(!allowed("weekly", on: roadmap))
        #expect(!allowed("weekly", on: meds))
        #expect(!allowed("", on: roadmap))
        #expect(ItemCaps.task.allowedFrequencies == ["none", "daily", "weekdays", "weekends", "monthly", "custom"])
        #expect(ItemCaps.habit.allowedFrequencies == ["daily", "weekdays", "weekends", "monthly", "custom"])
        #expect(caps("errand").allowedFrequencies == ItemCaps.task.allowedFrequencies)
    }

    /// Custom days carry their days, at least one, ascending, each once,
    /// Sunday (0) to Saturday (6); refused, never cleaned.
    @Test func customDaysAreAscendingAndInTheWeek() {
        #expect(!allowed("custom", days: nil, on: roadmap))
        #expect(!allowed("custom", days: [], on: roadmap))
        #expect(!allowed("custom", days: [3, 1], on: roadmap))
        #expect(!allowed("custom", days: [1, 1], on: roadmap))
        #expect(!allowed("custom", days: [7], on: roadmap))
        #expect(!allowed("custom", days: [-1, 2], on: roadmap))
        #expect(allowed("custom", days: [0, 6], on: roadmap))
        #expect(allowed("custom", days: [0, 1, 2, 3, 4, 5, 6], on: meds))
        // Days beside any other frequency.
        #expect(!allowed("daily", days: [1], on: roadmap))
        #expect(!allowed("monthly", days: [1], monthDay: 1, on: roadmap))
        // A day of the month beside Custom days.
        #expect(!allowed("custom", days: [1], monthDay: 1, on: roadmap))
    }

    /// Monthly carries its day, 1 to 31; no other frequency carries one.
    @Test func monthlyCarriesItsDay() {
        #expect(!allowed("monthly", monthDay: nil, on: roadmap))
        #expect(!allowed("monthly", monthDay: 0, on: roadmap))
        #expect(!allowed("monthly", monthDay: 32, on: roadmap))
        #expect(allowed("monthly", monthDay: 31, on: roadmap))
        #expect(allowed("monthly", monthDay: 1, on: meds))
        #expect(!allowed("daily", monthDay: 1, on: roadmap))
        #expect(!allowed("none", monthDay: 1, on: roadmap))
    }

    /// The type gate still comes first: a body the schema takes is refused
    /// on a subtask.
    @Test func theTypeGateComesFirst() {
        #expect(!allowed("daily", on: numbers))
        #expect(!allowed("custom", days: [1], on: numbers))
    }
}

/// `editing(.repeats)`: lib/item-edit.ts `repeatEditPatch`, the dialog's
/// Repeat chip over the keys sent, all three keys through `repeatPatch`.
@Suite struct RepeatEditingTests {
    /// A daily task from September, done yesterday, with a stale day of the
    /// month from an old Monthly.
    private let plants = Item(
        id: uuid(1), title: "Water the plants", status: "pending", startDate: "2026-09-01", timeBucket: "morning",
        repeatFrequency: "daily", repeatMonthDay: 15, isScheduled: true, completedDates: ["2026-09-30"],
        skippedDates: ["2026-09-28"]
    )
    /// A finished one-off.
    private let passport = Item(
        id: uuid(2), title: "Renew passport", status: "completed", startDate: "2026-09-30"
    )
    private let meds = Item(
        id: uuid(3), type: "habit", title: "Meds", repeatFrequency: "daily", streak: 41,
        completedDates: ["2026-09-30"], dailyCounts: ["2026-09-30": 1]
    )

    private func repeats(_ frequency: String, _ days: [Int]? = nil, _ monthDay: Int? = nil) -> ItemEdit {
        return .repeats(frequency: frequency, days: days, monthDay: monthDay)
    }

    /// No repeat on a task clears all three keys, the stale day too, and
    /// nothing else: the start day stays, so it is a one-off on that day.
    @Test func noRepeatClearsAllThree() {
        var want = plants
        want.repeatFrequency = nil
        want.repeatDays = nil
        want.repeatMonthDay = nil
        #expect(editing(plants, repeats("none")) == want)
        let errand = Item(id: uuid(4), type: "custom", customType: "errand", title: "Stamps", repeatFrequency: "weekdays")
        #expect(editing(errand, repeats("none")).repeatFrequency == nil)
    }

    /// A habit's frequency is kept as given, never cleared; the gate refuses
    /// "none" on one, and the port writes it as `repeatPatch`'s habit
    /// overload would.
    @Test func aHabitKeepsItsFrequency() {
        var weekdays = meds
        weekdays.repeatFrequency = "weekdays"
        #expect(editing(meds, repeats("weekdays")) == weekdays)
        var daily = weekdays
        daily.repeatFrequency = "daily"
        #expect(editing(weekdays, repeats("daily")) == daily)
        #expect(editing(meds, repeats("none")).repeatFrequency == "none")
        // A habit with none stored reads as daily, so daily changes nothing.
        var unset = meds
        unset.repeatFrequency = nil
        #expect(editing(unset, repeats("daily")) == unset)
    }

    /// Custom days set the days and clear the day; Monthly sets the day and
    /// clears the days.
    @Test func eachFrequencyCarriesItsOwnKey() {
        var custom = plants
        custom.repeatFrequency = "custom"
        custom.repeatDays = [1, 3, 5]
        custom.repeatMonthDay = nil
        #expect(editing(plants, repeats("custom", [1, 3, 5])) == custom)
        var monthly = custom
        monthly.repeatFrequency = "monthly"
        monthly.repeatDays = nil
        monthly.repeatMonthDay = 31
        #expect(editing(custom, repeats("monthly", nil, 31)) == monthly)
        var weekends = monthly
        weekends.repeatFrequency = "weekends"
        weekends.repeatMonthDay = nil
        #expect(editing(monthly, repeats("weekends")) == weekends)
    }

    /// What equals the seed changes nothing: the stored rule sent back, a
    /// task with none stored sent none, Monthly with no day stored sent the
    /// 1st, and a stale day under Daily sent Daily (the 15 stays).
    @Test func anEditEqualToTheSeedChangesNothing() {
        #expect(editing(plants, repeats("daily")) == plants)
        #expect(editing(plants, repeats("daily")).repeatMonthDay == 15)
        #expect(editing(passport, repeats("none")) == passport)
        var gym = passport
        gym.status = "pending"
        gym.repeatFrequency = "custom"
        gym.repeatDays = [1, 3]
        #expect(editing(gym, repeats("custom", [1, 3])) == gym)
        var rent = passport
        rent.repeatFrequency = "monthly"
        #expect(rent.repeatMonthDay == nil)
        #expect(editing(rent, repeats("monthly", nil, 1)) == rent)
        // A stored 0 reads as the 1st too (`|| 1`).
        var zero = rent
        zero.repeatMonthDay = 0
        #expect(editing(zero, repeats("monthly", nil, 1)) == zero)
        #expect(editing(rent, repeats("monthly", nil, 2)).repeatMonthDay == 2)
    }

    /// The days compare as an ordered list, as `JSON.stringify` does: stored
    /// days out of order, sent in order, are written.
    @Test func reorderedDaysAreWritten() {
        var stored = passport
        stored.repeatFrequency = "custom"
        stored.repeatDays = [3, 1]
        var want = stored
        want.repeatDays = [1, 3]
        #expect(editing(stored, repeats("custom", [1, 3])) == want)
    }

    /// No repeat edit moves the status, the day, the part of day, the streak
    /// or the done days: a finished one-off that starts repeating stays
    /// finished, and an undated task stays undated.
    @Test func nothingElseMoves() {
        let edits = [
            repeats("none"), repeats("daily"), repeats("weekdays"), repeats("weekends"),
            repeats("monthly", nil, 12), repeats("custom", [0, 3]),
        ]
        for item in [plants, passport, meds] {
            for edit in edits {
                let next = editing(item, edit)
                #expect(next.status == item.status, "\(item.title): \(edit)")
                #expect(next.startDate == item.startDate, "\(item.title): \(edit)")
                #expect(next.timeBucket == item.timeBucket && next.isScheduled == item.isScheduled,
                        "\(item.title): \(edit)")
                #expect(next.streak == item.streak, "\(item.title): \(edit)")
                #expect(next.completedDates == item.completedDates && next.skippedDates == item.skippedDates,
                        "\(item.title): \(edit)")
                #expect(next.dailyCounts == item.dailyCounts, "\(item.title): \(edit)")
            }
        }
        var weekdays = passport
        weekdays.repeatFrequency = "weekdays"
        #expect(editing(passport, repeats("weekdays")) == weekdays)
        let undated = Item(id: uuid(5), title: "Call the bank", status: "pending", isScheduled: false)
        let daily = editing(undated, repeats("daily"))
        #expect(daily.repeatFrequency == "daily" && daily.startDate == nil && daily.isScheduled == false)
    }
}

/// EditCopy.swift's Repeat sheet sentences, by hand. The fixture's `copy`
/// (`theCopyIsTheWebs`) is what pins them to the web.
@Suite struct RepeatCopyTests {
    @Test func theSentencesSayWhatTheWebsSay() {
        #expect(EditCopy.selectAtLeastOneDay == "Select at least one day")
        #expect(EditCopy.monthlyNote == "For months with fewer days, it will occur on the last day.")
        for sentence in [EditCopy.selectAtLeastOneDay, EditCopy.monthlyNote] {
            #expect(!sentence.unicodeScalars.contains("\u{2014}"), "no em dash: \(sentence)")
        }
    }
}

/// EditCopy.swift's lengths, by hand. The fixture's `durations`
/// (`theLengthsAreTheWebs`) is what pins them to the web.
@Suite struct DurationLabelTests {
    @Test func eachPresetHasItsWords() {
        #expect(EditCopy.durationPresets == [15, 30, 45, 60, 90, 120])
        #expect(EditCopy.durationPresets.map(EditCopy.durationLabel)
            == ["15 min", "30 min", "45 min", "1 hour", "1.5 hours", "2 hours"])
    }

    @Test func anyOtherLengthIsMinutes() {
        #expect(EditCopy.durationLabel(50) == "50 min")
        #expect(EditCopy.durationLabel(75) == "75 min")
        #expect(EditCopy.durationLabel(180) == "180 min")
        #expect(EditCopy.durationLabel(1) == "1 min")
    }
}

/// lib/item-edit.ts `sameProjectName`: the project kind's folded name test,
/// with no name read as none.
@Suite struct SameProjectNameTests {
    @Test func noNameIsNoneOnEitherSide() {
        #expect(sameProjectName(nil, nil))
        // An unfiled habit's "" is a name, so its clear always writes.
        #expect(!sameProjectName("", nil))
        // A "" name is no name, as the TS's `name ?` reads it.
        #expect(sameProjectName(nil, ""))
        #expect(!sameProjectName("", ""))
    }

    @Test func aNameIsFolded() {
        #expect(sameProjectName("work", "Work"))
        #expect(sameProjectName("Work", "Work"))
        #expect(!sameProjectName("Work", nil))
        #expect(!sameProjectName(nil, "Work"))
        #expect(!sameProjectName("Work", "Health"))
        // A stored "none" is a name here, as it is to the server.
        #expect(!sameProjectName("none", nil))
        // Folded as `toLowerCase`, the final sigma included.
        #expect(sameProjectName("\u{03A3}\u{03A4}\u{039F}\u{03A7}\u{039F}\u{03A3}",
                                "\u{03C3}\u{03C4}\u{03BF}\u{03C7}\u{03BF}\u{03C2}"))
    }
}

/// The Project chip's gate: lib/item-edit.ts `editRefusal`'s `project` arm
/// (`not_for_subtask`, `no_project`, `project_required`), and the body's own
/// rule, which `editAllowed` judges with no row.
@Suite struct ProjectEditAllowedTests {
    private let roadmap = task(1, "Draft Q4 roadmap")
    private let numbers = task(2, "Pull the numbers", parent: 1)
    private let meds = Item(id: uuid(3), type: "habit", title: "Meds", repeatFrequency: "daily")
    private let errand = Item(id: uuid(4), type: "custom", customType: "errand", title: "Post office")
    private let work = "00000000-0000-4000-8000-00000000051e"

    private func allowed(_ action: String, _ item: Item, caps: ItemCaps? = nil) -> Bool {
        return editAllowed(action: action, on: item, caps: caps ?? DsulCore.caps(item.typeName))
    }

    /// Every shipped type's, never a subtask's, and never a type with no
    /// project axis.
    @Test func aProjectIsAnyTypesButASubtasks() {
        #expect(allowed("project", roadmap))
        #expect(allowed("project", meds))
        #expect(allowed("project", errand))
        #expect(!allowed("project", numbers), "a subtask")
        var blank = roadmap
        blank.parentItemId = ""
        #expect(allowed("project", blank), "an empty parent is none")
        var unfiled = ItemCaps.task
        unfiled.containerKind = nil
        #expect(!allowed("project", roadmap, caps: unfiled), "no_project")
        #expect(!editAllowed(.project(id: work, name: "Work"), on: roadmap, caps: unfiled))
        #expect(ItemCaps.task.containerKind == "projects" && ItemCaps.habit.containerKind == "projects")
        #expect(caps("errand").containerKind == "projects")
        #expect(!ItemCaps.task.containerRequired && !ItemCaps.habit.containerRequired
            && !caps("errand").containerRequired)
    }

    /// The id and the name come together, and No project only where the
    /// type's container isn't required.
    @Test func theIdAndTheNameComeTogether() {
        #expect(editAllowed(.project(id: work, name: "Work"), on: roadmap, caps: .task))
        #expect(editAllowed(.project(id: nil, name: nil), on: roadmap, caps: .task))
        #expect(editAllowed(.project(id: nil, name: nil), on: meds, caps: .habit))
        #expect(!editAllowed(.project(id: work, name: nil), on: roadmap, caps: .task), "an id with no name")
        #expect(!editAllowed(.project(id: nil, name: "Work"), on: roadmap, caps: .task), "a name with no id")
        var required = ItemCaps.task
        required.containerRequired = true
        #expect(!editAllowed(.project(id: nil, name: nil), on: roadmap, caps: required), "project_required")
        #expect(editAllowed(.project(id: work, name: "Work"), on: roadmap, caps: required))
    }

    /// The type gate still comes first: a body the rule takes is refused on
    /// a subtask.
    @Test func theTypeGateComesFirst() {
        #expect(!editAllowed(.project(id: work, name: "Work"), on: numbers, caps: .task))
        #expect(!editAllowed(.project(id: nil, name: nil), on: numbers, caps: .task))
    }
}

/// `editing(.project)`: lib/item-edit.ts `projectRefilePatch`, the bulk Move
/// to project's write, with the release of a parked task.
@Suite struct ProjectEditingTests {
    private let work = "00000000-0000-4000-8000-00000000051e"
    private let health = "00000000-0000-4000-8000-00000000051f"
    private let stale = "00000000-0000-4000-8000-000000000577"
    /// An unfiled task, today, Anytime.
    private let groceries = Item(
        id: uuid(1), title: "Groceries", status: "pending", startDate: "2026-10-01", timeBucket: "anytime",
        isScheduled: true
    )
    /// Filed under Work, by name and id.
    private var standup: Item {
        var item = groceries
        item.title = "Standup"
        item.project = "Work"
        item.projectId = work
        return item
    }
    /// Parked in Work's block: Morning, its own 14:00 on the 30th stashed.
    private var parked: Item {
        var item = standup
        item.title = "Review PRs"
        item.timeBucket = "morning"
        item.inProjectBlock = true
        item.previousStartTime = "14:00"
        item.previousStartDate = "2026-09-30"
        return item
    }
    private let meds = Item(
        id: uuid(2), type: "habit", title: "Meds", status: "pending", timeBucket: "morning", repeatFrequency: "daily",
        project: "", streak: 41, completedDates: ["2026-09-30"], dailyCounts: ["2026-09-30": 1]
    )

    /// The name and the id set; then moved, and cleared.
    @Test func theNameAndTheIdAreSet() {
        var filed = groceries
        filed.project = "Work"
        filed.projectId = work
        #expect(editing(groceries, .project(id: work, name: "Work")) == filed)
        var moved = filed
        moved.project = "Health"
        moved.projectId = health
        #expect(editing(filed, .project(id: health, name: "Health")) == moved)
        #expect(editing(moved, .project(id: nil, name: nil)) == groceries)
    }

    /// Already there by folded name and id: nothing, the stored spelling kept.
    @Test func theSameProjectChangesNothing() {
        #expect(editing(standup, .project(id: work, name: "Work")) == standup)
        var folded = standup
        folded.project = "work"
        #expect(editing(folded, .project(id: work, name: "Work")) == folded)
        #expect(editing(groceries, .project(id: nil, name: nil)) == groceries)
    }

    /// A stale id, or none behind the name, is repaired: the id alone moves.
    @Test func aStaleLinkIsRepaired() {
        var staleLink = standup
        staleLink.projectId = stale
        #expect(editing(staleLink, .project(id: work, name: "Work")) == standup)
        var nameOnly = standup
        nameOnly.projectId = nil
        #expect(editing(nameOnly, .project(id: work, name: "Work")) == standup)
    }

    /// The id is stored lowercase, as Postgres writes it, so an uppercase
    /// one sent back changes nothing.
    @Test func theIdIsStoredLowercase() {
        let next = editing(groceries, .project(id: work.uppercased(), name: "Work"))
        #expect(next.projectId == work)
        #expect(editing(standup, .project(id: work.uppercased(), name: "Work")) == standup)
    }

    /// A parked task moved, or cleared, leaves the block: its own time and day
    /// back, the stash cleared, its part of day (the block's) and its
    /// scheduling kept.
    @Test func aParkedTaskLeavesItsBlock() {
        var released = parked
        released.project = "Health"
        released.projectId = health
        released.inProjectBlock = false
        released.startTime = "14:00"
        released.startDate = "2026-09-30"
        released.previousStartTime = nil
        released.previousStartDate = nil
        let next = editing(parked, .project(id: health, name: "Health"))
        #expect(next == released)
        #expect(next.timeBucket == "morning" && next.isScheduled == true)

        var cleared = released
        cleared.project = nil
        cleared.projectId = nil
        #expect(editing(parked, .project(id: nil, name: nil)) == cleared)
    }

    /// Parked from the braindump, with nothing stashed: no time and no day
    /// back, still scheduled (open question 1's default, the web's rule).
    @Test func anUndatedParkedTaskComesBackWithNoDay() {
        var undated = parked
        undated.previousStartTime = nil
        undated.previousStartDate = nil
        let next = editing(undated, .project(id: health, name: "Health"))
        #expect(next.inProjectBlock == false && next.startTime == nil && next.startDate == nil)
        #expect(next.isScheduled == true && next.timeBucket == "morning")
    }

    /// A same-name link repair keeps it in its own block.
    @Test func aRelinkUnderTheSameNameStaysParked() {
        var staleLink = parked
        staleLink.projectId = stale
        #expect(editing(staleLink, .project(id: work, name: "Work")) == parked)
        var folded = parked
        folded.project = "work"
        folded.projectId = nil
        var relinked = parked
        relinked.project = "Work"
        #expect(editing(folded, .project(id: work, name: "Work")) == relinked)
    }

    /// An unfiled habit's "" is a name, so No project writes, to none; a
    /// stored "none" is a name too, cleared the same way (the sheet reads it
    /// as no project, and the write repairs the row).
    @Test func aHabitsEmptyNameAndNoneAreCleared() {
        var unfiled = meds
        unfiled.project = nil
        #expect(editing(meds, .project(id: nil, name: nil)) == unfiled)
        var none = meds
        none.project = "none"
        #expect(editing(none, .project(id: nil, name: nil)) == unfiled)
        var filed = meds
        filed.project = "Work"
        filed.projectId = work
        #expect(editing(meds, .project(id: work, name: "Work")) == filed)
    }

    /// No project edit moves the status, the streak, the done days, the
    /// scheduling or the part of day.
    @Test func nothingElseMoves() {
        let edits: [ItemEdit] = [
            .project(id: work, name: "Work"), .project(id: health, name: "Health"), .project(id: nil, name: nil),
        ]
        for item in [groceries, standup, parked, meds] {
            for edit in edits {
                let next = editing(item, edit)
                #expect(next.status == item.status, "\(item.title): \(edit)")
                #expect(next.streak == item.streak, "\(item.title): \(edit)")
                #expect(next.completedDates == item.completedDates && next.dailyCounts == item.dailyCounts,
                        "\(item.title): \(edit)")
                #expect(next.isScheduled == item.isScheduled, "\(item.title): \(edit)")
                #expect(next.timeBucket == item.timeBucket, "\(item.title): \(edit)")
            }
        }
    }
}

/// EditCopy.swift's container nouns, by hand. The fixture's `containers`
/// (`theContainerWordsAreTheWebs`) is what pins them to the web.
@Suite struct ContainerWordsTests {
    @Test func theNounsAreTheWebs() {
        #expect(ContainerWords.project == "Project" && ContainerWords.projects == "Projects")
        #expect(ContainerWords.noProject == "No project")
        #expect(ContainerWords.routine == "Routine" && ContainerWords.routines == "Routines")
        #expect(ContainerWords.season == "Season" && ContainerWords.seasons == "Seasons")
    }
}
