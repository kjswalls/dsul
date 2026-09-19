'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { addDays, format, isAfter, startOfDay, startOfWeek, subWeeks } from 'date-fns';
import { ArrowUp, Check, ChevronDown, Plus, Sparkles, Split, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RelayField } from '@/components/primitives/relay-field';
import { usePlannerStore } from '@/lib/planner-store';
import {
  fetchItemEvents,
  getItemEventsAvailable,
  recordAgentReply,
  type ItemEvent,
} from '@/lib/db';
import { itemChatStore } from '@/lib/chat-store';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { useProposalStore } from '@/lib/proposal-store';
import { resolveAICapabilities } from '@/lib/ai-registry';
import { ProposalCard } from '@/components/ai/proposal-card';
import { useExtensionsStore } from '@/lib/extensions-store';
import { EXT_HABIT_HEATMAP, resolveEnabled } from '@/lib/extension-registry';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { agentStatusView } from '@/lib/agent-status';
import { BandLabel } from '@/components/planner/item-bands';
import { isBulkPaste, MAX_BULK_ITEMS, splitBulkLinesWithMeta } from '@/lib/bulk-add';
import { toast } from 'sonner';
import type { Item, TaskItem } from '@/lib/planner-types';
import { cn } from '@/lib/utils';

/**
 * The item detail sections — what the dialog never had room for. One component
 * serves both sizes of the surface: stacked inside the edit panel, and
 * re-parented into columns on /item/[id] (memory/plans/item-surface-growth.md).
 *
 * Which sections render is registry capability config (`subtasks`,
 * `agentAssignable`), the same way chips are — a custom type opts in with
 * zero work here.
 */

/**
 * The sections' heading is the BAND label — one component, so a section heading
 * and a band label are one typographic voice rather than two that happen to look
 * alike. See components/planner/item-bands.tsx.
 *
 * It was originally shared with the chips above, which were bands too. They are
 * not any more — every editing surface renders them as one label-less field — so
 * on the dialog these headings are now the only labels in the stack, which is
 * the point: the properties are chips you read by their values, the sections are
 * areas you read by their names. The bands themselves live on at /item/[id],
 * where this heading still sits directly beneath them.
 */
const SectionLabel = BandLabel;

// ── Subtasks ─────────────────────────────────────────────────────────────────

