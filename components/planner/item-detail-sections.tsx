'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { addDays, format, isAfter, startOfDay, startOfWeek, subWeeks } from 'date-fns';
import { Check, Plus, Split, X } from 'lucide-react';
import { AskMark } from '@/components/ai/ask-mark';
import { Input } from '@/components/ui/input';
import { usePlannerStore } from '@/lib/planner-store';
import { answerAgentQuestion } from '@/lib/agent-question';
import { useAgentQuestion } from '@/hooks/use-agent-question';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { assigneeLabel } from '@/lib/chat-utils';
import { AgentChip } from '@/components/primitives/pills';
import { PackInPanel } from '@/components/sidebar/prep-pack';
import { AgentExchangeFor } from '@/components/ai/agent-exchange';
import { useProposalStore } from '@/lib/proposal-store';
import { canBreakDown, canOfferBreakDown } from '@/lib/item-asks';
import { openSetup } from '@/lib/open-chat';
import { NUDGE_BREAK_IT_DOWN_OFFER } from '@/lib/nudges/registry';
import { useOneTimeNudge } from '@/hooks/use-one-time-nudge';
import { useIsMobile } from '@/hooks/use-mobile';
import { DraftedSteps, useStepDraftsShowing } from '@/components/planner/drafted-steps';
import { ItemConversation } from '@/components/ai/item-conversation';
import { ItemFilesSection } from '@/components/planner/item-files';
import { ItemTimeline } from '@/components/planner/item-timeline';
import { useExtensionsStore } from '@/lib/extensions-store';
import { EXT_HABIT_HEATMAP, resolveEnabled } from '@/lib/extension-registry';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { agentStatusView, showsAgentChip } from '@/lib/agent-status';
import { isAppAssignee } from '@/lib/handoff-wake';
import { BandLabel } from '@/components/planner/item-bands';
import { isBulkPaste, splitBulkLinesWithMeta } from '@/lib/bulk-add';
import { EDIT_COPY } from '@/lib/item-edit';
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

