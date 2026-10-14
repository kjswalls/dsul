'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TEXT_ACTION } from '@/components/ai/connect/connect-shared';
import { openClawSetup } from '@/lib/openclaw-setup';
import type { OpenClawConnectResponse } from '@/lib/ai-types';

/**
 * Settings → AI → OpenClaw → Connect: no plugin, nothing exposed
 * (lib/openclaw-setup.ts, app/docs/openclaw).
 *
 * Pressing Connect mints the OpenClaw agent key (POST /api/ai/openclaw, which
 * replaces any earlier one) and shows it ONCE, inside the commands to paste on
 * the machine OpenClaw runs on. Like Agent keys, the key lives only in the
 * pane's state and is gone when Done is pressed or Settings closes.
 *
 * `onConnected` lets the pane re-ask the connection store, so the pill reads
 * Paired and hand-off appears without a reload. That swaps the pane's
 * not-paired card for the paired one, so the commands are held by the pane
 * (`script`), not here, or they would vanish the moment they appeared.
 */
export function OpenClawConnect({
  label,
  script,
  onScript,
  onConnected,
}: {
  /** "Connect" for a first time, "Connect again" to replace a lost key. */
  label: string;
  /** The commands on screen, or null. */
  script: string | null;
  onScript: (script: string | null) => void;
  onConnected: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/openclaw', { method: 'POST' });
      if (res.status === 409) {
        return setError('That’s as many agent keys as one account can have. Revoke one under Agent keys first.');
      }
      if (!res.ok) throw new Error();
      const body = (await res.json()) as OpenClawConnectResponse;
      onScript(openClawSetup(window.location.origin, body.key).script);
      setCopied(false);
      onConnected();
    } catch {
      setError("Couldn't connect just now. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    if (!script) return;
    void navigator.clipboard?.writeText(script).then(
      () => setCopied(true),
      () => {}
    );
  }

  if (script) {
    return (
      <div data-testid="openclaw-connect-commands" className="flex flex-col gap-2">
        <p className="text-muted-foreground text-xs">
          Paste these into a terminal on the machine OpenClaw runs on. They hold a key that is shown only now.
        </p>
        <pre className="bg-muted text-foreground max-h-48 overflow-auto rounded-[6px] p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
          {script}
        </pre>
        <div className="flex items-center gap-3">
          <Button type="button" size="sm" variant="outline" onClick={copy} data-testid="openclaw-connect-copy">
            {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
            {copied ? 'Copied' : 'Copy commands'}
          </Button>
          <button type="button" className={TEXT_ACTION} onClick={() => onScript(null)} data-testid="openclaw-connect-done">
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void connect()}
          data-testid="openclaw-connect"
        >
          {busy ? 'Connecting…' : label}
        </Button>
      </div>
      {error && (
        <p role="alert" data-testid="openclaw-connect-error" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
