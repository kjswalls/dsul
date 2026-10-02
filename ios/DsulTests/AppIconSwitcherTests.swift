import DsulCore
import Foundation
import Testing
@testable import Dsul

/// Stands in for UIApplication: records each change, and can refuse or hold
/// one to check what the switcher does meanwhile.
@MainActor
private final class FakeIconHost: AlternateIconHost {
    var supportsAlternateIcons = true
    var alternateIconName: String?
    private(set) var requests: [String?] = []
    /// Throws instead of changing, as iOS does in the background.
    var refuse = false
    /// While true, a change in flight waits (`isWaiting`) before landing.
    var holding = false
    private(set) var isWaiting = false

    func setAlternateIconName(_ name: String?) async throws {
        requests.append(name)
        var waited = 0
        while holding && waited < 1000 {
            isWaiting = true
            try? await Task.sleep(for: .milliseconds(5))
            waited += 1
        }
        isWaiting = false
        if refuse { throw CocoaError(.featureUnsupported) }
        alternateIconName = name
    }
}

@MainActor
@Suite struct AppIconSwitcherTests {
    @Test func anUnchosenPickLeavesTheIconAlone() async {
        let host = FakeIconHost()
        host.alternateIconName = "AppIcon-Lime"
        let switcher = AppIconSwitcher(host: host)
        switcher.follow(nil)
        await switcher.settle()
        #expect(host.requests.isEmpty)
        #expect(host.alternateIconName == "AppIcon-Lime")
    }

    @Test func limeSwapsInTheAlternateOnce() async {
        let host = FakeIconHost()
        let switcher = AppIconSwitcher(host: host)
        switcher.follow(.lime)
        await switcher.settle()
        #expect(host.requests == ["AppIcon-Lime"])
        // Every later fetch carries the same pick; iOS's alert must not repeat.
        switcher.follow(.lime)
        await switcher.settle()
        #expect(host.requests == ["AppIcon-Lime"])
    }

    @Test func auroraGoesBackToThePrimaryIcon() async {
        let host = FakeIconHost()
        host.alternateIconName = "AppIcon-Lime"
        let switcher = AppIconSwitcher(host: host)
        switcher.follow(.aurora)
        await switcher.settle()
        #expect(host.requests == [nil])
        #expect(host.alternateIconName == nil)
    }

    @Test func auroraOnThePrimaryIconAsksNothing() async {
        let host = FakeIconHost()
        let switcher = AppIconSwitcher(host: host)
        switcher.follow(.aurora)
        await switcher.settle()
        #expect(host.requests.isEmpty)
    }

    @Test func aDeviceWithoutAlternateIconsIsNeverAsked() async {
        let host = FakeIconHost()
        host.supportsAlternateIcons = false
        let switcher = AppIconSwitcher(host: host)
        switcher.follow(.lime)
        await switcher.settle()
        #expect(host.requests.isEmpty)
    }

    @Test func aRefusedChangeIsTriedAgainOnTheNextFollow() async {
        let host = FakeIconHost()
        host.refuse = true
        let switcher = AppIconSwitcher(host: host)
        switcher.follow(.lime)
        await switcher.settle()
        #expect(host.requests == ["AppIcon-Lime"])
        #expect(host.alternateIconName == nil)

        // Back in front (AppGate's scenePhase hook follows the pick again).
        host.refuse = false
        switcher.follow(.lime)
        await switcher.settle()
        #expect(host.requests == ["AppIcon-Lime", "AppIcon-Lime"])
        #expect(host.alternateIconName == "AppIcon-Lime")
    }

    @Test func picksThatArriveMidChangeWaitAndOnlyTheLastIsMade() async {
        let host = FakeIconHost()
        host.holding = true
        let switcher = AppIconSwitcher(host: host)
        switcher.follow(.lime)
        // Let the first change start and wait.
        #expect(await waitUntil { host.isWaiting })
        switcher.follow(.aurora)
        switcher.follow(.lime)
        switcher.follow(.aurora)
        // Nothing new is asked while the first change is out.
        #expect(host.requests == ["AppIcon-Lime"])
        host.holding = false
        await switcher.settle()
        // Lime landed, then the last pick (Aurora) put the primary back; the
        // two in between were never sent.
        #expect(host.requests == ["AppIcon-Lime", nil])
        #expect(host.alternateIconName == nil)
    }

    @Test func aPickThatMatchesWhatLandedMidChangeAsksNothingMore() async {
        let host = FakeIconHost()
        host.holding = true
        let switcher = AppIconSwitcher(host: host)
        switcher.follow(.lime)
        #expect(await waitUntil { host.isWaiting })
        switcher.follow(.lime)
        host.holding = false
        await switcher.settle()
        #expect(host.requests == ["AppIcon-Lime"])
    }
}
