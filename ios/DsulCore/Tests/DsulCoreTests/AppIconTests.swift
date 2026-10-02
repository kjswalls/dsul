import Foundation
import Testing
import DsulCore

// AppIcon.swift: the web's reading of user_settings.app_icon (lib/app-icons.ts,
// migration 056), and when the home-screen icon changes.

@Suite struct AppIconTests {
    @Test func theCasesAreTheWebCatalog() {
        // lib/app-icons.ts APP_ICONS, in order.
        #expect(AppIcon.allCases.map(\.rawValue) == ["aurora", "lime"])
        #expect(AppIcon.default == .aurora)
    }

    @Test func aStoredSlugReadsAsTheWebReadsIt() {
        #expect(AppIcon(stored: nil) == nil)
        #expect(AppIcon(stored: "lime") == .lime)
        #expect(AppIcon(stored: "aurora") == .aurora)
        // An unknown slug degrades to Aurora rather than to "never chosen".
        #expect(AppIcon(stored: "sunset") == .aurora)
        #expect(AppIcon(stored: "") == .aurora)
    }

    @Test func auroraIsThePrimaryIcon() {
        #expect(AppIcon.aurora.alternateIconName == nil)
        #expect(AppIcon.lime.alternateIconName == "AppIcon-Lime")
    }

    @Test func anUnchosenPickNeverChangesTheIcon() {
        #expect(AppIcon.change(to: nil, from: nil) == nil)
        #expect(AppIcon.change(to: nil, from: "AppIcon-Lime") == nil)
    }

    @Test func aPickAlreadyShowingChangesNothing() {
        #expect(AppIcon.change(to: .aurora, from: nil) == nil)
        #expect(AppIcon.change(to: .lime, from: "AppIcon-Lime") == nil)
    }

    @Test func aDifferentPickSetsItsIcon() {
        #expect(AppIcon.change(to: .lime, from: nil) == IconChange(alternateIconName: "AppIcon-Lime"))
        // Back to Aurora is a change to the primary icon, not "leave it".
        #expect(AppIcon.change(to: .aurora, from: "AppIcon-Lime") == IconChange(alternateIconName: nil))
        // An alternate this build no longer ships goes back to the pick.
        #expect(AppIcon.change(to: .aurora, from: "AppIcon-Old") == IconChange(alternateIconName: nil))
    }
}
