'use client';

import { useId, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DANGER_TEXT_ACTION, TEXT_ACTION } from '@/components/ai/connect/connect-shared';
import { routineFireUrl, routineToken } from '@/lib/agent-wake';
import { cn } from '@/lib/utils';

/**
 * "Wake Claude when I hand it work", under a connected Claude in Settings → AI
 * → Connected apps (lib/agent-wake.ts). Claude cannot be reached until someone
 * opens it, but a Claude Code routine can be started over HTTP, so the person
 * makes one routine that reads their dsul queue and pastes its /fire URL and
 * token here. Three steps, the routine's instructions ready to copy; saving
 * fires the routine once as a test, so a wrong token is refused here and not
 * discovered later.
 *
 * Only for an app named Claude: the routine is Claude's, and no other MCP app
 * has a way to be started from outside.
 */

/** What the routine is told to do on every run, ready to paste into its instructions. */
export const ROUTINE_PROMPT = [
  'You do the planner work that dsul hands to you.',
  'Use the dsul connector. Call dsul_my_work to read your queue; if the routine-fire-payload names item ids, start with those.',
  'For each item: do what you can with the tools you have, and report what you did with dsul_report_progress.',
  'When you need a decision only I can make, ask with dsul_ask_user and move on.',
  'Mark an item done with dsul_complete once it is finished.',
  "An item with aiMode 'prepare' is only to get ready: read dsul_prep_brief once, hand back what you prepared with dsul_save_prep, report done, and never send anything or complete it.",
  'If your queue is empty, stop.',
].join(' ');

/** Apps a routine can wake: Claude, by whatever name it registered under. */
export function canWake(name: string): boolean {
  return /\bclaude\b/i.test(name);
}

const PROBLEM: Record<string, string> = {
  key_rejected: "That routine didn't start. Check the URL and that the token is the one it showed you.",
  invalid: "That doesn't look like a routine's URL and token.",
  unavailable: "Waking apps isn't available yet. Try again later.",
};

export function AppWake({
  name,
  assignee,
  wake,
  onChange,
}: {
  name: string;
  /** The stored assignee this app answers to (lib/agent-assignees.ts). */
  assignee: string;
  wake: boolean;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const urlId = useId();
  const tokenId = useId();

  async function send(method: 'PUT' | 'DELETE', body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/agents/wake', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const { error: code } = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setError(PROBLEM[code ?? ''] ?? "Couldn't save that just now. Try again.");
        return;
      }
      setOpen(false);
      setUrl('');
      setToken('');
      onChange();
    } catch {
      setError("Couldn't save that just now. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    void navigator.clipboard?.writeText(ROUTINE_PROMPT).then(
      () => setCopied(true),
      () => {}
    );
  }

  if (wake) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-xs" data-testid="app-wake-on">
        <span className="text-muted-foreground">{name} starts the moment you hand it work.</span>
        <button
          type="button"
          className={DANGER_TEXT_ACTION}
          disabled={busy}
          onClick={() => void send('DELETE', { assignee })}
          data-testid="app-wake-remove"
        >
          {busy ? 'Stopping…' : 'Stop waking it'}
        </button>
        {error && (
          <p role="alert" className="text-destructive basis-full">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        className={cn(TEXT_ACTION, 'self-start text-xs')}
        onClick={() => setOpen(true)}
        data-testid="app-wake-open"
      >
        Wake {name} when I hand it work
      </button>
    );
  }

  const ready = !!routineFireUrl(url) && !!routineToken(token);
  return (
    <form
      className="border-border flex flex-col gap-3 rounded-[8px] border p-4 text-xs"
      data-testid="app-wake-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void send('PUT', { assignee, url, token });
      }}
    >
      <p className="text-muted-foreground">
        Otherwise {name} picks up its work the next time you open it. A Claude routine can start the moment you hand
        something over.
      </p>
      <ol className="text-foreground flex list-decimal flex-col gap-3 pl-4">
        <li>
          At{' '}
          <a
            href="https://claude.ai/code/routines"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            claude.ai/code/routines
          </a>
          , make a new routine with the dsul connector, and give it these instructions:
          <div className="mt-2 flex items-start gap-2">
            <p
              className="bg-muted text-muted-foreground min-w-0 flex-1 rounded px-2 py-1.5"
              data-testid="app-wake-prompt"
            >
              {ROUTINE_PROMPT}
            </p>
            <Button type="button" variant="outline" size="sm" onClick={copy} data-testid="app-wake-copy">
              {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </li>
        <li>
          Under Select a trigger, add API and save the routine. Copy its URL, then Generate token and copy that too. A
          daily schedule on the same routine catches anything a wake misses.
        </li>
        <li className="flex flex-col gap-2">
          <span>Paste them here. Saving starts the routine once, to check it works.</span>
          <label htmlFor={urlId} className="font-medium">
            Routine URL
          </label>
          <Input
            id={urlId}
            value={url}
            placeholder="https://api.anthropic.com/v1/claude_code/routines/…/fire"
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="app-wake-url"
          />
          <label htmlFor={tokenId} className="font-medium">
            Token
          </label>
          <Input
            id={tokenId}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-testid="app-wake-token"
          />
        </li>
      </ol>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={!ready || busy} data-testid="app-wake-save">
          {busy ? 'Checking…' : 'Save'}
        </Button>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
