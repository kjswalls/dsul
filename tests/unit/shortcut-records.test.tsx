import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * Keyboard shortcuts: ONE record set, TWO shells.
 *
 * The bindings are settings records now (SHORTCUT_RECORDS,
 * lib/settings/manifest.ts), derived 1:1 from DEFAULT_SHORTCUTS, which is
 * itself derived from the command registry. The Keyboard settings pane and the
 * ⌘/ overlay both render THOSE records through the same <ShortcutsPanel>. What
 * this file pins is everything that can break silently in that arrangement:
 *
 *   · the derivation staying a derivation — a second, hand-maintained copy of
 *     the binding table is the failure the whole seam exists to prevent, and it
 *     would leave every existing test green;
 *   · the encoding, because a chord travels through `read`/`write` as ONE
 *     string and the obvious separator ('+') is itself a recordable key;
 *   · "modified" and "reset", which are what a settings record buys and which
 *     are both a comparison against an encoded default;
 *   · the two shells rendering the same rows, since the whole point of the
 *     ticket is that they cannot disagree.
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
  usePathname: () => '/settings/keyboard',
  useSearchParams: () => new URLSearchParams(),
}));

import {
  SHORTCUT_RECORDS,
  SHORTCUT_SECTIONS,
  SHORTCUT_ONLY_CTX,
  SETTINGS,
  settingById,
  displayValue,
  isModified,
  type SettingCtx,
  type ShortcutSettingRecord,
} from '@/lib/settings/manifest';
import { paneRows, searchSettings } from '@/lib/settings/search';
import {
  DEFAULT_SHORTCUTS,
  shortcutKeysFor,
  useKeyboardShortcutsStore,
} from '@/lib/keyboard-shortcuts-store';
import {
  decodeKeys,
  encodeKeys,
  formatKeys,
  matchesBinding,
  normalizeBinding,
  orderKeys,
  pressedKeys,
} from '@/lib/commands/keys';
import { ShortcutsPanel } from '@/components/settings/shortcuts-panel';
import { SettingsShell } from '@/components/settings/settings-shell';
import { KeyboardShortcutsModal } from '@/components/planner/keyboard-shortcuts-modal';
import { rejectionFor } from '@/components/settings/keys-control';
import { seedAI, NOTHING_CONNECTED } from './helpers/ai-fixtures';

const ctx: SettingCtx = { theme: 'system', setTheme: () => {}, userId: 'test-user' };

const recordFor = (shortcutId: string): ShortcutSettingRecord =>
  SHORTCUT_RECORDS.find((r) => r.shortcutId === shortcutId)!;

beforeEach(() => {
  useKeyboardShortcutsStore.setState({ overrides: {} });
});
afterEach(() => {
  cleanup();
  useKeyboardShortcutsStore.setState({ overrides: {} });
});

/* ── the seam ──────────────────────────────────────────────────────────── */

