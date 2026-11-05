import { describe, expect, it } from 'vitest';

import { SETTINGS, isExtensionPane, type SettingRecord } from '@/lib/settings/manifest';

/**
 * A description is one line under its label (46ch at text-xs is about 58
 * characters of dsul's copy), and the rest of it goes in `more`, behind the
 * row's More. Kirby's call for beta, 2026-11-05: a pane of grey paragraphs is
 * what made Settings read as scattered.
 *
 * Two kinds are let off. An extension's own switch says its description only
 * to a screen reader on its pane (the hero above already says it), and a
 * Keyboard row appends where a binding works, which is the row's point.
 */
const LIMIT = 58;

function exempt(record: SettingRecord): boolean {
  if (record.id.startsWith('keys.')) return true;
  return isExtensionPane(record.pane) && record.control === 'switch' && !record.dependsOn;
}

describe('settings descriptions are one line', () => {
  it.each(SETTINGS.filter((r) => r.description && !exempt(r)).map((r) => [r.id, r.description!] as const))(
    '%s',
    (_id, description) => {
      expect(description.length).toBeLessThanOrEqual(LIMIT);
    }
  );

  it('a More always follows a description', () => {
    for (const r of SETTINGS) if (r.more) expect(r.description, r.id).toBeTruthy();
  });
});
