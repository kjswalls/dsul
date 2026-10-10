'use client';

import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { CalendarCheck, ChevronRight, ListTree, Power } from 'lucide-react';

import { AskMark, AskMarkUnlitIcon } from '@/components/ai/ask-mark';
import {
  ANCHOR_CLASS,
  DANGER_TEXT_ACTION,
  labelName,
  settingAnchor,
} from '@/components/ai/connect/connect-shared';
import { KeyCap } from '@/components/planner/organize/primitives';
import { Button, buttonVariants } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useAIConnectionStore, useAICapabilities } from '@/lib/ai-connection-store';
import {
  aiPaneLayout,
  openClawStatus,
  USE_AI_COPY,
  type AIPaneLayout,
  type AliasId,
  type PillTone,
} from '@/lib/ai-pane-state';
import { useAISettingsStore } from '@/lib/ai-settings-store';
import { chordLabel, isApplePlatform } from '@/lib/commands/keys';
import { useShortcutKeys } from '@/lib/keyboard-shortcuts-store';
import { chatOffered } from '@/lib/mobile-nav-store';
import { setUseAI } from '@/lib/no-ai';
import { settingById, type SettingCtx, type SettingRecord } from '@/lib/settings/manifest';
import { highlightRuns, type MatchRange } from '@/lib/settings/search';
import { cn } from '@/lib/utils';
import { useDisconnect, useUnpair } from './disconnect';
import { ModelConnectionPanel } from './model-connection-panel';
import { ScopeChip } from './scope-chip';
import { PendingControl } from './setting-row';
import { StatusPill } from './status-pill';

/**
 * Settings → AI (pane id 'beacon', at /settings/ai): the pane body the frames
 * F18 to F22 draw, top to bottom.
 *
 *   What AI does      three tiles while nothing is connected, one sentence once
 *                     something is, nothing while the answer is unknown or AI is off
 *   Use AI in dsul    the account's "No AI, thanks" (UseAIRow), on every state
 *   AI is off         the card that says so, and what is still connected or paired
 *   Connection        ModelConnectionPanel, which draws nothing while AI is off
 *   OpenClaw          paired or not, with the gateway rows in its own fold
 *   On this device    who answers in chat and custom instructions (SettingRows)
 *
 * Which of them show, and which form each takes, is decided in one place
 * (lib/ai-pane-state.ts, `aiPaneLayout`), so a state is a row in a table test.
 * Nothing here gets an opacity and nothing dims: AI off hides sections, it
 * never fades them, so the lime that remains is never seen through a parent.
 *
 * Two structural rules keep the Connection section from ever remounting (it
 * holds one-shot state: the `?connect=` notice read once, the `?start=`
 * unfold, the just-connected line). The sections are fixed child slots
 * (`cond && <X/>`, never a filtered array), so one appearing above another
 * never shifts it. And the anchors that stand in for hidden rows around it
 * are four fixed nested divs (AliasSlots) whose attributes change and whose
 * depth never does.
 *
 * Every record the pane draws has exactly one anchor in every state, a row or
 * an alias (the table in lib/ai-pane-state.ts), so `?focus=` always lands.
 */

/* ── The live mark ──────────────────────────────────────────────────────── */

/** The pane's mark in the rail and the eyebrow: lit only while something answers chat here. */
export function AIPaneMark({ className }: { className?: string }) {
  const { canChat } = useAICapabilities();
  return <AskMark lit={canChat} className={className} />;
}

/* ── Layout ─────────────────────────────────────────────────────────────── */

/** The store reads + aiPaneLayout, shared by AIPane and UseAIRow. keepDevice is AIPane's latch (false elsewhere). */
export function useAIPaneLayout(keepDevice = false): AIPaneLayout {
  const phase = useAIConnectionStore((s) => s.phase);
  const available = useAIConnectionStore((s) => s.available);
  const model = useAIConnectionStore((s) => s.model);
  const openclaw = useAIConnectionStore((s) => s.openclaw);
  const aiHidden = useAIConnectionStore((s) => s.aiHidden);
  const choice = useAISettingsStore((s) => s.chatTarget);
  return useMemo(
    () => aiPaneLayout({ phase, available, model, openclaw, aiHidden, choice, keepDevice }),
    [phase, available, model, openclaw, aiHidden, choice, keepDevice]
  );
}

