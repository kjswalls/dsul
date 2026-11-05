'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { ANCHOR_CLASS, DANGER_TEXT_ACTION, settingAnchor } from '@/components/ai/connect/connect-shared';
import { useAIConnectionStore, useAICapabilities } from '@/lib/ai-connection-store';
import { openClawStatus, type AliasId, type PillTone } from '@/lib/ai-pane-state';
import { useOpenClawBrowserStore } from '@/lib/openclaw-browser-store';
import { paneHref, settingById, type SettingRecord } from '@/lib/settings/manifest';
import { cn } from '@/lib/utils';
import { AgentFinishSection } from './agent-finish';
import { AgentKeysSection } from './agent-keys';
import { useAIPaneLayout } from './ai-pane';
import { ConnectedAppsSection } from './connected-apps';
import { useUnpair } from './disconnect';
import { OpenClawBrowserChat } from './openclaw-browser-chat';
import { OpenClawConnect } from './openclaw-connect';
import { SettingsCard, SettingsSectionLabel } from './settings-card';
import { StatusPill } from './status-pill';

/**
 * Settings → Connections: agents and apps that reach the planner from outside
 * it. OpenClaw (with the two gateway rows), apps signed in over MCP, agent
 * keys, and whether an agent may tick off what it was handed. They used to sit
 * at the bottom of the AI pane; Kirby moved them out on 2026-11-05, since an
 * MCP app or an agent key is not dsul's own AI.
 *
 * OpenClaw follows the AI pane's rule (lib/ai-pane-state.ts `showOpenClaw`):
 * hidden while the connection check is out and while the account has AI off,
 * because "No AI, thanks" hides OpenClaw chat too. While it is hidden, a small
 * card stands in and wears the gateway rows' anchors, so `?focus=` still lands.
 * Connected apps, agent keys and handed-off work show either way: Disconnect
 * and Revoke have to be reachable with AI off.
 */
export function ConnectionsPane({
  highlightId,
  rowFor,
  gatewayOpen,
  onToggleGateway,
}: {
  highlightId: string | null;
  rowFor: (record: SettingRecord) => ReactNode;
  gatewayOpen: boolean;
  onToggleGateway: () => void;
}) {
  const layout = useAIPaneLayout();
  return (
    <div data-testid="connections-pane" className="flex flex-col gap-8">
      {layout.showOpenClaw ? (
        <OpenClawSection rowFor={rowFor} gatewayOpen={gatewayOpen} onToggleGateway={onToggleGateway} />
      ) : (
        <OpenClawStandIn aiOff={layout.aiOff} active={layout.gatewayAliases} highlightId={highlightId} />
      )}
      <ConnectedAppsSection />
      <AgentKeysSection />
      <AgentFinishSection />
    </div>
  );
}

