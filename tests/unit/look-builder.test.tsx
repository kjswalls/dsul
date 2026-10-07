import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: async () => ({ data: [], error: null }) }),
      insert: async () => ({ error: null }),
      update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    }),
  }),
}));

import { LookBuilder } from '@/components/settings/look-builder';
import { useModsStore } from '@/lib/mods-store';
import { setUserThemesFromRows, useUserThemes } from '@/lib/user-themes/store';
import { themeSlugForId } from '@/lib/user-themes/css';
import { useLookStore } from '@/lib/look-store';
import type { UserMod } from '@/lib/mods/schema';

/** Settings → Make's Look form (components/settings/look-builder.tsx). */

const USER = '11111111-1111-4111-8111-111111111111';
const ACTIONS = { createLook: useModsStore.getState().createLook, saveLook: useModsStore.getState().saveLook };

const mod = (id: string, kind: UserMod['kind'], name: string, manifest: unknown, enabled = true): UserMod => ({
  id,
  userId: USER,
  kind,
  slug: themeSlugForId(id),
  name,
  enabled,
  manifest,
  disabledReason: null,
  createdAt: '2026-10-07T00:00:00Z',
  updatedAt: '2026-10-07T00:00:00Z',
});
const MOSS = mod('aaaaaaaa-0000-4000-8000-000000000001', 'theme', 'Moss', { version: 1, mode: 'light', base: 'paper', tokens: {} });
const FOG = mod('bbbbbbbb-0000-4000-8000-000000000002', 'theme', 'Fog', { version: 1, mode: 'light', base: 'paper', tokens: {} }, false);
const EMBER = mod('cccccccc-0000-4000-8000-000000000003', 'theme', 'Ember', { version: 1, mode: 'dark', base: 'night', tokens: {} });
const THEMES = [MOSS, FOG, EMBER];

beforeEach(() => {
  localStorage.clear();
  useModsStore.getState().reset();
  useModsStore.setState({ ...ACTIONS, available: true, loaded: true, failed: false, hydratedUserId: USER, rows: [...THEMES] });
  setUserThemesFromRows(THEMES, false);
  useLookStore.setState({ layout: 'notebook', light: 'paper', dark: 'night' });
});
afterEach(() => {
  cleanup();
  useUserThemes.setState({ themes: {}, draft: null, rev: 0, source: 'none' });
  useLookStore.setState({ layout: 'classic', light: 'paper', dark: 'night' });
});

const pick = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const optionValues = (testId: string) =>
  [...(screen.getByTestId(testId) as HTMLSelectElement).options].map((o) => [o.value, o.textContent]);

