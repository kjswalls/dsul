import DsulCore
import Foundation

/// The sample planner behind "Try with sample data": the drag spike's day, a
/// morning routine (and an empty one), a season, a goal, and a braindump long
/// enough to scroll. Built as the web's own `Item`s, so the sample goes through
/// exactly the rules a signed-in day does. The hosted tests pin these titles,
/// counts and ids: change them there too.
enum SampleData {
    struct Contents {
        var items: [Item]
        var projects: [Project]
        var routines: [Routine]
        var seasons: [Season]
        var goals: [Goal]
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

        /// A sample project's id, from its name: `projects` below is made
        /// with it, and a row filed under a project carries it as its
        /// `projectId`, as a payload's row does.
        func sampleProjectId(_ name: String) -> String {
            return "sample-" + name.lowercased()
        }
        /// A task on `anchor`, filed under the hour's bucket when timed and
        /// under Anytime when not.
        func task(_ title: String, _ duration: Int, at start: Int? = nil, _ project: String? = nil,
                  order: Int = 0) -> Item {
            var bucket: DayBucket = .anytime
            if let start { bucket = DayBucket.owning(minute: start) }
            return Item(id: next(), type: "task", title: title, status: "pending", startDate: day,
                        startTime: start.map { minutesToTime($0) }, timeBucket: bucket.rawValue,
                        project: project, projectId: project.map(sampleProjectId), duration: duration, order: order,
                        isScheduled: true)
        }
        func habit(_ title: String, _ frequency: String, days: [Int]? = nil, streak: Int, doneDaysAgo: [Int],
                   _ project: String? = nil, bucket: DayBucket) -> Item {
            return Item(id: next(), type: "habit", title: title, status: "pending", timeBucket: bucket.rawValue,
                        repeatFrequency: frequency, project: project, projectId: project.map(sampleProjectId),
                        duration: 15, streak: streak, repeatDays: days,
                        completedDates: doneDaysAgo.map { anchor.adding(days: -$0).description })
        }

