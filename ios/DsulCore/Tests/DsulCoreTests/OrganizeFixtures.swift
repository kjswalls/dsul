import Foundation
import DsulCore

// The shared loader for tests/fixtures/organize/, which
// tests/unit/organize-fixtures.test.ts writes from the real TS
// (UPDATE_FIXTURES=1). Never edit the JSON by hand. Each suite decodes its
// own file with its own case types; container and item objects in the JSON
// are the app's camelCase shapes, so they decode as `Routine`, `Season`,
// `Goal`, `Project` and `Item`.

enum OrganizeFixtureError: Error {
    case notFound(String)
}

/// The bytes of tests/fixtures/organize/<file>. Walks up from this source
/// file to the repo root (see RecurrenceFixtureTests.swift).
func organizeFixtureData(_ file: String, here: String = #filePath) throws -> Data {
    let relative = "tests/fixtures/organize/\(file)"
    var dir: URL = URL(fileURLWithPath: here).deletingLastPathComponent()
    while dir.path != "/" && !dir.path.isEmpty {
        let candidate: URL = dir.appendingPathComponent(relative)
        if FileManager.default.fileExists(atPath: candidate.path) {
            return try Data(contentsOf: candidate)
        }
        dir = dir.deletingLastPathComponent()
    }
    throw OrganizeFixtureError.notFound("\(relative) above \(here)")
}

func loadOrganizeFixture<T: Decodable>(_ type: T.Type, _ file: String) throws -> T {
    return try JSONDecoder().decode(T.self, from: organizeFixtureData(file))
}

/// The fixture's lowercase id strings as uuids, failing on one that isn't.
func organizeUUIDs(_ ids: [String]) -> [UUID]? {
    let parsed = ids.compactMap { UUID(uuidString: $0) }
    return parsed.count == ids.count ? parsed : nil
}
