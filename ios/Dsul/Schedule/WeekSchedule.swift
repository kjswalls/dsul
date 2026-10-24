import DsulCore
import SwiftUI

/// Week × Schedule (Week and blocks PR 10, design §4.5; Kirby's Q1, three
/// days): the selected day's week as seven day columns, three across (two
/// from the first accessibility text size up), swiped sideways a day at a
/// time, under the hour gutter, which never moves sideways.
///
/// One vertical scroll view, as Day's grid, holds the gutter and a
/// horizontal scroll view of the seven columns. Each column is its day's
/// head (the heading and the Anytime strip) over that day's 24 hours, the
/// same `ScheduleColumn` Day draws, in its compact form. The heads, and the
/// gutter's cell above the hours, stay pinned to the top while the hours
/// scroll under them (`PinnedToTop`), all one height (`WeekHead`), so the
/// seven grids share one baseline; the hours start that far down the
/// scroll's content (`ScheduleDrag.hoursTop`).
///
/// What reads what (design §5.1): the week is laid out once by ScheduleView
/// and handed down as values; this body and the columns read the drag only
/// in callbacks. A ghost step re-renders each column's drag layer and
/// ScheduleView's haptic, and derives nothing (`SamplePlanner.week(of:)`
/// keeps the week until something it reads changes).
///
/// Drops (design §4.5, "Drops"): each column's hours and each strip is its
/// own drop destination, so a drop knows its day and its target without
/// reading x. The hours send every session update to
/// `ScheduleDrag.columnUpdate`, the ghost following the finger from column to
/// column (or staying on its own for a habit or a series, B18), and let go
/// through `SamplePlanner.dropOnHour` on their day. A strip takes a time-free
/// drop through `dropOnAnytime`, and refuses a block of another day (B22).
///
/// The rest is Day's: a block opens on its column's day and ticks there, a
/// heading or a strip's "+N more" opens its day in Day, Change length works
/// in any column (the grips measure in the hours' viewport, named here as on
/// Day), and a tap on the hours that no block takes clears the selection.
struct WeekSchedule: View {
    @Binding var position: ScrollPosition
    /// The columns' sideways position, by day.
    @Binding var columns: ScrollPosition
    /// The seven days, in column order, laid out once by ScheduleView.
    let week: [DaySchedule]
    /// Minutes after midnight on today's clock.
    let nowMin: Int
    /// Written with a column's width whenever it changes: what ScheduleView
    /// lays the blocks out on. Nil until the columns are measured.
    @Binding var columnWidth: Double?
    /// A heading's tap, or a strip's "+N more": that day, in Day.
    let openDay: (DayString) -> Void

    @Environment(SamplePlanner.self) private var planner
    @Environment(ScheduleDrag.self) private var drag
    @Environment(\.dynamicTypeSize) private var typeSize
    /// A heading's height, a strip row's and the "+N more" line's, at the
    /// default text size, scaled.
    @ScaledMetric(relativeTo: .subheadline) private var headingHeight: CGFloat = 32
    @ScaledMetric(relativeTo: .footnote) private var rowHeight: CGFloat = 28
    @ScaledMetric(relativeTo: .footnote) private var moreHeight: CGFloat = 22
    /// The columns' scroll view's width, as last measured.
    @State private var viewportW: Double = 0

    private let hourPx = CGFloat(ScheduleMetrics.hourPx)

    private var across: Int {
        WeekScheduleRules.across(accessibilitySize: typeSize.isAccessibilitySize)
    }