        // The day's blocks first: the drag spike's tests read scheduled[0].
        var blocks = [
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
        var untimed = [
            task("Reply to Avery about pricing", 15, "Work", order: 1),
            task("Review design PR", 30, "Work", order: 2),
            task("Groceries", 45, "Home", order: 3),
        ]
        var routineHabits = [
            habit("Meds", "daily", streak: 41, doneDaysAgo: [0, 1, 2], bucket: .morning),
            habit("Stretch 10 min", "daily", streak: 12, doneDaysAgo: [0, 1], bucket: .morning),
            habit("Journal", "daily", streak: 3, doneDaysAgo: [1, 2, 3], bucket: .morning),
        ]
        let otherHabits = [
            habit("Plan tomorrow", "weekdays", streak: 6, doneDaysAgo: [1], bucket: .evening),
            habit("Water the plants", "custom", days: [0, 3], streak: 2, doneDaysAgo: [], "Home", bucket: .anytime),
        ]

        // What the item sheet shows beyond the row: notes, a priority, a
        // reminder. Set on rows the tests already pin, so no title, count or
        // id moves.
        blocks[1].notes = "Three bets on one page. Pull the September numbers before writing any of them."
        blocks[1].priority = "high"
        blocks[5].priority = "medium"
        blocks[5].reminderTime = "14:45"
        untimed[0].priority = "high"
        untimed[2].notes = "Oat milk, eggs, coffee beans, basil."
        routineHabits[0].reminderTime = "08:00"
        routineHabits[0].reminderAnchor = "I pour my coffee"
        routineHabits[2].notes = "One page: what went well, what didn't, what's next."
        // Standup is filed "work", lowercase, with no link to Work's row, as a
        // name written before project ids (or by hand) can be. The project menu
        // checks Work by its folded name, and picking Work relinks it: the chip
        // then reads "Work".
        blocks[2].project = "work"
        blocks[2].projectId = nil

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

        // The roadmap's subtasks, made last so every id above keeps its
        // number. Undated and unscheduled, as the web adds them, and kept off
        // every day and the braindump (DsulCore `project`): they show only in
        // their parent's sheet.
        let roadmap = blocks[1].id.uuidString.lowercased()
        let subtasks = [
            Item(id: next(), type: "task", title: "Pull the September numbers", status: "completed",
                 parentItemId: roadmap, order: 0, isScheduled: false),
            Item(id: next(), type: "task", title: "Write the three bets", status: "pending",
                 parentItemId: roadmap, order: 1, isScheduled: false),
        ]

        // A repeating task with no day: monthly on the 1st, waiting in the
        // braindump (after the thoughts), on no day, the Repeat chip's Monthly
        // case. Made after the subtasks so no id above moves.
        let payRent = Item(id: next(), type: "task", title: "Pay rent", status: "pending",
                           repeatFrequency: "monthly", duration: 15,
                           order: untimed.count + 1 + thoughts.count, repeatMonthDay: 1,
                           isScheduled: false)

        // A goal's own items (Organize's Goals section), made after Pay rent
        // so no id above moves, and none on `anchor`, so the day's counts
        // stay as the tests pin them: three dated milestones (one reached),
        // filed under Anytime so they stay out of the braindump and off the
        // grid, and a check-in that repeats on the weekday three days ahead,
        // last done four days back, so it never lands on `anchor`.
        func milestone(_ title: String, inDays days: Int, done: Bool) -> Item {
            return Item(id: next(), type: "task", title: title, status: done ? "completed" : "pending",
                        startDate: anchor.adding(days: days).description, timeBucket: DayBucket.anytime.rawValue,
                        duration: 60, isScheduled: true)
        }
        let milestones = [
            milestone("Run 5K without stopping", inDays: -14, done: true),
            milestone("Run a 10K", inDays: 10, done: false),
            milestone("Run 16K", inDays: 45, done: false),
        ]
        let checkinStart = anchor.adding(days: -4)
        let checkin = Item(id: next(), type: "task", title: "Weekly run review", status: "pending",
                           startDate: checkinStart.description, timeBucket: DayBucket.anytime.rawValue,
                           repeatFrequency: "custom", duration: 15, isScheduled: true,
                           repeatDays: [checkinStart.weekday], completedDates: [checkinStart.description])
        // Gym is the goal's supporting work: an item already on the day, so
        // nothing new lands on it.
        let gym = blocks[6].id

        // Projects keep no icon or colour, so their tiles derive from their
        // names, as an older project's do on the web.
        let projects = ["Work", "Home", "Writing", "dsul", "Health"].map { name in
            Project(id: sampleProjectId(name), name: name)
        }
        let routines = [
            Routine(id: "sample-morning-routine", name: "Morning routine", icon: "icon:Sunrise",
                    color: "var(--accent-6)", sortOrder: 0, usualTime: "07:00", itemIds: routineHabits.map(\.id)),
            // A second routine with nothing in it yet, so a routine member's menu has
            // another routine to toggle, and a season holding Journal, the Season
            // chip's case. Autumn follows no dates (state auto, none set), so it is
            // live every day and hides nothing.
            Routine(id: "sample-wind-down", name: "Wind down", icon: "icon:Moon", color: "var(--accent-4)",
                    sortOrder: 1, usualTime: "21:30", itemIds: []),
        ]
        let seasons = [
            Season(id: "sample-autumn", name: "Autumn", icon: "icon:Leaf", color: "var(--accent-1)", sortOrder: 0,
                   itemIds: [routineHabits[2].id]),
        ]
        let goals = [
            Goal(id: "sample-half-marathon", name: "Run a half marathon",
                 why: "The long runs are the best part of the week.", icon: "icon:Target",
                 color: "var(--accent-3)", sortOrder: 0, startsOn: anchor.adding(days: -30).description,
                 targetOn: anchor.adding(days: 120).description, memberIds: [gym],
                 milestoneIds: milestones.map(\.id), checkinIds: [checkin.id]),
        ]
        return Contents(items: blocks + untimed + routineHabits + otherHabits + braindump + subtasks + [payRent]
                            + milestones + [checkin],
                        projects: projects, routines: routines, seasons: seasons, goals: goals)
    }
}
