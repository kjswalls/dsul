import Foundation
import Testing
import DsulCore

// Delete account, checked against the web (Account.swift). Three fixtures, each
// written by the Vitest side and never edited by hand (UPDATE_FIXTURES=1):
// - tests/fixtures/app/account-facts.json and account-deleted.json, the 200s
//   of GET /api/app/account and POST /api/app/account/delete, which
//   tests/unit/account-routes.test.ts writes from the routes' real output;
// - tests/fixtures/app/account-copy.json, every phone word of
//   lib/account-copy.ts and the answers of its rules (`confirms`, `joinNames`,
//   `consequenceLines` with `web: false`, `doneMessage`), which
//   tests/unit/account-copy.test.ts writes.
// The rest pins the lenient reading and the body on hand-written cases.

private enum FixtureError: Error {
    case notFound(String)
}

/// Walks up from this source file to the repo root (see RecurrenceFixtureTests.swift).
private func fixtureData(_ name: String, _ here: String = #filePath) throws -> Data {
    let relative = "tests/fixtures/app/" + name
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            return try Data(contentsOf: candidate)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw FixtureError.notFound("\(relative) above \(here)")
}

private let user = "6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b"

private func facts(_ json: String) throws -> AccountFacts {
    return try JSONDecoder().decode(AccountFacts.self, from: Data(json.utf8))
}

/// The body as the app's APIClient sends it (sorted keys), as a string.
private func wire(_ body: AccountDeleteBody) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return String(decoding: try encoder.encode(body), as: UTF8.self)
}

