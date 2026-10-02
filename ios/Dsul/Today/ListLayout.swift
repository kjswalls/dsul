import DsulCore
import SwiftUI

/// The List layout (G board): filter chips, then one section per routine
/// (done/total) and per project (coloured dot, count), each collapsible.
/// A row's circle ticks it on the selected day; the rest of the row opens its
/// sheet, acting on that day. Signed in, a pull refreshes it.
struct ListLayout: View {
    @Environment(SamplePlanner.self) private var planner
    @State private var filter: ListFilter = .all
    @State private var collapsed: Set<String> = []
    var nowMin: Int

    var body: some View {
        let sections = planner.listSections(filter)
        List {
            Section {
                FilterChips(filter: $filter)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if sections.isEmpty {
                Section {
                    if !planner.hasLoaded {
                        PlannerLoadingRow()
                    } else if filter != .all && planner.count(.all) > 0 {
                        // The day has items; only the chip hides them.
                        Text("Nothing matches this filter")
                            .foregroundStyle(.secondary)
                        Button("Show all") {
                            withAnimation(.snappy) { filter = .all }
                        }
                    } else {
                        Text("Nothing on this day")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            ForEach(sections) { section in
                Section {
                    if !collapsed.contains(section.id) {
                        ForEach(section.items) { item in
                            ItemRow(item: item, done: planner.isDone(item), skipped: planner.isSkipped(item),
                                    isNow: planner.isOnToday && PlannerFormat.isNow(startMin: item.startMin,
                                                                                   durationMin: item.durationMin,
                                                                                   nowMin: nowMin),
                                    onToggle: { toggle(item.id) },
                                    onOpen: { planner.open(item.id, day: .selected) })
                        }
                    }
                } header: {
                    SectionHeader(section: section, collapsed: collapsed.contains(section.id),
                                  color: color(for: section)) {
                        withAnimation(.snappy) {
                            if collapsed.contains(section.id) {
                                collapsed.remove(section.id)
                            } else {
                                collapsed.insert(section.id)
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .modifier(LiveRefresh(planner: planner))
        .onChange(of: planner.dayProjects) { _, projects in
            // A project chip can vanish when the day changes; fall back to All.
            if case .project(let name) = filter, !projects.contains(name) {
                filter = .all
            }
        }
    }

    private func toggle(_ id: UUID) {
        withAnimation(.snappy) { planner.toggle(id) }
    }

    private func color(for section: ListSection) -> Color? {
        guard section.kind == .project else { return nil }
        return ProjectPalette.color(for: section.title, in: planner.projects)
    }
}

private struct SectionHeader: View {
    var section: ListSection
    var collapsed: Bool
    var color: Color?
    var onToggle: () -> Void

    private var countText: String {
        section.kind == .routine ? "\(section.doneCount)/\(section.items.count)" : "\(section.items.count)"
    }

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 8) {
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .rotationEffect(.degrees(collapsed ? -90 : 0))
                    .foregroundStyle(.secondary)
                if let color {
                    Circle().fill(color).frame(width: 8, height: 8)
                }
                Text(section.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(countText)
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("\(section.title), \(countText)"))
        .accessibilityValue(Text(collapsed ? "Collapsed" : "Expanded"))
    }
}

/// All, Tasks, Habits, then one chip per project on the day.
struct FilterChips: View {
    @Binding var filter: ListFilter
    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                chip("All", .all, color: nil)
                chip("Tasks", .tasks, color: nil)
                chip("Habits", .habits, color: nil)
                ForEach(planner.dayProjects, id: \.self) { project in
                    chip(project, .project(project),
                         color: ProjectPalette.color(for: project, in: planner.projects), showCount: false)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .scrollIndicators(.hidden)
    }

    private func chip(_ title: String, _ value: ListFilter, color: Color?, showCount: Bool = true) -> some View {
        let selected = filter == value
        return Button {
            withAnimation(.snappy) { filter = value }
        } label: {
            HStack(spacing: 6) {
                if let color {
                    Circle().fill(color).frame(width: 7, height: 7)
                }
                Text(title)
                if showCount {
                    Text("\(planner.count(value))")
                        .monospacedDigit()
                }
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .foregroundStyle(selected ? Color(.systemBackground) : Color.primary)
            .background(Capsule().fill(selected ? Color.primary : Color(.secondarySystemFill)))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Pull to refresh, signed in only: the sample has nothing to fetch. Not on
/// the Schedule grid, whose scroll geometry the drag spike reads.
struct LiveRefresh: ViewModifier {
    var planner: SamplePlanner

    @ViewBuilder
    func body(content: Content) -> some View {
        let live = self.planner
        if live.isLive {
            content.refreshable {
                await live.refresh()
            }
        } else {
            content
        }
    }
}

/// A signed-in day before its first fetch lands: a spinner, or why the fetch
/// failed and a way to try again.
struct PlannerLoadingRow: View {
    @Environment(SamplePlanner.self) private var planner

    var body: some View {
        if let error = planner.loadError {
            VStack(alignment: .leading, spacing: 8) {
                Text(error)
                    .foregroundStyle(.secondary)
                Button("Try again") {
                    let live = self.planner
                    Task { await live.refresh() }
                }
            }
        } else {
            HStack(spacing: 10) {
                ProgressView()
                Text("Loading your day\u{2026}")
                    .foregroundStyle(.secondary)
            }
        }
    }
}
