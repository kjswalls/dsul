import Foundation

// Overlapping Schedule blocks: the web's pass, ported in numbers (Week and
// blocks PR 6). lib/schedule-overlap.ts `planOverlaps` decides where blocks
// that share time go ("Pocket & Channel"): it clusters them on their PAINTED
// extents (a pane floored at `paneMinH` covers more grid than it owns), and
// then, on Day, nests a block inside a longer one (up to `maxDepthDay`), packs
// crossing blocks into first-fit columns no narrower than `minChannelPx`
// (past that, an inset cascade inside the last column), and tiles a genuine
// double booking side by side, each tile keeping its own lane; on Week every
// overlap shingles by `shinglePx` and a double booking tiles. A block with no
// overlap gets no plan and draws as a lone block (`OverlapPlan.lone`).
// Topology is decided in minutes, so it never moves with the hour height or
// the field's width; only the column count does.
//
// Ported subset (design §5.3): the depth, the band (`left`, `right`), the
// pane margins, the rail and bead, `z`, `widthFraction`, the content band and
// the two grip lanes. The web's hover, wash, glass, pockets, branch ticks,
// bead punch-out and start-tie are not ported: the phone draws none of them.
// Nor are `maxCols` or a lane `root` (the phone has no grouping lanes), so
// every caller is the TS's "no root" path.
//
// The constants are lib/schedule-constants.ts's (ScheduleMetrics) and
// lib/schedule-overlap.ts's own tuning (`OverlapTuning`). A block's entry is
// components/views/day-schedule.tsx `toOverlapEntries` (`OverlapEntry(_:)`).
// Keep in step: a change there without the same change here is drift, and
// two blocks sit differently on the phone than on the web. Checked against
// the web by OverlapFixtureTests (tests/fixtures/day/overlap.json), which
// lib/schedule-overlap.ts's `planOverlaps` writes; every number is compared
// exactly, so keep the TS's arithmetic order.
//
// Ties sort by the id STRING, as the web's `<` does: the node order, and a
// double booking's tile order (tile 0 is the smallest id), never the grid's
// drawing order. `UUID.uuidString` is uppercase where the web's ids are
// lowercase, which sorts hex identically.

/// The overlap pass's own tuning, from lib/schedule-overlap.ts (the geometry
/// it shares with the pane is in `ScheduleMetrics`).
public enum OverlapTuning {
    /// `MIN_HOST_FREE_MIN`, `MIN_HOST_FREE_FRAC`: a container must keep a
    /// stretch of its own time free of the child, at least this many minutes
    /// or this share of its length, whichever is more, or it is not one.
    public static let minHostFreeMin: Double = 30
    public static let minHostFreeFrac: Double = 0.15
    /// `IDENTICAL_TOL`: starts and ends within this many minutes of each other
    /// are a double booking; anything looser is a crossing.
    public static let identicalTol: Double = 2
    /// `NOMINAL_FIELD`: the field width the title-band pass tests horizontal
    /// overlap at, Day and Week.
    public static let nominalFieldDay: Double = 800
    public static let nominalFieldWeek: Double = 140
}

/// lib/schedule-overlap.ts `LayoutOptions.variant`.
public enum OverlapVariant: String, Sendable, Hashable, CaseIterable {
    case day, week
}

/// lib/schedule-overlap.ts `OverlapEntry`: one block, as the pass reads it.
public struct OverlapEntry: Sendable, Hashable {
    public var id: UUID
    /// Minutes after midnight.
    public var startMin: Int
    /// Minutes.
    public var duration: Int
    /// The project of the block a task sits in, or nil. Every task in a
    /// project block carries the project's time and length, so they are one
    /// conflict unit and tile. An empty name is no block, as on the web.
    public var projectBlock: String?

    public init(id: UUID, startMin: Int, duration: Int, projectBlock: String? = nil) {
        self.id = id
        self.startMin = startMin
        self.duration = duration
        self.projectBlock = projectBlock
    }

    /// day-schedule.tsx `toOverlapEntries` for one drawn block: its id, the
    /// time and length it is drawn at, and its raw project name when it sits
    /// in a project block (whatever the item's type, as the web reads it).
    public init(item: Item, startMin: Int, duration: Int) {
        self.init(id: item.id, startMin: startMin, duration: duration,
                  projectBlock: item.inProjectBlock == true ? item.project : nil)
    }

