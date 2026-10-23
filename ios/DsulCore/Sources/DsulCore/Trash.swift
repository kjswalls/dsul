import Foundation

// The Trash on the phone (Organize O14): what GET /api/app/trash answers, what
// POST /api/app/trash/restore takes and what it refuses with. Port of
// lib/app-containers.ts `AppTrashRow`, `AppTrashResponse`, `TRASH_WRITES` and
// `TrashRestoreSchema`. Keep in step: a change there without the same change
// here is drift, and the phone can't read the bin or is refused its restore.
// The route's answer is pinned by tests/fixtures/app/trash-response.json, which
// tests/unit/app-trash.test.ts writes through the real route and TrashTests
// decodes. The row's words (`trashRowMeta`, `restoreRefusal`) are
// OrganizeCopy.swift's.
//
// The bin never enters the planner's state (the web's law): a page fetches it
// on arrival, holds the rows itself, and refetches the planner after a
// restore. Nothing here rebuilds an entity from a row.
//
// Reading is lenient where it can be and strict where it must be. A row with
// no kind the phone knows, or no id, is skipped and counted; an answer with no
// `entries` list fails, so the page says it couldn't load the Trash, never
// that the bin is empty.

/// lib/db.ts `TrashKind`: the five tables the bin spans.
public enum TrashKind: String, Sendable, Hashable, CaseIterable, Codable {
    case item, project, routine, season, goal

    /// The container kind, or nil for an item: lib/organize-copy.ts
    /// `restoreSentence` takes `Exclude<TrashKind, 'item'>`, which is
    /// `OrganizeKind`.
    public var container: OrganizeKind? {
        switch self {
        case .item: return nil
        case .project: return .project
        case .routine: return .routine
        case .season: return .season
        case .goal: return .goal
        }
    }

    /// The bin's kind for a container kind.
    public init(_ kind: OrganizeKind) {
        switch kind {
        case .routine: self = .routine
        case .season: self = .season
        case .goal: self = .goal
        case .project: self = .project
        }
    }

    /// lib/organize-copy.ts `TRASH_KIND_LABELS`: the kind as a word on the row
    /// ("Item", then the registry's nouns, `ContainerWords`).
    public var label: String {
        switch self {
        case .item: return "Item"
        case .project: return ContainerWords.project
        case .routine: return ContainerWords.routine
        case .season: return ContainerWords.season
        case .goal: return ContainerWords.goal
        }
    }
}

/// lib/app-containers.ts `AppTrashRow`: one row of the bin, trimmed to what
/// the phone draws. Absent optionals arrive as missing keys; a missing count
/// reads 0, which says nothing (`trashKindLine`).
public struct TrashRow: Decodable, Sendable, Hashable {
    public var kind: TrashKind
    /// The row's id, as the server wrote it (lowercase for every real row).
    /// Ids are unique per table only, so a list keys its rows on `key`.
    public var id: String
    /// The item's title, or the container's name.
    public var name: String
    /// `deleted_at` as Postgres wrote it (six fractional digits and an
    /// offset); `whenGone` reads it as an instant.
    public var deletedAt: String
    /// A container's glyph token (`icon:Briefcase`); items have none.
    public var icon: String?
    public var color: String?
    /// An item's type slug (`task`, `habit`, or a custom type's).
    public var itemType: String?
    /// The co-deleted subtasks that come back with an item.
    public var childCount: Int
    /// The items a project re-files or a goal reconnects (projects and goals
    /// only; 0 for the rest).
    public var memberCount: Int

    public init(
        kind: TrashKind,
        id: String,
        name: String,
        deletedAt: String,
        icon: String? = nil,
        color: String? = nil,
        itemType: String? = nil,
        childCount: Int = 0,
        memberCount: Int = 0
    ) {
        self.kind = kind
        self.id = id
        self.name = name
        self.deletedAt = deletedAt
        self.icon = icon
        self.color = color
        self.itemType = itemType
        self.childCount = childCount
        self.memberCount = memberCount
    }

    /// `<kind>:<id>`: unique in the bin, where ids are unique only per table
    /// (`ForEach(rows, id: \.key)`).
    public var key: String { "\(kind.rawValue):\(id)" }

    enum CodingKeys: String, CodingKey {
        case kind, id, name, deletedAt, icon, color, itemType, childCount, memberCount
    }

    /// Throws only without a known kind or a non-empty id, which leave nothing
    /// to restore. Everything else is lenient: a missing or wrong name or stamp
    /// reads as empty, a blank optional as nil, a count as a whole number.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rawKind = try c.decode(String.self, forKey: .kind)
        guard let kind = TrashKind(rawValue: rawKind) else {
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown kind \(rawKind)")
        }
        let id = try c.decode(String.self, forKey: .id)
        guard !id.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: c, debugDescription: "empty id")
        }
        func text(_ key: CodingKeys) -> String? {
            guard let s = try? c.decodeIfPresent(String.self, forKey: key), !s.isEmpty else { return nil }
            return s
        }
        func count(_ key: CodingKeys) -> Int {
            if let whole = try? c.decodeIfPresent(Int.self, forKey: key) { return max(0, whole) }
            if let real = try? c.decodeIfPresent(Double.self, forKey: key), real.isFinite, abs(real) < 9.0e15 {
                return max(0, Int(real))
            }
            return 0
        }
        self.init(
            kind: kind,
            id: id,
            name: (try? c.decodeIfPresent(String.self, forKey: .name)) ?? "",
            deletedAt: (try? c.decodeIfPresent(String.self, forKey: .deletedAt)) ?? "",
            icon: text(.icon),
            color: text(.color),
            itemType: text(.itemType),
            childCount: count(.childCount),
            memberCount: count(.memberCount)
        )
    }
}

