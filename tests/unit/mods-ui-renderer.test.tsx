// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * components/mods/mod-tree.tsx: draws every node from the host's own pieces,
 * never lets the lime dim (a DOM walk over every rendered class, the wrappers
 * included), counts a press only as the person saw it, commits fields to the
 * panel store as the spec says, and keeps password managers out.
 */

vi.mock('@/lib/supabase', () => ({ createClient: () => ({}) }));
const ui = vi.hoisted(() => ({ openEditFor: vi.fn() }));
vi.mock('@/lib/ui-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ui-store')>()),
  openEditFor: ui.openEditFor,
}));
const sheet = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock('@/lib/mods/ui/open-panel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mods/ui/open-panel')>()),
  closeModSheet: sheet.close,
}));

import { ModTree } from '@/components/mods/mod-tree';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { usePlannerStore } from '@/lib/planner-store';
import { useModsStore } from '@/lib/mods-store';
import { setModPanelRunner } from '@/lib/mods/ui/panel-run';
import { __resetPanelStoreForTests, usePanelStore } from '@/lib/mods/ui/panel-store';
import { parseModTree, type ModNode } from '@/lib/mods/ui/tree';
import type { SettleOutcome } from '@/lib/mods/runtime-manager';
import type { Item } from '@/lib/planner-types';
import type { UserMod } from '@/lib/mods/schema';

const MOD = '00000000-0000-4000-8000-000000000001';
const ITEM = '00000000-0000-4000-8000-0000000000a1';
const HABIT = '00000000-0000-4000-8000-0000000000a2';
const NOWHERE = '00000000-0000-4000-8000-0000000000ff';

const row: UserMod = {
  id: MOD,
  userId: 'u',
  kind: 'mod',
  slug: 'water',
  name: 'Water',
  enabled: true,
  manifest: { version: 1, uses: ['ui', 'items:read'], commands: [], panels: [{ id: 'water', label: 'Water' }] },
  disabledReason: null,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
};

const TONES = ['muted', 'accent', 'warn'] as const;

/** Every node kind, in every tone it takes. */
const EVERYTHING: ModNode = {
  type: 'stack',
  children: [
    { type: 'heading', text: 'Today' },
    { type: 'divider' },
    { type: 'text', text: 'Line one\nLine two' },
    ...TONES.map((tone) => ({ type: 'text' as const, text: `Text ${tone}`, tone })),
    { type: 'badge', text: 'Plain' },
    ...TONES.map((tone) => ({ type: 'badge' as const, text: `Badge ${tone}`, tone })),
    { type: 'progress', value: 3, max: 8, label: 'Glasses' },
    ...TONES.map((tone) => ({ type: 'progress' as const, value: 9, max: 8, tone })),
    { type: 'stat', value: '4 of 8', label: 'Glasses' },
    ...TONES.map((tone) => ({ type: 'stat' as const, value: 4, label: `Stat ${tone}`, tone })),
    {
      type: 'row',
      children: [
        { type: 'button', label: 'Plain', action: 'plain' },
        { type: 'button', label: 'Accent', action: 'accent', tone: 'accent' },
        { type: 'button', label: 'Muted', action: 'muted', tone: 'muted' },
      ],
    },
    { type: 'checkbox', atom: 'big', label: 'Big glass', initial: true },
    { type: 'input', atom: 'note', kind: 'text', label: 'Note', placeholder: 'A note' },
    { type: 'input', atom: 'count', kind: 'number', label: 'Count', min: 0, max: 10, initial: 2 },
    { type: 'input', atom: 'day', kind: 'date', label: 'Day', initial: '2026-03-10' },
    {
      type: 'select',
      atom: 'size',
      label: 'Size',
      options: [
        { value: 'small', label: 'Small' },
        { value: 'large', label: 'Large' },
      ],
      initial: 'small',
    },
    { type: 'list', children: [{ type: 'itemRef', id: ITEM }, { type: 'itemRef', id: HABIT }, { type: 'itemRef', id: NOWHERE }] },
    { type: 'icon', name: 'CupSoda' },
    ...TONES.map((tone) => ({ type: 'icon' as const, name: 'CupSoda' as const, label: `Cup ${tone}`, tone })),
  ],
};

