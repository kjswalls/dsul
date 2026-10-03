import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Settings → Look's picker, RENDERED in the real SettingsShell.
 *
 * The six look records (LOOK_PICKER_RECORD_IDS) are drawn as pictures, not
 * rows, so the claims a row got for free have to be pinned here: each id has
 * exactly one `data-setting-row` home in every state, a deep link lands on it
 * even when what it names is not drawn (Style off Notepad, Tint off Paper and
 * Night), and every tap writes through the record it stands for.
 */

const toast = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: Object.assign(toast, { error: vi.fn(), dismiss: vi.fn() }) }));
vi.mock('@/lib/supabase', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      upsert: async () => ({ error: null }),
    }),
    auth: { getUser: async () => ({ data: { user: null } }) },
  }),
}));
const settings = vi.hoisted(() => ({ saveSettings: vi.fn(), flushSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/settings-service', () => settings);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/settings/look',
  useSearchParams: () => new URLSearchParams(),
}));

import { SettingsShell } from '@/components/settings/settings-shell';
import { LOOK_PICKER_RECORD_IDS, type SettingCtx } from '@/lib/settings/manifest';
import { useLookStore } from '@/lib/look-store';
import { usePaletteStore } from '@/lib/palette-store';

const IDS = [...LOOK_PICKER_RECORD_IDS];
const LAYOUT_IDS = ['look.layout', 'look.layoutStyle'];

function makeCtx(theme = 'system'): SettingCtx {
  return { theme, setTheme: vi.fn(), userId: 'test-user' };
}

function renderLook(opts: { ctx?: SettingCtx; isMobile?: boolean; focusId?: string } = {}) {
  const ctx = opts.ctx ?? makeCtx();
  const view = render(
    <SettingsShell
      pane="look"
      ctx={ctx}
      focusId={opts.focusId}
      isMobile={opts.isMobile ?? false}
      onOpenDestination={() => {}}
    />
  );
  return { ...view, ctx };
}

const anchors = (id: string) => document.querySelectorAll(`[data-setting-row="${id}"]`);

beforeEach(() => {
  settings.saveSettings.mockReset();
  toast.mockReset();
  useLookStore.setState({ light: 'paper', dark: 'night', layout: 'classic' });
  usePaletteStore.setState({ palette: 'default' });
});

afterEach(() => {
  cleanup();
  useLookStore.setState({ light: 'paper', dark: 'night', layout: 'classic' });
  usePaletteStore.setState({ palette: 'default' });
});

describe('one home per id', () => {
  const states = [
    { name: 'the shipped look', light: 'paper', dark: 'night', layout: 'classic' },
    { name: 'Notepad Retro', light: 'studio', dark: 'dusk', layout: 'notepad-retro' },
    { name: 'no tintable theme', light: 'sorbet', dark: 'terminal', layout: 'console' },
    { name: 'only Night takes a tint', light: 'studio', dark: 'night', layout: 'writer' },
  ] as const;

  for (const state of states) {
    it(`draws each look record exactly once, inside the picker (${state.name})`, () => {
      useLookStore.setState({ light: state.light, dark: state.dark, layout: state.layout });
      renderLook();
      const picker = screen.getByTestId('look-picker');
      for (const id of IDS) {
        expect(anchors(id).length, id).toBe(1);
        expect(picker.contains(anchors(id)[0]), id).toBe(true);
      }
      const all = [...document.querySelectorAll('[data-setting-row]')].map((el) =>
        el.getAttribute('data-setting-row')
      );
      expect(new Set(all).size).toBe(all.length);
    });
  }

  it('keeps the rest of the pane as rows', () => {
    renderLook();
    for (const id of ['look.appIcon', 'look.typeface', 'look.buckets', 'look.showCompleted']) {
      const row = anchors(id)[0];
      expect(row, id).toBeTruthy();
      expect(screen.getByTestId('look-picker').contains(row), id).toBe(false);
    }
  });

  it('on a phone the layouts go, with their anchors, as paneRows and search drop them', () => {
    renderLook({ isMobile: true });
    for (const id of IDS) {
      expect(anchors(id).length, id).toBe(LAYOUT_IDS.includes(id) ? 0 : 1);
    }
    expect(screen.queryByTestId('look-card-dsul')).toBeNull();
  });
});

describe('a deep link lands where the setting lives', () => {
  async function lands(id: string) {
    const target = () => anchors(id)[0] as HTMLElement;
    await waitFor(() => expect(target().dataset.highlight).toBe('true'));
    expect(document.activeElement).toBe(target());
  }

  it('Style, off Notepad, rings the Layout block where Notepad is', async () => {
    renderLook({ focusId: 'look.layoutStyle' });
    await lands('look.layoutStyle');
    expect(anchors('look.layoutStyle')[0].contains(screen.getByTestId('look-layout-notepad'))).toBe(true);
  });

  it('Style, on Notepad, rings the style chips', async () => {
    useLookStore.setState({ layout: 'notepad-markdown' });
    renderLook({ focusId: 'look.layoutStyle' });
    await lands('look.layoutStyle');
    expect(anchors('look.layoutStyle')[0].contains(screen.getByTestId('look-style-notepad-retro'))).toBe(true);
  });

  it('Tint, with neither Paper nor Night picked, still lands', async () => {
    useLookStore.setState({ light: 'studio', dark: 'terminal' });
    renderLook({ focusId: 'look.palette' });
    await lands('look.palette');
    expect(screen.queryByTestId('look-tint-slate')).toBeNull();
  });

  it('Mode lands on Follow device', async () => {
    renderLook({ focusId: 'look.theme' });
    await lands('look.theme');
    expect(anchors('look.theme')[0].contains(screen.getByTestId('look-follow-device'))).toBe(true);
  });
});

