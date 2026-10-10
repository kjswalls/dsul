import Accessibility
import AuthenticationServices
import DsulCore
import SwiftUI

/// Signed out: Google, Apple, an emailed link, or the sample day (board H).
///
/// Google opens in `ASWebAuthenticationSession` (SwiftUI's
/// `webAuthenticationSession`), ephemeral, so no Safari cookie signs in a
/// different account behind the user's back. GoTrue sends the sheet to
/// https://do.dsul.app/auth/ios, which 302s the code to
/// `app.dsul.ios://auth/callback`, and the session catches its own scheme.
///
/// Apple is Apple's own `SignInWithAppleButton`, under Google's and as tall,
/// with no browser and no redirect: its sheet hands back an identity token,
/// which AuthStore sends to GoTrue's id_token grant with the attempt's nonce.
/// AppleAuthorization turns the framework's types into AuthStore's; it, this
/// view and DeleteAccountSheet (Apple's sheet again, for a code the server
/// revokes with) are the only app files that import AuthenticationServices
/// (memory/plans/ios-app.md, "Sign in with Apple").
///
/// The emailed link comes back through the same page from Mail, Safari or
/// another app's browser, so the app registers the scheme (project.yml) and
/// DsulApp hands it to `AuthStore.handleOpenURL`. After a send this screen says
/// "Check your email" until the link signs in or the user starts over.
///
/// VoiceOver hears the message line (`AuthStore.message`) when the screen
/// appears with one and whenever a new one arrives: a deletion's done line,
/// the signed-out line, a failed sign-in. The screen swap that brings most of
/// them moves VoiceOver to "dsul" and never reads the line, and Apple asks
/// that a deletion say it is done.
struct SignInView: View {
    @Environment(AuthStore.self) private var auth
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @Environment(\.colorScheme) private var colorScheme
    @State private var showsEmailField = false
    @State private var email = ""
    @FocusState private var emailFocused: Bool
    /// The Google button's height, which Apple's takes (50 is the email
    /// field's, until the first measure).
    @State private var providerButtonHeight: CGFloat = 50
    /// The appearance an Apple attempt began in, held until it ends.
    @State private var appleAttemptScheme: ColorScheme? = nil

    private var isSigningIn: Bool { auth.state == .signingIn }
    private var isBusy: Bool { isSigningIn || auth.isSendingEmail }
    /// "Signing in…" on the Google button for every sign-in but Apple's,
    /// whose line shows above the buttons instead.
    private var googleSaysSigningIn: Bool { isSigningIn && !auth.isSigningInWithApple }
    /// What the Apple button is drawn for: black on light, white on dark (HIG).
    /// The held appearance counts only while the attempt runs, so the button
    /// follows again the moment it ends, even if SwiftUI never saw the flag go
    /// up (a failure back before the next render).
    private var appleScheme: ColorScheme {
        auth.isSigningInWithApple ? appleAttemptScheme ?? colorScheme : colorScheme
    }

    // Scrolls only when the screen doesn't fit (the largest title size, or the
    // keyboard over the email form on a small phone). Otherwise the Spacers
    // fill the height and nothing bounces.
    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                screen
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .onChange(of: auth.isSigningInWithApple) { _, signingIn in
            if !signingIn { appleAttemptScheme = nil }
        }
        .onChange(of: auth.message, initial: true) { _, message in
            if let message { announceSettled(message) }
        }
    }

    /// Says `message` to VoiceOver once the screen has settled: said at once,
    /// the focus move that comes with the screen (or the sheet closing over
    /// it) would cut it off. Not said if a newer line has replaced it by then.
    private func announceSettled(_ message: String) {
        let store = auth
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(600))
            guard store.message == message else { return }
            AccessibilityNotification.Announcement(AttributedString(message)).post()
        }
    }

    private var screen: some View {
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
                } else if auth.isSigningInWithApple {
                    // Apple's button can't change its title, so this says it.
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                        Text("Signing in\u{2026}")
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityElement(children: .combine)
                }
                if let address = auth.emailSent {
                    checkYourEmail(address)
                } else {
                    googleButton
                    appleButton
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
            // Apple's title is 43% of its button's height and can't follow
            // Dynamic Type, so this stack stops growing here and the button
            // titles keep to one line, no taller than Apple's. The title
            // above keeps scaling.
            .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
    }

    private var googleButton: some View {
        Button(action: signInWithGoogle) {
            HStack(spacing: 8) {
                if googleSaysSigningIn {
                    ProgressView()
                }
                Text(googleSaysSigningIn ? "Signing in\u{2026}" : "Continue with Google")
                    .fontWeight(.semibold)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .controlSize(.large)
        .disabled(isBusy)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { providerButtonHeight = $0 }
    }

    /// Apple's own button, so its title ("Continue with Apple", the web's
    /// words), logo and VoiceOver label are Apple's. `.id` rebuilds it when the
    /// appearance changes, since the UIKit control under it may not redraw for
    /// a style alone. From a tap until the attempt ends the id holds still: a
    /// rebuild drops the object Apple's controller reports back to, and the
    /// attempt would never end. `.allowsHitTesting` backs `.disabled`, which
    /// nothing says the control honours: a tap that got through would open
    /// Apple's sheet even when AuthStore refused the attempt.
    private var appleButton: some View {
        SignInWithAppleButton(.continue) { request in
            let hashedNonce = auth.beginAppleSignIn()
            if hashedNonce != nil { appleAttemptScheme = colorScheme }
            AppleAuthorization.configure(request, hashedNonce: hashedNonce)
        } onCompletion: { result in
            // ASAuthorization isn't Sendable, so it is read before the Task.
            let outcome = AppleAuthorization.outcome(result)
            let store = auth
            Task {
                await store.finishAppleSignIn(outcome)
            }
        }
        .signInWithAppleButtonStyle(appleScheme == .dark ? .white : .black)
        .id(appleScheme)
        .frame(maxWidth: .infinity)
        .frame(height: max(providerButtonHeight, 44))
        .clipShape(.capsule)
        .disabled(isBusy)
        .allowsHitTesting(!isBusy)
    }

    private var emailButton: some View {
        Button {
            showsEmailField = true
        } label: {
            Label("Email me a sign-in link", systemImage: "envelope")
                .fontWeight(.semibold)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
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
