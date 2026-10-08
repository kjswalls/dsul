import { MOD_QUERY_LIMIT, MOD_STORE_VALUE_MAX_BYTES, MOD_TOASTS_PER_MINUTE } from './limits';
import { MOD_EVENT_KINDS, MOD_UI_EVENT_KINDS, type ModEventKind, type ModMethod } from './protocol';
import type { ModManifest, ModUse } from './schema';
import type { ModNodeType } from './ui/tree';

/**
 * What a mod does, in plain words (memory/plans/mods.md, build orders 8 to 10):
 * its uses, its hooks, its `$` methods, its panel nodes and its event fields.
 * One table each, typed exhaustively over the union it words, so a new use,
 * event, method or node is a compile error until it has words.
 *
 * Read in two places: Make's editor and Write card (components/settings/),
 * and the fixed prompt "Write with AI" sends (lib/ai-server/make-prompt.ts).
 * So it is pure and imports only types and ./limits: no store, no React, no
 * Supabase client, safe on the server and in the browser alike.
 *
 * The hook and method words are neutral ("when an item is ticked"), not
 * addressed to anyone, because the same line reads to the person on the card
 * and to the model in the prompt.
 */

/** What a mod may do, in the words the editor uses under the code. */
export const MOD_USE_WORDS: Record<ModUse, string> = {
  'items:read': 'see your items and container names',
  'items:write': 'add and change items',
  ui: 'show short messages, and open items and views from its commands',
  storage: 'keep its own saved data',
  look: 'change your theme or Look from its commands',
};

/** "a, b and c". */
function andList(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "It may keep its own saved data and show short messages." */
export function usesInWords(uses: readonly ModUse[]): string {
  if (uses.length === 0) return 'It asks for nothing: it can read the date and time, and log.';
  return `It may ${andList(uses.map((u) => MOD_USE_WORDS[u]))}.`;
}

/**
 * What a mod draws and asks of the person, in plain words (build order 9):
 * its panels and where they show, its settings, and that a panel can show
 * the titles of items it links to when it may read items. Empty for a mod
 * with neither panels nor settings.
 */
export function panelsInWords(m: Pick<ModManifest, 'uses' | 'panels' | 'settings'>): string {
  const parts: string[] = [];
  const n = m.panels.length;
  if (n > 0) {
    const card = m.panels.some((p) => p.card);
    const what = `Draws ${n} panel${n === 1 ? '' : 's'}`;
    parts.push(card ? `${what}, ${n === 1 ? '' : 'one '}shown under the braindump.` : `${what}.`);
    if (m.uses.includes('items:read')) parts.push('Shows titles of items you link to.');
  }
  const k = m.settings.length;
  if (k > 0) parts.push(`Has ${k} setting${k === 1 ? '' : 's'} you set in Make.`);
  return parts.join(' ');
}

/** When each hook runs. */
export const MOD_HOOK_WORDS: Record<ModEventKind, string> = {
  'item.completed': 'when an item is ticked',
  'item.uncompleted': 'when an item is unticked, by hand or by undo',
  'item.skipped': 'when an item is skipped for today',
  'item.created': 'when an item is added',
  'review.saved': "when the day's review is saved",
  command: 'when one of its commands is run',
  timer: 'when one of its timers goes off',
  'ui.resolve': 'when one of its panels is drawn',
  'ui.action': 'when a button on one of its panels is pressed',
  'atom.changed': 'when a field on one of its panels is changed',
};

const UI_HOOKS: ReadonlySet<ModEventKind> = new Set(MOD_UI_EVENT_KINDS);

/**
 * "As written now, it runs when an item is ticked and when one of its
 * commands is run." Panel hooks are left out (the panels line covers them),
 * and so is a mod with no other hook: ''. "As written now" because `register`
 * is ordinary code that may choose its hooks differently next time.
 */
export function hooksInWords(hooks: readonly ModEventKind[]): string {
  const words = MOD_EVENT_KINDS.filter((k) => hooks.includes(k) && !UI_HOOKS.has(k)).map((k) => MOD_HOOK_WORDS[k]);
  return words.length ? `As written now, it runs ${andList(words)}.` : '';
}

/** What each `$` method does and answers. */
export const MOD_METHOD_WORDS: Record<ModMethod, string> = {
  today: 'answers the date, time and part of day now: {"date": "YYYY-MM-DD", "time": "HH:MM", "bucket"}',
  log: "writes a line to the mod's log in Make",
  after: 'raises a "timer" event with this "name" (default "timer") after "ms" milliseconds',
  'items.get': 'answers one item by id, or null',
  'items.query': `answers up to ${MOD_QUERY_LIMIT} items matching every filter given`,
  'containers.list':
    'answers the names of the projects, routines, seasons and goals: {"projects": [...], "routines": [...], "seasons": [...], "goals": [...]}',
  'verbs.eligible': 'answers whether the verb may act on the item today: true or false',
  'items.create': 'adds an item. "type" is "task" or one of the type slugs in the next part, never "habit"; "project" must name a project that exists',
  'items.edit': 'changes an item\'s title, priority or project (null takes it out of its project). Say at least one',
  'verbs.run': 'runs a verb on an item. "inDays" goes with "reschedule", and only with it',
  'store.get': "answers one of the mod's saved values, or null",
  'store.keys': "answers the keys of the mod's saved values",
  'store.set': `saves a JSON value under a key, at most ${MOD_STORE_VALUE_MAX_BYTES.toLocaleString('en-US')} bytes; null deletes it`,
  'store.delete': 'deletes a saved value',
  'ui.toast': `shows a short message, one per hook and ${MOD_TOASTS_PER_MINUTE} a minute`,
  'ui.openItem': 'opens an item',
  'nav.go': 'goes to a view',
  'nav.organize': 'opens Organize',
  'look.set': 'sets the light or dark theme, or applies a Look',
  'ui.open': 'opens one of its own panels',
  'atom.get': 'answers one atom by key, or every atom',
  'atom.set': "sets an atom: a panel's state in memory, shared by all its panels",
  'settings.get': "answers the person's values for its settings, by key",
};

/** What each panel node draws. */
export const MOD_NODE_WORDS: Record<ModNodeType, string> = {
  stack: 'its children, top to bottom',
  row: 'its children, side by side',
  list: 'its children, as a list',
  divider: 'a line between parts',
  heading: 'a heading',
  text: 'plain text, a few lines at most',
  badge: 'a short tag',
  progress: 'a bar showing value out of max',
  stat: 'a big value over a label',
  button: 'a button; a press raises "ui.action" with its "action" and "arg"',
  checkbox: 'an on and off field, kept in an atom',
  input: 'a text, number or date field, kept in an atom',
  select: 'a choice from a list, kept in an atom',
  itemRef: 'a link to an item, by id (needs "items:read")',
  icon: 'an icon, by name',
};

/**
 * What each field of a hook's event holds, by name. Not the recipe words: in
 * a mod, `item` is the item itself, never a trigger.
 */
export const MOD_EVENT_FIELD_WORDS: Record<string, string> = {
  date: 'the day it happened on, "YYYY-MM-DD"',
  itemId: "the item's id",
  type: 'the item\'s type: "task", "habit", or a type slug',
  item: 'the item, as $.items.get answers it, when the mod has "items:read"; else absent',
  origin: '"user" when the person unticked it, "undo" when undo did',
  id: 'the id of the command that was run',
  name: 'the name the timer was set with',
  panelId: 'the id of the panel',
  action: "the pressed button's action",
  arg: "the pressed button's arg, when it has one",
  atoms: 'every atom now, by key',
  key: 'the atom that changed',
  value: 'its new value',
};
