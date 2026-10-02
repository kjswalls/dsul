import AuthenticationServices
import DsulCore
import SwiftUI

/// Signed out: Google, an emailed link, or the sample day (board H).
///
/// Google opens in `ASWebAuthenticationSession` (SwiftUI's
/// `webAuthenticationSession`), ephemeral, so no Safari cookie signs in a
/// different account behind the user's back. GoTrue sends the sheet to
/// https://do.dsul.app/auth/ios, which 302s the code to
/// `app.dsul.ios://auth/callback`, and the session catches its own scheme.
///
/// The emailed link comes back through the same page from Mail, Safari or
/// another app's browser, so the app registers the scheme (project.yml) and
/// DsulApp hands it to `AuthStore.handleOpenURL`. After a send this screen says
/// "Check your email" until the link signs in or the user starts over.
struct SignInView: View {
    @Environment(AuthStore.self) private var auth
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var showsEmailField = false
    @State private var email = ""
    @FocusState private var emailFocused: Bool

    private var isSigningIn: Bool { auth.state == .signingIn }
    private var isBusy: Bool { isSigningIn || auth.isSendingEmail }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 8) {
                Text("dsul")
                    .font(.system(size: 52, weight: .bold, design: .rounded))
                Text("Sign in to see your day.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(spacing: 14) {
                if let message = auth.message {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                if let address = auth.emailSent {
                    checkYourEmail(address)
                } else {
                    googleButton
                    if showsEmailField {
                        emailForm
                    } else {
                        emailButton
                    }
                }
                Button("Try with sample data") {
                    auth.enterSample()
                }
                .disabled(isBusy)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
    }

    private var googleButton: some View {
        Button(action: signInWithGoogle) {
            HStack(spacing: 8) {
                if isSigningIn {
                    ProgressView()
                }
                Text(isSigningIn ? "Signing in\u{2026}" : "Continue with Google")
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(isBusy)
    }

    private var emailButton: some View {
        Button {
            showsEmailField = true
        } label: {
            Label("Email me a sign-in link", systemImage: "envelope")
                .fontWeight(.semibold)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .disabled(isBusy)
    }

    private var emailForm: some View {
        VStack(spacing: 10) {
            TextField("Email address", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.send)
                .focused($emailFocused)
                .onSubmit { send(to: email) }
                .padding(.horizontal, 14)
                .frame(height: 50)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
                .disabled(isBusy)
                .onAppear { emailFocused = true }
            Button {
                send(to: email)
            } label: {
                HStack(spacing: 8) {
                    if auth.isSendingEmail {
                        ProgressView()
                    }
                    Text(auth.isSendingEmail ? "Sending\u{2026}" : "Send link")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(isBusy || email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func checkYourEmail(_ address: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "envelope.badge")
                .font(.system(size: 34))
                .foregroundStyle(.secondary)
            Text("Check your email")
                .font(.title3.weight(.semibold))
            Text("We sent a link to \(address). Open it on this iPhone in the next few minutes.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                send(to: address)
            } label: {
                HStack(spacing: 8) {
                    if isBusy {
                        ProgressView()
                    }
                    Text(isSigningIn ? "Signing in\u{2026}" : auth.isSendingEmail ? "Sending\u{2026}" : "Send again")
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 4)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(isBusy)
            Button("Use a different email") {
                auth.useDifferentEmail()
                email = ""
                showsEmailField = true
            }
            .disabled(isBusy)
        }
    }

    private func send(to address: String) {
        let store = auth
        Task {
            await store.sendEmailLink(to: address)
        }
    }

    private func signInWithGoogle() {
        let store = auth
        let session = webAuthenticationSession
        Task {
            await store.signInWithGoogle { url in
                do {
                    return try await session.authenticate(
                        using: url,
                        callback: .customScheme(GoTrue.callbackScheme),
                        preferredBrowserSession: .ephemeral,
                        additionalHeaderFields: [:]
                    )
                } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
                    throw CancellationError()
                }
            }
        }
    }
}