    /// `init(item:startMin:duration:)` for a `deriveTimedEntries` entry.
    public init(_ entry: TimedEntry) {
        self.init(item: entry.item, startMin: entry.startMin, duration: entry.duration)
    }
}

/// day-schedule.tsx `toOverlapEntries`: a day's timed entries as the pass's
/// input, in the grid's order (which is the pass's paint order).
public func overlapEntries(_ entries: [TimedEntry]) -> [OverlapEntry] {
    entries.map { OverlapEntry($0) }
}

/// lib/schedule-overlap.ts `BandLength`: `pct` percent of the box it resolves
/// against, plus `px` points.
public struct BandLength: Codable, Sendable, Hashable {
    public var pct: Double
    public var px: Double

    public init(pct: Double, px: Double) {
        self.pct = pct
        self.px = px
    }

    /// The length in a box `width` wide: `pct / 100 × width + px`.
    public func resolve(in width: Double) -> Double {
        (pct / 100) * width + px
    }
}

/// lib/schedule-overlap.ts `OverlapPlan`, the ported subset: where one
/// overlapping block goes.
public struct OverlapPlan: Sendable, Hashable {
    /// 0 at the root, 1 nested in a container, 2 nested twice. On Week, the
    /// shingle's step.
    public var depth: Int
    /// The block's band, as insets from the field's left and right edges
    /// (resolved against the field's width).
    public var left: BandLength
    public var right: BandLength
    /// The pane's margins inside the band, from its left and right edges
    /// (resolved against the band's width). Only a tile sets a percentage.
    public var paneLeft: BandLength
    public var paneRight: BandLength
    /// The rail's and the bead's left edges, from the band's left (resolved
    /// against the band's width).
    public var railX: BandLength
    public var beadX: BandLength
    /// Paint order: 2, then 2 more for each level of nesting or cascade.
    /// Equal z paints in the grid's order.
    public var z: Int
    /// The pane's share of the field's width.
    public var widthFraction: Double
    /// The content's band, pane-relative, when something paints over part of
    /// the pane; nil centres the content in the whole pane.
    public var contentTop: Double?
    public var contentHeight: Double?
    /// A child flush with this block's start (or end): its top (or bottom)
    /// grip moves into the block's own lane (PR 9).
    public var handleTopLane: Bool
    public var handleBottomLane: Bool

    public init(depth: Int, left: BandLength, right: BandLength, paneLeft: BandLength, paneRight: BandLength,
                railX: BandLength, beadX: BandLength, z: Int, widthFraction: Double,
                contentTop: Double?, contentHeight: Double?, handleTopLane: Bool, handleBottomLane: Bool) {
        self.depth = depth
        self.left = left
        self.right = right
        self.paneLeft = paneLeft
        self.paneRight = paneRight
        self.railX = railX
        self.beadX = beadX
        self.z = z
        self.widthFraction = widthFraction
        self.contentTop = contentTop
        self.contentHeight = contentHeight
        self.handleTopLane = handleTopLane
        self.handleBottomLane = handleBottomLane
    }

    /// A block the pass did not lay out: the whole field less the 4pt right
    /// inset, a 12pt lane, the rail at 5 and the bead at 3, z 2, content in the
    /// whole pane. What the web draws with no layout (`left-0 right-1`), and
    /// lib/schedule-overlap.ts's `soloPlan(0, 0)`.
    public static let lone = OverlapPlan(
        depth: 0,
        left: BandLength(pct: 0, px: 0),
        right: BandLength(pct: 0, px: 4),
        paneLeft: BandLength(pct: 0, px: ScheduleMetrics.lanePx),
        paneRight: BandLength(pct: 0, px: 0),
        railX: BandLength(pct: 0, px: 5),
        beadX: BandLength(pct: 0, px: 3),
        z: 2,
        widthFraction: 1,
        contentTop: nil,
        contentHeight: nil,
        handleTopLane: false,
        handleBottomLane: false
    )
}

