'use client';

import { RelayRow } from '@/components/ai/ai-work-badge';
import { useAiWork } from '@/hooks/use-ai-work';
import { useDoStuffEnabled } from '@/lib/extension-gates';
import { useDoStuffStore } from '@/lib/do-stuff';
import { NOTICE_RANK, type DockNotice } from '@/lib/dock-notices';

/**
 * The dock's one line about the AI's work (Kirby, 2026-10-22: a chip on every
 * row it touched was a lot to have in the sidebar). The rows say nothing about
 * what is ready, and only their titles shimmer while it works; this line says
 * it for the whole account:
 *
 *   ready    "3 ready · 1 question", the words crossed by a slow sheen every
 *            eight seconds (globals.css `[data-ai-sheen-slow]`), and Look,
 *            which starts Do stuff, whose ready lane holds exactly those rows.
 *   working  "Getting 2 things ready" with the relay as its glyph, while
 *            nothing is ready yet. Once something is, the ready line keeps
 *            the relay as its glyph for as long as work goes on.
 *
 * No anchor: it is about the account, not a row, so it keeps the dock's line
 * (lib/dock-notices.ts placeNotices). Ranked a receipt, below anything asking
 * for a decision, since it is the app's work on your behalf. Gone while doing
 * stuff, where the lanes and the key say it already.
 */
export function useAIWorkNotice(): DockNotice | null {
  const work = useAiWork();
  const doing = useDoStuffStore((s) => s.on);
  const canDoStuff = useDoStuffEnabled();
  if (doing) return null;

  const ready = work.ready - work.questions;
  if (work.ready > 0) {
    const parts = [
      ready > 0 ? `${ready} ready` : null,
      work.questions > 0 ? `${work.questions} ${work.questions === 1 ? 'question' : 'questions'}` : null,
    ].filter(Boolean);
    return {
      id: 'ai-work',
      rank: NOTICE_RANK.receipt,
      icon: work.working ? RelayGlyph : ready > 0 ? ReadyDot : QuestionDot,
      label: <span data-ai-sheen-slow="">{parts.join(' · ')}</span>,
      ...(canDoStuff ? { actionLabel: 'Look', onSelect: () => useDoStuffStore.getState().start() } : {}),
      testId: 'ai-work-notice',
    };
  }
  if (work.working) {
    return {
      id: 'ai-work',
      rank: NOTICE_RANK.statement,
      icon: RelayGlyph,
      label: `Getting ${work.workingCount} ${work.workingCount === 1 ? 'thing' : 'things'} ready`,
      testId: 'ai-work-notice',
    };
  }
  return null;
}

/* The glyphs take the row's className for its size; these marks size themselves. */

function RelayGlyph() {
  return <RelayRow label="" aria-hidden />;
}

function ReadyDot() {
  return <span data-ai-dot="" aria-hidden />;
}

function QuestionDot() {
  return <span data-ai-dot="question" aria-hidden />;
}
