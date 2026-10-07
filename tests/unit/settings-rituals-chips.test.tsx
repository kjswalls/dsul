import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * The Rituals pane's dependents, drawn as chips under their root — rendered,
 * against the real SettingsShell, the real manifest and the real stores.
 *
 * What is pinned, in the order it would break:
 *
 *   1. A dependent exists while its ancestors are on and is ABSENT otherwise —
 *      not a disabled row, and not indented behind a rail (the old
 *      `ml-3 border-l pl-4` wrapper is the regression).
 *   2. A merged chip is two records and writes them as two: "Off" writes the
 *      switch alone, so the value is still there when it comes back on; a
 *      value writes the value, then the switch.
 *   3. A merged chip is modified by the half that is in force, and its reset
 *      returns both halves and says so in the notice region.
 *   4. A time chip is a real, labelled time input, and a cleared one writes
 *      nothing.
 *   5. A deep link to a dependent lands on whatever is drawn for it — the
 *      merged chip for its value half, the nearest shown ancestor when hidden.
 *   6. Extension fields follow their toggle the same way, as flat rows.
 */

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
    }),
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));
vi.mock('@/lib/settings-service', () => ({
  saveSettings: vi.fn(async () => {}),
  flushSettings: vi.fn(async () => {}),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/rituals',
  useSearchParams: () => new URLSearchParams(),
}));

import { SettingsShell } from '@/components/settings/settings-shell';
import { SettingChip } from '@/components/settings/setting-chip';
import {
  settingById,
  type PaneId,
  type SettingCtx,
  type SettingRecord,
} from '@/lib/settings/manifest';
import { useMorningStore } from '@/lib/morning-store';
import { useEODStore } from '@/lib/eod-store';
import { useReminderStore, REMINDER_DEFAULTS } from '@/lib/reminder-store';
import { useExtensionsStore } from '@/lib/extensions-store';

const openLedger = vi.fn();

/**
 * The page rebuilds ctx whenever a store it reads changes; a static ctx would
 * leave the shell drawing the state before a click. This does the same with
 * the four stores the panes under test read.
 */