function SubtasksSection({ item }: { item: Item }) {
  const { items, addTask, addTasksBulk, deleteTask, toggleTaskStatus } = usePlannerStore();
  const [title, setTitle] = useState('');

  const provider = useAISettingsStore((s) => s.provider);
  const requestProposal = useProposalStore((s) => s.request);
  // Scoped to THIS item — see the note in chat-conversation.tsx. A breakdown
  // loading for another item must not grey out this one's button with no
  // spinner in sight.
  const proposalBusy = useProposalStore(
    (s) => s.status === 'loading' && s.lastRequest?.surface === `item:${item.id}`
  );

  // Live children — the edit dialog holds a SNAPSHOT of the parent, but the
  // subtask list must reflect toggles immediately.
  const children = items.filter(
    (i): i is TaskItem => i.type !== 'habit' && i.parentItemId === item.id
  );

  const addSubtask = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    addTask({ title: trimmed, parentItemId: item.id });
    setTitle('');
  };

  const done = children.filter((c) => c.status === 'completed').length;

  /**
   * "This is too big" is the moment the assistant is most useful and the moment
   * the user is least able to phrase a request — so it is a button, not a
   * prompt. The card answers HERE rather than in the sidebar: this section
   * often renders inside a dialog, and a suggestion delivered behind it would
   * be invisible.
   *
   * Nesting is excluded because one level is all this panel renders; the
   * validator and lib/db.ts both refuse a grandchild anyway, so a button here
   * would only produce a rejected operation.
   */
  const canBreakDown =
    resolveAICapabilities(provider).canPropose && !('parentItemId' in item && item.parentItemId);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>
          Subtasks{children.length > 0 ? ` · ${done} of ${children.length}` : ''}
        </SectionLabel>
        {canBreakDown && (
          <button
            onClick={() => requestProposal('breakdown', undefined, item.id)}
            disabled={proposalBusy}
            data-testid="break-it-down"
            className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-ai/40 hover:text-foreground disabled:opacity-50"
          >
            <Split className="h-2.5 w-2.5 text-ai" />
            Break it down
          </button>
        )}
      </div>

      <ProposalCard surface={`item:${item.id}`} className="mb-0.5" />
      {children.map((child) => (
        <div key={child.id} className="group flex items-center gap-2" data-testid="subtask-row">
          <button
            type="button"
            onClick={() => toggleTaskStatus(child.id)}
            aria-label={child.status === 'completed' ? 'Mark not done' : 'Mark done'}
            className={cn(
              'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
              child.status === 'completed'
                ? 'border-primary bg-primary'
                : 'border-muted-foreground/45 hover:border-primary'
            )}
          >
            {child.status === 'completed' && (
              <Check className="text-primary-foreground size-3" strokeWidth={3} />
            )}
          </button>
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm',
              child.status === 'completed' && 'text-muted-foreground line-through'
            )}
          >
            {child.title}
          </span>
          <button
            type="button"
            onClick={() => deleteTask(child.id)}
            aria-label={`Delete subtask ${child.title}`}
            className="text-muted-foreground hover:text-destructive opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Plus className="text-muted-foreground size-4 shrink-0" />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add subtask…"
          data-sub-input
          data-testid="subtask-add-input"
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            addSubtask();
          }}
          // A multi-line paste commits inline — every line becomes a subtask
          // of THIS parent, one set(), one ⌘Z. No bulk-add dialog hop here:
          // the dialog knows nothing of parents, and the rows land visibly in
          // the list right below the field.
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text/plain');
            if (!isBulkPaste(pasted)) return;
            e.preventDefault();
            const { titles, truncated } = splitBulkLinesWithMeta(pasted);
            addTasksBulk(
              'task',
              titles.map((line) => ({ title: line, parentItemId: item.id }))
            );
            // The parser's contract: a capped tail is surfaced, never silent.
            // This surface has no dialog to say it in, so the toast does.
            if (truncated) {
              toast(`Added the first ${MAX_BULK_ITEMS} subtasks — the paste had more.`);
            }
            setTitle('');
          }}
        />
      </div>
    </div>
  );
}

// ── Agent assignment ─────────────────────────────────────────────────────────

/**
 * Beacon's honey-keyed relay palette, for the ambient field behind its working
 * block. Beacon's hue is honey (--ai/--warning), not the app's lime `--primary`
 * — so this is passed as `darkPalette` to override the lime tokens the field
 * reads by default. Module constant on purpose: RelayField treats it as an
 * effect dependency, so a fresh array each render would re-init the canvas.
 * (Honey-dominant, with a lime and a teal for a little spectral life.)
 */
const BEACON_RELAY_DARK = [
  'oklch(0.80 0.11 85)',
  'oklch(0.85 0.13 88)',
  'oklch(0.80 0.11 85)',
  'oklch(0.87 0.19 125)',
  'oklch(0.74 0.13 62)',
  'oklch(0.72 0.09 190)',
] as const;