describe('one derivation, not two lists', () => {
  it('maps 1:1 over DEFAULT_SHORTCUTS, in order', () => {
    // The claim the whole design rests on. A record set that merely CONTAINS
    // the same bindings could still have been typed out by hand and could still
    // drop the next one added to the registry; same ids in the same order can
    // only come from mapping the list.
    expect(SHORTCUT_RECORDS.map((r) => r.shortcutId)).toEqual(DEFAULT_SHORTCUTS.map((b) => b.id));
  });

  it('names each record after the frozen shortcut id, verbatim', () => {
    // The settings id is a permanent deep link and the shortcut id is the
    // permanent persistence key. Deriving one from the other by a TRANSFORM
    // would be a second name that can collide (`new_task` / `newTask`).
    for (const record of SHORTCUT_RECORDS) {
      expect(record.id).toBe(`keys.${record.shortcutId}`);
    }
  });

  it('takes its label, description, keys and section from the binding', () => {
    for (const binding of DEFAULT_SHORTCUTS) {
      const record = recordFor(binding.id);
      expect(record.label).toBe(binding.label);
      expect(record.section).toBe(binding.groupHeading);
      expect(record.defaultValue).toBe(encodeKeys(binding.keys));
    }
  });

  it('puts every binding into the manifest, so search and deep links reach it', () => {
    const ids = new Set(SETTINGS.map((s) => s.id));
    for (const record of SHORTCUT_RECORDS) expect(ids.has(record.id)).toBe(true);
    expect(settingById('keys.undo')?.pane).toBe('keyboard');
  });

  it('is exactly what the Keyboard pane advertises', () => {
    // ShortcutsPanel renders SHORTCUT_SECTIONS while the pane's row count comes
    // from paneRows(). If those two sets ever differ, the pane shows a row the
    // panel does not draw (invisible) or the rail counts one it cannot reach.
    expect(paneRows('keyboard').rows.map((r) => r.id)).toEqual(SHORTCUT_RECORDS.map((r) => r.id));
    expect(paneRows('keyboard').advanced).toHaveLength(0);
    // …and on a phone too: hiding them there would leave a pane the rail still
    // offers and search can still reach — the "dead room" the manifest forbids.
    expect(paneRows('keyboard', { isMobile: true }).rows).toHaveLength(SHORTCUT_RECORDS.length);
  });

  it('groups without losing or duplicating a record', () => {
    const grouped = SHORTCUT_SECTIONS.flatMap((section) => section.records);
    expect(grouped.map((r) => r.id)).toEqual(SHORTCUT_RECORDS.map((r) => r.id));
    expect(new Set(SHORTCUT_SECTIONS.map((s) => s.heading)).size).toBe(SHORTCUT_SECTIONS.length);
  });
});

/* ── the encoding ──────────────────────────────────────────────────────── */

describe('a chord as one string', () => {
  it('round-trips every default binding', () => {
    for (const binding of DEFAULT_SHORTCUTS) {
      expect(decodeKeys(encodeKeys(binding.keys))).toEqual(orderKeys(normalizeBinding(binding.keys)));
    }
  });

  it('round-trips a chord whose key is a plus sign', () => {
    // The reason the separator is a space. '+' is a recordable key — ⌘+ arrives
    // as ['+','mod'], because isShiftProducedSymbol keeps 'shift' off it — so
    // joining on '+' makes that one binding un-splittable and silently
    // unbindable, which no other test in this repo would have caught.
    expect(decodeKeys(encodeKeys(['meta', '+']))).toEqual(['mod', '+']);
  });

  it('round-trips the space bar, which is a token and not a space', () => {
    expect(decodeKeys(encodeKeys(['meta', 'space']))).toEqual(['mod', 'space']);
  });

  it('collapses ctrl and meta to the same encoded chord', () => {
    // What makes `read() !== defaultValue` an honest "modified" test: the same
    // physical shortcut recorded on macOS and on Windows must encode alike.
    expect(encodeKeys(['ctrl', 'k'])).toBe(encodeKeys(['meta', 'k']));
    expect(encodeKeys(['k', 'mod'])).toBe(encodeKeys(['meta', 'k']));
  });
});

describe('key labels read modifier-first', () => {
  it('orders a recorded chord, which arrives alphabetically sorted', () => {
    // pressedKeys SORTS, because a sorted array is what makes matchesBinding a
    // cheap element-wise compare — so ⌘K comes back as ['k','mod'] and every
    // renderer printed "K + ⌘" for it. Only REBOUND shortcuts were affected,
    // which is why the table looked right until you changed something.
    expect(formatKeys(['k', 'mod'], true)).toEqual(['⌘', 'K']);
    expect(formatKeys(['z', 'shift', 'mod'], true)).toEqual(['⌘', '⇧', 'Z']);
    expect(formatKeys(['mod', 'k'], false)).toEqual(['Ctrl', 'K']);
  });

  it('leaves an already-ordered chord alone', () => {
    expect(formatKeys(['ctrl', 'z'], true)).toEqual(['⌘', 'Z']);
  });

  it('displays a record through the same ordering', () => {
    const record = recordFor('system_search');
    expect(displayValue(record, encodeKeys(['k', 'mod'])).startsWith('⌘') ||
      displayValue(record, encodeKeys(['k', 'mod'])).startsWith('Ctrl')).toBe(true);
  });
});

/* ── read / write / modified / reset ───────────────────────────────────── */

