/**
 * The one tool chat changes the planner with (AI step 3: chat tools, build
 * step 4): `propose_changes`.
 *
 * Server-only. It never writes. A call becomes a PROPOSAL CARD under the
 * reply, the same card "Turn this into a plan" draws, and nothing in the
 * planner moves until the user taps Accept; accepting applies it through the
 * planner store, so it is one undo and leaves a receipt in the chat.
 *
 * The operations are checked twice. Here, against the user's own items read
 * under RLS, so the model learns at once what cannot be offered (an id it
 * made up, a status from the wrong vocabulary, a habit it may not create) and
 * its reply can match the card. Then again in the browser against the planner
 * as it is when the card lands (lib/proposal-store.ts `offer`), which is the
 * check that counts.
 *
 * One card a turn: the store holds one, and two cards for one message would
 * read as two answers.
 */

import { ProposalDraftSchema } from '@dsul/types';
import { milestoneItemIds } from '@/lib/goals';
import type { Goal, Item, ProposalDraft, ProposalOperation } from '@/lib/planner-types';
import { describeOperation, validateProposalOperations } from '@/lib/proposal';
import type { ToolDef } from './providers';

/** The most changes one card offers: the cap the plan prompt already asks for. */
export const MAX_CARD_CHANGES = 8;

export const PROPOSE_TOOL: ToolDef = {
  name: 'propose_changes',
  description:
    'Offer the user changes to their planner as a card they accept with one tap. Nothing changes until they ' +
    'accept, so call this whenever they ask you to add, move, reschedule, rename, finish, cancel or break down ' +
    'something, to start a habit or change how something repeats, or to tick off, skip, pause or resume a habit ' +
    'or a repeating item. An existing item is named by its id, so find it with find_items first. One card per ' +
    `message, at most ${MAX_CARD_CHANGES} changes. Not for projects, routines, seasons, goals, or deleting anything.`,
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'The card\'s headline, at most about 8 words: "Dentist moved to Monday".' },
      rationale: { type: 'string', description: 'Optional: one warm sentence on the thinking. Never scolding.' },
      operations: {
        type: 'array',
        maxItems: MAX_CARD_CHANGES,
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['create', 'update', 'verb'],
              description:
                'create a new item, update an existing one, or verb: tick off, skip, pause or resume one. A habit or ' +
                'a repeating item is only ever ticked or skipped with verb, one day at a time.',
            },
            itemId: { type: 'string', description: 'update and verb: the id of the item, copied exactly.' },
            verb: {
              type: 'string',
              enum: ['complete', 'skip', 'unskip', 'pause', 'resume'],
              description:
                'verb: complete ticks it off for the day, skip lets the day go without breaking anything, unskip ' +
                'takes a skip back, pause stops it showing up until resumed, resume brings it back.',
            },
            date: {
              type: 'string',
              description: 'verb: the day it is for, YYYY-MM-DD; today when left out. Never a day still to come for complete.',
            },
            until: {
              type: 'string',
              description: 'pause only: the day it comes back, YYYY-MM-DD. Leave out to pause until they resume it.',
            },
            itemType: {
              type: 'string',
              description:
                'create: "task" (the default), "habit" for something done again and again that keeps a streak, or ' +
                'the name of one of their own types.',
            },
            parentItemId: {
              type: 'string',
              description: "create: the id of a task this is a step of. Steps take no day or time.",
            },
            title: { type: 'string', description: 'create: the title (required). update: a new title.' },
            startDate: { type: 'string', description: 'The day, YYYY-MM-DD.' },
            startTime: { type: 'string', description: 'The time, HH:mm (24-hour).' },
            timeBucket: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'anytime'] },
            priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            clear: {
              type: 'array',
              items: { type: 'string', enum: ['startDate', 'startTime', 'priority'] },
              description:
                'update: fields to empty. startDate moves it to the braindump (no day), startTime keeps the day ' +
                'and drops the time, priority stops flagging it.',
            },
            notes: { type: 'string', description: 'Notes, replacing any there were.' },
            repeatFrequency: {
              type: 'string',
              enum: ['none', 'daily', 'weekdays', 'weekends', 'monthly', 'custom'],
              description:
                'How it repeats. A habit always repeats (daily when left out). A repeating task needs a startDate, ' +
                'its first day. custom needs repeatDays; none stops a task repeating.',
            },
            repeatDays: {
              type: 'array',
              items: { type: 'integer', minimum: 0, maximum: 6 },
              description: 'For custom: the days, 0 = Sunday … 6 = Saturday.',
            },
            repeatMonthDay: { type: 'integer', minimum: 1, maximum: 31, description: 'For monthly: the day of the month.' },
            timesPerDay: { type: 'integer', minimum: 1, description: 'Habits only: how many times a day, e.g. 8 glasses of water.' },
            project: { type: 'string', description: 'create: the project to put it in, by name.' },
            status: {
              type: 'string',
              enum: ['completed', 'cancelled', 'pending'],
              description: 'update: completed to tick it off, cancelled to drop it, pending to reopen it.',
            },
          },
          required: ['kind'],
        },
      },
    },
    required: ['summary', 'operations'],
  },
};

