import Accessibility
import DsulCore
import SwiftUI

// Leftovers on Today on the iPhone (memory/plans/ghost-rows.md, phase 3): one
// quiet "From earlier N" fold at the top of today's Day view, in List, Buckets
// and Schedule, as components/planner/ghost-fold.tsx draws it on the web. Not
// in the Week forms, as the web's week views have none. The rows are a view
// over `SamplePlanner.ghostRows` (DsulCore `selectGhostRows`): nothing is
// written until a verb is picked, and every verb is a write the planner
// already makes (GhostRowsModel.swift).
//
// No lime in a ghost row: the title is muted, the box a dashed outline in the
// secondary ink, and arrive's light crosses only those. The one lime mark is
// "All sorted, you got this"'s dot, drawn at full strength with nothing above
// it faded and no transition on it.

/// The fold's words, the web's exactly where the web has them
/// (ghost-fold.tsx).
enum GhostCopy {
    static let caption = "From earlier"
    static let keepAll = "Keep all"
    static let sendAll = "Send all to sidebar"
    static let done = "Mark done"
    static let keep = "Keep for today"
    static let tomorrow = "Move to tomorrow"
    static let reschedule = "Reschedule"
    static let sidebar = "Send to sidebar"
    static let letGo = "Let it go"
    static let keptInHistory = "Kept in history"
    static let sorted = "All sorted, you got this"
    static let cancel = "Cancel"
    /// The fold's spoken name (its `aria-label`).
    static let spokenName = "Left over from earlier"
    /// `GHOST_DONE_MS`, in seconds.
    static let doneSeconds = 4.0

    /// The sheet's line under the title: "Planned for Thu, Oct 15".
    static func plannedFor(_ day: String) -> String {
        return "Planned for " + formatTargetDay(day)
    }

    /// A verb's word.
    static func word(_ verb: GhostVerb) -> String {
        switch verb {
        case .keep: keep
        case .tomorrow: tomorrow
        case .reschedule: reschedule
        case .sidebar: sidebar
        case .letGo: letGo
        }
    }

    /// The verb's symbol, the web's icon where SF Symbols has one.
    static func symbol(_ verb: GhostVerb) -> String {
        switch verb {
        case .keep: "plus"
        case .tomorrow: "arrow.uturn.forward"
        case .reschedule: "calendar"
        case .sidebar: "arrow.left.to.line"
        case .letGo: "xmark"
        }
    }

    /// A row as VoiceOver hears it: "Call the bank, from Thursday".
    static func spokenRow(_ item: SampleItem) -> String {
        guard let day = DayString(ghostDay(item)) else { return item.title }
        return item.title + ", from " + PlannerFormat.weekdayName(day)
    }
}

/// The motion's numbers (ghost-rows.md "Motion: arrive"). Arrive is the
/// web's rise on the planner's light (app/globals.css `ghost-rise`): each title
/// starts faint, and a band of full ink crosses it at a steady pace, leaving
/// the secondary ink behind it, a beat apart down the fold. The box only draws
/// in. Nothing breathes (Kirby, 2026-11-01).
enum GhostMotion {
    /// Half the band's width: the web's `--planner-shimmer-band` at a phone's width.
    static let band: CGFloat = 40
    /// The light's pace, points a second: the web's, about 690px/s.
    static let speed: CGFloat = 690
    /// The title's ink before the light reaches it, as a share of the secondary ink.
    static let faint: Double = 0.3
    /// 0.2s in, then 0.11s a row, capped as the web caps it.
    static func delay(_ index: Int) -> Double { 0.2 + Double(min(index, 8)) * 0.11 }
    static func rise(width: CGFloat, index: Int) -> Animation {
        .linear(duration: Double((width + 2 * band) / speed)).delay(delay(index))
    }
    static func boxIn(_ index: Int) -> Animation {
        .easeOut(duration: 0.6).delay(delay(index))
    }
}

/// The fold, where the Day view puts it: as List sections (`.list`), or as a
/// card in a stack (`.card`, Buckets and Schedule). `rowCap` scrolls the rows
/// past that many (Schedule's, so the hours keep their room); `rowsHidden`
/// shows the caption alone (Schedule's, while the braindump sheet is up).
struct GhostFold: View {
    enum Host { case list, card }

