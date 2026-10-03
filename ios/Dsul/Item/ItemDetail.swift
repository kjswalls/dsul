import Accessibility
import DsulCore
import SwiftUI

/// One page of the item sheet: the item the sheet opened on, or a subtask
/// pushed from its Subtasks list. From the top:
/// - the eyebrow, the type (a custom type's own label) and the first routine
///   holding it ("HABIT · MORNING ROUTINE");
/// - the title, with the tick circle when the tick is offered, and under it
///   a counted habit's tally ("1/3") and the day the circle ticks when it
///   isn't today;
/// - the notes, four lines with Show all when they run longer, or "Notes"
///   where there are none and they may be added;
/// - the item's own pause ("Paused until Oct 8");
/// - the chips, in the web panel's order (ItemSheetModel.chips), with the
///   streak chip first for a type that keeps a streak;
/// - the subtasks, each ticked in place, its title opening its own page, and
///   Delete in its context menu.
///
/// The verbs sit in a bar under the scroll (`VerbBar`), the rest of the
/// pause family (and a series' Reschedule) behind ⋯ in the toolbar, then
/// Delete, last. Which verbs, and in which slots, is ItemSheetModel's, asked
/// of what the planner offers (`offeredVerbs`), so the sheet never shows a
/// verb the web's gates or the server refuse. Each one acts on the day the
/// sheet was opened with, read when it is tapped (`SamplePlanner.actingDay`),
/// and the planner asks its gate again before it writes.
///
/// **Typed fields** (part 2). The title (`TitleField`) and the notes
/// (`NotesEditor`) edit in place where the server takes the write. Each has a
/// draft (what it shows, in this page's state, never bound to the planner's
/// items, which a fetch replaces wholesale) and a seed (what it showed when
/// editing began). What leaving a field sends is ItemSheetModel's `commit`:
/// nothing while the draft is still the seed. A field commits when its
/// focus goes (Return on the title, the nav bar's Done, a drag down the
/// scroll, another field), when the page goes (`.onDisappear`: a swipe down,
/// Close, a pushed page popping) and when the scene goes inactive, keeping
/// focus there so typing can go on. While a field has focus, the sheet goes
/// to its large detent, the bar hides, and Done takes ⋯'s place.
///
/// **Delete** always confirms (the phone has no undo), on this page, in
/// ItemSheetModel's words. While the page leaves, the sheet sliding down or
/// a pushed page popping, it keeps drawing its last content
/// (`lastShown`), never a blank, and VoiceOver hears what went.
struct ItemDetail: View {
    let id: UUID
    let day: SheetDay
    /// The sheet's first page, which carries Close. A pushed subtask's page
    /// has the stack's back button instead.
    let isRoot: Bool
    @Binding var path: [UUID]
    @Binding var dayPick: DayPick?
    /// The sheet's detent (`ItemSheetStack`'s), raised to large when a field
    /// takes focus, so the keyboard never leaves the field a sliver.
    @Binding var detent: PresentationDetent

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    /// The title's tick circle, drawn as a row's (22pt) at the default size
    /// and growing with the title's text.
    @ScaledMetric(relativeTo: .title2) private var circle: CGFloat = 22

    @FocusState private var focus: SheetField?
    @State private var titleDraft = ""
    @State private var titleSeed = ""
    @State private var notesDraft = ""
    @State private var notesSeed = ""
    /// The notes field is up in place of the text.
    @State private var editingNotes = false
    /// The item as last drawn, and its subtasks: what the page shows while it
    /// leaves once its item is gone.
    @State private var lastShown: SampleItem? = nil
    @State private var lastChildren: [SampleItem] = []
    /// The confirm last asked, kept once it closes (its title is read from
    /// it), and whether it is up.
    @State private var confirm: SheetConfirm? = nil
    @State private var confirming = false

