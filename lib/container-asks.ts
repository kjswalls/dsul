import { sameContainerName } from './container-registry';
import { goalItemIds } from './goals';
import { getItemTypeConfig, itemTypeName } from './item-registry';
import { MAX_MENTIONED } from './chat-mentions';
import { isRecurring } from './recurrence';
import type { Goal, Item, Project, Routine, Season } from './planner-types';

/**
 * WHAT CAN BE ASKED OF THE AI ABOUT A CONTAINER, OR ABOUT A SELECTION OF
 * ITEMS, declared once. The item-level asks are lib/item-asks.ts; this is the
 * same "AI ▸" row on a project, routine, season or goal
 * (components/planner/container-context-menu.tsx) and on a multiselection
 * (components/planner/item-context-menu.tsx SelectionBody). What each one DOES
 * lives in lib/open-chat.ts (`composeNew`, `askNew`); this module gates,
 * labels and words, and is pure.
 *
 * A container has no conversation of its own (one conversation per ITEM is a
 * database rule), so both container asks start a new conversation from Ask
 * home: "Ask about this…" with the words waiting in its box, nothing sent;
 * "Break it down" / "Help me plan this" sent. The chat context names projects
 * but not what any container holds, so the words carry the members' titles
 * themselves: what the model is told is exactly what the user sees in the box.
 *
 * A selection is different: its items ARE items, so "Ask about these…" names
 * them as @ mentions (lib/chat-mentions.ts), and the send gives the model each
 * one's detail. At most MAX_MENTIONED travel, so a larger selection is not
 * offered the ask rather than having some of it quietly dropped.
 *
 * COPY CONTRACT (as lib/item-asks.ts): every prompt is phrased as the user;
 * none names a failure, counts a miss or implies lateness.
 */

export type ContainerAskKind = 'project' | 'routine' | 'season' | 'goal';
export type ContainerAskId = 'ask' | 'plan';

/** What the asks need to know about one container. */
export interface ContainerAskSubject {
  kind: ContainerAskKind;
  name: string;
  /** Open members' titles, in the container's own order where it keeps one. */
  members: string[];
  /** A season's window or a goal's span, yyyy-MM-dd. */
  startsOn?: string;
  endsOn?: string;
}

/** At most this many member titles are written out; the rest are counted. */
export const MAX_NAMED_MEMBERS = 8;

const isStep = (item: Item) => 'parentItemId' in item && !!item.parentItemId;

/** A finished one-off holds nothing left to plan; a repeating item never finishes as a whole. */
function isOpen(item: Item): boolean {
  if (item.type === 'habit' || isRecurring(item)) return true;
  return item.status !== getItemTypeConfig(itemTypeName(item)).doneStatus && item.status !== 'cancelled';
}

export type AskableContainer = Project | Routine | Season | Goal;

/** The subject for a container, from the planner's items. Pure. */
export function containerAskSubject(kind: ContainerAskKind, container: AskableContainer, items: readonly Item[]): ContainerAskSubject {
  let members: Item[];
  if (kind === 'project') {
    members = items.filter(
      (i) => i.projectId === container.id || (!i.projectId && !!i.project && sameContainerName('project', i.project, container.name))
    );
  } else {
    const ids = kind === 'goal' ? goalItemIds(container as Goal) : (container as Routine | Season).itemIds;
    const byId = new Map(items.map((i) => [i.id, i]));
    members = ids.flatMap((id) => byId.get(id) ?? []);
  }
  const subject: ContainerAskSubject = {
    kind,
    name: container.name.trim(),
    members: members.filter((i) => !isStep(i) && isOpen(i) && i.title.trim()).map((i) => i.title.trim()),
  };
  if (kind === 'season') {
    const s = container as Season;
    if (s.startsOn) subject.startsOn = s.startsOn.slice(0, 10);
    if (s.endsOn) subject.endsOn = s.endsOn.slice(0, 10);
  } else if (kind === 'goal') {
    const g = container as Goal;
    if (g.targetOn) subject.endsOn = g.targetOn.slice(0, 10);
  }
  return subject;
}

