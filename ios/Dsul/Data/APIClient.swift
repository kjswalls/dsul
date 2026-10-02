import DsulCore
import Foundation

/// One HTTP exchange's outcome: the status and the body. Our own Sendable
/// value rather than `HTTPURLResponse`, so the transport crosses actors
/// cleanly and a test answers with one line.
struct HTTPResult: Sendable {
    var status: Int
    var data: Data

    init(status: Int, data: Data = Data()) {
        self.status = status
        self.data = data
    }

    var isSuccess: Bool { (200..<300).contains(status) }
}

/// Sends one request. Injected everywhere, so tests answer without a network.
typealias Transport = @Sendable (URLRequest) async throws -> HTTPResult

enum HTTP {
    /// No cookie jar and no disk cache: every route the app calls is
    /// bearer-only (lib/app-auth.ts never reads a cookie), and nothing it
    /// fetches should outlive the session on disk. (`nonisolated(unsafe)`
    /// only spells out what URLSession already is: safe to share.)
    nonisolated(unsafe) static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        return URLSession(configuration: configuration)
    }()

    static let live: Transport = { request in
        let (data, response) = try await HTTP.session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return HTTPResult(status: http.statusCode, data: data)
    }
}

/// Where the API client gets a bearer token: AuthStore in the app, a fake in
/// tests.
@MainActor
protocol AccessTokenSource: AnyObject {
    /// A token that isn't about to expire. When `rejected` is the current
    /// token (the server just answered 401 to it), a refreshed one.
    func accessToken(rejecting rejected: String?) async throws -> String
}

/// What a call to /api/app can come back with, beyond success.
enum APIError: Error, Equatable, Sendable {
    /// No session, or Auth says it is gone. AuthStore has already moved to
    /// signed out; nothing to show.
    case signedOut
    /// Still 401 after one refresh and one retry.
    case unauthorized
    /// The server or the network is down (502-504, offline). Never a reason
    /// to sign out.
    case unavailable
    /// The route said no: 400, 404, 409 and the like, with its error code.
    case rejected(status: Int, code: String?)
    /// A success whose body couldn't be read.
    case badResponse
}

/// The app's writes and one read on /api/app (lib/app-api.ts), with a
/// Supabase access token as the bearer: capture, and the item writes (tick,
/// braindump row to an hour, skip, move, pause).
///
/// Writes are intents, never arrays: a tick or a skip sends the date and the
/// end state, never `completedDates` or `skippedDates`, because the phone reads
/// a 400-day window and an array written back from a window deletes what the
/// window didn't show.
@MainActor
final class APIClient {
    private let origin: URL
    private let tokens: any AccessTokenSource
    private let transport: Transport

    init(origin: URL, tokens: any AccessTokenSource, transport: @escaping Transport) {
        self.origin = origin
        self.tokens = tokens
        self.transport = transport
    }

    /// GET /api/app/planner.
    func fetchPlanner() async throws -> PlannerPayload {
        let result = try await send("GET", "/api/app/planner", body: nil)
        do {
            return try JSONDecoder().decode(PlannerPayload.self, from: result.data)
        } catch {
            throw APIError.badResponse
        }
    }

    /// POST /api/app/items/:id `complete`: a tick on `date`, with a counted
    /// habit's new tally.
    func complete(id: UUID, date: String, done: Bool, count: Int?) async throws {
        let body = CompleteBody(date: date, done: done, count: count)
        _ = try await send("POST", Self.itemPath(id), body: try Self.encode(body))
    }

    /// POST /api/app/items/:id `schedule`: a braindump row dropped on an hour.
    func schedule(id: UUID, date: String, startTime: String) async throws {
        let body = ScheduleBody(date: date, startTime: startTime)
        _ = try await send("POST", Self.itemPath(id), body: try Self.encode(body))
    }

    /// POST /api/app/items/:id `skip`: Skip today (`skipped` true) or Unskip
    /// today on `date`.
    func skip(id: UUID, date: String, skipped: Bool) async throws {
        let body = SkipBody(date: date, skipped: skipped)
        _ = try await send("POST", Self.itemPath(id), body: try Self.encode(body))
    }

