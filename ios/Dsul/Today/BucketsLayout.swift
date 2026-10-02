import DsulCore
import SwiftUI

/// The Buckets layout (E and G boards): one card per bucket with its count,
/// or "Nothing yet" when it's empty. The rule that files each item is
/// DsulCore's `bucketDayRows`, the port of lib/day-items.ts. Signed in, a pull
/// refreshes it.
struct BucketsLayout: View {
    @Environment(SamplePlanner.self) private var planner
    var nowMin: Int

    /// The boards' order, Anytime last. The web draws `bucketOrder`
    /// (Anytime first); the phone follows the design here.
    static let order: [DayBucket] = [.morning, .afternoon, .evening, .anytime]

    var body: some View {
        let buckets = planner.buckets()
        ScrollView {
            LazyVStack(spacing: 10) {
                if !planner.hasLoaded {
                    PlannerLoadingRow()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 6)
                }
                ForEach(Self.order, id: \.self) { bucket in
                    BucketCard(bucket: bucket, items: buckets[bucket] ?? [], nowMin: nowMin)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .modifier(LiveRefresh(planner: planner))
    }
}

private struct BucketCard: View {
    var bucket: DayBucket
    var items: [SampleItem]
    var nowMin: Int

    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: Self.icon(bucket))
                    .foregroundStyle(Self.tint(bucket))
                    .frame(width: 18)
                Text(bucket.label)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(items.isEmpty ? "Nothing yet" : "\(items.count)")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)

            ForEach(items) { item in
                ItemRow(item: item, done: planner.isDone(item), skipped: planner.isSkipped(item),
                        isNow: planner.isOnToday && PlannerFormat.isNow(startMin: item.startMin,
                                                                       durationMin: item.durationMin,
                                                                       nowMin: nowMin),
                        onToggle: {
                            withAnimation(.snappy) { planner.toggle(item.id) }
                        })
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(Color(.secondarySystemBackground)))
    }

    private static func icon(_ bucket: DayBucket) -> String {
        switch bucket {
        case .morning: "sunrise"
        case .afternoon: "sun.max"
        case .evening: "moon"
        case .anytime: "clock"
        }
    }

    private static func tint(_ bucket: DayBucket) -> Color {
        switch bucket {
        case .morning, .afternoon: .orange
        case .evening, .anytime: .secondary
        }
    }
}
