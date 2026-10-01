import Testing
@testable import Dsul

@MainActor
@Suite struct SamplePlannerTests {
    @Test func schedulingMovesAnItemOutOfTheBraindump() {
        let planner = SamplePlanner()
        let item = planner.braindump[0]
        let before = planner.scheduled.count
        planner.schedule(item.id, startMin: 9 * 60 + 15)
        #expect(!planner.braindump.contains { $0.id == item.id })
        #expect(planner.scheduled.count == before + 1)
        #expect(planner.item(item.id)?.startMin == 555)
        #expect(planner.isScheduled(item.id))
    }

    @Test func reschedulingMovesABlock() {
        let planner = SamplePlanner()
        let block = planner.scheduled[0]
        planner.schedule(block.id, startMin: 600)
        #expect(planner.item(block.id)?.startMin == 600)
        #expect(planner.scheduled.count == 8)
    }

    @Test func captureAddsToTheTopAndIgnoresBlanks() {
        let planner = SamplePlanner()
        let count = planner.braindump.count
        planner.capture("  New thought ")
        planner.capture("   ")
        #expect(planner.braindump.count == count + 1)
        #expect(planner.braindump[0].title == "New thought")
    }

    @Test func stressFillsTheDayToFortyBlocks() {
        let planner = SamplePlanner()
        planner.stress()
        #expect(planner.scheduled.count == 40)
        #expect(planner.scheduled.allSatisfy { ($0.startMin ?? -1) >= 0 })
    }

    @Test func sampleIdsAreStable() {
        #expect(SamplePlanner().braindump[0].id == SamplePlanner().braindump[0].id)
    }

    @Test func dragStateSnapsTheGhost() {
        let drag = ScheduleDrag()
        drag.begin(itemID: nil, durationMin: 60, detent: .medium)
        drag.setContentY(712.5)  // 09:30 at 75pt an hour
        #expect(drag.ghostStartMin == 540)
        drag.reset()
        #expect(drag.ghostStartMin == nil)
        #expect(drag.phase == "idle")
    }
}