/// lib/schedule-overlap.ts `OverlapPlans`: a plan for each block the pass laid
/// out, in the order the TS's Map holds them. A block with no plan is not
/// laid out; `plan(for:)` answers `.lone` for it.
public struct OverlapPlans: Sendable, Hashable {
    /// The laid-out ids, in the TS's insertion order.
    public private(set) var ids: [UUID] = []
    private var byId: [UUID: OverlapPlan] = [:]

    public init() {}

    public subscript(id: UUID) -> OverlapPlan? { byId[id] }

    /// The block's plan, or `.lone` when the pass left it alone.
    public func plan(for id: UUID) -> OverlapPlan { byId[id] ?? .lone }

    public var count: Int { ids.count }
    public var isEmpty: Bool { ids.isEmpty }

    /// `Map.set`: a new id goes last, a known one keeps its place.
    mutating func set(_ id: UUID, _ plan: OverlapPlan) {
        if byId.updateValue(plan, forKey: id) == nil { ids.append(id) }
    }
}

/// lib/schedule-overlap.ts `pickContentBand`'s answer: where a pane's content
/// goes, pane-relative.
public struct ContentBand: Sendable, Hashable {
    public var top: Double
    public var height: Double

    public init(top: Double, height: Double) {
        self.top = top
        self.height = height
    }
}

/// lib/schedule-overlap.ts `pickContentBand`: take the covered spans out of
/// a pane `paneHeight` tall and choose where its content goes. A threshold,
/// not a maximum: the topmost free band that clears `bandComfort`, else the
/// topmost that clears `lineH`, else nil (centre in the whole pane). A band
/// that is the whole pane is nil too.
public func pickContentBand(paneHeight: Double, covers: [(top: Double, bottom: Double)]) -> ContentBand? {
    var free: [(top: Double, bottom: Double)] = [(top: 0, bottom: paneHeight)]
    for c in covers {
        var next: [(top: Double, bottom: Double)] = []
        for f in free {
            if c.bottom <= f.top || c.top >= f.bottom {
                next.append(f)
                continue
            }
            if c.top > f.top { next.append((top: f.top, bottom: min(c.top, f.bottom))) }
            if c.bottom < f.bottom { next.append((top: max(c.bottom, f.top), bottom: f.bottom)) }
        }
        free = next
    }
    if free.isEmpty { return nil }
    let comfortable = free.first { $0.bottom - $0.top >= ScheduleMetrics.bandComfort }
    guard let usable = comfortable ?? free.first(where: { $0.bottom - $0.top >= ScheduleMetrics.lineH }) else {
        return nil
    }
    if usable.top == 0 && usable.bottom >= paneHeight { return nil }
    return ContentBand(top: usable.top, height: usable.bottom - usable.top)
}

/// lib/schedule-overlap.ts `planOverlaps`: where each overlapping block goes,
/// for `entries` in the grid's drawing order. Pass `fieldWidth` (the grid
/// right of the gutter, in points) on Day, so crossing blocks take only as
/// many columns as clear `minChannelPx`; Week passes none and never caps.
public func planOverlaps(
    _ entries: [OverlapEntry],
    hourPx: Double = ScheduleMetrics.hourPx,
    gridStartMin: Int = 0,
    variant: OverlapVariant = .day,
    fieldWidth: Double? = nil
) -> OverlapPlans {
    // A lone entry on the open field is already where it belongs.
    guard entries.count >= 2 else { return OverlapPlans() }
    var pass = OverlapPass(entries: entries, hourPx: hourPx, gridStartMin: Double(gridStartMin),
                           isWeek: variant == .week, fieldWidth: fieldWidth)
    return pass.run()
}

/// Where a block draws on a field `fieldWidth` wide, its plan resolved: the
/// band against the field, then the pane margins, rail and bead against the
/// band, as the web's CSS resolves them.
public struct BlockFrame: Sendable, Hashable {
    /// The band, from the field's left edge.
    public var bandX: Double
    public var bandWidth: Double
    /// The pane, from the field's left edge.
    public var paneX: Double
    public var paneWidth: Double
    /// The pane, from the grid's top (`PaneRect`).
    public var paneTop: Double
    public var paneHeight: Double
    /// The rail's left edge (`railWidth` wide) and the bead's (`beadSize`
    /// across), from the field's left edge.
    public var railX: Double
    public var beadX: Double
    /// The block's true start from the grid's top (the rail's top and the
    /// bead's centre) and its length in points (the rail's height).
    public var startY: Double
    public var spanHeight: Double
    /// The content's band, from the pane's top: the plan's when something
    /// covers part of the pane, else the whole pane.
    public var contentTop: Double
    public var contentHeight: Double
    /// The content band holds a second line (`paneTallH` or taller), so the
    /// block adds its range. The web's `tall`.
    public var isTall: Bool
    /// The plan's paint order.
    public var z: Int

