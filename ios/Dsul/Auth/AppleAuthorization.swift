import AuthenticationServices
import DsulCore
import Foundation

/// AuthenticationServices' half of Sign in with Apple, so AuthStore and its
/// tests need none of the framework's types: what Apple's request asks for,
/// what the button's result comes to, and what Apple says about an Apple ID;
/// and for Delete account, the request for a fresh code and what it comes to.
/// With SignInView and DeleteAccountSheet, the only app files that import
/// AuthenticationServices. It imports no SwiftUI, so `ASAuthorizationResult`
/// (AuthenticationServices' SwiftUI overlay) is the sheet's to unwrap.
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

/// What Apple's sheet came to, for Delete account.
enum AppleDeletionOutcome: Sendable, Equatable {
    /// Apple's one-time code, for the server to exchange for the tokens it
    /// revokes once the account is deleted.
    case code(String)
    /// ASAuthorizationError.canceled: nothing is sent, and the sheet stays.
    case cancelled
    /// Any other error, or a credential without a usable code: the account is
    /// deleted without one, and the sign-in screen says Apple may still list
    /// dsul.
    case failed
}

extension AppleAuthorization {
    /// Apple's request before a deletion (memory/plans/account-deletion.md):
    /// no scopes, since nothing is read from it, and `user` set to the Apple
    /// ID AuthStore found this phone can authorize, as Apple advises for a
    /// known user (`ASAuthorizationAppleIDRequest.user`). No nonce: the code
    /// goes to dsul's server, never to GoTrue.
    static func deletionRequest(user: String) -> ASAuthorizationAppleIDRequest {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = []
        request.user = user
        return request
    }

    /// The credential's `authorizationCode`, good once and for five minutes,
    /// which Apple hands over as UTF-8 `Data`: `.code` when it reads as UTF-8
    /// and isn't empty, else `.failed`. The sheet takes the credential out of
    /// `ASAuthorizationResult.appleID` itself.
    static func deletionOutcome(credential: ASAuthorizationAppleIDCredential) -> AppleDeletionOutcome {
        guard let data = credential.authorizationCode,
              let code = String(data: data, encoding: .utf8), !code.isEmpty
        else { return .failed }
        return .code(code)
    }

    /// `ASAuthorizationError.canceled` is `.cancelled`, as for sign-in;
    /// anything else is `.failed`.
    static func deletionOutcome(error: any Error) -> AppleDeletionOutcome {
        if (error as? ASAuthorizationError)?.code == .canceled { return .cancelled }
        return .failed
    }
}