describe('a binding behaves like every other setting', () => {
  it('reads the live binding, override included', () => {
    const record = recordFor('new_task');
    expect(record.read(ctx)).toBe(encodeKeys(['n']));
    useKeyboardShortcutsStore.getState().updateShortcut('new_task', ['j', 'mod']);
    expect(record.read(ctx)).toBe(encodeKeys(['mod', 'j']));
  });

  it('writes through to the store', () => {
    const record = recordFor('new_task');
    record.write(encodeKeys(['meta', 'j']), ctx);
    expect(useKeyboardShortcutsStore.getState().overrides['new_task']).toEqual(['mod', 'j']);
  });

  it('lights the modified bar only when the chord actually moved', () => {
    const record = recordFor('system_search');
    expect(isModified(record, ctx)).toBe(false);

    // The same shortcut, recorded on a non-Apple platform: ['ctrl','k'] instead
    // of ['meta','k']. It normalizes to the identical chord, so the row must
    // NOT claim the user changed anything.
    useKeyboardShortcutsStore.getState().updateShortcut('system_search', ['ctrl', 'k']);
    expect(isModified(record, ctx)).toBe(false);

    useKeyboardShortcutsStore.getState().updateShortcut('system_search', ['mod', 'j']);
    expect(isModified(record, ctx)).toBe(true);
  });

  it('resets by REMOVING the override, never by storing a copy of the default', () => {
    // Storing today's default pins the user to it: the day a release moves ⌘/
    // somewhere better, everyone who ever pressed reset silently keeps the old
    // key, with no override visible anywhere to explain why.
    const record = recordFor('system_shortcuts');
    useKeyboardShortcutsStore.getState().updateShortcut('system_shortcuts', ['mod', 'j']);
    expect(useKeyboardShortcutsStore.getState().overrides).toHaveProperty('system_shortcuts');

    record.write(record.defaultValue, ctx);
    expect(useKeyboardShortcutsStore.getState().overrides).not.toHaveProperty('system_shortcuts');
    expect(record.read(ctx)).toBe(record.defaultValue);
  });

  it('ignores an empty write rather than storing an unreachable binding', () => {
    const record = recordFor('new_task');
    record.write('', ctx);
    expect(useKeyboardShortcutsStore.getState().overrides).not.toHaveProperty('new_task');
  });

  it('never touches the settings ctx — which is what lets ⌘/ render it anywhere', () => {
    // The overlay hands these records SHORTCUT_ONLY_CTX, a bare object with no
    // theme, no push subscription and no router actions. A record that reached
    // for ctx.actions or ctx.push would throw there and nowhere else, so the
    // guarantee is asserted by handing every one a ctx that refuses to be read.
    const forbidden = new Proxy(
      {},
      {
        get(_target, property) {
          throw new Error(`a keys record read ctx.${String(property)}`);
        },
      }
    ) as SettingCtx;

    for (const record of SHORTCUT_RECORDS) {
      expect(() => record.read(forbidden), record.id).not.toThrow();
      expect(() => record.write(record.defaultValue, forbidden), record.id).not.toThrow();
      expect(() => record.pending?.(forbidden), record.id).not.toThrow();
      expect(() => record.unavailable?.(forbidden), record.id).not.toThrow();
    }
    expect(SHORTCUT_ONLY_CTX.userId).toBeNull();
  });
});

/* ── what the rows SAY ─────────────────────────────────────────────────── */

