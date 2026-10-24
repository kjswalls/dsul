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
/// Each row ticks and opens on the band's day, as a List row does.
///
/// It is also a drop target, and its rows drag sources (PR 8):
/// - While a drag is in the air the header's words become "Drop here to
///   keep it time-free" (the web's), in the same frame.
/// - A block or an Anytime row of the day lands through the drop rule
///   (`moveBlock` to `.anytime`): `time {timeBucket: "anytime", startTime:
///   null}`, the day kept.
/// - A braindump row lands through `move {date}` (`placeAnytime`), the Date
///   chip's write, only when that write's gate takes it.
/// - A drop it won't take gets the system's forbidden badge, decided from
///   what the drag says was lifted, since the `ItemRef` is read only at the
///   drop.
/// - Its rows (`AnytimeRow`) lift with a hold inside the band's own drag
///   container; let go on an hour, a row writes what a block would.
struct AnytimeBand: View {
    /// The day, laid out once by ScheduleView: the band draws its untimed
    /// rows (`deriveUntimedRows`, from the same derive as the blocks) and
    /// ticks them on its day.
    let schedule: DaySchedule
    /// The braindump sheet is up.
    let sheetUp: Bool

    @Environment(SamplePlanner.self) private var planner
    /// Written from the drag and drop callbacks only; the header's words
    /// and its spoken label are the parts of the band that read it to draw.
    @Environment(ScheduleDrag.self) private var drag
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
        .dropDestination(for: ItemRef.self) { (refs: [ItemRef], _: DropSession) in
            guard let ref = refs.first else { return }
            drop(ref.id)
        }
        .dropConfiguration { _ in
            DropConfiguration(operation: proposal())
        }
    }

    /// The header: the word and the count, and with rows a chevron and a
    /// tap that folds them. Folding waits while the sheet is up, since the
    /// rows are already put away then.
    @ViewBuilder
    private var header: some View {
        if rows.isEmpty {
            headerLabel
                .accessibilityElement(children: .ignore)
                .modifier(SpokenHeader(spoken: AnytimeBandRules.spokenHeader(count: 0)))
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
            .modifier(SpokenHeader(spoken: AnytimeBandRules.spokenHeader(count: rows.count)))
            .accessibilityValue(Text(showsRows ? "Expanded" : "Collapsed"))
            .accessibilityAddTraits(.isHeader)
            .accessibilityHint(Text(sheetUp ? "" : (showsRows ? "Hides the rows" : "Shows the rows")))
        }
    }

    private var headerLabel: some View {
        HStack(spacing: 6) {
            AnytimeHeaderWords(words: AnytimeBandRules.header(count: rows.count))
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
                AnytimeRow(item: item, done: planner.isDone(item, on: day),
                           skipped: planner.isSkipped(item, on: day),
                           streaksEnabled: planner.settings.streaksEnabled,
                           onToggle: { toggle(item) },
                           onOpen: { planner.open(item.id, day: .selected) })
                    .padding(.horizontal, 16)
                    .padding(.vertical, 7)
                    // The lifted copy is the row on the band's paper.
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
    }

    /// A row lifted (the session's `.initial`): its own length for the
    /// ghost, held by its middle, and kept to the band's day when it moves
    /// in time only.
    private func lift(_ id: UUID?) {
        guard let id, let item = planner.item(id) else { return }
        drag.beginMove(itemID: id, durationMin: item.durationMin, source: .anytime(day: day), anchor: 0.5,
                       confinedTo: planner.confinedDay(id, from: day))
    }

    /// The band's proposal for the drag in the air (design §5.4): forbidden
    /// for a drop it won't take, else a move. A block or an Anytime row asks
    /// the drop rule from the day it was lifted on (`refusesDrop`); a
    /// braindump row asks the Date chip's gate (`canPlaceAnytime`).
    private func proposal() -> DropOperation {
        guard let id = drag.itemID else { return .forbidden }
        switch drag.source {
        case .block(let from)?, .anytime(let from)?:
            let refused = planner.refusesDrop(id, from: planner.blockOrigin(id, on: from),
                                              to: .anytime(date: day.description))
            return refused ? .forbidden : .move
        case .braindump?, nil:
            return planner.canPlaceAnytime(id, on: day) ? .move : .forbidden
        }
    }

    /// `id` let go on the band, routed by the item (`dropSource`) as the
    /// grid's drop is. Nothing is selected after it (B3).
    private func drop(_ id: UUID) {
        switch planner.dropSource(id, said: drag.source(of: id), on: day) {
        case .block(let from), .anytime(let from):
            withAnimation(.snappy) {
                _ = planner.moveBlock(id, from: planner.blockOrigin(id, on: from), to: .anytime(date: day.description))
            }
        case .braindump:
            withAnimation(.snappy) { planner.placeAnytime(id, on: day) }
        }
        drag.note("drop anytime")
    }

    /// A row's tick on the band's day, ungated, as a List row's
    /// (`tickAnytimeRow`, which ScheduleLayoutTests drives).
    private func toggle(_ item: SampleItem) {
        withAnimation(.snappy) { planner.tickAnytimeRow(item, in: schedule) }
    }
}

/// The header's spoken label (`BlockMoveWords.anytimeHeader`): its own, and
/// while a drag is in the air the hint the screen shows. A modifier of its
/// own, so only it reads the drag, and only whether one is in the air.
private struct SpokenHeader: ViewModifier {
    let spoken: String

    @Environment(ScheduleDrag.self) private var drag

    func body(content: Content) -> some View {
        content.accessibilityLabel(Text(BlockMoveWords.anytimeHeader(spoken, dragging: drag.inFlight)))
    }
}

/// The header's words, or while a drag is in the air the band's hint
/// (`BlockMoveWords.anytimeHint`), in one frame on one line, so the band
/// never changes height as a drag begins. Its own view, so only it and
/// `SpokenHeader` read the drag, and only whether one is in the air.
private struct AnytimeHeaderWords: View {
    let words: String

    @Environment(ScheduleDrag.self) private var drag

    var body: some View {
        ZStack(alignment: .leading) {
            Text(words)
                .opacity(drag.inFlight ? 0 : 1)
            Text(BlockMoveWords.anytimeHint)
                .opacity(drag.inFlight ? 1 : 0)
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
}
