import Accessibility
import DsulCore
import SwiftUI

// A container's page on the Organize stack (design §6.3, O2 and O3): the
// parts every page shares, and the host that keeps a page honest while its
// container comes and goes. What each page shows and says is
// ContainerPageModel (Foundation only, pinned by OrganizePageTests); these
// draw it.
//
// The writes: the tick, the row's own (`toggle(_:on:)` on today, behind the
// `tick` gate), the write Today's circle sends; a row's tap opens the item's
// sheet on today. From O8a a routine's or a season's Status chip, a menu
// (`StatusChipMenu`) where the page's model carries one (`StatusMenu`), and
// from O8b a goal's. From O8b the chips that open a sheet (`PageChip.edits`:
// a routine's usual time, a season's Runs, a goal's window) and the notes
// (PageEditors.swift); from O9 the ⋯ menu in the bar, Rename… (an alert,
// RenameAlert.swift) and Icon and color… (LookSheet.swift), which the host
// presents so they stay up however far the page has scrolled, and from O10
// its Delete… (a confirmation dialog, the web's words). From O12 the bar's
// Edit button, which turns the page's own Edit mode on (a routine's steps,
// reordered by drag or by Move up and Move down, with Remove and "Add from
// your items…"), and from O13 a season's "Add a routine…" and swipe Take out.
// The planner steps and sends each one. The footer's
// pages (Paused, a paused routine's or season's
// detail, Item types and the Trash, O5 and O14) go through the same
// destination: PausedPage.swift, PausedEntryPage.swift, ItemTypesPage.swift
// and TrashPage.swift draw them.
//
// No tint anywhere here (OrganizeView): the ticks, the strip, the ring and
// the timeline's nodes are `Color.accentColor`, lime, and a tint would turn
// them the label colour. Lime is a mark, never text, and nothing lime sits
// inside anything faded.

/// Where a route on the Organize stack goes.
struct OrganizeDestination: View {
    let route: OrganizeRoute
    @Binding var path: [OrganizeRoute]

    var body: some View {
        switch route {
        case .container(let kind, let id):
            switch kind {
            case .routine: RoutinePageView(id: id, path: $path)
            case .season: SeasonPageView(id: id, path: $path)
            case .goal: GoalPageView(id: id, path: $path)
            case .project: ProjectPageView(id: id, path: $path)
            }
        case .paused:
            PausedPageView(path: $path)
        case .pausedEntry(let key):
            PausedEntryPageView(key: key, path: $path)
        case .itemTypes:
            ItemTypesPageView(path: $path)
        case .trash:
            TrashPageView()
        }
    }
}

/// One page: its rows in an inset grouped list, the planner's banner over
/// it, pull to refresh, and the name in the bar once the header has scrolled
/// under it.
///
/// A page whose container goes (a delete from the web, a fetch without it)
/// takes itself off the stack, and keeps drawing what it last showed while it
/// slides away, as an item's page does (`ItemDetail`). One pushed for a
/// container already gone pops at once. While the container's extension is
/// off the page is the web's sentence, never "not found".
///
/// From O9 the bar carries the ⋯ menu where the page may rename the
/// container or change its look (`PageEdits.hasMenu`), and only while the
/// container is there: Rename… opens the alert, Icon and color… the sheet,
/// each on what the page showed when it was picked. From O10 it may also
/// delete it: Delete… asks first, in the web's words for the kind
/// (`DeleteEdit`), and once the container is gone the page pops as it does
/// for a delete from the web, and VoiceOver hears "Routine deleted".
///
/// From O12 the bar also carries Edit, on a page with an Edit mode to go into
/// (`steps`, a routine's, while `reorderable`: two steps or more and the
/// server's `moveMember`), and the rows it hands down read it through
/// `\.editMode`. It is this view's own state, not an `EditButton`, so the page
/// can leave it the moment the mode is no longer there: a fetch that takes the
/// write away, the switch going off, or a Remove that leaves one step puts the
/// page back as it was rather than leaving a list no drag can reorder.
struct OrganizePageHost<Page: OrganizePageModel, Rows: View>: View {
    let route: OrganizeRoute
    @Binding var path: [OrganizeRoute]
    /// The page as the planner has it now; nil once the container is gone.
    let load: @MainActor (SamplePlanner) -> PageContent<Page>?
    @ViewBuilder let rows: (Page) -> Rows