/** “Work” project, “Mornings” routine, goal “Run a 10k”: how the user names it. */
function named(s: ContainerAskSubject): string {
  const name = `“${s.name}”`;
  if (s.kind === 'goal') return `goal ${name}${s.endsOn ? ` (aiming for ${s.endsOn})` : ''}`;
  if (s.kind === 'season') {
    const span = s.startsOn && s.endsOn ? ` (${s.startsOn} to ${s.endsOn})` : s.endsOn ? ` (until ${s.endsOn})` : '';
    return `${name} season${span}`;
  }
  return `${name} ${s.kind}`;
}

/** "A, B and C", "A, B and 4 more". */
function titles(list: readonly string[], joiner: string): string {
  const shown = list.slice(0, MAX_NAMED_MEMBERS);
  const rest = list.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(', ')}${joiner}${shown.at(-1)}`;
}

/** What it holds, as a sentence; a routine is in order. */
function holding(s: ContainerAskSubject): string {
  if (s.members.length === 0) return "It's empty so far.";
  if (s.kind === 'routine') return `It goes ${titles(s.members, ', then ')}.`;
  return `It has ${titles(s.members, ' and ')}.`;
}

export interface ContainerAsk {
  id: ContainerAskId;
  label: (s: ContainerAskSubject) => string;
  /**
   * compose  a new conversation with `text` in its box; nothing is sent
   * send     a new conversation, `text` sent as its first message
   */
  kind: 'compose' | 'send';
  text: (s: ContainerAskSubject) => string;
}

export const CONTAINER_ASKS: Record<ContainerAskId, ContainerAsk> = {
  ask: {
    id: 'ask',
    kind: 'compose',
    label: () => 'Ask about this…',
    // Ends in a space: the caret lands after it, ready for the question.
    text: (s) => `About my ${named(s)}. ${holding(s)} `,
  },
  plan: {
    id: 'plan',
    kind: 'send',
    // A project and a goal hold work to break into steps; a routine and a
    // season are shaped rather than broken down.
    label: (s) => (s.kind === 'project' || s.kind === 'goal' ? 'Break it down' : 'Help me plan this'),
    text: (s) => {
      switch (s.kind) {
        case 'project':
          return `Help me break down my ${named(s)} into next steps. ${holding(s)} What would the next few steps be?`;
        case 'goal':
          return `Help me break down my ${named(s)} into steps. ${holding(s)} What could I do next to move toward it?`;
        case 'routine':
          return `Help me plan my ${named(s)}. ${holding(s)} ${
            s.members.length ? 'Does the order work, and is anything missing or too much?' : 'What could go in it?'
          }`;
        case 'season':
          return `Help me plan my ${named(s)}. ${holding(s)} What would help it go well?`;
      }
    },
  },
};

export const CONTAINER_ASK_ORDER: readonly ContainerAskId[] = ['ask', 'plan'];

/** The asks to offer on a container, in menu order. Empty when nothing can answer. */
export function containerAsksFor(gate: { canChat: boolean }): ContainerAsk[] {
  return gate.canChat ? CONTAINER_ASK_ORDER.map((id) => CONTAINER_ASKS[id]) : [];
}

/* ── a selection ─────────────────────────────────────────────────────── */

export const SELECTION_ASK_LABEL = 'Ask about these…';

/**
 * The words "Ask about these…" leaves in a new conversation's box: each
 * selected item as "@<title>", in the order given, then a space for the
 * question. Null when it cannot be offered: nothing can answer, fewer than
 * two items, more than MAX_MENTIONED (the send would carry only some), or two
 * that share a title (a mention finds items by title, so one of the two
 * would never reach the model).
 */
export function selectionAskText(items: readonly Item[], gate: { canChat: boolean }): string | null {
  if (!gate.canChat || items.length < 2 || items.length > MAX_MENTIONED) return null;
  const names = items.map((i) => i.title.trim());
  if (names.some((n) => !n)) return null;
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return null;
  return `${names.map((n) => `@${n}`).join(' ')} `;
}
