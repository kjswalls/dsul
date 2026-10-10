import { describe, expect, it } from 'vitest';
import { ALL_ICON_ENTRIES } from '@/lib/category-icons';
import { MOD_TREE_MAX_BYTES } from '@/lib/mods/limits';
import { MOD_ICON_DENY, MOD_ICON_NAMES } from '@/lib/mods/ui/icons-list';
import {
  atomValueFits,
  parseModTree,
  treeActions,
  treeAtoms,
  treeKeys,
  walkModTree,
  type ModNode,
} from '@/lib/mods/ui/tree';

/**
 * A panel's element tree (lib/mods/ui/tree.ts, memory/plans/mods.md build
 * order 9): the walk, the node schema, the rules after it, and the icon list.
 */

const USES = ['ui', 'storage'];
const parse = (tree: unknown, uses: readonly string[] = USES) => parseModTree(JSON.stringify(tree), { uses });
const okTree = (tree: unknown, uses?: readonly string[]) => parse(tree, uses).ok;
const stack = (...children: unknown[]) => ({ type: 'stack', children });
const ID = '00000000-0000-4000-8000-0000000000a1';

const VALID: Record<string, unknown> = {
  stack: stack({ type: 'divider' }),
  row: { type: 'row', children: [] },
  list: { type: 'list', children: [{ type: 'text', text: 'One' }] },
  divider: { type: 'divider' },
  heading: { type: 'heading', text: 'Water' },
  text: { type: 'text', text: 'Drink up', tone: 'muted' },
  badge: { type: 'badge', text: 'New', tone: 'accent' },
  progress: { type: 'progress', value: 3, max: 8, label: 'Water', tone: 'warn' },
  'stat string': { type: 'stat', value: '3 of 8', label: 'Glasses' },
  'stat number': { type: 'stat', value: 3, label: 'Glasses' },
  button: { type: 'button', label: '+1', action: 'add', arg: 'one', tone: 'accent' },
  checkbox: { type: 'checkbox', atom: 'done', label: 'Done', initial: false },
  'input text': { type: 'input', atom: 'note', kind: 'text', label: 'Note', placeholder: 'Type here', initial: 'hi' },
  'input number': { type: 'input', atom: 'n', kind: 'number', label: 'Count', initial: 2, min: 0, max: 10 },
  'input date': { type: 'input', atom: 'day', kind: 'date', label: 'Day', initial: '2026-02-28' },
  select: {
    type: 'select',
    atom: 'size',
    label: 'Size',
    options: [
      { value: 'small', label: 'Small' },
      { value: 'large', label: 'Large' },
    ],
    initial: 'large',
  },
  icon: { type: 'icon', name: 'CupSoda', label: 'Water' },
};

const INVALID: Record<string, unknown> = {
  'an unknown type': { type: 'iframe' },
  'an unknown key': { type: 'divider', style: 'color: red' },
  'a className': { type: 'text', text: 'x', className: 'bg-red-500' },
  'an href': { type: 'button', label: 'Go', action: 'go', href: 'https://x' },
  'a bad tone': { type: 'text', text: 'x', tone: 'danger' },
  'an empty text': { type: 'text', text: '' },
  'a 301-character text': { type: 'text', text: 'x'.repeat(301) },
  'a 41-character label': { type: 'badge', text: 'x'.repeat(41) },
  'a newline in a label': { type: 'badge', text: 'a\nb' },
  'a negative progress': { type: 'progress', value: -1, max: 8 },
  'a zero max': { type: 'progress', value: 0, max: 0 },
  'a huge max': { type: 'progress', value: 0, max: 2e6 },
  'a 13-character stat': { type: 'stat', value: 'x'.repeat(13), label: 'L' },
  'a bad action': { type: 'button', label: 'Go', action: 'Go!' },
  'a 65-character arg': { type: 'button', label: 'Go', action: 'go', arg: 'x'.repeat(65) },
  'a fill tone on a button': { type: 'button', label: 'Go', action: 'go', tone: 'warn' },
  'a bad atom': { type: 'checkbox', atom: '1x', label: 'Done' },
  'a min on a text input': { type: 'input', atom: 'a', kind: 'text', label: 'A', min: 1 },
  'a number initial on a text input': { type: 'input', atom: 'a', kind: 'text', label: 'A', initial: 3 },
  'a fake date': { type: 'input', atom: 'a', kind: 'date', label: 'A', initial: '2026-02-30' },
  'a number outside its range': { type: 'input', atom: 'a', kind: 'number', label: 'A', initial: 11, max: 10 },
  'min over max': { type: 'input', atom: 'a', kind: 'number', label: 'A', min: 5, max: 1 },
  'an unlisted select initial': {
    type: 'select',
    atom: 'a',
    label: 'A',
    options: [{ value: 'x', label: 'X' }],
    initial: 'y',
  },
  'a select with no options': { type: 'select', atom: 'a', label: 'A', options: [] },
  'an item that is not a uuid': { type: 'itemRef', id: 'nope' },
  'a denied icon': { type: 'icon', name: 'Lock' },
  'an icon off the list': { type: 'icon', name: 'Nope' },
  'a root that is not a node': [1, 2],
  'a string root': 'hello',
};

