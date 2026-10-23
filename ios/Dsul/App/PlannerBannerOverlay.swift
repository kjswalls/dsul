import SwiftUI

/// The planner's banner ("Signed in as …", a write that didn't save) over the
/// top of a tab for a few seconds: Today's, and Organize's, so a refused write
/// shows its sentence on either stack. Applied as `.plannerBanner()` to the
/// stack's root view. Not while an item's sheet is up: the sheet draws the
/// banner itself (ItemDetail), and at its medium detent this copy would show
/// too.
struct PlannerBannerOverlay: ViewModifier {
    @Environment(SamplePlanner.self) private var planner

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let banner = planner.banner, !planner.isShowingItemSheet {
                    // As tall as the screen, so the move (which travels the
                    // view's own height) carries the banner off the top,
                    // never parking it in the bar's band, which draws no
                    // background. The spacer draws nothing and takes no taps.
                    VStack(spacing: 0) {
                        BannerView(banner: banner) {
                            planner.dismissBanner(banner.id)
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 4)
                        Spacer(minLength: 0)
                    }
                    // A move alone: an opacity transition would fade the
                    // lime check through the banner's own opacity.
                    .transition(.move(edge: .top))
                }
            }
            .animation(.snappy, value: planner.banner)
    }
}

extension View {
    /// The planner's banner over this view (`PlannerBannerOverlay`).
    func plannerBanner() -> some View {
        modifier(PlannerBannerOverlay())
    }
}

/// The planner's banner: it goes by itself after a few seconds
/// (`SamplePlanner.show`, which also has VoiceOver say it), and a tap
/// dismisses it sooner. Over Today and Organize (`PlannerBannerOverlay`), or
/// over an item's sheet while one is up, which would otherwise hide a write
/// the server refused.
struct BannerView: View {
    var banner: PlannerBanner
    var onDismiss: () -> Void

    var body: some View {
        Button(action: onDismiss) {
            HStack(spacing: 8) {
                Image(systemName: banner.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(banner.isError ? Color.orange : Color.accentColor)
                Text(banner.text)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.primary)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        // Not `.plain`, whose press fades the lime tick.
        .buttonStyle(PressScaleStyle(scale: 0.97))
        .accessibilityHint("Dismisses the message")
    }
}