    var host: Host
    var rowCap: Int? = nil
    var rowsHidden: Bool = false

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var rowHeight: CGFloat = 44
    /// The person's own open or close; nil follows `startsCollapsed`.
    @State private var userOpen: Bool? = nil
    /// Decided by the count at first sight, so a pile shrinking to five never
    /// springs the fold open.
    @State private var startsCollapsed: Bool? = nil

    var body: some View {
        // Today only, in the user's zone: on any other day nothing ghosts.
        let ghosts = planner.isOnToday ? planner.ghostRows : []
        if !ghosts.isEmpty {
            switch host {
            case .list: listFold(ghosts)
            case .card: cardFold(ghosts)
            }
        } else if planner.isOnToday && planner.showsGhostsSorted {
            switch host {
            case .list:
                Section {
                    sortedLine
                        .listRowSeparator(.hidden)
                }
            case .card:
                sortedLine
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
            }
        }
    }

    private func isOpen(_ count: Int) -> Bool {
        return userOpen ?? !(startsCollapsed ?? ghostFoldStartsCollapsed(count))
    }

    // MARK: The two hosts

    @ViewBuilder
    private func listFold(_ ghosts: [SampleItem]) -> some View {
        Section {
            if isOpen(ghosts.count) && !rowsHidden {
                ForEach(Array(ghosts.enumerated()), id: \.element.id) { index, ghost in
                    row(ghost, index: index)
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            if planner.ghostOffers(.keep, ghost) {
                                Button(GhostCopy.keep, systemImage: GhostCopy.symbol(.keep)) {
                                    settle(ghost.id, .keep)
                                }
                                .tint(Color(.systemBlue))
                            }
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            if planner.ghostOffers(.tomorrow, ghost) {
                                Button(GhostCopy.tomorrow, systemImage: GhostCopy.symbol(.tomorrow)) {
                                    settle(ghost.id, .tomorrow)
                                }
                                .tint(Color(.systemGray))
                            }
                        }
                }
            }
        } header: {
            caption(ghosts)
        }
    }

    private func cardFold(_ ghosts: [SampleItem]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            caption(ghosts)
            if isOpen(ghosts.count) && !rowsHidden {
                let rows = VStack(spacing: 0) {
                    ForEach(Array(ghosts.enumerated()), id: \.element.id) { index, ghost in
                        row(ghost, index: index)
                            .modifier(GhostSwipe(
                                onRight: planner.ghostOffers(.keep, ghost) ? { settle(ghost.id, .keep) } : nil,
                                onLeft: planner.ghostOffers(.tomorrow, ghost) ? { settle(ghost.id, .tomorrow) } : nil))
                    }
                }
                if let rowCap, ghosts.count > rowCap {
                    ScrollView { rows }
                        .frame(maxHeight: rowHeight * CGFloat(rowCap))
                        .scrollIndicatorsFlash(onAppear: true)
                } else {
                    rows
                }
            }
        }
        // BucketCard's card, so the fold reads as one more quiet card above
        // the day and a swiped row's backing matches it.
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(Color(.secondarySystemBackground)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(GhostCopy.spokenName))
    }

    // MARK: Parts

    /// "From earlier", a muted count and a chevron that folds the rows, then
    /// Keep all and Send all to sidebar, always on screen on touch.
    private func caption(_ ghosts: [SampleItem]) -> some View {
        let open = isOpen(ghosts.count)
        let keepable = ghosts.contains { planner.ghostOffers(.keep, $0) }
        let sendable = ghosts.contains { planner.ghostOffers(.sidebar, $0) }
        return HStack(spacing: 12) {
            Button {
                withAnimation(reduceMotion ? nil : .snappy) { userOpen = !open }
            } label: {
                HStack(spacing: 6) {
                    Text(GhostCopy.caption)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.primary)
                    Text("\(ghosts.count)")
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(Color.secondary)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.semibold))
                        .rotationEffect(.degrees(open ? 0 : -90))
                        .foregroundStyle(Color.secondary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle())
            .accessibilityLabel(Text("\(GhostCopy.caption), \(ghosts.count)"))
            .accessibilityValue(Text(open ? "Expanded" : "Collapsed"))

            Spacer(minLength: 8)

            if keepable {
                bulkButton(GhostCopy.keepAll) { settleAll(.keep) }
            }
            if sendable {
                bulkButton(GhostCopy.sendAll) { settleAll(.sidebar) }
            }
        }
        .textCase(nil)
        .padding(.vertical, 2)
        .onAppear { firstSight(ghosts.count) }
    }

    private func bulkButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.footnote)
                .foregroundStyle(Color.secondary)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
                .padding(.vertical, -11)
        }
        .buttonStyle(PressScaleStyle(scale: 0.96))
    }

    /// Hidden only before this planner's first arrive starts
    /// (`SamplePlanner.ghostsHaveArrived`): once it has played, every fold
    /// draws its rows at rest from the first frame. Under Reduce Motion the
    /// first sight sets it at once, so turning Reduce Motion off later never
    /// takes the rows back to hidden.
    private var rowsAtRest: Bool {
        return planner.ghostsHaveArrived || reduceMotion
    }

    private func row(_ ghost: SampleItem, index: Int) -> some View {
        GhostRow(item: ghost, index: index, lit: rowsAtRest,
                 onDone: { markDone(ghost.id) },
                 onOpen: { planner.activeSheet = .ghost(ghost.id) },
                 actions: GhostVerb.allCases.filter { planner.ghostOffers($0, ghost) && $0 != .reschedule },
                 onAction: { settle(ghost.id, $0) })
    }

    /// "All sorted, you got this" beside one small lime dot, at full
    /// strength: no opacity above it, and it comes and goes with no
    /// transition (the verb that brings it is sent unanimated, see
    /// `settle`).
    private var sortedLine: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Color.accentColor)
                .frame(width: 6, height: 6)
                .accessibilityHidden(true)
            Text(GhostCopy.sorted)
                .font(.footnote)
                .foregroundStyle(Color.secondary)
        }
        .padding(.vertical, 4)
        .transition(.identity)
        .accessibilityElement(children: .combine)
    }

    // MARK: Doing

    private func firstSight(_ count: Int) {
        if startsCollapsed == nil { startsCollapsed = ghostFoldStartsCollapsed(count) }
        guard !planner.ghostsHaveArrived else { return }
        // No arrive to play: at rest now, and for good, so the rows can't
        // hide when Reduce Motion is turned off with the fold on screen.
        if reduceMotion {
            planner.ghostsHaveArrived = true
            return
        }
        // After the first frame, so the titles have been drawn faint and the
        // light rises them from there.
        let planner = self.planner
        Task { @MainActor in
            planner.ghostsHaveArrived = true
        }
    }

    /// A verb that empties the fold goes with no animation at all, so the
    /// sorted line, and its lime dot, are never faded in: in the List host it
    /// arrives as a new row, which List would fade through its own opacity
    /// whatever `.transition` the line asks for.
    private func settle(_ id: UUID, _ verb: GhostVerb) {
        let still = reduceMotion || planner.ghostVerbEmptiesFold(verb, id)
        withAnimation(still ? nil : .snappy) { planner.settleGhost(id, verb) }
        announceIfSorted()
    }

    private func markDone(_ id: UUID) {
        let still = reduceMotion || planner.ghostDoneEmptiesFold(id)
        withAnimation(still ? nil : .snappy) { planner.markGhostDone(id) }
        announceIfSorted()
    }

    private func settleAll(_ verb: GhostVerb) {
        let still = reduceMotion || planner.ghostBulkEmptiesFold(verb)
        withAnimation(still ? nil : .snappy) { planner.settleAllGhosts(verb) }
        announceIfSorted()
    }

    private func announceIfSorted() {
        if planner.showsGhostsSorted {
            AccessibilityNotification.Announcement(AttributedString(GhostCopy.sorted)).post()
        }
    }
}

