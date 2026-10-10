import Accessibility
import AuthenticationServices
import DsulCore
import SwiftUI

/// Delete account (memory/plans/account-deletion.md): the avatar menu's
/// Delete account… on Today, signed in only, through the planner's one sheet
/// slot (`PlannerSheet.deleteAccount`), so it opens over Today, or stacked on
/// the braindump sheet while that is up. Its words and the rules that pick
/// them are DsulCore's `AccountDeletion` (lib/account-copy.ts); the web's
/// twin is components/settings/delete-account-dialog.tsx.
///
/// - **What it says.** The title as a heading, the account by its email (no
///   line when it has none), what goes and that it cannot be undone, then one
///   line for each thing dsul can't delete for the person, from
///   `GET /api/app/account` (`AuthStore.accountFacts`), asked as the sheet
///   opens. A failed ask says it couldn't reach dsul, with Try again. A 410
///   means an earlier delete went through and its answer was lost: AuthStore
///   ends the session, and AppGate drops this sheet.
/// - **The word.** DELETE, in any case, trimmed as JavaScript trims
///   (`AccountDeletion.confirms`); what was typed is never sent. The
///   instruction is the section's header, since a field with a prompt in a
///   Form shows the prompt and no title: the title is VoiceOver's alone.
///   Delete account stays off until the facts are in and the word matches.
/// - **Apple.** When the server can revoke and this phone's Apple Account
///   can authorize one of the account's Apple IDs
///   (`AuthStore.deletionAppleUserId`), the sheet says Apple will ask to
///   continue, and Delete asks Apple through SwiftUI's
///   `authorizationController` (no scopes, `user` set, no nonce) for a code
///   the server exchanges, then revokes once the account is deleted. The
///   credential state is asked again just before: a retry may follow a
///   deletion that already revoked that ID. A cancel sends nothing and the
///   sheet stays; any other failure deletes without a code, since Apple never
///   blocks a deletion. `ASAuthorizationResult` is unwrapped here: it lives in
///   the overlay a file sees only when it imports both AuthenticationServices
///   and SwiftUI, and AppleAuthorization imports no SwiftUI.
/// - **Deleting.** In an unstructured Task, so it outlives the sheet: on a
///   200 AuthStore ends the session, AppGate swaps in the sign-in screen, and
///   SignInView says the done line (and has VoiceOver say it). A failure
///   stays here as the confirm section's footer, said to VoiceOver at high
///   priority, and the field keeps its text. Cancel and a swipe down are off
///   while it runs.
/// - **Lime.** Nothing here is lime: the sheet tints itself in the label
///   colour (Cancel, Try again, the field's caret). Delete account is the
///   system red.
struct DeleteAccountSheet: View {
    @Environment(AuthStore.self) private var auth
    @Environment(\.authorizationController) private var authorizationController
    @Environment(\.dismiss) private var dismiss
    @State private var facts: AccountFacts? = nil
    /// The Apple ID this phone can authorize for the account, as the sheet
    /// opened: it picks the Apple line, and whether Delete asks Apple at all.
    @State private var appleUserId: String? = nil
    @State private var loadFailed = false
    /// Bumped by Try again, which runs the facts ask again (`.task(id:)`).
    @State private var loadAttempt = 0
    @State private var typed = ""
    @State private var isDeleting = false
    /// Why the last Delete didn't delete, under the button.
    @State private var line: String? = nil

