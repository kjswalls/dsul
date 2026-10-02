'use client';

import { useContext, useMemo } from 'react';
import { ProposalCard } from '@/components/ai/proposal-card';
import { BoundComposer, ComposerAwakeContext } from '@/components/ai/bound-composer';
import { OpenerChips } from '@/components/ai/opener-chips';
import { AskGreeting } from '@/components/ai/ask/ask-greeting';
import { NeedsYou } from '@/components/ai/ask/needs-you';
import { AIActivity } from '@/components/ai/ask/ai-activity';
import { usePlannerStore } from '@/lib/planner-store';
import { useConversationsStore } from '@/lib/conversations-store';
import { useEODStore } from '@/lib/eod-store';
import { buildChatOpeners, HOME_OPENERS } from '@/lib/ai-openers';
import { activityRows, dayEndFromReview, dayLoad, loadLine, needsYou } from '@/lib/ask-home';
import { askNew } from '@/lib/open-chat';
import { useAgentFreshness } from '@/hooks/use-agent-freshness';
import { useOpenerContext } from '@/hooks/use-opener-context';
import type { ComposerBinding } from '@/lib/rail-store';

/** Ask home's box: a send starts a new conversation and pushes it (lib/open-chat.ts). */
const HOME: ComposerBinding = { kind: 'home' };

/**
 * Ask home, the rail's resting view: what Ask shows with nothing pushed.
 *
 * From the top: the catch-up card when one is up, the greeting, the load line,
 * Needs you, With AI activity, then today's two chips and the box at the foot
 * (the static model label under it is BoundComposer's). The card's surface is
 * 'chat', and this is its one home whenever it is on screen; the docks'
 * catch-up hosts yield to it (lib/open-chat.ts useChatCardHomeShown), so it
 * never renders twice.
 *
 * Every section but the greeting renders only when it has something to say,
 * so a brand-new account sees the greeting, the chips and the box. Every line
 * is worked out in lib/ask-home.ts, under the copy contract there.
 *
 * The clock is the minute clock (lib/use-now-minutes.ts, through
 * hooks/use-opener-context.ts, which a new chat's chips read too), so the day,
 * the chips and "OpenClaw · 12m" turn on the minute and nothing reads
 * `Date.now()` in render. Until it is known (hydration only; Ask mounts behind
 * the AI gate, after it) nothing derived from it shows.
 *
 * Fresh without realtime: while Ask is on screen (ComposerAwakeContext is
 * "the rail is visible") the agent columns and the conversation list are
 * re-read on mount and on focus, throttled (hooks/use-agent-freshness.ts).
 *
 * A chip starts a FRESH conversation titled with its label, not its long
 * prompt (`askNew`), and pushes it; the box does the same with what was typed.
 */
export function AskHome() {
  const items = usePlannerStore((s) => s.items);
  const summaries = useConversationsStore((s) => s.summaries);
  const eodEnabled = useEODStore((s) => s.eodReviewEnabled);
  const eodTime = useEODStore((s) => s.eodReviewTime);
  const awake = useContext(ComposerAwakeContext);
  useAgentFreshness(awake);

  // The openers' own day, so the chips and the load line never disagree
  // about what today holds (lib/ai-openers.ts has why, and the copy rule).
  const { ctx, minutesNow, now, todayStr, tz } = useOpenerContext();

  const openers = useMemo(
    () => (ctx && minutesNow !== null ? buildChatOpeners(ctx, { max: HOME_OPENERS, minutesNow }) : []),
    [ctx, minutesNow]
  );

  const load = useMemo(
    () =>
      ctx && minutesNow !== null
        ? loadLine(dayLoad(ctx, { minutesNow, dayEndMin: dayEndFromReview(eodEnabled, eodTime) }))
        : null,
    [ctx, minutesNow, eodEnabled, eodTime]
  );

  const waiting = useMemo(() => needsYou(items), [items]);

  const activity = useMemo(
    () =>
      now === null || todayStr === null
        ? []
        : activityRows({ items, conversations: Object.values(summaries), now, todayStr, userTimezone: tz }),
    [items, summaries, now, todayStr, tz]
  );

  return (
    <div data-ask-home="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-1 pb-3">
        <ProposalCard surface="chat" />
        <div className="flex flex-col gap-0.5">
          <AskGreeting variant="home" />
          {load && (
            <p data-ask-load="" className="text-xs text-muted-foreground">
              {load}
            </p>
          )}
        </div>
        <NeedsYou items={waiting} />
        <AIActivity rows={activity} />
      </div>
      <div className="flex shrink-0 flex-col gap-2 px-3 pb-3">
        <OpenerChips
          openers={openers}
          onPick={(opener) => askNew(opener.prompt, { title: opener.label, isMobile: false })}
          className="px-2"
        />
        <BoundComposer binding={HOME} />
      </div>
    </div>
  );
}
