import SwiftUI

/// The avatar circle at the top right of Today and Organize: the account (the
/// email, Sign out and Delete account…), or on the sample a way back to the
/// sign-in screen, then whatever sections the tab adds (`extra`: Today's drag
/// spike switches; Organize adds none). Delete account… opens its sheet
/// through the planner's one sheet slot, so it shows over the braindump sheet
/// too; the sample has no account to delete.
struct AvatarMenu<Extra: View>: View {
    private let extra: Extra

    @Environment(SamplePlanner.self) private var planner
    @Environment(AuthStore.self) private var auth

    init(@ViewBuilder extra: () -> Extra) {
        self.extra = extra()
    }

    var body: some View {
        Menu {
            if planner.isLive {
                Section(auth.email ?? "Signed in") {
                    Button(role: .destructive) {
                        let store = auth
                        Task { await store.signOut() }
                    } label: {
                        Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                    Button(role: .destructive) {
                        planner.activeSheet = .deleteAccount
                    } label: {
                        Label("Delete account\u{2026}", systemImage: "person.crop.circle.badge.xmark")
                    }
                }
            } else {
                Section("Sample data") {
                    Button("Leave sample data", systemImage: "rectangle.portrait.and.arrow.right") {
                        auth.leaveSample()
                    }
                }
            }
            extra
        } label: {
            Text(planner.isLive ? AccountFormat.initials(auth.email) : "KI")
                .font(.caption.weight(.semibold))
                .frame(width: 30, height: 30)
                .background(Circle().fill(Color(.tertiarySystemFill)))
        }
        // A toolbar menu takes the app's accent; the initials are text, so
        // they take the label colour (lime is a mark, never text).
        .tint(Color.primary)
        .accessibilityLabel("Account")
    }
}

extension AvatarMenu where Extra == EmptyView {
    /// The account alone, with no sections of the tab's own.
    init() {
        self.init { EmptyView() }
    }
}

enum AccountFormat {
    /// "KF" for kirby.fox@…, "KI" for kirby@…: the first letters of the first
    /// two words of the address's local part, or its first two letters.
    static func initials(_ email: String?) -> String {
        guard let email, let local = email.split(separator: "@").first else { return "?" }
        let words = local.split(whereSeparator: { !$0.isLetter })
        let letters: [Character]
        if words.count >= 2 {
            letters = words.prefix(2).compactMap { $0.first }
        } else {
            letters = Array(local.filter { $0.isLetter }.prefix(2))
        }
        let text = String(letters).uppercased()
        return text.isEmpty ? "?" : text
    }
}
