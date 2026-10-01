import Foundation
import Observation

/// A stand-in for a planner item until the app talks to the server.
struct SampleItem: Identifiable, Hashable, Sendable {
    let id: UUID
    var title: String
    var durationMin: Int
    var startMin: Int?
    var project: String?
}

/// Sample data for the shell and the drag spike. No network, no persistence.
@Observable @MainActor
final class SamplePlanner {
    var scheduled: [SampleItem]
    var braindump: [SampleItem]
    var showBraindumpSheet = false

    init() {
        var n = 0
        func make(_ title: String, _ duration: Int, _ start: Int? = nil, _ project: String? = nil) -> SampleItem {
            n += 1
            return SampleItem(id: SamplePlanner.uuid(n), title: title, durationMin: duration, startMin: start, project: project)
        }
        scheduled = [
            make("Morning pages", 30, 7 * 60, "Writing"),
            make("Deep work: planner sync", 90, 9 * 60, "dsul"),
            make("Standup", 15, 11 * 60, "Work"),
            make("Lunch walk", 45, 12 * 60 + 30),
            make("Review PRs", 60, 14 * 60, "dsul"),
            make("Gym", 60, 17 * 60 + 30, "Health"),
            make("Cook dinner", 45, 19 * 60),
            make("Read", 30, 21 * 60 + 30),
        ]
        let durations = [15, 30, 45, 60, 90]
        let thoughts = [
            "Call the dentist", "Renew passport", "Draft the launch post", "Fix the bike light",
            "Plan the weekend", "Email Sam back", "Sort the photo backlog", "Buy coffee beans",
            "Try the new pasta recipe", "Back up the laptop", "Book a haircut", "Water the plants",
            "Outline the iOS onboarding", "Cancel the unused subscription", "Write a thank-you card",
            "Look into a standing desk", "Clean the inbox", "Pick up the parcel", "Stretch for 10 minutes",
            "Update the budget sheet", "Call Mum", "Return the library books", "Order printer ink",
            "Read the Swift drag docs", "Sketch the Organize page", "Charge the camera",
            "Fix the squeaky door", "Pay the electricity bill", "Plan Friday dinner", "Tidy the desk",
        ]
        braindump = thoughts.enumerated().map { i, t in make(t, durations[i % durations.count]) }
    }

    nonisolated static func uuid(_ n: Int) -> UUID {
        UUID(uuidString: String(format: "00000000-0000-0000-0000-%012d", n))!
    }

    func item(_ id: UUID?) -> SampleItem? {
        guard let id else { return nil }
        return scheduled.first { $0.id == id } ?? braindump.first { $0.id == id }
    }

    func isScheduled(_ id: UUID?) -> Bool {
        scheduled.contains { $0.id == id }
    }

    /// Moves a braindump item onto the grid, or moves a scheduled one.
    func schedule(_ id: UUID, startMin: Int) {
        if let i = braindump.firstIndex(where: { $0.id == id }) {
            var item = braindump.remove(at: i)
            item.startMin = startMin
            scheduled.append(item)
        } else if let i = scheduled.firstIndex(where: { $0.id == id }) {
            scheduled[i].startMin = startMin
        }
    }

    func capture(_ title: String) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        braindump.insert(SampleItem(id: UUID(), title: trimmed, durationMin: 30), at: 0)
    }

    /// Fills the day to 40 blocks, for the spike's "no hitches on a busy day" test.
    func stress() {
        var k = 1000
        while scheduled.count < 40 {
            k += 1
            let start = (scheduled.count * 35) % (23 * 60)
            scheduled.append(SampleItem(id: Self.uuid(k), title: "Block \(scheduled.count + 1)",
                                        durationMin: [15, 30, 45][k % 3], startMin: start))
        }
    }
}
