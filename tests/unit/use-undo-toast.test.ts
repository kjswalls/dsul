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
