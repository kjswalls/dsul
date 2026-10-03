import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

/**
 * An extension row must not draw a control until its own store can answer for
 * it.
 *
 * The extensions store is fetched beside hydrateSettings, not inside it, so it
 * races the gate the settings page opens on. Inside that window `isEnabled()`
 * answers with the MANIFEST DEFAULT — which is not "off", it is "not known yet"
 * — and `configs` is empty. A toggle drawn from that reads as off for an
 * extension the server has on, and one click writes that off into the user's
 * row: for Beeminder, silently taking a live stakes integration down. A config
 * field drawn from it is worse in the other direction — the store's
 * whole-object write guard drops the keystroke with nothing but a console line.
 *
 * The window used to be unreachable by accident (the page waited on
 * planner-store's seven-table load, which the extensions fetch always beat).
 * It is reachable now, so the row states its own readiness.
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

import { SettingRow } from '@/components/settings/setting-row';
import { SETTINGS, settingById, type SettingCtx, type SettingRecord } from '@/lib/settings/manifest';
import { useExtensionsStore } from '@/lib/extensions-store';
import { EXT_HABIT_HEATMAP } from '@/lib/extension-registry';

const ctx: SettingCtx = { theme: 'system', setTheme: () => {}, userId: 'u1' };

function renderRecord(record: SettingRecord) {
  const onWrite = vi.fn();
  render(
    <SettingRow
      record={record}
      ctx={ctx}
      value={record.read(ctx)}
      onWrite={onWrite}
      onReset={() => {}}
    />
  );
  return onWrite;
}

/** Every manifest default is `false`, which is exactly the trap: a row that
 *  renders it looks identical to a row the user really did turn off. */
const toggle = () => settingById('extensions.habitHeatmap')!;

describe('an extension row while its store is still fetching', () => {
  beforeEach(() => {
    useExtensionsStore.setState({
      available: true,
      configsLoaded: false,
      enabled: {},
      configs: {},
      hydratedUserId: 'u1',
    });
  });

  afterEach(() => {
    cleanup();
    useExtensionsStore.getState().reset();
  });

  it('renders no control at all, and says it is loading', () => {
    renderRecord(toggle());

    // Not "a switch, disabled" — a disabled switch still draws a POSITION, and
    // the position it would draw is the manifest default.
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('Still loading…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('data-setting-pending', 'true');
  });

  it('draws the real control once the fetch has landed', () => {
    // ON on the server, and `false` in the manifest — the disagreement the
    // pending window would otherwise have rendered backwards, one click away
    // from writing that backwards value into the user's row.
    useExtensionsStore.setState({ configsLoaded: true, enabled: { [EXT_HABIT_HEATMAP]: true } });
    renderRecord(toggle());

    const control = screen.getByRole('switch');
    expect(control).toBeEnabled();
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText('Still loading…')).toBeNull();
  });

  it('keeps "unavailable" ahead of "loading" when the table is not deployed', () => {
    // hydrate leaves configsLoaded false in that case too, and a spinner that
    // never resolves is the wrong answer — the migration is the real one.
    useExtensionsStore.setState({ available: false, configsLoaded: false });
    renderRecord(toggle());

    expect(screen.queryByText('Still loading…')).toBeNull();
    expect(screen.getByText(/Unavailable:/)).toBeInTheDocument();
  });

  it('covers every extension row, generated ones included', () => {
    // The channel toggles and their config fields are GENERATED from
    // EXTENSION_SETTINGS, so a new channel must not be able to arrive without
    // this. Every extension record whose write path goes through the extensions
    // store declares `pending`; the credential fields do not, because they are
    // written to /api/reminders/secrets and read '' by contract.
    const writable = SETTINGS.filter(
      (r) => r.id.startsWith('extensions.') && r.textVariant !== 'secret'
    );
    expect(writable.length).toBeGreaterThan(2);
    for (const record of writable) {
      expect(record.pending, `${record.id} declares no pending()`).toBeTypeOf('function');
    }
  });
});