    var body: some View {
        let live = planner.item(id)
        let liveChildren = planner.subtasks(of: id).filter { !$0.isHabit }
        let confirmTitle = confirm?.title ?? ""
        Group {
            if let item = live ?? lastShown {
                page(item, children: live == nil ? lastChildren : liveChildren, leaving: live == nil)
            } else {
                Color.clear
            }
        }
        // The item is gone (deleted here, or a fetch without it): the planner
        // clears the sheet slot, and the page keeps drawing what it last
        // showed while the sheet slides away. The slot knows only the first
        // page, so a pushed subtask's page takes itself, and any other gone
        // page, off the stack.
        .onChange(of: live, initial: true) { _, now in
            if let now {
                lastShown = now
            } else if !isRoot {
                path.removeAll { planner.item($0) == nil }
            }
        }
        .onChange(of: liveChildren, initial: true) { _, now in
            // A delete takes the subtasks with the item: keep the last ones
            // drawn while it was there.
            if planner.item(id) != nil { lastChildren = now }
        }
        // The title field shows what is stored whenever it doesn't have
        // focus, so a fetch or a revert shows through; while it has focus,
        // what is typed stays.
        .onChange(of: live?.title, initial: true) { _, title in
            guard let title, focus != .title else { return }
            titleDraft = title
            titleSeed = title
        }
        .onChange(of: focus) { old, new in
            focusMoved(from: old, to: new)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .inactive || phase == .background { commitFields(leaving: false) }
        }
        .onDisappear {
            commitFields(leaving: true)
        }
        .confirmationDialog(confirmTitle, isPresented: $confirming, titleVisibility: .visible,
                            presenting: confirm) { pending in
            Button("Delete", role: .destructive) { confirmed(pending) }
            Button("Cancel", role: .cancel) {}
        } message: { pending in
            Text(pending.message)
        }
    }

    /// The page for `item`. `leaving`: its item is gone and this is its last
    /// content, drawn while the page goes, so nothing in it takes a tap and
    /// the bar is down.
    private func page(_ item: SampleItem, children: [SampleItem], leaving: Bool) -> some View {
        let ctx = planner.verbContext(for: item, day: day)
        let offered = planner.offeredVerbs(for: item, day: day)
        let verbs = ItemSheetModel.verbs(item, ctx, offered: offered)
        let caption = ItemSheetModel.dayCaption(item, ctx, bar: verbs.bar)
        let typeCaps = planner.caps(for: item)
        let showsBar = (verbs.notDue || !verbs.bar.isEmpty) && focus == nil && !leaving
        return ScrollViewReader { proxy in
            ScrollView {
                content(item, ctx, typeCaps: typeCaps, offered: offered, bar: verbs.bar, children: children)
                    .allowsHitTesting(!leaving)
            }
            // A drag down the content takes the keyboard with the finger,
            // which ends the edit and sends it.
            .scrollDismissesKeyboard(.interactively)
            // The field that takes focus stays in view: the notes by their
            // end, where the caret is.
            .onChange(of: focus) { _, field in
                guard let field else { return }
                let anchor: UnitPoint? = field == .notes ? UnitPoint.bottom : nil
                withAnimation(.snappy) { proxy.scrollTo(field, anchor: anchor) }
            }
            // Below the navigation bar, so it never covers Close: a write the
            // server refused says so over the sheet the verb was tapped in.
            .overlay(alignment: .top) {
                if let banner = planner.banner {
                    // As tall as the sheet, so the move (which travels the view's
                    // own height) carries the banner past the top, never parking
                    // it under the bar. The spacer draws nothing and takes no taps.
                    VStack(spacing: 0) {
                        BannerView(banner: banner) {
                            planner.dismissBanner(banner.id)
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 4)
                        Spacer(minLength: 0)
                    }
                    // A move alone: an opacity transition would fade the lime
                    // check through the banner's own opacity.
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
                toolbarItems(item, ctx, verbs: verbs, typeCaps: typeCaps)
            }
        }
    }

    /// Close on the first page; ⋯ on the right, or, while a field has focus,
    /// Done, which ends the edit and so sends it. A nav-bar button rather
    /// than a keyboard toolbar, which SwiftUI repeats across a stack's pages.
    @ToolbarContentBuilder
    private func toolbarItems(_ item: SampleItem, _ ctx: VerbContext, verbs: SheetVerbs,
                              typeCaps: ItemCaps) -> some ToolbarContent {
        if isRoot {
            ToolbarItem(placement: .topBarLeading) {
                Button(role: .close) { dismiss() }
                    .tint(Color.primary)
            }
        }
        if focus != nil {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done", systemImage: "checkmark") { focus = nil }
                    .tint(Color.primary)
            }
        }
        if focus == nil && !verbs.menu.isEmpty {
            ToolbarItem(placement: .topBarTrailing) {
                moreMenu(item, ctx, verbs: verbs, typeCaps: typeCaps)
            }
        }
    }

