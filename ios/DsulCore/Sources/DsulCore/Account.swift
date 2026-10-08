import Foundation

// Delete account (memory/plans/account-deletion.md). Ports of:
// - lib/account-types.ts: what GET /api/app/account says (`AccountFacts`,
//   `parseAccountFacts`), what POST /api/app/account/delete answers
//   (`AccountDeleted`, `parseAccountDeleted`) and what it takes (the strict
//   body, `ACCOUNT_CONFIRM_WORD`);
// - lib/account-copy.ts: the words the sheet and the sign-in screen say
//   (`ACCOUNT_COPY`) and the rules that pick them (`confirms`, `joinNames`,
//   `accountLine`, `consequenceLines`, `doneMessage`).
// Keep in step: a change there without the same change here is drift, and the
// phone says something the web no longer does, or can't read what the route
// sends. Checked against the web by AccountTests: the routes' real answers
// (tests/fixtures/app/account-facts.json and account-deleted.json, which
// tests/unit/account-routes.test.ts writes) and every phone word and every
// rule's table (tests/fixtures/app/account-copy.json, which
// tests/unit/account-copy.test.ts writes), byte for byte.
//
// Reading is lenient, as `parseAccountFacts` is, with one difference: the web
// refuses a `userId` that isn't a UUID, the phone only one that is missing or
// blank. Either way nothing is deleted without the right one, since the phone
// sends it back as `account` and the route deletes nothing unless it is the
// verified caller's own id. And one rule is the phone's alone: a Sign in with
// Apple code the route's schema would refuse is left out of the body
// (`AccountDeleteBody`), since Apple must never block a deletion.
//
// The web has words of its own that the phone never shows: `appleManualWeb`
// and `appleLeftWeb` (the web never revokes Sign in with Apple, so its Apple
// lines also name account.apple.com) and its Done button's. They are not here.

/// GET /api/app/account (lib/account-types.ts `AccountFacts`). Decoding throws
/// only when `userId` is missing or blank (nothing can be deleted without it).
/// Everything else is lenient: a missing or wrong key reads as none, a blank
/// email or provider is nil, an unknown key service is dropped.
public struct AccountFacts: Decodable, Sendable, Equatable {
    /// The verified caller's id; the delete body sends it back as `account`.
    public var userId: String
    /// Nil when the account has none. A Hide My Email address is kept as it is.
    public var email: String?
    /// The provider ids of the account's Apple identities (the credential's
    /// `user`). Empty strings are dropped.
    public var appleIds: [String]
    /// The server can revoke Sign in with Apple (its Apple setup is in place).
    public var appleRevocable: Bool
    /// The `beeminder` extension is on.
    public var beeminder: Bool
    /// The account has a stakes ledger (any `stake_events` row).
    public var ledger: Bool
    /// OpenClaw has an agent key or a gateway token.
    public var openclaw: Bool
    /// The services whose keys dsul held, never a key: "Beeminder", "Twilio",
    /// "Home Assistant", "OpenClaw" only, in that order.
    public var keyServices: [String]
    /// The model connection's provider ("OpenAI"), or a custom connection's host.
    public var modelProviderName: String?

    public init(userId: String, email: String? = nil, appleIds: [String] = [], appleRevocable: Bool = false,
                beeminder: Bool = false, ledger: Bool = false, openclaw: Bool = false,
                keyServices: [String] = [], modelProviderName: String? = nil) {
        self.userId = userId
        self.email = email
        self.appleIds = appleIds
        self.appleRevocable = appleRevocable
        self.beeminder = beeminder
        self.ledger = ledger
        self.openclaw = openclaw
        self.keyServices = keyServices
        self.modelProviderName = modelProviderName
    }

    /// lib/account-types.ts `KEY_SERVICES`.
    private static let knownKeyServices = ["Beeminder", "Twilio", "Home Assistant", "OpenClaw"]

    private enum CodingKeys: String, CodingKey {
        case userId, email, appleIds, appleRevocable, beeminder, ledger, openclaw, keyServices, modelProviderName
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let userId = try c.decode(String.self, forKey: .userId)
        guard !jsTrim(userId).isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .userId, in: c, debugDescription: "blank userId")
        }
        self.userId = userId
        // `try?` flattens: each read is nil for a missing key, a null and a
        // value of the wrong type alike.
        self.email = nonBlank(try? c.decodeIfPresent(String.self, forKey: .email))
        self.appleIds = AccountFacts.strings(c, .appleIds).filter { !$0.isEmpty }
        self.appleRevocable = (try? c.decodeIfPresent(Bool.self, forKey: .appleRevocable)) ?? false
        self.beeminder = (try? c.decodeIfPresent(Bool.self, forKey: .beeminder)) ?? false
        self.ledger = (try? c.decodeIfPresent(Bool.self, forKey: .ledger)) ?? false
        self.openclaw = (try? c.decodeIfPresent(Bool.self, forKey: .openclaw)) ?? false
        // `KEY_SERVICES.filter((s) => listed.includes(s))`: the known names
        // only, once each, in the known order whatever order they came in.
        let listed = AccountFacts.strings(c, .keyServices)
        self.keyServices = AccountFacts.knownKeyServices.filter { listed.contains($0) }
        self.modelProviderName = nonBlank(try? c.decodeIfPresent(String.self, forKey: .modelProviderName))
    }

    /// The elements of a list that are strings; none when the key is missing,
    /// null or not a list.
    private static func strings(_ c: KeyedDecodingContainer<CodingKeys>, _ key: CodingKeys) -> [String] {
        let list = (try? c.decodeIfPresent([StringOrNothing].self, forKey: key)) ?? []
        return list.compactMap { $0.value }
    }
}

