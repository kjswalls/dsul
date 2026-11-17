import type { Item, Task, HabitItem, Goal } from './planner-types';
import { getAllItemTypeNames, getItemTypeConfig } from './item-registry';
import { passesContainerFilter, typeNameOf } from './filters';
import { containerRef } from './container-registry';

/**
 * Pure search parsing + matching for the omnibar (and anything else that
 * needs it). Extracted per the redesign plan; behaviour is specified by
 * tests/unit/search-parser.test.ts.
 *
 * Keyword grammar:
 *   task:foo      → type filter 'task', "foo" becomes search text
 *   habit:foo     → type filter 'habit', "foo" becomes search text
 *   type:errand   → type filter by registry name (custom types; also accepts
 *                   type:task / type:habit)
 *   priority:high → priority filter (low|medium|high), value consumed
 *   project:Name  → project filter, value consumed
 * Unknown "word:value" tokens are treated as plain text.
 */

export interface ParsedSearchQuery {
  text: string;
  /** 'task' | 'habit' | a custom type slug. */
  type: string | null;
  priority: 'low' | 'medium' | 'high' | null;
  project: string | null;
}

const PRIORITIES = ['low', 'medium', 'high'] as const;

export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const result: ParsedSearchQuery = { text: '', type: null, priority: null, project: null };
  const textParts: string[] = [];

  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const sep = token.indexOf(':');
    if (sep > 0) {
      const keyword = token.slice(0, sep).toLowerCase();
      const value = token.slice(sep + 1);

      if (keyword === 'task' || keyword === 'habit') {
        result.type = keyword;
        if (value) textParts.push(value);
        continue;
      }
      if (keyword === 'type' && value) {
        result.type = value.toLowerCase();
        continue;
      }
      if (keyword === 'priority' && (PRIORITIES as readonly string[]).includes(value.toLowerCase())) {
        result.priority = value.toLowerCase() as ParsedSearchQuery['priority'];
        continue;
      }
      if (keyword === 'project' && value) {
        result.project = value;
        continue;
      }
    }
    textParts.push(token);
  }

  result.text = textParts.join(' ');
  return result;
}

export interface SearchResults {
  tasks: Task[];
  habits: HabitItem[];
  /**
   * Parent id → the title of the subtask that put the parent in `tasks`, for a
   * parent found only through a subtask. A parent whose own title (or
   * container) matched is not listed here.
   */
  viaSubtask?: Record<string, string>;
  /**
   * Item id → a short excerpt of its notes around the match, for an item found
   * only through its notes (title, container and subtasks missed). The row
   * shows it, or a hit on a word the row doesn't display reads as a mistake.
   */
  viaNotes?: Record<string, string>;
}

/** Characters of context either side of a notes match. */
const SNIPPET_PAD = 28;

/**
 * About 60 characters of `body` around the first match of `needle` (already
 * lower-cased), whitespace collapsed, with an ellipsis on each cut side. Null
 * when there is no match.
 */