describe('a binding that only works somewhere says so', () => {
  it('appends the context sentence to the row', () => {
    expect(recordFor('week_columns_wider').description).toContain('week view');
    expect(recordFor('delete_hovered').description).toContain('pointer is over an item');
    expect(recordFor('toggle_left_sidebar').description).toContain('Desktop only');
    expect(recordFor('focus_item_panel').description).toContain('item panel is open');
  });

  it('leaves a binding that works anywhere unqualified', () => {
    // The default has to be silence, or the qualification stops meaning
    // anything — nineteen rows all claiming a caveat is nineteen rows nobody
    // reads.
    //
    // The bar is "a caveat is never the common case", not a strict majority:
    // `toggle_zen` was the twentieth binding and is honestly desktop-only, the
    // same way the two sidebar toggles and the scope toggle are, which put the
    // split at exactly half. Tightening this back to `>` would only buy silence
    // by making a true sentence go unsaid. What must not happen is qualified
    // rows OUTNUMBERING plain ones.
    const unqualified = SHORTCUT_RECORDS.filter((r) => !/only|Desktop/i.test(r.description ?? ''));
    expect(unqualified.map((r) => r.shortcutId)).toContain('undo');
    expect(unqualified.map((r) => r.shortcutId)).toContain('system_search');
    expect(unqualified.length).toBeGreaterThanOrEqual(SHORTCUT_RECORDS.length / 2);
  });

  it('is findable by the words the context uses', () => {
    // The sentence is indexed, which is the second reason it lives in the
    // description rather than in a decoration.
    const hits = searchSettings('hovered', ctx).settings.map((h) => h.record.id);
    expect(hits).toContain('keys.delete_hovered');
  });

  it('is findable by the owning command s own search terms', () => {
    // The command's keywords ride along on the binding (ShortcutBinding.
    // keywords), so "palette" finds the ⌘K row without the manifest reaching
    // back into the command registry for them.
    const hits = searchSettings('palette', ctx).settings.map((h) => h.record.id);
    expect(hits).toContain('keys.system_search');
  });

  it('is findable by the words someone actually types', () => {
    for (const query of ['hotkey', 'rebind', 'keybinding']) {
      const hits = searchSettings(query, ctx).settings.map((h) => h.record.id);
      expect(hits.length, query).toBeGreaterThan(0);
      expect(hits.every((id) => id.startsWith('keys.')), query).toBe(true);
    }
  });
});

describe('the one place a binding is merely PRINTED', () => {
  it('follows the override, so the resting hint cannot start lying', () => {
    // AppShell's shortcuts button used to print the literal '⌘ + /'. Every
    // shortcut is rebindable, so that hint went wrong the moment someone moved
    // the one binding it exists to advertise.
    expect(shortcutKeysFor('system_shortcuts')).toEqual(['meta', '/']);
    useKeyboardShortcutsStore.getState().updateShortcut('system_shortcuts', ['mod', 'j']);
    expect(shortcutKeysFor('system_shortcuts')).toEqual(['mod', 'j']);
    expect(formatKeys(shortcutKeysFor('system_shortcuts'), true)).toEqual(['⌘', 'J']);
  });

  it('answers empty for an id no binding owns, rather than guessing', () => {
    expect(shortcutKeysFor('not_a_shortcut')).toEqual([]);
  });
});

describe('⌘/ is unclaimed by anything else', () => {
  it('belongs to system_shortcuts and to no other binding', () => {
    const owners = DEFAULT_SHORTCUTS.filter(
      (binding) => encodeKeys(binding.keys) === encodeKeys(['meta', '/'])
    );
    expect(owners.map((b) => b.id)).toEqual(['system_shortcuts']);
  });

  it('is not the same chord as the bare `?` the bug report owns', () => {
    // They look adjacent on a US layout (`?` IS shift+/), and they are not:
    // one carries a real modifier and one does not.
    expect(encodeKeys(['?'])).not.toBe(encodeKeys(['meta', '/']));
  });
});

/* ── two shells ────────────────────────────────────────────────────────── */

function renderPanel(variant: 'pane' | 'overlay') {
  return render(<ShortcutsPanel variant={variant} ctx={SHORTCUT_ONLY_CTX} />);
}

/**
 * The recorder button on one row, in the panel currently rendered.
 *
 * By `data-shortcut` and not by accessible name: once a row is off-default it
 * grows a reset button whose label names the same setting, and a name query
 * then matches two.
 */
function recorder(shortcutId: string): HTMLElement {
  return document.querySelector(`[data-shortcut="${shortcutId}"]`) as HTMLElement;
}

function record(button: HTMLElement, key: string, mods: Record<string, boolean> = {}) {
  fireEvent.click(button);
  fireEvent.keyDown(button, { key, ...mods });
  fireEvent.keyUp(button, { key, ...mods });
}