    @Environment(SamplePlanner.self) private var planner
    @State private var lastShown: PageContent<Page>? = nil
    /// The header's name has scrolled under the bar: the bar shows it.
    @State private var titleShown = false
    /// Rename…, while its alert is up, and the name in its field.
    @State private var renaming: RenameEdit? = nil
    @State private var renameDraft = ""
    /// Icon and color…, while its sheet is up.
    @State private var looking: LookEdit? = nil
    /// Delete…, while its confirm is up.
    @State private var deleting: DeleteEdit? = nil
    /// (O12) Edit mode, on a page that has one: its rows reorder and the bar's
    /// button says Done. This view's own, not the system's `EditButton`, so
    /// the page can hand it down (`\.editMode`) and leave it itself once the
    /// page may no longer be edited.
    @State private var editing = false
    /// How far the list scrolls before the header's name is under the bar:
    /// about the tile and the first line of a large title.
    @ScaledMetric(relativeTo: .largeTitle) private var titleFold: CGFloat = 96

    var body: some View {
        let live = load(planner)
        let shown = live ?? lastShown
        let title = shown?.title ?? ""
        let menu = Self.menuEdits(live)
        // Edit mode is the page's own, and only a page with steps to reorder
        // can be in it (`StepsEdit.reorderable`).
        let reorderable = Self.stepsEdit(live)?.reorderable == true
        let mode: EditMode = editing && reorderable ? .active : .inactive
        List {
            switch shown {
            case .page(let page)?:
                rows(page)
            case .switchedOff(let off)?:
                Section {
                    SwitchedOffRow(off: off)
                }
            case nil:
                EmptyView()
            }
        }
        .listStyle(.insetGrouped)
        // Handed to the rows the page drew, as the system's EditButton hands
        // it down.
        .environment(\.editMode, Binding<EditMode>.constant(mode))
        .modifier(LiveRefresh(planner: planner))
        // A refused tick's sentence shows here too: the list's banner is
        // under this page.
        .plannerBanner()
        // The back button's words on a page pushed from this one, and the
        // stack's long-press menu.
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .opacity(titleShown ? 1 : 0)
                    .accessibilityHidden(!titleShown)
            }
            if reorderable {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(editing ? ContainerEditModel.editDoneWord : ContainerEditModel.editWord) {
                        withAnimation(.snappy) { editing.toggle() }
                    }
                    .tint(Color.primary)
                }
            }
            if let menu {
                ToolbarItem(placement: .topBarTrailing) {
                    PageMenu(edits: menu, onRename: { rename($0) }, onLook: { looking = $0 },
                             onDelete: { deleting = $0 })
                }
            }
        }
        .renameAlert($renaming, draft: $renameDraft, onSave: { edit, draft in
            withAnimation(.snappy) { planner.rename(edit.ref, to: draft) }
        })
        .sheet(item: $looking) { edit in
            LookSheet(edit: edit)
        }
        .confirmationDialog(deleting?.title ?? "", isPresented: Binding(
            get: { deleting != nil },
            set: { shown in if !shown { deleting = nil } }
        ), titleVisibility: .visible, presenting: deleting) { edit in
            Button(edit.confirmLabel, role: .destructive) { delete(edit) }
            Button("Cancel", role: .cancel) {}
        } message: { edit in
            Text(edit.message)
        }
        .onScrollGeometryChange(for: Bool.self) { [fold = titleFold] geometry in
            geometry.contentOffset.y + geometry.contentInsets.top > fold
        } action: { _, past in
            withAnimation(.easeInOut(duration: 0.15)) { titleShown = past }
        }
        .onChange(of: live, initial: true) { _, now in
            if let now {
                lastShown = now
            } else {
                path.removeAll { planner.isGone($0) }
            }
        }
        // The mode goes with what it edits: a fetch that takes the write away,
        // the switch going off, or the steps going down to one puts the page
        // back as it rests.
        .onChange(of: reorderable) { _, still in
            if !still, editing { withAnimation(.snappy) { editing = false } }
        }
    }

    /// The ⋯ menu's edits: the live page's, when it may rename or change the
    /// look; nil while the container is gone or the page edits neither.
    private static func menuEdits(_ live: PageContent<Page>?) -> PageEdits? {
        guard case .page(let page)? = live, let edits = page.edits, edits.hasMenu else { return nil }
        return edits
    }

    /// (O12) The live page's steps, when it edits them; nil while the
    /// container is gone, the switch is off, or the page edits no steps. The
    /// bar's Edit button shows only while they are `reorderable`.
    private static func stepsEdit(_ live: PageContent<Page>?) -> StepsEdit? {
        guard case .page(let page)? = live else { return nil }
        return page.steps
    }

    /// Rename…: the field starts on the name as the page shows it.
    private func rename(_ edit: RenameEdit) {
        renameDraft = edit.name
        renaming = edit
    }

    /// Delete…, confirmed: through the planner, which asks its gate again.
    /// The page pops once the container is gone (`onChange` of `live`), and
    /// VoiceOver hears it once the page has gone. One already gone (a fetch
    /// while the confirm was up) has nothing to send or say.
    private func delete(_ edit: DeleteEdit) {
        guard planner.container(edit.ref) != nil else { return }
        withAnimation(.snappy) { planner.deleteContainer(edit.ref) }
        guard planner.container(edit.ref) == nil else { return }
        SettledAnnouncement.post(edit.spoken)
    }
}