    var body: some View {
        let timeFormat = planner.settings.timeFormat
        let limit = WeekScheduleRules.stripRows(accessibilitySize: typeSize.isAccessibilitySize)
        let lines = WeekScheduleRules.stripLines(counts: week.map(\.untimed.count), limit: limit)
        let head = WeekHead(heading: headingHeight, row: rowHeight, more: moreHeight, rows: lines.rows,
                            hasMore: lines.more, limit: limit)
        let width = WeekScheduleRules.columnWidth(viewportW: viewportW, across: across)
        let holdsToday = week.contains { $0.day == planner.today }
        ScrollView {
            HStack(alignment: .top, spacing: 0) {
                HourGutter(timeFormat: timeFormat, nowMin: holdsToday ? nowMin : nil)
                    // Grows with the text up to the first accessibility size,
                    // then caps (design §5.10), as on Day.
                    .dynamicTypeSize(...DynamicTypeSize.accessibility1)
                    .padding(.top, head.height)
                    .overlay(alignment: .top) {
                        // The gutter's cell beside the heads: opaque and
                        // pinned with them, so no hour mark shows through.
                        Color(.systemBackground)
                            .frame(height: head.height)
                            .overlay(alignment: .bottom) { Divider() }
                            .modifier(PinnedToTop())
                            .accessibilityHidden(true)
                    }
                ScrollView(.horizontal) {
                    HStack(spacing: 0) {
                        ForEach(Array(week.enumerated()), id: \.element.day) { index, day in
                            WeekColumn(schedule: day, index: index, head: head, columnWidth: width, nowMin: nowMin,
                                       timeFormat: timeFormat, openDay: openDay)
                                .containerRelativeFrame(.horizontal, count: across, spacing: 0)
                        }
                    }
                    .scrollTargetLayout()
                }
                // A swipe moves a day at a time and stops on a column's edge.
                .scrollTargetBehavior(.viewAligned(limitBehavior: .alwaysByOne))
                .scrollPosition($columns, anchor: .leading)
                .scrollIndicators(.hidden)
                .onScrollGeometryChange(for: Double.self, of: { Double($0.contentOffset.x) }) { _, x in
                    drag.offsetX = x
                }
                .onGeometryChange(for: Double.self) { proxy in
                    Double(proxy.size.width)
                } action: { measured in
                    viewportW = measured
                    drag.viewportW = measured
                }
            }
            .padding(.trailing, CGFloat(WeekScheduleRules.trailingMargin))
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .contentShape(Rectangle())
            .modifier(TapClearsSelection())
        }
        // The hours' viewport, as on Day: a grip measures in it.
        .coordinateSpace(.named(ResizeGrips.viewportSpace))
        .scrollPosition($position)
        .onScrollGeometryChange(for: ScrollGeometry.self, of: { $0 }) { _, geometry in
            drag.offsetY = Double(geometry.contentOffset.y)
            drag.viewportH = Double(geometry.containerSize.height)
            drag.contentH = Double(geometry.contentSize.height)
        }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.frame(in: .global).maxY
        } action: { bottom in
            drag.viewportBottomGlobal = Double(bottom)
        }
        .onChange(of: Double(head.height), initial: true) { _, top in
            drag.hoursTop = top
        }
        .onChange(of: week.map(\.day), initial: true) { _, days in
            drag.columnDays = days
        }
        .onChange(of: width, initial: true) { _, measured in
            // Only a measured width: on coming back to Week the columns are
            // not measured yet (0), and the width ScheduleView kept from the
            // last time lays the blocks out until they are.
            guard measured > 0 else { return }
            drag.columnWidth = measured
            columnWidth = measured
        }
        .onAppear {
            // 8:00 just under the pinned heads: the heads cover the top
            // `hoursTop` of the viewport, where the hours' first
            // `hoursTop` points of content would show.
            position.scrollTo(y: 8 * hourPx)
            openOnSelectedDay()
        }
        .onChange(of: planner.selectedDay) {
            openOnSelectedDay()
        }
        .onChange(of: across) {
            openOnSelectedDay()
        }
    }

    /// The selected day at the leading edge, or as near it as the week's end
    /// allows (W15): on opening, and when the selected day moves (Go to
    /// date, Today) or the columns across change. Never animated, whatever
    /// transaction moved the day (Today's button animates its change), so
    /// the week changes without a slide (design §5.10).
    private func openOnSelectedDay() {
        let days = week.map(\.day)
        guard let day = WeekScheduleRules.openingDay(selected: planner.selectedDay, days: days, across: across)
        else { return }
        var still = Transaction(animation: nil)
        still.disablesAnimations = true
        withTransaction(still) {
            columns.scrollTo(id: day, anchor: .leading)
        }
    }
}