describe('the same component in two shells', () => {
  it('draws the same rows in both', () => {
    const { container: pane } = renderPanel('pane');
    const paneRowIds = [...pane.querySelectorAll('[data-setting-row]')].map((el) =>
      el.getAttribute('data-setting-row')
    );
    cleanup();

    const { container: overlay } = renderPanel('overlay');
    const overlayRowIds = [...overlay.querySelectorAll('[data-setting-row]')].map((el) =>
      el.getAttribute('data-setting-row')
    );

    expect(paneRowIds).toEqual(SHORTCUT_RECORDS.map((r) => r.id));
    expect(overlayRowIds).toEqual(paneRowIds);
  });

  it('labels which shell it is, so a test can scope to one', () => {
    // The omnibar's `data-omnibar-variant` rule, applied here: both shells share
    // every other testid, and on /settings a search result row and a panel row
    // are the same component.
    const { container } = renderPanel('overlay');
    expect(container.querySelector('[data-shortcuts-variant="overlay"]')).not.toBeNull();
    cleanup();
    expect(renderPanel('pane').container.querySelector('[data-shortcuts-variant="pane"]')).not.toBeNull();
  });

  it('claims the bare-key space in the overlay and not in the pane', () => {
    // A surface built out of <button>s is not "typing" by the dispatcher's
    // isFocusedOnInput test, so `n` from a focused row would open the add
    // dialog and REPLACE the overlay in the single ActiveDialog slot. The pane
    // must not claim it: /settings mounts no dispatcher, and its own '/' search
    // binding is something you still want.
    const { container: overlay } = renderPanel('overlay');
    expect(overlay.querySelector('[data-keys-local="true"]')).not.toBeNull();
    cleanup();
    const { container: pane } = renderPanel('pane');
    expect(pane.querySelector('[data-keys-local]')).toBeNull();
  });

  it('offers reset-to-defaults in both', () => {
    renderPanel('pane');
    expect(screen.getByTestId('shortcuts-reset-all')).toBeTruthy();
  });
});

describe('recording a chord', () => {
  it('stores what was pressed, in the canonical encoded order', () => {
    renderPanel('overlay');
    record(recorder('new_task'), 'j', { metaKey: true });
    expect(useKeyboardShortcutsStore.getState().overrides['new_task']).toEqual(['mod', 'j']);
  });

  it('stores a chord the DISPATCHER still matches', () => {
    // The stored array is display-ordered (modifier first) while pressedKeys
    // produces an alphabetically sorted one. matchesBinding normalizes both
    // sides, which is the only reason the two orders can coexist — and it is
    // exactly the kind of thing that is true until someone "simplifies" one of
    // them. A rebinding nothing dispatches is invisible from the settings
    // surface, so it is checked here rather than assumed.
    renderPanel('overlay');
    record(recorder('new_task'), 'j', { metaKey: true });
    const stored = useKeyboardShortcutsStore.getState().overrides['new_task'];
    const pressed = pressedKeys(
      { metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: 'j' } as KeyboardEvent,
      false
    );
    expect(matchesBinding(pressed, stored)).toBe(true);
  });

  it('draws the new chord modifier-first', () => {
    // The regression that made this worth fixing: the stored array is sorted,
    // so before orderKeys the row read "J + ⌘".
    renderPanel('overlay');
    const button = recorder('new_task');
    record(button, 'j', { metaKey: true });
    const caps = recorder('new_task').textContent ?? '';
    expect(caps.indexOf('⌘') === -1 ? caps.indexOf('Ctrl') : caps.indexOf('⌘')).toBe(0);
    expect(caps).toContain('J');
  });

  it('refuses a chord another binding already answers to, and names it', () => {
    // The dispatcher takes the FIRST match in registry order, so a duplicate
    // leaves this row displaying a shortcut that silently runs something else.
    renderPanel('overlay');
    record(recorder('new_task'), 'k', { metaKey: true });
    expect(useKeyboardShortcutsStore.getState().overrides).not.toHaveProperty('new_task');
    expect(screen.getByText(/already used by/i).textContent).toContain('Search');
  });

  it('cancels on Escape rather than binding Escape', () => {
    renderPanel('overlay');
    const button = recorder('new_task');
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Escape' });
    fireEvent.keyUp(button, { key: 'Escape' });
    expect(useKeyboardShortcutsStore.getState().overrides).not.toHaveProperty('new_task');
    // …and the recorder is back at rest, showing the binding it still has.
    expect(recorder('new_task').textContent).toContain('N');
  });

  it('keeps a recorded chord away from the app s own keydown dispatcher', () => {
    // Both the window dispatcher and the settings page's '/' handler listen on
    // window. A chord being RECORDED must not also be RUN, and stopPropagation
    // on the native event is the only thing standing between them.
    renderPanel('overlay');
    const button = recorder('new_task');
    fireEvent.click(button);

    let reachedWindow = false;
    const spy = () => {
      reachedWindow = true;
    };
    window.addEventListener('keydown', spy);
    fireEvent.keyDown(button, { key: 'j', metaKey: true, bubbles: true });
    window.removeEventListener('keydown', spy);

    expect(reachedWindow).toBe(false);
  });

  it('keeps the ⌘] row editable with nothing to answer, so its chord can always be moved', () => {
    // ⌘] toggles a chat panel that exists only while something can answer.
    // Locking its row then (the old `unavailable`) took the recorder AND the
    // reset away, while every other row's conflict check still counted the
    // chord as taken: the user's own chord was held hostage until
    // "Reset to defaults", which put ⌘] straight back on the locked row.
    const cleanupAI = seedAI(NOTHING_CONNECTED);
    try {
      useKeyboardShortcutsStore.getState().updateShortcut('toggle_right_sidebar', ['mod', 'j']);
      renderPanel('pane');
      const row = document.querySelector('[data-setting-row="keys.toggle_right_sidebar"]') as HTMLElement;
      expect(row.textContent).toContain('Works while a model or OpenClaw is connected.');
      expect(row.textContent).not.toMatch(/Unavailable/);
      expect(recorder('toggle_right_sidebar')).not.toBeDisabled();
      // Off its default, so it offers its own reset.
      expect(within(row).getByRole('button', { name: /is changed from its default/ })).toBeTruthy();

      // While it holds ⌘J, ⌘J is refused elsewhere…
      record(recorder('new_task'), 'j', { metaKey: true });
      expect(useKeyboardShortcutsStore.getState().overrides).not.toHaveProperty('new_task');
      // …and moving it off frees the chord.
      record(recorder('toggle_right_sidebar'), 'u', { metaKey: true, altKey: true });
      const moved = useKeyboardShortcutsStore.getState().overrides['toggle_right_sidebar'];
      expect(matchesBinding(normalizeBinding(['mod', 'alt', 'u']), moved)).toBe(true);
      record(recorder('new_task'), 'j', { metaKey: true });
      expect(useKeyboardShortcutsStore.getState().overrides['new_task']).toEqual(['mod', 'j']);
    } finally {
      cleanupAI();
    }
  });
});

