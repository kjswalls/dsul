import { settingById, type SettingCtx, type SettingRecord } from './manifest';

/**
 * A pane's rows, gathered under the switch they hang off.
 *
 * Presentation only — nothing here changes an id, a `dependsOn` or a stored
 * value. The manifest still declares every record flat and in order; this is
 * the one place that decides a dependent renders as a chip under its root, or
 * as an ordinary row below it, and it does so from the record's SHAPE rather
 * than from its id, so a new dependent lands somewhere sensible without a line
 * here naming it.
 *
 * Pure and React-free on purpose: the grouping rules are the part worth
 * testing, and they are cheaper to pin here than through a rendered pane.
 */

/** One chip under a root row. */
export type ChipSpec =
  | { kind: 'single'; record: SettingRecord }
  /** A switch and its one value, drawn as one chip: "Auto-clear · after 30 days". */
  | { kind: 'merged'; toggle: SettingRecord; value: SettingRecord };

export type PaneGroup =
  /** Nothing hangs off it. */
  | { mode: 'row'; parent: SettingRecord }
  /** Every descendant fits in a chip. */
  | { mode: 'chips'; parent: SettingRecord; descendants: SettingRecord[]; chips: ChipSpec[] }
  /**
   * Something below it cannot be a chip (a text field, a credential, a key
   * binding), so the descendants render as ordinary rows in the same list —
   * same left edge, no indent — shown only while shown.
   */
  | { mode: 'rows'; parent: SettingRecord; descendants: SettingRecord[] };

/** Controls a lone dependent may take and still be a chip. An allowlist, so a
 *  control kind added later falls to 'rows' rather than into a chip that does
 *  not know how to draw it. */
const SINGLE_CHIP_KINDS = new Set<SettingRecord['control']>(['enum', 'time', 'action']);
/** What the value half of a merged pair may be. */
const MERGE_VALUE_KINDS = new Set<SettingRecord['control']>(['enum', 'time']);

/**
 * The value V a switch S merges with, from `pool`: S is a switch with exactly
 * one dependent, V is an enum or a time, and V has no dependents of its own.
 * Anything looser and "Off" on the chip would be hiding a setting nobody can
 * see any more.
 */
function mergedValueOf(toggle: SettingRecord, pool: SettingRecord[]): SettingRecord | null {
  if (toggle.control !== 'switch') return null;
  const kids = pool.filter((r) => r.dependsOn === toggle.id);
  if (kids.length !== 1) return null;
  const value = kids[0];
  if (!MERGE_VALUE_KINDS.has(value.control)) return null;
  if (pool.some((r) => r.dependsOn === value.id)) return null;
  return value;
}

export function groupPaneRows(rows: SettingRecord[]): PaneGroup[] {
  const byId = new Map(rows.map((r) => [r.id, r]));

  // The group a record belongs to: its topmost ancestor that is IN `rows`. A
  // record whose parent was dropped (advanced, desktop-only on a phone) is its
  // own root and renders as a plain row — it must never vanish with a parent
  // that is not on screen to turn it back on.
  const rootIn = (record: SettingRecord): string => {
    const seen = new Set<string>([record.id]);
    let current = record;
    let parent = current.dependsOn ? byId.get(current.dependsOn) : undefined;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      current = parent;
      parent = current.dependsOn ? byId.get(current.dependsOn) : undefined;
    }
    return current.id;
  };

  const groups: PaneGroup[] = [];
  for (const record of rows) {
    if (record.dependsOn && byId.has(record.dependsOn)) continue;
    const descendants = rows.filter((r) => r !== record && rootIn(r) === record.id);
    if (!descendants.length) {
      groups.push({ mode: 'row', parent: record });
      continue;
    }

    const chips: ChipSpec[] = [];
    const consumed = new Set<string>();
    let chipable = true;
    for (const d of descendants) {
      if (consumed.has(d.id)) continue;
      const value = mergedValueOf(d, descendants);
      if (value) {
        chips.push({ kind: 'merged', toggle: d, value });
        consumed.add(value.id);
      } else if (SINGLE_CHIP_KINDS.has(d.control)) {
        chips.push({ kind: 'single', record: d });
      } else {
        chipable = false;
        break;
      }
    }
    groups.push(
      chipable
        ? { mode: 'chips', parent: record, descendants, chips }
        : { mode: 'rows', parent: record, descendants }
    );
  }
  // A dependsOn cycle has no root to hang off. Draw its members as plain rows
  // rather than lose them — the manifest test would be the place to fail that.
  const placed = new Set(
    groups.flatMap((g) => [g.parent.id, ...(g.mode === 'row' ? [] : g.descendants.map((d) => d.id))])
  );
  for (const record of rows) {
    if (!placed.has(record.id)) groups.push({ mode: 'row', parent: record });
  }
  return groups;
}

/** Ancestors of a record, nearest first. `seen` is a cycle stop — the manifest
 *  test asserts a parent exists, never that the graph is a DAG, and this runs
 *  during render. */
export function ancestorsOf(record: SettingRecord): SettingRecord[] {
  const out: SettingRecord[] = [];
  const seen = new Set<string>([record.id]);
  let cursor = record.dependsOn;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = settingById(cursor);
    if (!parent) break;
    out.push(parent);
    cursor = parent.dependsOn;
  }
  return out;
}

/** The top of a record's `dependsOn` chain — the row its chip lives under. */
export function rootOf(id: string): string {
  const record = settingById(id);
  if (!record) return id;
  const chain = ancestorsOf(record);
  return chain.length ? chain[chain.length - 1].id : id;
}

/**
 * Every ancestor reads on, and none of them is still loading.
 *
 * Walks the WHOLE chain, not one link: autoAgeDays → autoAge → morningCheck,
 * and setMorningCheckEnabled never clears morningAutoAgeEnabled. Reading only
 * the immediate parent would show the grandchild under a branch
 * use-overdue-sweep refuses to act on. A pending ancestor hides too: its
 * `read()` is the manifest default until the store answers, so drawing its
 * children off it would pop them in and out as the fetch lands.
 *
 * A throwing read counts as shown — one broken store must not cost a row that
 * is otherwise reachable.
 */
export function isShown(record: SettingRecord, ctx: SettingCtx): boolean {
  try {
    for (const parent of ancestorsOf(record)) {
      if (parent.pending?.(ctx)) return false;
      if (!parent.read(ctx)) return false;
    }
    return true;
  } catch {
    return true;
  }
}

/** Some ancestor's store has not answered yet — "hidden" is not known yet. */
export function anyAncestorPending(record: SettingRecord, ctx: SettingCtx): boolean {
  try {
    return ancestorsOf(record).some((parent) => parent.pending?.(ctx) ?? false);
  } catch {
    return false;
  }
}
