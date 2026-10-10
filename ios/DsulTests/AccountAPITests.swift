import DsulCore
import Foundation
import Testing
@testable import Dsul

/// The account routes' bodies (lib/account-types.ts), as
/// tests/unit/account-routes.test.ts pins them.
enum AccountJSON {
    static let factsRoute = "GET /api/app/account"
    static let deleteRoute = "POST /api/app/account/delete"

    /// tests/fixtures/app/account-facts.json, the route's own answer, in one
    /// line.
    static let facts = #"{"userId":"6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b","email":"kirby@example.com","#
        + #""appleIds":["001234.dsul.0001"],"appleRevocable":true,"beeminder":true,"ledger":true,"#
        + #""openclaw":false,"keyServices":["Beeminder","Twilio"],"modelProviderName":"OpenAI"}"#

    /// The facts' `userId`, which a delete sends back as `account`.
    static let account = "6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b"

    /// tests/fixtures/app/account-deleted.json.
    static let revoked = #"{"deleted":true,"apple":"revoked"}"#

    static func refusal(_ code: String) -> String {
        return #"{"error":""# + code + #""}"#
    }
}

/// A route's answer, and the error the client throws for it.
struct AccountRefusal: Sendable, CustomTestStringConvertible {
    let testDescription: String
    let reply: FakeServer.Reply
    let error: APIError
}

/// A 2xx body, and what the client reads it as.
struct AccountAnswer: Sendable, CustomTestStringConvertible {
    let testDescription: String
    let status: Int
    let body: String
    let apple: AppleRevocation
}

/// Delete account's two calls through the client every /api/app call uses
/// (memory/plans/account-deletion.md): GET /api/app/account and POST
/// /api/app/account/delete, with the bearer, one refresh on a 401, and the
/// route's refusals as `APIError`s. DsulCore's AccountTests reads the routes'
/// fixtures; this suite checks what goes over the wire and back.
@MainActor
@Suite struct AccountAPITests {
    private func makeClient(_ server: FakeServer, tokens: FakeTokens? = nil) -> APIClient {
        let source: FakeTokens = tokens ?? FakeTokens()
        return APIClient(origin: URL(string: "https://dsul.test")!, tokens: source, transport: server.transport)
    }

    /// What a call threw, if it threw an `APIError`.
    private func apiError(_ call: () async throws -> Void) async -> APIError? {
        do {
            try await call()
            return nil
        } catch let error as APIError {
            return error
        } catch {
            return nil
        }
    }

    // MARK: The facts

