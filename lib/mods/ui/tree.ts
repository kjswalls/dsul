import { z } from 'zod';
import { isSafeTypedValue, normalizeModText, passesSurfaceRule } from '../labels';
import {
  MOD_ATOMS_MAX,
  MOD_ATOM_TEXT_MAX,
  MOD_TEXT_LINES_MAX,
  MOD_TREE_CHILDREN_MAX,
  MOD_TREE_DEPTH_MAX,
  MOD_TREE_MAX_BYTES,
  MOD_TREE_NODES_MAX,
} from '../limits';
import { ModIdentSchema, type AtomValue } from '../protocol';
import { MOD_ICON_NAMES, type ModIconName } from './icons-list';

/**
 * A panel's element tree (memory/plans/mods.md, build order 9): what a mod's
 * `ui.resolve` returns, and the only thing of its that the host draws.
 * Host-only and pure: no React, no lucide, no stores, so the runtime manager's
 * tests and the renderer (components/mods/mod-tree.tsx) read the same rules.
 *
 * Every node is strict, so there is no style, class or link to pass through,
 * and every string is held to the surface rule (../labels.ts). The tree comes
 * from a mod's worker, so it is untrusted text until parseModTree says
 * otherwise: bytes first, then JSON.parse, then an iterative walk against the
 * structural caps, and only then Zod, whose recursive z.lazy never sees a deep
 * tree. Nothing in it throws.
 */

export type ModTone = 'muted' | 'accent' | 'warn';

export interface ModSelectOption {
  value: string;
  label: string;
}

export type ModNode =
  | { type: 'stack' | 'row' | 'list'; children: ModNode[] }
  | { type: 'divider' }
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string; tone?: ModTone }
  | { type: 'badge'; text: string; tone?: ModTone }
  | { type: 'progress'; value: number; max: number; label?: string; tone?: ModTone }
  | { type: 'stat'; value: string | number; label: string; tone?: ModTone }
  | { type: 'button'; label: string; action: string; arg?: string; tone?: 'accent' | 'muted' }
  | { type: 'checkbox'; atom: string; label: string; initial?: boolean }
  | {
      type: 'input';
      atom: string;
      kind: 'text' | 'number' | 'date';
      label: string;
      placeholder?: string;
      initial?: string | number;
      min?: number;
      max?: number;
    }
  | { type: 'select'; atom: string; label: string; options: ModSelectOption[]; initial?: string }
  | { type: 'itemRef'; id: string }
  | { type: 'icon'; name: ModIconName; label?: string; tone?: ModTone };

export type ModNodeType = ModNode['type'];

/** What an atom-bound node accepts, so a mod's `$.atom.set` is held to the field that shows it. */
export type AtomKind =
  | { kind: 'checkbox' }
  | { kind: 'select'; options: string[] }
  | { kind: 'number'; min?: number; max?: number }
  | { kind: 'text' }
  | { kind: 'date' };

export interface ModTreeAction {
  action: string;
  arg?: string;
}

/* ── strings ───────────────────────────────────────────────────────────── */

const Ident = ModIdentSchema;
const Tone = z.enum(['muted', 'accent', 'warn']);
const Finite = z.number().finite();

const surface = { message: 'cannot be shown' };
/** The surface rule on one line: a newline belongs only in a text node. */
const oneLine = (s: string) => !s.includes('\n') && passesSurfaceRule(s);

/** NFKC, trimmed, 1 to `max`, one line under the surface rule. */
const label = (max: number) =>
  z
    .string()
    .transform((s) => normalizeModText(s.trim()))
    .pipe(z.string().min(1).max(max).refine(oneLine, surface));

const Label = label(40);
const Heading = label(80);

/** NFKC, 1 to 300, at most MOD_TEXT_LINES_MAX lines, each under the surface rule. */
const Text = z
  .string()
  .transform(normalizeModText)
  .pipe(
    z
      .string()
      .min(1)
      .max(300)
      .refine((s) => s.split('\n').length <= MOD_TEXT_LINES_MAX, { message: `is over ${MOD_TEXT_LINES_MAX} lines` })
      .refine(passesSurfaceRule, surface)
  );

