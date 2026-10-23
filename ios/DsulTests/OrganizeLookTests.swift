#if canImport(UIKit)
import DsulCore
import Testing
import UIKit
@testable import Dsul

/// Every SF Symbol a container's tile can draw exists on this iOS: each
/// glyph DsulCore maps a Lucide name to (`ContainerLook.lucideToSymbol`,
/// checked for coverage on Linux by LookFixtureTests, which cannot ask UIKit)
/// and each kind's own fallback. A missing name draws nothing at all, so a
/// tile would be an empty square. Runs on the xcode-27 runner only; the
/// Linux shim never compiles it.
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
}
#endif
