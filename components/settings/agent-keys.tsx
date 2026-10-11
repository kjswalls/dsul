'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DANGER_TEXT_ACTION, TEXT_ACTION } from '@/components/ai/connect/connect-shared';
import { cn } from '@/lib/utils';
import { SCOPE_WORDS, type Scope } from '@/lib/mcp-oauth/scopes';

/**
 * Settings → AI → Agent keys (lib/agent-keys.ts, migration 072): named keys for
 * a second agent, a script or a hosted runtime, each read-only or
 * read-and-change, beside the OpenClaw key and never instead of it.
 *
 * A new key is shown ONCE, in this component's state, and forgotten when
 * dismissed or when Settings closes: the server keeps only its hash. Like
 * Connected apps, the list is fetched when shown and never stored.
 */

interface AgentKey {
  id: string;
  name: string;
  scope: Scope;
  createdAt: string;
  lastUsedAt: string | null;
}

type Load = { kind: 'loading' } | { kind: 'ready'; keys: AgentKey[] } | { kind: 'unavailable' };

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const SCOPE_CHOICES: { scope: Scope; label: string }[] = [
  { scope: 'planner:read', label: 'Read only' },
  { scope: 'planner', label: 'Read and change' },
];

export function AgentKeysSection() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<Scope>('planner:read');
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/agent-keys', { cache: 'no-store' });
      if (!res.ok) return setLoad({ kind: 'unavailable' });
      const body = (await res.json()) as { keys?: AgentKey[] };
      setLoad({ kind: 'ready', keys: body.keys ?? [] });
    } catch {
      setLoad({ kind: 'unavailable' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/agent-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, scope }),
      });
      if (res.status === 409) return setError('That’s as many keys as one account can have. Revoke one first.');
      if (!res.ok) throw new Error();
      const body = (await res.json()) as { key: string; agentKey: AgentKey };
      setFresh({ name: body.agentKey.name, key: body.key });
      setCopied(false);
      setMaking(false);
      setName('');
      setScope('planner:read');
      await refresh();
    } catch {
      setError("Couldn't make a key just now. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setPending(id);
    setError(null);
    try {
      const res = await fetch(`/api/agent-keys/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error();
      setConfirming(null);
      await refresh();
    } catch {
      setError("Couldn't revoke it just now. Try again.");
    } finally {
      setPending(null);
    }
  }

  function copy(key: string) {
    void navigator.clipboard?.writeText(key).then(
      () => setCopied(true),
      () => {}
    );
  }

  // Nothing to offer before 072 is applied: no heading over an empty promise.
  if (load.kind === 'unavailable') return null;

  return (
    <section
      data-ai-section="agent-keys"
      data-testid="ai-agent-keys"
      aria-labelledby="ai-agent-keys-title"
      className="flex flex-col gap-3"
    >
      <h3 id="ai-agent-keys-title" className="text-foreground text-sm font-medium">
        Agent keys
      </h3>
      <p className="text-muted-foreground text-xs">
        A key for another agent or a script, sent as <code className="font-mono">Authorization: Bearer</code> to the
        agent API or <code className="font-mono">/api/mcp</code>. Give each one a name, and make it read only unless it
        needs to change things.
      </p>

      {fresh && (
        <div className="border-border flex flex-col gap-2 rounded-[8px] border p-4" data-testid="agent-key-fresh">
          <p className="text-foreground text-sm">Your key for {fresh.name}</p>
          <div className="flex items-center gap-2">
            <code
              className="bg-muted text-foreground min-w-0 flex-1 truncate rounded px-2 py-1.5 font-mono text-xs"
              data-testid="agent-key-value"
            >
              {fresh.key}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copy(fresh.key)}
              data-testid="agent-key-copy"
            >
              {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            This is the only time it’s shown. Keep it somewhere safe; if it’s lost, make a new one.
          </p>
          <button
            type="button"
            className={cn(TEXT_ACTION, 'self-start')}
            onClick={() => setFresh(null)}
            data-testid="agent-key-done"
          >
            Done
          </button>
        </div>
      )}

      {load.kind === 'ready' && load.keys.length > 0 && (
        <ul className="border-border divide-border divide-y rounded-[8px] border">
          {load.keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="agent-key">
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-foreground truncate text-sm">{k.name}</p>
                <p className="text-muted-foreground text-xs">
                  {SCOPE_WORDS[k.scope]}. Made {day(k.createdAt)}
                  {k.lastUsedAt ? `, last used ${day(k.lastUsedAt)}` : ', not used yet'}.
                </p>
              </div>
              {confirming === k.id ? (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className={DANGER_TEXT_ACTION}
                    disabled={pending === k.id}
                    onClick={() => revoke(k.id)}
                    data-testid="agent-key-confirm"
                  >
                    {pending === k.id ? 'Revoking…' : `Revoke ${k.name}`}
                  </button>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground text-xs"
                    onClick={() => setConfirming(null)}
                  >
                    Keep
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className={DANGER_TEXT_ACTION}
                  onClick={() => setConfirming(k.id)}
                  data-testid="agent-key-revoke"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {load.kind === 'ready' &&
        (making ? (
          <form
            className="border-border flex flex-col gap-3 rounded-[8px] border p-4"
            data-testid="agent-key-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label htmlFor={nameId} className="text-foreground text-xs font-medium">
              Name
            </label>
            <Input
              id={nameId}
              value={name}
              maxLength={60}
              autoFocus
              placeholder="Like “Home server” or “Weekly report script”"
              onChange={(e) => setName(e.target.value)}
              data-testid="agent-key-name"
            />
            <div role="radiogroup" aria-label="What it may do" className="flex flex-wrap gap-2">
              {SCOPE_CHOICES.map((c) => (
                <button
                  key={c.scope}
                  type="button"
                  role="radio"
                  aria-checked={scope === c.scope}
                  onClick={() => setScope(c.scope)}
                  data-testid={`agent-key-scope-${c.scope === 'planner' ? 'write' : 'read'}`}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs transition-colors',
                    scope === c.scope
                      ? 'border-transparent bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">{SCOPE_WORDS[scope]}.</p>
            <div className="flex items-center gap-3">
              <Button type="submit" size="sm" disabled={!name.trim() || busy} data-testid="agent-key-create">
                {busy ? 'Making…' : 'Make key'}
              </Button>
              <button
                type="button"
                className={TEXT_ACTION}
                onClick={() => {
                  setMaking(false);
                  setName('');
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className={cn(TEXT_ACTION, 'self-start')}
            onClick={() => {
              setMaking(true);
              setError(null);
            }}
            data-testid="agent-key-new"
          >
            New key
          </button>
        ))}

      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </section>
  );
}
