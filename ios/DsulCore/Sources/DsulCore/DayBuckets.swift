import Foundation

// Port of the bucket placement in lib/day-items.ts (`deriveDayItems`,
// `byTimeThenOrder`, `BUCKET_ORDER`) and of the row order inside one bucket in
// components/views/day-buckets.tsx (`DayBucket`). Keep in step: a change there
// without the same change here is drift, and the phone files a row under a
// different bucket than the web.
//
// What is ported: an item goes in its stored bucket and nowhere else; an item
// with no bucket shows in none; inside a bucket the untimed rows come first
// (habits, then tasks) and the timed rows follow in time order. What is not:
// which items are on the day at all (the caller passes them in, already
// filtered), project time blocks, `inProjectBlock`, grouping and the
// finished-row sink, none of which the sample model has yet.

/// packages/types/src/schemas.ts `TimeBucketSchema`: the four buckets an item
/// can be filed under. `TimeBucket` in ScheduleMath.swift is the narrower
/// answer to "which bucket owns this hour", which is never `anytime`.
public enum DayBucket: String, Sendable, Hashable, CaseIterable {
    case anytime, morning, afternoon, evening

    public init(_ bucket: TimeBucket) {
        switch bucket {
        case .morning: self = .morning
        case .afternoon: self = .afternoon
        case .evening: self = .evening
        }
    }

    /// lib/planner-types.ts `TIME_BUCKET_RANGES[bucket].label`.
    public var label: String {
        switch self {
        case .anytime: "Anytime"
        case .morning: "Morning"
        case .afternoon: "Afternoon"
        case .evening: "Evening"
        }
    }

    /// lib/dnd/handle-drag-end.ts `hour:{H}`: the bucket a block scheduled at
    /// `minutes` is filed under (the hour's owner, via `bucketForMinute`).
    public static func owning(minute minutes: Int) -> DayBucket {
        DayBucket(bucketForMinute(minutes))
    }
}

/// lib/day-items.ts `BUCKET_ORDER`, the web's render order.
public let bucketOrder: [DayBucket] = [.anytime, .morning, .afternoon, .evening]

/// What the bucket rule reads off an item. `startMin` is the web's `startTime`
/// ("HH:mm") as minutes; the two order the same.
public struct BucketRow<ID: Hashable & Sendable>: Sendable, Hashable {
    public var id: ID
    public var isHabit: Bool
    public var bucket: DayBucket?
    public var startMin: Int?
    /// The web's `order`. Habits have none and read as 0.
    public var order: Int

    public init(id: ID, isHabit: Bool, bucket: DayBucket?, startMin: Int?, order: Int = 0) {
        self.id = id
        self.isHabit = isHabit
        self.bucket = bucket
        self.startMin = startMin
        self.order = order
    }
}

/// lib/day-items.ts `byTimeThenOrder`: timed rows first in time order, then
/// untimed rows by `order`. Stable: ties keep their input order, as JS's sort
/// does (Swift's `sort` doesn't promise that, so the index breaks ties).
public func sortedByTimeThenOrder<ID>(_ rows: [BucketRow<ID>]) -> [BucketRow<ID>] {
    let indexed = Array(rows.enumerated())
    let sorted = indexed.sorted { a, b in
        let x = a.element
        let y = b.element
        switch (x.startMin, y.startMin) {
        case let (s?, t?):
            if s != t { return s < t }
        case (.some, nil):
            return true
        case (nil, .some):
            return false
        case (nil, nil):
            if x.order != y.order { return x.order < y.order }
        }
        return a.offset < b.offset
    }
    return sorted.map(\.element)
}

/// One day's rows filed by bucket, each bucket in the order day-buckets.tsx
/// draws it: untimed habits, untimed tasks, then every timed row by time
/// (habits before tasks at the same minute). Every bucket has an entry, empty
/// or not. Rows with no bucket are dropped, as `deriveDayItems` drops them.
public func bucketDayRows<ID>(_ rows: [BucketRow<ID>]) -> [DayBucket: [ID]] {
    var result: [DayBucket: [ID]] = [:]
    for bucket in bucketOrder { result[bucket] = [] }
    // deriveDayItems sorts each type on its own, then files it.
    let habits = sortedByTimeThenOrder(rows.filter { $0.isHabit && $0.bucket != nil })
    let tasks = sortedByTimeThenOrder(rows.filter { !$0.isHabit && $0.bucket != nil })
    for bucket in bucketOrder {
        let h = habits.filter { $0.bucket == bucket }
        let t = tasks.filter { $0.bucket == bucket }
        let untimed = h.filter { $0.startMin == nil } + t.filter { $0.startMin == nil }
        let timed = sortedByTimeThenOrder(h.filter { $0.startMin != nil } + t.filter { $0.startMin != nil })
        result[bucket] = (untimed + timed).map(\.id)
    }
    return result
}
