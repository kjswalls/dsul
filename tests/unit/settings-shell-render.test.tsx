import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * The settings surface at the level it actually breaks: RENDERED.
 *
 * The pane-per-extension change shipped with thirteen new tests and every one
 * of them asserted the data layer. Reverting settings-shell's results loop from
 * ALL_PANES back to PANES — which drops every extension field out of the result
 * list while the rail keeps counting it — left the whole suite green. So did
 * changing a generated credential's `read` to return a token, because the only
 * secret-row test builds its own hand-written record.
 *
 * Both of those are rendering facts, so they are pinned here, against the real
 * SettingsShell and the real manifest. Three claims:
 *
 *   1. A query crosses into sub-panes and the hits are DRAWN, not merely
 *      counted — the rail number and the row count are the same number.
 *   2. No credential's value can reach the screen.
 *   3. The extension index and the extension's own pane say the same word about
 *      whether it is live.
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
  usePathname: () => '/settings/day',
  useSearchParams: () => new URLSearchParams(),
}));

import { SettingsShell } from '@/components/settings/settings-shell';
import { SETTINGS, type PaneId, type SettingCtx } from '@/lib/settings/manifest';
import { useExtensionsStore } from '@/lib/extensions-store';
import { useReminderStore } from '@/lib/reminder-store';

const ctx: SettingCtx = { theme: 'system', setTheme: () => {}, userId: 'test-user' };

function renderShell(pane: PaneId = 'day') {
  return render(
    <SettingsShell pane={pane} ctx={ctx} isMobile={false} onOpenDestination={() => {}} />
  );
}

/**
 * Type a query and wait for it to actually commit.
 *
 * The wait is on the live region rather than on any row: the pane's OWN rows
 * are in the DOM from first paint, so "some row exists" is true before the
 * 120ms debounce has fired and would let every assertion below run against the
 * unsearched page. The status text is computed from `results.total`, which is
 * the one number a broken results loop still gets right — so this settles even
 * in the failure mode these tests are here to catch.
 */
async function search(term: string) {
  fireEvent.change(screen.getByTestId('settings-search'), { target: { value: term } });
  await waitFor(
    () => expect(screen.getByTestId('settings-status').textContent).not.toBe(''),
    { timeout: 3000 }
  );
}

/** The rail's own number for a rail row — "Extensions 4" minus the name. */
function railCount(name: string): number {
  const rail = screen.getByRole('navigation', { name: 'Settings sections' });
  const button = Array.from(rail.querySelectorAll('button')).find((b) =>
    b.textContent?.startsWith(name)
  );
  expect(button, `no rail row named ${name}`).toBeTruthy();
  return Number(button!.textContent!.slice(name.length).trim());
}

beforeEach(() => {
  useExtensionsStore.setState({ available: true, configsLoaded: true, enabled: {}, configs: {} });
  useReminderStore.setState({ remindersEnabled: false, stakesEnabled: false });
});

afterEach(() => {
  cleanup();
  useExtensionsStore.getState().reset();
  useReminderStore.setState({ remindersEnabled: false, stakesEnabled: false });
});

describe('settings search renders what it counts', () => {
  it('draws the sub-pane hits, and draws exactly as many as the rail claims', async () => {
    // The regression this exists for: grouping the results by PANES instead of
    // ALL_PANES leaves the rail saying "Extensions 4" over an empty list,
    // because paneMatchCount rolls sub-panes up and the loop does not. The two
    // numbers agreeing is the whole assertion.
    renderShell();
    await search('beeminder');

    const rendered = document.querySelectorAll('[data-setting-row^="extensions.beeminder"]');
    expect(rendered.length).toBeGreaterThan(0);
    expect(railCount('Extensions')).toBe(rendered.length);
  });

  it('names the sub-pane a hit came from, parent included', async () => {
    // "Beeminder" alone does not say where to go; the group header is the only
    // place the result list explains where a row actually lives.
    renderShell();
    await search('beeminder');
    expect(
      screen.getByRole('heading', { name: /Extensions · Beeminder/ })
    ).toBeInTheDocument();
  });
});

