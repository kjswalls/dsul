'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, X } from 'lucide-react';
import { AskMark } from '@/components/ai/ask-mark';
import { usePlannerStore } from '@/lib/planner-store';
import { useProposalStore } from '@/lib/proposal-store';
import { UNDO_MS, usePrepPacksStore } from '@/lib/prep-packs-store';
import { packIsStale, packIsSteps, packSteps } from '@/lib/prep-packs';
import { useHandOffTargets } from '@/lib/agents-store';
import { sameAssignee } from '@/lib/agent-assignees';
import { handOffItem } from '@/lib/agent-handoff';
import { useDoStuffStore } from '@/lib/do-stuff';
import type { Item } from '@/lib/planner-types';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';

/**
 * The steps the AI drafted for an item, as rows in its Subtasks (Kirby's pick
 * A, "drafted rows", 2026-10-23): subtasks you haven't kept yet. A dashed box
 * and softer words set them apart; one aurora label holds Keep all and Clear;
 * each row keeps, hands off or drops itself, and its words edit in place.
 * Since pick F (2026-11-21) the label and Keep all · Redo · Clear are words in
 * a note beside the Subtasks heading, and the rows sit on the kept rows' grid.
 *
 * The one home for every way steps reach an item (the same pick's "one
 * home"): the panel's Draft steps (a breakdown, proposal-store `item:<id>`),
 * a prep pack of steps or subtasks (lib/prep-packs.ts), and first steps from
 * Do stuff or the item menu, which open the item here. A breakdown asked for
 * wins over a pack while it is up, since it is the newer ask.
 *
 * Nothing is added until a row is kept. Edits stay in the rows and shape what
 * is kept; they are never written back to the pack. What a gesture did is
 * said in that note, with its Undo, never in a toast.
 */

type Source = { key: string; titles: string[]; from: 'pack' | 'proposal' };
type Note = { text: string; undo?: () => void };

const surfaceOf = (id: string) => `item:${id}` as const;

/** Is a draft from either source showing for this item, or being drafted? */
export function useStepDraftsShowing(itemId: string, title: string): boolean {
  const pack = usePrepPacksStore((s) => {
    const stored = s.packs[itemId];
    return !!stored && !packIsStale(stored, title) && packIsSteps(stored.pack);
  });
  const asked = useProposalStore(
    (s) =>
      s.lastRequest?.surface === surfaceOf(itemId) &&
      s.lastRequest.intent === 'breakdown' &&
      (s.status === 'loading' || s.status === 'ready' || s.status === 'empty' || s.status === 'error')
  );
  return pack || asked;
}

/**
 * `head` is the Subtasks heading's slot, where the note and its words go
 * (pick F); null while that slot mounts, and left out to draw it in place.
 */
