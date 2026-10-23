'use client';

import { useState } from 'react';
import { RelayRow } from '@/components/ai/ai-work-badge';
import { QuestionRound } from '@/components/sidebar/question-round';
import { useAiWork } from '@/hooks/use-ai-work';
import { useDoStuffStore } from '@/lib/do-stuff';
import { NOTICE_RANK, type DockNotice } from '@/lib/dock-notices';

/**
 * The dock's one line about the AI's work (Kirby, 2026-10-22: a chip on every
 * row it touched was a lot to have in the sidebar). The rows say nothing about
 * what is ready, and only their titles shimmer while it works; this line says
 * it for the whole account:
 *
 *   asking   "2 to answer", under a slow sheen (globals.css
 *            `[data-ai-sheen-slow]`), and Answer: it opens the quick round
 *            (components/sidebar/question-round.tsx, Kirby's pick D,
 *            2026-10-23), the questions one card at a time. Do stuff never
 *            waits on it.
 *   working  "Getting 2 things ready" with the relay as its glyph, while
 *            nothing waits on an answer. The questions line keeps the relay
 *            as its glyph for as long as work goes on.
 *
 * What is ready has no line (Kirby, 2026-10-23): the do stuff key says it,
 * with its own sheen, and a line here only repeated it.
 *
 * No anchor: it is about the account, not a row, so it keeps the dock's line
 * (lib/dock-notices.ts placeNotices). Ranked a receipt, below anything asking
 * for a decision, since it is the app's work on your behalf. Gone while doing
 * stuff, where the lanes and the key say it already.
 */
export function useAIWorkNotice(): DockNotice | null {
  const work = useAiWork();
  const doing = useDoStuffStore((s) => s.on);
  const [round, setRound] = useState(false);
  if (doing) return null;

  if (work.questions > 0) {
    return {
      id: 'ai-work',
      rank: NOTICE_RANK.receipt,
      icon: work.working ? RelayGlyph : QuestionDot,
      label: <span data-ai-sheen-slow="">{`${work.questions} to answer`}</span>,
      actionLabel: 'Answer',
      tray: () => <QuestionRound onClose={() => setRound(false)} />,
      trayTitle: 'Your AI has questions',
      trayDescription: 'Answer what your AI asked, one card at a time, so it can get those things ready.',
      open: round,
      onOpenChange: setRound,
      trayTestId: 'question-round-tray',
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

function QuestionDot() {
  return <span data-ai-dot="question" aria-hidden />;
}