describe('LookBuilder', () => {
  it('saves a new Look switched off, with the manifest the form shows', async () => {
    const onDone = vi.fn();
    render(<LookBuilder userId={USER} editing={null} onDone={onDone} onCancel={() => {}} />);
    expect((screen.getByTestId('look-layout') as HTMLSelectElement).value).toBe('notebook');
    pick('look-name', 'Deep work');
    pick('look-layout', 'writer');
    pick('look-light', 'u-aaaaaaaa');
    pick('look-dark', 'dusk');
    fireEvent.click(screen.getByTestId('look-save'));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Saved. It starts switched off.'));
    const row = useModsStore.getState().rows.find((r) => r.kind === 'look')!;
    expect(row).toMatchObject({ name: 'Deep work', enabled: false });
    expect(row.slug).toBe(themeSlugForId(row.id));
    expect(row.manifest).toEqual({ version: 1, layout: 'writer', light: 'u-aaaaaaaa', dark: 'dusk' });
  });

  it('will not save without a name', async () => {
    const createLook = vi.fn();
    useModsStore.setState({ createLook });
    render(<LookBuilder userId={USER} editing={null} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByTestId('look-save'));
    expect((await screen.findByTestId('look-problems')).textContent).toContain('Give it a name.');
    expect(createLook).not.toHaveBeenCalled();
  });

  it('lists the built-ins and your themes of each mode, an off one marked', () => {
    render(<LookBuilder userId={USER} editing={null} onDone={() => {}} onCancel={() => {}} />);
    expect(optionValues('look-light')).toEqual([
      ['paper', 'Paper'],
      ['studio', 'Studio'],
      ['sorbet', 'Sorbet'],
      ['u-bbbbbbbb', 'Fog (off)'],
      ['u-aaaaaaaa', 'Moss'],
    ]);
    expect(optionValues('look-dark')).toEqual([
      ['night', 'Night'],
      ['terminal', 'Terminal'],
      ['dusk', 'Dusk'],
      ['u-cccccccc', 'Ember'],
    ]);
    expect(optionValues('look-layout').map(([v]) => v)).toContain('notepad-retro');
  });

  it('in safe mode still lists your themes from the rows, by name, though the registry is empty', () => {
    useModsStore.setState({ safeMode: true });
    useUserThemes.setState({ themes: {}, source: 'rows' });
    render(<LookBuilder userId={USER} editing={null} onDone={() => {}} onCancel={() => {}} />);
    expect(optionValues('look-light').slice(3)).toEqual([
      ['u-bbbbbbbb', 'Fog (off)'],
      ['u-aaaaaaaa', 'Moss'],
    ]);
    expect(optionValues('look-dark').slice(3)).toEqual([['u-cccccccc', 'Ember']]);
    useModsStore.setState({ safeMode: false });
  });

  it('labels each preview with its mode', () => {
    render(<LookBuilder userId={USER} editing={null} onDone={() => {}} onCancel={() => {}} />);
    const captions = [...screen.getByTestId('look-previews').querySelectorAll('figcaption')].map((c) => c.textContent);
    expect(captions).toEqual(['Light', 'Dark']);
  });

  it('"Use what I have now" keeps your own theme as saved, off included, and drops only one that is gone', () => {
    useLookStore.setState({ layout: 'console', light: 'u-bbbbbbbb', dark: 'u-cccccccc' });
    render(<LookBuilder userId={USER} editing={null} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByTestId('look-use-current'));
    expect((screen.getByTestId('look-layout') as HTMLSelectElement).value).toBe('console');
    // Fog is switched off: it stays, as the Look would save it.
    expect((screen.getByTestId('look-light') as HTMLSelectElement).value).toBe('u-bbbbbbbb');
    expect((screen.getByTestId('look-dark') as HTMLSelectElement).value).toBe('u-cccccccc');
    useLookStore.setState({ light: 'u-deadbeef' });
    fireEvent.click(screen.getByTestId('look-use-current'));
    expect((screen.getByTestId('look-light') as HTMLSelectElement).value).toBe('paper');
  });

  it('"Use what I have now" does not wait on the theme registry (empty, or in safe mode)', () => {
    useUserThemes.setState({ themes: {}, source: 'none' });
    useLookStore.setState({ layout: 'console', light: 'u-aaaaaaaa', dark: 'u-cccccccc' });
    render(<LookBuilder userId={USER} editing={null} onDone={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByTestId('look-use-current'));
    expect((screen.getByTestId('look-light') as HTMLSelectElement).value).toBe('u-aaaaaaaa');
    expect((screen.getByTestId('look-dark') as HTMLSelectElement).value).toBe('u-cccccccc');
  });

  it('editing round-trips, keeps an off theme marked "(off)", and keeps the switch', async () => {
    const look = mod('dddddddd-0000-4000-8000-000000000004', 'look', 'Calm', {
      version: 1,
      layout: 'classic',
      light: 'u-bbbbbbbb',
      dark: 'terminal',
    });
    const on = { ...look, enabled: true };
    useModsStore.setState({ rows: [...THEMES, on] });
    const onDone = vi.fn();
    render(<LookBuilder userId={USER} editing={on} onDone={onDone} onCancel={() => {}} />);
    expect((screen.getByTestId('look-name') as HTMLInputElement).value).toBe('Calm');
    expect((screen.getByTestId('look-light') as HTMLSelectElement).value).toBe('u-bbbbbbbb');
    expect(optionValues('look-light')).toContainEqual(['u-bbbbbbbb', 'Fog (off)']);
    pick('look-dark', 'dusk');
    fireEvent.click(screen.getByTestId('look-save'));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Saved.'));
    const saved = useModsStore.getState().rows.find((r) => r.id === look.id)!;
    expect(saved).toMatchObject({ enabled: true, manifest: { version: 1, layout: 'classic', light: 'u-bbbbbbbb', dark: 'dusk' } });
  });

  it('refuses a theme of yours that has gone', async () => {
    const look = mod('eeeeeeee-0000-4000-8000-000000000005', 'look', 'Old', {
      version: 1,
      layout: 'classic',
      light: 'u-deadbeef',
      dark: 'night',
    });
    useModsStore.setState({ rows: [...THEMES, look] });
    const saveLook = vi.fn();
    useModsStore.setState({ saveLook });
    render(<LookBuilder userId={USER} editing={look} onDone={() => {}} onCancel={() => {}} />);
    expect((screen.getByTestId('look-light') as HTMLSelectElement).value).toBe('u-deadbeef');
    expect(optionValues('look-light')).toContainEqual(['u-deadbeef', 'A theme you deleted']);
    fireEvent.click(screen.getByTestId('look-save'));
    expect((await screen.findByTestId('look-problems')).textContent).toContain('Pick a light theme.');
    expect(saveLook).not.toHaveBeenCalled();
  });
});

describe('LookBuilder prefilled (a "Write with AI" draft opened in Edit)', () => {
  it('starts from the draft, and saves a new Look switched off', async () => {
    const onDone = vi.fn();
    render(
      <LookBuilder
        userId={USER}
        editing={null}
        initial={{ name: 'Deep work', manifest: { version: 1, layout: 'writer', light: MOSS.slug, dark: 'dusk' } }}
        onDone={onDone}
        onCancel={() => {}}
      />
    );
    expect(screen.getByText('New Look')).toBeTruthy();
    expect((screen.getByTestId('look-name') as HTMLInputElement).value).toBe('Deep work');
    expect((screen.getByTestId('look-layout') as HTMLSelectElement).value).toBe('writer');
    expect((screen.getByTestId('look-light') as HTMLSelectElement).value).toBe(MOSS.slug);
    expect((screen.getByTestId('look-dark') as HTMLSelectElement).value).toBe('dusk');
    fireEvent.click(screen.getByTestId('look-save'));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Saved. It starts switched off.'));
    const saved = useModsStore.getState().rows.find((r) => r.kind === 'look');
    expect(saved).toMatchObject({ name: 'Deep work', enabled: false, manifest: { layout: 'writer', light: MOSS.slug, dark: 'dusk' } });
  });
});