function SubtasksSection({ item, offerSetup }: { item: Item; offerSetup: boolean }) {
  const { items, addTask, addTasksBulk, deleteTask, toggleTaskStatus } = usePlannerStore();
  const [title, setTitle] = useState('');

  const { canPropose, askInvite } = useAICapabilities();
  const offerNudge = useOneTimeNudge(NUDGE_BREAK_IT_DOWN_OFFER);
  const isMobile = useIsMobile();
  const requestProposal = useProposalStore((s) => s.request);
  // Scoped to THIS item, not global. The spinner renders on the surface that
  // asked, so a breakdown loading for another item must not grey out this
  // one's button with no spinner in sight. Superseding another surface's
  // request is safe: the store drops the reply of any request no longer current.
  const proposalBusy = useProposalStore(
    (s) => s.status === 'loading' && s.lastRequest?.surface === `item:${item.id}`
  );

  // A breakdown asked from outside the section (the right-click menu's "Ask
  // AI") answers here, in a rail body that may be scrolled anywhere: the panel
  // keeps its scroll across items, and "Continue conversation" scrolls it down
  // to the conversation. So when this item's card starts loading out of view,
  // the rail body, and only it (never scrollIntoView, which would move <main>
  // too), brings the section to its top. Asked from the button, it is in view
  // already and nothing moves.
  const sectionRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const body = section?.closest<HTMLElement>('[data-rail-body]');
    if (!proposalBusy || !section || !body) return;
    const top = section.getBoundingClientRect().top - body.getBoundingClientRect().top;
    if (top < 0 || top > body.clientHeight - 48) body.scrollTop += top;
  }, [proposalBusy]);

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
   * Who may is asked of lib/item-asks.ts, which the right-click menu's "Ask AI"
   * asks too, so the two never disagree (it excludes subtasks: one level is
   * all this panel renders).
   */
  const breakable = canBreakDown(item, canPropose);
  // Drafts on screen (or coming) are the answer already: Redo lives under them.
  const drafts = useStepDraftsShowing(item.id, item.title);

  /**
   * The same moment before any AI is set up: while the gate invites, the
   * button is offered unlit and opens setup (the column, or the phone's setup
   * page) instead of asking. Nothing in it is lime, since nothing answers yet.
   * Its ✕ is a one-time nudge, so closing it once hides it on every item and
   * device; `active` stays false until this account's dismissals have loaded,
   * so it never flashes for someone who already closed it. Only where the
   * column or the Ask tab can open (the item panel), never on /item/[id].
   */
  const offered =
    offerSetup && !breakable && offerNudge.active && canOfferBreakDown(item, askInvite);

  return (
    <div ref={sectionRef} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>
          Subtasks{children.length > 0 ? ` · ${done} of ${children.length}` : ''}
        </SectionLabel>
        {breakable && !drafts && (
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
        {offered && (
          <span
            data-testid="break-it-down-offer"
            className="inline-flex items-center rounded-full border border-border text-[10px] font-medium text-muted-foreground"
          >
            <button
              type="button"
              onClick={() => openSetup(isMobile)}
              data-testid="break-it-down-setup"
              title="Set up AI to break this into small steps"
              className="inline-flex items-center gap-1 rounded-l-full py-0.5 pr-1 pl-2 transition-colors hover:text-foreground"
            >
              <Split className="h-2.5 w-2.5" />
              Break it down
            </button>
            <button
              type="button"
              onClick={offerNudge.dismiss}
              data-testid="break-it-down-offer-close"
              aria-label="Hide Break it down"
              className="inline-flex items-center rounded-r-full py-0.5 pr-1.5 pl-0.5 transition-colors hover:text-foreground"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        )}
      </div>

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
      {/* What the AI drafted: rows not kept yet, after the kept ones. */}
      <DraftedSteps item={item} />
      <div className="flex items-center gap-2">
        <Plus className="text-muted-foreground size-4 shrink-0" />
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={EDIT_COPY.subtaskPlaceholder}
          data-sub-input
          data-testid="subtask-add-input"
          className="placeholder:text-muted-foreground -mx-1 min-w-0 flex-1 bg-transparent px-1 text-sm outline-none"
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
              toast(EDIT_COPY.subtaskPasteCapped);
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
 * Who has the item, its status chip (lit like the Ask key), and the way out.
 * What the agent and the user said is its exchange (components/ai/
 * agent-exchange.tsx): drawn here with its own answer box where the item has
 * no conversation on screen, else in the item's conversation, whose box
 * answers the agent while its question is open.
 */
function AgentSection({
  item,
  inConversation,
  statusElsewhere = false,
}: {
  item: Item;
  inConversation: boolean;
  /** The agent's status is drawn under the item's title instead (ItemDialog's `AgentStatus`). */
  statusElsewhere?: boolean;
}) {
  const { items, updateTask } = usePlannerStore();
  const { canDelegate } = useAICapabilities();
  const live = (items.find((i) => i.id === item.id) ?? item) as TaskItem;

  // No type test here on purpose: the call site gates on the registry's
  // `agentAssignable`, which is the single answer to "may this be delegated"
  // (habit: no, custom: no while the agent write API cannot address it). A
  // second, hardcoded check in here is how the two drift apart.

  if (!live.assignee) {
    // Only an agent can DO background work. A connected model is a
    // request/response API with no worker behind it, and nothing in the app,
    // the agent API or any cron consumes a `beacon` assignment — a delegate
    // button that silently queues work nobody picks up is worse than no
    // button. So this asks one question: is an OpenClaw agent paired
    // (`canDelegate`, independent of who answers chat)? And it always writes
    // `openclaw`, the only assignee anything consumes.
    if (!canDelegate) return null;

    return (
      <button
        type="button"
        data-testid="assign-agent"
        onClick={() => updateTask(item.id, { assignee: 'openclaw', aiStatus: 'queued' })}
        className={cn(
          'inline-flex h-7 w-fit items-center gap-1.5 rounded-sm border border-dashed px-2.5',
          'border-input text-muted-foreground hover-wash text-xs transition-colors',
          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
        )}
      >
        <AskMark tone="ink" className="size-3" />
        Assign to OpenClaw
      </button>
    );
  }

  // One status, one place: under the title, the exchange in the conversation.
  if (statusElsewhere && inConversation) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="agent-block" data-agent-state={live.aiStatus}>
      {!statusElsewhere && <AgentStatus item={live} />}
      {!inConversation && <AgentExchangeFor item={live} withAnswerBox />}
    </div>
  );
}

/**
 * Who has the item and how it is going: the agent's name, the row's own
 * status chip, and the recoveries (Try again, Wake, Unassign). Drawn under the
 * title in the item panel and page (the item conversations design's "one
 * status, one place"), or at the top of the Agent section where there is no
 * title above it. Nothing for an item nobody holds.
 */
export function AgentStatus({ item }: { item: Item }) {
  const { items, updateTask } = usePlannerStore();
  const live = (items.find((i) => i.id === item.id) ?? item) as TaskItem;

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

  const view = showsAgentChip(live) ? agentStatusView(live, now) : null;
  // A connected app that never picked the item up can be woken again: it runs
  // only when woken (lib/handoff-wake.ts), so a lost or refused wake leaves the
  // item queued forever. Re-queueing stamps it fresh and wakes the app (the
  // store's `requeues` path), and the wake route's cooldown and the agent's
  // own claim keep a double tap from starting two runs. OpenClaw listens on its
  // event feed instead, so there it would be a placebo and is not offered.
  const wakeable = !!view?.stalled && live.aiStatus === 'queued' && isAppAssignee(live.assignee);

  if (!live.assignee) return null;

  return (
    <div data-testid="agent-status">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <AskMark className="size-3.5" />
          {/* assigneeLabel, not CSS capitalize: a stored `beacon` (from before
              the AI lost its name) has to read as "AI", and the stored value is
              a contract that is never rewritten. */}
          <span className="text-foreground text-xs font-semibold">
            {assigneeLabel(live.assignee)}
          </span>
          {/* The row's own chip (pills.tsx AgentChip), lit like the Ask key:
              the same view, so the panel and the row never disagree. */}
          {view && <AgentChip item={live} view={view} title={view.detail} />}
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
              className="text-foreground hover:text-muted-foreground ml-auto text-[10px] font-medium"
            >
              Try again
            </button>
          )}
          {wakeable && (
            <button
              type="button"
              onClick={() => updateTask(item.id, { aiStatus: 'queued' })}
              data-testid="agent-wake"
              className="text-foreground hover:text-muted-foreground ml-auto text-[10px] font-medium"
            >
              Wake {assigneeLabel(live.assignee)}
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
              !view?.recoverable && !wakeable && 'ml-auto'
            )}
          >
            Unassign
          </button>
        </div>
        {/* Why the button is there, in words. */}
        {view?.stalled && <p className="text-muted-foreground text-xs leading-relaxed">{view.detail}</p>}
      </div>
    </div>
  );
}