/** Honey is the agent's hue everywhere in dsul (--ai tokens). */
function AgentSection({ item }: { item: Item }) {
  const { items, updateTask } = usePlannerStore();
  const provider = useAISettingsStore((s) => s.provider);
  const live = (items.find((i) => i.id === item.id) ?? item) as TaskItem;
  const agentName = provider === 'openclaw' ? 'OpenClaw' : 'Beacon';

  /**
   * A ticking clock, because "has this run gone quiet" is a question about
   * elapsed time and `Date.now()` may not be read during render.
   *
   * Coarser than the row's minute tick: nothing here changes until the quiet
   * threshold is crossed, so checking a few times an hour is plenty, and only
   * one detail panel is ever open. Hooks run before the unassigned early
   * return below — they cannot be conditional — which costs an idle interval
   * on a panel with no agent on it. One timer, while a panel is open.
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // A minute, matching the row's pill. A ten-minute tick meant the row could
    // flip to "Gone quiet" while the panel two inches away still showed a plain
    // "working" and no recovery — the same item, disagreeing with itself.
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const view = agentStatusView(live, now);

  // No type test here on purpose: the call site gates on the registry's
  // `agentAssignable`, which is the single answer to "may this be delegated"
  // (habit: no, custom: no while the agent write API cannot address it). A
  // second, hardcoded check in here is how the two drift apart.

  if (!live.assignee) {
    // Can this tier actually DO background work? `ai-registry.ts` says the
    // assistant tier cannot — it is a request/response completions API with no
    // worker behind it — and nothing in the app, the agent API or any cron
    // consumes a `beacon` assignment. Offering the button anyway queues work
    // that sits untouched forever, and the registry's own header names this
    // exact failure: "a delegate button that silently does nothing on the
    // assistant tier is worse than no button".
    if (!resolveAICapabilities(provider).canDelegate) return null;

    return (
      <button
        type="button"
        data-testid="assign-agent"
        onClick={() =>
          updateTask(item.id, { assignee: provider === 'openclaw' ? 'openclaw' : 'beacon', aiStatus: 'queued' })
        }
        className={cn(
          'inline-flex h-7 w-fit items-center gap-1.5 rounded-sm border border-dashed px-2.5',
          'border-input text-muted-foreground hover-wash text-xs transition-colors',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
        )}
      >
        <Sparkles className="size-3" />
        Assign to {agentName}
      </button>
    );
  }

  // Only the actively-streaming state gets the ambient field; queued/blocked/
  // done/failed are static.
  const working = live.aiStatus === 'working';

  return (
    <div
      className="bg-warning/10 relative overflow-hidden rounded-md px-2.5 py-2"
      data-testid="agent-block"
      data-working={working || undefined}
    >
      {/* While Beacon works, a RelayField blooms behind the block — honey-keyed
          (Beacon's hue), not the app's lime primary. Pure decoration:
          pointer-events-none + aria-hidden, paused offscreen and frozen under
          reduced motion (all inherited from RelayField). */}
      {working && (
        <RelayField
          active
          className="absolute inset-0 z-0"
          darkPalette={BEACON_RELAY_DARK}
          // Warm 'harvest' (amber→terracotta→lime) in light mode so Beacon keeps
          // its honey identity there too, harmonising with the warm block rather
          // than laying a cool-gray sonar over it.
          lightPalette="harvest"
          pitch={30}
          focalY={0.5}
          // Kept modest so the assignee/result/Unassign text stays legible over
          // the bloom (the field peaks under the content baseline at focalY 0.5).
          activeIntensity={0.6}
          activeIntensityLight={0.4}
          mask="radial-gradient(135% 135% at 50% 45%, #000 40%, transparent 92%)"
        />
      )}
      <div className="relative z-10 flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Sparkles className="text-warning-text size-3.5 shrink-0" />
          <span className="text-warning-text text-xs font-semibold capitalize">{live.assignee}</span>
          {view && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 font-mono text-[9px] font-semibold tracking-wider uppercase',
                // 'blocked' is the only state that wants something FROM you, so
                // it's the only one that gets to raise its voice. The rest are
                // progress you're free to ignore.
                live.aiStatus === 'blocked'
                  ? 'bg-destructive text-destructive-foreground'
                  : 'bg-warning text-warning-foreground'
              )}
              title={view.detail}
            >
              {/* The VIEW's label, not the raw status. This panel used to print
                  "WORKING" beside a Try again button that appeared from nowhere —
                  so the evidence the button's safety depends on was the one thing
                  the surface offering it never showed. On /item/[id] there is no
                  row pill either, so this was the only place it could come from. */}
              {view.label}
            </span>
          )}
          {/* The LIGHT recovery, offered only once a run has actually gone quiet
              or failed.

              Unassign was the only way out, and it throws the delegation away —
              "this run died, have another go" is the far commoner want, and it
              keeps the assignee. Deliberately manual and deliberately gated:
              nothing claims work atomically, so a button that re-queued a run
              which was merely slow would put two workers on one task and let the
              second overwrite the first's report. The user seeing "Gone quiet" is
              the evidence that makes it safe. */}
          {view?.recoverable && (
            <button
              type="button"
              onClick={() => updateTask(item.id, { aiStatus: 'queued', aiResult: undefined })}
              data-testid="agent-requeue"
              className="text-warning-text hover:text-foreground ml-auto text-[10px] font-medium"
            >
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              updateTask(item.id, { assignee: undefined, aiStatus: undefined, aiResult: undefined })
            }
            className={cn(
              'text-muted-foreground hover:text-foreground text-[10px]',
              // Keeps its right-hand anchor when it is the only control.
              !view?.recoverable && 'ml-auto'
            )}
          >
            Unassign
          </button>
        </div>
        {/* Why the button is there, in words. */}
        {view?.stalled && (
          <p className="text-warning-text text-xs leading-relaxed">{view.detail}</p>
        )}
        {live.aiResult && (
          <p className="text-warning-text/85 text-xs leading-relaxed">{live.aiResult}</p>
        )}
        {live.aiStatus === 'blocked' && <AgentReply item={live} />}
      </div>
    </div>
  );
}