/// lib/app-containers.ts `AppTrashResponse`: the bin, newest first, as the
/// web's Trash lists it (a subtask deleted with its parent travels in the
/// parent's row).
public struct TrashList: Decodable, Sendable, Hashable {
    public var entries: [TrashRow]
    /// Rows that couldn't be read and were left out.
    public var dropped: Int

    public init(entries: [TrashRow], dropped: Int = 0) {
        self.entries = entries
        self.dropped = dropped
    }

    enum CodingKeys: String, CodingKey {
        case entries
    }

    /// Throws when `entries` is missing or not a list: a bin the phone could
    /// not read is never shown as an empty one. A bad row is skipped and
    /// counted.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var list = try c.nestedUnkeyedContainer(forKey: .entries)
        var rows: [TrashRow] = []
        var dropped = 0
        while !list.isAtEnd {
            if let row = try? list.decode(TrashRow.self) {
                rows.append(row)
                continue
            }
            dropped += 1
            if let isNull = try? list.decodeNil(), isNull { continue }
            if (try? list.decode(TrashSkip.self)) == nil { break }
        }
        self.entries = rows
        self.dropped = dropped
    }

    /// The list without `row`, as the page shows it once a restore lands.
    public func removing(_ row: TrashRow) -> TrashList {
        return TrashList(entries: entries.filter { $0.key != row.key }, dropped: dropped)
    }
}

/// Decodes anything and keeps nothing, to step past a row that failed.
private struct TrashSkip: Decodable {
    init(from decoder: Decoder) throws {}
}

/// POST /api/app/trash/restore's body (lib/app-containers.ts
/// `TrashRestoreSchema`, `.strict()`): `{"id":…,"kind":…}`, exactly these two
/// keys. The id is sent lowercase, as the route lowercases it.
public struct TrashRestoreBody: Encodable, Sendable, Hashable {
    public var kind: TrashKind
    public var id: String

    public init(kind: TrashKind, id: String) {
        self.kind = kind
        self.id = id.lowercased()
    }

    public init(_ row: TrashRow) {
        self.init(kind: row.kind, id: row.id)
    }

    enum CodingKeys: String, CodingKey {
        case kind, id
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(kind.rawValue, forKey: .kind)
        try c.encode(id, forKey: .id)
    }
}

/// A refused restore's body, read leniently: `{"error":"name_taken",
/// "project":{"id":…,"name":…}}` (the LIVE project whose name the trashed one
/// folds to), `{"error":"parent_gone"}`, `{"error":"not_found"}`, or nothing
/// readable at all. Never throws.
public struct TrashRestoreRefusal: Sendable, Hashable {
    /// The route's code, or nil when the body had none.
    public var code: String?
    /// `name_taken` only: the live project's id and name.
    public var projectId: String?
    public var projectName: String?

    public init(code: String?, projectId: String? = nil, projectName: String? = nil) {
        self.code = code
        self.projectId = projectId
        self.projectName = projectName
    }

    public static func read(_ data: Data) -> TrashRestoreRefusal {
        guard let object = try? JSONSerialization.jsonObject(with: data, options: []),
              let json = object as? [String: Any]
        else { return TrashRestoreRefusal(code: nil) }
        let project = json["project"] as? [String: Any]
        return TrashRestoreRefusal(
            code: json["error"] as? String,
            projectId: project?["id"] as? String,
            projectName: project?["name"] as? String
        )
    }

    /// The route's 404: the row is no longer in the bin (purged after the
    /// list was read, or never this user's). No retry can land, so the page
    /// drops the row.
    public var isGone: Bool { code == "not_found" }

    /// What the phone says (`OrganizeCopy.restoreRefusal`): a `name_taken`
    /// names the live project, falling back to the trashed row's own name
    /// (they fold to the same name) when the body didn't carry it.
    public func sentence(rowName: String) -> String {
        let name = projectName.flatMap { $0.isEmpty ? nil : $0 } ?? rowName
        return OrganizeCopy.restoreRefusal(code: code, name: name)
    }
}

/// The two routes and the payload's switch for them.
public enum TrashRoutes {
    /// GET: the bin.
    public static let list = "/api/app/trash"
    /// POST: one row back (`TrashRestoreBody`).
    public static let restore = "/api/app/trash/restore"
    /// lib/app-containers.ts `TRASH_WRITES`, in the order the phone uses them.
    public static let writes = ["list", "restore"]

    /// Whether the server takes both (`PlannerPayload.trashWrites`). An
    /// older server sends no key, and the phone then shows no Trash row
    /// rather than a bin it would be refused.
    public static func offered(_ trashWrites: [String]?) -> Bool {
        guard let trashWrites else { return false }
        return writes.allSatisfy { trashWrites.contains($0) }
    }
}
