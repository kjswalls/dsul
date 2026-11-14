import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArrowLeftToLine, ArrowRightToLine } from 'lucide-react';

import { braindumpArrowsFor } from '@/hooks/use-braindump-arrows';
import { LAYOUTS } from '@/lib/layout-themes';

describe('braindump arrows', () => {
  it('points at the braindump and away from it, as a mirrored pair', () => {
    for (const { value, slots } of LAYOUTS) {
      const { toBraindump, toDay } = braindumpArrowsFor(value);
      const right = slots.sidebar === 'pane-right';
      expect(toBraindump, value).toBe(right ? ArrowRightToLine : ArrowLeftToLine);
      expect(toDay, value).toBe(right ? ArrowLeftToLine : ArrowRightToLine);
    }
  });

  it('flips in Console, whose braindump is on the right', () => {
    expect(braindumpArrowsFor('console').toBraindump).toBe(ArrowRightToLine);
    expect(braindumpArrowsFor('classic').toBraindump).toBe(ArrowLeftToLine);
  });

  it('keeps the default way round on the phone, which ignores layouts', () => {
    expect(braindumpArrowsFor('console', true).toBraindump).toBe(ArrowLeftToLine);
  });

  it('is the only way the desktop rows draw the pair', () => {
    // A hard-coded arrow would point the wrong way in Console.
    for (const file of [
      'components/primitives/task-row.tsx',
      'components/views/day-schedule.tsx',
      'components/planner/item-context-menu.tsx',
      'components/planner/item-dialog.tsx',
      'components/planner/organize/member-row-actions.tsx',
    ]) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      expect(src, file).not.toMatch(/\bArrow(Left|Right)ToLine\b/);
      expect(src, file).toContain('useBraindumpArrows');
    }
  });
});
