#if canImport(UIKit)
import DsulCore
import SwiftUI
import Testing
import UIKit
@testable import Dsul

/// Every SF Symbol a container's tile can draw exists on this iOS: each
/// glyph DsulCore maps a Lucide name to (`ContainerLook.lucideToSymbol`,
/// checked for coverage on Linux by LookFixtureTests, which cannot ask UIKit)
/// and each kind's own fallback; and every symbol a page's chips and rows
/// draw. A missing name draws nothing at all, so a tile would be an empty
/// square. Runs on the xcode-27 runner only; the Linux shim never compiles
/// it.
@MainActor
@Suite struct OrganizeLookTests {
    @Test func everyMappedSymbolExists() {
        let missing = ContainerLook.lucideToSymbol
            .filter { UIImage(systemName: $0.value) == nil }
            .map { "\($0.key) → \($0.value)" }
            .sorted()
        #expect(missing.isEmpty, "No SF Symbol for: \(missing.joined(separator: ", "))")
    }

    @Test func everyKindsFallbackExists() {
        for kind in OrganizeKind.allCases {
            #expect(UIImage(systemName: kind.fallbackSymbol) != nil, "\(kind.rawValue): \(kind.fallbackSymbol)")
        }
    }

    /// The sample's tiles: what Organize draws without signing in.
    @Test func theSamplesTilesDrawASymbol() {
        let planner = SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
        guard case .list(let sections, _, _) = planner.organize else {
            Issue.record("The sample is loaded")
            return
        }
        for row in sections.flatMap(\.rows) {
            #expect(UIImage(systemName: row.symbol) != nil, "\(row.title): \(row.symbol)")
        }
    }

    /// The pages' symbols (O2, O3): every Status a chip can show, the other
    /// chips, and the marks a row draws (a skip, a reached milestone).
    @Test func everyPageSymbolExists() {
        let planner = SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
        var symbols = ["clock", "calendar", "list.bullet", "play.circle", "pause.circle", "forward.end",
                       "checkmark.circle.fill", "flame.fill"]
        symbols += ["active", "paused", "auto"].map(ContainerPageModel.seasonStatusSymbol)
        symbols += ["active", "achieved", "abandoned"].map(ContainerPageModel.goalStatusSymbol)
        if case .page(let page)? = planner.routinePage("sample-morning-routine") {
            symbols += page.chips.map(\.systemImage) + [page.header.symbol]
        }
        if case .page(let page)? = planner.seasonPage("sample-autumn") {
            symbols += page.chips.map(\.systemImage) + [page.header.symbol]
        }
        if case .page(let page)? = planner.goalPage("sample-half-marathon") {
            symbols += page.chips.map(\.systemImage) + [page.header.symbol]
        }
        if case .page(let page)? = planner.projectPage("sample-work") {
            symbols += page.chips.map(\.systemImage) + [page.header.symbol]
        }
        for symbol in Set(symbols).sorted() {
            #expect(UIImage(systemName: symbol) != nil, "\(symbol)")
        }
    }

    /// O15: a project's dot keeps its own value in each appearance on the way
    /// to a menu row, which draws it as a `UIColor` on a tinted image
    /// (PropertyMenus.swift `projectDot`), as on the chip, which fills a
    /// `Circle` with the `Color`. So the chip and its row under it are one
    /// colour in light and in dark mode: the sample's Home is Teal, its two
    /// values from look.json.
    @Test func aProjectDotIsItsTokenInEachAppearance() {
        let planner = SamplePlanner(todayString: "2026-10-01", now: { PlannerJSON.noon })
        let home = planner.projectAccent(for: "Home")
        #expect(home.token == "var(--accent-2)")
        let menuRow = UIColor(home.color)
        for (style, want) in [(UIUserInterfaceStyle.light, home.light), (UIUserInterfaceStyle.dark, home.dark)] {
            let resolved = menuRow.resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            let read = resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            #expect(read, "\(style.rawValue) reads as RGB")
            #expect(abs(Double(red) - want.red) < 0.002, "\(style.rawValue) red")
            #expect(abs(Double(green) - want.green) < 0.002, "\(style.rawValue) green")
            #expect(abs(Double(blue) - want.blue) < 0.002, "\(style.rawValue) blue")
            #expect(alpha == 1)
        }
        #expect(home.light != home.dark)
    }
}
#endif