    public init(bandX: Double, bandWidth: Double, paneX: Double, paneWidth: Double, paneTop: Double,
                paneHeight: Double, railX: Double, beadX: Double, startY: Double, spanHeight: Double,
                contentTop: Double, contentHeight: Double, isTall: Bool, z: Int) {
        self.bandX = bandX
        self.bandWidth = bandWidth
        self.paneX = paneX
        self.paneWidth = paneWidth
        self.paneTop = paneTop
        self.paneHeight = paneHeight
        self.railX = railX
        self.beadX = beadX
        self.startY = startY
        self.spanHeight = spanHeight
        self.contentTop = contentTop
        self.contentHeight = contentHeight
        self.isTall = isTall
        self.z = z
    }
}

/// A block of `duration` minutes from `startMin`, drawn with `plan` (`.lone`
/// when the pass left it alone) on a field `fieldWidth` wide. Day-schedule's
/// geometry: the band from the field's edges, the pane inside the band by its
/// margins, the rail and bead from the band's left; the pane's height is
/// `paneRect`'s. A width that would come out negative (a field narrower than
/// its insets) is 0.
public func blockFrame(startMin: Int, duration: Int, plan: OverlapPlan = .lone, fieldWidth: Double,
                       hourPx: Double = ScheduleMetrics.hourPx, gridStartMin: Int = 0) -> BlockFrame {
    let rect = paneRect(startMin: startMin, duration: duration, hourPx: hourPx, gridStartMin: gridStartMin)
    let bandX = plan.left.resolve(in: fieldWidth)
    let bandWidth = max(0, fieldWidth - bandX - plan.right.resolve(in: fieldWidth))
    let paneLeft = plan.paneLeft.resolve(in: bandWidth)
    let paneWidth = max(0, bandWidth - paneLeft - plan.paneRight.resolve(in: bandWidth))
    let contentHeight = plan.contentHeight ?? rect.height
    return BlockFrame(
        bandX: bandX,
        bandWidth: bandWidth,
        paneX: bandX + paneLeft,
        paneWidth: paneWidth,
        paneTop: rect.top,
        paneHeight: rect.height,
        railX: bandX + plan.railX.resolve(in: bandWidth),
        beadX: bandX + plan.beadX.resolve(in: bandWidth),
        startY: rect.startY,
        spanHeight: rect.spanHeight,
        contentTop: plan.contentHeight != nil ? (plan.contentTop ?? 0) : 0,
        contentHeight: contentHeight,
        isTall: contentHeight >= ScheduleMetrics.paneTallH,
        z: plan.z
    )
}

// MARK: - The pass

/// A band's four insets, as the pass computes them.
private struct Band {
    var leftPct: Double
    var leftPx: Double
    var rightPct: Double
    var rightPx: Double
}

/// A conflict unit's key: a project block's name, or the first member's id.
private enum UnitKey: Hashable {
    case project(String)
    case item(UUID)
}

private struct Node {
    let entry: OverlapEntry
    /// The id as the web compares it.
    let key: String
    /// True extent, minutes.
    let s: Double
    let t: Double
    /// Painted extent, minutes.
    let ps: Double
    let pt: Double
    var unit: UnitKey?
    var parent: Int?
    var children: [Int] = []
    /// Index in the caller's array: the grid's drawing order.
    let dom: Int
}

private struct Placed {
    let node: Int
    let band: Band
    let paneTop: Double
    let paneHeight: Double
    let paintedTop: Double
    let paintedBottom: Double
    /// Everything but the content band, which the occlusion pass decides.
    let plan: OverlapPlan
}