/** The four ids the Connection section stands in for while their own homes are hidden, in nesting order. */
const CONNECTION_SLOT_IDS: readonly AliasId[] = [
  'beacon.provider',
  'beacon.instructions',
  'beacon.gatewayUrl',
  'beacon.gatewayToken',
];

/** Every id but beacon.useAi, which the AI-off card stands in for while AI is off. */
const OFF_CARD_IDS: readonly AliasId[] = [
  'beacon.apiKey',
  'beacon.model',
  'beacon.provider',
  'beacon.instructions',
  'beacon.gatewayUrl',
  'beacon.gatewayToken',
];

/**
 * One div per id, nested in order, ALWAYS: the depth never changes, so what
 * sits inside never remounts. A div wears its id's alias (and the deep-link
 * ring) only while `active` lists it; otherwise it is a bare div. Attributes
 * change, the tree does not.
 */
function AliasSlots({
  ids,
  active,
  highlightId,
  children,
}: {
  ids: readonly AliasId[];
  active: readonly AliasId[];
  highlightId: string | null;
  children: ReactNode;
}) {
  return ids.reduceRight<ReactNode>(
    (inner, id) =>
      active.includes(id) ? (
        <div {...settingAnchor(id, highlightId)} className={ANCHOR_CLASS}>
          {inner}
        </div>
      ) : (
        <div>{inner}</div>
      ),
    children
  );
}

/* ── The pane ───────────────────────────────────────────────────────────── */

export function AIPane({
  isMobile,
  highlightId,
  rowFor,
  gatewayOpen,
  onToggleGateway,
}: {
  ctx: SettingCtx;
  isMobile: boolean;
  highlightId: string | null;
  rowFor: (record: SettingRecord) => ReactNode;
  gatewayOpen: boolean;
  onToggleGateway: () => void;
}) {
  // On this device, once shown, stays for the visit: choosing a chat target
  // while nothing is connected (the one reason it shows then) must not take
  // away the select you just changed. Set during render, React's derived-state
  // pattern, so the latch and the section land in the same commit.
  const [keepDevice, setKeepDevice] = useState(false);
  const layout = useAIPaneLayout(keepDevice);
  if (layout.showDevice && !keepDevice) setKeepDevice(true);

  return (
    <div data-testid="ai-pane" className="mt-2 flex flex-col gap-7">
      {layout.explainer !== 'none' && <Explainer form={layout.explainer} />}

      <div className="border-border border-y">
        <UseAIRow highlightId={highlightId} />
      </div>

      {layout.aiOff && <AIOffCard active={layout.offCardAliases} highlightId={highlightId} />}

      {/* Always mounted, and always at this depth: the panel renders nothing
          while AI is off, and its state outlives the trip. */}
      <div data-ai-section={layout.aiOff ? undefined : 'connection'} className={cn(layout.aiOff && 'hidden')}>
        <AliasSlots ids={CONNECTION_SLOT_IDS} active={layout.connectionAliases} highlightId={highlightId}>
          <ModelConnectionPanel isMobile={isMobile} highlightId={highlightId} />
        </AliasSlots>
      </div>

      {layout.showOpenClaw && (
        <OpenClawSection rowFor={rowFor} gatewayOpen={gatewayOpen} onToggleGateway={onToggleGateway} />
      )}

      {layout.showDevice && <DeviceSection rowFor={rowFor} />}
    </div>
  );
}

/* ── What AI does ───────────────────────────────────────────────────────── */

const INK = 'text-foreground font-medium';

/**
 * Ask's chord, as the user has it bound (chordLabel: "Ctrl+J", or the Mac's
 * own), and only where it does something: while the gate offers chat at all
 * (`chatOffered`). Pull-only, chat Off here, or no model on this server, and
 * the chord is consumed and inert, so it is not shown. Below `md` it is
 * hidden in CSS, since the chord does nothing on a phone.
 */
function useAskChord(): string | null {
  const caps = useAICapabilities();
  const keys = useShortcutKeys('toggle_right_sidebar');
  return chatOffered(caps) ? chordLabel(keys, isApplePlatform()) : null;
}

