'use client';

import { useCallback, useEffect, useState } from 'react';
import { DANGER_TEXT_ACTION } from '@/components/ai/connect/connect-shared';
import { SCOPE_WORDS, type Scope } from '@/lib/mcp-oauth/scopes';

/**
 * Settings → AI → Connected apps: the apps signed in to dsul's MCP server over
 * OAuth (memory/plans/mcp-oauth.md), each with what it may do and a Disconnect
 * that stops its tokens at once. Also where someone learns the address to
 * give Claude or Cursor.
 *
 * Fetched when shown, never stored: the list is the server's, and a stale one
 * would show an app as connected after it was disconnected elsewhere.
 */

interface App {
  id: string;
  name: string;
  scope: Scope;
  connectedAt: string;
  lastUsedAt: string | null;
}

type Load = { kind: 'loading' } | { kind: 'ready'; apps: App[] } | { kind: 'unavailable' };

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function ConnectedAppsSection() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [origin, setOrigin] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/oauth/grants', { cache: 'no-store' });
      if (!res.ok) return setLoad({ kind: 'unavailable' });
      const body = (await res.json()) as { apps?: App[] };
      setLoad({ kind: 'ready', apps: body.apps ?? [] });
    } catch {
      setLoad({ kind: 'unavailable' });
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    void refresh();
  }, [refresh]);

  async function disconnect(id: string) {
    setPending(id);
    setError(null);
    try {
      const res = await fetch(`/api/oauth/grants/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error();
      setConfirming(null);
      await refresh();
    } catch {
      setError("Couldn't disconnect it just now. Try again.");
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      data-ai-section="connected-apps"
      data-testid="ai-connected-apps"
      aria-labelledby="ai-connected-apps-title"
      className="flex flex-col gap-3"
    >
      <h3 id="ai-connected-apps-title" className="text-foreground text-sm font-medium">
        Connected apps
      </h3>
      <p className="text-muted-foreground text-xs">
        Claude, Cursor and other apps that speak MCP can read and change your planner. Add{' '}
        <code className="bg-muted text-foreground rounded px-1 py-0.5 font-mono" data-testid="mcp-url">
          {origin}/api/mcp
        </code>{' '}
        as a custom connector in the app, then sign in here when it asks.
      </p>

      {load.kind === 'ready' && load.apps.length > 0 && (
        <ul className="border-border divide-border divide-y rounded-[8px] border">
          {load.apps.map((app) => (
            <li key={app.id} className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="connected-app">
              <div className="min-w-0 flex-1 basis-48">
                <p className="text-foreground truncate text-sm">{app.name}</p>
                <p className="text-muted-foreground text-xs">
                  {SCOPE_WORDS[app.scope]}. Connected {day(app.connectedAt)}
                  {app.lastUsedAt ? `, last used ${day(app.lastUsedAt)}` : ''}.
                </p>
              </div>
              {confirming === app.id ? (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className={DANGER_TEXT_ACTION}
                    disabled={pending === app.id}
                    onClick={() => disconnect(app.id)}
                    data-testid="connected-app-confirm"
                  >
                    {pending === app.id ? 'Disconnecting…' : `Disconnect ${app.name}`}
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
                  onClick={() => setConfirming(app.id)}
                  data-testid="connected-app-disconnect"
                >
                  Disconnect
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </section>
  );
}