/** "3 minutes ago", for the Connect key's last use (written at most every ten minutes). */
function heardAgo(iso: string, now = Date.now()): string {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (mins < 15) return 'it in the last few minutes';
  if (mins < 60) return `it ${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `it ${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `it on ${new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function recordFor(id: string): SettingRecord {
  const record = settingById(id);
  if (!record) throw new Error(`No setting record ${id}`);
  return record;
}

/**
 * While OpenClaw is hidden: one quiet card under its label, wearing the
 * gateway rows' anchors (nested, fixed depth, like the AI pane's AliasSlots).
 */
function OpenClawStandIn({
  aiOff,
  active,
  highlightId,
}: {
  aiOff: boolean;
  active: readonly AliasId[];
  highlightId: string | null;
}) {
  const failed = useAIConnectionStore((s) => s.phase === 'error');
  const body = (
    <p data-testid="openclaw-hidden-copy" className="text-muted-foreground px-4 py-3 text-xs">
      {aiOff ? (
        <>
          OpenClaw is hidden while AI is off. Turn it back on in{' '}
          <Link href={paneHref('beacon')} className="underline underline-offset-2">
            AI
          </Link>
          .
        </>
      ) : failed ? (
        'Shows once dsul can check your AI connection.'
      ) : (
        'Checking…'
      )}
    </p>
  );
  const anchored = active.reduceRight<ReactNode>(
    (inner, id) => (
      <div {...settingAnchor(id, highlightId)} className={ANCHOR_CLASS}>
        {inner}
      </div>
    ),
    body
  );
  return (
    <section data-ai-section="openclaw-hidden" data-testid="openclaw-hidden" aria-labelledby="openclaw-hidden-title">
      <SettingsSectionLabel id="openclaw-hidden-title" as="h2">
        OpenClaw
      </SettingsSectionLabel>
      <SettingsCard>{anchored}</SettingsCard>
    </section>
  );
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
  const browserChat = useOpenClawBrowserStore((s) => s.paired !== null);
  const { canChat } = useAICapabilities();
  const status = openClawStatus(openclaw, browserChat);
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
    : browserChat
      ? 'OpenClaw answers in Ask on this browser.'
      : 'OpenClaw can answer in Ask through your gateway.';
  const connect = openclaw.connect;
  // Held here: Connect flips the card from not paired to paired, and the
  // commands must survive that (components/settings/openclaw-connect.tsx).
  const [connectScript, setConnectScript] = useState<string | null>(null);
  const refreshConnection = useCallback(() => void useAIConnectionStore.getState().refresh(), []);

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      data-ai-section="openclaw"
      data-testid="ai-openclaw"
      aria-labelledby="ai-openclaw-title"
      className="flex flex-col outline-none"
    >
      <SettingsSectionLabel
        id="ai-openclaw-title"
        trailing={
          <StatusPill testId="openclaw-status" tone={tone}>
            {status.paired ? 'Paired' : 'Not paired'}
          </StatusPill>
        }
      >
        OpenClaw
      </SettingsSectionLabel>

      <SettingsCard>
        {status.paired ? (
          <div className="flex flex-col gap-3 px-4 py-3">
            <p data-testid="openclaw-copy" className="text-muted-foreground text-xs">
              {copy}
            </p>
            {connect?.connected && (
              <p data-testid="openclaw-last-seen" className="text-muted-foreground text-xs">
                {connect.lastSeenAt
                  ? `Last heard from ${heardAgo(connect.lastSeenAt)}.`
                  : 'Waiting to hear from it. Run the commands from Connect on the machine OpenClaw runs on.'}
              </p>
            )}
            <OpenClawConnect
              label={connect?.connected ? 'Connect again' : 'Connect'}
              script={connectScript}
              onScript={setConnectScript}
              onConnected={refreshConnection}
            />
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
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p className="text-muted-foreground min-w-0 flex-1 basis-60 text-xs">
              Run your own OpenClaw agent? Connect it, and it can take on tasks you hand it. Nothing to install, and
              your gateway stays private.{' '}
              <Link href="/docs/openclaw" data-testid="openclaw-pair" className="underline underline-offset-2">
                How it works
              </Link>
            </p>
            <OpenClawConnect
              label="Connect"
              script={connectScript}
              onScript={setConnectScript}
              onConnected={refreshConnection}
            />
          </div>
        )}

        <div className="px-4 py-3">
          <OpenClawBrowserChat />
        </div>

        <div>
          <button
            type="button"
            data-testid="openclaw-gateway-toggle"
            aria-expanded={gatewayOpen}
            onClick={onToggleGateway}
            className={cn(
              'text-muted-foreground hover:bg-accent flex h-10 w-full items-center gap-2 px-4 text-xs font-medium',
              'transition-colors focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
              'focus-visible:ring-inset'
            )}
          >
            <ChevronRight className={cn('size-3 transition-transform', gatewayOpen && 'rotate-90')} aria-hidden />
            Gateway
          </button>
          {gatewayOpen && (
            <div className="border-border divide-border divide-y border-t">
              {rowFor(recordFor('beacon.gatewayUrl'))}
              {rowFor(recordFor('beacon.gatewayToken'))}
            </div>
          )}
        </div>
      </SettingsCard>
    </section>
  );
}