let clock = 0;
let release: ((o: SettleOutcome) => void) | null = null;
type Call = [string, string, string, string | undefined, Record<string, unknown>, number];
const runAction = vi.fn<(...args: Call) => Promise<SettleOutcome>>(
  () =>
    new Promise<SettleOutcome>((res) => {
      release = res;
    })
);
const atomChanged = vi.fn<(modId: string, key: string, value: unknown) => Promise<SettleOutcome>>(async () => ({
  ok: true,
}));
let unslot = () => {};

/** Puts the tree in the panel store as an accepted resolve would, and draws it. */
function draw(tree: ModNode = EVERYTHING, opts: { inSheet?: boolean } = {}) {
  const parsed = parseModTree(JSON.stringify(tree), { uses: ['ui', 'items:read'] });
  if (!parsed.ok) throw new Error(parsed.message);
  const seq = 7;
  usePanelStore.setState({
    trees: {
      [`${MOD}:water`]: {
        seq,
        tree: parsed.tree,
        actions: parsed.actions,
        atomKinds: parsed.atoms,
        rowUpdatedAt: row.updatedAt,
        at: 0,
      },
    },
  });
  const view = render(<ModTree tree={parsed.tree} seq={seq} modId={MOD} panelId="water" inSheet={opts.inSheet} />);
  return {
    ...view,
    redraw: (nextSeq: number, next: ModNode = parsed.tree) =>
      view.rerender(<ModTree tree={next} seq={nextSeq} modId={MOD} panelId="water" inSheet={opts.inSheet} />),
  };
}

beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  __resetPanelStoreForTests();
  useModsStore.setState({ rows: [row] });
  usePlannerStore.setState({
    items: [
      { type: 'task', id: ITEM, title: 'Drink water', status: 'pending', isScheduled: false, order: 0, startTime: '09:30' },
      {
        type: 'habit',
        id: HABIT,
        title: 'Stretch',
        status: 'pending',
        repeatFrequency: 'daily',
        completedDates: [],
        skippedDates: [],
        isScheduled: false,
        order: 1,
      },
    ] as unknown as Item[],
  } as never);
  runAction.mockClear();
  atomChanged.mockClear();
  ui.openEditFor.mockClear();
  sheet.close.mockClear();
  release = null;
  unslot = setModPanelRunner({
    resolvePanel: async () => ({ ok: true }),
    runAction: runAction as never,
    atomChanged: atomChanged as never,
    panelFault: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  unslot();
  vi.restoreAllMocks();
});

const LIME_ALPHA = /(primary|ring|lime|success)[\w-]*\/\d+/;
const DIM = /opacity-(?!100\b)/;

function classesUnder(root: Element): string[] {
  return [root, ...root.querySelectorAll('*')].map((el) => el.getAttribute('class') ?? '').filter(Boolean);
}