/** Shared empty list, so a render with no options allocates nothing. */
const NO_OPTIONS: string[] = [];

/**
 * The answer half of `blocked`.
 *
 * Without this the agent can ask a question and nobody can answer it — the loop
 * is open at exactly the point where a human is needed. Sending does two
 * things: it writes the reply to the item's activity trail, which is where the
 * agent reads it back from, and it flips the status to `queued` so the next
 * scheduled run picks the work up again. The flip is the load-bearing half; a
 * reply that did not re-queue would look answered and never move.
 */
function AgentReply({ item }: { item: TaskItem }) {
  const updateTask = usePlannerStore((s) => s.updateTask);
  const [text, setText] = useState('');
  /**
   * The fetched options, TAGGED with the item and question they belong to.
   *
   * Derived during render rather than reset by an effect, for the reason the
   * proposal card learned the same way: an effect resets a render late, so the
   * panel paints the previous item's buttons once before clearing them — and
   * this panel is REUSED across items (the dialog re-seeds on id change without
   * unmounting), so that frame has the new item's id already bound to the old
   * item's answers.
   */
  const optionsKey = `${item.id}\u0000${(item.aiResult ?? '').trim()}`;
  const [fetched, setFetched] = useState<{ key: string; options: string[] }>(() => ({
    key: '',
    options: NO_OPTIONS,
  }));
  const options = fetched.key === optionsKey ? fetched.options : NO_OPTIONS;

  /**
   * The tappable answers, if the agent offered any FOR THE QUESTION ON SCREEN.
   *
   * Fetched here rather than lifted from the Activity section below: this only
   * renders while `aiStatus` is `blocked`, so the query is rare, and the two
   * sections are independent by design (Activity is collapsible and may never
   * be opened).
   *
   * Two things this has to get right, both of which it got wrong first:
   *
   * 1. CLEAR BEFORE FETCHING. The detail panel is REUSED across items — the
   *    dialog re-seeds on id change without unmounting — so leaving the old
   *    options up during the round-trip meant opening blocked item B while A
   *    was on screen showed A's buttons with B's id already bound. A tap in
   *    that window filed A's answer against B and re-queued B unanswered.
   *
   * 2. MATCH THE QUESTION, not just "the newest event". The question the user
   *    reads comes from `aiResult`, which `dsul_report_progress` can also
   *    set — and that path writes no `agent_question` event. So an agent that
   *    asked with options, then asked again through the old tool, left the new
   *    question on screen above the OLD question's buttons. Comparing the
   *    payload against `aiResult` ties the two together, and incidentally
   *    handles a lost event (no match, no buttons) and a truncated feed the
   *    same safe way.
   */
  useEffect(() => {
    let cancelled = false;
    if (!getItemEventsAvailable()) return;

    fetchItemEvents(item.id)
      .then((events) => {
        if (cancelled) return;
        const question = events.find((e) => e.action === 'agent_question');
        if (!question) return;

        // Is this the question currently being asked?
        const asked = typeof question.payload?.question === 'string' ? question.payload.question : '';
        if (asked.trim() !== (item.aiResult ?? '').trim()) return;

        // Still open? A reply recorded AFTER it means the user already answered,
        // and re-offering the choices would invite a duplicate answer.
        const answeredSince = events.find((e) => e.action === 'agent_reply');
        if (answeredSince && answeredSince.createdAt > question.createdAt) return;

        const raw = Array.isArray(question.payload?.options)
          ? (question.payload.options as unknown[])
          : [];
        setFetched({
          key: optionsKey,
          options: raw.filter((o): o is string => typeof o === 'string' && o.trim().length > 0),
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [item.id, item.aiResult, optionsKey]);

  const answer = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    recordAgentReply(item.id, itemTypeName(item), trimmed);
    updateTask(item.id, { aiStatus: 'queued' });
    setText('');
    // The question is answered; the buttons would otherwise sit there inviting
    // a second reply to a queued item. (In the app the status flip unmounts
    // this whole section — but that is the CALLER's behaviour, not this
    // component's, and it should not be load-bearing here.)
    setFetched({ key: '', options: NO_OPTIONS });
  };

  const send = () => answer(text);

  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {options.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="agent-options">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => answer(option)}
              className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-foreground transition-colors hover:border-ai/40 hover:bg-muted"
            >
              {option}
            </button>
          ))}
        </div>
      )}

      {/* data-sub-input so the dialog's Enter-to-submit guard leaves this alone
          — Enter here answers the agent, it does not save the item. The box
          stays even with options: an exhaustive-looking list often isn't. */}
      <div className="flex items-center gap-1.5" data-sub-input>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            send();
          }
        }}
        placeholder="Answer…"
        data-testid="agent-reply-input"
        className="h-7 flex-1 text-xs"
      />
        <button
          type="button"
          onClick={send}
          disabled={!text.trim()}
          data-testid="agent-reply-send"
          className="text-warning-text hover:text-foreground disabled:opacity-40 text-[10px] font-medium"
        >
          Send
        </button>
      </div>
    </div>
  );
}

