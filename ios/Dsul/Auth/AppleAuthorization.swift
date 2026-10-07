import AuthenticationServices
import DsulCore
import Foundation

/// AuthenticationServices' half of Sign in with Apple, so AuthStore and its
/// tests need none of the framework's types: what Apple's request asks for,
/// what the button's result comes to, and what Apple says about an Apple ID.
/// With SignInView, the only app file that imports AuthenticationServices.
enum AppleAuthorization {
    /// Name and email, and the attempt's hashed nonce (nil: an attempt AuthStore
    /// refused; its completion is dropped unless another attempt is live).
    ///
    /// Apple carries the nonce into the identity token, where GoTrue compares
    /// it with the hash of the raw nonce the grant sends (token_oidc.go). The
    /// name comes once, on the first consent; the email is in the token on
    /// every sign-in once it was shared.
    static func configure(_ request: ASAuthorizationAppleIDRequest, hashedNonce: String?) {
        request.requestedScopes = [.fullName, .email]
        request.nonce = hashedNonce
    }

    /// The button's result as AuthStore takes it. Call it inside onCompletion,
    /// before any Task: ASAuthorization isn't Sendable.
    ///
    /// The identity token is a JWT in UTF-8 `Data` (Apple's `identityToken`);
    /// the name halves are there only on a first consent. A cancel is
    /// `ASAuthorizationError.canceled` and silent; every other error, and any
    /// credential that isn't an Apple ID one, is a failure.
    static func outcome(_ result: Result<ASAuthorization, any Error>) -> AppleSignInOutcome {
        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                return .failed
            }
            return .credential(AppleCredential(
                user: credential.user,
                identityToken: credential.identityToken.flatMap { String(data: $0, encoding: .utf8) },
                givenName: credential.fullName?.givenName,
                familyName: credential.fullName?.familyName
            ))
        case .failure(let error):
            if (error as? ASAuthorizationError)?.code == .canceled { return .cancelled }
            return .failed
        }
    }

    /// `ASAuthorizationAppleIDProvider().credentialState(forUserID:)`; a thrown
    /// error or an unknown case is `.unknown`.
    ///
    /// A local call that asks no server ("Verifying a user"). Apple answers
    /// `notFound` once the phone's Apple Account is a different one.
    static func credentialState(forUserID userID: String) async -> AppleIDCredentialState {
        do {
            let state = try await ASAuthorizationAppleIDProvider().credentialState(forUserID: userID)
            switch state {
            case .authorized:
                return .authorized
            case .revoked:
                return .revoked
            case .notFound:
                return .notFound
            case .transferred:
                return .transferred
            @unknown default:
                return .unknown
            }
        } catch {
            return .unknown
        }
    }

    /// `ASAuthorizationAppleIDProvider.credentialRevokedNotification`, so AppGate
    /// needn't import the framework.
    static let revokedNotification: Notification.Name = ASAuthorizationAppleIDProvider.credentialRevokedNotification
}