describe('parseModTree', () => {
  it.each(Object.entries(VALID))('takes a %s', (_, node) => {
    expect(parse(node)).toMatchObject({ ok: true });
  });

  it.each(Object.entries(INVALID))('refuses %s', (_, node) => {
    const r = parse(node);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^the panel: /);
  });

  it('takes an itemRef only with items:read', () => {
    expect(okTree({ type: 'itemRef', id: ID }, ['ui', 'items:read'])).toBe(true);
    expect(parse(stack({ type: 'itemRef', id: ID }))).toEqual({
      ok: false,
      message: 'the panel: children.0 shows an item, which needs "items:read" in uses',
    });
  });

  it('clamps a progress value to its max', () => {
    const r = parse({ type: 'progress', value: 12, max: 8 });
    expect(r.ok && r.tree).toEqual({ type: 'progress', value: 8, max: 8 });
  });

  it('normalizes text to NFKC and trims labels', () => {
    const r = parse(stack({ type: 'badge', text: '  ｗａｔｅｒ ' }));
    expect(r.ok && r.tree).toEqual(stack({ type: 'badge', text: 'water' }));
  });

  it('takes newline text up to 12 lines, and refuses a 13th', () => {
    expect(okTree({ type: 'text', text: Array.from({ length: 12 }, (_, i) => `Line ${i}`).join('\n') })).toBe(true);
    expect(okTree({ type: 'text', text: Array.from({ length: 13 }, (_, i) => `Line ${i}`).join('\n') })).toBe(false);
    expect(okTree({ type: 'text', text: 'a\tb' })).toBe(false);
  });

  it.each([
    'Signed in as kirby',
    'Reconnect your model',
    'Enter API secret',
    'Chat',
    'sk_live_abcdef123',
    `ghp_${'a1'.repeat(10)}`,
    'a3f9c2e81b7d4f60a9e5c3b2d1f0e8a7c6b5d4e3',
    'https://example.com',
    'Sеttings',
  ])('refuses %s anywhere it shows', (s) => {
    expect(okTree({ type: 'text', text: s })).toBe(false);
    expect(okTree({ type: 'heading', text: s.slice(0, 80) })).toBe(false);
    expect(okTree({ type: 'button', label: s.slice(0, 40), action: 'a' })).toBe(false);
  });

  it('refuses an atom two nodes share, and the same button twice', () => {
    expect(
      parse(stack({ type: 'checkbox', atom: 'a', label: 'A' }, { type: 'input', atom: 'a', kind: 'text', label: 'B' }))
    ).toEqual({ ok: false, message: 'the panel: children.1 uses the atom a twice' });
    expect(okTree(stack({ type: 'button', label: 'A', action: 'go' }, { type: 'button', label: 'B', action: 'go' }))).toBe(false);
    expect(
      okTree(stack({ type: 'button', label: 'A', action: 'go' }, { type: 'button', label: 'B', action: 'go', arg: '' }))
    ).toBe(false);
    expect(
      okTree(stack({ type: 'button', label: 'A', action: 'go', arg: '1' }, { type: 'button', label: 'B', action: 'go', arg: '2' }))
    ).toBe(true);
  });

  it('refuses more than 50 atoms', () => {
    const boxes = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'checkbox', atom: `a${i}`, label: 'A' }));
    expect(okTree(stack(stack(...boxes(25)), stack(...boxes(50).slice(25))))).toBe(true);
    // 51 atoms across two stacks, each under the children cap.
    const more = Array.from({ length: 51 }, (_, i) => ({ type: 'checkbox', atom: `b${i}`, label: 'B' }));
    expect(parse(stack(stack(...more.slice(0, 26)), stack(...more.slice(26))))).toEqual({
      ok: false,
      message: 'the panel: root has more than 50 atoms',
    });
  });

  it('refuses malformed JSON without throwing', () => {
    expect(parseModTree('{', { uses: USES })).toEqual({ ok: false, message: 'the panel: root is not JSON' });
    expect(parseModTree('', { uses: USES }).ok).toBe(false);
  });
});

