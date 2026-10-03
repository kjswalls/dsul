import Foundation
import Testing
import DsulCore

// ItemEdit.swift on hand-written text and lists: the cleaners at their limits,
// JavaScript's trim, the growth caps, a new subtask and a streak reset, and
// where a failed delete puts things back. The web's own answers for the same
// functions are in EditWritesFixtureTests.

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