describe('every tap writes through its record', () => {
  it('a swatch sets that mode’s theme and saves its column', () => {
    renderLook();
    fireEvent.click(screen.getByTestId('look-swatch-terminal'));
    expect(useLookStore.getState().dark).toBe('terminal');
    expect(settings.saveSettings).toHaveBeenCalledWith('test-user', { theme_dark: 'terminal' });
  });

  it('a tint dot sets the tint, and only Paper and Night draw dots', () => {
    useLookStore.setState({ light: 'studio', dark: 'night' });
    renderLook();
    // Night draws one set; Studio draws none.
    expect(screen.getAllByTestId('look-tint-slate')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('look-tint-slate'));
    expect(usePaletteStore.getState().palette).toBe('slate');
    expect(settings.saveSettings).toHaveBeenCalledWith('test-user', { theme_palette: 'slate' });
  });

  it('tapping the dark preview keeps dsul dark', () => {
    const { ctx } = renderLook();
    fireEvent.click(screen.getByTestId('look-pin-dark'));
    expect(ctx.setTheme).toHaveBeenCalledWith('dark');
    expect(settings.saveSettings).toHaveBeenCalledWith('test-user', { theme: 'dark' });
  });

  it('the pinned side is pressed and Follow device is off', () => {
    renderLook({ ctx: makeCtx('dark') });
    expect(screen.getByTestId('look-pin-dark').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('look-pin-light').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('look-follow-device').getAttribute('aria-checked')).toBe('false');
  });

  it('Follow device on writes system', () => {
    renderLook({ ctx: makeCtx('dark') });
    fireEvent.click(screen.getByTestId('look-follow-device'));
    expect(settings.saveSettings).toHaveBeenCalledWith('test-user', { theme: 'system' });
  });

  it('a floor plan changes the layout only: no colours, no toast', () => {
    renderLook();
    fireEvent.click(screen.getByTestId('look-layout-console'));
    expect(useLookStore.getState()).toMatchObject({ layout: 'console', dark: 'night' });
    expect(settings.saveSettings).toHaveBeenCalledWith('test-user', { layout: 'console' });
    expect(toast).not.toHaveBeenCalled();
  });

  it('a floor plan for the family you are in keeps its style', () => {
    useLookStore.setState({ layout: 'notepad-retro' });
    renderLook();
    fireEvent.click(screen.getByTestId('look-layout-notepad'));
    expect(useLookStore.getState().layout).toBe('notepad-retro');
    fireEvent.click(screen.getByTestId('look-style-notepad-markdown'));
    expect(useLookStore.getState().layout).toBe('notepad-markdown');
  });

  it('style chips show under Notepad only', () => {
    renderLook();
    expect(screen.queryByTestId('look-style-notepad-retro')).toBeNull();
  });
});

describe('Looks', () => {
  it('a look sets its layout and its pairing, leaves the other mode and the mode alone', () => {
    useLookStore.setState({ light: 'sorbet' });
    const { ctx } = renderLook();
    fireEvent.click(screen.getByTestId('look-card-console'));
    expect(useLookStore.getState()).toMatchObject({ layout: 'console', dark: 'terminal', light: 'sorbet' });
    expect(settings.saveSettings).toHaveBeenCalledWith('test-user', {
      layout: 'console',
      theme_dark: 'terminal',
    });
    expect(ctx.setTheme).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('is on, edited when a colour it set has moved, and a tap puts it back', () => {
    useLookStore.setState({ layout: 'console', dark: 'terminal' });
    renderLook();
    const card = () => screen.getByTestId('look-card-console');
    expect(card().getAttribute('aria-pressed')).toBe('true');
    expect(card().closest('[data-look-state]')!.getAttribute('data-look-state')).toBe('on');

    act(() => useLookStore.setState({ dark: 'dusk' }));
    expect(card().closest('[data-look-state]')!.getAttribute('data-look-state')).toBe('edited');
    expect(card().textContent).toContain('Edited');

    fireEvent.click(card());
    expect(useLookStore.getState().dark).toBe('terminal');
  });

  it('marks the swatch the layout was made with', () => {
    useLookStore.setState({ layout: 'console' });
    renderLook();
    expect(screen.getByTestId('look-swatch-terminal').textContent).toContain('for Console');
    expect(screen.getByTestId('look-swatch-dusk').textContent).not.toContain('for');
  });

  it('says so when the layout brings its own colours', () => {
    useLookStore.setState({ layout: 'notepad-retro' });
    renderLook();
    expect(screen.getByTestId('look-own-colours').textContent).toContain('Retro brings its own colours');
  });
});