function Explainer({ form }: { form: 'tiles' | 'sentence' }) {
  const chord = useAskChord();

  if (form === 'sentence') {
    return (
      <p
        data-ai-section="explainer"
        data-testid="ai-explainer"
        data-form="sentence"
        className="text-muted-foreground text-xs"
      >
        {'AI in dsul is '}
        <strong className={INK}>Ask</strong>
        {chord !== null && (
          <span data-testid="ai-explainer-chord" className="hidden md:inline">
            {` (${chord})`}
          </span>
        )}
        {', '}
        <strong className={INK}>plan suggestions</strong>
        {' and '}
        <strong className={INK}>Break it down</strong>
        {'. Nothing in your planner changes unless you say yes.'}
      </p>
    );
  }

  return (
    <section
      data-ai-section="explainer"
      data-testid="ai-explainer"
      data-form="tiles"
      aria-labelledby="ai-explainer-title"
      className="flex flex-col gap-3"
    >
      <h3 id="ai-explainer-title" className="text-foreground text-sm font-medium">
        What AI does in dsul
      </h3>
      <ul className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Tile
          tile="ask"
          icon={<AskMarkUnlitIcon className="size-4" />}
          title="Ask"
          body={
            <>
              Talk through your day, or ask what to do next.
              {chord !== null && (
                <span data-testid="ai-explainer-chord" className="hidden md:inline">
                  {' Open it with'}
                  <KeyCap>
                    <span className="text-foreground">{chord}</span>
                  </KeyCap>
                  .
                </span>
              )}
            </>
          }
        />
        <Tile
          tile="plan"
          icon={<CalendarCheck className="text-muted-foreground size-4" aria-hidden />}
          title="Plan suggestions"
          body="Drafts today or tomorrow from your list. You keep, move or drop each line."
        />
        <Tile
          tile="breakdown"
          icon={<ListTree className="text-muted-foreground size-4" aria-hidden />}
          title="Break it down"
          body="Turns a big task into small steps you can start."
        />
      </ul>
      <p data-testid="ai-explainer-caption" className="text-muted-foreground text-xs">
        Nothing in your planner changes unless you say yes.
      </p>
    </section>
  );
}

function Tile({ tile, icon, title, body }: { tile: string; icon: ReactNode; title: string; body: ReactNode }) {
  return (
    <li data-testid="ai-tile" data-tile={tile} className="border-border flex flex-col gap-1.5 rounded-[8px] border p-3">
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-foreground text-sm font-medium">{title}</p>
      </div>
      <p className="text-muted-foreground text-xs">{body}</p>
    </li>
  );
}

/* ── Use AI in dsul ─────────────────────────────────────────────────────── */

const USE_AI_LABEL = 'Use AI in dsul';
const USE_AI_CONTROL = '[data-testid="ai-use-switch"], [data-testid="ai-no-ai-thanks"]';

/**
 * "Use AI in dsul" (`beacon.useAi`), drawn by this one component in the pane
 * and in search, so the two always show the same form: "No AI, thanks" while
 * nothing is connected (never a lit switch), the switch once something is or
 * AI is off, and only a status line while the account's answer is unknown or
 * cannot be kept. It never draws a modified bar or a reset: off is a choice,
 * not a drift from a default, and the switch is its own way back.
 *
 * Every write is `setUseAI` (lib/no-ai.ts): the account's answer and nothing
 * else. Neither control ever takes `disabled`, since the Switch fades itself
 * through `disabled:opacity-50` over a lime track; the store serializes
 * presses instead.
 *
 * Focus follows a press on THIS row only. The button and the switch swap
 * places on the tap (and back on a refused write), so the one pressed is
 * gone; focus moves to the one that took its place. A swap nobody made here
 * (a connect, a Disconnect, a refresh) never pulls focus or scroll to this
 * row, where the next Space would hide AI on every device.
 */