describe('ModTree: what it draws', () => {
  it('draws every node, text only as text', () => {
    const { container } = draw();
    expect(screen.getByRole('heading', { level: 3, name: 'Today' })).toBeInTheDocument();
    expect(screen.getByText(/Line one/).textContent).toBe('Line one\nLine two');
    expect(screen.getByText('4 of 8')).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar')[0]).toHaveAttribute('aria-valuetext', '3 of 8');
    // Clamped to its max.
    expect(screen.getAllByRole('progressbar')[1]).toHaveAttribute('aria-valuetext', '8 of 8');
    expect(screen.getByRole('button', { name: 'Accent' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Big glass' })).toBeChecked();
    expect(screen.getByLabelText('Count')).toHaveValue(2);
    expect(screen.getByLabelText('Day')).toHaveValue('2026-03-10');
    expect(screen.getByRole('combobox', { name: 'Size' })).toHaveTextContent('Small');
    expect(screen.getByRole('img', { name: 'Cup accent' })).toBeInTheDocument();
    expect(container.querySelectorAll('svg[aria-hidden="true"].lucide-cup-soda').length).toBe(1);
    expect(screen.getByText('Item not found')).toBeInTheDocument();
    expect(container.querySelector('h1, h2')).toBeNull();
  });

  it('puts nothing of the mod in innerHTML, a style or autofocus', () => {
    const { container } = draw();
    // The only styles are the host's own: Radix's pointer-events on its
    // indicator and value, and the progress fill's transform from a clamped number.
    const styles = [...container.querySelectorAll('[style]')].map((el) => el.getAttribute('style'));
    for (const style of styles) {
      expect(style).toMatch(/^(pointer-events: none;|transform: translateX\(-[\d.]+%\);)$/);
    }
    expect(container.innerHTML).not.toMatch(/<script|javascript:|href=/i);
    expect(container.querySelector('[autofocus]')).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('never dims the lime: no alpha on primary, ring, lime or success, and no opacity but 100, anywhere', () => {
    const { container } = draw();
    const wrappers = render(
      <div>
        <Checkbox />
        <Checkbox checked />
        <Progress value={3} max={8} />
        <Separator />
      </div>
    );
    // An accent button is the app's main button (ink, #436); the walk still sees a faded lime fill.
    expect(screen.getByRole('button', { name: 'Accent' }).className).toMatch(/\bbg-foreground\b/);
    const stock = render(<div className="bg-primary hover:bg-primary/90 disabled:opacity-50">Stock</div>);
    expect(classesUnder(stock.container).some((c) => LIME_ALPHA.test(c) && DIM.test(c))).toBe(true);
    stock.unmount();
    for (const root of [container, wrappers.container]) {
      for (const cls of classesUnder(root)) {
        expect(cls, cls).not.toMatch(LIME_ALPHA);
        expect(cls, cls).not.toMatch(DIM);
      }
    }
  });

  it('shows the initial value for a stored atom that does not fit its node', () => {
    usePanelStore.setState({ atoms: { [MOD]: { big: 'yes', count: 99, day: '2026-02-30', size: 'huge' } } });
    draw();
    expect(screen.getByRole('checkbox', { name: 'Big glass' })).toBeChecked();
    expect(screen.getByLabelText('Count')).toHaveValue(2);
    expect(screen.getByLabelText('Day')).toHaveValue('2026-03-10');
    expect(screen.getByRole('combobox', { name: 'Size' })).toHaveTextContent('Small');
  });

  it('keeps password managers and autofill out of every field', () => {
    const { container } = draw();
    const inputs = [...container.querySelectorAll('input')];
    expect(inputs.length).toBe(3);
    for (const input of inputs) {
      expect(input).toHaveAttribute('autocomplete', 'off');
      expect(input).toHaveAttribute('data-1p-ignore');
      expect(input).toHaveAttribute('data-lpignore', 'true');
      expect(input).toHaveAttribute('data-form-type', 'other');
      expect(input).toHaveAttribute('spellcheck', 'false');
      expect(input).toHaveAttribute('autocorrect', 'off');
      expect(input.getAttribute('name')).toMatch(/^m[a-z0-9]+$/);
    }
    expect(new Set(inputs.map((i) => i.name)).size).toBe(3);
    expect(container.querySelector('form')).toBeNull();
  });
});

describe('ModTree: presses', () => {
  const press = (name: string) => {
    const b = screen.getByRole('button', { name });
    fireEvent.pointerDown(b);
    fireEvent.click(b);
    return b;
  };

  it('ignores a press within the settle time of the button appearing', () => {
    draw();
    clock += 499;
    press('Plain');
    expect(runAction).not.toHaveBeenCalled();
    clock += 1;
    press('Plain');
    expect(runAction).toHaveBeenCalledWith(MOD, 'water', 'plain', undefined, expect.any(Object), 7);
  });

  it('ignores a press whose tree changed between the pointerdown and the click', () => {
    const { redraw } = draw();
    clock += 1000;
    const b = screen.getByRole('button', { name: 'Plain' });
    fireEvent.pointerDown(b);
    redraw(8);
    fireEvent.click(b);
    expect(runAction).not.toHaveBeenCalled();
    // A click with no press at all (a script) is not one either.
    fireEvent.click(b);
    expect(runAction).not.toHaveBeenCalled();
  });

  it('a changed label restarts the settle time; Enter counts as a press', () => {
    const tree: ModNode = { type: 'button', label: 'Add', action: 'add' };
    const { redraw } = draw(tree);
    clock += 1000;
    redraw(7, { type: 'button', label: 'Remove', action: 'add' });
    clock += 100;
    press('Remove');
    expect(runAction).not.toHaveBeenCalled();
    clock += 500;
    const b = screen.getByRole('button', { name: 'Remove' });
    fireEvent.keyDown(b, { key: 'Enter' });
    fireEvent.click(b);
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it('a button moved to another place in the tree restarts the settle time', () => {
    const keep: ModNode = { type: 'button', label: 'Keep', action: 'keep' };
    const del: ModNode = { type: 'button', label: 'Delete', action: 'del' };
    const { redraw } = draw({ type: 'row', children: [keep, del] });
    clock += 1000;
    // Same seq, same label, same key: only the place changed.
    redraw(7, { type: 'row', children: [del, keep] });
    press('Delete');
    expect(runAction).not.toHaveBeenCalled();
    clock += 500;
    press('Delete');
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it('is busy, never disabled, while in flight, and ignores clicks meanwhile', async () => {
    draw();
    clock += 1000;
    const b = press('Accent');
    expect(b).toHaveAttribute('aria-busy', 'true');
    expect(b).not.toBeDisabled();
    press('Accent');
    expect(runAction).toHaveBeenCalledTimes(1);
    await act(async () => release?.({ ok: true }));
    expect(b).not.toHaveAttribute('aria-busy');
    for (const btn of screen.getAllByRole('button')) expect(btn).not.toBeDisabled();
  });

  it('sends the mod’s atoms with the press', () => {
    draw();
    usePanelStore.setState({ atoms: { [MOD]: { big: false } } });
    clock += 1000;
    press('Plain');
    expect(runAction.mock.calls[0][4]).toEqual({ big: false });
  });
});

describe('ModTree: fields', () => {
  const atoms = () => usePanelStore.getState().atoms[MOD] ?? {};

  it('a checkbox commits on change, as the person’s', () => {
    draw();
    clock += 1000;
    const box = screen.getByRole('checkbox', { name: 'Big glass' });
    fireEvent.pointerDown(box);
    fireEvent.click(box);
    expect(atoms().big).toBe(false);
    expect(atomChanged).toHaveBeenCalledWith(MOD, 'big', false);
  });

  it('a checkbox ignores a press within the settle, or over a newer tree', () => {
    const { redraw } = draw();
    const box = screen.getByRole('checkbox', { name: 'Big glass' });
    clock += 100;
    fireEvent.pointerDown(box);
    fireEvent.click(box);
    clock += 1000;
    fireEvent.pointerDown(box);
    redraw(8);
    fireEvent.click(box);
    // A click with no press at all (a script) is not one either.
    fireEvent.click(box);
    expect(atoms().big).toBeUndefined();
    expect(atomChanged).not.toHaveBeenCalled();
  });

  it('a select opens only once settled, and a pick over a newer tree is dropped', async () => {
    const { redraw } = draw();
    const trigger = screen.getByRole('combobox', { name: 'Size' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    expect(screen.queryByRole('option')).toBeNull();
    clock += 1000;
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    const option = await screen.findByRole('option', { name: 'Large' });
    redraw(8);
    fireEvent.click(option);
    expect(atoms().size).toBeUndefined();
    expect(atomChanged).not.toHaveBeenCalled();
  });

  it('a select commits on change', async () => {
    draw();
    clock += 1000;
    const trigger = screen.getByRole('combobox', { name: 'Size' });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    const option = await screen.findByRole('option', { name: 'Large' });
    fireEvent.click(option);
    expect(atoms().size).toBe('large');
    expect(atomChanged).toHaveBeenCalledWith(MOD, 'size', 'large');
  });

  it('text commits only on blur or Enter', () => {
    draw();
    const note = screen.getByLabelText('Note');
    fireEvent.change(note, { target: { value: 'chat with mom' } });
    expect(atoms().note).toBeUndefined();
    expect(atomChanged).not.toHaveBeenCalled();
    fireEvent.blur(note);
    expect(atoms().note).toBe('chat with mom');
    expect(atomChanged).toHaveBeenCalledWith(MOD, 'note', 'chat with mom');
    fireEvent.change(note, { target: { value: 'bring a bottle' } });
    fireEvent.keyDown(note, { key: 'Enter' });
    expect(atoms().note).toBe('bring a bottle');
  });

  it('refuses a value shaped like a key inline, and sends nothing', () => {
    draw();
    const note = screen.getByLabelText('Note');
    fireEvent.change(note, { target: { value: 'sk-abcdefghijklmnop' } });
    fireEvent.blur(note);
    expect(atoms().note).toBeUndefined();
    expect(atomChanged).not.toHaveBeenCalled();
    expect(screen.getByText("That looks like a password or key, so it wasn't sent to your mod")).toBeInTheDocument();
    expect(note).toHaveValue('sk-abcdefghijklmnop');
  });

  it('a number is clamped to its min and max, and a non-number is dropped', () => {
    draw();
    const count = screen.getByLabelText('Count');
    fireEvent.change(count, { target: { value: '40' } });
    fireEvent.blur(count);
    expect(atoms().count).toBe(10);
    fireEvent.change(count, { target: { value: '' } });
    fireEvent.blur(count);
    expect(atoms().count).toBe(10);
    expect(count).toHaveValue(10);
  });

  it('a date must be a real day', () => {
    draw();
    const day = screen.getByLabelText('Day');
    fireEvent.change(day, { target: { value: '2026-04-01' } });
    fireEvent.blur(day);
    expect(atoms().day).toBe('2026-04-01');
    expect(atomChanged).toHaveBeenCalledTimes(1);
  });

  it('an initial value seeds no atom.changed', () => {
    draw();
    expect(atomChanged).not.toHaveBeenCalled();
  });
});

describe('ModTree: itemRef', () => {
  const open = (el: HTMLElement) => {
    fireEvent.pointerDown(el);
    fireEvent.click(el);
  };

  it('opens the item as a held openItem does, task or habit', () => {
    draw();
    clock += 1000;
    const [task, habit] = screen.getAllByTestId('mod-item-ref');
    expect(task).toHaveTextContent('Drink water');
    expect(task).toHaveTextContent('09:30');
    open(task);
    expect(ui.openEditFor).toHaveBeenLastCalledWith(expect.objectContaining({ id: ITEM }), 'task');
    open(habit);
    expect(ui.openEditFor).toHaveBeenLastCalledWith(expect.objectContaining({ id: HABIT }), 'habit');
    expect(sheet.close).not.toHaveBeenCalled();
  });

  it('closes the phone sheet first when shown there', () => {
    draw({ type: 'itemRef', id: ITEM }, { inSheet: true });
    clock += 1000;
    open(screen.getByTestId('mod-item-ref'));
    expect(sheet.close).toHaveBeenCalled();
    expect(sheet.close.mock.invocationCallOrder[0]).toBeLessThan(ui.openEditFor.mock.invocationCallOrder[0]);
  });

  it('ignores a click within the settle, or with no press', () => {
    draw({ type: 'itemRef', id: ITEM });
    const ref = screen.getByTestId('mod-item-ref');
    clock += 100;
    open(ref);
    clock += 1000;
    fireEvent.click(ref);
    expect(ui.openEditFor).not.toHaveBeenCalled();
  });
});