/// Says a sentence to VoiceOver once the screen has settled (O10, O11): a
/// page going or coming, and the focus moving with it, would cut off one said
/// at once. It waits 600ms, as two private copies of the same rule do:
/// `ItemDetail.announceSettled` and `SignInView.announceSettled` (which also
/// checks its message still stands). A change to the delay changes all
/// three; folding those two into this one is left to a PR that touches them.
enum SettledAnnouncement {
    @MainActor static func post(_ spoken: String) {
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(600))
            AccessibilityNotification.Announcement(AttributedString(spoken)).post()
        }
    }
}

/// The page's ⋯ menu in the bar (O9, O10): Rename…, Icon and color… and,
/// last and in red as the system draws a destructive row, Delete…, each where
/// the page may write it. The label colour, never the lime tint; to VoiceOver
/// it is "More".
private struct PageMenu: View {
    let edits: PageEdits
    let onRename: (RenameEdit) -> Void
    let onLook: (LookEdit) -> Void
    let onDelete: (DeleteEdit) -> Void

    var body: some View {
        Menu {
            if let rename = edits.rename {
                Button {
                    onRename(rename)
                } label: {
                    Label(ContainerEditModel.renameWord, systemImage: "pencil")
                }
            }
            if let look = edits.look {
                Button {
                    onLook(look)
                } label: {
                    Label(look.menuLabel, systemImage: "paintpalette")
                }
            }
            if let delete = edits.delete {
                Divider()
                Button(role: .destructive) {
                    onDelete(delete)
                } label: {
                    Label(ContainerEditModel.deleteWord, systemImage: "trash")
                }
            }
        } label: {
            Label(ContainerEditModel.moreLabel, systemImage: "ellipsis")
        }
        .menuOrder(.fixed)
        .tint(Color.primary)
    }
}

extension View {
    /// A row of a page's top (the header, its lines, the chips, the notes):
    /// on the page's own background, with no separator, edge to edge of the
    /// sections below. A button in it (the notes' Show all) answers its own
    /// taps, never the whole row's, as a list row's plain button would.
    func pageTopRow() -> some View {
        self
            .buttonStyle(.borderless)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
    }
}

