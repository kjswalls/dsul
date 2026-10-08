import { describe, expect, it } from 'vitest';

import { isToastWorthy } from '@/hooks/use-undo-toast';

describe('isToastWorthy — completions', () => {
  it('announces a recurring task tick, which names its day', () => {
    // planner-store's recurring branch labels the tick with the date it was
    // ticked for; the one-shot "Complete task:" prefix never matched it.
    expect(isToastWorthy({ label: 'Complete task on 2026-09-25: Swim' })).toBe(true);
    expect(isToastWorthy({ label: 'Uncomplete task on 2026-09-25: Swim' })).toBe(true);
  });

  it('still announces one-shot tasks and habits', () => {
    expect(isToastWorthy({ label: 'Complete task: Swim' })).toBe(true);
    expect(isToastWorthy({ label: 'Complete habit: Stretch' })).toBe(true);
  });
});

describe('isToastWorthy — the hand-off', () => {
  it("announces the right-click menu's hand-off and take-back (lib/agent-handoff.ts)", () => {
    // A schedule block draws no agent badge, so the strip is the only trace.
    expect(isToastWorthy({ label: 'Hand off to OpenClaw: Book dentist' })).toBe(true);
    expect(isToastWorthy({ label: 'Take back from OpenClaw: Book dentist' })).toBe(true);
    expect(isToastWorthy({ label: 'Take back from AI: Draft the email' })).toBe(true);
  });

  it("still keeps the panel's plain edit quiet", () => {
    // The item panel's Assign/Unassign go through updateTask's default label.
    expect(isToastWorthy({ label: 'Edit task: Book dentist' })).toBe(false);
  });
});

describe('isToastWorthy — recipes', () => {
  it('a recipe run offers its one undo', () => {
    expect(isToastWorthy({ label: 'Recipe: After run' })).toBe(true);
  });
});