/// One ghost: the real row's geometry, muted. A dashed box where the tick
/// would be (a tap marks it done, as a row's tick does), the title in the secondary ink, and
/// the ghost's own weekday ("Thu") where the time would be. A tap on the rest
/// opens its sheet. To VoiceOver it is one element that opens the sheet, with
/// each verb as a named action.
struct GhostRow: View {
    var item: SampleItem
    var index: Int
    /// False until arrive plays: the title faint, the box not drawn yet.
    var lit: Bool = true
    var onDone: () -> Void
    var onOpen: () -> Void
    /// The verbs VoiceOver offers in place of the swipes, in the sheet's order.
    var actions: [GhostVerb]
    var onAction: (GhostVerb) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onDone) {
                GhostBox()
                    .opacity(lit ? 1 : 0)
                    .animation(reduceMotion ? nil : GhostMotion.boxIn(index), value: lit)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressScaleStyle())
            .padding(-7)

            Button(action: onOpen) {
                HStack(spacing: 12) {
                    GhostRiseTitle(title: item.title, index: index, lit: lit)
                    Spacer(minLength: 8)
                    Text(ghostWeekday(ghostDay(item)))
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(Color.secondary)
                }
                .padding(.vertical, 11)
                .contentShape(Rectangle())
                .padding(.vertical, -11)
            }
            .buttonStyle(RowPressStyle())
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(GhostCopy.spokenRow(item)))
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Opens choices")
        .accessibilityAction { onOpen() }
        .accessibilityActions {
            Button(GhostCopy.done) { onDone() }
            ForEach(actions, id: \.self) { verb in
                Button(GhostCopy.word(verb)) { onAction(verb) }
            }
        }
        .accessibilityInputLabels([Text(item.title)])
    }
}

