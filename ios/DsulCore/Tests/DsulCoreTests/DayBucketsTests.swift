import Testing
import DsulCore

@Suite struct DayBucketsTests {
    private func row(_ id: String, habit: Bool = false, _ bucket: DayBucket?, at start: Int? = nil, order: Int = 0) -> BucketRow<String> {
        BucketRow(id: id, isHabit: habit, bucket: bucket, startMin: start, order: order)
    }

    @Test func webOrderPutsAnytimeFirst() {
        #expect(bucketOrder == [.anytime, .morning, .afternoon, .evening])
        #expect(DayBucket.allCases.count == 4)
    }

    @Test func labelsMatchTheWeb() {
        #expect(bucketOrder.map(\.label) == ["Anytime", "Morning", "Afternoon", "Evening"])
    }

    @Test func anHourIsOwnedByItsBucket() {
        #expect(DayBucket.owning(minute: 0) == .morning)
        #expect(DayBucket.owning(minute: 11 * 60 + 59) == .morning)
        #expect(DayBucket.owning(minute: 12 * 60) == .afternoon)
        #expect(DayBucket.owning(minute: 17 * 60) == .evening)
        #expect(DayBucket.owning(minute: 23 * 60 + 45) == .evening)
    }

    @Test func anItemGoesInItsStoredBucketEvenAgainstItsTime() {
        // The stored bucket wins: deriveDayItems never re-reads the hour.
        let out = bucketDayRows([row("late", .morning, at: 20 * 60)])
        #expect(out[.morning] == ["late"])
        #expect(out[.evening] == [])
    }

    @Test func anItemWithNoBucketShowsNowhere() {
        let out = bucketDayRows([row("loose", nil), row("kept", .anytime)])
        #expect(out.values.flatMap { $0 } == ["kept"])
    }

    @Test func everyBucketHasAnEntry() {
        let out = bucketDayRows([BucketRow<String>]())
        #expect(out.count == 4)
        #expect(out.values.allSatisfy { $0.isEmpty })
    }

    @Test func untimedHabitsThenUntimedTasksThenTheTimedSpine() {
        // The Morning card on the boards: three routine habits, then the 9–11 block.
        let out = bucketDayRows([
            row("draft", .morning, at: 9 * 60),
            row("meds", habit: true, .morning),
            row("standup", .morning, at: 8 * 60),
            row("inbox", .morning),
            row("stretch", habit: true, .morning),
            row("walk", habit: true, .morning, at: 8 * 60),
        ])
        #expect(out[.morning] == ["meds", "stretch", "inbox", "walk", "standup", "draft"])
    }

    @Test func untimedTasksFollowTheirOrder() {
        let out = bucketDayRows([
            row("b", .anytime, order: 2),
            row("a", .anytime, order: 1),
            row("c", .anytime, order: 2),
        ])
        #expect(out[.anytime] == ["a", "b", "c"])
    }

    @Test func byTimeThenOrderIsStable() {
        let rows = [row("x", .anytime, at: 600), row("y", .anytime, at: 600), row("z", .anytime)]
        #expect(sortedByTimeThenOrder(rows).map(\.id) == ["x", "y", "z"])
        #expect(sortedByTimeThenOrder(Array(rows.reversed())).map(\.id) == ["y", "x", "z"])
    }
}

@Suite struct HabitCompletionTests {
    private let day = DayString("2026-10-01")!

    @Test func tickingAddsTheDayAndCountsOne() {
        let next = settingHabitCompletion(HabitMark(completedDates: ["2026-09-30"], streak: 4), done: true, on: day)
        #expect(next.completedDates == ["2026-09-30", "2026-10-01"])
        #expect(next.streak == 5)
    }

    @Test func untickingRemovesTheDayAndTakesOne() {
        let next = settingHabitCompletion(HabitMark(completedDates: ["2026-10-01"], streak: 4), done: false, on: day)
        #expect(next.completedDates.isEmpty)
        #expect(next.streak == 3)
    }

    @Test func aRepeatOfTheSameStateChangesNothing() {
        let done = HabitMark(completedDates: ["2026-10-01"], streak: 4)
        #expect(settingHabitCompletion(done, done: true, on: day) == done)
        let open = HabitMark(completedDates: [], streak: 4)
        #expect(settingHabitCompletion(open, done: false, on: day) == open)
    }

    @Test func theStreakNeverGoesBelowZero() {
        let next = settingHabitCompletion(HabitMark(completedDates: ["2026-10-01"], streak: 0), done: false, on: day)
        #expect(next.streak == 0)
    }

    @Test func theStreakIsNotRecomputedFromHistory() {
        // 41 with one date on file: the counter is opaque and only moves by one.
        let next = settingHabitCompletion(HabitMark(completedDates: ["2026-01-01"], streak: 41), done: true, on: day)
        #expect(next.streak == 42)
    }
}
