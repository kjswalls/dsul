import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, within, act } from '@testing-library/react';
import { Star } from 'lucide-react';

/**
 * Multiselect in the omnibar's entity picker (components/sidebar/omnibar.tsx).
 *
 * With nothing marked the picker must behave exactly as it always has — Enter or
 * a click runs the command on ONE item and closes. Marks (Tab, Shift+Enter, a
 * ⌘-click, the checkbox) change what Enter does: it runs the command's `runMany`
 * on every mark, once. Everything here is driven through a fake entity command
 * whose `search`/`resolve`/`runMany` are under the test's control, injected via
 * `matchCommands`, so the assertions are about the omnibar and not the registry
 * (the registry's own batch semantics live in commands.test.ts).
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  fetchRoutines: vi.fn(async () => []),
  fetchPrograms: vi.fn(async () => []),
  fetchGoals: vi.fn(async () => []),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/supabase', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  })),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile.value }));

/* ── the fake command ──────────────────────────────────────────────────── */

const fake = vi.hoisted(() => ({
  items: [] as { id: string; label: string }[],
  eligible: new Set<string>(),
  available: true,
  multi: true,
}));
const run = vi.fn();
const runMany = vi.fn();

function option(item: { id: string; label: string }) {
  return { value: item.id, label: item.label, typeName: 'task', icon: Star };
}

function buildCommand() {
  return {
    id: 'test.multi',
    label: 'Test multi',
    group: 'items' as const,
    icon: Star,
    availableWhen: () => fake.available,
    argument: {
      kind: 'entity' as const,
      placeholder: 'Which item?',
      emptyLabel: 'Nothing qualifies',
      search: (q: string) =>
        fake.items
          .filter((i) => fake.eligible.has(i.id))
          .filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase()))
          .map(option),
      resolve: (ids: readonly string[]) =>
        ids
          .map((id) => fake.items.find((i) => i.id === id))
          .filter((i): i is { id: string; label: string } => !!i && fake.eligible.has(i.id))
          .map(option),
      runMany: fake.multi ? runMany : undefined,
    },
    run,
  };
}

vi.mock('@/lib/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/commands')>();
  return {
    ...actual,
    // `/fake` surfaces the fake command and nothing else; every other query
    // goes to the real matcher so the resting panel renders as it does in-app.
    matchCommands: (...args: Parameters<typeof actual.matchCommands>) => {
      if (args[0].trim() !== 'fake') return actual.matchCommands(...args);
      const command = buildCommand() as unknown as import('@/lib/commands').Command;
      return [
        { value: 'cmd:test.multi', command, label: command.label, group: 'items', disabled: false, score: 100 },
      ];
    },
  };
});

import { Omnibar } from '@/components/sidebar/omnibar';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useCommandUsageStore } from '@/lib/command-usage-store';
import { usePlannerStore } from '@/lib/planner-store';

