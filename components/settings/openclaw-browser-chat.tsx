'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal';
import { TEXT_ACTION, DANGER_TEXT_ACTION } from '@/components/ai/connect/connect-shared';
import { chooseChatTarget } from '@/lib/chat-target';
import {
  BROWSER_CAN,
  BROWSER_CANNOT,
  IF_DSUL_IS_COMPROMISED,
  SETUP_FAILURE_COPY,
  TOKEN_NOTE,
  allowOriginCommand,
  approveCommand,
  removeCommand,
} from '@/lib/openclaw-browser-copy';
import { useOpenClawBrowserStore } from '@/lib/openclaw-browser-store';
import { thisBrowserName } from '@/lib/openclaw-browser/device-name';
import { cn } from '@/lib/utils';
import { StatusPill } from './status-pill';

/**
 * Settings → AI → OpenClaw → Chat in Ask: this browser, paired with the
 * person's own gateway, with no plugin and nothing of dsul's server in the
 * path (lib/openclaw-browser-store.ts, memory/plans/openclaw-browser-chat.md).
 *
 * Three steps: let this site ask to connect (allowedOrigins), introduce this
 * browser with the gateway token, approve it on the machine OpenClaw runs on.
 * What an approved browser can do is said BEFORE the token is asked for, and
 * again once it is set up, in the same words (lib/openclaw-browser-copy.ts).
 */