/// A page's header: the tile (or a goal's ring), the kind's eyebrow, and the
/// name in `.largeTitle`, wrapping. Hue is on the tile, its glyph and the
/// ring alone; the eyebrow is gray and the name the label colour. To
/// VoiceOver the name and kind are one heading ("Morning routine, routine"),
/// read before the ring's own label.
struct PageHeaderView: View {
    let header: PageHeader
    /// A goal's progress, drawn in place of the tile; nil draws the tile.
    var ring: GoalRing? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                if let ring {
                    GoalRingView(ring: ring, symbol: header.symbol, accent: header.accent)
                } else {
                    ContainerTile(symbol: header.symbol, accent: header.accent, side: 44)
                }
                Text(header.eyebrow)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.secondary)
                    .accessibilityHidden(true)
            }
            Text(header.title)
                .font(.largeTitle.bold())
                .foregroundStyle(Color.primary)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(Text("\(header.title), \(jsLowercased(OrganizeModel.noun(header.kind)))"))
                .accessibilityAddTraits(.isHeader)
                .accessibilitySortPriority(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

/// A goal's progress ring: a gray track, the lime arc at the share of
/// milestones reached, and the goal's glyph in its colour at the centre, not
/// a percent. 64pt, scaling with Dynamic Type. One element to VoiceOver,
/// "2 of 5 milestones reached"; the glyph is hidden.
struct GoalRingView: View {
    let ring: GoalRing
    let symbol: String
    let accent: ContainerAccent

    @ScaledMetric(relativeTo: .body) private var side: CGFloat = 64
    @ScaledMetric(relativeTo: .body) private var line: CGFloat = 6
    @ScaledMetric(relativeTo: .body) private var glyph: CGFloat = 24

    var body: some View {
        ZStack {
            Circle()
                .stroke(Color(.tertiarySystemFill), lineWidth: line)
            Circle()
                .trim(from: 0, to: CGFloat(min(max(ring.fraction, 0), 1)))
                .stroke(Color.accentColor, style: StrokeStyle(lineWidth: line, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.snappy, value: ring.fraction)
            Image(systemName: symbol)
                .font(.system(size: glyph, weight: .medium))
                .foregroundStyle(accent.color)
        }
        // A stroke straddles its path: inset by half the line, the ring
        // draws inside its frame.
        .padding(line / 2)
        .frame(width: side, height: side)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(ring.spokenLabel))
    }
}

/// The chips under a page's header, wrapping as the item sheet's do
/// (`ChipFlow`), each in its 44pt slot: the symbol gray, the words the label
/// colour. Read-only, with no chevron, but for the Status chip when the page
/// carries a `status` menu (O8a): then it is that menu, its label ending in a
/// chevron, and a pick goes to `onStatus`; and for a chip that `edits` (O8b),
/// a button with the same chevron, as the item sheet's chips that open a
/// sheet are, whose tap goes to `onEdit`. One element each to VoiceOver
/// ("Status: Paused until Oct 30"), the controls with their button trait and
/// hint.
struct PageChipsView: View {
    let chips: [PageChip]
    var status: StatusMenu? = nil
    var onStatus: (StatusAction) -> Void = { _ in }
    var onEdit: (PageChip.Kind) -> Void = { _ in }

    var body: some View {
        let flow = ChipFlow()
        flow {
            ForEach(chips) { chip in
                if chip.kind == .status, let status {
                    StatusChipMenu(chip: chip, menu: status, onPick: onStatus)
                } else if chip.edits {
                    Button {
                        onEdit(chip.kind)
                    } label: {
                        PageChipLabel(chip: chip, editable: true)
                            .chipHit()
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel(Text(chip.spoken))
                    .accessibilityHint(Text(ContainerEditModel.chipHint(chip.kind) ?? ""))
                } else {
                    PageChipLabel(chip: chip)
                        .chipSlot()
                }
            }
        }
    }
}

/// One page chip's capsule: its symbol gray, its words the label colour, and
/// a gray chevron when it opens a menu, as the item sheet's editable chips
/// end (`ChipView`). One element to VoiceOver, its spoken words.
struct PageChipLabel: View {
    let chip: PageChip
    var editable: Bool = false

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: chip.systemImage)
                .foregroundStyle(.secondary)
            Text(chip.text)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
            if editable {
                Image(systemName: "chevron.down")
                    .imageScale(.small)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
        .foregroundStyle(Color.primary)
        .font(.subheadline)
        .chipBackground()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(chip.spoken))
    }
}

/// A page's Status chip as a menu (O8a; a goal's from O8b), drawn as the
/// item sheet's editable chips are (`PropertyMenus`): the chip in its 44pt
/// hit frame as the label, scaling when pressed, the label colour throughout,
/// never the lime tint, so a season's checkmark isn't lime either. A season's
/// and a goal's states are an inline picker, the one it is in checked; a
/// routine's verbs are plain buttons, with no check. A pick goes to `onPick`
/// and nothing is written here.
struct StatusChipMenu: View {
    let chip: PageChip
    let menu: StatusMenu
    let onPick: (StatusAction) -> Void