    @Test func theFactsAreAGetWithTheBearer() async throws {
        let server = FakeServer()
        await server.on(AccountJSON.factsRoute, .status(200, AccountJSON.facts))
        let api = makeClient(server)

        let facts = try await api.accountFacts()

        #expect(facts == AccountFacts(userId: AccountJSON.account, email: "kirby@example.com",
                                      appleIds: ["001234.dsul.0001"], appleRevocable: true, beeminder: true,
                                      ledger: true, openclaw: false, keyServices: ["Beeminder", "Twilio"],
                                      modelProviderName: "OpenAI"))
        let requests = await server.requests
        #expect(requests.count == 1)
        let request = requests.first
        #expect(request?.route == AccountJSON.factsRoute)
        #expect(request?.headers["authorization"] == "Bearer token-1")
        #expect(request?.headers["accept"] == "application/json")
        #expect(request?.body == nil)
    }

    @Test(arguments: [
        #"{"email":"kirby@example.com","appleIds":[]}"#,
        #"{"userId":"","email":"kirby@example.com"}"#,
        #"{"userId":null}"#,
        "not json",
        "",
    ])
    func factsWithNoUserIdAreABadResponse(_ body: String) async {
        let server = FakeServer()
        await server.on(AccountJSON.factsRoute, .status(200, body))
        let api = makeClient(server)

        let error = await apiError { _ = try await api.accountFacts() }

        #expect(error == .badResponse)
    }

    @Test(arguments: [
        AccountRefusal(testDescription: "410 gone", reply: .status(410, AccountJSON.refusal("gone")),
                       error: .rejected(status: 410, code: "gone")),
        AccountRefusal(testDescription: "503", reply: .status(503, AccountJSON.refusal("unavailable")),
                       error: .unavailable),
        AccountRefusal(testDescription: "offline", reply: .offline, error: .unavailable),
    ])
    func eachFactsRefusalIsAnError(_ refusal: AccountRefusal) async {
        let server = FakeServer()
        await server.on(AccountJSON.factsRoute, refusal.reply)
        let api = makeClient(server)

        let error = await apiError { _ = try await api.accountFacts() }

        #expect(error == refusal.error)
    }

    // MARK: The delete

    @Test func theBodyIsTheAccountAndTheWordAndNothingElse() async throws {
        let server = FakeServer()
        await server.on(AccountJSON.deleteRoute, .status(200, AccountJSON.revoked))
        let api = makeClient(server)

        _ = try await api.deleteAccount(account: AccountJSON.account, appleCode: nil)

        let requests = await server.requests
        #expect(requests.count == 1)
        let request = requests.first
        #expect(request?.route == AccountJSON.deleteRoute)
        #expect(request?.headers["authorization"] == "Bearer token-1")
        #expect(request?.headers["content-type"] == "application/json")
        let sent = request?.body.flatMap { String(data: $0, encoding: .utf8) }
        #expect(sent == #"{"account":"6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b","confirm":"DELETE"}"#)
        #expect(bodyJSON(request)?.count == 2)
    }

    @Test func aCodeGoesWithItWhenThereIsOne() async throws {
        let server = FakeServer()
        await server.on(AccountJSON.deleteRoute, .status(200, AccountJSON.revoked))
        let api = makeClient(server)

        _ = try await api.deleteAccount(account: AccountJSON.account, appleCode: "c0de.1")

        let request = await server.requests.first
        let sent = request?.body.flatMap { String(data: $0, encoding: .utf8) }
        #expect(sent == #"{"account":"6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b","appleCode":"c0de.1","confirm":"DELETE"}"#)
        let body = bodyJSON(request)
        #expect(body?.count == 3)
        #expect(body?["account"] as? String == AccountJSON.account)
        #expect(body?["appleCode"] as? String == "c0de.1")
        #expect(body?["confirm"] as? String == "DELETE")
    }

    @Test(arguments: [
        AccountAnswer(testDescription: "revoked", status: 200, body: AccountJSON.revoked, apple: .revoked),
        AccountAnswer(testDescription: "not revoked", status: 200, body: #"{"deleted":true,"apple":"not_revoked"}"#,
                      apple: .notRevoked),
        AccountAnswer(testDescription: "no Apple id", status: 200, body: #"{"deleted":true,"apple":"none"}"#,
                      apple: AppleRevocation.none),
        AccountAnswer(testDescription: "a retry", status: 200, body: #"{"deleted":true,"apple":"unknown"}"#,
                      apple: .unknown),
        AccountAnswer(testDescription: "no apple key", status: 200, body: #"{"deleted":true}"#, apple: .unknown),
        AccountAnswer(testDescription: "an unknown word", status: 200, body: #"{"deleted":true,"apple":"maybe"}"#,
                      apple: .unknown),
        AccountAnswer(testDescription: "not JSON", status: 200, body: "deleted", apple: .unknown),
        AccountAnswer(testDescription: "empty", status: 200, body: "", apple: .unknown),
        AccountAnswer(testDescription: "204", status: 204, body: "", apple: .unknown),
    ])
    func anyTwoHundredIsADeletion(_ answer: AccountAnswer) async throws {
        let server = FakeServer()
        await server.on(AccountJSON.deleteRoute, .status(answer.status, answer.body))
        let api = makeClient(server)

        let deleted = try await api.deleteAccount(account: AccountJSON.account, appleCode: nil)

        #expect(deleted == AccountDeleted(apple: answer.apple))
    }

    @Test(arguments: [
        AccountRefusal(testDescription: "503", reply: .status(503, AccountJSON.refusal("unavailable")),
                       error: .unavailable),
        AccountRefusal(testDescription: "502", reply: .status(502, ""), error: .unavailable),
        AccountRefusal(testDescription: "offline", reply: .offline, error: .unavailable),
        AccountRefusal(testDescription: "400", reply: .status(400, AccountJSON.refusal("invalid")),
                       error: .rejected(status: 400, code: "invalid")),
        AccountRefusal(testDescription: "409", reply: .status(409, AccountJSON.refusal("changed")),
                       error: .rejected(status: 409, code: "changed")),
        AccountRefusal(testDescription: "500", reply: .status(500, AccountJSON.refusal("failed")),
                       error: .rejected(status: 500, code: "failed")),
        AccountRefusal(testDescription: "401 twice", reply: .status(401, AccountJSON.refusal("unauthorized")),
                       error: .unauthorized),
    ])
    func eachDeleteRefusalIsAnError(_ refusal: AccountRefusal) async {
        let server = FakeServer()
        await server.on(AccountJSON.deleteRoute, refusal.reply)
        let api = makeClient(server)

        let error = await apiError { _ = try await api.deleteAccount(account: AccountJSON.account, appleCode: nil) }

        #expect(error == refusal.error)
    }

    @Test func a401RefreshesOnceAndSendsTheSameBodyAgain() async throws {
        let server = FakeServer()
        await server.on(AccountJSON.deleteRoute,
                        .status(401, AccountJSON.refusal("unauthorized")),
                        .status(200, AccountJSON.revoked))
        let tokens = FakeTokens()
        let api = makeClient(server, tokens: tokens)

        let deleted = try await api.deleteAccount(account: AccountJSON.account, appleCode: "c0de.1")

        #expect(deleted.apple == .revoked)
        #expect(tokens.refreshes == 1)
        let requests = await server.requests
        #expect(requests.count == 2)
        #expect(requests.map(\.route) == [AccountJSON.deleteRoute, AccountJSON.deleteRoute])
        #expect(requests.map { $0.headers["authorization"] } == ["Bearer token-1", "Bearer token-2"])
        #expect(requests.first?.body != nil)
        #expect(requests.first?.body == requests.last?.body)
    }
}
