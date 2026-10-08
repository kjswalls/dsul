'use client';

import { useContext, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ProposalCard } from '@/components/ai/proposal-card';
import { BoundComposer, ComposerAwakeContext } from '@/components/ai/bound-composer';
import { OpenerChips } from '@/components/ai/opener-chips';
import { AskGreeting } from '@/components/ai/ask/ask-greeting';
import { NeedsYou } from '@/components/ai/ask/needs-you';
import { AIActivity } from '@/components/ai/ask/ai-activity';
import { AskFlowNote, ItWorksCard, useItWorksShown } from '@/components/ai/ask/it-works-card';
import { usePlannerStore } from '@/lib/planner-store';
import { usePlannerLoaded } from '@/lib/planner-ready';
import { useConversationsStore } from '@/lib/conversations-store';
import { useEODStore } from '@/lib/eod-store';
import { buildChatOpeners, HOME_OPENERS, type ChatOpener } from '@/lib/ai-openers';
import { activityRows, dayEndFromReview, dayLoad, loadLine, needsYou } from '@/lib/ask-home';
import { askNew } from '@/lib/open-chat';
import { useAgentFreshness } from '@/hooks/use-agent-freshness';
import { useOpenerContext } from '@/hooks/use-opener-context';
import type { ComposerBinding } from '@/lib/rail-store';
import { cn } from '@/lib/utils';

/** Ask home's box: a send starts a new conversation and pushes it (lib/open-chat.ts). */
const HOME: ComposerBinding = { kind: 'home' };

/**
 * Whether the box scrolls with more of it out of sight below: its content
 * taller than it, and not scrolled to the end. Re-read on a scroll, and on any
 * change of size, the box's own or a section's inside it (a card answered,
 * "Show N more"), so it never goes stale while the content moves under it.
 */
function useScrollsBeneath(ref: RefObject<HTMLElement | null>): boolean {
  const [beneath, setBeneath] = useState(false);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const measure = () => setBeneath(box.scrollHeight - box.scrollTop - box.clientHeight > 1);
    measure();
    box.addEventListener('scroll', measure, { passive: true });
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    sizes?.observe(box);
    for (const el of Array.from(box.children)) sizes?.observe(el);
    // Sections come and go with what they have to say.
    const sections = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((n) => n instanceof Element && sizes?.observe(n));
        r.removedNodes.forEach((n) => n instanceof Element && sizes?.unobserve(n));
      }
      measure();
    });
    sections.observe(box, { childList: true });
    return () => {
      box.removeEventListener('scroll', measure);
      sizes?.disconnect();
      sections.disconnect();
    };
  }, [ref]);
  return beneath;
}

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
 *
 * The foot (the chips and the box) stays put while the sections above scroll,
 * and draws a hairline along its top only while some of them are out of sight
 * beneath it, so a fifth Needs-you card cut off at the chips reads as "scroll
 * for more". A rule, never a mask or an opacity fade: either would dim a lime
 * mark scrolling under it (CLAUDE.md, the lime accent).
 *
 * Right after a connection lands in this tab, "It works." sits under the
 * greeting with three of today's openers as live rows
 * (components/ai/ask/it-works-card.tsx), and the foot's chips stand down
 * until it is spent, so no opener is offered twice. An OpenRouter sign-in
 * that came home saved but unanswered says why in its place, quietly
 * (AskFlowNote, beside the card), and leaves the chips be.
 *
 * `variant="mobile"` is the phone's Ask tab: the same home, pushing on the
 * phone's stack, with no box of its own (the dock's bar is the tab's box).
 */
export function AskHome({ variant = 'rail' }: { variant?: 'rail' | 'mobile' }) {
  const phone = variant === 'mobile';
  const items = usePlannerStore((s) => s.items);
  const summaries = useConversationsStore((s) => s.summaries);
  const list = useConversationsStore((s) => s.list);
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

  // Answering is an act (a reply on the item's trail, then the re-queue), so
  // Needs you waits for fresh data (lib/planner-ready.ts, loaded). Over the
  // look-only preview it would offer a question already answered elsewhere,
  // and the write barrier would refuse the re-queue after the reply had gone.
  const loaded = usePlannerLoaded();
  const waiting = useMemo(() => (loaded ? needsYou(items) : []), [loaded, items]);

  // The conversations History lists, not every summary ever cached: one
  // deleted on another device leaves both at the same refresh. Today's are
  // always on the first page, and a save here places its own at once.
  const conversations = useMemo(
    () => [...new Set([...list.starredIds, ...list.ids])].flatMap((id) => (summaries[id] ? [summaries[id]] : [])),
    [list, summaries]
  );
  const activity = useMemo(
    () =>
      now === null || todayStr === null
        ? []
        : activityRows({ items, conversations, now, todayStr, userTimezone: tz }),
    [items, conversations, now, todayStr, tz]
  );

  const scrollerRef = useRef<HTMLDivElement>(null);
  const beneath = useScrollsBeneath(scrollerRef);
  const itWorks = useItWorksShown();
  const pick = (opener: ChatOpener) => askNew(opener.prompt, { title: opener.label, isMobile: phone });

  return (
    <div data-ask-home="" className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        data-ask-scroller=""
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-1 pb-1"
      >
        <ProposalCard surface="chat" />
        <div className="flex flex-col gap-0.5">
          <AskGreeting variant="home" />
          {load && (
            <p data-ask-load="" className="text-xs text-muted-foreground">
              {load}
            </p>
          )}
        </div>
        <ItWorksCard ctx={ctx} minutesNow={minutesNow} onPick={pick} />
        <AskFlowNote />
        <NeedsYou items={waiting} />
        <AIActivity rows={activity} surface={phone ? 'phone' : 'desktop'} />
      </div>
      <div
        data-ask-foot=""
        data-scrolls-beneath={beneath ? 'true' : undefined}
        className={cn(
          // The rule's 1px is always there, transparent at rest, so it never
          // moves the chips as it comes and goes.
          'flex shrink-0 flex-col gap-2 border-t px-3 pt-2 pb-3 transition-colors duration-150',
          beneath ? 'border-border' : 'border-transparent'
        )}
      >
        {!itWorks && <OpenerChips openers={openers} onPick={pick} className="px-2" />}
        {!phone && <BoundComposer binding={HOME} />}
      </div>
    </div>
  );
}
