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

import { ThemeBuilder } from '@/components/settings/theme-builder';
import { useModsStore } from '@/lib/mods-store';
import { useUserThemes } from '@/lib/user-themes/store';
import { DRAFT_SLUG } from '@/lib/user-themes/css';
import { ThemeManifestSchema } from '@/lib/mods/theme-grammar';
import type { UserMod } from '@/lib/mods/schema';

/** Settings → Make's theme form (components/settings/theme-builder.tsx). */

const USER = '11111111-1111-4111-8111-111111111111';
const ACTIONS = { createTheme: useModsStore.getState().createTheme, saveTheme: useModsStore.getState().saveTheme };

beforeEach(() => {
  useModsStore.getState().reset();
  useModsStore.setState({ ...ACTIONS, available: true, loaded: true, failed: false, hydratedUserId: USER, rows: [] });
  useUserThemes.setState({ themes: {}, draft: null, rev: 0, source: 'none' });
});
afterEach(() => cleanup());

const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

describe('ThemeBuilder', () => {
  it('saves a new theme switched off, with every value re-printed', async () => {
    const onDone = vi.fn();
    render(<ThemeBuilder userId={USER} editing={null} onDone={onDone} onCancel={() => {}} />);
    type('theme-name', 'Moss');
    type('theme-field-paper0', '#EEF');
    type('theme-field-ink0', 'oklch(20% 0.0100 272)');
    fireEvent.click(screen.getByTestId('theme-save'));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Saved. It starts switched off.'));
    const row = useModsStore.getState().rows[0];
    expect(row).toMatchObject({ kind: 'theme', name: 'Moss', enabled: false });
    expect(row.slug).toMatch(/^u-[0-9a-f]{8}$/);
    expect(row.slug).toBe(`u-${row.id.replace(/-/g, '').slice(0, 8)}`);
    expect(row.manifest).toEqual({
      version: 1,
      mode: 'light',
      base: 'paper',
      tokens: { paper0: '#eeeeff', ink0: 'oklch(0.2 0.01 272)' },
    });
    expect(ThemeManifestSchema.safeParse(row.manifest).success).toBe(true);
  });

  it('says what is wrong with a field and will not save it', async () => {
    const createTheme = vi.fn();
    useModsStore.setState({ createTheme });
    render(<ThemeBuilder userId={USER} editing={null} onDone={() => {}} onCancel={() => {}} />);
    type('theme-name', 'Bad');
    type('theme-field-limeSolid', 'oklch(0.8 0.1 90 / 50%)');
    expect(screen.getByText('Use #rrggbb, #rgb or oklch(L C H), with no transparency.')).toBeTruthy();
    type('theme-field-scrim', '#000000');
    expect(screen.getByText('Use oklch(L C H / N%), with N from 12% to 60%.')).toBeTruthy();
    type('theme-field-paper1', 'url(x)');
    fireEvent.click(screen.getByTestId('theme-save'));
    expect(await screen.findByTestId('theme-problems')).toBeTruthy();
    expect(createTheme).not.toHaveBeenCalled();
  });

  it('a contrast shortfall holds Save until "Save anyway", which is stored', async () => {
    const onDone = vi.fn();
    render(<ThemeBuilder userId={USER} editing={null} onDone={onDone} onCancel={() => {}} />);
    type('theme-name', 'Faint');
    type('theme-field-ink0', '#f0f0f0');
    expect(screen.getByTestId('theme-contrast').textContent).toContain('Text on the page');
    expect(screen.getByTestId('theme-save').getAttribute('aria-describedby')).toBe('theme-contrast');
    fireEvent.click(screen.getByTestId('theme-save'));
    expect((await screen.findByTestId('theme-problems')).textContent).toContain('Tick Save anyway');
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('theme-save-anyway'));
    fireEvent.click(screen.getByTestId('theme-save'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(useModsStore.getState().rows[0].manifest).toMatchObject({ contrastOverride: true });
  });

  it('previews through the draft while open, and clears it on the way out', () => {
    const view = render(<ThemeBuilder userId={USER} editing={null} onDone={() => {}} onCancel={() => {}} />);
    type('theme-field-paper0', '#123456');
    const draft = useUserThemes.getState().draft;
    expect(draft?.slug).toBe(DRAFT_SLUG);
    expect(new Map(draft!.decls).get('--paper-0')).toBe('#123456');
    expect(document.querySelector(`[data-preview-light='${DRAFT_SLUG}']`)).not.toBeNull();
    view.unmount();
    expect(useUserThemes.getState().draft).toBeNull();
  });

  it('a dark theme starts from a dark built-in and previews dark', () => {
    render(<ThemeBuilder userId={USER} editing={null} onDone={() => {}} onCancel={() => {}} />);
    type('theme-field-paper0', '#fafafa');
    type('theme-mode', 'dark');
    // Light colours do not carry into a dark theme.
    expect((screen.getByTestId('theme-field-paper0') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('theme-base') as HTMLSelectElement).value).toBe('night');
    expect(useUserThemes.getState().draft?.mode).toBe('dark');
    expect(screen.queryByTestId('theme-field-relayLight')).toBeNull();
    expect(screen.getByTestId('theme-field-relayDark')).toBeTruthy();
  });

  it('edit round-trips, and keeps the switch as it is', async () => {
    const id = 'abcdef01-2345-4678-9abc-def012345678';
    const manifest = {
      version: 1,
      mode: 'dark',
      base: 'terminal',
      tokens: { paper0: '#000000', relayDark: ['#ffaa00', '#ff8800'], radius: 2, font: 'plex' },
    };
    const row: UserMod = {
      id,
      userId: USER,
      kind: 'theme',
      slug: 'u-abcdef01',
      name: 'Amber',
      enabled: true,
      manifest,
      disabledReason: null,
      createdAt: '2026-10-07T00:00:00Z',
      updatedAt: '2026-10-07T00:00:00Z',
    };
    useModsStore.setState({ rows: [row] });
    const onDone = vi.fn();
    render(<ThemeBuilder userId={USER} editing={row} onDone={onDone} onCancel={() => {}} />);
    expect((screen.getByTestId('theme-field-paper0') as HTMLInputElement).value).toBe('#000000');
    expect((screen.getByTestId('theme-field-relayDark') as HTMLInputElement).value).toBe('#ffaa00, #ff8800');
    expect((screen.getByTestId('theme-font') as HTMLSelectElement).value).toBe('plex');
    // A saved theme keeps its mode, so no light or dark pick can strand.
    expect((screen.getByTestId('theme-mode') as HTMLSelectElement).disabled).toBe(true);
    type('theme-name', 'Amber 2');
    fireEvent.click(screen.getByTestId('theme-save'));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Saved.'));
    expect(useModsStore.getState().rows[0]).toMatchObject({ name: 'Amber 2', enabled: true, manifest });
  });
});
