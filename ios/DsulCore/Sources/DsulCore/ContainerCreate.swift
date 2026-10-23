import Foundation

// Port of lib/app-containers.ts' create (O11): what POST
// /api/app/containers/:kind takes (`RoutineCreateSchema`, `SeasonCreateSchema`,
// `GoalCreateSchema`, `ProjectCreateSchema`) and the container it makes
// (`containerCreateRecord`). Keep in step: a change there without the same
// change here is drift, and the phone's new container differs from the row
// the server inserts until the next fetch replaces it. Checked against the
// web by ContainerWritesFixtureTests (tests/fixtures/organize/container-writes.json
// `creates` and `createInvalid`), whose every row the route's own test also
// runs through the route, reading the row back as `after`.
//
// The body the phone sends, every member `.strict()` there:
// - `{"id":"<uuid>","name":"…"}`, plus `"icon":"icon:<Name>"` when it has a
//   glyph (lib/organize-copy.ts `CONTAINER_CREATE_COPY`'s starting one, which
//   `init?(_:id:name:today:)` sends);
// - a goal's may add `"startsOn":"yyyy-MM-dd"`, the day its window opens: the
//   create sheet sends its today in the account's zone, as the console's form
//   does.
// The optional keys are left out, never null (the schemas are `.optional()`,
// and a null is a 400). Nothing else: a new container is made empty, with no
// state, colour or member, so a create can never put back a list.
//
// The route answers `{"ok":true,"id":…}`, a retry of a create it already has
// (live or in the Trash) included; for a project, 409 `name_taken` (a live
// project folds to the name) or `name_in_trash` (one in the Trash holds it
// exactly), worded by `OrganizeCopy.refusal(code:for:)`; 404 for a kind with
// no route. The kind is the path (`ContainerRoutes.create`), never the body.

/// One new container, ready to encode: the body of POST
/// /api/app/containers/:kind, and the container it makes
/// (`containerCreateRecord`).
public struct ContainerCreateBody: Encodable, Sendable, Hashable {
    /// The kind whose route takes it.
    public let kind: OrganizeKind
    /// The phone's own id, lowercased, as the route's `Id` lowercases it, so
    /// the phone's new container and the row are one and a fetch sees no
    /// phantom change. Mint it as `UUID().uuidString.lowercased()`.
    public let id: String
    /// The name as typed. The route trims it (`storedName`).
    public let name: String
    /// The glyph, an `icon:<Name>` token, or nil to send none (a routine,
    /// season or goal then has no icon, and a project an empty `emoji`).
    public let icon: String?
    /// A goal's first day, or nil to send none. Only a goal takes one.
    public let startsOn: DayString?

    /// The body for `kind`'s route, or nil when its schema would refuse it
    /// (400): an id that is not a uuid (a sample id never reaches a route), a
    /// name that trims to nothing or to more than `EditLimits.outerTitle`
    /// UTF-16 units, an icon that is not `icon:` and 1 to 64 ASCII letters or
    /// digits, or a first day on anything but a goal, or one the route's
    /// `DateStrSchema` can't read (a year before 0100).
    public init?(kind: OrganizeKind, id: String, name: String, icon: String? = nil, startsOn: DayString? = nil) {
        guard isUUIDText(id) else { return nil }
        let trimmed = jsTrim(name).utf16.count
        guard trimmed >= 1, trimmed <= EditLimits.outerTitle else { return nil }
        if let icon, !isIconToken(icon) { return nil }
        if let startsOn, kind != .goal || !isSchemaDay(startsOn) { return nil }
        self.kind = kind
        self.id = id.lowercased()
        self.name = name
        self.icon = icon
        self.startsOn = startsOn
    }

    /// The create sheet's body (design §2 Q17, §6.3): the name as typed, the
    /// glyph the web's create form starts the kind with
    /// (`OrganizeCopy.createCopy(kind).icon`), and for a goal a window that
    /// opens `today`, the phone's today in the account's zone. Nil as for
    /// `init?(kind:id:name:icon:startsOn:)`.
    public init?(_ kind: OrganizeKind, id: String, name: String, today: DayString) {
        self.init(
            kind: kind, id: id, name: name, icon: OrganizeCopy.createCopy(kind).icon,
            startsOn: kind == .goal ? today : nil
        )
    }

    /// The container it makes, by kind and id.
    public var ref: ContainerRef { ContainerRef(kind: kind, id: id) }

    /// The name as the route stores it: trimmed, as its `Name` schema reads it.
    public var storedName: String { jsTrim(name) }

    private enum Key: String, CodingKey {
        case id, name, icon, startsOn
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Key.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        if let icon { try c.encode(icon, forKey: .icon) }
        if let startsOn { try c.encode(startsOn.description, forKey: .startsOn) }
    }
}

/// lib/app-containers.ts `containerCreateRecord`: the container a create
/// makes, decided once. The route inserts it; the phone makes the same one at
/// once, so its new page draws before the answer comes. Each is the console's
/// "+ New" with nothing picked, the web's defaults:
/// - a routine: live, no usual time, no members, no sort order (the server's
///   order puts it after the arranged ones);
/// - a season: `auto` with no dates, always on and hiding nothing;
/// - a goal: `active`, its window opening on `startsOn` when sent, no target,
///   members, milestones or check-ins;
/// - a project: its glyph in `emoji` (a project's glyph column), empty with
///   none.
/// The name is trimmed, as the route stores it. No colour: the name hash
/// colours it, as on the web.
public func containerCreateRecord(_ body: ContainerCreateBody) -> ContainerSnapshot {
    let name = body.storedName
    switch body.kind {
    case .routine:
        return .routine(Routine(id: body.id, name: name, icon: body.icon))
    case .season:
        return .season(Season(id: body.id, name: name, icon: body.icon, state: SeasonState.auto.rawValue))
    case .goal:
        return .goal(Goal(
            id: body.id, name: name, icon: body.icon, state: GoalState.active.rawValue,
            startsOn: body.startsOn?.description
        ))
    case .project:
        return .project(Project(id: body.id, name: name, emoji: body.icon ?? ""))
    }
}

extension ContainerRoutes {
    /// POST /api/app/containers/:kind: `/api/app/containers/<kind>`, the
    /// route's own segment (lowercase, singular).
    public static func create(_ kind: OrganizeKind) -> String {
        return "/api/app/containers/\(kind.rawValue)"
    }
}

/// lib/app-http.ts `UUID`: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`,
/// ASCII only (the `i` flag folds no other letter onto these).
func isUUIDText(_ s: String) -> Bool {
    let units = Array(s.utf16)
    guard units.count == 36 else { return false }
    for (i, u) in units.enumerated() {
        if i == 8 || i == 13 || i == 18 || i == 23 {
            guard u == 45 /* - */ else { return false }
            continue
        }
        let hex = (u >= 48 && u <= 57) || (u >= 65 && u <= 70) || (u >= 97 && u <= 102)
        guard hex else { return false }
    }
    return true
}