    /// POST /api/app/items/:id `move`: Tomorrow or Reschedule, to `date`.
    func move(id: UUID, date: String) async throws {
        let body = MoveBody(date: date)
        _ = try await send("POST", Self.itemPath(id), body: try Self.encode(body))
    }

    /// POST /api/app/items/:id `pause`: Pause (until `pausedUntil`, or with no
    /// end when nil) or Resume, with the zone the phone read today in.
    func pause(id: UUID, paused: Bool, pausedUntil: String?, timeZone: String?) async throws {
        let body = PauseBody(paused: paused, pausedUntil: pausedUntil, timeZone: timeZone)
        _ = try await send("POST", Self.itemPath(id), body: try Self.encode(body))
    }

    /// POST /api/app/items: a capture, under the phone's own id, so a retry
    /// after a lost response is answered 200 for the same row.
    func capture(id: UUID, title: String) async throws {
        let body = CaptureBody(id: id.uuidString.lowercased(), title: title)
        _ = try await send("POST", "/api/app/items", body: try Self.encode(body))
    }

    /// Postgres stores uuids lowercase; `uuidString` is uppercase.
    static func itemPath(_ id: UUID) -> String {
        return "/api/app/items/" + id.uuidString.lowercased()
    }

    // MARK: Sending

    /// The token is refreshed ahead of expiry by the source. A 401 anyway gets
    /// one refresh and one retry; a second 401 is an error, not a sign-out.
    private func send(_ method: String, _ path: String, body: Data?) async throws -> HTTPResult {
        let first = try await token(rejecting: nil)
        var result = try await perform(method, path, body: body, token: first)
        if result.status == 401 {
            let second = try await token(rejecting: first)
            result = try await perform(method, path, body: body, token: second)
            if result.status == 401 { throw APIError.unauthorized }
        }
        if result.isSuccess { return result }
        if result.status == 502 || result.status == 503 || result.status == 504 { throw APIError.unavailable }
        throw APIError.rejected(status: result.status, code: Self.errorCode(result.data))
    }

    private func token(rejecting rejected: String?) async throws -> String {
        do {
            return try await tokens.accessToken(rejecting: rejected)
        } catch AuthError.signedOut {
            throw APIError.signedOut
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw APIError.unavailable
        }
    }

    private func perform(_ method: String, _ path: String, body: Data?, token: String) async throws -> HTTPResult {
        guard let url = AppConfig.endpoint(path, origin: origin) else { throw APIError.badResponse }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        do {
            return try await transport(request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw APIError.unavailable
        }
    }

    private static func encode<T: Encodable>(_ body: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(body)
    }

    /// The route's `{"error": "…"}`, never more: the server never sends a
    /// Postgres message, and the phone never shows one.
    private static func errorCode(_ data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data, options: []),
              let json = object as? [String: Any]
        else { return nil }
        return json["error"] as? String
    }
}

/// `{"action":"complete","date":…,"done":…,"count"?:…}`. A nil count is left
/// out, not sent as null: the route's schema takes a number or nothing.
private struct CompleteBody: Encodable {
    var action = "complete"
    var date: String
    var done: Bool
    var count: Int?
}

/// `{"action":"schedule","date":…,"startTime":"HH:mm"}`.
private struct ScheduleBody: Encodable {
    var action = "schedule"
    var date: String
    var startTime: String
}

/// `{"id":…,"title":…}`.
private struct CaptureBody: Encodable {
    var id: String
    var title: String
}

/// `{"action":"skip","date":…,"skipped":…}`.
private struct SkipBody: Encodable {
    var action = "skip"
    var date: String
    var skipped: Bool
}

/// `{"action":"move","date":…}`.
private struct MoveBody: Encodable {
    var action = "move"
    var date: String
}

/// `{"action":"pause","paused":…,"pausedUntil"?:…,"timeZone"?:…}`. A nil key
/// is left out, not sent as null: the route's schema takes a day or a zone,
/// or nothing.
private struct PauseBody: Encodable {
    var action = "pause"
    var paused: Bool
    var pausedUntil: String?
    var timeZone: String?
}
