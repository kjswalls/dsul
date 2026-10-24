import DsulCore
import SwiftUI

/// The day's untimed rows, in a band pinned above the hours (design §5.2):
/// untimed habits, then untimed tasks not in a project block
/// (`deriveUntimedRows`, the web's Anytime rows, day-schedule.tsx). Its
/// header is always there, "Anytime" or "Anytime · 4", so nothing above the
/// grid changes height when a drag begins; a tap on it folds the rows away
/// or brings them back, and the choice is kept on this device. Up to three
/// rows show (one at the accessibility text sizes); more scroll inside the
/// band. While the braindump sheet is up
/// the band shows its header only, so the grid keeps its room above a medium
/// sheet, and the stored choice is left alone (`AnytimeBandRules`).
///
/// Each row ticks and opens on the band's day, as a List row does. Drops on
/// the band and drags from it come with PR 8.
struct AnytimeBand: View {
    /// The day, laid out once by ScheduleView: the band draws its untimed
    /// rows (`deriveUntimedRows`, from the same derive as the blocks) and
    /// ticks them on its day.
    let schedule: DaySchedule
    /// The braindump sheet is up.
    let sheetUp: Bool

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @AppStorage(AnytimeBandRules.storageKey) private var open = AnytimeBandRules.defaultOpen
    /// A row's height at the default text size, scaled: the band's scroll
    /// cap is `visibleRows` of them.
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 44

    private var day: DayString { schedule.day }
    private var rows: [SampleItem] { schedule.untimed }
    /// Three rows, or one at the accessibility sizes, so the hours keep
    /// their room on a small phone.
    private var visibleRows: Int {
        AnytimeBandRules.visibleRows(accessibilitySize: typeSize.isAccessibilitySize)
    }

    private var showsRows: Bool {
        AnytimeBandRules.showsRows(open: open, sheetUp: sheetUp) && !rows.isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if showsRows {
                if rows.count > visibleRows {
                    ScrollView {
                        rowList
                    }
                    .frame(maxHeight: rowHeight * CGFloat(visibleRows))
                    .scrollIndicatorsFlash(onAppear: true)
                } else {
                    rowList
                }
            }
            Divider()
        }
        .background(Color(.systemBackground))
    }

    /// The header: the word and the count, and with rows a chevron and a
    /// tap that folds them. Folding waits while the sheet is up, since the
    /// rows are already put away then.
    @ViewBuilder
    private var header: some View {
        if rows.isEmpty {
            headerLabel
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(AnytimeBandRules.spokenHeader(count: 0)))
                .accessibilityAddTraits(.isHeader)
        } else {
            Button {
                withAnimation(reduceMotion ? nil : .snappy) {
                    open = AnytimeBandRules.afterTap(open: open, sheetUp: sheetUp)
                }
            } label: {
                headerLabel
            }
            .buttonStyle(.plain)
            .disabled(sheetUp)
            .accessibilityLabel(Text(AnytimeBandRules.spokenHeader(count: rows.count)))
            .accessibilityValue(Text(showsRows ? "Expanded" : "Collapsed"))
            .accessibilityAddTraits(.isHeader)
            .accessibilityHint(Text(sheetUp ? "" : (showsRows ? "Hides the rows" : "Shows the rows")))
        }
    }

    private var headerLabel: some View {
        HStack(spacing: 6) {
            Text(AnytimeBandRules.header(count: rows.count))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            if !rows.isEmpty {
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(showsRows ? 0 : -90))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private var rowList: some View {
        VStack(spacing: 0) {
            ForEach(rows) { item in
                ItemRow(item: item, done: planner.isDone(item, on: day), skipped: planner.isSkipped(item, on: day),
                        streaksEnabled: planner.settings.streaksEnabled,
                        onToggle: { toggle(item) },
                        onOpen: { planner.open(item.id, day: .selected) })
                    .padding(.horizontal, 16)
                    .padding(.vertical, 7)
            }
        }
    }

    /// A row's tick on the band's day, ungated, as a List row's
    /// (`tickAnytimeRow`, which ScheduleLayoutTests drives).
    private func toggle(_ item: SampleItem) {
        withAnimation(.snappy) { planner.tickAnytimeRow(item, in: schedule) }
    }
}