export interface ChangeSource {
  items(): Promise<Item[]>;
  goals(): Promise<Goal[] | null>;
  /** The user's own type names; null when they cannot be read. */
  itemTypes(): Promise<string[] | null>;
}

export interface ChangeResult {
  content: string;
  action: string;
  /** Present only when a card is to be shown. */
  proposal?: ProposalDraft;
}

const QUOTE_MAX = 60;

function quote(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > QUOTE_MAX ? `${flat.slice(0, QUOTE_MAX - 1)}…` : flat;
}

const CLEARABLE = new Set(['startDate', 'startTime', 'priority']);

/**
 * The tool's arguments as a ProposalDraft. Two translations, both because the
 * wire shape has to suit every provider: a create with no type is a task, and
 * `clear: [...]` becomes the null a ProposalOperation uses to empty a field
 * (a nullable property is a union type, which not every provider's schema
 * dialect accepts).
 */
function toDraft(args: Record<string, unknown>): unknown {
  const op = (raw: unknown): unknown => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const { clear, ...rest } = raw as Record<string, unknown>;
    const out: Record<string, unknown> = { ...rest };
    if (out.kind === 'create' && !out.itemType) out.itemType = 'task';
    if (out.kind === 'update' && Array.isArray(clear)) {
      for (const field of clear) if (typeof field === 'string' && CLEARABLE.has(field)) out[field] = null;
    }
    return out;
  };
  return {
    summary: typeof args.summary === 'string' ? args.summary.trim() : args.summary,
    ...(typeof args.rationale === 'string' && args.rationale.trim() ? { rationale: args.rationale.trim() } : {}),
    operations: Array.isArray(args.operations) ? args.operations.map(op) : args.operations,
  };
}

export function makeChangeOffer(source: ChangeSource) {
  let offered = false;

  return async function proposeChanges(args: Record<string, unknown>): Promise<ChangeResult> {
    const failed = (content: string): ChangeResult => ({
      content: `error: ${content}`,
      action: 'Tried to suggest a change that did not work',
    });
    if (offered) return failed('you already offered a card for this message. Say what is on it instead.');

    const parsed = ProposalDraftSchema.safeParse(toDraft(args));
    if (!parsed.success) {
      const where = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
        .join('; ');
      return failed(`the card could not be read (${where}). Fix it and call again.`);
    }
    const draft = parsed.data;
    if (draft.operations.length > MAX_CARD_CHANGES) {
      return failed(`at most ${MAX_CARD_CHANGES} changes on one card. Offer the most useful ones.`);
    }

    const [items, goals, types] = await Promise.all([source.items(), source.goals(), source.itemTypes()]);
    const ctx = { items, customTypeNames: types ?? [], milestoneIds: milestoneItemIds(goals ?? []) };
    const { accepted, rejected } = validateProposalOperations(draft.operations as ProposalOperation[], ctx);
    const refusedLines = rejected.map((r) => `- ${describeOperation(r.operation, ctx)}: ${r.reason}`);

    if (accepted.length === 0) {
      return failed(
        ['none of those changes can be offered:', ...refusedLines, 'Fix them and call again, or tell the user what cannot be done.'].join('\n')
      );
    }

    offered = true;
    const proposal: ProposalDraft = { ...draft, operations: accepted };
    const lines = [
      `The user now sees a card headed "${draft.summary}" with these changes:`,
      ...accepted.map((op) => `- ${describeOperation(op, ctx)}`),
    ];
    if (refusedLines.length) lines.push('Left off the card because they cannot be done:', ...refusedLines);
    lines.push(
      'Nothing has changed yet: the planner changes only if they tap Accept on the card. ' +
        'In your reply, say in a sentence what you offered and that they can accept it below. Never say you made the change.'
    );
    return {
      content: lines.join('\n'),
      action: `Suggested "${quote(draft.summary)}"`,
      proposal,
    };
  };
}
