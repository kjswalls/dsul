import Foundation

// lib/overdue.ts, ported: the ONE definition of "past due". Pure and
// string-based like the web's, so callers pass the day and no device zone can
// move it. The ghost rows (GhostRows.swift) are its only reader on the phone.

/// lib/overdue.ts `RECENT_OVERDUE_DAYS`: `<=` is the recent cohort, `>` the
/// earlier one, so 7 days is still recent and 8 is earlier.
public let recentOverdueDays = 7

/// Days since 1970-01-01 for a proleptic Gregorian y-m-d, rolling an
/// out-of-range month or day over as `Date.UTC` does.
private func civilDays(_ y: Int, _ m: Int, _ d: Int) -> Int {
    // Normalise the month first (Date.UTC(y, 12, 1) is the next January).
    let m0 = m - 1
    let year = y + Int((Double(m0) / 12).rounded(.down))
    let month = ((m0 % 12) + 12) % 12 + 1
    // Howard Hinnant's days_from_civil.
    let yy = month <= 2 ? year - 1 : year
    let era = (yy >= 0 ? yy : yy - 399) / 400
    let yoe = yy - era * 400
    let mp = (month + 9) % 12
    let doy = (153 * mp + 2) / 5
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468 + (d - 1)
}

/// lib/overdue.ts `toUTCms`, in whole days: nil where the web's is NaN.
private func utcDay(_ dateStr: String) -> Int? {
    let parts = toDateOnly(dateStr).split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count >= 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]) else { return nil }
    return civilDays(y, m, d)
}

/// lib/overdue.ts `daysOverdue`: whole calendar days between the item's start
/// date and `today`. Positive is overdue by that many days (1 = yesterday);
/// 0 is due today, undated or unparseable; negative is ahead.
public func daysOverdue(_ item: Item, today: String) -> Int {
    guard let start = item.startDate, !start.isEmpty,
          let s = utcDay(start), let t = utcDay(today) else { return 0 }
    return t - s
}

/// lib/overdue.ts `selectOverdue`: every item past its date that still wants
/// doing. Its type is `carryForwardEligible` and `dateAnchored`, it is not set
/// aside today (`inactiveIds`, REQUIRED as the web's is), not a subtask, not
/// recurring, `pending`, and dated strictly before `today`. The recent cohort
/// comes first, newest first, then the earlier tail oldest first; ties keep
/// the order the items arrived in.
public func selectOverdue(
    _ items: [Item],
    today todayStr: String,
    inactiveIds: Set<UUID>
) -> [Item] {
    let today = toDateOnly(todayStr)
    let overdue = items.filter { t in
        let config = caps(t.typeName)
        guard config.carryForwardEligible, config.dateAnchored else { return false }
        if inactiveIds.contains(t.id) { return false }
        if let parent = t.parentItemId, !parent.isEmpty { return false }
        if isRecurring(t.rule) { return false }
        guard t.status == "pending" else { return false }
        guard let start = t.startDate, !start.isEmpty else { return false }
        return toDateOnly(start) < today
    }
    let ages: [Int] = overdue.map { daysOverdue($0, today: today) }
    let order: [Int] = overdue.indices.sorted { a, b in
        let aLong = ages[a] > recentOverdueDays
        let bLong = ages[b] > recentOverdueDays
        if aLong != bLong { return !aLong }
        if ages[a] != ages[b] { return aLong ? ages[a] > ages[b] : ages[a] < ages[b] }
        return a < b
    }
    return order.map { overdue[$0] }
}