/// lib/schedule-overlap.ts `paintedMinutes`: a floored pane covers at least
/// `(paneMinH + paneTrim) / hourPx` hours of grid.
private func paintedMinutes(_ duration: Double, _ hourPx: Double) -> Double {
    max(duration, ((ScheduleMetrics.paneMinH + ScheduleMetrics.paneTrim) / hourPx) * 60)
}

private func contains(_ p: Node, _ c: Node) -> Bool {
    p.s <= c.s && c.t <= p.t && (p.s < c.s || c.t < p.t)
}

private func identical(_ a: Node, _ b: Node) -> Bool {
    abs(a.s - b.s) <= OverlapTuning.identicalTol && abs(a.t - b.t) <= OverlapTuning.identicalTol
}

private func hasProjectBlock(_ e: OverlapEntry) -> Bool {
    !(e.projectBlock ?? "").isEmpty
}

private func overlapsHorizontally(_ a: Band, _ b: Band, _ w: Double) -> Bool {
    let al = (a.leftPct / 100) * w + a.leftPx
    let ar = w - ((a.rightPct / 100) * w + a.rightPx)
    let bl = (b.leftPct / 100) * w + b.leftPx
    let br = w - ((b.rightPct / 100) * w + b.rightPx)
    return al < br - 0.01 && bl < ar - 0.01
}

/// The pass's state: the nodes in its own order, and what it has placed.
private struct OverlapPass {
    var nodes: [Node]
    var placed: [Placed] = []
    var unitSize: [UnitKey: Int] = [:]
    let hourPx: Double
    let gridStartMin: Double
    let isWeek: Bool
    let fieldWidth: Double?

    init(entries: [OverlapEntry], hourPx: Double, gridStartMin: Double, isWeek: Bool, fieldWidth: Double?) {
        self.hourPx = hourPx
        self.gridStartMin = gridStartMin
        self.isWeek = isWeek
        self.fieldWidth = fieldWidth
        nodes = entries.enumerated().map { i, e in
            let s = Double(e.startMin)
            return Node(entry: e, key: e.id.uuidString, s: s, t: s + Double(e.duration), ps: s,
                        pt: s + paintedMinutes(Double(e.duration), hourPx), unit: nil, parent: nil, dom: i)
        }
    }