/// One element of a list: its string, or nothing when it is anything else.
/// Never fails, so one odd element can't cost the list.
private struct StringOrNothing: Decodable {
    let value: String?

    init(from decoder: Decoder) throws {
        value = try? decoder.singleValueContainer().decode(String.self)
    }
}

/// lib/account-types.ts `nonBlank`: present and not blank as JavaScript trims,
/// kept as it came.
private func nonBlank(_ value: String?) -> String? {
    guard let value, !jsTrim(value).isEmpty else { return nil }
    return value
}

/// What the delete did about Sign in with Apple (lib/account-types.ts
/// `AppleRevocation`). `none`: the account had no Apple id. `unknown`: an
/// earlier call had already deleted the account, so this one can't say, and
/// what an unknown string decodes as. Where an `AppleRevocation?` is in play,
/// spell `.none` out as `AppleRevocation.none`, or it reads as Optional's.
public enum AppleRevocation: String, Sendable, Equatable, Decodable {
    case revoked
    case notRevoked = "not_revoked"
    case none
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try? decoder.singleValueContainer().decode(String.self)
        self = raw.flatMap { AppleRevocation(rawValue: $0) } ?? .unknown
    }
}

/// The 200 of POST /api/app/account/delete (lib/account-types.ts
/// `parseAccountDeleted`). Any 200 is a deletion; an unreadable `apple` is
/// `.unknown`.
public struct AccountDeleted: Decodable, Sendable, Equatable {
    public var apple: AppleRevocation

    public init(apple: AppleRevocation) {
        self.apple = apple
    }

    private enum CodingKeys: String, CodingKey {
        case apple
    }

    public init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else {
            apple = .unknown
            return
        }
        apple = (try? c.decodeIfPresent(AppleRevocation.self, forKey: .apple)) ?? .unknown
    }

    /// Any 200's body, read leniently: never throws. A body that isn't JSON,
    /// or isn't an object, is a deletion that can't say what became of Apple.
    public static func read(_ data: Data) -> AccountDeleted {
        return (try? JSONDecoder().decode(AccountDeleted.self, from: data)) ?? AccountDeleted(apple: .unknown)
    }
}

/// POST /api/app/account/delete's body: `{"account":"…","confirm":"DELETE"}`,
/// with `"appleCode"` only when there is one (never null, never empty). The
/// word is always the constant, whatever was typed.
///
/// A code goes only when the route's strict schema takes it (1 to 1024
/// visible ASCII characters, `/^[\x21-\x7E]{1,1024}$/`); any other is left
/// out, as no code at all is. Sent, it would be a 400 on every try, and Apple
/// must never block a deletion: without the code the account is still
/// deleted, and the sign-in screen says Apple may still list dsul.
public struct AccountDeleteBody: Encodable, Sendable, Equatable {
    /// The `userId` the facts gave when the sheet opened: a guard, never a
    /// target. The route deletes nothing unless it is the caller's own id.
    public var account: String
    public var appleCode: String?

    public init(account: String, appleCode: String?) {
        self.account = account
        self.appleCode = AccountDeleteBody.sendable(appleCode)
    }

    private enum CodingKeys: String, CodingKey {
        case account, appleCode, confirm
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(account, forKey: .account)
        if let code = AccountDeleteBody.sendable(appleCode) {
            try c.encode(code, forKey: .appleCode)
        }
        try c.encode(AccountDeletion.confirmWord, forKey: .confirm)
    }

    /// The code when the route's schema takes it, else nil.
    private static func sendable(_ code: String?) -> String? {
        guard let code, !code.isEmpty, code.utf8.count <= 1024,
              code.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7E })
        else { return nil }
        return code
    }
}

/// The routes, the word, and lib/account-copy.ts `ACCOUNT_COPY`'s phone words
/// with the rules that pick them. Straight apostrophes, as the web's, so one
/// fixture compares both.
public enum AccountDeletion {
    public static let factsPath = "/api/app/account"
    public static let deletePath = "/api/app/account/delete"
    /// `ACCOUNT_CONFIRM_WORD`.
    public static let confirmWord = "DELETE"

    /// `confirms`: what was typed, trimmed as JavaScript trims, in any case, is
    /// the word. What is typed is never sent.
    public static func confirms(_ typed: String) -> Bool {
        return jsTrim(typed).uppercased() == confirmWord
    }

    /// `joinNames`: "A"; "A and B"; "A, B and C" (no Oxford comma). Empty for none.
    public static func joinNames(_ names: [String]) -> String {
        guard names.count > 1, let last = names.last else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " and " + last
    }

