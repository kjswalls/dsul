'use client';

import { useId, useMemo } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  History,
  Hourglass,
  Info,
  ListChecks,
  MessageCircle,
  type LucideIcon,
} from 'lucide-react';
import { ASK_SECTION_HEADING } from '@/components/ai/ask/needs-you';
import { labelName } from '@/components/ai/connect/connect-shared';
import { useAIConnectionStore, type JustConnected } from '@/lib/ai-connection-store';
import { FLOW_COPY, flowSaved } from '@/lib/connect-flow';
import { modelName } from '@/lib/ai-model-names';
import { buildChatOpeners, buildOpenerPreviews, type ChatOpener, type OpenerContext } from '@/lib/ai-openers';
import { AI_SETTINGS_PATH, type ModelConnectionView } from '@/lib/ai-types';
import { cn } from '@/lib/utils';

/** How many openers the card offers: the setup column's three previews, now live. */
export const IT_WORKS_OPENERS = 3;

/**
 * Each opener's glyph, as the setup column's previews wear it
 * (components/ai/rail/ask-setup.tsx), so the row it offered becomes this one;
 * a later opener falls back to a speech bubble.
 */
export const OPENER_ICONS: Readonly<Record<string, LucideIcon>> = Object.freeze({
  plan: CalendarDays,
  triage: ListChecks,
  'plan-tomorrow': CalendarDays,
  'let-go': Hourglass,
  review: History,
  reflect: CalendarRange,
});

/** The card is about the connection on screen: the one just made, and still the live model. */
export function itWorksFor(said: JustConnected | null, model: ModelConnectionView | null): boolean {
  return said !== null && model !== null && said.provider === model.provider && said.model === model.model;
}

/** Whether Ask home shows "It works." now (its foot hides the chips meanwhile). */
export function useItWorksShown(): boolean {
  return useAIConnectionStore((s) => itWorksFor(s.justConnected, s.model));
}

/**
 * The words above the openers: who answered, and which model Ask will use.
 * "Google Gemini answered a test question. Ask will use **Gemini Flash**,
 * Google’s quick everyday model." OpenRouter's free plan is said only when its
 * connect answer said so (`freeTier`); no other provider gives a plan signal,
 * so none is claimed.
 */
function useItWorksLine(): { label: string; name: string; tail: string } | null {
  const said = useAIConnectionStore((s) => s.justConnected);
  const model = useAIConnectionStore((s) => s.model);
  if (!itWorksFor(said, model) || !said || !model?.model) return null;
  const { name, about } = modelName(model.provider, model.model, model.modelLabel);
  const free = said.freeTier && model.provider === 'openrouter';
  return {
    label: labelName(model.provider, model.baseUrl),
    name,
    tail: `${about ? `, ${about}` : ''}${free ? ', on OpenRouter’s free plan' : ''}.`,
  };
}

/**
 * In "It works."'s place when an OpenRouter sign-in came back home and saved a
 * connection whose test question went unanswered (`flowResult` saved,
 * no_credit or daily_limit, lib/connect-return.ts): the connection is there,
 * so this is a quiet word on why the check said nothing, not an alarm. Any
 * other result is the setup column's to say, never Ask's. Spent where the card
 * is (lib/rail-store.ts spendJustConnected). An `ok` return never leaves a
 * result and a new connection clears both, so the two are never up together;
 * should they be, the card speaks.
 */
export function AskFlowNote() {
  const flow = useAIConnectionStore((s) => s.flowResult);
  const itWorks = useItWorksShown();
  if (!flow || !flowSaved(flow) || itWorks) return null;
  return (
    <div
      role="status"
      data-testid="ask-flow-note"
      data-flow={flow}
      className="flex gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5"
    >
      <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <p className="text-sm leading-snug text-foreground">{FLOW_COPY[flow]}</p>
    </div>
  );
}

/** An opener with the line the setup column showed under it. */
type OpenerRow = ChatOpener & { description: string };

/**
 * Ask home's first words after a connection lands in this tab: a key in the
 * setup column, or an OpenRouter sign-in that came back home
 * (lib/connect-return.ts). The store's `justConnected` says so, in memory
 * only, and it shows only while the live model is still the one it names.
 *
 * From the top: ✓ It works., who answered and the model Ask will use (by its
 * name, lib/ai-model-names.ts, never its id), that the connection is the
 * account's, where to change it, then "Start with one of these": three of
 * today's openers as live rows (the setup column's previews, now one click
 * each; the same action as Ask home's chips, which hide meanwhile).
 *
 * Said once. The first send, New chat, a conversation opened and Ask closing
 * spend it (lib/rail-store.ts, lib/open-chat.ts, lib/conversations-store.ts); a model change, a
 * disconnect and a sign-out clear it in the store itself.
 */
export function ItWorksCard({
  ctx,
  minutesNow,
  onPick,
}: {
  ctx: OpenerContext | null;
  minutesNow: number | null;
  onPick: (opener: ChatOpener) => void;
}) {
  const line = useItWorksLine();
  const headingId = useId();
  const startId = useId();

  const openers = useMemo<OpenerRow[]>(() => {
    if (!ctx || minutesNow === null) return [];
    const o = { max: IT_WORKS_OPENERS, minutesNow };
    const lines = new Map(buildOpenerPreviews(ctx, o).map((p) => [p.id, p.description]));
    return buildChatOpeners(ctx, o).map((x) => ({ ...x, description: lines.get(x.id) ?? '' }));
  }, [ctx, minutesNow]);

  if (!line) return null;

  return (
    <section aria-labelledby={headingId} data-testid="it-works" className="flex flex-col gap-5">
      <div role="status" className="flex flex-col gap-3 rounded-xl border border-border bg-surface-2 p-4">
        <h3 id={headingId} className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CheckCircle2 aria-hidden className="size-4 shrink-0 text-success" />
          It works.
        </h3>
        <p data-testid="it-works-line" className="text-sm leading-snug text-foreground">
          {line.label} answered a test question. Ask will use <strong className="font-semibold">{line.name}</strong>
          {line.tail}
        </p>
        <p className="rounded-lg bg-secondary px-3 py-2 text-sm leading-snug text-muted-foreground">
          Connected to your account, so dsul on the web and in the desktop app both use it.
        </p>
        <p className="text-xs text-muted-foreground">
          Change the model or disconnect in{' '}
          <Link
            href={AI_SETTINGS_PATH}
            className="text-foreground underline underline-offset-2 hover:no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Settings → AI
          </Link>
          .
        </p>
      </div>
      {openers.length > 0 && (
        <section aria-labelledby={startId} data-testid="it-works-openers" className="-mx-2 flex flex-col gap-1">
          <h3 id={startId} className={cn(ASK_SECTION_HEADING, 'px-2')}>
            Start with one of these
          </h3>
          <ul className="flex flex-col">
            {openers.map((opener) => {
              const Icon = OPENER_ICONS[opener.id] ?? MessageCircle;
              return (
                <li key={opener.id}>
                  <button
                    type="button"
                    data-opener={opener.id}
                    onClick={() => onPick(opener)}
                    className="flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-ai" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm font-medium text-foreground">{opener.label}</span>
                      {opener.description && (
                        <span className="text-sm leading-snug text-muted-foreground">{opener.description}</span>
                      )}
                    </span>
                    <ArrowRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="px-2 text-xs text-muted-foreground">Pick one to start, or ask anything below.</p>
        </section>
      )}
    </section>
  );
}