    /// ⋯: the verbs the bar doesn't hold, then, after a divider, Delete.
    private func moreMenu(_ item: SampleItem, _ ctx: VerbContext, verbs: SheetVerbs,
                          typeCaps: ItemCaps) -> some View {
        Menu {
            ForEach(verbs.menu, id: \.self) { verb in
                if verb == .delete, verbs.menu.first != SheetVerb.delete {
                    Divider()
                }
                menuEntry(verb, item, ctx, typeCaps: typeCaps)
            }
        } label: {
            Label("More", systemImage: "ellipsis")
        }
        .menuOrder(.fixed)
        .tint(Color.primary)
    }

    /// One ⋯ entry. Reschedule opens the bar's three choices as a submenu;
    /// Delete is named after the type ("Delete task") and drawn in the system
    /// red; every other verb runs when tapped.
    @ViewBuilder
    private func menuEntry(_ verb: SheetVerb, _ item: SampleItem, _ ctx: VerbContext,
                           typeCaps: ItemCaps) -> some View {
        if verb == .reschedule {
            Menu(ItemSheetModel.menuTitle(verb), systemImage: ItemSheetModel.symbol(verb, item, ctx)) {
                Button("Today", systemImage: "sun.max") { reschedule(.today) }
                Button("Next week", systemImage: "calendar.badge.plus") { reschedule(.nextWeek) }
                Button("Pick a date\u{2026}", systemImage: "calendar") { reschedule(.pick) }
            }
        } else if verb == .delete {
            Button(ItemSheetModel.deleteMenuTitle(typeLabel: typeCaps.label),
                   systemImage: ItemSheetModel.symbol(verb, item, ctx), role: .destructive) {
                run(verb)
            }
        } else {
            Button(ItemSheetModel.menuTitle(verb), systemImage: ItemSheetModel.symbol(verb, item, ctx)) {
                run(verb)
            }
        }
    }

    // MARK: Content