/// The body as a JSON object.
private func object(_ body: AccountDeleteBody) throws -> [String: Any] {
    let data = try JSONEncoder().encode(body)
    return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Suite struct AccountWireTests {
    @Test func theFactsFixtureDecodes() throws {
        let read = try JSONDecoder().decode(AccountFacts.self, from: try fixtureData("account-facts.json"))
        #expect(read == AccountFacts(
            userId: user, email: "kirby@example.com", appleIds: ["001234.dsul.0001"], appleRevocable: true,
            beeminder: true, ledger: true, openclaw: false, keyServices: ["Beeminder", "Twilio"],
            modelProviderName: "OpenAI"
        ))
    }

    /// A key the route adds that the phone doesn't read turns this red, so the
    /// port learns of it.
    @Test func theFactsFixtureHoldsOnlyKeysThePhoneReads() throws {
        let raw = try JSONSerialization.jsonObject(with: try fixtureData("account-facts.json"))
        let keys = try #require(raw as? [String: Any]).keys
        #expect(Set(keys) == [
            "userId", "email", "appleIds", "appleRevocable", "beeminder", "ledger", "openclaw", "keyServices",
            "modelProviderName",
        ])
    }

    @Test(arguments: [
        "{}",
        #"{"userId":null}"#,
        #"{"userId":""}"#,
        #"{"userId":" \n "}"#,
        #"{"userId":42}"#,
        #"{"email":"kirby@example.com","appleIds":["001234.dsul.0001"]}"#,
        "[]",
        #""6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b""#,
        "not json",
    ])
    func factsWithNoUserIdFailToDecode(json: String) {
        #expect(throws: (any Error).self) {
            _ = try facts(json)
        }
    }

    @Test func missingKeysReadAsNone() throws {
        #expect(try facts(#"{"userId":"\#(user)"}"#) == AccountFacts(userId: user))
    }

    @Test func wrongKeysReadAsNone() throws {
        let read = try facts("""
        {"userId":"\(user)","email":3,"appleIds":"001234.dsul.0001","appleRevocable":"true","beeminder":1,
         "ledger":null,"openclaw":"yes","keyServices":{"Beeminder":true},"modelProviderName":["OpenAI"]}
        """)
        #expect(read == AccountFacts(userId: user))
    }

    @Test func aBlankEmailOrProviderIsNilAndAnotherIsKeptAsItCame() throws {
        let blank = try facts(#"{"userId":"\#(user)","email":"  ","modelProviderName":"　"}"#)
        #expect(blank.email == nil)
        #expect(blank.modelProviderName == nil)
        let relay = try facts(#"{"userId":"\#(user)","email":"x7q2@privaterelay.appleid.com","modelProviderName":"llm.example.com"}"#)
        #expect(relay.email == "x7q2@privaterelay.appleid.com")
        #expect(relay.modelProviderName == "llm.example.com")
    }

    @Test func anOddAppleIdIsDroppedAndTheRestKept() throws {
        let read = try facts(#"{"userId":"\#(user)","appleIds":["",3,null,"001234.dsul.0001",{"id":"x"},"000999.dsul.0002"]}"#)
        #expect(read.appleIds == ["001234.dsul.0001", "000999.dsul.0002"])
    }

    @Test func anUnknownKeyServiceIsDroppedAndTheKnownOnesKeepTheirOrder() throws {
        let read = try facts("""
        {"userId":"\(user)","keyServices":["OpenClaw","Slack","Home Assistant",3,"twilio","Beeminder","OpenClaw"]}
        """)
        #expect(read.keyServices == ["Beeminder", "Home Assistant", "OpenClaw"])
    }

    @Test func theDeletedFixtureDecodes() throws {
        #expect(AccountDeleted.read(try fixtureData("account-deleted.json")) == AccountDeleted(apple: .revoked))
    }

    @Test(arguments: [
        (#"{"deleted":true,"apple":"revoked"}"#, AppleRevocation.revoked),
        (#"{"deleted":true,"apple":"not_revoked"}"#, AppleRevocation.notRevoked),
        (#"{"deleted":true,"apple":"none"}"#, AppleRevocation.none),
        (#"{"deleted":true,"apple":"unknown"}"#, AppleRevocation.unknown),
        (#"{"deleted":true,"apple":"later"}"#, AppleRevocation.unknown),
        (#"{"deleted":true,"apple":"notRevoked"}"#, AppleRevocation.unknown),
        (#"{"deleted":true,"apple":3}"#, AppleRevocation.unknown),
        (#"{"deleted":true,"apple":null}"#, AppleRevocation.unknown),
        (#"{"deleted":true}"#, AppleRevocation.unknown),
        (#"{}"#, AppleRevocation.unknown),
        ("[]", AppleRevocation.unknown),
        ("not json", AppleRevocation.unknown),
        ("", AppleRevocation.unknown),
    ])
    func anyTwoHundredIsADeletion(body: String, apple: AppleRevocation) {
        #expect(AccountDeleted.read(Data(body.utf8)).apple == apple)
    }

    @Test func theBodyAlwaysCarriesTheAccountAndTheWord() throws {
        #expect(try wire(AccountDeleteBody(account: user, appleCode: nil))
            == #"{"account":"\#(user)","confirm":"DELETE"}"#)
        #expect(try wire(AccountDeleteBody(account: user, appleCode: "c0de.1-x_y"))
            == #"{"account":"\#(user)","appleCode":"c0de.1-x_y","confirm":"DELETE"}"#)
    }

    @Test func theCodeGoesOnlyWhenThereIsOne() throws {
        let bare = try object(AccountDeleteBody(account: user, appleCode: nil))
        #expect(bare.count == 2)
        #expect(bare["account"] as? String == user)
        #expect(bare["confirm"] as? String == "DELETE")
        let empty = AccountDeleteBody(account: user, appleCode: "")
        #expect(empty.appleCode == nil)
        #expect(try object(empty).count == 2)
        let apple = try object(AccountDeleteBody(account: user, appleCode: "c0de.1"))
        #expect(apple.count == 3)
        #expect(apple["appleCode"] as? String == "c0de.1")
    }

    /// The route's schema takes 1 to 1024 visible ASCII characters; a code it
    /// would refuse is left out, so it can never turn a deletion into a 400.
    @Test(arguments: [
        "c0de 1",
        "c0de\n",
        "c\u{00E9}de",
        "c\u{7F}de",
        String(repeating: "a", count: 1025),
    ])
    func aCodeTheRouteWouldRefuseIsLeftOut(code: String) throws {
        let body = AccountDeleteBody(account: user, appleCode: code)
        #expect(body.appleCode == nil)
        #expect(try !object(body).keys.contains("appleCode"))
        var changed = AccountDeleteBody(account: user, appleCode: nil)
        changed.appleCode = code
        #expect(try !object(changed).keys.contains("appleCode"))
    }

    @Test func aCodeAtTheLimitGoes() throws {
        let longest = String(repeating: "a", count: 1024)
        #expect(try object(AccountDeleteBody(account: user, appleCode: longest))["appleCode"] as? String == longest)
        let visible = "!~" + String(repeating: "Z", count: 8)
        #expect(try object(AccountDeleteBody(account: user, appleCode: visible))["appleCode"] as? String == visible)
    }

    @Test func thePathsAreTheRoutes() {
        #expect(AccountDeletion.factsPath == "/api/app/account")
        #expect(AccountDeletion.deletePath == "/api/app/account/delete")
    }
}

@Suite struct AccountWordsTests {
    @Test(arguments: [
        "DELETE", "delete", "Delete", "dElEtE", " Delete\n", "\tDELETE  ", "\u{00A0}DELETE", "\u{FEFF}delete\u{2028}",
    ])
    func theWordConfirms(typed: String) {
        #expect(AccountDeletion.confirms(typed))
    }

    @Test(arguments: [
        "", "   ", "DELET", "DELETED", "DELETE!", "DELETE ME", "D E L E T E", "delete account", "\u{200B}DELETE",
    ])
    func anythingElseDoesNot(typed: String) {
        #expect(!AccountDeletion.confirms(typed))
    }

    @Test func noFactsNoLines() {
        #expect(AccountDeletion.consequences(AccountFacts(userId: user), appleStep: false).isEmpty)
        #expect(AccountDeletion.consequences(AccountFacts(userId: user, email: "kirby@example.com"), appleStep: false).isEmpty)
    }

    @Test func eachFactAddsItsLineInOrder() {
        let all = AccountFacts(
            userId: user, appleIds: ["001234.dsul.0001"], appleRevocable: true, beeminder: true, ledger: true,
            openclaw: true, keyServices: ["Beeminder", "Twilio"], modelProviderName: "Google Gemini"
        )
        #expect(AccountDeletion.consequences(all, appleStep: true) == [
            AccountDeletion.beeminderLine,
            AccountDeletion.ledgerLine,
            AccountDeletion.openclawLine,
            "Keys you gave dsul for Beeminder and Twilio stay active there until you revoke them.",
            "dsul deletes the key you connected, but it stays active with Google Gemini until you revoke it there.",
            AccountDeletion.appleStepLine,
        ])
        #expect(AccountDeletion.consequences(all, appleStep: false).last == AccountDeletion.appleManualLine)
        var noApple = all
        noApple.appleIds = []
        #expect(AccountDeletion.consequences(noApple, appleStep: false).last
            == AccountDeletion.modelKeyLine("Google Gemini"))
    }

    @Test func aBlankProviderAddsNoLine() {
        #expect(AccountDeletion.consequences(AccountFacts(userId: user, modelProviderName: " "), appleStep: false).isEmpty)
    }

    @Test func theAccountLineNamesTheEmail() {
        #expect(AccountDeletion.accountLine("kirby@example.com") == "This deletes the account for kirby@example.com.")
        #expect(AccountDeletion.accountLine(nil) == nil)
        #expect(AccountDeletion.accountLine("") == nil)
        #expect(AccountDeletion.accountLine(" \n") == nil)
    }

    @Test(arguments: [
        ([String](), ""),
        (["Beeminder"], "Beeminder"),
        (["Beeminder", "Twilio"], "Beeminder and Twilio"),
        (["Beeminder", "Twilio", "Home Assistant"], "Beeminder, Twilio and Home Assistant"),
        (["Beeminder", "Twilio", "Home Assistant", "OpenClaw"], "Beeminder, Twilio, Home Assistant and OpenClaw"),
    ])
    func joinNames(names: [String], joined: String) {
        #expect(AccountDeletion.joinNames(names) == joined)
    }

    @Test(arguments: [
        (AppleRevocation.revoked, true, AccountDeletion.deletedMessage),
        (AppleRevocation.revoked, false, AccountDeletion.deletedMessage),
        (AppleRevocation.none, true, AccountDeletion.deletedMessage),
        (AppleRevocation.none, false, AccountDeletion.deletedMessage),
        (AppleRevocation.notRevoked, true, AccountDeletion.appleLeftMessage),
        (AppleRevocation.notRevoked, false, AccountDeletion.appleLeftMessage),
        (AppleRevocation.unknown, true, AccountDeletion.appleLeftMessage),
        (AppleRevocation.unknown, false, AccountDeletion.deletedMessage),
    ])
    func theDoneMessage(apple: AppleRevocation, hadApple: Bool, expected: String) {
        #expect(AccountDeletion.doneMessage(apple: apple, hadApple: hadApple) == expected)
    }

    @Test func noWordHasADashOrAnOldButton() {
        let all = [
            AccountDeletion.title, AccountDeletion.accountLine("kirby@example.com") ?? "", AccountDeletion.lead,
            AccountDeletion.beeminderLine, AccountDeletion.ledgerLine, AccountDeletion.openclawLine,
            AccountDeletion.keysLine(["Beeminder", "Twilio"]), AccountDeletion.modelKeyLine("OpenAI"),
            AccountDeletion.appleStepLine, AccountDeletion.appleManualLine, AccountDeletion.unreachableMessage,
            AccountDeletion.failedMessage, AccountDeletion.changedMessage, AccountDeletion.deletedMessage,
            AccountDeletion.appleLeftMessage, AccountDeletion.confirmLabel, AccountDeletion.deleteLabel,
            AccountDeletion.deletingLabel,
        ]
        for line in all {
            #expect(!line.contains("\u{2014}"), "\(line)")
            #expect(!line.contains("\u{2013}"), "\(line)")
            #expect(!line.contains("Beacon"), "\(line)")
            #expect(!line.contains("Stop Using"), "\(line)")
        }
        #expect(AccountDeletion.lead.contains("cannot be undone"))
        #expect(AccountDeletion.lead.contains("Trash"))
        #expect(AccountDeletion.appleManualLine.contains("tap Delete"))
        #expect(AccountDeletion.appleLeftMessage.contains("tap Delete"))
        #expect(AccountDeletion.confirmLabel.contains(AccountDeletion.confirmWord))
    }
}

// MARK: - The web's words and rules (account-copy.json)

/// `words`: the phone's words, and the templates with their placeholders
/// ({email}, {services}, {name}). The web's own (`appleManualWeb`,
/// `appleLeftWeb`, `doneLabel`) are in the file but not read here.
private struct CopyWords: Decodable, Sendable {
    let title: String
    let account: String
    let lead: String
    let beeminder: String
    let ledger: String
    let openclaw: String
    let keys: String
    let modelKey: String
    let appleStep: String
    let appleManual: String
    let unreachable: String
    let failed: String
    let changed: String
    let deleted: String
    let appleLeft: String
    let confirmLabel: String
    let deleteLabel: String
    let deletingLabel: String
    let confirmWord: String
}

private struct ConfirmCase: Decodable, Sendable {
    let typed: String
    let ok: Bool
}

private struct JoinCase: Decodable, Sendable {
    let names: [String]
    let joined: String
}

/// `facts` is the route's shape, so it reads through AccountFacts' own decoding.
private struct ConsequenceCase: Decodable, Sendable {
    let facts: AccountFacts
    let appleStep: Bool
    let lines: [String]
}

private struct DoneCase: Decodable, Sendable {
    let apple: String
    let hadApple: Bool
    let message: String
}

private struct CopyFixture: Decodable, Sendable {
    let words: CopyWords
    let confirms: [ConfirmCase]
    let joinNames: [JoinCase]
    let consequences: [ConsequenceCase]
    let done: [DoneCase]
}

private func loadCopy() throws -> CopyFixture {
    return try JSONDecoder().decode(CopyFixture.self, from: try fixtureData("account-copy.json"))
}

@Suite struct AccountCopyFixtureTests {
    @Test func everyTableHasCases() throws {
        let f = try loadCopy()
        #expect(f.confirms.contains { $0.ok })
        #expect(f.confirms.contains { !$0.ok })
        #expect(f.joinNames.count >= 4)
        #expect(f.consequences.contains { $0.appleStep })
        #expect(f.consequences.contains { !$0.appleStep && !$0.facts.appleIds.isEmpty })
        #expect(f.consequences.contains { $0.lines.isEmpty })
        #expect(Set(f.done.map(\.apple)) == ["revoked", "not_revoked", "none", "unknown"])
    }

    @Test func everyPhoneWordIsTheWebs() throws {
        let w = try loadCopy().words
        #expect(AccountDeletion.title == w.title)
        #expect(AccountDeletion.accountLine("{email}") == w.account)
        #expect(AccountDeletion.lead == w.lead)
        #expect(AccountDeletion.beeminderLine == w.beeminder)
        #expect(AccountDeletion.ledgerLine == w.ledger)
        #expect(AccountDeletion.openclawLine == w.openclaw)
        #expect(AccountDeletion.keysLine(["{services}"]) == w.keys)
        #expect(AccountDeletion.modelKeyLine("{name}") == w.modelKey)
        #expect(AccountDeletion.appleStepLine == w.appleStep)
        #expect(AccountDeletion.appleManualLine == w.appleManual)
        #expect(AccountDeletion.unreachableMessage == w.unreachable)
        #expect(AccountDeletion.failedMessage == w.failed)
        #expect(AccountDeletion.changedMessage == w.changed)
        #expect(AccountDeletion.deletedMessage == w.deleted)
        #expect(AccountDeletion.appleLeftMessage == w.appleLeft)
        #expect(AccountDeletion.confirmLabel == w.confirmLabel)
        #expect(AccountDeletion.deleteLabel == w.deleteLabel)
        #expect(AccountDeletion.deletingLabel == w.deletingLabel)
        #expect(AccountDeletion.confirmWord == w.confirmWord)
    }

    /// Byte for byte, not as Swift's `==` compares (canonical equivalence):
    /// the fixture is the web's own strings.
    @Test func everyPhoneWordIsTheWebsByteForByte() throws {
        let w = try loadCopy().words
        let pairs: [(String, String)] = [
            (AccountDeletion.title, w.title), (AccountDeletion.lead, w.lead),
            (AccountDeletion.ledgerLine, w.ledger), (AccountDeletion.deletingLabel, w.deletingLabel),
            (AccountDeletion.changedMessage, w.changed), (AccountDeletion.appleLeftMessage, w.appleLeft),
        ]
        for (phone, web) in pairs {
            #expect(Array(phone.utf8) == Array(web.utf8), "\(web)")
        }
    }

    @Test func theConfirmTableAgrees() throws {
        for c in try loadCopy().confirms {
            #expect(AccountDeletion.confirms(c.typed) == c.ok, "\(c.typed.unicodeScalars.map { $0.value })")
        }
    }

    @Test func theJoinTableAgrees() throws {
        for c in try loadCopy().joinNames {
            #expect(AccountDeletion.joinNames(c.names) == c.joined)
        }
    }

    @Test func theConsequenceTableAgrees() throws {
        for c in try loadCopy().consequences {
            #expect(AccountDeletion.consequences(c.facts, appleStep: c.appleStep) == c.lines, "\(c.facts)")
        }
    }

    @Test func theDoneTableAgrees() throws {
        for c in try loadCopy().done {
            let apple = try #require(AppleRevocation(rawValue: c.apple), "unknown apple \(c.apple)")
            #expect(AccountDeletion.doneMessage(apple: apple, hadApple: c.hadApple) == c.message, "\(c.apple)")
        }
    }
}