/// The week's head, one height for every column (design §4.5): the heading,
/// the strip's rows (the week's tallest, `WeekScheduleRules.stripLines`) and
/// the "+N more" line when any day has one, and a little air under them.
private struct WeekHead: Equatable {
    let heading: CGFloat
    let row: CGFloat
    let more: CGFloat
    let rows: Int
    let hasMore: Bool
    /// The most rows a strip shows (`WeekScheduleRules.stripRows`).
    let limit: Int

    static let bottomPadding: CGFloat = 4

    var stripHeight: CGFloat {
        CGFloat(rows) * row + (hasMore ? more : 0)
    }

    /// How far down the column the hours start (`ScheduleDrag.hoursTop`).
    var height: CGFloat {
        heading + stripHeight + Self.bottomPadding
    }
}

/// Pinned to the top of the vertical scroll while the content scrolls under
/// it (design §4.5): drawn that much lower, never laid out lower, so the
/// hours keep their place, and over its siblings. Hit testing follows the
/// drawn place (device check W-S2).
private struct PinnedToTop: ViewModifier {
    func body(content: Content) -> some View {
        content
            .visualEffect { effect, proxy in
                effect.offset(y: max(0, -proxy.frame(in: .scrollView(axis: .vertical)).minY))
            }
            .zIndex(1)
    }
}

/// One day's column: its pinned head over its 24 hours. The hours are Day's
/// column in its compact form, opening blocks on this day, and a drop
/// destination of their own: every session update goes to `columnUpdate`
/// (y down the scroll's content, the hours from `head.height`; x across the
/// columns' content), and a drop lands at the ghost's time on this day
/// (`dropOnHour`). To VoiceOver the column is a group named for its day.
private struct WeekColumn: View {
    let schedule: DaySchedule
    /// Its place in the week, for x across the columns.
    let index: Int
    let head: WeekHead
    let columnWidth: Double
    let nowMin: Int
    let timeFormat: TimeFormat
    let openDay: (DayString) -> Void

    @Environment(SamplePlanner.self) private var planner
    /// Written from the drop callbacks only, never read to draw.
    @Environment(ScheduleDrag.self) private var drag

    var body: some View {
        let day = schedule.day
        let isToday = day == planner.today
        VStack(spacing: 0) {
            VStack(spacing: 0) {
                WeekColumnHeading(day: day, isToday: isToday) { openDay(day) }
                    .frame(height: head.heading)
                WeekStrip(schedule: schedule, head: head) { openDay(day) }
                    .frame(height: head.stripHeight, alignment: .top)
                Spacer(minLength: 0)
            }
            .frame(height: head.height, alignment: .top)
            .background(Color(.systemBackground))
            .overlay(alignment: .bottom) { Divider() }
            .modifier(PinnedToTop())
            ScheduleColumn(day: schedule, nowMin: isToday ? nowMin : nil, timeFormat: timeFormat, opensOn: .on(day),
                           compact: true)
                .contentShape(Rectangle())
                .dropDestination(for: ItemRef.self) { (refs: [ItemRef], session: DropSession) in
                    guard let ref = refs.first else { return }
                    drop(ref.id, at: Double(session.location.y) + Double(head.height))
                }
                .onDropSessionUpdated { session in
                    guard let phase = ColumnDropPhase(session.phase) else {
                        drag.noteDropUpdate()
                        return
                    }
                    drag.columnUpdate(day: day, phase: phase, y: Double(session.location.y) + Double(head.height),
                                      x: Double(index) * columnWidth + Double(session.location.x))
                }
        }
        // Room under midnight for the latest block's floored pane, inside
        // the columns' scroll view, which clips, and outside the drop target.
        .padding(.bottom, CGFloat(ScheduleMetrics.paneOffset + ScheduleMetrics.paneMinH))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(PlannerFormat.spokenHeading(day, isToday: isToday)))
    }

    /// `id` let go at `contentY` on this day's hours: where the ghost showed
    /// it (`ScheduleDrag.dropStart`), on this day, by the drop rule for a
    /// block or an Anytime row and the hour drop for a braindump row
    /// (`dropOnHour`). A habit or a series keeps its own day (B18). Nothing
    /// is selected after it (B3).
    private func drop(_ id: UUID, at contentY: Double) {
        let duration = planner.item(id)?.durationMin ?? drag.durationMin
        let start = drag.dropStart(contentY: contentY, durationMin: duration)
        withAnimation(.snappy) {
            planner.dropOnHour(id, said: drag.source(of: id), on: schedule.day, startMin: start)
        }
        drag.note("drop \(schedule.day) \(minutesToTime(start))")
    }
}

