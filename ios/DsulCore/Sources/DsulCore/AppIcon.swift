import Foundation

// Port of lib/app-icons.ts: the App icon pick (Settings → Look on the web,
// user_settings.app_icon, migration 056). One pick for every device, not per
// mode. The web swaps the browser tab and the desktop app's Dock or taskbar
// icon; the phone swaps its home-screen icon to an alternate icon set.
//
// The web's tab ALSO turns Lime for the rest of a day whose items are all done
// (lib/day-done.ts). The phone does not: iOS shows an alert every time an app
// changes its icon, and only lets it happen while the app is in front, so an
// icon that changed by itself at the end of a day would interrupt the user to
// say so. The phone follows the explicit pick alone.

/// `APP_ICONS` in lib/app-icons.ts. Keep the cases in step with it.
public enum AppIcon: String, Sendable, Hashable, CaseIterable {
    case aurora
    case lime

    /// `DEFAULT_APP_ICON`, and what an unknown slug reads as.
    public static let `default`: AppIcon = .aurora

    /// The web's rule for the stored slug: nil stays nil (never chosen on any
    /// device), and an unknown slug is Aurora (migration 056's comment).
    public init?(stored slug: String?) {
        guard let slug else { return nil }
        self = AppIcon(rawValue: slug) ?? .default
    }

    /// The alternate icon set in ios/Dsul/Resources/Assets.xcassets, named in
    /// ios/project.yml's ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES. Nil is
    /// the primary icon (AppIcon, Aurora).
    public var alternateIconName: String? {
        switch self {
        case .aurora: return nil
        case .lime: return "AppIcon-Lime"
        }
    }

    /// What the home-screen icon should become, given the pick and the
    /// alternate icon in use now (`UIApplication.alternateIconName`): nil when
    /// it should stay as it is. A nil pick never changes the icon, the web's
    /// "never chosen leaves the device's own pick" rule.
    public static func change(to pick: AppIcon?, from current: String?) -> IconChange? {
        guard let pick, pick.alternateIconName != current else { return nil }
        return IconChange(alternateIconName: pick.alternateIconName)
    }
}

/// A change to make with `setAlternateIconName`. Its own type so that "set
/// the primary icon" (a nil name) can't be mistaken for "leave it".
public struct IconChange: Sendable, Hashable {
    public var alternateIconName: String?

    public init(alternateIconName: String?) {
        self.alternateIconName = alternateIconName
    }
}
