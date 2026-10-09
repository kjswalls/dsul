import Foundation

// Done and Snooze, tapped on a notification, kept on disk until the server
// has them (memory/plans/reminders-platforms.md §5.3). A button pressed on the
// lock screen may wake the app for a few seconds with no network, or not at
// all past iOS's patience, and an in-memory queue dies with the process, so
// each tap is written here first and taken out only once its write landed or
// was refused. NotificationHub drains it: through PlannerSync when a planner
// is up, else straight to the item routes.
//
// The file is protected `completeUntilFirstUserAuthentication`, not
// `complete`: "Users can respond to actions while the device is locked, which
// would make files encrypted with the complete option unavailable"
// (developer.apple.com, Declaring your actionable notification types).

/// One button press.
struct OutboxEntry: Codable, Sendable, Hashable, Identifiable {
    enum Kind: String, Codable, Sendable {
        case done, snooze
    }

    var id: UUID
    /// Whose tap it was: another user's is dropped, never sent.
    var userId: UUID
    var kind: Kind
    var itemId: UUID
    /// The day the notification was about: Done ticks it, Snooze is gated to it.
    var dateStr: String
    /// When it was pressed, epoch ms.
    var tappedAtMs: Int
    /// A snooze's ring, epoch ms: the tap plus SNOOZE_MINUTES, held to its
    /// day. Sent as the minutes left, so a drain late by ten minutes still
    /// rings at the minute the button promised.
    var untilMs: Int?
}

/// Where the outbox's bytes live: a protected file in the app, memory in tests.
protocol OutboxStorage: AnyObject {
    func read() -> Data?
    func write(_ data: Data?) throws
}

final class FileOutboxStorage: OutboxStorage {
    private let url: URL

    init(url: URL) {
        self.url = url
    }

    /// Application Support/dsul-action-outbox.json.
    static func standard() -> FileOutboxStorage {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return FileOutboxStorage(url: base.appendingPathComponent("dsul-action-outbox.json"))
    }

    func read() -> Data? {
        return try? Data(contentsOf: url)
    }

    func write(_ data: Data?) throws {
        guard let data else {
            try? FileManager.default.removeItem(at: url)
            return
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: [.atomic])
        #endif
    }
}

final class MemoryOutboxStorage: OutboxStorage {
    var data: Data?

    init(_ data: Data? = nil) {
        self.data = data
    }

    func read() -> Data? { data }
    func write(_ data: Data?) throws { self.data = data }
}

@MainActor
final class ActionOutbox {
    private let storage: any OutboxStorage
    private(set) var entries: [OutboxEntry]

    init(storage: any OutboxStorage) {
        self.storage = storage
        if let data = storage.read(), let saved = try? JSONDecoder().decode([OutboxEntry].self, from: data) {
            entries = saved
        } else {
            entries = []
        }
    }

    func append(_ entry: OutboxEntry) {
        entries.append(entry)
        persist()
    }

    func remove(_ ids: Set<UUID>) {
        let before = entries.count
        entries.removeAll { ids.contains($0.id) }
        if entries.count != before { persist() }
    }

    func clear() {
        entries = []
        persist()
    }

    private func persist() {
        let data = entries.isEmpty ? nil : try? JSONEncoder().encode(entries)
        try? storage.write(data)
    }
}
