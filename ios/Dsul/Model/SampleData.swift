import DsulCore
import Foundation

/// The sample planner behind "Try with sample data": the drag spike's day, a
/// morning routine, and a braindump long enough to scroll. Built as the web's
/// own `Item`s, so the sample goes through exactly the rules a signed-in day
/// does. The hosted tests pin these titles, counts and ids: change them there
/// too.
enum SampleData {
    struct Contents {
        var items: [Item]
        var projects: [Project]
        var routines: [Routine]
    }

    /// Stable ids, so a test can find the same row on two planners.
    static func uuid(_ n: Int) -> UUID {
        return UUID(uuidString: String(format: "00000000-0000-0000-0000-%012d", n))!
    }

    static func make(today anchor: DayString) -> Contents {
        var n = 0
        func next() -> UUID {
            n += 1
            return uuid(n)
        }
        let day = anchor.description

        /// A task on `anchor`, filed under the hour's bucket when timed and
        /// under Anytime when not.
        func task(_ title: String, _ duration: Int, at start: Int? = nil, _ project: String? = nil,
                  order: Int = 0) -> Item {
            var bucket: DayBucket = .anytime
            if let start { bucket = DayBucket.owning(minute: start) }
            return Item(id: next(), type: "task", title: title, status: "pending", startDate: day,
                        startTime: start.map { minutesToTime($0) }, timeBucket: bucket.rawValue,
                        project: project, duration: duration, order: order, isScheduled: true)
        }
        func habit(_ title: String, _ frequency: String, days: [Int]? = nil, streak: Int, doneDaysAgo: [Int],
                   _ project: String? = nil, bucket: DayBucket) -> Item {
            return Item(id: next(), type: "habit", title: title, status: "pending", timeBucket: bucket.rawValue,
                        repeatFrequency: frequency, project: project, duration: 15, streak: streak,
                        repeatDays: days,
                        completedDates: doneDaysAgo.map { anchor.adding(days: -$0).description })
        }

        // The day's blocks first: the drag spike's tests read scheduled[0].
        let blocks = [
            task("Morning pages", 30, at: 7 * 60, "Writing"),
            task("Draft Q4 roadmap", 120, at: 9 * 60, "Work"),
            task("Standup", 15, at: 11 * 60 + 15, "Work"),
            task("Lunch walk", 45, at: 12 * 60 + 30),
            task("Review PRs", 60, at: 13 * 60 + 30, "dsul"),
            task("Call the dentist", 15, at: 15 * 60, "Home"),
            task("Gym", 60, at: 17 * 60 + 30, "Health"),
            task("Cook dinner", 45, at: 19 * 60, "Home"),
            task("Read", 30, at: 21 * 60 + 30),
        ]
        let untimed = [
            task("Reply to Avery about pricing", 15, "Work", order: 1),
            task("Review design PR", 30, "Work", order: 2),
            task("Groceries", 45, "Home", order: 3),
        ]
        let routineHabits = [
            habit("Meds", "daily", streak: 41, doneDaysAgo: [0, 1, 2], bucket: .morning),
            habit("Stretch 10 min", "daily", streak: 12, doneDaysAgo: [0, 1], bucket: .morning),
            habit("Journal", "daily", streak: 3, doneDaysAgo: [1, 2, 3], bucket: .morning),
        ]
        let otherHabits = [
            habit("Plan tomorrow", "weekdays", streak: 6, doneDaysAgo: [1], bucket: .evening),
            habit("Water the plants", "custom", days: [0, 3], streak: 2, doneDaysAgo: [], "Home", bucket: .anytime),
        ]

        let durations = [15, 30, 45, 60, 90]
        let thoughts = [
            "Call the bank", "Renew passport", "Draft the launch post", "Fix the bike light",
            "Plan the weekend", "Email Sam back", "Sort the photo backlog", "Buy coffee beans",
            "Try the new pasta recipe", "Back up the laptop", "Book a haircut", "Repot the fern",
            "Outline the iOS onboarding", "Cancel the unused subscription", "Write a thank-you card",
            "Look into a standing desk", "Clean the inbox", "Pick up the parcel", "Stretch for 10 minutes",
            "Update the budget sheet", "Call Mum", "Return the library books", "Order printer ink",
            "Read the Swift drag docs", "Sketch the Organize page", "Charge the camera",
            "Fix the squeaky door", "Pay the electricity bill", "Plan Friday dinner", "Tidy the desk",
        ]
        // Captured, not placed: no day, no bucket, not scheduled
        // (lib/braindump-members.ts), in capture order after the day's tasks.
        let braindump: [Item] = thoughts.enumerated().map { i, title in
            Item(id: next(), type: "task", title: title, status: "pending",
                 duration: durations[i % durations.count], order: untimed.count + 1 + i, isScheduled: false)
        }

        let projects = ["Work", "Home", "Writing", "dsul", "Health"].map { name in
            Project(id: "sample-" + name.lowercased(), name: name)
        }
        let routines = [
            Routine(id: "sample-morning-routine", name: "Morning routine", sortOrder: 0,
                    itemIds: routineHabits.map(\.id)),
        ]
        return Contents(items: blocks + untimed + routineHabits + otherHabits + braindump,
                        projects: projects, routines: routines)
    }
}