/// A ghost's title under arrive's light. The title is drawn faint, and over it
/// the same text, masked, shows a strip that is the secondary ink up to a band
/// of full ink: the strip slides from wholly before the title to wholly over
/// it, so the band crosses the title at `GhostMotion.speed` and leaves the
/// secondary ink behind. Drawn at rest (`lit` from the start, or Reduce
/// Motion), the strip already covers the title: plain secondary ink. Neutral
/// inks only.
struct GhostRiseTitle: View {
    var title: String
    var index: Int
    var lit: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var text: some View {
        Text(title)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
    }

    var body: some View {
        text
            .foregroundStyle(Color.secondary.opacity(GhostMotion.faint))
            .overlay(alignment: .leading) {
                GeometryReader { geo in
                    let width = geo.size.width
                    let band = GhostMotion.band
                    HStack(spacing: 0) {
                        Color.secondary.frame(width: width)
                        LinearGradient(
                            stops: [
                                .init(color: .secondary, location: 0),
                                .init(color: .primary, location: 0.5),
                                .init(color: .clear, location: 1),
                            ],
                            startPoint: .leading, endPoint: .trailing
                        )
                        .frame(width: 2 * band)
                    }
                    .frame(width: width + 2 * band, height: geo.size.height, alignment: .leading)
                    .offset(x: lit ? 0 : -(width + 2 * band))
                    .animation(reduceMotion ? nil : GhostMotion.rise(width: width, index: index), value: lit)
                }
                .mask(alignment: .leading) { text }
            }
    }
}

/// The ghost's box: TickBox's open square, dashed, in the secondary ink, no
/// fill and never lime.
struct GhostBox: View {
    var diameter: CGFloat = 22

    var body: some View {
        let side = diameter * 0.9
        RoundedRectangle(cornerRadius: side * 5 / 16, style: .continuous)
            .strokeBorder(Color.secondary, style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
            .frame(width: side, height: side)
            .frame(width: diameter, height: diameter)
    }
}

/// Swipe right to keep for today, left to move to tomorrow, outside a List
/// (Buckets, Schedule), where `swipeActions` has no row to hang on. Horizontal
/// only, so the stack still scrolls; past `threshold` the verb runs, short of
/// it the row springs back. A side with no verb doesn't move.
struct GhostSwipe: ViewModifier {
    var onRight: (() -> Void)?
    var onLeft: (() -> Void)?

    static let threshold: CGFloat = 80

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dx: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .background(Color(.secondarySystemBackground))
            .offset(x: dx)
            .background(alignment: dx >= 0 ? .leading : .trailing) {
                if dx != 0 {
                    reveal(dx > 0 ? .keep : .tomorrow, armed: abs(dx) >= Self.threshold)
                }
            }
            .clipped()
            .simultaneousGesture(
                DragGesture(minimumDistance: 16)
                    .onChanged { value in
                        let w = value.translation.width
                        guard abs(w) > abs(value.translation.height) else { return }
                        if (w > 0 && onRight == nil) || (w < 0 && onLeft == nil) {
                            dx = 0
                        } else {
                            dx = w
                        }
                    }
                    .onEnded { _ in
                        let x = dx
                        withAnimation(reduceMotion ? nil : .snappy) { dx = 0 }
                        if x >= Self.threshold {
                            onRight?()
                        } else if x <= -Self.threshold {
                            onLeft?()
                        }
                    }
            )
    }