/// A column's heading: "Thu 1" (`PlannerFormat.columnHeading`), and on
/// today a 6pt lime dot after it; the words stay in ink. A tap opens the day
/// in Day (W7). To VoiceOver a heading and a button: "Thursday, October 1,
/// today", hint "Opens this day", as Week × List's.
private struct WeekColumnHeading: View {
    let day: DayString
    let isToday: Bool
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 5) {
                Text(PlannerFormat.columnHeading(day))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                if isToday {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 6, height: 6)
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, CGFloat(ScheduleMetrics.lanePx))
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        // A press fills behind the label and never fades it, so today's dot
        // keeps its full strength.
        .buttonStyle(RowPressStyle(verticalBleed: 0))
        .accessibilityLabel(Text(PlannerFormat.spokenHeading(day, isToday: isToday)))
        .accessibilityAddTraits(.isHeader)
        .accessibilityHint(Text(PlannerFormat.opensThisDay))
    }
}

/// A column's Anytime strip (design §4.5): the day's untimed rows, at most
/// three (one at the accessibility sizes), then "+N more", which opens the
/// day in Day; with none, the band's word, "Anytime", so the place to drop a
/// time-free item says what it is. The rows tick and open on the column's
/// day, and lift onto any hour as the band's do.
///
/// The whole strip is a drop destination: a block or an Anytime row lands
/// through the drop rule (`dropOnAnytime`), which keeps its day, so another
/// day's block is refused with the system's forbidden badge (B22); a
/// braindump row lands through the Date chip's write when its gate takes it.
private struct WeekStrip: View {
    let schedule: DaySchedule
    let head: WeekHead
    let onMore: () -> Void

    @Environment(SamplePlanner.self) private var planner
    /// Written from the drag and drop callbacks only, never read to draw.
    @Environment(ScheduleDrag.self) private var drag