beforeAll(() => {
  if (!('PointerEvent' in globalThis)) {
    (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = MouseEvent;
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

let record: ReturnType<typeof vi.fn<(commandId: string) => void>>;

beforeEach(() => {
  fake.items = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Bravo' },
    { id: 'c', label: 'Charlie' },
    { id: 'd', label: 'Delta' },
  ];
  fake.eligible = new Set(['a', 'b', 'c', 'd']);
  fake.available = true;
  fake.multi = true;
  mobile.value = false;
  run.mockReset();
  runMany.mockReset();
  record = vi.fn<(commandId: string) => void>();
  useCommandUsageStore.setState({ record });
});
afterEach(cleanup);

/* ── helpers ───────────────────────────────────────────────────────────── */

type Variant = 'dock' | 'launcher';

const scopeFor = (variant: Variant) =>
  document.querySelector(`[data-omnibar-variant="${variant}"]`) as HTMLElement;
const inputIn = (variant: Variant) =>
  within(scopeFor(variant)).getByTestId('omnibar-input') as HTMLInputElement;
const rowsIn = (variant: Variant) =>
  Array.from(scopeFor(variant).querySelectorAll<HTMLElement>('[data-testid="omnibar-entity-row"]'));
const rowFor = (variant: Variant, id: string) =>
  scopeFor(variant).querySelector<HTMLElement>(`[data-testid="omnibar-entity-row"][data-arg="${id}"]`);
const highlighted = (variant: Variant) =>
  scopeFor(variant).querySelector<HTMLElement>('[cmdk-item][data-selected="true"]');
const chipCount = (variant: Variant) =>
  scopeFor(variant).querySelector('[data-testid="omnibar-chip-count"]')?.textContent ?? null;
const panel = (variant: Variant) => scopeFor(variant).querySelector('[data-testid="omnibar-panel"]');
const live = (variant: Variant) =>
  scopeFor(variant).querySelector('[data-testid="omnibar-live"]')?.textContent ?? '';
const key = (variant: Variant, init: Parameters<typeof fireEvent.keyDown>[1]) =>
  fireEvent.keyDown(inputIn(variant), init);
const type = (variant: Variant, value: string) =>
  fireEvent.change(inputIn(variant), { target: { value } });

/** Mount one shell and put the fake command's chip up, the way a user does. */
function openPicker(variant: Variant, { wrap }: { wrap?: (ui: React.ReactElement) => React.ReactElement } = {}) {
  const ui = <Omnibar variant={variant} />;
  render(wrap ? wrap(ui) : ui);
  fireEvent.focus(inputIn(variant));
  type(variant, '/fake');
  const commandRow = scopeFor(variant).querySelector<HTMLElement>('[data-command-id="test.multi"]');
  expect(commandRow).not.toBeNull();
  fireEvent.click(commandRow!);
  // The chip is up and the picker lists the fake command's items.
  expect(within(scopeFor(variant)).getByRole('button', { name: /^Cancel Test multi/ })).toBeTruthy();
  expect(rowsIn(variant).length).toBe(4);
}

/* ── shared behaviour, both shells ─────────────────────────────────────── */

describe.each<Variant>(['dock', 'launcher'])('omnibar multiselect (%s)', (variant) => {
  it('with nothing marked, Enter runs `run` on the highlighted item once and closes', () => {
    openPicker(variant);
    expect(highlighted(variant)?.getAttribute('data-arg')).toBe('a');
    key(variant, { key: 'Enter' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toBe('a');
    expect(runMany).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith('test.multi');
    expect(scopeFor(variant).querySelector('[data-testid="omnibar-chip-count"]')).toBeNull();
    expect(rowsIn(variant)).toHaveLength(0);
  });

  it('with nothing marked, a plain click runs that one item', () => {
    openPicker(variant);
    const row = rowFor(variant, 'c')!;
    // A plain mousedown leaves the default alone — focus may go, as it always has.
    expect(fireEvent.mouseDown(row)).toBe(true);
    fireEvent.click(row);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toBe('c');
    expect(runMany).not.toHaveBeenCalled();
  });

  it('Tab marks the highlighted row without running or moving the cursor', () => {
    openPicker(variant);
    // Prevented → fireEvent returns false.
    expect(key(variant, { key: 'Tab' })).toBe(false);
    const a = rowFor(variant, 'a')!;
    expect(a).toHaveAttribute('data-checked', 'true');
    expect(a).toHaveAttribute('aria-checked', 'true');
    expect(rowFor(variant, 'b')).toHaveAttribute('aria-checked', 'false');
    expect(chipCount(variant)).toBe('· 1');
    expect(highlighted(variant)?.getAttribute('data-arg')).toBe('a');
    expect(run).not.toHaveBeenCalled();
    // Tab again on the same row unmarks it.
    key(variant, { key: 'Tab' });
    expect(a).not.toHaveAttribute('data-checked');
    expect(chipCount(variant)).toBeNull();
  });

  it('Enter with marks calls runMany once, in mark order, records once, and closes', () => {
    openPicker(variant);
    key(variant, { key: 'ArrowDown' });
    key(variant, { key: 'ArrowDown' }); // c
    key(variant, { key: 'Tab' });
    key(variant, { key: 'ArrowUp' }); // b
    key(variant, { key: 'Tab' });
    expect(chipCount(variant)).toBe('· 2');
    key(variant, { key: 'Enter' });
    expect(runMany).toHaveBeenCalledTimes(1);
    expect(runMany.mock.calls[0][1]).toEqual(['c', 'b']);
    expect(run).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('test.multi');
    expect(rowsIn(variant)).toHaveLength(0);
  });

  it('Enter with marks does NOT add the highlighted row', () => {
    openPicker(variant);
    key(variant, { key: 'Tab' }); // a
    key(variant, { key: 'ArrowDown' }); // highlight b, unmarked
    key(variant, { key: 'Enter' });
    expect(runMany.mock.calls[0][1]).toEqual(['a']);
  });

  it('Shift+Enter toggles and does not run', () => {
    openPicker(variant);
    key(variant, { key: 'Enter', shiftKey: true });
    expect(rowFor(variant, 'a')).toHaveAttribute('data-checked', 'true');
    expect(run).not.toHaveBeenCalled();
    expect(runMany).not.toHaveBeenCalled();
  });

  it('⌘Enter runs the marks plus the highlighted row', () => {
    openPicker(variant);
    key(variant, { key: 'Tab' }); // a
    key(variant, { key: 'ArrowDown' }); // b
    key(variant, { key: 'Enter', ctrlKey: true });
    expect(runMany).toHaveBeenCalledTimes(1);
    expect(runMany.mock.calls[0][1]).toEqual(['a', 'b']);
  });

  it('⌘Enter with an empty result list sends no undefined', () => {
    openPicker(variant);
    key(variant, { key: 'Tab' }); // a
    type(variant, 'zzz'); // hides every row
    expect(within(scopeFor(variant)).getByText('Nothing qualifies')).toBeTruthy();
    // The hidden mark is still listed below, so the cursor may sit on it —
    // either way the run is just the one mark.
    key(variant, { key: 'Enter', metaKey: true });
    expect(runMany).toHaveBeenCalledTimes(1);
    expect(runMany.mock.calls[0][1]).toEqual(['a']);
  });

  it('a mark the query hides shows under "Also selected", after the results, and still runs', () => {
    openPicker(variant);
    key(variant, { key: 'Tab' }); // a
    type(variant, 'bra');
    const scope = scopeFor(variant);
    const headings = Array.from(scope.querySelectorAll('[cmdk-group-heading]')).map((h) => h.textContent);
    expect(headings).toEqual(['Which item?', 'Also selected']);
    const rows = rowsIn(variant).map((r) => r.getAttribute('data-arg'));
    expect(rows).toEqual(['b', 'a']);
    // The cursor stays on the first RESULT, not on the marked row — so Tab
    // marks Bravo rather than unmarking Alpha.
    expect(highlighted(variant)?.getAttribute('data-arg')).toBe('b');
    key(variant, { key: 'Tab' });
    expect(rowFor(variant, 'a')).toHaveAttribute('data-checked', 'true');
    expect(rowFor(variant, 'b')).toHaveAttribute('data-checked', 'true');
    key(variant, { key: 'Enter' });
    expect(runMany.mock.calls[0][1]).toEqual(['a', 'b']);
  });

  it('Backspace on an empty query unmarks one pick first, then pops the chip; a held key stops', () => {
    openPicker(variant);
    key(variant, { key: 'Tab' }); // a
    key(variant, { key: 'ArrowDown' });
    key(variant, { key: 'Tab' }); // b
    key(variant, { key: 'Backspace' });
    expect(chipCount(variant)).toBe('· 1');
    expect(rowFor(variant, 'b')).not.toHaveAttribute('data-checked');
    expect(live(variant)).toBe('1 selected');
    // Held: repeats change nothing, not even the chip.
    key(variant, { key: 'Backspace', repeat: true });
    key(variant, { key: 'Backspace', repeat: true });
    expect(chipCount(variant)).toBe('· 1');
    fireEvent.keyUp(inputIn(variant), { key: 'Backspace' });
    key(variant, { key: 'Backspace' });
    expect(chipCount(variant)).toBeNull();
    expect(within(scopeFor(variant)).getByRole('button', { name: 'Cancel Test multi' })).toBeTruthy();
    key(variant, { key: 'Backspace' });
    expect(within(scopeFor(variant)).queryByRole('button', { name: /^Cancel Test multi/ })).toBeNull();
  });

  it('holding Backspace to clear a typed query keeps the marks and the chip', () => {
    openPicker(variant);
    key(variant, { key: 'Tab' }); // a
    key(variant, { key: 'ArrowDown' });
    key(variant, { key: 'Tab' }); // b
    type(variant, 'al');
    // The key deletes characters first (no hold set), then repeats on an empty query.
    key(variant, { key: 'Backspace' });
    type(variant, '');
    key(variant, { key: 'Backspace', repeat: true });
    key(variant, { key: 'Backspace', repeat: true });
    expect(chipCount(variant)).toBe('· 2');
    expect(within(scopeFor(variant)).getByRole('button', { name: /^Cancel Test multi/ })).toBeTruthy();
  });

  it('Escape clears the marks and keeps the chip; a second Escape pops the chip as before', () => {
    openPicker(variant);
    key(variant, { key: 'Tab' });
    key(variant, { key: 'Escape' });
    expect(chipCount(variant)).toBeNull();
    expect(live(variant)).toBe('Selection cleared');
    expect(within(scopeFor(variant)).getByRole('button', { name: 'Cancel Test multi' })).toBeTruthy();
    key(variant, { key: 'Escape' });
    expect(within(scopeFor(variant)).queryByRole('button', { name: /^Cancel Test multi/ })).toBeNull();
  });

  it('a mark that stops qualifying drops out of the count, Backspace and Escape', () => {
    openPicker(variant);
    key(variant, { key: 'Tab' }); // a
    key(variant, { key: 'ArrowDown' });
    key(variant, { key: 'Tab' }); // b
    expect(chipCount(variant)).toBe('· 2');
    // A mutation elsewhere makes b ineligible; a store change re-renders.
    fake.eligible.delete('b');
    act(() => usePlannerStore.setState({ tasks: [...usePlannerStore.getState().tasks] }));
    expect(chipCount(variant)).toBe('· 1');
    // Backspace pops the VISIBLE pick (a), not the dead id.
    key(variant, { key: 'Backspace' });
    expect(chipCount(variant)).toBeNull();
    expect(rowFor(variant, 'a')).not.toHaveAttribute('data-checked');
    fireEvent.keyUp(inputIn(variant), { key: 'Backspace' });
    // Only the dead id is left in raw state: Escape falls through to today's
    // behaviour and pops the chip.
    key(variant, { key: 'Escape' });
    expect(within(scopeFor(variant)).queryByRole('button', { name: /^Cancel Test multi/ })).toBeNull();
  });

  it('the checkbox toggles without running and keeps focus in the input', () => {
    openPicker(variant);
    const check = rowFor(variant, 'c')!.querySelector<HTMLElement>('[data-testid="omnibar-entity-check"]')!;
    expect(fireEvent.mouseDown(check)).toBe(false); // prevented → the input keeps focus
    fireEvent.click(check);
    expect(rowFor(variant, 'c')).toHaveAttribute('data-checked', 'true');
    expect(run).not.toHaveBeenCalled();
  });

  it('a modifier click toggles; once marked, a plain click toggles too', () => {
    openPicker(variant);
    const b = rowFor(variant, 'b')!;
    expect(fireEvent.mouseDown(b, { ctrlKey: true })).toBe(false);
    fireEvent.click(b, { ctrlKey: true });
    expect(b).toHaveAttribute('data-checked', 'true');
    const d = rowFor(variant, 'd')!;
    expect(fireEvent.mouseDown(d)).toBe(false);
    fireEvent.click(d);
    expect(d).toHaveAttribute('data-checked', 'true');
    expect(run).not.toHaveBeenCalled();
    expect(chipCount(variant)).toBe('· 2');
  });

  it('a Ctrl-click toggles even while the held Ctrl key auto-repeats', () => {
    openPicker(variant);
    const input = inputIn(variant);
    const b = rowFor(variant, 'b')!;
    // Holding Ctrl fires repeated keydowns at the focused input, before, during
    // and after the press — the regression that turned every Ctrl-click into a run.
    fireEvent.keyDown(input, { key: 'Control', ctrlKey: true });
    fireEvent.mouseDown(b, { ctrlKey: true });
    fireEvent.keyDown(input, { key: 'Control', ctrlKey: true, repeat: true });
    fireEvent.mouseUp(b, { ctrlKey: true });
    fireEvent.keyDown(input, { key: 'Control', ctrlKey: true, repeat: true });
    fireEvent.click(b, { ctrlKey: true });
    expect(b).toHaveAttribute('data-checked', 'true');
    expect(run).not.toHaveBeenCalled();
  });

  it('a plain click with nothing marked still runs on that one item', () => {
    openPicker(variant);
    const b = rowFor(variant, 'b')!;
    fireEvent.mouseDown(b);
    fireEvent.click(b);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toBe('b');
  });

  it('a modifier mousedown that never became a click does not turn a later Enter into a toggle', () => {
    openPicker(variant);
    fireEvent.mouseDown(rowFor(variant, 'b')!, { ctrlKey: true });
    key(variant, { key: 'Enter' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toBe('a');
  });

  it('ignores Tab and Enter while an IME is composing', () => {
    openPicker(variant);
    key(variant, { key: 'Tab', keyCode: 229 });
    expect(chipCount(variant)).toBeNull();
    key(variant, { key: 'Tab' });
    expect(chipCount(variant)).toBe('· 1');
    key(variant, { key: 'Enter', keyCode: 229 });
    expect(runMany).not.toHaveBeenCalled();
  });

  it('when the command stops being available, a run clears the marks and says so', () => {
    openPicker(variant);
    key(variant, { key: 'Tab' });
    fake.available = false;
    key(variant, { key: 'Enter' });
    expect(runMany).not.toHaveBeenCalled();
    expect(chipCount(variant)).toBeNull();
    expect(live(variant)).toBe('Nothing selected can take this now');
    expect(record).not.toHaveBeenCalled();
  });

  it('the run bar sits outside the listbox; Clear and Run work', () => {
    openPicker(variant);
    const scope = scopeFor(variant);
    expect(scope.querySelector('[data-testid="omnibar-run-bar"]')).toBeNull();
    key(variant, { key: 'Tab' });
    const bar = scope.querySelector<HTMLElement>('[data-testid="omnibar-run-bar"]')!;
    expect(bar).not.toBeNull();
    expect(bar.closest('[role="listbox"]')).toBeNull();
    expect(bar.textContent).toContain('Test multi · 1 item');
    fireEvent.click(within(bar).getByTestId('omnibar-clear-selection'));
    expect(chipCount(variant)).toBeNull();
    key(variant, { key: 'Tab' });
    fireEvent.click(within(scope).getByTestId('omnibar-run-selection'));
    expect(runMany).toHaveBeenCalledTimes(1);
    expect(runMany.mock.calls[0][1]).toEqual(['a']);
  });

  it('ARIA: no aria-multiselectable, the square is aria-hidden', () => {
    openPicker(variant);
    key(variant, { key: 'Tab' });
    const scope = scopeFor(variant);
    expect(scope.querySelector('[aria-multiselectable]')).toBeNull();
    const check = rowFor(variant, 'a')!.querySelector('[data-testid="omnibar-entity-check"]')!;
    expect(check).toHaveAttribute('aria-hidden', 'true');
  });

  it('lime rule: nothing at or above the checked square carries an opacity class', () => {
    openPicker(variant);
    key(variant, { key: 'Tab' });
    let el: HTMLElement | null = rowFor(variant, 'a')!.querySelector<HTMLElement>(
      '[data-testid="omnibar-entity-check"] > span',
    );
    expect(el?.className).toContain('bg-primary');
    // Bare `opacity-*` utilities only: a variant like data-[disabled=true]:opacity-50
    // never applies (rows are never disabled).
    while (el) {
      const tokens = (el.getAttribute('class') ?? '').split(/\s+/);
      expect(tokens.filter((t) => /^opacity-/.test(t))).toEqual([]);
      el = el.parentElement;
    }
  });

  it('an entity picker without runMany stays single-select', () => {
    fake.multi = false;
    openPicker(variant);
    expect(scopeFor(variant).querySelector('[data-testid="omnibar-entity-check"]')).toBeNull();
    expect(key(variant, { key: 'Tab' })).toBe(true); // not intercepted
    expect(rowFor(variant, 'a')).not.toHaveAttribute('aria-checked');
    key(variant, { key: 'Enter' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

/* ── shell-specific ────────────────────────────────────────────────────── */

describe('launcher footer', () => {
  const footer = () =>
    scopeFor('launcher').querySelector('[data-testid="omnibar-launcher-footer"]')!.textContent ?? '';

  it('teaches the multiselect keys, and swaps to the run keys once something is marked', () => {
    openPicker('launcher');
    expect(footer()).toContain('↵ pick');
    expect(footer()).toContain('⇥ select several');
    expect(footer()).toContain('esc back');
    expect(footer()).not.toContain('Beacon');
    key('launcher', { key: 'Tab' });
    expect(footer()).toContain('↵ run on 1');
    expect(footer()).toContain('Ctrl↵ include highlighted');
    expect(footer()).toContain('⇥ toggle');
    expect(footer()).toContain('⌫ unselect');
    expect(footer()).toContain('esc clear');
  });

  it('a single-select chip says pick/back only', () => {
    fake.multi = false;
    openPicker('launcher');
    expect(footer()).toContain('↵ pick');
    expect(footer()).not.toContain('select several');
  });
});

describe('dock hint', () => {
  it('shows one muted line in the picker that follows the count', () => {
    openPicker('dock');
    const hint = () => scopeFor('dock').querySelector('[data-testid="omnibar-multi-hint"]')?.textContent;
    expect(hint()).toBe('⇥ select several');
    key('dock', { key: 'Tab' });
    expect(hint()).toBe('↵ run on 1');
  });

  it('does not intercept Tab once the panel has closed', () => {
    openPicker('dock');
    // Click outside closes the panel; the chip stays.
    fireEvent.pointerDown(document.body);
    expect(panel('dock')).toBeNull();
    expect(key('dock', { key: 'Tab' })).toBe(true);
  });
});

describe('focus trap inside a Radix dialog', () => {
  it('Tab with marks keeps focus on the input instead of letting FocusScope move it', () => {
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    openPicker('launcher', {
      wrap: (ui) => (
        <Dialog open>
          <DialogContent>
            <DialogTitle>Launcher</DialogTitle>
            {ui}
          </DialogContent>
        </Dialog>
      ),
    });
    const inp = inputIn('launcher');
    inp.focus();
    key('launcher', { key: 'Tab' });
    // The run bar's buttons now exist, and the input is the LAST tabbable in the
    // card, so an unstopped Tab would have FocusScope wrap focus to the first.
    expect(scopeFor('launcher').querySelector('[data-testid="omnibar-run-selection"]')).not.toBeNull();
    inp.focus();
    key('launcher', { key: 'Tab' });
    expect(document.activeElement).toBe(inp);
    expect(outside).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'Tab' }));
    document.removeEventListener('keydown', outside);
  });
});

describe('phone (mobile dock)', () => {
  beforeEach(() => {
    mobile.value = true;
  });

  it('shows the checkboxes at rest with a 44pt hit area', () => {
    openPicker('dock');
    const check = rowFor('dock', 'a')!.querySelector<HTMLElement>('[data-testid="omnibar-entity-check"]')!;
    expect(check.className).toContain('w-11');
    const square = check.firstElementChild as HTMLElement;
    expect(square.className).toContain('visible');
    expect(square.className.split(/\s+/)).not.toContain('invisible');
  });

  it('a tap on the checkbox starts a selection, then a row tap toggles, and Run runs', () => {
    openPicker('dock');
    fireEvent.click(rowFor('dock', 'b')!.querySelector('[data-testid="omnibar-entity-check"]')!);
    fireEvent.mouseDown(rowFor('dock', 'c')!);
    fireEvent.click(rowFor('dock', 'c')!);
    expect(run).not.toHaveBeenCalled();
    const run_ = within(scopeFor('dock')).getByTestId('omnibar-run-selection');
    expect(run_.textContent).toBe('Run');
    fireEvent.click(run_);
    expect(runMany.mock.calls[0][1]).toEqual(['b', 'c']);
  });

  it('the chip yields its label to the count, and the keyboard says "go"', () => {
    openPicker('dock');
    const chip = within(scopeFor('dock')).getByRole('button', { name: 'Cancel Test multi' });
    expect(chip.textContent).toContain('Test multi');
    expect(inputIn('dock')).not.toHaveAttribute('enterkeyhint');
    fireEvent.click(rowFor('dock', 'a')!.querySelector('[data-testid="omnibar-entity-check"]')!);
    const counted = within(scopeFor('dock')).getByRole('button', { name: 'Cancel Test multi, 1 selected' });
    expect(counted.textContent).not.toContain('Test multi');
    expect(chipCount('dock')).toBe('· 1');
    expect(inputIn('dock')).toHaveAttribute('enterkeyhint', 'go');
  });

  it('shows no key hints', () => {
    openPicker('dock');
    fireEvent.click(rowFor('dock', 'a')!.querySelector('[data-testid="omnibar-entity-check"]')!);
    const scope = scopeFor('dock');
    expect(scope.querySelector('[data-testid="omnibar-multi-hint"]')).toBeNull();
    expect(scope.textContent).not.toMatch(/⇥|↵/);
  });
});
