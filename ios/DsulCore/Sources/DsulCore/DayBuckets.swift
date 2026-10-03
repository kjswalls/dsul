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
//
// From 2d, the time-to-bucket rules of lib/time-bucket.ts too, which the Time
// sheet and its edit read: `getBucketForTime` (`bucketForTime`),
// `autoCorrectBucket` and `BUCKET_START_TIMES` (`bucketStartTime`). Checked
// against the web by EditWritesFixtureTests (edit-writes.json's `buckets`).

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

// MARK: - A time's part of day (lib/time-bucket.ts)

/// JavaScript's `parseInt(s)` with no radix, as far as an hour needs it:
/// leading whitespace skipped (`isJSWhitespace`, the same set), one sign, a
/// "0x" prefix read as hex, then the longest run of digits. Nil where
/// JavaScript answers NaN (no digits at all). A Double, so a long run of
/// digits grows past every hour rather than overflowing.
func jsParseInt(_ s: String) -> Double? {
    var scalars = Substring(s).unicodeScalars.drop(while: isJSWhitespace)
    var sign: Double = 1
    if let first = scalars.first, first == "-" || first == "+" {
        if first == "-" { sign = -1 }
        scalars = scalars.dropFirst()
    }
    var radix: UInt32 = 10
    if scalars.count >= 2, scalars.first == "0",
       let x = scalars.dropFirst().first, x == "x" || x == "X" {
        radix = 16
        scalars = scalars.dropFirst(2)
    }
    var value: Double = 0
    var read = false
    for scalar in scalars {
        let digit: UInt32
        switch scalar.value {
        case 0x30...0x39: digit = scalar.value - 0x30
        case 0x61...0x66 where radix == 16: digit = scalar.value - 0x61 + 10
        case 0x41...0x46 where radix == 16: digit = scalar.value - 0x41 + 10
        default: return read ? sign * value : nil
        }
        value = value * Double(radix) + Double(digit)
        read = true
    }
    return read ? sign * value : nil
}

/// lib/time-bucket.ts `getBucketForTime`: the part of day a time files under,
/// by its hour as `parseInt(time.split(':')[0])` reads it (leading digits, so
/// "9:30" is 9), against lib/planner-types.ts `TIME_BUCKET_RANGES`: 0 to 11
/// Morning, 12 to 16 Afternoon, 17 and up Evening, and below 0 Evening too,
/// as the JS's `hour < 5` arm answers (Morning's range already holds 0 to 4).
/// No hour at all (NaN: "", "x") is Anytime. Not `DayBucket.owning(minute:)`,
/// which reads minutes the grid has already kept inside the day.
public func bucketForTime(_ time: String) -> DayBucket {
    let head = time.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
    guard let hour = jsParseInt(String(head)) else { return .anytime }
    if hour >= 0 && hour < 12 { return .morning }
    if hour >= 12 && hour < 17 { return .afternoon }
    if hour >= 17 || hour < 5 { return .evening }
    return .anytime
}

/// lib/time-bucket.ts `autoCorrectBucket`, on the stored strings: a time
/// overrules a part of day it doesn't fall in, so a non-empty time under a
/// non-empty bucket other than "anytime" answers the time's own
/// (`bucketForTime`); anything else answers `bucket` as it was (Anytime holds
/// any time, and no time or no bucket corrects nothing). A bucket the enum
/// doesn't name is corrected too, as JavaScript's truthiness has it.
public func autoCorrectBucket(_ time: String?, _ bucket: String?) -> String? {
    guard let time, !time.isEmpty, let bucket, !bucket.isEmpty, bucket != DayBucket.anytime.rawValue else {
        return bucket
    }
    return bucketForTime(time).rawValue
}

/// lib/time-bucket.ts `BUCKET_START_TIMES`: where each part of day starts as
/// the web offers it (a project time block's default start, and the Time
/// sheet's Add a time). Morning "05:00", Afternoon "12:00", Evening "17:00";
/// nil for Anytime, which has no start. Not `TIME_BUCKET_RANGES`' first hour,
/// which starts Morning at midnight.
public func bucketStartTime(_ bucket: DayBucket) -> String? {
    switch bucket {
    case .anytime: nil
    case .morning: "05:00"
    case .afternoon: "12:00"
    case .evening: "17:00"
    }
}

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