describe('the structural caps', () => {
  const nest = (depth: number) => {
    let node: unknown = { type: 'divider' };
    for (let i = 1; i < depth; i++) node = stack(node);
    return node;
  };

  it('nests 8 deep and no deeper', () => {
    expect(okTree(nest(8))).toBe(true);
    const r = parse(nest(9));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/nested more than 8 deep/);
  });

  it('refuses a 1,100-deep stack in the walk, before Zod, with no throw', () => {
    const deep = '{"type":"stack","children":['.repeat(1100) + '{"type":"divider"}' + ']}'.repeat(1100);
    expect(() => parseModTree(deep, { uses: USES })).not.toThrow();
    expect(parseModTree(deep, { uses: USES }).ok).toBe(false);
    expect(walkModTree(JSON.parse(deep))).toMatchObject({ ok: false, reason: 'is nested more than 8 deep' });
  });

  it('takes 300 nodes and refuses 301', () => {
    // A root over stacks of up to 49 dividers each, `total` nodes in all.
    const build = (total: number) => {
      const rows: unknown[] = [];
      let left = total - 1;
      while (left > 0) {
        const n = Math.min(49, left - 1);
        rows.push(stack(...Array.from({ length: n }, () => ({ type: 'divider' }))));
        left -= n + 1;
      }
      return stack(...rows);
    };
    expect(okTree(build(300))).toBe(true);
    const r = parse(build(301));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/past 300 nodes/);
  });

  it('takes 50 children and refuses 51', () => {
    const kids = (n: number) => Array.from({ length: n }, () => ({ type: 'divider' }));
    expect(okTree(stack(...kids(50)))).toBe(true);
    expect(parse(stack(...kids(51)))).toEqual({ ok: false, message: 'the panel: root has more than 50 children' });
  });

  it('counts the 32KB cap in UTF-8 bytes', () => {
    // Under 32K characters, over 32K bytes: a 3-byte character.
    const chunk = { type: 'text', text: '€'.repeat(300) };
    const tree = stack(...Array.from({ length: 40 }, () => chunk));
    const json = JSON.stringify(tree);
    expect(json.length).toBeLessThan(MOD_TREE_MAX_BYTES);
    expect(new TextEncoder().encode(json).length).toBeGreaterThan(MOD_TREE_MAX_BYTES);
    expect(parseModTree(json, { uses: USES })).toEqual({ ok: false, message: 'the panel: root is over 32KB' });
  });

  it('names the first node that is not one', () => {
    expect(walkModTree(stack({ type: 'divider' }, 'x'))).toEqual({ ok: false, path: 'children.1', reason: 'is not a node' });
    expect(walkModTree({ children: [] })).toEqual({ ok: false, path: 'root', reason: 'is not a node' });
  });
});

describe('what a tree holds', () => {
  const tree = stack(
    { type: 'button', label: 'Add', action: 'add' },
    { type: 'row', children: [{ type: 'button', label: 'Two', action: 'add', arg: '2' }] },
    { type: 'checkbox', atom: 'done', label: 'Done' },
    { type: 'input', atom: 'n', kind: 'number', label: 'N', min: 0, max: 5 },
    { type: 'input', atom: 'day', kind: 'date', label: 'Day' },
    { type: 'input', atom: 'note', kind: 'text', label: 'Note' },
    { type: 'select', atom: 'size', label: 'Size', options: [{ value: 'small', label: 'Small' }] }
  ) as ModNode;

  it('treeActions lists every button in order', () => {
    expect(treeActions(tree)).toEqual([{ action: 'add' }, { action: 'add', arg: '2' }]);
  });

  it('treeAtoms says what each atom accepts', () => {
    expect(treeAtoms(tree)).toEqual({
      done: { kind: 'checkbox' },
      n: { kind: 'number', min: 0, max: 5 },
      day: { kind: 'date' },
      note: { kind: 'text' },
      size: { kind: 'select', options: ['small'] },
    });
  });

  it('parseModTree hands both back', () => {
    const r = parse(tree);
    expect(r.ok && r.actions).toEqual(treeActions(tree));
    expect(r.ok && r.atoms).toEqual(treeAtoms(tree));
  });

  it('keys interactive nodes by atom or action, the rest by path, all unique', () => {
    const keys = treeKeys(tree);
    expect(keys).toContain('action:add:');
    expect(keys).toContain('action:add:2');
    expect(keys).toContain('atom:done');
    expect(keys).toContain('path:children.1');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('atomValueFits holds a value to its node', () => {
    const atoms = treeAtoms(tree);
    expect(atomValueFits(atoms.done, true)).toBe(true);
    expect(atomValueFits(atoms.done, 'yes')).toBe(false);
    expect(atomValueFits(atoms.n, 6)).toBe(false);
    expect(atomValueFits(atoms.day, '2026-13-01')).toBe(false);
    expect(atomValueFits(atoms.size, 'small')).toBe(true);
    expect(atomValueFits(atoms.note, 'sk_live_abcdef123')).toBe(false);
    expect(atomValueFits(atoms.note, null)).toBe(true);
    expect(atomValueFits(undefined, 'Chat')).toBe(false);
    expect(atomValueFits(undefined, 4)).toBe(true);
  });
});

describe('the icon list', () => {
  const library = ALL_ICON_ENTRIES.map(([name]) => name);

  it('is the library minus the deny list, and holds no denied name', () => {
    const deny = new Set<string>(MOD_ICON_DENY);
    expect([...MOD_ICON_NAMES].sort()).toEqual(library.filter((n) => !deny.has(n)).sort());
    for (const name of MOD_ICON_DENY) expect(MOD_ICON_NAMES as readonly string[]).not.toContain(name);
    for (const name of MOD_ICON_NAMES) expect(library).toContain(name);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(MOD_ICON_NAMES)).toBe(true);
    expect(Object.isFrozen(MOD_ICON_DENY)).toBe(true);
  });
});