    mutating func run() -> OverlapPlans {
        // Duration descending puts a container before its contents; the id
        // makes it total.
        nodes.sort { a, b in
            if a.s != b.s { return a.s < b.s }
            let da = a.t - a.s
            let db = b.t - b.s
            if da != db { return da > db }
            return a.key < b.key
        }

        // Conflict units: a project block's members group by project, every
        // other block by identity of extent.
        for i in nodes.indices where nodes[i].unit == nil {
            let n = nodes[i]
            if hasProjectBlock(n.entry) {
                let key = UnitKey.project(n.entry.projectBlock ?? "")
                for j in nodes.indices where nodes[j].unit == nil && nodes[j].entry.projectBlock == n.entry.projectBlock {
                    nodes[j].unit = key
                }
                continue
            }
            let key = UnitKey.item(n.entry.id)
            for j in nodes.indices
            where nodes[j].unit == nil && !hasProjectBlock(nodes[j].entry) && identical(nodes[j], n) {
                nodes[j].unit = key
            }
        }
        for n in nodes { unitSize[unit(of: n), default: 0] += 1 }

        // Clusters, on painted extents.
        var clusters: [[Int]] = []
        var run: [Int] = []
        var runEnd = -Double.infinity
        for i in nodes.indices {
            if !run.isEmpty && nodes[i].ps >= runEnd {
                clusters.append(run)
                run = []
                runEnd = -Double.infinity
            }
            run.append(i)
            runEnd = max(runEnd, nodes[i].pt)
        }
        if !run.isEmpty { clusters.append(run) }

        for cluster in clusters where cluster.count >= 2 {
            if isWeek {
                // Week shingles: right-flush, stepped, z ascending; a double
                // booking tiles.
                for (i, group) in unitGroups(cluster).enumerated() {
                    let step = min(i, 2)
                    placeUnit(group, Band(leftPct: 0, leftPx: Double(step) * ScheduleMetrics.shinglePx,
                                          rightPct: 0, rightPx: 4),
                              depth: step, cascade: 0)
                }
                continue
            }

            // The containment forest, gated in minutes.
            for c in cluster {
                var host: Int?
                for p in cluster {
                    if p == c || nodes[p].unit == nodes[c].unit { continue }
                    // A member of a real double booking may not host.
                    if (unitSize[unit(of: nodes[p])] ?? 1) > 1 { continue }
                    if !contains(nodes[p], nodes[c]) { continue }
                    // Hosting must leave the parent a readable band of its own.
                    let span = nodes[p].t - nodes[p].s
                    let largestFree = max(nodes[c].s - nodes[p].s, nodes[p].t - nodes[c].t)
                    if largestFree < max(OverlapTuning.minHostFreeMin, span * OverlapTuning.minHostFreeFrac) { continue }
                    // The innermost eligible host wins.
                    if let h = host, !(span < nodes[h].t - nodes[h].s) { continue }
                    host = p
                }
                nodes[c].parent = host
            }

            // Depth by chain walk; past maxDepthDay a child is demoted to its
            // host's level.
            for c in cluster {
                var d = 0
                var cur = nodes[c].parent
                while let x = cur {
                    d += 1
                    cur = nodes[x].parent
                }
                while d > ScheduleMetrics.maxDepthDay, let par = nodes[c].parent {
                    nodes[c].parent = nodes[par].parent
                    d -= 1
                }
            }
            for c in cluster {
                if let p = nodes[c].parent { nodes[p].children.append(c) }
            }

            placeSiblings(cluster.filter { nodes[$0].parent == nil },
                          Band(leftPct: 0, leftPx: 0, rightPct: 0, rightPx: 4), depth: 0)
        }

        // Occlusion, then title bands: a block's coverers are everything that
        // paints above it and lands on it, tested on the coverer's painted
        // extent.
        let nominal = isWeek ? OverlapTuning.nominalFieldWeek : OverlapTuning.nominalFieldDay
        var out = OverlapPlans()
        for (pi, p) in placed.enumerated() {
            let rank = paintRank(p)
            let paneBottom = p.paneTop + p.paneHeight
            var covers: [(top: Double, bottom: Double)] = []
            for (qi, q) in placed.enumerated()
            where qi != pi && paintRank(q) > rank && overlapsHorizontally(p.band, q.band, nominal)
                && q.paintedTop < paneBottom && p.paneTop < q.paintedBottom {
                covers.append((top: q.paintedTop - p.paneTop, bottom: q.paintedBottom - p.paneTop))
            }
            let chosen = pickContentBand(paneHeight: p.paneHeight, covers: covers)
            var plan = p.plan
            plan.contentTop = chosen?.top
            plan.contentHeight = chosen?.height
            out.set(nodes[p.node].entry.id, plan)
        }
        return out
    }

    private func unit(of n: Node) -> UnitKey {
        n.unit ?? .item(n.entry.id)
    }

    /// Paint order as one integer: z, then the grid's drawing order.
    private func paintRank(_ p: Placed) -> Int {
        p.plan.z * 4096 + nodes[p.node].dom
    }

    /// `members` grouped into conflict units in first-seen order (a Map's),
    /// then stably sorted by their earliest painted start.
    private func unitGroups(_ members: [Int]) -> [[Int]] {
        var order: [UnitKey] = []
        var groups: [UnitKey: [Int]] = [:]
        for i in members {
            let u = unit(of: nodes[i])
            if groups[u] == nil { order.append(u) }
            groups[u, default: []].append(i)
        }
        let starts = order.map { u in groups[u, default: []].map { nodes[$0].ps }.min() ?? 0 }
        return order.indices
            .sorted { a, b in starts[a] != starts[b] ? starts[a] < starts[b] : a < b }
            .map { groups[order[$0], default: []] }
    }

    /// How many channels fit in `availPx` at `minChannelPx`. With no field
    /// width, as many as wanted (Week).
    private func channelsThatFit(_ availPx: Double, _ wanted: Int) -> Int {
        guard fieldWidth != nil, availPx.isFinite, availPx > 0 else { return wanted }
        return max(1, min(wanted, Int((availPx / ScheduleMetrics.minChannelPx).rounded(.down))))
    }