describe('why a chord is refused', () => {
  /* Both arms of the recorder's guard, as a pure function — the platform arm
     cannot be exercised through the DOM because jsdom is not a Mac, and
     pressedKeys' Apple branch is the only thing that ever produces a surviving
     'ctrl'. */

  it('refuses a bare Control combo, which on macOS could never fire', () => {
    // pressedKeys deliberately leaves Control to the macOS text system (⌃K
    // kills to end of line), so a ⌃ binding recorded there matches nothing —
    // a shortcut that looks set and is dead.
    expect(rejectionFor(['ctrl', 'j'], 'new_task', DEFAULT_SHORTCUTS)).toContain('macOS');
  });

  it('refuses a chord another binding already owns, and names that binding', () => {
    expect(rejectionFor(['mod', 'k'], 'new_task', DEFAULT_SHORTCUTS)).toBe('Search');
  });

  it('lets a binding keep its OWN chord', () => {
    // Re-recording what you already have must not report a conflict with
    // yourself, which is what excluding the row's own id buys.
    expect(rejectionFor(['mod', 'k'], 'system_search', DEFAULT_SHORTCUTS)).toBeNull();
  });

  it('accepts a free chord', () => {
    expect(rejectionFor(['mod', 'j'], 'new_task', DEFAULT_SHORTCUTS)).toBeNull();
  });

  it('compares normalized, so ⌃K and ⌘K are the same claim', () => {
    // Bindings were authored inconsistently (undo as ctrl, settings as meta).
    // A conflict check that compared literally would let a Windows user bind
    // ⌃K over the palette's ⌘K and leave the first-declared one winning.
    expect(rejectionFor(['k', 'mod'], 'new_task', DEFAULT_SHORTCUTS)).toBe('Search');
  });
});

