import BackgroundTasks
import Foundation

/// The BGAppRefreshTask that re-plans while dsul isn't opened
/// (`app.dsul.ios.reconcile`, in project.yml's BGTaskSchedulerPermittedIdentifiers).
/// A held slot comes back, a day ticked on the Mac is taken out of the
/// shade, and a tap left in the outbox is sent. iOS decides when it runs, if
/// at all; this only asks for no sooner than the next local midnight (when
/// the day's held slots are due back) or six hours, whichever is first.
///
/// With no planner kept on disk (APIClient's rule stands; the plan's
/// PlannerCache is not built), each run fetches the planner, so one with no
/// network plans nothing and the standing triggers keep ringing.
enum BackgroundRefresh {
    static let identifier = "app.dsul.ios.reconcile"

    /// At launch, before it finishes (BGTaskScheduler's rule).
    static func register() {
        _ = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            let box = TaskBox(task)
            MainActor.assumeIsolated {
                run(box)
            }
        }
    }

    /// Leaving the screen: asks for the next run.
    static func schedule(now: Date = Date()) {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = nextBegin(after: now)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Five past the next local midnight, or six hours on, whichever is first.
    static func nextBegin(after now: Date, calendar: Calendar = .current) -> Date {
        let later = now.addingTimeInterval(6 * 3600)
        guard let midnight = calendar.nextDate(after: now, matching: DateComponents(hour: 0, minute: 5),
                                               matchingPolicy: .nextTime)
        else { return later }
        return min(later, midnight)
    }

    @MainActor
    private static func run(_ box: TaskBox) {
        schedule()
        let work = Task { @MainActor in
            let planned = await NotificationHub.shared.backgroundRefresh()
            box.task.setTaskCompleted(success: planned)
        }
        box.task.expirationHandler = {
            work.cancel()
        }
    }
}

/// A BGTask carried into the work that completes it. It is only touched on
/// the main queue (the handler is registered `using: .main`).
private final class TaskBox: @unchecked Sendable {
    let task: BGTask

    init(_ task: BGTask) {
        self.task = task
    }
}
