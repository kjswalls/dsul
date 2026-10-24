'use client';

import { useState } from 'react';
import { QuestionRound } from '@/components/sidebar/question-round';
import { useAiWork } from '@/hooks/use-ai-work';
import { useDoStuffStore } from '@/lib/do-stuff';
import { NOTICE_RANK, type DockNotice } from '@/lib/dock-notices';

/**
 * The dock's one line about the AI's work (Kirby, 2026-10-22: a chip on every
 * row it touched was a lot to have in the sidebar). It says only what waits on
 * the person:
 *
 *   asking   "2 to answer", under a slow sheen (globals.css
 *            `[data-ai-sheen-slow]`), and Answer: it opens the quick round
 *            (components/sidebar/question-round.tsx, Kirby's pick D,
 *            2026-10-23), the questions one card at a time. Do stuff never
 *            waits on it.
 *
 * What is being worked on has no line (Kirby, 2026-10-24): the row itself
 * says it, wherever the item is, with the relay beside its shimmering title
 * (components/ai/ai-work-badge.tsx WorkingMark). "Getting 2 things ready"
 * only repeated the rows, and said nothing about which.
 *
 * On the desktop the questions are not here at all (Kirby's pick, 2026-10-24):
 * the header's Needs you badge counts them with the agents' and its inbox
 * answers them (components/ai/needs-you/prep-asker-card.tsx), so the desktop
 * has no line. The phone has no header badge and keeps "2 to answer" here.
 *
 * What is ready has no line either (Kirby, 2026-10-23): the do stuff key says
 * it, with its own sheen, and a line here only repeated it.
 *
 * No anchor: it is about the account, not a row, so it keeps the dock's line
 * (lib/dock-notices.ts placeNotices). Ranked a receipt, below anything asking
 * for a decision, since it is the app's work on your behalf. Gone while doing
 * stuff, where the lanes and the key say it already.
 */
export function useAIWorkNotice({ questions = true }: { questions?: boolean } = {}): DockNotice | null {
  const work = useAiWork();
  const doing = useDoStuffStore((s) => s.on);
  const [round, setRound] = useState(false);
  if (doing) return null;

  if (questions && work.questions > 0) {
    return {
      id: 'ai-work',
      rank: NOTICE_RANK.receipt,
      icon: QuestionDot,
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
  return null;
}

/* The glyph takes the row's className for its size; this mark sizes itself. */
function QuestionDot() {
  return <span data-ai-dot="question" aria-hidden />;
}