describe('resetting from a row', () => {
  it('restores the default and clears the override', () => {
    useKeyboardShortcutsStore.getState().updateShortcut('new_task', ['j', 'mod']);
    const { container } = renderPanel('pane');
    const row = container.querySelector('[data-setting-row="keys.new_task"]') as HTMLElement;
    const reset = within(row).getByRole('button', { name: /reset to default/i });
    fireEvent.click(reset);
    expect(useKeyboardShortcutsStore.getState().overrides).not.toHaveProperty('new_task');
  });

  it('offers no reset on a row that is still at its default', () => {
    const { container } = renderPanel('pane');
    const row = container.querySelector('[data-setting-row="keys.system_search"]') as HTMLElement;
    expect(within(row).queryByRole('button', { name: /reset to default/i })).toBeNull();
  });
});

/* ── the shells themselves ─────────────────────────────────────────────── */

describe('the Keyboard pane', () => {
  it('renders the shared panel, not a flat list of rows', () => {
    // The pane could render these records through the generic row loop and
    // still work — it would just lose the sections, and lose them ONLY in one
    // of the two shells, which is the disagreement this ticket exists to
    // remove. So the pane is pinned to the panel by name.
    const { container } = render(
      <SettingsShell pane="keyboard" ctx={ctx} isMobile={false} onOpenDestination={() => {}} />
    );
    expect(container.querySelector('[data-shortcuts-variant="pane"]')).not.toBeNull();
    expect(
      [...container.querySelectorAll('[data-setting-row]')].map((el) =>
        el.getAttribute('data-setting-row')
      )
    ).toEqual(SHORTCUT_RECORDS.map((r) => r.id));
  });

  it('heads each section with the group the commands come from', () => {
    render(
      <SettingsShell pane="keyboard" ctx={ctx} isMobile={false} onOpenDestination={() => {}} />
    );
    for (const section of SHORTCUT_SECTIONS) {
      expect(screen.getAllByText(section.heading).length, section.heading).toBeGreaterThan(0);
    }
    // The one section that is not a command group: the two shell-owned
    // bindings, whose whole distinction is that they act on what is hovered.
    expect(SHORTCUT_SECTIONS.map((s) => s.heading)).toContain('Item under the cursor');
  });

  it('does not render the flat row list as well, which would double every row', () => {
    const { container } = render(
      <SettingsShell pane="keyboard" ctx={ctx} isMobile={false} onOpenDestination={() => {}} />
    );
    const ids = [...container.querySelectorAll('[data-setting-row]')].map((el) =>
      el.getAttribute('data-setting-row')
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the ⌘/ overlay', () => {
  it('renders the very same records, in the overlay shell', () => {
    const { baseElement } = render(<KeyboardShortcutsModal open onOpenChange={() => {}} />);
    expect(baseElement.querySelector('[data-shortcuts-variant="overlay"]')).not.toBeNull();
    expect(
      [...baseElement.querySelectorAll('[data-setting-row]')].map((el) =>
        el.getAttribute('data-setting-row')
      )
    ).toEqual(SHORTCUT_RECORDS.map((r) => r.id));
  });

  it('scrolls in a plain overflow box, never a ScrollArea', () => {
    // CLAUDE.md: <ScrollArea> silently drops max-h. A shortcuts table whose
    // height cap is ignored either pushes the dialog past the viewport or
    // hides its last section with no way to reach it.
    const { baseElement } = render(<KeyboardShortcutsModal open onOpenChange={() => {}} />);
    const panel = baseElement.querySelector('[data-shortcuts-variant="overlay"]')!;
    const scroller = panel.parentElement!;
    expect(scroller.className).toContain('overflow-y-auto');
    expect(baseElement.querySelector('[data-radix-scroll-area-viewport]')).toBeNull();
  });

  it('offers the way to the permanent address', () => {
    // The two shells are not interchangeable: one is summoned over your work,
    // the other is a page you can link, search and bookmark. The overlay is the
    // only place that fact can be said.
    const { baseElement } = render(<KeyboardShortcutsModal open onOpenChange={() => {}} />);
    const link = [...baseElement.querySelectorAll('a')].find(
      (a) => a.getAttribute('href') === '/settings/keyboard'
    );
    expect(link).toBeDefined();
  });
});
