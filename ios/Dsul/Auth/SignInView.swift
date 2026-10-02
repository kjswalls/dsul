import AuthenticationServices
import DsulCore
import SwiftUI

/// Signed out: Google, or the sample day.
///
/// Google opens in `ASWebAuthenticationSession` (SwiftUI's
/// `webAuthenticationSession`), ephemeral, so no Safari cookie signs in a
/// different account behind the user's back. GoTrue sends the sheet to
/// https://do.dsul.app/auth/ios, which 302s the code to
/// `app.dsul.ios://auth/callback`; the session catches its own scheme, so the
/// app registers no URL type. Closing the sheet is a silent cancel.
struct SignInView: View {
    @Environment(AuthStore.self) private var auth
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession

    private var isSigningIn: Bool { auth.state == .signingIn }

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
                Button(action: signIn) {
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
                .disabled(isSigningIn)

                Button("Try with sample data") {
                    auth.enterSample()
                }
                .disabled(isSigningIn)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
    }

    private func signIn() {
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
