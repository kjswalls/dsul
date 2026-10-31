import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The end of day review retired on the web (ghost rows phase 2), but the
 * iPhone app still plans its nightly notification off eod_review_enabled and
 * has no switch of its own. `rituals.eod` is kept as that notification's off
 * switch until phase 3, drawn only for an account whose value was on when its
 * settings landed.
 */

const saves = vi.hoisted(() => [] as Array<{ userId: string; patch: Record<string, unknown> }>);

vi.mock('@/lib/settings-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settings-service')>();
  return {
    ...actual,
    saveSettings: (userId: string, patch: Record<string, unknown>) => {
      saves.push({ userId, patch });
    },
  };
});

import { useReminderStore, REMINDER_DEFAULTS } from '@/lib/reminder-store';
import { usePlannerStore } from '@/lib/planner-store';
import { settingById, type SettingCtx } from '@/lib/settings/manifest';
import { searchSettings } from '@/lib/settings/search';

const ctx: SettingCtx = { theme: 'system', setTheme: () => {}, userId: 'u1' };

beforeEach(() => {
  saves.length = 0;
  useReminderStore.setState({ ...REMINDER_DEFAULTS });
  usePlannerStore.setState({ userId: 'u1' });
});

describe('rituals.eod, the iPhone evening nudge off switch', () => {
  it('writes eod_review_enabled', () => {
    const record = settingById('rituals.eod')!;
    expect(record.dbColumn).toBe('eod_review_enabled');
    useReminderStore.setState({ iphoneEveningNudge: true, iphoneEveningNudgeShown: true });
    expect(record.read(ctx)).toBe(true);
    record.write(false, ctx);
    expect(useReminderStore.getState().iphoneEveningNudge).toBe(false);
    expect(saves).toEqual([{ userId: 'u1', patch: { eod_review_enabled: false } }]);
  });

  it('is hidden for an account that never had the review on', () => {
    const record = settingById('rituals.eod')!;
    expect(record.shownWhen?.(ctx)).toBe(false);
    const hits = searchSettings('iphone evening', ctx).settings.map((h) => h.record.id);
    expect(hits).not.toContain('rituals.eod');
  });

  it('stays drawn after it is turned off, so it does not vanish mid-click', () => {
    const record = settingById('rituals.eod')!;
    useReminderStore.setState({ iphoneEveningNudge: true, iphoneEveningNudgeShown: true });
    record.write(false, ctx);
    expect(record.shownWhen?.(ctx)).toBe(true);
    const hits = searchSettings('iphone evening', ctx).settings.map((h) => h.record.id);
    expect(hits).toContain('rituals.eod');
  });

  it('copy has no em dash', () => {
    const record = settingById('rituals.eod')!;
    expect(`${record.label} ${record.description}`).not.toMatch(/—/);
  });
});