    private var canDelete: Bool {
        facts != nil && AccountDeletion.confirms(typed) && !isDeleting
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(AccountDeletion.title)
                            .font(.headline)
                            .accessibilityAddTraits(.isHeader)
                        if let account = AccountDeletion.accountLine(facts?.email) {
                            Text(account)
                        }
                        Text(AccountDeletion.lead)
                    }
                    .padding(.vertical, 4)
                }

                factsSection

                confirmSection
            }
            .navigationTitle("Delete account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .tint(Color.primary)
                        .disabled(isDeleting)
                }
            }
        }
        .tint(Color.primary)
        .interactiveDismissDisabled(isDeleting)
        .task(id: loadAttempt) {
            await load()
        }
    }

    /// While the facts load, the spinner; if they couldn't, the line and Try
    /// again; then each consequence line, none when there are none.
    @ViewBuilder
    private var factsSection: some View {
        if let facts {
            let lines = AccountDeletion.consequences(facts, appleStep: appleUserId != nil)
            if !lines.isEmpty {
                Section {
                    ForEach(lines, id: \.self) { consequence in
                        Text(consequence)
                            .font(.subheadline)
                    }
                }
            }
        } else if loadFailed {
            Section {
                Text(AccountDeletion.unreachableMessage)
                    .foregroundStyle(.secondary)
                Button("Try again") {
                    loadAttempt += 1
                }
            }
        } else {
            Section {
                ProgressView()
                    .frame(maxWidth: .infinity)
            }
        }
    }

    /// The word, then Delete account, and why the last try didn't delete.
    private var confirmSection: some View {
        Section {
            TextField(AccountDeletion.confirmLabel, text: $typed, prompt: Text(AccountDeletion.confirmWord))
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .disabled(isDeleting)
            Button(role: .destructive) {
                Task { @MainActor in
                    await delete()
                }
            } label: {
                HStack(spacing: 8) {
                    if isDeleting {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Text(isDeleting ? AccountDeletion.deletingLabel : AccountDeletion.deleteLabel)
                }
            }
            .disabled(!canDelete)
        } header: {
            // As written, so DELETE reads as the word to type.
            Text(AccountDeletion.confirmLabel)
                .textCase(nil)
        } footer: {
            if let line {
                Text(line)
            }
        }
    }

    /// The facts, then which Apple ID (if any) this phone can authorize for
    /// them, both before either shows, so the Apple line never swaps under
    /// the reader. Nothing is said when the ask was cancelled (the sheet
    /// closed) or the session is over (a 410: the sign-in screen says it).
    private func load() async {
        loadFailed = false
        guard let loaded = await auth.accountFacts() else {
            guard !Task.isCancelled, auth.isSignedIn else { return }
            loadFailed = true
            announce(AccountDeletion.unreachableMessage, isError: true)
            return
        }
        appleUserId = await auth.deletionAppleUserId(for: loaded)
        facts = loaded
    }

    /// Apple first when this phone can run its step, then the delete. On a
    /// 200 or a session already over there is nothing left to do here:
    /// AppGate has moved on.
    private func delete() async {
        guard let facts, AccountDeletion.confirms(typed), !isDeleting else { return }
        isDeleting = true
        line = nil
        var code: String? = nil
        // Asked again: a retry may follow a deletion that already revoked this id.
        if appleUserId != nil, let user = await auth.deletionAppleUserId(for: facts) {
            do {
                let result = try await authorizationController.performRequest(
                    AppleAuthorization.deletionRequest(user: user))
                if case .appleID(let credential) = result,
                   case .code(let c) = AppleAuthorization.deletionOutcome(credential: credential) {
                    code = c
                }
            } catch {
                if AppleAuthorization.deletionOutcome(error: error) == .cancelled {
                    isDeleting = false
                    return
                }
            }
        }
        let store = auth
        switch await store.deleteAccount(account: facts.userId, appleCode: code,
                                         hadApple: !facts.appleIds.isEmpty) {
        case .deleted, .signedOut:
            break
        case .failed(let message):
            line = message
            isDeleting = false
            announce(message, isError: true)
        }
    }

    /// Says `text` to VoiceOver, as `SamplePlanner.show` says a banner: the
    /// line is drawn away from VoiceOver's focus (under the button, or where
    /// the spinner was), so it would otherwise go unheard. An error
    /// interrupts whatever is being said.
    private func announce(_ text: String, isError: Bool) {
        var spoken = AttributedString(text)
        if isError { spoken.accessibilitySpeechAnnouncementPriority = .high }
        AccessibilityNotification.Announcement(spoken).post()
    }
}