/**
 * Exported for tests only.
 *
 * The reply box is reachable from the UI only through a `blocked` item inside a
 * dialog, which would mean standing up the whole panel to test three lines of
 * option logic — and that logic is where the cross-item bug lived.
 */
export { AgentReply as AgentReplyForTest };

// ── Activity ─────────────────────────────────────────────────────────────────

function eventLabel(e: ItemEvent): string {
  if (e.action === 'create') return 'Created';
  if (e.action === 'delete') return 'Deleted';
  // The user's answer to a blocked agent — like a check-in note, the payload is
  // the only part worth reading.
  // The agent's question. Reads before the user's answer in the feed, and the
  // options are worth showing — they say what the agent thought the shape of
  // the answer was.
  if (e.action === 'agent_question') {
    const question = typeof e.payload?.question === 'string' ? e.payload.question.trim() : '';
    const options = Array.isArray(e.payload?.options)
      ? (e.payload.options as unknown[]).filter((o): o is string => typeof o === 'string')
      : [];
    if (!question) return 'Agent asked a question';
    return options.length > 0
      ? `Agent asked — ${question} (${options.join(' / ')})`
      : `Agent asked — ${question}`;
  }
  if (e.action === 'agent_reply') {
    const text = typeof e.payload?.text === 'string' ? e.payload.text.trim() : '';
    return text ? `You answered — ${text}` : 'You answered';
  }
  // A check-in note reads here as well as on the goal page. It is the one event
  // whose payload is something the user WROTE, so showing the action alone
  // would hide the only part worth reading — and an item whose notes live
  // exclusively on another surface is an item whose own page lies about its
  // history.
  if (e.action === 'checkin') {
    const note = typeof e.payload?.note === 'string' ? e.payload.note.trim() : '';
    return note ? `Checked in — ${note}` : 'Checked in';
  }
  const payload = e.payload ?? {};
  // The container ids ride along with every re-file (migration 027) and are an
  // internal mirror of the name beside them — listing both turns "Updated
  // project" into "Updated project, projectId", which names a column the user
  // has never seen. Dropped from the LABEL only; the payload keeps them.
  const keys = Object.keys(payload).filter((k) => k !== 'projectId' && k !== 'groupId');
  if ('assignee' in payload) {
    return payload.assignee ? `Assigned to ${payload.assignee}` : 'Unassigned';
  }
  if ('aiStatus' in payload && payload.aiStatus) return `Agent: ${payload.aiStatus}`;
  if ('status' in payload) {
    return payload.status === 'completed' ? 'Completed' : `Status → ${payload.status}`;
  }
  if (keys.length === 0) return 'Updated';
  return `Updated ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '…' : ''}`;
}