    /// A conflict unit shares one band; its panes tile and each keeps its own
    /// lane. Its members' children nest in its band, inset `nestPx` left and
    /// `nestRightPx` right.
    private mutating func placeUnit(_ unit: [Int], _ b: Band, depth: Int, cascade: Int) {
        let n = unit.count
        let ordered = unit.sorted { nodes[$0].key < nodes[$1].key }
        let widthFraction = ((100 - b.leftPct - b.rightPct) / 100) / Double(n)

        for (k, idx) in ordered.enumerated() {
            let node = nodes[idx]
            let rect = paneRect(startMin: node.s, minutes: node.t - node.s, gridStartMin: gridStartMin, hourPx: hourPx)
            let painted = paneRect(startMin: node.s, minutes: paintedMinutes(node.t - node.s, hourPx),
                                   gridStartMin: gridStartMin, hourPx: hourPx)
            let fL = Double(k) / Double(n)
            let fR = Double(n - 1 - k) / Double(n)
            let flushTop = node.children.contains { abs(nodes[$0].s - node.s) < 1 }
            let flushBottom = node.children.contains { abs(nodes[$0].t - node.t) < 1 }

            placed.append(Placed(
                node: idx,
                band: b,
                paneTop: rect.top,
                paneHeight: rect.height,
                paintedTop: painted.top,
                paintedBottom: painted.top + painted.height,
                plan: OverlapPlan(
                    depth: depth,
                    left: BandLength(pct: b.leftPct, px: b.leftPx),
                    right: BandLength(pct: b.rightPct, px: b.rightPx),
                    paneLeft: BandLength(pct: fL * 100, px: ScheduleMetrics.lanePx),
                    paneRight: BandLength(pct: fR * 100, px: 0),
                    railX: BandLength(pct: fL * 100, px: 5),
                    beadX: BandLength(pct: fL * 100, px: 3),
                    z: 2 + (depth + cascade) * 2,
                    widthFraction: widthFraction,
                    contentTop: nil,
                    contentHeight: nil,
                    handleTopLane: flushTop,
                    handleBottomLane: flushBottom
                )
            ))

            if !node.children.isEmpty {
                placeSiblings(node.children,
                              Band(leftPct: b.leftPct, leftPx: b.leftPx + ScheduleMetrics.nestPx,
                                   rightPct: b.rightPct, rightPx: b.rightPx + ScheduleMetrics.nestRightPx),
                              depth: depth + 1)
            }
        }
    }

    /// Siblings in `area`: conflict units into greedy first-fit columns on
    /// painted extents, as many as the area carries at `minChannelPx`, the
    /// overflow into the inset cascade inside the last column.
    private mutating func placeSiblings(_ sibs: [Int], _ area: Band, depth: Int) {
        guard !sibs.isEmpty else { return }
        let groups = unitGroups(sibs)

        var colEnds: [Double] = []
        var colOf: [Int] = []
        for g in groups {
            let gs = g.map { nodes[$0].ps }.min() ?? 0
            let gt = g.map { nodes[$0].pt }.max() ?? 0
            if let c = colEnds.firstIndex(where: { $0 <= gs }) {
                colEnds[c] = max(colEnds[c], gt)
                colOf.append(c)
            } else {
                colOf.append(colEnds.count)
                colEnds.append(gt)
            }
        }

        // The channels this AREA can carry, not the whole field's.
        let availPx: Double
        if let fieldWidth {
            availPx = (fieldWidth * (100 - area.leftPct - area.rightPct)) / 100 - area.leftPx - area.rightPx
        } else {
            availPx = .nan
        }
        let cols = channelsThatFit(availPx, colEnds.count)

        for (gi, g) in groups.enumerated() {
            let rawCol = colOf[gi]
            let col = min(rawCol, cols - 1)
            let cascade = max(0, rawCol - col)
            let span = 100 - area.leftPct - area.rightPct
            let w = span / Double(cols)
            placeUnit(
                g,
                Band(
                    leftPct: area.leftPct + Double(col) * w,
                    leftPx: area.leftPx + (col > 0 ? ScheduleMetrics.colGap : 0) + Double(cascade) * ScheduleMetrics.nestPx,
                    rightPct: area.rightPct + Double(cols - 1 - col) * w,
                    rightPx: area.rightPx
                ),
                depth: depth,
                cascade: cascade
            )
        }
    }
}