    var body: some View {
        Menu {
            if let selected = menu.selected {
                Picker(chip.text, selection: Binding(get: { selected }, set: { onPick($0) })) {
                    ForEach(menu.choices) { choice in
                        Label(choice.label, systemImage: choice.systemImage)
                            .tag(choice.action)
                    }
                }
                .pickerStyle(.inline)
            } else {
                ForEach(menu.choices) { choice in
                    Button {
                        onPick(choice.action)
                    } label: {
                        Label(choice.label, systemImage: choice.systemImage)
                    }
                }
            }
        } label: {
            PageChipLabel(chip: chip, editable: true)
                .chipHit()
        }
        .menuOrder(.fixed)
        .menuStyle(.button)
        .buttonStyle(PressScaleStyle())
        .tint(Color.primary)
        .accessibilityLabel(Text(chip.spoken))
        .accessibilityHint(Text(ContainerPageModel.statusHint))
    }
}

/// A section's heading: sentence case, the title `.primary`, a count or
/// summary at the trailing edge `.secondary`. One heading to VoiceOver,
/// with the trailing words as they are said.
struct PageSectionHeader: View {
    let title: String
    var trailing: String? = nil
    /// The trailing words for VoiceOver; the shown ones with "·" as a pause
    /// when nil.
    var spokenTrailing: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.primary)
            Spacer(minLength: 8)
            if let trailing {
                Text(trailing)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(Color.secondary)
                    .multilineTextAlignment(.trailing)
            }
        }
        .textCase(nil)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(spokenLabel))
        .accessibilityAddTraits(.isHeader)
    }

    private var spokenLabel: String {
        guard let words = spokenTrailing ?? trailing.map(OrganizeModel.spokenSegment) else { return title }
        return "\(title), \(words)"
    }
}

/// A quiet line: an empty section's sentence, a note under the chips.
/// Secondary; it says why, it asks nothing.
struct PageQuietText: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(Color.secondary)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// The page while its extension is off: the web's title and sentence, in
/// place of everything else.
private struct SwitchedOffRow: View {
    let off: SwitchedOff

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(off.title)
                .font(.body)
                .foregroundStyle(Color.secondary)
            Text(off.body)
                .font(.subheadline)
                .foregroundStyle(Color.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(off.sentence))
    }
}

/// One item on a page, Today's row in look: the status circle, the title
/// (struck through when done), the meta under it, and a habit's flame while
/// Streaks is on.
///
/// The circle is the tick only for an item on today (`tickable`), through
/// the row's own write on today, never the selected day's; anywhere else on
/// the row, and the whole row of an item not on today, opens the item's sheet
/// on today. Skipped today, the circle gives way to a skip mark (the sheet is
/// where Unskip is). To VoiceOver the row is ONE element whose activation
/// opens the sheet; Done is its value, and the tick a named action.
///
/// From O12 a row whose routine may take the step out (`row.removable`, on a
/// page that handed down `onRemove`) swipes to Remove, which VoiceOver hears
/// as a second named action. It is never "Delete": the step leaves the
/// routine and the item itself stays where it is.
struct MemberRowView: View {
    let row: MemberRow
    /// A paused routine's or season's member (its detail's "Comes back with
    /// it"): the dashed outline the Paused list draws, the web's ItemMark on
    /// both, in place of the circle. Such a row never ticks.
    var paused = false
    /// (O12) Takes this step out of its routine; nil on a page that doesn't
    /// offer it, which is every page but a routine's.
    var onRemove: (() -> Void)? = nil

    @Environment(SamplePlanner.self) private var planner

    /// Swipe Remove and its named action show together, where the page offers
    /// it and the row takes it.
    private var removable: Bool { row.removable && onRemove != nil }