    var body: some View {
        let day = schedule.day
        let rows = schedule.untimed
        let shown = Array(rows.prefix(WeekScheduleRules.shownRows(rows.count, limit: head.limit)))
        VStack(alignment: .leading, spacing: 0) {
            if rows.isEmpty {
                Text(WeekScheduleRules.emptyStrip)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .padding(.leading, CGFloat(ScheduleMetrics.lanePx))
                    .frame(maxWidth: .infinity, minHeight: head.row, maxHeight: head.row, alignment: .leading)
                    .accessibilityHidden(true)
            } else {
                VStack(spacing: 0) {
                    ForEach(shown) { item in
                        StripRow(item: item, done: planner.isDone(item, on: day),
                                 skipped: planner.isSkipped(item, on: day),
                                 streaksEnabled: planner.settings.streaksEnabled,
                                 onToggle: { toggle(item) },
                                 onOpen: { planner.open(item.id, day: .on(day)) })
                            .frame(height: head.row)
                            // The lifted copy is the row on the strip's paper.
                            .background(Color(.systemBackground))
                            .modifier(LiftsWhen(enabled: planner.canLiftRow(item, on: day), id: item.id))
                    }
                }
                .dragContainer(for: ItemRef.self) { ids in
                    ids.map { ItemRef(id: $0) }
                }
                .onDragSessionUpdated { session in
                    switch session.phase {
                    case .initial:
                        lift(session.draggedItemIDs(for: UUID.self).first)
                    case .active:
                        drag.noteMove()
                    case .ended(let operation):
                        drag.note("ended \(operation)")
                        drag.reset()
                    default:
                        break
                    }
                }
                if let more = WeekScheduleRules.moreLine(rows.count, limit: head.limit) {
                    Button(action: onMore) {
                        Text(more)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                            .padding(.leading, CGFloat(ScheduleMetrics.lanePx))
                            .frame(maxWidth: .infinity, minHeight: head.more, maxHeight: head.more,
                                   alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(RowPressStyle(verticalBleed: 0))
                    .accessibilityLabel(Text("\(WeekScheduleRules.overflow(rows.count, limit: head.limit)) more"))
                    .accessibilityHint(Text(PlannerFormat.opensThisDay))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .contentShape(Rectangle())
        .dropDestination(for: ItemRef.self) { (refs: [ItemRef], _: DropSession) in
            guard let ref = refs.first else { return }
            withAnimation(.snappy) {
                planner.dropOnAnytime(ref.id, said: drag.source(of: ref.id), on: day)
            }
            drag.note("drop anytime \(day)")
        }
        .dropConfiguration { _ in
            DropConfiguration(operation: planner.refusesAnytimeDrop(drag.itemID, source: drag.source, on: day)
                ? .forbidden : .move)
        }
    }

    /// A row lifted (the session's `.initial`): its own length for the
    /// ghost, held by its middle, and kept to its column when it moves in
    /// time only, as a band row is.
    private func lift(_ id: UUID?) {
        guard let id, let item = planner.item(id) else { return }
        drag.beginMove(itemID: id, durationMin: item.durationMin, source: .anytime(day: schedule.day), anchor: 0.5,
                       confinedTo: planner.confinedDay(id, from: schedule.day))
    }

    /// A row's tick on the column's day, ungated, as the band's.
    private func toggle(_ item: SampleItem) {
        withAnimation(.snappy) { planner.tickAnytimeRow(item, in: schedule) }
    }
}

/// One row of a strip: the tick circle, drawn 16pt and hit over the row's
/// height, and the title on one line; a tap on the title opens it. A
/// skipped occurrence shows the skip mark in the circle's place and no tick.
/// To VoiceOver it is the band row's one element: activation opens it, and
/// the tick is a named action.
private struct StripRow: View {
    let item: SampleItem
    let done: Bool
    let skipped: Bool
    let streaksEnabled: Bool
    let onToggle: () -> Void
    let onOpen: () -> Void

    /// The tick's width, at the default text size, scaled.
    @ScaledMetric(relativeTo: .footnote) private var tickWidth: CGFloat = 28

    var body: some View {
        if skipped {
            HStack(spacing: 2) {
                Image(systemName: "forward.end")
                    .font(.caption2.weight(.semibold))
                    .frame(width: tickWidth)
                title
            }
            .foregroundStyle(.secondary)
            .contentShape(Rectangle())
            .onTapGesture(perform: onOpen)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("\(item.title), skipped"))
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Opens details")
            .accessibilityAction { onOpen() }
        } else {
            HStack(spacing: 2) {
                Button(action: onToggle) {
                    TickCircle(done: done, habit: item.isHabit, diameter: 16)
                        .frame(width: tickWidth)
                        .frame(maxHeight: .infinity)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle())
                title
                    .foregroundStyle(done ? Color.secondary : Color.primary)
                    .contentShape(Rectangle())
                    .onTapGesture(perform: onOpen)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(PlannerFormat.rowLabel(item, isNow: false, streaksEnabled: streaksEnabled)))
            .accessibilityValue(Text(done ? "Done" : ""))
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Opens details")
            .accessibilityAction { onOpen() }
            .accessibilityAction(named: Text(done ? "Mark not done" : "Mark done"), onToggle)
            .accessibilityInputLabels([Text(item.title)])
        }
    }

    private var title: some View {
        Text(item.title)
            .font(.footnote)
            .strikethrough(done)
            .lineLimit(1)
            .padding(.trailing, 4)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}
