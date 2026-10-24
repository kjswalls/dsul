import DsulCore
import SwiftUI

/// Week × List (design §4.3, W2): the filter chips, then the selected day's
/// week as seven day sections in one list, the week starting on the user's
/// Week starts on. Each day keeps its Day list's own grouping, worked out for
/// that day alone as lib/grouping.ts `routineGroups` does (DsulCore's port;
/// the web's week list groups each day on its own too, though it is not
/// ported): routines (done/total), then projects (their dot), then the loose
/// rows, under compact captions that don't fold. A day with nothing on it
/// says "Nothing planned."
///
/// Every row reads, ticks and opens at its own day, never the selected one:
/// Thursday's circle ticks Thursday, and its sheet acts on Thursday
/// (`SheetDay.on`). "Now" shows on today's rows alone. A day's heading opens
/// that day in Day. The list opens on the selected day's section, and goes
/// back to it when the selected day moves (Go to date, Today); the chips stay
/// above it as a bar. Signed in, a pull refreshes it.
struct WeekList: View {
    var nowMin: Int
    /// A heading's tap: that day, in Day.
    var openDay: (DayString) -> Void

    @Environment(SamplePlanner.self) private var planner
    @State private var filter: ListFilter = .all

    var body: some View {
        let week = planner.weekRows(of: planner.selectedDay)
        let weekRows = week.flatMap(\.rows)
        ScrollViewReader { proxy in
            List {
                if !planner.hasLoaded {
                    Section {
                        PlannerLoadingRow()
                    }
                } else {
                    ForEach(week) { day in
                        daySection(day)
                    }
                }
            }
            .listStyle(.plain)
            // The chips are a bar over the list, not its first row: the list
            // opens on the selected day's heading, which would scroll a first
            // row out of sight every time Week opens (§4.3 keeps the chips).
            .safeAreaBar(edge: .top) {
                FilterChips(filter: $filter, rows: weekRows)
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
            .onChange(of: planner.chipProjects(in: weekRows)) { _, projects in
                // A project chip can vanish when the week changes; fall back
                // to All.
                if case .project(let name) = filter, !projects.contains(name) {
                    filter = .all
                }
            }
        }
    }

    /// One day: its heading (the scroll target), then its groups and rows, or
    /// the line that says why there are none.
    @ViewBuilder
    private func daySection(_ week: WeekDayRows) -> some View {
        let day = week.day
        let sections = planner.listSections(filter, rows: week.rows, on: day)
        Section {
            WeekDayHeader(day: day, isToday: day == planner.today) {
                openDay(day)
            }
            .id(day)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 2, trailing: 16))

            if sections.isEmpty {
                // Nothing on the day at all, or only what the chip hides.
                Text(week.rows.isEmpty ? PlannerFormat.nothingPlanned : PlannerFormat.nothingMatches)
                    .font(.subheadline)
                    .italic(week.rows.isEmpty)
                    .foregroundStyle(Color.secondary)
                    .listRowSeparator(.hidden)
            }
            ForEach(sections) { section in
                WeekGroupLabel(section: section, color: color(for: section))
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 0, trailing: 16))
                ForEach(section.items) { item in
                    row(item, on: day)
                }
            }
        }
    }

    private func row(_ item: SampleItem, on day: DayString) -> some View {
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

    private func color(for section: ListSection) -> Color? {
        guard section.kind == .project else { return nil }
        return ProjectPalette.color(for: section.title, in: planner.projects)
    }
}

/// A group's caption inside a week day: "MORNING ROUTINE 1/3", "• WORK",
/// "NO PROJECT". Compact and never folding, where Day's section headers fold:
/// seven days of headers that fold would be fourteen taps to tidy. One header
/// element to VoiceOver, worded as Day's header is ("Morning routine, 1/3").
struct WeekGroupLabel: View {
    var section: ListSection
    var color: Color?

    private var countText: String? {
        section.kind == .routine ? "\(section.doneCount)/\(section.items.count)" : nil
    }

    var body: some View {
        HStack(spacing: 6) {
            if let color {
                Circle().fill(color).frame(width: 6, height: 6)
            }
            Text(section.title)
                .textCase(.uppercase)
            if let countText {
                Text(countText)
                    .monospacedDigit()
            }
            Spacer(minLength: 0)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Color.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(countText.map { "\(section.title), \($0)" } ?? section.title))
        .accessibilityAddTraits(.isHeader)
    }
}