/** NFKC, one line under the surface rule, `min` to `max`. */
const plain = (min: number, max: number) =>
  z.string().transform(normalizeModText).pipe(z.string().min(min).max(max).refine(oneLine, surface));

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` naming a day the calendar has. */
export function isRealDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/* ── nodes ─────────────────────────────────────────────────────────────── */

const container = (type: 'stack' | 'row' | 'list') =>
  z.object({ type: z.literal(type), children: z.array(ModNodeSchema).max(MOD_TREE_CHILDREN_MAX) }).strict();

export const ModNodeSchema: z.ZodType<ModNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.discriminatedUnion('type', [
    container('stack'),
    container('row'),
    container('list'),
    z.object({ type: z.literal('divider') }).strict(),
    z.object({ type: z.literal('heading'), text: Heading }).strict(),
    z.object({ type: z.literal('text'), text: Text, tone: Tone.optional() }).strict(),
    z.object({ type: z.literal('badge'), text: Label, tone: Tone.optional() }).strict(),
    z
      .object({
        type: z.literal('progress'),
        value: Finite.min(0),
        max: Finite.positive().max(1e6),
        label: Label.optional(),
        tone: Tone.optional(),
      })
      .strict(),
    z
      .object({ type: z.literal('stat'), value: z.union([plain(1, 12), Finite]), label: Label, tone: Tone.optional() })
      .strict(),
    z
      .object({
        type: z.literal('button'),
        label: Label,
        action: Ident,
        arg: plain(0, 64).optional(),
        tone: z.enum(['accent', 'muted']).optional(),
      })
      .strict(),
    z.object({ type: z.literal('checkbox'), atom: Ident, label: Label, initial: z.boolean().optional() }).strict(),
    z
      .object({
        type: z.literal('input'),
        atom: Ident,
        kind: z.enum(['text', 'number', 'date']),
        label: Label,
        placeholder: Label.optional(),
        initial: z.union([z.string().max(MOD_ATOM_TEXT_MAX), Finite]).optional(),
        min: Finite.optional(),
        max: Finite.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('select'),
        atom: Ident,
        label: Label,
        options: z.array(z.object({ value: Ident, label: Label }).strict()).min(1).max(20),
        initial: Ident.optional(),
      })
      .strict(),
    z.object({ type: z.literal('itemRef'), id: z.string().uuid() }).strict(),
    z.object({ type: z.literal('icon'), name: z.enum(MOD_ICON_NAMES), label: Label.optional(), tone: Tone.optional() }).strict(),
  ])
);

/* ── the walk ──────────────────────────────────────────────────────────── */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const pathText = (path: readonly (string | number)[]) => (path.length === 0 ? 'root' : path.join('.'));

/**
 * The structural caps, before Zod: depth, node count, children per node, and
 * that every node is an object with a string `type`. Iterative, with its own
 * stack, and it stops at the first breach, so a 10,000-deep tree costs one
 * pass down one branch.
 */
export function walkModTree(raw: unknown): { ok: true } | { ok: false; path: string; reason: string } {
  const stack: { v: unknown; depth: number; path: (string | number)[] }[] = [{ v: raw, depth: 1, path: [] }];
  let nodes = 0;
  while (stack.length > 0) {
    const { v, depth, path } = stack.pop()!;
    if (depth > MOD_TREE_DEPTH_MAX) return { ok: false, path: pathText(path), reason: `is nested more than ${MOD_TREE_DEPTH_MAX} deep` };
    if (++nodes > MOD_TREE_NODES_MAX) return { ok: false, path: pathText(path), reason: `is past ${MOD_TREE_NODES_MAX} nodes` };
    if (!isPlainObject(v) || typeof v.type !== 'string') {
      return { ok: false, path: pathText(path), reason: 'is not a node' };
    }
    const children = v.children;
    if (!Array.isArray(children)) continue;
    if (children.length > MOD_TREE_CHILDREN_MAX) {
      return { ok: false, path: pathText(path), reason: `has more than ${MOD_TREE_CHILDREN_MAX} children` };
    }
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ v: children[i], depth: depth + 1, path: [...path, 'children', i] });
    }
  }
  return { ok: true };
}

/** Every node with its path, depth first, children in order. Iterative; for a tree that passed the walk. */
function eachNode(tree: ModNode, fn: (node: ModNode, path: (string | number)[]) => void): void {
  const stack: { node: ModNode; path: (string | number)[] }[] = [{ node: tree, path: [] }];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    fn(node, path);
    if ('children' in node) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i], path: [...path, 'children', i] });
      }
    }
  }
}

/** Every button's (action, arg), in order. */
export function treeActions(tree: ModNode): ModTreeAction[] {
  const out: ModTreeAction[] = [];
  eachNode(tree, (n) => {
    if (n.type === 'button') out.push(n.arg === undefined ? { action: n.action } : { action: n.action, arg: n.arg });
  });
  return out;
}

/** Whether the tree holds a button with this (action, arg). An absent arg and '' are one. */
export function treeHasAction(actions: readonly ModTreeAction[], action: string, arg?: string): boolean {
  return actions.some((a) => a.action === action && (a.arg ?? '') === (arg ?? ''));
}

/** What each atom-bound node accepts, by atom key. */
export function treeAtoms(tree: ModNode): Record<string, AtomKind> {
  const out: Record<string, AtomKind> = {};
  eachNode(tree, (n) => {
    if (n.type === 'checkbox') out[n.atom] = { kind: 'checkbox' };
    else if (n.type === 'select') out[n.atom] = { kind: 'select', options: n.options.map((o) => o.value) };
    else if (n.type === 'input') {
      out[n.atom] =
        n.kind === 'number'
          ? { kind: 'number', ...(n.min !== undefined && { min: n.min }), ...(n.max !== undefined && { max: n.max }) }
          : { kind: n.kind };
    }
  });
  return out;
}

/**
 * A node's React key: its index path, except that an interactive node is
 * keyed by its atom or its `action:arg`, so focus survives a redraw that
 * moves it.
 */
export function nodeKey(node: ModNode, path: readonly (string | number)[]): string {
  if ('atom' in node) return `atom:${node.atom}`;
  if (node.type === 'button') return `action:${node.action}:${node.arg ?? ''}`;
  return `path:${path.join('.')}`;
}

/** Every node's key, depth first. Unique for a tree parseModTree accepted. */
export function treeKeys(tree: ModNode): string[] {
  const out: string[] = [];
  eachNode(tree, (n, path) => out.push(nodeKey(n, path)));
  return out;
}

/**
 * Whether an atom value fits the node that shows it. `null` (unset) always
 * fits, and the renderer draws the node's initial value for it. A key no
 * tree shows takes any atom value, with its text under the surface rule and
 * not shaped like a secret.
 */
export function atomValueFits(kind: AtomKind | undefined, v: AtomValue): boolean {
  if (v === null) return true;
  if (typeof v === 'number' && !Number.isFinite(v)) return false;
  const safeText = (s: string) => s.length <= MOD_ATOM_TEXT_MAX && passesSurfaceRule(s) && isSafeTypedValue(s);
  if (!kind) return typeof v === 'string' ? safeText(v) : typeof v === 'boolean' || typeof v === 'number';
  switch (kind.kind) {
    case 'checkbox':
      return typeof v === 'boolean';
    case 'select':
      return typeof v === 'string' && kind.options.includes(v);
    case 'date':
      return typeof v === 'string' && isRealDate(v);
    case 'number':
      return (
        typeof v === 'number' && (kind.min === undefined || v >= kind.min) && (kind.max === undefined || v <= kind.max)
      );
    case 'text':
      return typeof v === 'string' && safeText(v);
  }
}

/* ── parse ─────────────────────────────────────────────────────────────── */

export type ParsedModTree =
  | { ok: true; tree: ModNode; actions: ModTreeAction[]; atoms: Record<string, AtomKind> }
  | { ok: false; message: string };

const refuse = (path: readonly (string | number)[] | string, reason: string): ParsedModTree => ({
  ok: false,
  message: `the panel: ${typeof path === 'string' ? path : pathText(path)} ${reason}`,
});

/** The rules Zod does not hold: per-kind input values, a select's initial, and the progress clamp (applied in place). */
function nodeProblem(n: ModNode): string | null {
  if (n.type === 'progress') {
    n.value = Math.min(n.value, n.max);
    return null;
  }
  if (n.type === 'select') {
    const values = n.options.map((o) => o.value);
    if (new Set(values).size !== values.length) return 'has an option twice';
    if (n.initial !== undefined && !values.includes(n.initial)) return 'starts on an option it does not have';
    return null;
  }
  if (n.type !== 'input') return null;
  if (n.kind !== 'number' && (n.min !== undefined || n.max !== undefined)) return 'has a min or max on a non-number';
  switch (n.kind) {
    case 'text':
      if (n.initial !== undefined && (typeof n.initial !== 'string' || !oneLine(n.initial))) {
        return 'starts with text that cannot be shown';
      }
      return null;
    case 'date':
      if (n.initial !== undefined && (typeof n.initial !== 'string' || !isRealDate(n.initial))) {
        return 'starts on a day that is not YYYY-MM-DD';
      }
      return null;
    case 'number':
      if (n.min !== undefined && n.max !== undefined && n.min > n.max) return 'has min over max';
      if (n.initial === undefined) return null;
      if (typeof n.initial !== 'number') return 'starts with a value that is not a number';
      if ((n.min !== undefined && n.initial < n.min) || (n.max !== undefined && n.initial > n.max)) {
        return 'starts outside its min and max';
      }
      return null;
  }
}

/**
 * A resolve's JSON text as a tree the renderer may draw, or the fault message
 * for it (`the panel: <path> <reason>`). Never throws.
 */
export function parseModTree(json: string, opts: { uses: readonly string[] }): ParsedModTree {
  try {
    if (new TextEncoder().encode(json).length > MOD_TREE_MAX_BYTES) {
      return refuse('root', `is over ${Math.round(MOD_TREE_MAX_BYTES / 1024)}KB`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      return refuse('root', 'is not JSON');
    }
    const walked = walkModTree(raw);
    if (!walked.ok) return refuse(walked.path, walked.reason);

    const parsed = ModNodeSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return refuse(issue?.path ?? [], issue?.message.toLowerCase() ?? 'is not valid');
    }
    const tree = parsed.data;

    let problem: ParsedModTree | null = null;
    const atoms = new Set<string>();
    const actions = new Set<string>();
    eachNode(tree, (n, path) => {
      if (problem) return;
      const p = nodeProblem(n);
      if (p) problem = refuse(path, p);
      else if ('atom' in n) {
        if (atoms.has(n.atom)) problem = refuse(path, `uses the atom ${n.atom} twice`);
        atoms.add(n.atom);
      } else if (n.type === 'button') {
        const key = `${n.action}\u0000${n.arg ?? ''}`;
        if (actions.has(key)) problem = refuse(path, 'has the same button twice');
        actions.add(key);
      } else if (n.type === 'itemRef' && !opts.uses.includes('items:read')) {
        problem = refuse(path, 'shows an item, which needs "items:read" in uses');
      }
    });
    if (problem) return problem;
    if (atoms.size > MOD_ATOMS_MAX) return refuse('root', `has more than ${MOD_ATOMS_MAX} atoms`);
    return { ok: true, tree, actions: treeActions(tree), atoms: treeAtoms(tree) };
  } catch {
    return refuse('root', 'could not be read');
  }
}
