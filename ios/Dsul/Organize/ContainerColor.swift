import DsulCore
import SwiftUI
import UIKit

// The SwiftUI side of a container's colour. DsulCore is Foundation only, so it
// hands over sRGB components per theme (ContainerLook.swift `containerAccent`
// and `projectAccent`, app/globals.css' `:root` and `.dark` values); this
// turns them into one `Color` that follows light and dark mode. Kept off the
// shim's file list: its SwiftUI stub has no `Color`.
//
// Where the colour goes (design §6.6): on Organize, the tile's fill, at 18% on
// the tile alone, and the full-strength glyph on it; on Today and in the item
// sheet (O15, `SamplePlanner.projectAccent`), a project's dot, full strength:
// its List section, filter chip and Week caption, the sheet's project chip and
// each project menu row. Only ever a mark: never text, and never inside
// anything faded, a press included: accent-8 is lime.

extension ContainerAccent {
    /// The accent in the current appearance: its light value, or its dark one
    /// in dark mode. A raw `#rrggbb` is the same in both.
    var color: Color {
        let light = self.light
        let dark = self.dark
        return Color(uiColor: UIColor { traits in
            let value = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat(value.red), green: CGFloat(value.green), blue: CGFloat(value.blue),
                           alpha: 1)
        })
    }
}
