'use client';

import { useMemo, useState } from 'react';
import { PackCard } from '@/components/sidebar/prep-pack';
import { usePlannerStore } from '@/lib/planner-store';
import { usePrepPacksStore } from '@/lib/prep-packs-store';
import { packIsQuestion, packIsStale, type PrepPack } from '@/lib/prep-packs';

/**
 * The quick round (Kirby's pick D, 2026-10-23): every question the AI has, one
 * card at a time, opened from the dock's line ("2 to answer · Answer"). An
 * answer sends the card's item back to be prepared and the next question takes
 * its place; ↓ or the arrows skip one. Nothing waits on it: Do stuff and every
 * lane work the same with the questions unanswered.
 */

/** The open items with a question on them, oldest question first. */
export function questionsWaiting(
  items: readonly { id: string; title: string; status?: string }[],
  packs: Readonly<Record<string, PrepPack>>
): { itemId: string; title: string; stored: PrepPack }[] {
  return items
    .filter((i) => i.status !== 'completed' && i.status !== 'cancelled')
    .map((i) => ({ itemId: i.id, title: i.title, stored: packs[i.id] }))
    .filter((q): q is { itemId: string; title: string; stored: PrepPack } =>
      !!q.stored && packIsQuestion(q.stored.pack) && !packIsStale(q.stored, q.title)
    )
    .sort((a, b) => a.stored.updatedAt.localeCompare(b.stored.updatedAt));
}

export function QuestionRound({ onClose }: { onClose: () => void }) {
  const items = usePlannerStore((s) => s.items);
  const packs = usePrepPacksStore((s) => s.packs);
  const waiting = useMemo(
    () => questionsWaiting(items as unknown as { id: string; title: string; status?: string }[], packs),
    [items, packs]
  );
  const [index, setIndex] = useState(0);
  const count = waiting.length;
  if (count === 0) {
    return (
      <p className="px-4 py-3 text-[13px] text-muted-foreground" data-testid="question-round-done">
        All answered. Your AI is getting them ready.
      </p>
    );
  }
  const at = Math.min(index, count - 1);
  const q = waiting[at];
  return (
    <div data-testid="question-round">
      <PackCard
        key={`${q.itemId}:${q.stored.updatedAt}`}
        itemId={q.itemId}
        title={q.title}
        stored={q.stored}
        nav={count > 1 ? { index: at, count, go: (dir) => setIndex((at + dir + count) % count) } : undefined}
        onClose={onClose}
        onSettled={() => {
          if (count <= 1) onClose();
        }}
      />
    </div>
  );
}