/**
 * The answer half of `blocked`.
 *
 * Without this the agent can ask a question and nobody can answer it — the loop
 * is open at exactly the point where a human is needed. The options and the
 * answer are shared with Ask home's Needs-you card: which options belong to the
 * question on screen, and why they are tagged to it, is hooks/use-agent-
 * question.ts; what an answer writes (the reply on the trail, then the flip
 * back to `queued`, the load-bearing half) is lib/agent-question.ts.
 */
function AgentReply({ item }: { item: TaskItem }) {
  const [text, setText] = useState('');
  const { options, clear } = useAgentQuestion(item);

  const answer = (value: string) => {
    if (!answerAgentQuestion(item, value)) return;
    setText('');
    // The question is answered; the buttons would otherwise sit there inviting
    // a second reply to a queued item. (In the app the status flip unmounts
    // this whole section — but that is the CALLER's behaviour, not this
    // component's, and it should not be load-bearing here.)
    clear();
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

// ── Footer ───────────────────────────────────────────────────────────────────

/**
 * The autosaving panel's footer: "Saves as you go", the only promise a surface
 * with no Save button makes. The edit history it used to fold up beside that
 * is the item's timeline now (components/planner/item-timeline.tsx).
 */
export function ClearingFooter({ saving }: { saving: boolean }) {
  return (
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

// ── The stack ────────────────────────────────────────────────────────────────

/** Subtasks + agent + timeline, gated by the type's capability config, then
 *  the item's conversation (components/ai/item-conversation.tsx) in the shape
 *  its host asks for, which carries the timeline itself when it is on screen.
 *  /item/[id] mounts that conversation as its own column and says so with
 *  `conversationElsewhere`. */
export function ItemDetailSections({
  item,
  conversation = 'none',
  // Clearing folds Activity into a footer disclosure (ClearingFooter), so the
  // body stack omits it to avoid rendering the same feed twice.
  withActivity = true,
  offerSetup = false,
  conversationElsewhere = false,
  agentStatusElsewhere = false,
}: {
  item: Item;
  /** The host draws the agent's status under the item's title (`AgentStatus`). */
  agentStatusElsewhere?: boolean;
  /** The item's conversation is drawn by the host, outside these sections (the rail's pinned one). */
  conversationElsewhere?: boolean;
  /** True where AI setup can open from here (the item panel, on both shells),
   *  so an item that could be broken down offers it before AI is set up. */
  offerSetup?: boolean;
  /** ItemDialog's `conversation` prop: 'pinned' and 'transcript' draw the
   *  transcript only (the box is the host's), 'inline' brings its own box. */
  conversation?: 'pinned' | 'transcript' | 'inline' | 'none';
  withActivity?: boolean;
}) {
  const config = getItemTypeConfig(itemTypeName(item));
  // Extension gate + capability gate: the heatmap is opt-in (Settings →
  // Extensions) and only meaningful where the registry says a streak exists.
  const heatmapOn = useExtensionsStore((s) => resolveEnabled(s.enabled, EXT_HABIT_HEATMAP));
  // Where a conversation is on screen, the agent's exchange is drawn in it (ItemConversation).
  const { canChat } = useAICapabilities();
  return (
    // data-sub-input on the CONTAINER: the dialog's Enter-submit guard checks
    // closest('[data-sub-input]'), and everything in here — inputs AND buttons
    // (subtask toggles, assign/unassign, send) — handles its own Enter. Without
    // this, Enter on a focused subtask checkbox saves-and-closes the panel.
    <div className="flex flex-col gap-4" data-sub-input>
      {config.subtasks && <SubtasksSection item={item} offerSetup={offerSetup} />}
      {/* What the AI got ready for it (a prep pack): where a row's ready chip leads. */}
      {item.type === 'task' && <PackInPanel itemId={item.id} title={item.title} />}
      {config.agentAssignable && (
        <AgentSection
          item={item}
          inConversation={canChat && (conversation !== 'none' || conversationElsewhere)}
          statusElsewhere={agentStatusElsewhere}
        />
      )}
      <ItemFilesSection itemId={item.id} />
      {heatmapOn && config.counters.streak && <HeatmapSection item={item} />}
      {/* Where the conversation is on screen, the timeline is drawn inside it, as one stream. */}
      {withActivity && !(canChat && (conversation !== 'none' || conversationElsewhere)) && <ItemTimeline item={item} />}
      {/* Keyed by item: the panel retargets in place, and a message count
          carried over from the last item would read as new messages here and
          scroll the rail body to the bottom of a different conversation. */}
      {conversation !== 'none' && <ItemConversation key={item.id} item={item} mode={conversation} />}
    </div>
  );
}
