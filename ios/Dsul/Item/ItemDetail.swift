import DsulCore
import SwiftUI

/// One page of the item sheet: the item the sheet opened on, or a subtask
/// pushed from its Subtasks list. Read-only in part 1. From the top:
/// - the eyebrow, the type and the first routine holding it ("HABIT · MORNING
///   ROUTINE");
/// - the title, with the tick circle when the tick is offered;
/// - the notes, four lines with Show all when they run longer;
/// - the item's own pause ("Paused until Oct 8");
/// - the chips, in the web panel's order (ItemSheetModel.chips), with the
///   streak chip first for a type that keeps a streak;
/// - the subtasks, each ticked in place, its title opening its own page.
///
/// The verbs sit in a bar under the scroll (`VerbBar`), the rest of the
/// pause family (and a series' Reschedule) behind ⋯ in the toolbar. Which verbs, and in which slots, is
/// ItemSheetModel's, asked of what the planner offers (`offeredVerbs`), so the
/// sheet never shows a verb the web's gates or the server refuse. Each one
/// acts on the day the sheet was opened with, read when it is tapped
/// (`SamplePlanner.actingDay`), and the planner asks its gate again before it
/// writes.
struct ItemDetail: View {
    let id: UUID
    let day: SheetDay
    /// The sheet's first page, which carries Close. A pushed subtask's page
    /// has the stack's back button instead.
    let isRoot: Bool
    @Binding var path: [UUID]
    @Binding var dayPick: DayPick?

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss
    /// The title's tick circle, drawn as a row's (22pt) at the default size
    /// and growing with the title's text.
    @ScaledMetric(relativeTo: .title2) private var circle: CGFloat = 22

    var body: some View {
        if let item = planner.item(id) {
            page(item)
        } else {
            // The item is gone (a fetch without it): the planner clears the
            // sheet slot, and this frame, before that lands, draws nothing.
            Color.clear
        }
    }