export function noteSnippet(body: string | undefined, needle: string): string | null {
  if (!body || !needle) return null;
  const flat = body.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(needle);
  if (at < 0) return null;
  const start = Math.max(0, at - SNIPPET_PAD);
  const end = Math.min(flat.length, at + needle.length + SNIPPET_PAD);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

// typeNameOf moved to lib/filters.ts — the filter predicates need the same
// resolution, and two copies of "which registry type is this row" is exactly
// how the four filter shapes drifted apart.

/**
 * `subtasks` are the task-like rows with a `parentItemId`, which the planner's
 * `tasks` projection leaves out. Search still has to find them: a subtask is
 * something the user typed and will look for by name, and before this a search
 * for one came back empty as if it had been deleted. A subtask has no row of its
 * own anywhere in the app, so a hit answers with its PARENT (once, in the
 * parent's place among the task results) and `viaSubtask` names the subtask so
 * the row can say why it is there. The parent must still pass the query's
 * filters; only the text is matched against the subtask's title.
 */
export function searchItems(
  raw: string,
  tasks: Task[],
  habits: HabitItem[],
  subtasks: readonly Task[] = []
): SearchResults {
  const query = parseSearchQuery(raw);
  const text = query.text.toLowerCase();
  const hasQuery = text.length > 0 || query.type !== null || query.priority !== null || query.project !== null;
  if (!hasQuery) return { tasks: [], habits: [] };

  const matchText = (title: string, context?: string) =>
    text.length === 0 ||
    title.toLowerCase().includes(text) ||
    (context?.toLowerCase().includes(text) ?? false);

  const passesTaskFilters = (t: Task) =>
    (query.type === null || typeNameOf(t) === query.type) &&
    (query.priority === null || t.priority === query.priority) &&
    (query.project === null ||
      (t.project?.toLowerCase() ?? '') === query.project.toLowerCase());

  // First matching subtask per parent, in the order the caller passed them.
  const subtaskHit = new Map<string, string>();
  if (text.length > 0) {
    for (const sub of subtasks) {
      const parentId = sub.parentItemId;
      if (!parentId || subtaskHit.has(parentId)) continue;
      if (sub.title.toLowerCase().includes(text)) subtaskHit.set(parentId, sub.title);
    }
  }

  const viaSubtask: Record<string, string> = {};
  const viaNotes: Record<string, string> = {};
  /** Last resort for a row nothing else matched: its notes. */
  const matchNotes = (id: string, notes: string | undefined) => {
    const snippet = noteSnippet(notes, text);
    if (snippet === null) return false;
    viaNotes[id] = snippet;
    return true;
  };
  const matchedTasks =
    query.type === 'habit'
      ? []
      : tasks.filter((t) => {
          if (!passesTaskFilters(t)) return false;
          if (matchText(t.title, t.project)) return true;
          const hit = subtaskHit.get(t.id);
          if (hit !== undefined) {
            viaSubtask[t.id] = hit;
            return true;
          }
          return matchNotes(t.id, t.notes);
        });

  /**
   * A QUERY is not a view filter, so the pass-through rule lands differently
   * here — and the two tokens split.
   *
   * `priority:` still excludes habits, and that is correct rather than a wipe:
   * the user asked for high-priority things, a habit has no priority, so no
   * habit is one. Passing them through would answer a narrow question with the
   * whole list. (The canvas filter is the opposite case: there the user is
   * shaping a view, and deleting a whole class of work they never mentioned is
   * the surprise.)
   *
   * `project:` DID wipe, and that was wrong. It is the container axis, and a
   * habit answers it too — so `project:Health` finds the habits filed under
   * Health instead of silently returning none. One axis, resolved per type
   * (see lib/filters.ts containerRefOf), and since 039 one kind as well.
   */
  const matchedHabits =
    (query.type !== null && query.type !== 'habit') || query.priority !== null
      ? []
      : habits.filter(
          (h) =>
            (query.project === null ||
              passesContainerFilter(h, [containerRef('project', query.project)])) &&
            (matchText(h.title, h.project) || matchNotes(h.id, h.notes))
        );

  const results: SearchResults = { tasks: matchedTasks, habits: matchedHabits };
  if (Object.keys(viaSubtask).length > 0) results.viaSubtask = viaSubtask;
  if (Object.keys(viaNotes).length > 0) results.viaNotes = viaNotes;
  return results;
}

/** A project, routine or season, as a search row. */
export interface ContainerHit {
  kind: 'project' | 'routine' | 'season';
  id: string;
  name: string;
  /** The container's glyph token or emoji, for CategoryIcon. */
  glyph?: string;
}

/** Containers shown at most, across the three kinds: a jump, not a browse. */
const CONTAINER_LIMIT = 4;

/**
 * Projects, routines and seasons by NAME, text-only like searchGoals and for
 * the same reason: the grammar's filters are questions about items. A
 * `project:Work` query still finds the items filed under Work, not the project.
 * Name hits that START with the text come first, so "work" puts Work above
 * Homework.
 */
export function searchContainers(
  raw: string,
  lists: {
    projects: readonly { id: string; name: string; emoji?: string }[];
    routines: readonly { id: string; name: string; icon?: string }[];
    seasons: readonly { id: string; name: string; icon?: string }[];
  }
): ContainerHit[] {
  const text = parseSearchQuery(raw).text.trim().toLowerCase();
  if (!text) return [];
  const hits: (ContainerHit & { rank: number; seq: number })[] = [];
  let seq = 0;
  const take = (kind: ContainerHit['kind'], id: string, name: string, glyph?: string) => {
    const at = name.toLowerCase().indexOf(text);
    if (at >= 0) hits.push({ kind, id, name, glyph, rank: at === 0 ? 0 : 1, seq: seq++ });
  };
  for (const p of lists.projects) take('project', p.id, p.name, p.emoji);
  for (const r of lists.routines) take('routine', r.id, r.name, r.icon);
  for (const s of lists.seasons) take('season', s.id, s.name, s.icon);
  return hits
    .sort((a, b) => a.rank - b.rank || a.seq - b.seq)
    .slice(0, CONTAINER_LIMIT)
    .map(({ kind, id, name, glyph }) => (glyph === undefined ? { kind, id, name } : { kind, id, name, glyph }));
}

/** Bin rows shown at most. The bin is the last place to look, not the first. */
const BIN_LIMIT = 3;

/**
 * What's in the bin, by name, text-only. Fed from a fetch the omnibar makes
 * itself (the bin must never enter the planner store, see
 * components/planner/organize/sections/trash.tsx), newest-deleted first as
 * listDeleted returns it.
 */
export function searchBin<T extends { name: string }>(raw: string, entries: readonly T[]): T[] {
  const text = parseSearchQuery(raw).text.trim().toLowerCase();
  if (!text) return [];
  return entries.filter((e) => e.name.toLowerCase().includes(text)).slice(0, BIN_LIMIT);
}

export interface SearchGroup {
  /** Registry type name — 'task', 'habit', or a custom slug. */
  type: string;
  /** Section heading: the type's plural label. */
  heading: string;
  items: Item[];
}

/**
 * Rows per section. The built-ins keep the counts the omnibar shipped with, so
 * a workspace with no custom types sees exactly what it saw before; a new type
 * gets a section of its own rather than being filed under Tasks because it
 * happens to ride the task pipeline.
 */
const GROUP_LIMITS: Record<string, number> = { task: 6, habit: 4 };
const GROUP_LIMIT_DEFAULT = 4;
/** Ceiling across all sections — five matching types must not fill the panel. */
const TOTAL_LIMIT = 12;

/**
 * Goals, as a channel BESIDE the item groups rather than a group inside them.
 *
 * `groupResults` is typed to `Item`s, keyed by item TYPE, and its rows are
 * rendered with `data-item-type`, a `doneStatus` and an edit action — a goal is
 * none of those, needs a navigate action, and would collide outright with a
 * user's custom item type literally named `goal` (still the codebase's
 * canonical example slug in several places).
 *
 * Text-only, deliberately: the search grammar's filters (`type:`, `project:`,
 * `priority:`) are all questions about items, and answering them with goals
 * would mean inventing a meaning for "goals with high priority". A query that
 * carries ONE of them and nothing else returns no goals at all, so `type:task`
 * does not list goals above the task section it asked for.
 *
 * Matches the NAME only. Matching `why` as well looked generous and read as a
 * bug: the row renders the name, so a hit inside a three-sentence motivation
 * paragraph appeared as a result with no visible reason to be there. The item
 * rows can match on context because they RENDER their container beside the
 * title; this row has nowhere to show it.
 */
export function searchGoals(raw: string, goals: readonly Goal[]): Goal[] {
  const query = parseSearchQuery(raw);
  const text = query.text.trim().toLowerCase();
  if (!text) return [];
  return goals.filter((goal) => goal.name.toLowerCase().includes(text));
}

/**
 * Splits a result set into one section per item type, in registry order
 * (built-ins first, then custom types as the user ordered them).
 *
 * Items whose type is no longer in the registry — a type deleted while its
 * items remain — keep their own section at the end rather than disappearing;
 * getItemTypeConfig falls back to a template for the heading.
 */

export function groupResults(results: SearchResults): SearchGroup[] {
  const byType = new Map<string, Item[]>();
  for (const row of [...results.tasks, ...results.habits] as unknown as Item[]) {
    const name = typeNameOf(row);
    const bucket = byType.get(name);
    if (bucket) bucket.push(row);
    else byType.set(name, [row]);
  }

  const known = getAllItemTypeNames().filter((name) => byType.has(name));
  const orphaned = [...byType.keys()].filter((name) => !known.includes(name));

  const order = [...known, ...orphaned].filter((type) => (byType.get(type)?.length ?? 0) > 0);

  const groups: SearchGroup[] = [];
  let budget = TOTAL_LIMIT;
  for (let i = 0; i < order.length; i++) {
    const type = order[i];
    // Hold back one row for each section still to come, so a matching type is
    // never dropped outright — it shrinks to a single row first. (Past ~12
    // matching types even that runs out, and the tail is cut.)
    const reserved = order.length - i - 1;
    const limit = Math.min(GROUP_LIMITS[type] ?? GROUP_LIMIT_DEFAULT, budget - reserved);
    if (limit < 1) break;
    const items = (byType.get(type) ?? []).slice(0, limit);
    budget -= items.length;
    groups.push({ type, heading: getItemTypeConfig(type).labelPlural, items });
  }
  return groups;
}