export function OpenClawBrowserChat() {
  const paired = useOpenClawBrowserStore((s) => s.paired);
  const forget = useOpenClawBrowserStore((s) => s.forget);
  const [open, setOpen] = useState(false);
  const [forgetting, setForgetting] = useState(false);

  if (!paired) {
    return (
      <div data-testid="openclaw-browser-chat" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-foreground text-sm font-medium">Chat in Ask</p>
          <StatusPill tone="grey" testId="openclaw-browser-status">
            Not set up here
          </StatusPill>
        </div>
        <p className="text-muted-foreground text-xs">
          Chat with OpenClaw in Ask, straight from this browser to your gateway. No plugin, and nothing goes through
          dsul’s servers. Each browser sets up its own.
        </p>
        <div>
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="openclaw-browser-setup">
            Set up chat
          </Button>
        </div>
        <SetupDialog open={open} onOpenChange={setOpen} />
      </div>
    );
  }

  const host = (() => {
    try {
      return new URL(paired.url).host;
    } catch {
      return paired.url;
    }
  })();

  return (
    <div data-testid="openclaw-browser-chat" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <p className="text-foreground text-sm font-medium">Chat in Ask</p>
          <p className="text-muted-foreground truncate text-xs" data-testid="openclaw-browser-host">
            {host}
          </p>
        </div>
        <StatusPill tone="lime" testId="openclaw-browser-status">
          On this browser
        </StatusPill>
      </div>
      <CapabilityList />
      <p className="text-muted-foreground text-xs" data-testid="openclaw-browser-listed-as">
        OpenClaw lists it as “{thisBrowserName()}”. To take it off your gateway as well, run{' '}
        <Code>{removeCommand(paired.deviceId)}</Code>.
      </p>
      <div>
        <button
          type="button"
          className={DANGER_TEXT_ACTION}
          data-testid="openclaw-browser-forget"
          disabled={forgetting}
          onClick={() => {
            setForgetting(true);
            void forget().finally(() => setForgetting(false));
          }}
        >
          {forgetting ? 'Forgetting…' : 'Forget this browser'}
        </button>
      </div>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="bg-muted rounded-[4px] px-1 py-px font-mono text-[11px] break-all">{children}</code>;
}

function CapabilityList() {
  return (
    <div data-testid="openclaw-browser-capabilities" className="bg-muted/60 grid gap-x-4 gap-y-1.5 rounded-[8px] p-3 text-xs sm:grid-cols-2">
      <p className="text-foreground font-medium sm:col-span-2">This browser can</p>
      {BROWSER_CAN.map((line) => (
        <p key={line} className="text-foreground flex gap-2">
          <Check className="text-success-text mt-0.5 size-3 shrink-0" aria-hidden />
          {line}
        </p>
      ))}
      <p className="text-foreground mt-1 font-medium sm:col-span-2">It can’t</p>
      {BROWSER_CANNOT.map((line) => (
        <p key={line} className="text-muted-foreground flex gap-2">
          <span aria-hidden className="mt-0.5 w-3 shrink-0 text-center">
            –
          </span>
          {line}
        </p>
      ))}
    </div>
  );
}

function CommandLine({ command, testId }: { command: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="bg-muted flex items-center gap-2 rounded-[6px] py-2 pr-2 pl-3">
      <code data-testid={testId} className="text-foreground min-w-0 flex-1 font-mono text-[11px] leading-relaxed break-all">
        {command}
      </code>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 shrink-0"
        onClick={() =>
          void navigator.clipboard?.writeText(command).then(
            () => setCopied(true),
            () => {}
          )
        }
      >
        {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

function Steps({ at }: { at: 1 | 2 | 3 }) {
  return (
    <div className="flex gap-1.5" aria-label={`Step ${at} of 3`} role="img">
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={cn('h-1 w-7 rounded-full', n < at ? 'bg-primary' : n === at ? 'bg-foreground' : 'bg-border')}
        />
      ))}
    </div>
  );
}

function SetupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const setup = useOpenClawBrowserStore((s) => s.setup);
  const paired = useOpenClawBrowserStore((s) => s.paired);
  const startSetup = useOpenClawBrowserStore((s) => s.startSetup);
  const cancelSetup = useOpenClawBrowserStore((s) => s.cancelSetup);
  const [step, setStep] = useState<1 | 2>(1);
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [done, setDone] = useState(false);
  const addressId = useId();
  const tokenId = useId();
  const wasPaired = useRef(!!paired);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  // Approved while the dialog is open: OpenClaw answers in Ask from here on.
  useEffect(() => {
    if (open && paired && !wasPaired.current) {
      wasPaired.current = true;
      setToken('');
      setDone(true);
      chooseChatTarget('openclaw');
    }
    if (!paired) wasPaired.current = false;
  }, [open, paired]);

  function close(next: boolean) {
    if (next) return onOpenChange(true);
    cancelSetup();
    setToken('');
    setStep(1);
    setDone(false);
    onOpenChange(false);
  }

  const busy = setup.step === 'connecting';
  const failure = setup.step === 'failed' ? SETUP_FAILURE_COPY[setup.why] : null;
  const at: 1 | 2 | 3 = setup.step === 'pairing' ? 3 : step;

  return (
    <ResponsiveModal open={open} onOpenChange={close}>
      <ResponsiveModalContent className="sm:max-w-[520px]" data-testid="openclaw-browser-dialog">
        {done ? (
          <>
            <ResponsiveModalHeader>
              <ResponsiveModalTitle>Chat is set up</ResponsiveModalTitle>
              <ResponsiveModalDescription>
                OpenClaw answers in Ask on this browser now. You can change that under Who answers in chat.
              </ResponsiveModalDescription>
            </ResponsiveModalHeader>
            <ResponsiveModalFooter>
              <Button type="button" onClick={() => close(false)} data-testid="openclaw-browser-done">
                Done
              </Button>
            </ResponsiveModalFooter>
          </>
        ) : at === 1 ? (
          <>
            <ResponsiveModalHeader>
              <Steps at={1} />
              <ResponsiveModalTitle>Let dsul reach your gateway</ResponsiveModalTitle>
              <ResponsiveModalDescription>
                Your gateway only talks to sites you allow. Run this on the machine OpenClaw runs on, and restart the
                gateway if it asks. If you already allow other sites, add this one to that list instead.
              </ResponsiveModalDescription>
            </ResponsiveModalHeader>
            <CommandLine command={allowOriginCommand(origin)} testId="openclaw-browser-origin-command" />
            <div data-testid="openclaw-browser-risk" className="flex flex-col gap-2 rounded-[8px] border p-3 text-xs">
              <p className="text-foreground font-medium">What chat from this browser means</p>
              <p className="text-muted-foreground">
                Once you approve it, this browser can use your agent the way you can from OpenClaw’s own chat.
              </p>
              <CapabilityList />
              <p className="text-muted-foreground">{IF_DSUL_IS_COMPROMISED}</p>
            </div>
            <ResponsiveModalFooter>
              <button type="button" className={TEXT_ACTION} onClick={() => close(false)}>
                Cancel
              </button>
              <Button type="button" onClick={() => setStep(2)} data-testid="openclaw-browser-next">
                I’ve run it
              </Button>
            </ResponsiveModalFooter>
          </>
        ) : at === 2 ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void startSetup({ url: address, token });
            }}
          >
            <ResponsiveModalHeader>
              <Steps at={2} />
              <ResponsiveModalTitle>Where’s your gateway?</ResponsiveModalTitle>
              <ResponsiveModalDescription>
                The address this browser reaches it on, and its token to introduce this browser.
              </ResponsiveModalDescription>
            </ResponsiveModalHeader>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={addressId} className="text-foreground text-xs font-medium">
                Address
              </label>
              <Input
                id={addressId}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="wss://my-machine.tailnet.ts.net"
                autoComplete="off"
                spellCheck={false}
                data-testid="openclaw-browser-address"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={tokenId} className="text-foreground text-xs font-medium">
                Gateway token
              </label>
              <Input
                id={tokenId}
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                data-testid="openclaw-browser-token"
              />
              <p className="text-muted-foreground text-xs">
                Run <Code>openclaw config get gateway.auth.token</Code> to see it.
              </p>
            </div>
            <p className="bg-muted/60 text-muted-foreground flex gap-2 rounded-[8px] p-3 text-xs">
              <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {TOKEN_NOTE}
            </p>
            {failure && (
              <p role="alert" data-testid="openclaw-browser-error" className="text-destructive text-xs">
                {failure}
              </p>
            )}
            <ResponsiveModalFooter>
              <button type="button" className={TEXT_ACTION} onClick={() => setStep(1)} disabled={busy}>
                Back
              </button>
              <Button type="submit" disabled={busy || !address.trim() || !token.trim()} data-testid="openclaw-browser-connect">
                {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                {busy ? 'Connecting…' : 'Connect'}
              </Button>
            </ResponsiveModalFooter>
          </form>
        ) : (
          <>
            <ResponsiveModalHeader>
              <Steps at={3} />
              <ResponsiveModalTitle>Approve this browser</ResponsiveModalTitle>
              <ResponsiveModalDescription>
                Your gateway is asking whether to let it in. Say yes on the machine OpenClaw runs on.
              </ResponsiveModalDescription>
            </ResponsiveModalHeader>
            <CommandLine
              command={approveCommand(setup.step === 'pairing' ? setup.requestId : null)}
              testId="openclaw-browser-approve-command"
            />
            <p className="text-muted-foreground text-xs">
              It asks for read and write access, which is what the first step described, and never admin. Or approve it
              under Devices in OpenClaw’s Control UI, where it is listed as “{thisBrowserName()}”. This moves on by
              itself.
            </p>
            <ResponsiveModalFooter>
              <button
                type="button"
                className={TEXT_ACTION}
                onClick={() => {
                  cancelSetup();
                  setStep(2);
                }}
              >
                Back
              </button>
              <Button type="button" disabled data-testid="openclaw-browser-waiting">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Waiting for approval
              </Button>
            </ResponsiveModalFooter>
          </>
        )}
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