    private func reveal(_ verb: GhostVerb, armed: Bool) -> some View {
        Label(GhostCopy.word(verb), systemImage: GhostCopy.symbol(verb))
            .font(.footnote.weight(.semibold))
            .foregroundStyle(armed ? Color.primary : Color.secondary)
            .padding(.horizontal, 12)
            .frame(maxHeight: .infinity)
            .accessibilityHidden(true)
    }
}

/// A leftover's five verbs, from a tap on its row: the title, "Planned for
/// Thu, Oct 15", then Keep for today (the ink primary), Move to tomorrow
/// (today's tomorrow beside it), Reschedule (a day picker over the sheet),
/// Send to sidebar and Let it go ("Kept in history"), each only where it
/// lands, then Cancel. The web's phone drawer, as a sheet. It closes on a
/// verb, and by itself if the item stops being a leftover (settled elsewhere).
struct GhostSheet: View {
    let id: UUID

    @Environment(SamplePlanner.self) private var planner
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var choosing = false

    private var ghost: SampleItem? {
        planner.ghostRows.first { $0.id == id }
    }

    var body: some View {
        NavigationStack {
            Group {
                if let ghost {
                    content(ghost)
                } else {
                    Color.clear
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(GhostCopy.cancel, role: .cancel) { dismiss() }
                        .tint(Color.primary)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .sheet(isPresented: $choosing) {
            if let ghost {
                DayPickSheet(words: DayPickWords(title: GhostCopy.reschedule, confirmVerb: "Move to", note: nil),
                             initial: planner.today, earliest: nil) { day in
                    run(.reschedule, on: ghost, day: day)
                }
            }
        }
        .onChange(of: ghost == nil) { _, gone in
            if gone && !choosing { dismiss() }
        }
    }

    private func content(_ ghost: SampleItem) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(ghost.title)
                        .font(.title3.weight(.semibold))
                        .lineLimit(3)
                    Text(GhostCopy.plannedFor(ghostDay(ghost)))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                VStack(spacing: 8) {
                    ForEach(GhostVerb.allCases.filter { planner.ghostOffers($0, ghost) }, id: \.self) { verb in
                        verbButton(verb, ghost)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
        }
    }

    private func verbButton(_ verb: GhostVerb, _ ghost: SampleItem) -> some View {
        let primary = verb == .keep
        return Button {
            if verb == .reschedule {
                choosing = true
            } else {
                run(verb, on: ghost, day: nil)
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: GhostCopy.symbol(verb))
                    .frame(width: 20)
                Text(GhostCopy.word(verb))
                Spacer(minLength: 8)
                if let detail = detail(verb) {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(primary ? Color(.systemBackground) : Color.secondary)
                }
            }
            .font(.body.weight(primary ? .semibold : .regular))
            .foregroundStyle(primary ? Color(.systemBackground) : Color.primary)
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(primary ? Color.primary : Color(.secondarySystemFill)))
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressScaleStyle(scale: 0.97))
    }

    private func detail(_ verb: GhostVerb) -> String? {
        switch verb {
        case .tomorrow: return formatTargetDay(planner.ghostTomorrow.description)
        case .letGo: return GhostCopy.keptInHistory
        case .keep, .reschedule, .sidebar: return nil
        }
    }

    private func run(_ verb: GhostVerb, on ghost: SampleItem, day: DayString?) {
        // As the fold's own verbs: one that empties it goes unanimated, so
        // the sorted line's lime dot never fades in under the sheet.
        let still = reduceMotion || planner.ghostVerbEmptiesFold(verb, ghost.id)
        withAnimation(still ? nil : .snappy) { planner.settleGhost(ghost.id, verb, day: day) }
        if planner.showsGhostsSorted {
            AccessibilityNotification.Announcement(AttributedString(GhostCopy.sorted)).post()
        }
        dismiss()
    }
}