    private func content(_ item: SampleItem, _ ctx: VerbContext, typeCaps: ItemCaps, offered: [VerbID],
                         bar: [SheetVerb], children: [SampleItem]) -> some View {
        let routines = planner.routineNames(for: item.id)
        let pauseNote = ItemSheetModel.pauseNote(item, today: planner.today.description,
                                                 timeZone: planner.timeZoneID)
        return VStack(alignment: .leading, spacing: 14) {
            Text(ItemSheetModel.eyebrow(typeLabel: typeCaps.label, routineNames: routines))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)

            titleRow(item, ctx, typeCaps: typeCaps, offered: offered, bar: bar)

            NotesEditor(stored: item.notes, editable: typeCaps.hasNotes && planner.canWrite("notes"),
                        editing: editingNotes, draft: $notesDraft, focus: $focus,
                        onEdit: { startEditingNotes() })
                .id(SheetField.notes)

            if let pauseNote {
                Label(pauseNote, systemImage: "pause.circle")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            chipRow(item, caps: typeCaps, routines: routines)

            if typeCaps.subtasks {
                subtaskSection(item, children: children)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
    }

    /// The tick circle and the title, the circle centred on the title's first
    /// line. The circle draws at the row's size and is hit over at least 44pt
    /// square, the overhang reaching into the margin and the gap before the
    /// title, never over it, so its left edge lines up with the eyebrow's.
    /// The title is a field when the server takes `title` (`TitleField`),
    /// else text, as it is when stored longer than one request may carry,
    /// which a line under it says. Under it, a counted habit's tally ("1/3",
    /// which the circle's label already speaks) and the day the circle ticks
    /// when that isn't today and the bar doesn't hold the tick
    /// (`ItemSheetModel.titleNote`).
    private func titleRow(_ item: SampleItem, _ ctx: VerbContext, typeCaps: ItemCaps, offered: [VerbID],
                          bar: [SheetVerb]) -> some View {
        let hit = max(44, circle + 22)
        let inset = (hit - circle) / 2
        // Where a first line's middle sits above its baseline, near enough.
        let lift = circle * 0.35
        let tally = offered.contains(.tick) ? ItemSheetModel.tally(item, on: ctx.dateStr) : nil
        let dayNote = ItemSheetModel.titleDayNote(item, ctx, offered: offered, bar: bar)
        let note = ItemSheetModel.titleNote(tally: tally, dayNote: dayNote)
        let takesTitle = planner.canWrite("title")
        let editable = takesTitle && !ItemSheetModel.tooLongToEdit(item.title, kind: .title)
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
            VStack(alignment: .leading, spacing: 2) {
                if editable {
                    TitleField(draft: $titleDraft, stored: item.title, placeholder: typeCaps.titlePlaceholder,
                               focus: $focus)
                        .id(SheetField.title)
                } else {
                    Text(item.title)
                        .font(.title2.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                    if takesTitle {
                        Text(ItemSheetModel.tooLongNote)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                if let note {
                    // Spoken as the day alone: the circle says the tally.
                    Text(note)
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(Text(dayNote ?? ""))
                        .accessibilityHidden(dayNote == nil)
                }
            }
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
    /// whose parent this is, habits aside. Hidden with none, since adding one
    /// waits for 2b.
    @ViewBuilder
    private func subtaskSection(_ item: SampleItem, children: [SampleItem]) -> some View {
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
    /// complete, so the day doesn't matter), its title opens its page, and a
    /// long press offers Delete, confirmed as ⋯'s is (the web's ✕ deletes in
    /// one click, with an undo the phone doesn't have). No swipe actions,
    /// which a `ScrollView` doesn't take. To VoiceOver, one element, as a row
    /// on Today is, whose actions are the tick and Delete.
    private func subtaskRow(_ child: SampleItem, acting: DayString) -> some View {
        let childCtx = planner.verbContext(for: child, on: acting)
        let done = isDoneOn(child, on: childCtx.dateStr)
        let canTick = planner.offers(.tick, child, childCtx)
        let canDelete = planner.offers(.delete, child, childCtx)
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
                // As tall as the row, so a tap above or below one line of
                // title still opens it. Not an overhang, as Today's rows
                // have: these rows are siblings in a stack, not List cells,
                // so an overhang would take taps from the row above.
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            // The label is the row's height, so the fill bleeds no further.
            .buttonStyle(RowPressStyle(verticalBleed: 0))
        }
        .frame(minHeight: 44)
        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 10, style: .continuous))
        .contextMenu {
            if canDelete {
                Button("Delete", systemImage: "trash", role: .destructive) {
                    askDelete(childID)
                }
            }
        }
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
            if canDelete {
                Button("Delete") {
                    askDelete(childID)
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

    // MARK: Typed fields

    /// The title's seed is what the field showed when focus arrived; any
    /// field taking focus raises the sheet to large; a field losing it sends.
    private func focusMoved(from old: SheetField?, to new: SheetField?) {
        if old == .title && new != .title { commitTitle(leaving: true) }
        if old == .notes && new != .notes { commitNotes(leaving: true) }
        if new == .title && old != .title { titleSeed = titleDraft }
        if new != nil { detent = .large }
    }

    /// A tap on the notes, or on "Notes": the draft and the seed are what is
    /// stored, verbatim, and the field swaps in, focusing itself.
    private func startEditingNotes() {
        guard let item = planner.item(id) else { return }
        notesDraft = item.notes ?? ""
        notesSeed = notesDraft
        editingNotes = true
    }

    /// Both fields, on the page going (`leaving`) or the scene going inactive
    /// (not leaving: focus, and what is typed, stay).
    private func commitFields(leaving: Bool) {
        commitTitle(leaving: leaving)
        commitNotes(leaving: leaving)
    }

    /// Sends the title if it changed (`ItemSheetModel.commit`), through the
    /// planner, which gates it again. Once focus has gone, the field shows
    /// what is stored, so a blank title comes back and a pasted line break is
    /// the space that was sent. Nothing once the item is gone.
    private func commitTitle(leaving: Bool) {
        guard let item = planner.item(id) else { return }
        if let edit = ItemSheetModel.commit(draft: titleDraft, seed: titleSeed, stored: item.title, kind: .title) {
            planner.edit(id, edit)
        }
        if leaving, let stored = planner.item(id)?.title { titleDraft = stored }
        titleSeed = titleDraft
    }

    /// Sends the notes if they changed. Once focus has gone, the text takes
    /// the field's place again, showing what is stored.
    private func commitNotes(leaving: Bool) {
        guard editingNotes, let item = planner.item(id) else { return }
        if let edit = ItemSheetModel.commit(draft: notesDraft, seed: notesSeed, stored: item.notes, kind: .notes) {
            planner.edit(id, edit)
        }
        notesSeed = notesDraft
        if leaving { editingNotes = false }
    }

    // MARK: Delete

    /// Asks before deleting `target` (this page's item, or a subtask from its
    /// row): "Delete task?", the type's words, and how many subtasks go with
    /// it, worked out now and kept with the confirm.
    private func askDelete(_ target: UUID) {
        guard let item = planner.item(target) else { return }
        let typeCaps = planner.caps(for: item)
        let childCount = ItemSheetModel.cascadeCount(item, in: planner.items)
        confirm = .delete(target,
                          title: ItemSheetModel.deleteConfirmTitle(typeLabel: typeCaps.label),
                          message: ItemSheetModel.deleteConfirmMessage(item, typeCaps, childCount: childCount))
        confirming = true
    }

    private func confirmed(_ pending: SheetConfirm) {
        switch pending {
        case .delete(let target, _, _):
            delete(target)
        }
    }

    /// Deletes `target` through the planner, which asks its gate again and
    /// closes the sheet when it was the sheet's item; this page's own pops
    /// from the stack when it was a pushed one (`body`'s `onChange`). Then
    /// VoiceOver hears "Task deleted", once the page has gone: said at once,
    /// the screen change that follows would cut it off.
    private func delete(_ target: UUID) {
        guard let item = planner.item(target) else { return }
        let spoken = ItemSheetModel.deletedAnnouncement(typeLabel: planner.caps(for: item).label)
        withAnimation(.snappy) {
            planner.deleteItem(target)
        }
        guard planner.item(target) == nil else { return }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(600))
            AccessibilityNotification.Announcement(AttributedString(spoken)).post()
        }
    }

    // MARK: Verbs

    /// Runs `verb` on the day the sheet acts on, read now, not when the sheet
    /// was drawn. Pause until (and Reschedule, which the bar shows as a menu)
    /// first asks for a day, in the sheet's own day picker; Delete asks to
    /// confirm.
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
        case .delete:
            askDelete(id)
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

/// What a page asks before it acts, in the words it asks in, worked out when
/// it asks: a confirm's title isn't handed the value it presents, and the
/// item may be gone by the time the dialog has closed. One case in 2a; Reset
/// streak's confirm (2b) belongs to the streak chip's popover instead, since
/// a view presenting a popover can't also present a dialog.
enum SheetConfirm: Hashable, Sendable {
    /// Delete the item with this id: the page's own, or a subtask from its
    /// row.
    case delete(UUID, title: String, message: String)

    var title: String {
        switch self {
        case .delete(_, let title, _): return title
        }
    }

    var message: String {
        switch self {
        case .delete(_, _, let message): return message
        }
    }
}