function Harness({ pane, focusId }: { pane: PaneId; focusId?: string }) {
  // Subscribed for the re-render alone; the records read the stores directly.
  useMorningStore();
  useEODStore();
  useReminderStore();
  useExtensionsStore();
  const ctx: SettingCtx = {
    theme: 'system',
    setTheme: () => {},
    userId: 'test-user',
    actions: {
      openBugReport: () => {},
      replayTour: () => {},
      signOut: () => {},
      openLedger,
      deleteAccount: () => {},
    },
  };
  return (
    <SettingsShell
      pane={pane}
      ctx={ctx}
      focusId={focusId}
      isMobile={false}
      onOpenDestination={() => {}}
    />
  );
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-setting-row="${id}"]`);
const alias = (id: string) => document.querySelector<HTMLElement>(`[data-setting-alias="${id}"]`);

function spyWrite(id: string) {
  return vi.spyOn(settingById(id)!, 'write');
}

beforeEach(() => {
  useMorningStore.setState({
    morningCheckEnabled: true,
    morningAutoAgeEnabled: false,
    morningAutoAgeDays: 30,
  });
  useEODStore.setState({ eodReviewEnabled: false, eodReviewTime: '21:00' });
  useReminderStore.setState({ ...REMINDER_DEFAULTS });
  useExtensionsStore.setState({ available: true, configsLoaded: true, enabled: {}, configs: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  openLedger.mockReset();
  useExtensionsStore.getState().reset();
  useReminderStore.setState({ ...REMINDER_DEFAULTS });
});

describe('dependents follow their ancestors', () => {
  it('draws no chip and no dependent hook while the root is off', () => {
    act(() => useMorningStore.setState({ morningCheckEnabled: false, morningAutoAgeEnabled: true }));
    render(<Harness pane="rituals" />);
    expect(row('rituals.morningCheck')).not.toBeNull();
    for (const id of [
      'rituals.autoAge',
      'rituals.autoAgeDays',
      'rituals.eodTime',
      'rituals.lastCall',
      'rituals.lastCallTime',
      'rituals.stakesTime',
      'rituals.ledger',
    ]) {
      expect(row(id), id).toBeNull();
      expect(alias(id), id).toBeNull();
    }
  });

  it('draws the chips once the root is on, with no indent or rail anywhere', () => {
    act(() => {
      useEODStore.setState({ eodReviewEnabled: true });
      useReminderStore.setState({ remindersEnabled: true, stakesEnabled: true });
    });
    render(<Harness pane="rituals" />);
    expect(row('rituals.autoAge')).not.toBeNull();
    expect(alias('rituals.autoAgeDays')).toBe(row('rituals.autoAge'));
    expect(row('rituals.eodTime')).not.toBeNull();
    expect(alias('rituals.lastCallTime')).toBe(row('rituals.lastCall'));
    expect(row('rituals.stakesTime')).not.toBeNull();
    expect(row('rituals.ledger')).not.toBeNull();
    expect(document.querySelector('.border-l, .ml-3, .pl-4')).toBeNull();
  });

  it('flips the chips in and out as the root changes', async () => {
    render(<Harness pane="rituals" />);
    expect(row('rituals.eodTime')).toBeNull();
    act(() => useEODStore.setState({ eodReviewEnabled: true }));
    await waitFor(() => expect(row('rituals.eodTime')).not.toBeNull());
  });
});

describe('a merged chip', () => {
  const chip = () => screen.getByTestId('setting-rituals.autoAge');

  it('reads the value when on and Off when off', () => {
    const view = render(<Harness pane="rituals" />);
    expect(chip()).toHaveAccessibleName('Auto-clear stale items: Off');
    expect(chip().textContent).toContain('Off');

    act(() => useMorningStore.setState({ morningAutoAgeEnabled: true }));
    view.rerender(<Harness pane="rituals" />);
    expect(chip()).toHaveAccessibleName('Auto-clear stale items: after 30 days');
    expect(chip().textContent).toContain('Auto-clear stale items');
    expect(chip().textContent).toContain('after 30 days');
  });

  it('picking a value writes the value, then the switch', async () => {
    const days = spyWrite('rituals.autoAgeDays');
    const toggle = spyWrite('rituals.autoAge');
    render(<Harness pane="rituals" />);

    fireEvent.click(chip());
    fireEvent.click(await screen.findByRole('button', { name: '60 days' }));

    expect(days).toHaveBeenCalledWith('60', expect.anything());
    expect(toggle).toHaveBeenCalledWith(true, expect.anything());
    expect(days.mock.invocationCallOrder[0]).toBeLessThan(toggle.mock.invocationCallOrder[0]);
    expect(useMorningStore.getState()).toMatchObject({
      morningAutoAgeEnabled: true,
      morningAutoAgeDays: 60,
    });
  });

  it('Off writes the switch alone and keeps the value', async () => {
    act(() => useMorningStore.setState({ morningAutoAgeEnabled: true, morningAutoAgeDays: 60 }));
    const days = spyWrite('rituals.autoAgeDays');
    const toggle = spyWrite('rituals.autoAge');
    render(<Harness pane="rituals" />);

    fireEvent.click(chip());
    fireEvent.click(await screen.findByRole('button', { name: 'Off' }));

    expect(toggle).toHaveBeenCalledWith(false, expect.anything());
    expect(days).not.toHaveBeenCalled();
    expect(useMorningStore.getState().morningAutoAgeDays).toBe(60);
  });

  it('is modified by the half in force, and marks it outside any fade', () => {
    // A changed days count under "Off" is not in force.
    act(() => useMorningStore.setState({ morningAutoAgeEnabled: false, morningAutoAgeDays: 60 }));
    const view = render(<Harness pane="rituals" />);
    expect(row('rituals.autoAge')!.querySelector('[data-chip-modified]')).toBeNull();

    act(() => useMorningStore.setState({ morningAutoAgeEnabled: true }));
    view.rerender(<Harness pane="rituals" />);
    const dot = row('rituals.autoAge')!.querySelector('[data-chip-modified]');
    expect(dot).not.toBeNull();
    // The lime never composites through a parent's opacity.
    for (let el = dot!.parentElement; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/(^|\s)opacity-/);
    }
    // A sibling of the trigger, not a child of it — the trigger is what dims.
    expect(chip().contains(dot)).toBe(false);
  });

  it('reset returns both halves and names the chip in the notice', async () => {
    act(() => useMorningStore.setState({ morningAutoAgeEnabled: true, morningAutoAgeDays: 60 }));
    const days = spyWrite('rituals.autoAgeDays');
    const toggle = spyWrite('rituals.autoAge');
    render(<Harness pane="rituals" />);

    fireEvent.click(chip());
    // Named for the chip: the fixture keeps the morning check ON (its
    // dependents only draw under it), and since rituals went opt-in (054) ON
    // is itself off-default, so that row wears a reset of its own.
    fireEvent.click(
      await screen.findByRole('button', { name: /^Auto-clear stale items is changed from its default/ })
    );

    expect(toggle).toHaveBeenCalledWith(false, expect.anything());
    expect(days).toHaveBeenCalledWith('30', expect.anything());
    expect(toggle.mock.invocationCallOrder[0]).toBeLessThan(days.mock.invocationCallOrder[0]);
    expect(screen.getByTestId('settings-notice').textContent).toBe(
      'Auto-clear stale items reset to Off'
    );
  });

  it('the time half lives in the picker as a labelled time input', async () => {
    act(() => useReminderStore.setState({ remindersEnabled: true, lastCallEnabled: true }));
    const time = spyWrite('rituals.lastCallTime');
    render(<Harness pane="rituals" />);

    const trigger = screen.getByTestId('setting-rituals.lastCall');
    expect(trigger).toHaveAccessibleName('Last call: 8:30 pm');
    fireEvent.click(trigger);
    const input = (await screen.findByLabelText('Last call at')) as HTMLInputElement;
    expect(input.type).toBe('time');
    fireEvent.change(input, { target: { value: '' } });
    expect(time).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '21:15' } });
    expect(time).toHaveBeenCalledWith('21:15', expect.anything());
  });
});

describe('single chips', () => {
  it('a lone time is a real time input, named by its own label, that ignores a cleared value', () => {
    act(() => useEODStore.setState({ eodReviewEnabled: true }));
    const write = spyWrite('rituals.eodTime');
    render(<Harness pane="rituals" />);

    const input = screen.getByLabelText('Review at') as HTMLInputElement;
    expect(input.type).toBe('time');
    expect(input.value).toBe('21:00');
    expect(input.dataset.setting).toBe('eod_review_time');

    fireEvent.change(input, { target: { value: '' } });
    expect(write).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '22:30' } });
    expect(write).toHaveBeenCalledWith('22:30', expect.anything());
  });

  it('a modified lone time grows a reset with the row reset’s wording', () => {
    act(() => useEODStore.setState({ eodReviewEnabled: true, eodReviewTime: '22:00' }));
    render(<Harness pane="rituals" />);
    const chip = row('rituals.eodTime')!;
    fireEvent.click(within(chip).getByRole('button', { name: /changed from its default/ }));
    expect(useEODStore.getState().eodReviewTime).toBe('21:00');
    expect(screen.getByTestId('settings-notice').textContent).toMatch(/reset to/i);
  });

  it('the ledger chip opens the ledger', () => {
    act(() => useReminderStore.setState({ stakesEnabled: true }));
    render(<Harness pane="rituals" />);
    fireEvent.click(screen.getByTestId('setting-rituals.ledger'));
    expect(openLedger).toHaveBeenCalledTimes(1);
  });
});

describe('deep links to a dependent', () => {
  it('rings the merged chip for its value half', async () => {
    act(() => useReminderStore.setState({ remindersEnabled: true, lastCallEnabled: true }));
    render(<Harness pane="rituals" focusId="rituals.lastCallTime" />);
    const chip = row('rituals.lastCall')!;
    await waitFor(() => expect(chip.dataset.highlight).toBe('true'));
    expect(document.activeElement).toBe(chip);
  });

  it('rings the nearest shown ancestor when the dependent is hidden', async () => {
    render(<Harness pane="rituals" focusId="rituals.lastCallTime" />);
    expect(alias('rituals.lastCallTime')).toBeNull();
    const parent = row('rituals.reminders')!;
    await waitFor(() => expect(parent.dataset.highlight).toBe('true'));
  });

  it('waits out a loading ancestor instead of ringing the wrong row', async () => {
    act(() =>
      useExtensionsStore.setState({ configsLoaded: false, enabled: { beeminder: true } })
    );
    render(<Harness pane="extensions/beeminder" focusId="extensions.beeminder.username" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(row('extensions.beeminder')!.dataset.highlight).toBeUndefined();

    act(() => useExtensionsStore.setState({ configsLoaded: true }));
    await waitFor(() =>
      expect(row('extensions.beeminder.username')!.dataset.highlight).toBe('true')
    );
  });
});

describe('a deep link behind a load that never finishes', () => {
  afterEach(() => vi.useRealTimers());

  it('settles on the drawn pending toggle after the wait, and strips ?focus=', async () => {
    // A failed extensions hydrate returns without ever setting configsLoaded.
    act(() =>
      useExtensionsStore.setState({ configsLoaded: false, enabled: { beeminder: true } })
    );
    const replace = vi.spyOn(window.history, 'replaceState');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<Harness pane="extensions/beeminder" focusId="extensions.beeminder.username" />);
    act(() => vi.advanceTimersByTime(1000));
    expect(replace).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(2500));
    vi.useRealTimers();
    const toggle = row('extensions.beeminder')!;
    await waitFor(() => expect(toggle.dataset.highlight).toBe('true'));
    expect(document.activeElement).toBe(toggle);
    expect(replace).toHaveBeenCalled();
  });
});

describe('a chip that cannot be used yet', () => {
  const ctx = {} as SettingCtx;
  const timeRecord = (over: Partial<SettingRecord>): SettingRecord => ({
    id: 'test.time',
    pane: 'rituals',
    label: 'Ring at',
    description: 'When it rings.',
    control: 'time',
    dependsOn: 'test.root',
    keywords: [],
    read: () => '07:00',
    write: vi.fn(),
    defaultValue: '07:00',
    ...over,
  });
  const draw = (record: SettingRecord) =>
    render(
      <SettingChip
        spec={{ kind: 'single', record }}
        ctx={ctx}
        highlight={null}
        onWrite={() => {}}
        onReset={() => {}}
        onResetMany={() => {}}
      />
    );

  it('a pending lone time shows Loading, not an editable default', () => {
    draw(timeRecord({ pending: () => true }));
    expect(document.querySelector('input[type="time"]')).toBeNull();
    const status = screen.getByTestId('setting-test.time');
    expect(status.textContent).toMatch(/Loading…/);
    const desc = document.getElementById(status.getAttribute('aria-describedby')!)!;
    expect(desc.textContent).toMatch(/Still loading/);
  });

  it('an unavailable chip says why in the description its control points at', () => {
    draw(timeRecord({ unavailable: () => 'needs a database update' }));
    const input = screen.getByLabelText('Ring at') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    const desc = document.getElementById(input.getAttribute('aria-describedby')!)!;
    expect(desc.textContent).toContain('When it rings.');
    expect(desc.textContent).toContain('Unavailable: needs a database update');
  });
});

describe('extension panes', () => {
  const fields = [
    'extensions.beeminder.username',
    'extensions.beeminder.goals',
    'extensions.beeminder.authToken',
  ];

  it('hide the fields while the toggle is off', () => {
    render(<Harness pane="extensions/beeminder" />);
    expect(row('extensions.beeminder')).not.toBeNull();
    for (const id of fields) expect(row(id), id).toBeNull();
  });

  it('hide them while the toggle is still loading', () => {
    act(() => useExtensionsStore.setState({ configsLoaded: false, enabled: { beeminder: true } }));
    render(<Harness pane="extensions/beeminder" />);
    for (const id of fields) expect(row(id), id).toBeNull();
  });

  it('show them as flat rows on the toggle’s own left edge once it is on', () => {
    act(() => useExtensionsStore.setState({ enabled: { beeminder: true } }));
    render(<Harness pane="extensions/beeminder" />);
    for (const id of fields) {
      const el = row(id);
      expect(el, id).not.toBeNull();
      for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
        expect(node.className, id).not.toMatch(/(^|\s)(ml-|pl-|border-l)/);
      }
    }
    expect((screen.getByLabelText('Auth token') as HTMLInputElement).type).toBe('password');
  });
});