    private func page(_ item: SampleItem) -> some View {
        let ctx = planner.verbContext(for: item, day: day)
        let offered = planner.offeredVerbs(for: item, day: day)
        let verbs = ItemSheetModel.verbs(item, ctx, offered: offered)
        let caption = ItemSheetModel.dayCaption(item, ctx, offered: offered)
        let showsBar = verbs.notDue || !verbs.bar.isEmpty
        return ScrollView {
            content(item, ctx, offered: offered)
        }
        // Below the navigation bar, so it never covers Close: a write the
        // server refused says so over the sheet the verb was tapped in.
        .overlay(alignment: .top) {
            if let banner = planner.banner {
                BannerView(banner: banner) {
                    planner.dismissBanner(banner.id)
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .transition(.move(edge: .top))
            }
        }
        .animation(.snappy, value: planner.banner)
        .safeAreaBar(edge: .bottom) {
            if showsBar {
                VerbBar(item: item, ctx: ctx, verbs: verbs, caption: caption,
                        onRun: { verb in run(verb) },
                        onReschedule: { choice in reschedule(choice) })
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isRoot {
                ToolbarItem(placement: .topBarLeading) {
                    Button(role: .close) { dismiss() }
                        .tint(Color.primary)
                }
            }
            if !verbs.menu.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        ForEach(verbs.menu, id: \.self) { verb in
                            menuEntry(verb, item, ctx)
                        }
                    } label: {
                        Label("More", systemImage: "ellipsis")
                    }
                    .menuOrder(.fixed)
                    .tint(Color.primary)
                }
            }
        }
    }

    /// One ⋯ entry. Reschedule opens the bar's three choices as a submenu;
    /// every other verb runs when tapped.
    @ViewBuilder
    private func menuEntry(_ verb: SheetVerb, _ item: SampleItem, _ ctx: VerbContext) -> some View {
        if verb == .reschedule {
            Menu(ItemSheetModel.menuTitle(verb), systemImage: ItemSheetModel.symbol(verb, item, ctx)) {
                Button("Today", systemImage: "sun.max") { reschedule(.today) }
                Button("Next week", systemImage: "calendar.badge.plus") { reschedule(.nextWeek) }
                Button("Pick a date\u{2026}", systemImage: "calendar") { reschedule(.pick) }
            }
        } else {
            Button(ItemSheetModel.menuTitle(verb), systemImage: ItemSheetModel.symbol(verb, item, ctx)) {
                run(verb)
            }
        }
    }

    // MARK: Content

    private func content(_ item: SampleItem, _ ctx: VerbContext, offered: [VerbID]) -> some View {
        let typeCaps = caps(item.typeName)
        let routines = planner.routineNames(for: item.id)
        let notes = (item.notes ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let pauseNote = ItemSheetModel.pauseNote(item, today: planner.today.description,
                                                 timeZone: planner.timeZoneID)
        return VStack(alignment: .leading, spacing: 14) {
            Text(ItemSheetModel.eyebrow(item, routineNames: routines))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)

            titleRow(item, ctx, offered: offered)

            if !notes.isEmpty {
                NotesText(text: notes)
            }

            if let pauseNote {
                Label(pauseNote, systemImage: "pause.circle")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            chipRow(item, caps: typeCaps, routines: routines)

            if typeCaps.subtasks {
                subtaskSection(item)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
    }

    /// The tick circle and the title, the circle centred on the title's first
    /// line. The circle draws at the row's size and is hit over at least 44pt
    /// square, the overhang reaching into the margin and the gap before the
    /// title, never over it, so its left edge lines up with the eyebrow's.
    private func titleRow(_ item: SampleItem, _ ctx: VerbContext, offered: [VerbID]) -> some View {
        let hit = max(44, circle + 22)
        let inset = (hit - circle) / 2
        // Where a first line's middle sits above its baseline, near enough.
        let lift = circle * 0.35
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            if offered.contains(.tick) {
                Button {
                    run(.tick)
                } label: {
                    TickCircle(done: isDoneOn(item, on: ctx.dateStr), habit: item.isHabit, diameter: circle)
                        .frame(width: hit, height: hit)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle())
                .alignmentGuide(.firstTextBaseline) { d in d[VerticalAlignment.center] + lift }
                .padding(.horizontal, -inset)
                .accessibilityLabel(Text(ItemSheetModel.spokenLabel(.tick, item, ctx)))
            }
            Text(item.title)
                .font(.title2.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
        }
    }

    /// The streak chip (a type that keeps a streak) and the property chips.
    @ViewBuilder
    private func chipRow(_ item: SampleItem, caps typeCaps: ItemCaps, routines: [String]) -> some View {
        let chips = ItemSheetModel.chips(item, today: planner.today, timeFormat: planner.settings.timeFormat,
                                         routineNames: routines, seasonNames: planner.seasonNames(for: item.id))
        if typeCaps.streakCounter || !chips.isEmpty {
            let flow = ChipFlow()
            flow {
                if typeCaps.streakCounter {
                    streakChip(item)
                }
                ForEach(chips) { chip in
                    ChipView(chip: chip,
                             dot: chip.kind == .project ? ProjectPalette.color(for: chip.text, in: planner.projects) : nil)
                }
            }
        }
    }

    /// The stored streak, lit once wall-clock today is ticked, and this
    /// week's dots.
    private func streakChip(_ item: SampleItem) -> some View {
        let streak = item.streak ?? 0
        let dots = ItemSheetModel.weekDots(item, today: planner.today, weekStartDay: planner.settings.weekStartDay)
        return StreakChip(streak: streak, dots: dots, lit: isDoneOn(item, on: planner.today.description),
                          spoken: ItemSheetModel.streakSpoken(streak: streak, dots: dots))
    }

    // MARK: Subtasks

    /// "SUBTASKS  1 of 2" and the live children, in stored order: the web's
    /// SubtasksSection (item-detail-sections.tsx), which lists the items
    /// whose parent this is, habits aside. Hidden with none, since part 1
    /// can't add one.
    @ViewBuilder
    private func subtaskSection(_ item: SampleItem) -> some View {
        let children = planner.subtasks(of: item.id).filter { !$0.isHabit }
        if !children.isEmpty {
            let acting = planner.actingDay(day)
            let doneCount = children.filter { isDoneOn($0, on: acting.description) }.count
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Subtasks")
                        .textCase(.uppercase)
                    Spacer(minLength: 8)
                    Text("\(doneCount) of \(children.count)")
                        .monospacedDigit()
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                .padding(.bottom, 2)

                ForEach(children) { child in
                    subtaskRow(child, acting: acting)
                }
            }
            .padding(.top, 4)
        }
    }

    /// A subtask: its circle ticks it (the web's subtask toggle, a one-off's
    /// complete, so the day doesn't matter), its title opens its page. To
    /// VoiceOver, one element, as a row on Today is.
    private func subtaskRow(_ child: SampleItem, acting: DayString) -> some View {
        let childCtx = planner.verbContext(for: child, on: acting)
        let done = isDoneOn(child, on: childCtx.dateStr)
        let canTick = planner.offers(.tick, child, childCtx)
        let childID = child.id
        return HStack(spacing: 12) {
            if canTick {
                Button {
                    tickSubtask(childID)
                } label: {
                    TickCircle(done: done, habit: false)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle())
                .padding(.horizontal, -11)
            } else {
                TickCircle(done: done, habit: false)
            }

            Button {
                path.append(childID)
            } label: {
                HStack(spacing: 8) {
                    Text(child.title)
                        .strikethrough(done)
                        .foregroundStyle(done ? Color.secondary : Color.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle())
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(child.title))
        .accessibilityValue(Text(done ? "Done" : ""))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Opens details")
        .accessibilityAction { path.append(childID) }
        .accessibilityActions {
            if canTick {
                Button(done ? "Mark not done" : "Mark done") {
                    tickSubtask(childID)
                }
            }
        }
    }

    private func tickSubtask(_ childID: UUID) {
        let acting = planner.actingDay(day)
        withAnimation(.snappy) {
            planner.toggle(childID, on: acting)
        }
    }

    // MARK: Verbs

    /// Runs `verb` on the day the sheet acts on, read now, not when the sheet
    /// was drawn. Pause until (and Reschedule, which the bar shows as a menu)
    /// first asks for a day, in the sheet's own day picker.
    private func run(_ verb: SheetVerb) {
        let acting = planner.actingDay(day)
        switch verb {
        case .tick:
            withAnimation(.snappy) { planner.toggle(id, on: acting) }
        case .skip:
            withAnimation(.snappy) { planner.skip(id, on: acting) }
        case .unskip:
            withAnimation(.snappy) { planner.unskip(id, on: acting) }
        case .pause:
            withAnimation(.snappy) { planner.pause(id, until: nil) }
        case .pauseUntil:
            dayPick = .pauseUntil(id)
        case .resume:
            withAnimation(.snappy) { planner.resume(id) }
        case .nextDay:
            // Where the carry lands, worked out again off the item as it is
            // now (lib/item-verbs.ts `nextDayOf`).
            guard let item = planner.item(id) else { return }
            let target = nextDayOf(item, planner.verbContext(for: item, day: day))
            withAnimation(.snappy) { planner.move(id, to: target) }
        case .reschedule:
            dayPick = .reschedule(id)
        }
    }

    /// Reschedule's menu: wall-clock today, the first day of next week (by
    /// the user's Week starts on), or a day picked in the sheet's picker.
    private func reschedule(_ choice: RescheduleChoice) {
        switch choice {
        case .today:
            let target = planner.today.description
            withAnimation(.snappy) { planner.move(id, to: target) }
        case .nextWeek:
            let target = planner.nextWeekStart.description
            withAnimation(.snappy) { planner.move(id, to: target) }
        case .pick:
            dayPick = .reschedule(id)
        }
    }
}

/// The notes, four lines at most until Show all. The button is there only
/// when the text runs longer, which two hidden copies measure: one held to
/// four lines, one not. VoiceOver reads the whole text either way, so the
/// button is hidden from it.
private struct NotesText: View {
    let text: String

    @State private var expanded = false
    @State private var clippedHeight: CGFloat = 0
    @State private var fullHeight: CGFloat = 0

    private var truncates: Bool { fullHeight > clippedHeight + 0.5 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(.body)
                .foregroundStyle(.secondary)
                .lineLimit(expanded ? nil : 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(alignment: .topLeading) {
                    ZStack(alignment: .topLeading) {
                        Text(text)
                            .font(.body)
                            .lineLimit(4)
                            .fixedSize(horizontal: false, vertical: true)
                            .onGeometryChange(for: CGFloat.self) { proxy in
                                proxy.size.height
                            } action: { height in
                                clippedHeight = height
                            }
                        Text(text)
                            .font(.body)
                            .fixedSize(horizontal: false, vertical: true)
                            .onGeometryChange(for: CGFloat.self) { proxy in
                                proxy.size.height
                            } action: { height in
                                fullHeight = height
                            }
                    }
                    .hidden()
                    .accessibilityHidden(true)
                }

            if truncates {
                Button(expanded ? "Show less" : "Show all") {
                    withAnimation(.snappy) { expanded.toggle() }
                }
                .font(.subheadline.weight(.semibold))
                .tint(Color.primary)
                .accessibilityHidden(true)
            }
        }
    }
}