    /// `accountLine`: the account named by its email, under the title. Nil for
    /// nil or blank; a Hide My Email address shows as it is.
    public static func accountLine(_ email: String?) -> String? {
        guard let email = nonBlank(email) else { return nil }
        return "This deletes the account for \(email)."
    }

    /// The sheet's heading (`title`).
    public static let title = "Delete your dsul account?"
    /// Under the account line: what goes, and that it can't come back.
    public static let lead = "Deleting it removes everything in it from every device, right away: "
        + "your items, habits, projects, routines, seasons, goals, recipes, settings and saved conversations. "
        + "None of it goes to the Trash, and this cannot be undone."

    // What dsul can't delete for the person, one line for each that applies
    // (`consequences`).

    /// The `beeminder` extension is on.
    public static let beeminderLine = "Beeminder stops getting your ticks from dsul. A goal that needs them "
        + "can derail and charge you, so change or archive those goals in Beeminder first."
    /// The account has a stakes ledger. For Pledge it is the only record of
    /// what a miss cost. It names the address, not a Settings path: the
    /// Settings row hides while Settle the day is off, and /ledger is always
    /// there (lib/account-copy.ts).
    public static let ledgerLine = "Your stakes ledger is deleted too, so note anything you owe first. "
        + "It's at do.dsul.app/ledger."
    /// OpenClaw has an agent key or a gateway token.
    public static let openclawLine = "OpenClaw loses access to dsul, but keeps anything it already remembers."

    /// Keys dsul held for other services (`keys`), named by `joinNames`.
    public static func keysLine(_ services: [String]) -> String {
        return "Keys you gave dsul for \(joinNames(services)) stay active there until you revoke them."
    }

    /// A connected model key (`modelKey`): Disconnect's words, so the two
    /// surfaces say the same thing about a key dsul no longer holds.
    public static func modelKeyLine(_ name: String) -> String {
        return "dsul deletes the key you connected, but it stays active with \(name) until you revoke it there."
    }

    /// Apple's own steps for removing an app (support.apple.com/en-us/102571):
    /// the button is Delete now.
    private static let appleSteps = "open Settings, tap your name, then Sign in with Apple, pick dsul and tap Delete."

    /// This iPhone will run Apple's sheet before the delete (`appleStep`).
    public static let appleStepLine = "Apple will ask you to continue, so that dsul is also removed from Sign in with Apple."
    /// The account has an Apple id, and this iPhone can't run the Apple step
    /// (`appleManual`).
    public static let appleManualLine = "dsul can't remove itself from Sign in with Apple here. Afterwards, " + appleSteps

    /// The facts couldn't load, or the delete couldn't reach the server.
    public static let unreachableMessage = "Couldn't reach dsul. Check your connection and try again."
    /// The server answered, and nothing was deleted.
    public static let failedMessage = "Couldn't delete your account. Nothing was deleted. Try again."
    /// A 409: the session is another account's now.
    public static let changedMessage = "You're signed in to a different account now, so nothing was deleted. "
        + "Close this and open it again."
    /// The sign-in screen, once the account is gone (`deleted`).
    public static let deletedMessage = "Your dsul account is deleted."
    /// The same, when Apple may still list dsul (`appleLeft`).
    public static let appleLeftMessage = deletedMessage + " Apple may still list dsul under Sign in with Apple: " + appleSteps

    /// The confirm section's header, and the field's title for VoiceOver.
    public static let confirmLabel = "Type \(confirmWord) to confirm"
    public static let deleteLabel = "Delete account"
    public static let deletingLabel = "Deleting\u{2026}"

    /// `consequenceLines(facts, { appleStep, web: false })`: Beeminder, the
    /// ledger, OpenClaw, the keys, the model key, then Sign in with Apple:
    /// the step line when this iPhone will run Apple's sheet, else the manual
    /// line when the account has an Apple id.
    public static func consequences(_ facts: AccountFacts, appleStep: Bool) -> [String] {
        var lines: [String] = []
        if facts.beeminder { lines.append(beeminderLine) }
        if facts.ledger { lines.append(ledgerLine) }
        if facts.openclaw { lines.append(openclawLine) }
        if !facts.keyServices.isEmpty { lines.append(keysLine(facts.keyServices)) }
        if let name = nonBlank(facts.modelProviderName) { lines.append(modelKeyLine(name)) }
        if appleStep {
            lines.append(appleStepLine)
        } else if !facts.appleIds.isEmpty {
            lines.append(appleManualLine)
        }
        return lines
    }

    /// `doneMessage(apple, hadApple)`: the line once the account is gone.
    /// `notRevoked` says Apple may still list dsul; `unknown` (a retried call
    /// whose first answer was lost) says so only for an account that had an
    /// Apple id, since nobody can tell whether the first call revoked it;
    /// `revoked` and `none` are the plain line.
    public static func doneMessage(apple: AppleRevocation, hadApple: Bool) -> String {
        switch apple {
        case .notRevoked:
            return appleLeftMessage
        case .unknown:
            return hadApple ? appleLeftMessage : deletedMessage
        case .revoked, .none:
            return deletedMessage
        }
    }
}