describe('a credential never reaches the screen', () => {
  it('renders every secret row masked and empty, whatever read() returns', async () => {
    // read() returning '' is a contract, not an accident, and this is the half
    // of it a data-layer test cannot see: the shell passes record.read(ctx)
    // straight into the control as `value`, so a read that started answering
    // with the stored token would put the token in the box.
    // The GENERATED ones. beacon.apiKey wears the same variant but is a
    // device-local key the user typed and can read back, and it is `advanced`,
    // so it is neither this contract nor in these results.
    const secrets = SETTINGS.filter(
      (r) => r.textVariant === 'secret' && r.id.startsWith('extensions.')
    );
    expect(secrets.length).toBeGreaterThan(0);

    renderShell();
    // Every generated credential carries 'credential' as a keyword — the one
    // query that surfaces all of them at once. The toggles are all OFF here, so
    // this also pins that SEARCH still draws a dependent its pane would hide
    // (settings-shell rowFor): a hit the rail counts is a hit on screen.
    await search('credential');

    for (const record of secrets) {
      const row = document.querySelector<HTMLElement>(`[data-setting-row="${record.id}"]`);
      expect(row, `${record.id} did not render`).not.toBeNull();
      const input = row!.querySelector('input') as HTMLInputElement;
      expect(input.type, record.id).toBe('password');
      expect(input.value, record.id).toBe('');
      // And nothing echoed it back out in the row's own copy either.
      expect(row!.textContent, record.id).not.toContain('AC0123');
    }
  });
});

describe('the extension index and the extension pane agree', () => {
  it('says Unavailable, not On, for an extension its master switch has off', async () => {
    // Beeminder switched on with "Settle the day" off is an extension that is
    // enabled and doing nothing. The index used to read the enabled flag alone
    // and call that "On" while the pane one click away called it Unavailable —
    // and Beeminder is the one where being wrong costs money.
    act(() => {
      useExtensionsStore.setState({ enabled: { beeminder: true } });
      useReminderStore.setState({ stakesEnabled: false });
    });

    const index = renderShell('extensions');
    const row = () => document.querySelector<HTMLElement>('[data-extension-row="beeminder"]');
    expect(row()!.dataset.extensionState).toBe('Unavailable');

    // The pane's own word for the same state, from the same unavailable().
    index.unmount();
    renderShell('extensions/beeminder');
    expect(
      document.querySelector('[data-setting-row="extensions.beeminder"]')!.textContent
    ).toContain('Unavailable — needs Settle the day, in Rituals');
  });

  it('reads On once the master switch is on — and re-renders on its own', async () => {
    act(() => {
      useExtensionsStore.setState({ enabled: { beeminder: true } });
      useReminderStore.setState({ stakesEnabled: false });
    });
    renderShell('extensions');

    // The index subscribes to the two stores itself rather than riding the
    // page's ctx rebuild, so flipping the master switch is enough.
    act(() => useReminderStore.setState({ stakesEnabled: true }));
    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-extension-row="beeminder"]')!.dataset
          .extensionState
      ).toBe('On')
    );
  });

  /**
   * The two STORE-level facts outrank the record, and the order is the point.
   *
   * Asking the toggle record is the fix for the index and the pane disagreeing,
   * but a record read against a store that has not fetched yet answers with the
   * MANIFEST DEFAULT — a guess, and for any account that has ever toggled
   * something, frequently the opposite of the truth. So `available` and
   * `configsLoaded` are checked BEFORE `toggle.read`, not after. Nothing in the
   * shape of the code says so; these say it.
   */
  it('says Loading rather than guessing from the manifest default', async () => {
    act(() => {
      // The server has it ON. The store has not heard yet, so `isEnabled` would
      // fall back to the manifest default and print the opposite.
      useExtensionsStore.setState({ configsLoaded: false, enabled: {} });
      useReminderStore.setState({ stakesEnabled: true });
    });
    renderShell('extensions');
    expect(
      document.querySelector<HTMLElement>('[data-extension-row="beeminder"]')!.dataset
        .extensionState
    ).toBe('Loading');

    // And it clears on its own once the fetch lands — the subscription names
    // configsLoaded, so "Loading" is not a state the row can get stuck in.
    act(() => useExtensionsStore.setState({ configsLoaded: true, enabled: { beeminder: true } }));
    await waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-extension-row="beeminder"]')!.dataset
          .extensionState
      ).toBe('On')
    );
  });

  it('says Unavailable for every row when the extensions table is missing', async () => {
    // `available: false` is "the migration has not run" — no row under here is
    // real, whatever its record would compute.
    act(() => {
      useExtensionsStore.setState({ available: false, configsLoaded: true });
      useReminderStore.setState({ stakesEnabled: true, remindersEnabled: true });
    });
    renderShell('extensions');
    const rows = [...document.querySelectorAll<HTMLElement>('[data-extension-row]')];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.dataset.extensionState, row.dataset.extensionRow).toBe('Unavailable');
    }
  });
});
