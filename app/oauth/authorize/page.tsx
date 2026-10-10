'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { SCOPE_WORDS, type Scope } from '@/lib/mcp-oauth/scopes';
import { loginPathFor } from '@/lib/signed-out-redirect';

/**
 * /oauth/authorize — where an MCP client (Claude, Cursor, …) sends the user to
 * say yes or no to it reaching their planner. memory/plans/mcp-oauth.md.
 *
 * Signed out, proxy.ts sends the visitor to /login and back here with the whole
 * request intact. The page asks /api/oauth/authorize who the app is and checks
 * where the answer goes before showing anything, and only ever navigates to a
 * URL that route returned, which it built against the app's registered list.
 */

type State =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'ready'; name: string; returnsTo: string }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'error'; message: string };

const BUTTON =
  'flex-1 rounded-[calc(var(--radius)*0.5)] px-4 py-2 text-[13px] font-medium transition-colors disabled:opacity-60';

function AuthorizeInner() {
  const params = useSearchParams();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [scope, setScope] = useState<Scope>(params.get('scope')?.trim() === 'planner:read' ? 'planner:read' : 'planner');

  const clientId = params.get('client_id') ?? '';
  const redirectUri = params.get('redirect_uri') ?? '';

  useEffect(() => {
    if (params.get('response_type') !== 'code' || !clientId || !redirectUri) {
      setState({ kind: 'error', message: 'This sign-in link is missing something. Start again from the app.' });
      return;
    }
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri });
    fetch(`/api/oauth/authorize?${q}`, { cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 401) return setState({ kind: 'signed-out' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          return setState({
            kind: 'error',
            message:
              body.error === 'bad_redirect'
                ? "This app asked to send you somewhere it never registered, so dsul won't."
                : body.error === 'unknown_client'
                  ? "dsul doesn't know this app. Start again from the app."
                  : "Couldn't check this app just now. Try again in a moment.",
          });
        }
        setState({ kind: 'ready', name: body.name, returnsTo: body.returnsTo });
      })
      .catch(() => setState({ kind: 'error', message: "Couldn't reach dsul. Check your connection." }));
  }, [clientId, redirectUri, params]);

  async function decide(approve: boolean) {
    setState({ kind: 'sending' });
    try {
      const res = await fetch('/api/oauth/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: params.get('code_challenge'),
          code_challenge_method: params.get('code_challenge_method'),
          state: params.get('state') ?? undefined,
          resource: params.get('resource') ?? undefined,
          scope,
          approve,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.redirect !== 'string') {
        setState({ kind: 'error', message: "Couldn't finish connecting. Try again from the app." });
        return;
      }
      setState({ kind: 'sent' });
      window.location.assign(body.redirect);
    } catch {
      setState({ kind: 'error', message: "Couldn't reach dsul. Check your connection." });
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-sm w-full space-y-6" data-testid="oauth-authorize">
        {state.kind === 'loading' && <p className="text-center text-sm text-muted-foreground">Checking…</p>}

        {state.kind === 'signed-out' && (
          <div className="space-y-4 text-center">
            <h1 className="text-xl font-semibold text-foreground">Sign in to connect</h1>
            <p className="text-sm text-muted-foreground">Sign in to dsul first, then you can choose what this app may do.</p>
            <a
              href={loginPathFor(`${window.location.pathname}${window.location.search}`, window.location.origin)}
              className={`${BUTTON} block bg-foreground text-background hover:bg-foreground/85`}
            >
              Sign in to dsul
            </a>
          </div>
        )}

        {(state.kind === 'ready' || state.kind === 'sending') && (
          <div className="rounded-lg border border-border bg-card p-5 space-y-5">
            <div className="space-y-1">
              <h1 className="text-lg font-semibold text-foreground">
                {state.kind === 'ready' ? `Connect ${state.name} to dsul?` : 'Connecting…'}
              </h1>
              {state.kind === 'ready' && (
                <p className="text-xs text-muted-foreground">
                  Any app can call itself anything, so check where it sends you back:{' '}
                  <span className="text-foreground font-medium" data-testid="oauth-returns-to">
                    {state.returnsTo}
                  </span>
                </p>
              )}
            </div>

            <fieldset className="space-y-2" disabled={state.kind === 'sending'}>
              <legend className="text-sm font-medium text-foreground mb-1">What it may do</legend>
              {(['planner', 'planner:read'] as const).map((s) => (
                <label key={s} className="flex items-start gap-2 text-sm text-foreground cursor-pointer">
                  <input
                    type="radio"
                    name="scope"
                    value={s}
                    checked={scope === s}
                    onChange={() => setScope(s)}
                    className="mt-1"
                    data-testid={`oauth-scope-${s}`}
                  />
                  <span>{SCOPE_WORDS[s]}</span>
                </label>
              ))}
            </fieldset>

            <p className="text-xs text-muted-foreground">
              You can disconnect it any time in Settings, under AI.
            </p>

            <div className="flex gap-2">
              <button
                onClick={() => decide(true)}
                disabled={state.kind === 'sending'}
                className={`${BUTTON} bg-foreground text-background hover:bg-foreground/85`}
                data-testid="oauth-allow"
              >
                Allow
              </button>
              <button
                onClick={() => decide(false)}
                disabled={state.kind === 'sending'}
                className={`${BUTTON} border border-border text-muted-foreground hover:text-foreground`}
                data-testid="oauth-deny"
              >
                Don&apos;t allow
              </button>
            </div>
          </div>
        )}

        {state.kind === 'sent' && (
          <p className="text-center text-sm text-muted-foreground">Done. You can go back to the app.</p>
        )}

        {state.kind === 'error' && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-5 space-y-2">
            <p className="text-sm font-medium text-destructive">Can&apos;t connect this app</p>
            <p className="text-xs text-muted-foreground">{state.message}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AuthorizePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-background">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      }
    >
      <AuthorizeInner />
    </Suspense>
  );
}