function ActivitySection({ itemId }: { itemId: string }) {
  const [events, setEvents] = useState<ItemEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchItemEvents(itemId).then((rows) => {
      if (!cancelled) setEvents(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  // Quiet when the table isn't deployed or nothing happened yet — the feed is
  // a bonus surface, never an empty-state to explain.
  if (!getItemEventsAvailable() || !events || events.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <SectionLabel>Activity</SectionLabel>
      {events.slice(0, 8).map((e) => (
        <div key={e.id} className="text-muted-foreground flex items-baseline gap-2 text-xs">
          <span className="bg-muted-foreground/60 size-1 shrink-0 translate-y-[-2px] rounded-full" />
          <span className="min-w-0 flex-1 truncate">{eventLabel(e)}</span>
          <time className="text-muted-foreground/70 shrink-0 font-mono text-[10px]">
            {format(new Date(e.createdAt), 'MMM d · HH:mm')}
          </time>
        </div>
      ))}
    </div>
  );
}

/**
 * The activity log as a footer disclosure — Clearing's home for it.
 *
 * The body stack shows Activity as its own labelled section; Clearing instead
 * folds the whole edit history into one quiet line in the pane's bottom-right,
 * across from "Saves as you go": the most recent change and its date, click to
 * expand the rest. The expanded list is height-capped and scrolls in a PLAIN
 * overflow container (a ScrollArea silently drops max-h — see CLAUDE.md). Same
 * quiet-null rule as ActivitySection: nothing to show ⇒ just the save note.
 *
 * It owns its own fetch (the panel above autosaves off a snapshot; this reads
 * the live event feed) and its own open state, reset when the panel retargets.
 */
export function ClearingFooter({
  itemId,
  saving,
  // On /item/[id] the page body already renders Activity, and the editor panel
  // is mounted withDetailSections=false so it must not double the feed. There the
  // save note (the sole autosave signal) still shows; the history disclosure and
  // its fetch are suppressed.
  showHistory = true,
}: {
  itemId: string;
  saving: boolean;
  showHistory?: boolean;
}) {
  const [events, setEvents] = useState<ItemEvent[] | null>(null);
  const [open, setOpen] = useState(false);

  // Mounted fresh per item (the caller keys on itemId), so events and the open
  // flag reset on retarget with no reset effect — a new item starts collapsed.
  useEffect(() => {
    if (!showHistory) return;
    let cancelled = false;
    fetchItemEvents(itemId).then((rows) => {
      if (!cancelled) setEvents(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [itemId, showHistory]);

  const has = showHistory && getItemEventsAvailable() && !!events && events.length > 0;
  const latest = has ? events![0] : null;

  return (
    <div>
      {has && open && (
        <div
          id={`item-history-${itemId}`}
          data-testid="item-history-list"
          className="bg-secondary/50 mb-2 max-h-[132px] overflow-y-auto rounded-md px-3 py-1"
        >
          {events!.slice(0, 20).map((e) => (
            <div key={e.id} className="text-muted-foreground flex items-baseline gap-2 py-1 text-xs">
              <span className="bg-muted-foreground/60 size-1 shrink-0 translate-y-[-2px] rounded-full" />
              <span className="min-w-0 flex-1 truncate">{eventLabel(e)}</span>
              <time className="text-muted-foreground/70 shrink-0 font-mono text-[10px]">
                {format(new Date(e.createdAt), 'MMM d · HH:mm')}
              </time>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <span
          role="status"
          aria-live="polite"
          className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
        >
          {/* The lime tick is its own element so no parent opacity ever dims it. */}
          <span className="bg-primary size-1.5 shrink-0 rounded-full" aria-hidden />
          {saving ? 'Saving…' : 'Saves as you go'}
        </span>
        {has && latest && (
          <button
            type="button"
            data-testid="item-history-toggle"
            aria-expanded={open}
            aria-controls={`item-history-${itemId}`}
            aria-label="Edit history"
            onClick={() => setOpen((o) => !o)}
            className="text-muted-foreground hover-wash inline-flex min-w-0 max-w-[62%] items-center gap-1.5 rounded-sm px-1.5 py-1 text-[11px] transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
          >
            <span className="min-w-0 truncate">{eventLabel(latest)}</span>
            <time className="text-muted-foreground/70 shrink-0 font-mono">
              {format(new Date(latest.createdAt), 'MMM d')}
            </time>
            <ChevronDown
              className={cn('size-3 shrink-0 opacity-60 transition-transform', open && 'rotate-180')}
              aria-hidden
            />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Habit heatmap (extension: habit-heatmap) ────────────────────────────────

const HEATMAP_WEEKS = 26;

/**
 * A six-month completion grid — the habit-heatmap extension's whole surface.
 * Columns are calendar weeks (aligned to the user's week start), rows are
 * days; the vocabulary is the dialog's streak strip scaled up: a done day is a
 * solid bead in the -text role (bright in dark), a missed day is a faint
 * day-off wash, the future is blank. Data is completedDates, already on the
 * client — no fetch, and quiet-null when there's nothing to draw (the
 * ActivitySection convention: a bonus surface, never an empty state).
 */
function HeatmapSection({ item }: { item: Item }) {
  const weekStartDay = usePlannerStore((s) => s.weekStartDay);
  const completedDates = (item as { completedDates?: string[] }).completedDates;

  const grid = useMemo(() => {
    if (!completedDates || completedDates.length === 0) return null;
    const done = new Set(completedDates);
    const today = startOfDay(new Date());
    const weekStartsOn = weekStartDay === 'monday' ? 1 : weekStartDay === 'saturday' ? 6 : 0;
    const start = startOfWeek(subWeeks(today, HEATMAP_WEEKS - 1), { weekStartsOn });
    let count = 0;
    const weeks = Array.from({ length: HEATMAP_WEEKS }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => {
        const date = addDays(start, w * 7 + d);
        if (isAfter(date, today)) return 'future' as const;
        if (done.has(format(date, 'yyyy-MM-dd'))) {
          count += 1;
          return 'done' as const;
        }
        return 'miss' as const;
      })
    );
    return { weeks, count };
  }, [completedDates, weekStartDay]);

  if (!grid || grid.count === 0) return null;

  return (
    <div className="flex flex-col gap-1.5" data-testid="habit-heatmap">
      <div className="flex items-baseline justify-between">
        <SectionLabel>History</SectionLabel>
        <span className="text-muted-foreground/70 font-mono text-[10px]">
          {grid.count} in 6 months
        </span>
      </div>
      <div className="flex gap-[3px]">
        {grid.weeks.map((week, w) => (
          <div key={w} className="flex flex-col gap-[3px]">
            {week.map((day, d) => (
              <span
                key={d}
                className={cn(
                  'size-[5px] rounded-[1.5px]',
                  day === 'done' && 'bg-warning-text',
                  day === 'miss' && 'bg-day-off/25',
                  day === 'future' && 'opacity-0'
                )}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Per-item thread ──────────────────────────────────────────────────────────

export function ItemThread({ item, className }: { item: Item; className?: string }) {
  // Store identity is cached per item id (itemChatStore), so the hook target
  // is stable across renders and hook ORDER never changes.
  const useThread = useMemo(() => itemChatStore(item.id), [item.id]);
  const { messages, isLoading, isTyping, send, hydrate, syncOpenclawInfo } = useThread();
  const provider = useAISettingsStore((s) => s.provider);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(0);

  useEffect(() => {
    hydrate();
    syncOpenclawInfo();
  }, [hydrate, syncOpenclawInfo]);

  // Scroll ONLY the thread's own list, and only on new messages — never on
  // the initial hydrate. scrollIntoView would scroll every ancestor too,
  // yanking the edit panel (or the page) down to the thread on open.
  useEffect(() => {
    const el = listRef.current;
    const prev = prevCount.current;
    prevCount.current = messages.length;
    if (!el || prev === 0 || messages.length <= prev) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isTyping]);

  const handleSend = () => {
    const text = draft.trim();
    if (!text || isLoading) return;
    setDraft('');
    void send(text);
  };

  const agentName = provider === 'openclaw' ? 'OpenClaw' : 'Beacon';

  return (
    <div className={cn('flex min-h-0 flex-col gap-1.5', className)} data-testid="item-thread">
      <SectionLabel>Thread</SectionLabel>
      {messages.length > 0 && (
        <div ref={listRef} className="flex max-h-64 min-h-0 flex-col gap-2 overflow-y-auto pr-1">
          {messages.map((m, i) => (
            <div
              key={i}
              className={cn(
                'max-w-[92%] rounded-md px-2.5 py-1.5 text-xs leading-relaxed whitespace-pre-wrap',
                m.role === 'user'
                  ? 'bg-secondary text-foreground self-end'
                  : 'bg-warning/10 text-foreground self-start'
              )}
            >
              {m.content ||
                (isTyping || isLoading ? '…' : '')}
            </div>
          ))}
        </div>
      )}
      <div className="border-input flex items-center gap-1.5 rounded-md border px-2 py-1">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Ask ${agentName} about this item…`}
          data-sub-input
          data-testid="item-thread-input"
          className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-xs outline-none"
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            e.preventDefault();
            handleSend();
          }}
        />
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          disabled={!draft.trim() || isLoading}
          onClick={handleSend}
          aria-label="Send"
        >
          <ArrowUp className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── The stack ────────────────────────────────────────────────────────────────

/** Subtasks + agent + activity, gated by the type's capability config.
 *  The thread is exported separately so the page can column it. */
export function ItemDetailSections({
  item,
  withThread,
  // Clearing folds Activity into a footer disclosure (ClearingFooter), so the
  // body stack omits it to avoid rendering the same feed twice.
  withActivity = true,
}: {
  item: Item;
  withThread?: boolean;
  withActivity?: boolean;
}) {
  const config = getItemTypeConfig(itemTypeName(item));
  // Extension gate + capability gate: the heatmap is opt-in (Settings →
  // Extensions) and only meaningful where the registry says a streak exists.
  const heatmapOn = useExtensionsStore((s) => resolveEnabled(s.enabled, EXT_HABIT_HEATMAP));
  return (
    // data-sub-input on the CONTAINER: the dialog's Enter-submit guard checks
    // closest('[data-sub-input]'), and everything in here — inputs AND buttons
    // (subtask toggles, assign/unassign, send) — handles its own Enter. Without
    // this, Enter on a focused subtask checkbox saves-and-closes the panel.
    <div className="flex flex-col gap-4" data-sub-input>
      {config.subtasks && <SubtasksSection item={item} />}
      {config.agentAssignable && <AgentSection item={item} />}
      {heatmapOn && config.counters.streak && <HeatmapSection item={item} />}
      {withActivity && <ActivitySection itemId={item.id} />}
      {withThread && <ItemThread item={item} />}
    </div>
  );
}
