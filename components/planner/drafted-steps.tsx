'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, RotateCcw, X } from 'lucide-react';
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

/**
 * The steps the AI drafted for an item, as rows in its Subtasks (Kirby's pick
 * A, "drafted rows", 2026-10-23): subtasks you haven't kept yet. A dashed box
 * and softer words set them apart; one aurora label holds Keep all and Clear;
 * each row keeps, hands off or drops itself, and its words edit in place.
 *
 * The one home for every way steps reach an item (the same pick's "one
 * home"): the panel's Draft steps (a breakdown, proposal-store `item:<id>`),
 * a prep pack of steps or subtasks (lib/prep-packs.ts), and first steps from
 * Do stuff or the item menu, which open the item here. A breakdown asked for
 * wins over a pack while it is up, since it is the newer ask.
 *
 * Nothing is added until a row is kept. Edits stay in the rows and shape what
 * is kept; they are never written back to the pack. What a gesture did is
 * said on one quiet line under the rows, with its Undo, never in a toast.
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

export function DraftedSteps({ item }: { item: Item }) {
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

  const label = (children: React.ReactNode, tail?: React.ReactNode) => (
    <div className="flex min-h-6 items-center gap-1.5 text-xs" data-testid="drafted-steps-label">
      <AskMark className="size-3" />
      {children}
      <span className="flex-1" />
      {tail}
    </div>
  );

  const noteLine = note && (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" data-testid="drafted-steps-note">
      <Check aria-hidden className="size-3" />
      {note.text}
      {note.undo && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            onClick={note.undo}
            data-testid="drafted-steps-undo"
            className="font-medium text-foreground underline-offset-2 hover:underline"
          >
            Undo
          </button>
        </>
      )}
    </p>
  );

  if (drafting) {
    return (
      <div className="flex flex-col gap-1" data-testid="drafted-steps" data-state="drafting">
        {label(
          <span data-steps-label="drafting" className="font-medium">
            Drafting steps…
          </span>,
          <button
            type="button"
            onClick={() => useProposalStore.getState().dismiss()}
            className="rounded-[6px] px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Stop
          </button>
        )}
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex h-6 items-center gap-2" aria-hidden>
            <span className="size-4 shrink-0 rounded-[5px] border border-dashed border-muted-foreground/30" />
            <span className="h-2 flex-1 animate-pulse rounded-full bg-surface-2" style={{ maxWidth: `${80 - i * 15}%` }} />
          </div>
        ))}
      </div>
    );
  }

  if (!showing && mine && (status === 'empty' || status === 'error')) {
    return (
      <div className="flex flex-col gap-1" data-testid="drafted-steps" data-state={status}>
        {label(
          <span className={cn(status === 'error' ? 'text-muted-foreground' : 'text-foreground')}>
            {status === 'empty' ? emptyMessage || 'This one is small enough to just do.' : error || "Couldn't draft steps."}
          </span>,
          <span className="flex items-center gap-0.5">
            {status === 'error' && (
              <button
                type="button"
                onClick={() => void useProposalStore.getState().retry()}
                className="rounded-[6px] px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Try again
              </button>
            )}
            <button
              type="button"
              aria-label="Close"
              onClick={() => useProposalStore.getState().dismiss()}
              className="flex size-6 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </span>
        )}
      </div>
    );
  }

  if (!showing) return noteLine || null;

  return (
    <div className="flex flex-col gap-0.5" data-testid="drafted-steps" data-state="ready">
      {label(
        <span data-steps-label="" className="font-medium">
          {rows.titles.length === 1 ? '1 step drafted' : `${rows.titles.length} steps drafted`}
        </span>,
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={keepAll}
            data-testid="drafted-steps-keep-all"
            aria-keyshortcuts="Meta+Enter"
            className="rounded-full bg-primary px-2.5 py-0.5 text-[11.5px] font-semibold text-primary-foreground hover:brightness-105"
          >
            Keep all
          </button>
          <button
            type="button"
            onClick={clear}
            data-testid="drafted-steps-clear"
            className="rounded-[6px] px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Clear
          </button>
        </span>
      )}
      {rows.titles.map((title, i) => (
        <div
          key={i}
          data-testid="drafted-step"
          data-first={i === 0 ? 'true' : undefined}
          className="group/draft relative -mx-1.5 flex min-h-7 items-center gap-2 rounded-[7px] px-1.5 focus-within:bg-accent hover:bg-accent"
        >
          <span
            aria-hidden
            data-drafted-box=""
            className="size-4 shrink-0 rounded-[5px] border-[1.5px] border-dashed"
          />
          <input
            value={title}
            onChange={(e) => edit(i, e.target.value)}
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
            aria-label={`Step ${i + 1}`}
            className={cn(
              '-mx-1 min-w-0 flex-1 bg-transparent px-1 py-1 text-sm outline-none',
              i === 0 ? 'text-foreground' : 'text-muted-foreground focus:text-foreground'
            )}
          />
          <span className="pointer-events-none flex items-center gap-0.5 opacity-0 group-focus-within/draft:pointer-events-auto group-focus-within/draft:opacity-100 group-hover/draft:pointer-events-auto group-hover/draft:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
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
      {redo === null ? (
        <button
          type="button"
          onClick={() => setRedo('')}
          data-testid="drafted-steps-redo"
          className="mt-0.5 flex w-fit items-center gap-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="size-3" />
          Redo with a note…
        </button>
      ) : (
        <form
          className="mt-1 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            ask(redo);
          }}
        >
          <input
            autoFocus
            value={redo}
            onChange={(e) => setRedo(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setRedo(null)}
            placeholder="What should it know? (we already have dates)"
            aria-label="A note for the redo"
            data-testid="drafted-steps-redo-note"
            className="h-7 min-w-0 flex-1 rounded-[8px] border border-input bg-transparent px-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <button
            type="submit"
            className="rounded-full border border-border px-2.5 py-0.5 text-[11.5px] font-medium text-muted-foreground hover:text-foreground"
          >
            Redo
          </button>
        </form>
      )}
      {noteLine}
    </div>
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
