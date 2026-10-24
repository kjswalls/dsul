import DsulCore
import SwiftUI

/// Week × Buckets (design §4.4, W3): the selected day's week as seven day
/// sections, each its heading over one card of that day's parts of the day,
/// in the phone's order (Morning, Afternoon, Evening, Anytime), filed by
/// DsulCore's `bucketDayRows` as Day's cards are. A part with nothing in it is
/// left out, and a day with nothing at all says "Nothing planned." The web's
/// 28 cells across do not fit a phone (understand-web-week.md §8).
///
/// Rows read, tick and open at their own day, as on Week × List; "Now" shows
/// on today's rows alone. Day's Buckets draws no current-part mark, so this
/// draws none either. A heading opens its day in Day. It opens on the
/// selected day, and goes back to it when the selected day moves. Signed in,
/// a pull refreshes it.
struct WeekBuckets: View {
    var nowMin: Int
    /// A heading's tap: that day, in Day.
    var openDay: (DayString) -> Void

    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        let week = planner.weekRows(of: planner.selectedDay)
        ScrollViewReader { proxy in
            ScrollView {
                // A plain stack: seven days, and a scroll to the fifth must
                // land on it, not on an estimate of where it would be.
                VStack(alignment: .leading, spacing: 6) {
                    if !planner.hasLoaded {
                        PlannerLoadingRow()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 6)
                    } else {
                        ForEach(week) { day in
                            WeekBucketsDay(day: day.day, buckets: planner.buckets(day.rows), nowMin: nowMin) {
                                openDay(day.day)
                            }
                            .id(day.day)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .modifier(LiveRefresh(planner: planner))
            .onAppear {
                proxy.scrollTo(planner.selectedDay, anchor: .top)
            }
            .onChange(of: planner.selectedDay) { _, day in
                withAnimation(.snappy) { proxy.scrollTo(day, anchor: .top) }
            }
            .onChange(of: planner.hasLoaded) { _, loaded in
                // Signed in, the days arrive with the first fetch: open on the
                // selected one then.
                if loaded { proxy.scrollTo(planner.selectedDay, anchor: .top) }
            }
        }
    }
}

/// One day of Week × Buckets: the heading, then a card holding each part of
/// the day that has something in it, or "Nothing planned."
private struct WeekBucketsDay: View {
    var day: DayString
    var buckets: [DayBucket: [SampleItem]]
    var nowMin: Int
    var onOpen: () -> Void

    @Environment(SamplePlanner.self) private var planner

    /// Day's order (`BucketsLayout.order`), the parts with rows only.
    private var filled: [DayBucket] {
        BucketsLayout.order.filter { !(buckets[$0] ?? []).isEmpty }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            WeekDayHeader(day: day, isToday: day == planner.today, onOpen: onOpen)
                .padding(.top, 10)

            if filled.isEmpty {
                Text(PlannerFormat.nothingPlanned)
                    .font(.subheadline)
                    .italic()
                    .foregroundStyle(Color.secondary)
                    .padding(.bottom, 4)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(filled, id: \.self) { bucket in
                        bucketGroup(bucket, items: buckets[bucket] ?? [])
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color(.secondarySystemBackground)))
            }
        }
    }

    /// A part of the day: its small label, then its rows.
    private func bucketGroup(_ bucket: DayBucket, items: [SampleItem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(bucket.label)
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(Color.secondary)
                .accessibilityAddTraits(.isHeader)
            ForEach(items) { item in
                ItemRow(item: item, done: planner.isDone(item, on: day), skipped: planner.isSkipped(item, on: day),
                        isNow: day == planner.today && PlannerFormat.isNow(startMin: item.startMin,
                                                                          durationMin: item.durationMin,
                                                                          nowMin: nowMin),
                        streaksEnabled: planner.settings.streaksEnabled,
                        onToggle: {
                            withAnimation(.snappy) { planner.toggleRow(item.id, on: day) }
                        },
                        onOpen: { planner.open(item.id, day: .on(day)) })
            }
        }
    }
}