export function UseAIRow({
  highlightId,
  search,
}: {
  highlightId: string | null;
  search?: { paneName: string; ranges: MatchRange[]; matchedValue?: string };
}) {
  const layout = useAIPaneLayout();
  const form = layout.useAi;
  const uid = useId();
  const controlId = `ai-use-${uid}`;
  const descId = `${controlId}-desc`;
  const rowRef = useRef<HTMLDivElement>(null);
  const handOff = useRef(0);
  const highlighted = highlightId === 'beacon.useAi';

  const press = (on: boolean) => {
    handOff.current += 1;
    void setUseAI(on).finally(() => {
      handOff.current -= 1;
    });
  };

  // Keyed on the form: the optimistic swap and a rollback each change it.
  useLayoutEffect(() => {
    if (handOff.current <= 0) return;
    rowRef.current?.querySelector<HTMLElement>(USE_AI_CONTROL)?.focus({ preventScroll: true });
  }, [form]);

  const description =
    form === 'button' ? USE_AI_COPY.button : form === 'on' ? USE_AI_COPY.on : form === 'off' ? USE_AI_COPY.off : null;
  // The pane's line points at the card below it; a search hit has no card
  // below, so it says the record's own reason.
  const statusLine = search && form === 'unavailable' ? `Unavailable: ${layout.useAiReason}` : layout.useAiLine;
  const quiet = form === 'pending' || form === 'unavailable';
  const isSwitch = form === 'on' || form === 'off';
  const runs = highlightRuns(USE_AI_LABEL, search?.ranges ?? []);
  const labelText = runs.map((run, i) =>
    run.hit ? (
      <mark key={i} className="bg-primary/30 rounded-[2px] px-0.5 text-inherit">
        {run.text}
      </mark>
    ) : (
      <span key={i}>{run.text}</span>
    )
  );
  const labelClass = cn('text-sm font-medium', quiet ? 'text-muted-foreground' : 'text-foreground');

  return (
    <div
      ref={rowRef}
      data-ai-section={search ? undefined : 'use'}
      data-testid="ai-use-row"
      data-form={form}
      data-setting-row="beacon.useAi"
      data-highlight={highlighted || undefined}
      tabIndex={-1}
      className={cn(
        'relative -mx-3 grid grid-cols-[minmax(0,1fr)_162px] items-center gap-6 rounded-[5px] px-3 py-2.5 transition-colors',
        'hover:bg-accent',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
        highlighted &&
          'after:ring-ring after:pointer-events-none after:absolute after:inset-0 after:rounded-[5px] after:ring-2 after:content-[""]'
      )}
    >
      <div className="min-w-0">
        {/* Wraps on a phone, where the left track is about 157px: the chip
            drops under the label whole rather than breaking inside its outline. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {isSwitch ? (
            <label htmlFor={controlId} className={labelClass}>
              {labelText}
            </label>
          ) : (
            <p className={labelClass}>{labelText}</p>
          )}
          <ScopeChip scope="account" />
        </div>

        {description && (
          <p id={descId} data-testid="ai-use-desc" className="text-muted-foreground mt-[3px] max-w-[46ch] text-xs">
            {description}
          </p>
        )}

        {search && (
          <p className="text-muted-foreground mt-[3px] text-[10px] font-medium tracking-wider uppercase">
            {search.paneName}
          </p>
        )}

        {search?.matchedValue && (
          <p className="text-muted-foreground font-num mt-[3px] text-[10px]">matches: {search.matchedValue}</p>
        )}

        {statusLine && <p className="text-muted-foreground mt-[3px] text-[10px]">{statusLine}</p>}
      </div>

      <div className="flex min-h-7 items-center justify-end gap-1.5">
        {form === 'button' && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="ai-no-ai-thanks"
            aria-describedby={descId}
            onClick={() => press(false)}
          >
            No AI, thanks
          </Button>
        )}
        {isSwitch && (
          <Switch
            id={controlId}
            data-testid="ai-use-switch"
            data-setting="beacon.useAi"
            aria-describedby={descId}
            checked={form === 'on'}
            onCheckedChange={(checked) => press(checked)}
          />
        )}
        {form === 'pending' && <PendingControl label={USE_AI_LABEL} />}
      </div>
    </div>
  );
}

/* ── AI is off ──────────────────────────────────────────────────────────── */

/**
 * Directly under the switch while the account has AI off, with everything
 * else below it hidden: what is still connected (Disconnect deletes it) and
 * what is still paired (this switch leaves a pairing alone; Unpair ends it). It stands in for
 * every hidden record's anchor, so a deep link lands here.
 */
function AIOffCard({ active, highlightId }: { active: readonly AliasId[]; highlightId: string | null }) {
  const model = useAIConnectionStore((s) => s.model);
  const openclaw = useAIConnectionStore((s) => s.openclaw);
  const cardRef = useRef<HTMLElement>(null);
  // The row and its Disconnect go once the key is deleted; focus goes to the
  // card rather than to <body>. ConfirmDialog runs fallbackFocus when the
  // DELETE lands before the confirm has finished closing (its opener gone).
  const focusCard = useCallback(() => cardRef.current?.focus({ preventScroll: true }), []);
  const disconnect = useDisconnect(model, {
    onDone: (ok) => {
      if (ok) focusCard();
    },
    fallbackFocus: focusCard,
  });
  // Once unpaired the row goes too, with the same hand-off.
  const unpair = useUnpair({
    onDone: (ok) => {
      if (ok) focusCard();
    },
    fallbackFocus: focusCard,
  });
  const paired = openClawStatus(openclaw);

  return (
    <AliasSlots ids={OFF_CARD_IDS} active={active} highlightId={highlightId}>
      <section
        ref={cardRef}
        tabIndex={-1}
        data-ai-section="ai-off"
        data-testid="mcp-ai-off"
        aria-labelledby="ai-off-title"
        className="border-border flex flex-col gap-4 rounded-[8px] border p-4 outline-none"
      >
        <div className="flex items-start gap-2.5">
          <Power className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="flex min-w-0 flex-col gap-1">
            <h3 id="ai-off-title" className="text-foreground text-sm font-medium">
              AI is off
            </h3>
            <p className="text-muted-foreground text-xs">
              dsul won’t show AI or bring it up again until you turn it back on above. Your planner works exactly the
              same.
            </p>
          </div>
        </div>

        {model !== null && (
          <div data-testid="ai-off-connected" className="border-border flex flex-col gap-2 border-t pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-foreground text-sm font-medium">
                  {labelName(model.provider, model.baseUrl)} is still connected
                </p>
                <p className="text-muted-foreground text-xs">
                  {model.authMethod === 'oauth'
                    ? 'Your sign-in stays saved, so turning AI back on picks up where you left off. Disconnect to delete it.'
                    : 'Your key stays saved, so turning AI back on picks up where you left off. Disconnect to delete it.'}
                </p>
              </div>
              <button
                type="button"
                className={cn(DANGER_TEXT_ACTION, 'shrink-0')}
                data-testid="ai-off-disconnect"
                disabled={disconnect.pending}
                onClick={() => disconnect.ask()}
              >
                {disconnect.pending ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
            {disconnect.error && (
              <p role="alert" data-testid="ai-off-error" className="text-destructive text-xs">
                {disconnect.error}
              </p>
            )}
          </div>
        )}

        {openclaw.agent && (
          <div data-testid="ai-off-paired" className="border-border flex flex-col gap-2 border-t pt-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-foreground text-sm font-medium">{paired.name} is still paired</p>
                <p className="text-muted-foreground text-xs">
                  OpenClaw reads your planner through its own pairing, which this switch doesn’t touch. Unpair it to
                  stop that.
                </p>
              </div>
              <button
                type="button"
                className={cn(DANGER_TEXT_ACTION, 'shrink-0')}
                data-testid="ai-off-unpair"
                disabled={unpair.pending}
                onClick={() => unpair.ask()}
              >
                {unpair.pending ? 'Unpairing…' : 'Unpair'}
              </button>
            </div>
            {unpair.error && (
              <p role="alert" data-testid="ai-off-unpair-error" className="text-destructive text-xs">
                {unpair.error}
              </p>
            )}
          </div>
        )}
      </section>
    </AliasSlots>
  );
}

/* ── OpenClaw ───────────────────────────────────────────────────────────── */

function recordFor(id: string): SettingRecord {
  const record = settingById(id);
  if (!record) throw new Error(`No setting record ${id}`);
  return record;
}

/**
 * The person's own agent. Pairing is a device-code flow run from OpenClaw's
 * side, so the pane links to the docs rather than starting it; Unpair ends
 * it from here (the gateway rows are their own connection, and stay). The pill is
 * lime by the Working dot's rule: paired, something answers through it, and
 * chat answers on this device. The gateway rows live in a quiet fold here,
 * driven by the shell's own Advanced state, so `?focus=` opens it.
 */
function OpenClawSection({
  rowFor,
  gatewayOpen,
  onToggleGateway,
}: {
  rowFor: (record: SettingRecord) => ReactNode;
  gatewayOpen: boolean;
  onToggleGateway: () => void;
}) {
  const openclaw = useAIConnectionStore((s) => s.openclaw);
  const { canChat } = useAICapabilities();
  const status = openClawStatus(openclaw);
  const sectionRef = useRef<HTMLElement>(null);
  // Unpaired, the card and its button go (or keep only the gateway's line):
  // focus lands on the section rather than on <body>.
  const focusSection = useCallback(() => sectionRef.current?.focus({ preventScroll: true }), []);
  const unpair = useUnpair({
    onDone: (ok) => {
      if (ok) focusSection();
    },
    fallbackFocus: focusSection,
  });
  const tone: PillTone = status.paired && canChat && status.answers ? 'lime' : 'grey';

  // "Can answer": this device's Who answers in chat may pick the model, or Off.
  // A pull-only agent is OpenClaw by name (openClawStatus), never a stale id.
  const copy = status.agent
    ? status.answers
      ? `${status.name} can answer in Ask and take on tasks you hand it.`
      : `${status.name} takes on tasks you hand it.`
    : 'OpenClaw can answer in Ask through your gateway.';

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      data-ai-section="openclaw"
      data-testid="ai-openclaw"
      aria-labelledby="ai-openclaw-title"
      className="flex flex-col gap-3 outline-none"
    >
      <div className="flex items-center justify-between gap-4">
        <h3 id="ai-openclaw-title" className="text-foreground text-sm font-medium">
          OpenClaw
        </h3>
        <StatusPill testId="openclaw-status" tone={tone}>
          {status.paired ? 'Paired' : 'Not paired'}
        </StatusPill>
      </div>

      {status.paired ? (
        <div className="border-border flex flex-col gap-3 rounded-[8px] border p-4">
          <p data-testid="openclaw-copy" className="text-muted-foreground text-xs">
            {copy}
          </p>
          {status.agent && (
            <div>
              <button
                type="button"
                className={DANGER_TEXT_ACTION}
                data-testid="openclaw-unpair"
                disabled={unpair.pending}
                onClick={() => unpair.ask()}
              >
                {unpair.pending ? 'Unpairing…' : 'Unpair'}
              </button>
            </div>
          )}
          {unpair.error && (
            <p role="alert" data-testid="openclaw-unpair-error" className="text-destructive text-xs">
              {unpair.error}
            </p>
          )}
        </div>
      ) : (
        <div className="border-border flex flex-wrap items-center justify-between gap-3 rounded-[8px] border p-4">
          <p className="text-muted-foreground min-w-0 flex-1 basis-60 text-xs">
            Run your own OpenClaw agent? Pair it, and it can answer in Ask and take on tasks you hand it.
          </p>
          <Link
            href="/docs/openclaw"
            data-testid="openclaw-pair"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            Pair OpenClaw
          </Link>
        </div>
      )}

      <div>
        <button
          type="button"
          data-testid="openclaw-gateway-toggle"
          aria-expanded={gatewayOpen}
          onClick={onToggleGateway}
          className={cn(
            'text-muted-foreground hover:bg-accent -mx-3 flex h-8 w-[calc(100%+1.5rem)]',
            'items-center gap-2 rounded-[5px] px-3 text-xs font-medium transition-colors',
            'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
          )}
        >
          <ChevronRight className={cn('size-3 transition-transform', gatewayOpen && 'rotate-90')} aria-hidden />
          Advanced
        </button>
        {gatewayOpen && (
          <div className="divide-border divide-y">
            {rowFor(recordFor('beacon.gatewayUrl'))}
            {rowFor(recordFor('beacon.gatewayToken'))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ── On this device ─────────────────────────────────────────────────────── */

/** Who answers in chat and custom instructions: device-local, so a phone and the desktop app can differ. */
function DeviceSection({ rowFor }: { rowFor: (record: SettingRecord) => ReactNode }) {
  return (
    <section
      data-ai-section="device"
      data-testid="ai-device"
      aria-labelledby="ai-device-title"
      className="flex flex-col gap-1"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id="ai-device-title" className="text-foreground text-sm font-medium">
          On this device
        </h3>
        <ScopeChip scope="device" />
      </div>
      <p className="text-muted-foreground text-xs">
        These two stay on this device, so your phone and the desktop app can each have their own.
      </p>
      <div className="border-border divide-border mt-2 divide-y border-t">
        {rowFor(recordFor('beacon.provider'))}
        {rowFor(recordFor('beacon.instructions'))}
      </div>
    </section>
  );
}