export function DraftedSteps({ item, head }: { item: Item; head?: HTMLElement | null }) {
  const surface = surfaceOf(item.id);
  const stored = usePrepPacksStore((s) => s.packs[item.id]);
  const mine = useProposalStore((s) => s.lastRequest?.surface === surface && s.lastRequest.intent === 'breakdown');
  const status = useProposalStore((s) => s.status);
  const proposal = useProposalStore((s) => s.proposal);
  const emptyMessage = useProposalStore((s) => s.emptyMessage);
  const error = useProposalStore((s) => s.error);
  const targets = useHandOffTargets();
  const handTo = useDoStuffStore((s) => s.handTo);
  const target = targets.find((t) => sameAssignee(t.assignee, handTo)) ?? targets[0] ?? null;

  const packSource: Source | null =
    stored && !packIsStale(stored, item.title) && packIsSteps(stored.pack)
      ? { key: `k:${stored.updatedAt}`, titles: packSteps(stored.pack), from: 'pack' }
      : null;
  const proposalSource: Source | null =
    mine && status === 'ready' && proposal
      ? {
          key: `p:${proposal.id}`,
          titles: proposal.operations.flatMap((op) => (op.kind === 'create' ? [op.title] : [])),
          from: 'proposal',
        }
      : null;
  const drafting = mine && status === 'loading';
  const source = drafting ? null : proposalSource ?? packSource;

  // The rows, editable, tagged with the source they came from. A new source
  // (a fresh pack, a redo's answer) starts them over, derived during render
  // rather than synced by an effect a paint late. 'local' is rows an Undo put
  // back after their source had already gone.
  const [rows, setRows] = useState<{ key: string | null; titles: string[]; seen: string | null }>({
    key: null,
    titles: [],
    seen: null,
  });
  if (source && rows.seen !== source.key) {
    setRows({ key: source.key, titles: source.titles, seen: source.key });
  }
  const showing = rows.titles.length > 0 && (rows.key === 'local' || rows.key === source?.key);

  const [note, setNote] = useState<Note | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
  }, []);
  const say = (text: string, undo?: () => void) => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    setNote({ text, undo });
    noteTimer.current = setTimeout(() => setNote(null), UNDO_MS);
  };

  const [redo, setRedo] = useState<string | null>(null);

  // Like ProposalCard's: a breakdown this panel owns never outlives it, or it
  // would land on a panel nobody has open (components/ai/proposal-card.tsx).
  useEffect(
    () => () => {
      const store = useProposalStore.getState();
      if (store.lastRequest?.surface === surface) store.dismiss();
    },
    [surface]
  );

  /** Lets the sources go once no row is left: the rows were the offer. */
  const settle = () => {
    const proposals = useProposalStore.getState();
    if (proposals.lastRequest?.surface === surface) proposals.dismiss();
    usePrepPacksStore.getState().settle(item.id);
  };

  /** Puts rows back, under their source while it is still up. */
  const restore = (titles: string[], key: string | null) => () => {
    setNote(null);
    setRows((r) => ({ ...r, key: key && key === sourceKeyNow() ? key : 'local', titles }));
  };
  const sourceKeyNow = () => {
    const p = useProposalStore.getState();
    if (p.lastRequest?.surface === surface && p.status === 'ready' && p.proposal) return `p:${p.proposal.id}`;
    const k = usePrepPacksStore.getState().packs[item.id];
    return k ? `k:${k.updatedAt}` : null;
  };

  /** Removes rows; settles the sources when none are left. */
  const leave = (next: string[]) => {
    setRows((r) => ({ ...r, titles: next }));
    if (next.length === 0) settle();
  };

  const add = (titles: string[]): string[] => {
    const planner = usePlannerStore.getState();
    const before = new Set(planner.items.map((i) => i.id));
    planner.addTasksBulk(
      'task',
      titles.map((title) => ({ title, parentItemId: item.id }))
    );
    return usePlannerStore
      .getState()
      .items.filter((i) => !before.has(i.id))
      .map((i) => i.id);
  };
  const unadd = (ids: string[]) => {
    if (ids.length > 0) usePlannerStore.getState().deleteItems(ids);
  };

  const keep = (index: number, handOff = false) => {
    const was = rows.titles;
    const title = was[index]?.trim();
    if (!title) return;
    const ids = add([title]);
    const kid = usePlannerStore.getState().items.find((i) => i.id === ids[0]);
    if (handOff && target && kid) handOffItem(kid, target.assignee);
    leave(was.filter((_, i) => i !== index));
    const back = restore(was, rows.key);
    say(handOff && target ? `Handed to ${target.name}` : 'Subtask added', () => {
      unadd(ids);
      back();
    });
  };

  const keepAll = () => {
    const was = rows.titles;
    const titles = was.map((t) => t.trim()).filter(Boolean);
    if (titles.length === 0) return;
    const ids = add(titles);
    leave([]);
    const back = restore(was, rows.key);
    say(titles.length === 1 ? '1 subtask added' : `${titles.length} subtasks added`, () => {
      unadd(ids);
      back();
    });
  };

  const drop = (index: number) => {
    const was = rows.titles;
    leave(was.filter((_, i) => i !== index));
    say('Dropped', restore(was, rows.key));
  };

  const clear = () => {
    const was = rows.titles;
    const key = rows.key;
    setRows((r) => ({ ...r, titles: [] }));
    const proposals = useProposalStore.getState();
    if (proposals.lastRequest?.surface === surface) proposals.dismiss();
    // A pack's Not needed holds its delete for the undo (prep-packs-store).
    const packBack = usePrepPacksStore.getState().dismiss(item.id);
    say('Cleared', () => {
      packBack?.();
      setNote(null);
      setRows((r) => ({ ...r, key: packBack && key?.startsWith('k:') ? key : 'local', titles: was }));
    });
  };

  const ask = (known: string) => {
    setRedo(null);
    setNote(null);
    const text = known.trim();
    void useProposalStore
      .getState()
      .request(
        'breakdown',
        text ? `Break this into a few concrete steps. Something to know first: ${text}` : undefined,
        item.id
      );
  };

  const edit = (index: number, title: string) =>
    setRows((r) => ({ ...r, titles: r.titles.map((t, i) => (i === index ? title : t)) }));

  // The heading note (Kirby's pick F, 2026-11-21): what the draft is and what
  // to do with it, as quiet words beside the Subtasks heading, so nothing sits
  // between the last row and the add row. Portalled into the heading's slot;
  // with no slot given (a test, a host with no heading) it draws in place.
  const atHead = (node: React.ReactNode) =>
    head === undefined ? node : head ? createPortal(node, head) : null;

  const headNote = (children: React.ReactNode, testId = 'drafted-steps-label', role?: 'status') => (
    <span
      role={role}
      className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] leading-4"
      data-testid={testId}
    >
      {children}
    </span>
  );
  const mark = <AskMark className="size-2.5 shrink-0" />;
  const dot = (
    <span aria-hidden className="text-muted-foreground/60">
      ·
    </span>
  );

  const noteHead =
    note &&
    headNote(
      <>
        <Check aria-hidden className="text-muted-foreground size-3" />
        <span className="text-muted-foreground">{note.text}</span>
        {note.undo && (
          <>
            {dot}
            <HeadWord onClick={note.undo} testId="drafted-steps-undo" ink>
              Undo
            </HeadWord>
          </>
        )}
      </>,
      'drafted-steps-note',
      'status'
    );

  if (drafting) {
    return (
      <>
        {atHead(
          headNote(
            <>
              {mark}
              <span data-steps-label="drafting" className="font-medium">
                Drafting steps…
              </span>
              {dot}
              <HeadWord onClick={() => useProposalStore.getState().dismiss()}>Stop</HeadWord>
            </>
          )
        )}
        <div className="flex flex-col" data-testid="drafted-steps" data-state="drafting">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-2.5 py-[5px]" aria-hidden>
              <span className="flex h-5 shrink-0 items-center">
                <span className="size-4 rounded-[5px] border border-dashed border-muted-foreground/30" />
              </span>
              <span className="h-2 flex-1 animate-pulse rounded-full bg-surface-2" style={{ maxWidth: `${80 - i * 15}%` }} />
            </div>
          ))}
        </div>
      </>
    );
  }

  if (!showing && mine && (status === 'empty' || status === 'error')) {
    return (
      <>
        {atHead(
          headNote(
            <>
              {mark}
              <span className={cn(status === 'error' ? 'text-muted-foreground' : 'text-foreground')}>
                {status === 'empty' ? emptyMessage || 'This one is small enough to just do.' : error || "Couldn't draft steps."}
              </span>
              {status === 'error' && (
                <>
                  {dot}
                  <HeadWord onClick={() => void useProposalStore.getState().retry()}>Try again</HeadWord>
                </>
              )}
              {dot}
              <HeadWord onClick={() => useProposalStore.getState().dismiss()}>Close</HeadWord>
            </>
          )
        )}
      </>
    );
  }

  if (!showing) return noteHead ? atHead(noteHead) : null;

  return (
    <>
      {atHead(
        noteHead ||
          headNote(
            <>
              {mark}
              <span data-steps-label="" className="font-medium">
                {rows.titles.length} drafted
              </span>
              {dot}
              <HeadWord onClick={keepAll} testId="drafted-steps-keep-all" keys="Meta+Enter" ink>
                Keep all
              </HeadWord>
              {dot}
              <HeadWord onClick={() => setRedo(redo === null ? '' : null)} testId="drafted-steps-redo" expanded={redo !== null}>
                Redo
              </HeadWord>
              {dot}
              <HeadWord onClick={clear} testId="drafted-steps-clear">
                Clear
              </HeadWord>
            </>
          )
      )}
      <div className="flex flex-col" data-testid="drafted-steps" data-state="ready">
        {redo !== null && (
          <form
            className="mb-1 flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              ask(redo);
            }}
          >
            <input
              autoFocus
              value={redo}
              onChange={(e) => setRedo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.preventDefault();
                e.stopPropagation();
                setRedo(null);
              }}
              placeholder="What should it know? (we already have dates)"
              aria-label="A note for the redo"
              data-testid="drafted-steps-redo-note"
              className="h-7 min-w-0 flex-1 rounded-[8px] border border-input bg-transparent px-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button type="submit" className={buttonVariants({ size: 'sm' })}>
              Redo
            </button>
          </form>
        )}
        {rows.titles.map((title, i) => (
          <div
            key={i}
            data-testid="drafted-step"
            data-first={i === 0 ? 'true' : undefined}
            // The kept rows' own grid (subtask-row.tsx): a 16px box column,
            // 10px to the words, 5px above and below a 20px line.
            className="group/draft relative -mx-1.5 flex items-start gap-2.5 rounded-md px-1.5 py-[5px] focus-within:bg-accent hover:bg-accent"
          >
            <span className="flex h-5 shrink-0 items-center">
              <span aria-hidden data-drafted-box="" className="size-4 rounded-[5px] border-[1.5px] border-dashed" />
            </span>
            <StepField
              value={title}
              first={i === 0}
              label={`Step ${i + 1}`}
              onChange={(next) => edit(i, next)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  keepAll();
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  keep(i);
                } else if (e.key === 'Backspace' && title === '') {
                  e.preventDefault();
                  drop(i);
                } else if (e.key === 'Escape') {
                  e.currentTarget.blur();
                }
              }}
            />
            <span className="pointer-events-none flex h-5 items-center gap-0.5 opacity-0 group-focus-within/draft:pointer-events-auto group-focus-within/draft:opacity-100 group-hover/draft:pointer-events-auto group-hover/draft:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
              <RowButton label="Keep" onClick={() => keep(i)} testId="drafted-step-keep">
                <Check className="size-3.5" />
              </RowButton>
              {target && (
                <RowButton label={`Hand to ${target.name}`} onClick={() => keep(i, true)} testId="drafted-step-hand-off">
                  <ArrowRight className="size-3.5" />
                </RowButton>
              )}
              <RowButton label="Drop" onClick={() => drop(i)} testId="drafted-step-drop">
                <X className="size-3.5" />
              </RowButton>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * A step's words: one line tall, growing as they wrap, so a long step reads
 * whole instead of being cut off. Measured, so every browser grows it the
 * same way. A step is one line of text, so a pasted line break becomes a space.
 */
function StepField({
  value,
  first,
  label,
  onChange,
  onKeyDown,
}: {
  value: string;
  first: boolean;
  label: string;
  onChange: (next: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\s*[\r\n]+\s*/g, ' '))}
      onKeyDown={onKeyDown}
      aria-label={label}
      className={cn(
        '-mx-1 block min-w-0 flex-1 resize-none overflow-hidden bg-transparent px-1 py-0 text-sm leading-5 outline-none',
        first ? 'text-foreground' : 'text-muted-foreground focus:text-foreground'
      )}
    />
  );
}

/** A word in the heading note: quiet, full ink under the pointer; Keep all leads in ink. */
function HeadWord({
  onClick,
  testId,
  keys,
  ink,
  expanded,
  children,
}: {
  onClick: () => void;
  testId?: string;
  keys?: string;
  ink?: boolean;
  expanded?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-keyshortcuts={keys}
      aria-expanded={expanded}
      className={cn(
        'rounded-[4px] underline decoration-transparent decoration-dashed underline-offset-[3px] transition-colors hover:text-foreground hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        ink ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground',
        expanded && 'text-foreground'
      )}
    >
      {children}
    </button>
  );
}

function RowButton({
  label,
  onClick,
  testId,
  children,
}: {
  label: string;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid={testId}
      className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}
