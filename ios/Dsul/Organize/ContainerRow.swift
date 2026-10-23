import DsulCore
import SwiftUI

/// One container on the Organize list (design §6.2): its tile, its name in
/// `.body`, the subtitle under it in `.subheadline` `.secondary`, and a
/// trailing value when it has one. Hue goes on the tile alone, never on text.
/// Every line wraps, so the largest text sizes never cut a count off.
///
/// The row draws; what a tap does is its caller's. On the list, a routine's
/// "Held by" and a season's routines it pushes the container's page
/// (`ContainerLinkRow`, with the chevron and the hint "Opens the routine").
/// To VoiceOver it is one element, read from the model's `spokenLabel`
/// ("Morning routine, routine, 7:00 am, 3 items, 2 of 3 done today").
struct ContainerRow: View {
    var row: OrganizeRow

    var body: some View {
        TileRow(symbol: row.symbol, color: row.accent.color, title: row.title, subtitle: row.subtitle,
                trailing: row.trailing, spokenLabel: row.spokenLabel)
    }
}

/// The row a container draws, for anything else that wears a tile: the
/// footer's Item types, Paused and Trash, and a custom type on Item types.
/// The tile, the title in `.body`, the line under it in `.subheadline`
/// `.secondary`, and the trailing value; one element to VoiceOver.
struct TileRow: View {
    var symbol: String
    var color: Color
    var title: String
    var subtitle: String? = nil
    var trailing: String? = nil
    var spokenLabel: String

    var body: some View {
        HStack(spacing: 13) {
            ContainerTile(symbol: symbol, color: color)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body)
                    .foregroundStyle(Color.primary)
                    .multilineTextAlignment(.leading)
                if let subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(Color.secondary)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let trailing {
                Text(trailing)
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(Color.secondary)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(spokenLabel))
    }
}

/// A container's tile: a rounded square washed with its accent, and its glyph
/// at full strength on it. 30pt with a 17pt glyph at the default text size on
/// a row, 44pt in a page's header, the corner and the glyph in proportion,
/// all scaling with Dynamic Type. Decorative: the row says what it is. The
/// footer's Paused and Trash pass a gray (`init(symbol:color:side:)`), the
/// console rail's muted identity.
struct ContainerTile: View {
    var symbol: String
    var color: Color

    @ScaledMetric private var side: CGFloat
    @ScaledMetric private var radius: CGFloat
    @ScaledMetric private var glyph: CGFloat

    init(symbol: String, accent: ContainerAccent, side: CGFloat = 30) {
        self.init(symbol: symbol, color: accent.color, side: side)
    }

    init(symbol: String, color: Color, side: CGFloat = 30) {
        self.symbol = symbol
        self.color = color
        _side = ScaledMetric(wrappedValue: side, relativeTo: .body)
        _radius = ScaledMetric(wrappedValue: side * 0.3, relativeTo: .body)
        _glyph = ScaledMetric(wrappedValue: side * 17 / 30, relativeTo: .body)
    }

    var body: some View {
        // The wash is the fill's own 18%, a mix with the row under it. The
        // glyph is drawn over the fill, never inside anything faded, so a lime
        // glyph (accent-8) stays full-strength lime.
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(color.opacity(0.18))
            .frame(width: side, height: side)
            .overlay {
                Image(systemName: symbol)
                    .font(.system(size: glyph, weight: .medium))
                    .foregroundStyle(color)
            }
            .accessibilityHidden(true)
    }
}
