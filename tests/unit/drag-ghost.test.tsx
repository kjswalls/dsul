// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scrub } from '@/components/shell/drag-ghost';

describe('drag ghost twin', () => {
  it('strips identity, test hooks and dnd markers from the clone, keeping its look', () => {
    const row = document.createElement('div');
    row.innerHTML =
      '<div data-testid="item-card" data-item-id="t1" data-dnd-id="x" data-settle-key="k" tabindex="0" role="button" aria-label="Row" class="group flex px-2">' +
      '<button data-testid="item-complete-button" data-checked="true" class="h-4 w-4"></button>' +
      '<p id="title" class="font-content">Water the plants</p></div>';
    const el = row.firstElementChild!;
    scrub(el);
    expect(row.querySelector('[data-testid]')).toBeNull();
    expect(row.querySelector('[data-item-id],[data-dnd-id],[data-settle-key],[tabindex],[role],[aria-label],#title')).toBeNull();
    expect(el.className).toBe('group flex px-2');
    // The tick's drawn state is look, not identity: it stays.
    expect(row.querySelector('[data-checked="true"]')).not.toBeNull();
    expect(row.textContent).toBe('Water the plants');
  });

  it('leaves the slot hollow rather than fading the grabbed element (the lime rule)', () => {
    for (const f of [
      'components/primitives/task-row.tsx',
      'components/views/day-schedule.tsx',
      'components/views/project-block.tsx',
      'components/views/atlas/atlas-row.tsx',
    ]) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toMatch(/isDragging && 'drag-source'/);
      expect(src, f).not.toMatch(/isDragging && '[^']*opacity-/);
    }
  });
});