    var body: some View {
        HStack(spacing: 12) {
            if row.tickable {
                // Drawn at 22 in a 30pt column, hit over 44pt: the overhang
                // grows the hit shape and leaves the layout alone.
                Button(action: toggle) {
                    TickCircle(done: row.done, habit: row.item.isHabit)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressScaleStyle())
                .padding(-7)
            }

            Button(action: open) {
                HStack(spacing: 12) {
                    if !row.tickable {
                        mark
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.item.title)
                            .strikethrough(row.done)
                            .foregroundStyle(row.done || row.skipped ? Color.secondary : Color.primary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        if let subline {
                            Text(subline)
                                .font(.footnote)
                                .foregroundStyle(Color.secondary)
                                .multilineTextAlignment(.leading)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if row.flame {
                        StreakLabel(streak: row.item.streak ?? 0, lit: row.done)
                    }
                }
                // The hit shape overhangs the label to the row's edges, as
                // Today's does, and leaves the layout alone.
                .padding(.vertical, 11)
                .contentShape(Rectangle())
                .padding(.vertical, -11)
            }
            .buttonStyle(RowPressStyle())
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(row.spokenLabel))
        .accessibilityValue(Text(row.done ? "Done" : ""))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint(Text(ContainerPageModel.openHint))
        .accessibilityAction { open() }
        .accessibilityActions {
            if row.tickable {
                Button(ContainerPageModel.tickName(done: row.done)) { toggle() }
            }
            if removable, let onRemove {
                Button(ContainerEditModel.removeStepWord) { onRemove() }
            }
        }
        .accessibilityInputLabels([Text(row.item.title)])
        // (O12) Swipe Remove, where the page offers it. No full swipe: taking
        // a step out of a routine is not a flick to make by accident, and the
        // row says what it is before it goes. The page animates the write.
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if removable, let onRemove {
                Button(ContainerEditModel.removeStepWord, role: .destructive) { onRemove() }
            }
        }
    }

    /// The meta, then why it is hidden, as one line.
    private var subline: String? {
        let parts = [row.meta, row.hiddenNote].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: OrganizeModel.separator)
    }

    /// Where the tick would be on a row that doesn't tick today: a paused
    /// member's outline, a skip mark, or the circle drawn for its state, part
    /// of the open button.
    @ViewBuilder
    private var mark: some View {
        if paused {
            PausedMarkView(mark: .item(habit: row.item.isHabit))
        } else if row.skipped {
            Image(systemName: "forward.end")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Color.secondary)
                .frame(width: 30, height: 30)
        } else {
            TickCircle(done: row.done, habit: row.item.isHabit)
                .frame(width: 30, height: 30)
        }
    }

    private func open() {
        planner.open(row.item.id, day: .today)
    }

    private func toggle() {
        planner.toggle(row.item.id, on: planner.today)
    }
}

/// The row that adds a member (O12, O13): "Add from your items…" on a
/// routine, "Add a routine…" on a season. A gray +, the label colour, never
/// lime, and no chevron: it opens a sheet, as the look rows do.
///
/// With nothing left to add it is still drawn, gray and inert, with the
/// reason under it, as the web draws its disabled pill: a row that vanishes
/// reads as "this cannot take any at all". Its tap goes to `onTap`; nothing
/// is written here.
struct PageAddRow: View {
    let title: String
    /// Why there is nothing left to add; nil while there is.
    var none: String? = nil
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                Image(systemName: "plus.circle")
                    .foregroundStyle(Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .foregroundStyle(none == nil ? Color.primary : Color.secondary)
                        .multilineTextAlignment(.leading)
                    if let none {
                        Text(none)
                            .font(.footnote)
                            .foregroundStyle(Color.secondary)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
            }
            // The hit shape overhangs the label to the row's edges, as the
            // member rows' does, and leaves the layout alone.
            .padding(.vertical, 11)
            .contentShape(Rectangle())
            .padding(.vertical, -11)
        }
        .buttonStyle(RowPressStyle())
        .disabled(none != nil)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(spokenLabel))
        .accessibilityAddTraits(.isButton)
    }

    /// The row as one element: its words, then why nothing can be added.
    private var spokenLabel: String {
        guard let none else { return title }
        return "\(title), \(none)"
    }
}

/// A container row that pushes its page: the Organize list's rows, a
/// routine's "Held by", a season's routines.
struct ContainerLinkRow: View {
    let row: OrganizeRow
    /// (O13) Takes this routine out of the season whose page drew it; nil in
    /// every other list, where a row is a link and nothing else.
    var onTakeOut: (() -> Void)? = nil

    var body: some View {
        NavigationLink(value: row.route) {
            ContainerRow(row: row)
        }
        .accessibilityHint(Text(row.hint))
        .accessibilityActions {
            if let onTakeOut {
                Button(ContainerEditModel.takeOutWord) { onTakeOut() }
            }
        }
        // (O13) Swipe Take out, on a season's page. The routine itself stays:
        // it leaves this season and goes on running on its own. The page
        // animates the write.
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if let onTakeOut {
                Button(ContainerEditModel.takeOutWord, role: .destructive) { onTakeOut() }
            }
        }
    }
}
