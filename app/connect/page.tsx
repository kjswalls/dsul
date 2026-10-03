'use client';

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { useAIConnectionStore } from '@/lib/ai-connection-store';

type State =
  | { kind: 'loading' }
  | { kind: 'needs-login' }
  | { kind: 'ready'; email: string }
  | { kind: 'authorizing' }
  | { kind: 'authorized' }
  | { kind: 'error'; message: string };

function ConnectPageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const code = searchParams.get('code') ?? '';

  const [state, setState] = useState<State>({ kind: 'loading' });

  async function checkAuth() {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      setState({ kind: 'needs-login' });
    } else {
      setState({ kind: 'ready', email: user.email ?? '' });
    }
  }

  useEffect(() => {
    checkAuth();
  }, []);

  function handleLogin() {
    // Route through /auth/callback so Supabase PKCE exchange happens before
    // landing back on the connect page. Direct redirect skips exchangeCodeForSession.
    const returnTo = `/connect${code ? `?code=${encodeURIComponent(code)}` : ''}`;
    const callbackUrl = `/auth/callback?next=${encodeURIComponent(returnTo)}`;
    router.push(`/login?redirect=${encodeURIComponent(callbackUrl)}`);
  }

  async function handleAuthorize() {
    setState({ kind: 'authorizing' });
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) {
        setState({ kind: 'error', message: 'No active session. Please log in again.' });
        return;
      }
      const res = await fetch('/api/agent/connect/authorize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ userCode: code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState({ kind: 'error', message: data.error ?? `Error ${res.status}` });
      } else {
        setState({ kind: 'authorized' });
        // The agent key now exists server-side, so "Give to OpenClaw" can
        // light up without a reload. The plugin usually registers its chat URL
        // later (on its gateway restart), which the next re-check picks up.
        void useAIConnectionStore.getState().serverChanged();
      }
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  }

  if (!code) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <div className="text-4xl">⚡</div>
          <h1 className="text-xl font-semibold text-foreground">Connect OpenClaw</h1>
          <p className="text-sm text-muted-foreground">
            To connect your AI agent to dsul, run:
          </p>
          <code className="block bg-muted text-foreground text-sm rounded-md px-4 py-3 font-mono">
            openclaw dsul-context setup
          </code>
          <p className="text-xs text-muted-foreground">
            The setup command will print a URL. Open it here to authorize.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-sm w-full space-y-6">
        <div className="text-center space-y-2">
          <div className="text-4xl">⚡</div>
          <h1 className="text-xl font-semibold text-foreground">Connect OpenClaw</h1>
        </div>

        {state.kind === 'loading' && (
          <p className="text-center text-sm text-muted-foreground">Checking session…</p>
        )}

        {state.kind === 'needs-login' && (
          <div className="space-y-4">
            <p className="text-sm text-center text-muted-foreground">
              You need to be logged in to authorize this connection.
            </p>
            <button
              onClick={handleLogin}
              className="w-full bg-primary text-primary-foreground rounded-md px-4 py-2.5 text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Log in to dsul
            </button>
          </div>
        )}

        {(state.kind === 'ready' || state.kind === 'authorizing') && (
          <div className="rounded-lg border border-border bg-card p-5 space-y-4">
            <div>
              <p className="text-sm font-medium text-foreground">Device code</p>
              <p className="text-2xl font-mono font-bold tracking-widest text-foreground mt-1">
                {code}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Verify this matches your terminal before authorizing.
              </p>
            </div>

            <div className="border-t border-border pt-4 space-y-1">
              <p className="text-xs text-muted-foreground">
                Logged in as <span className="text-foreground">{state.kind === 'ready' ? state.email : ''}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                This will give your AI agent access to your tasks and habits.
              </p>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={handleAuthorize}
                disabled={state.kind === 'authorizing'}
                className="flex-1 bg-primary text-primary-foreground rounded-md px-4 py-2.5 text-sm font-medium hover:bg-primary/90 disabled:opacity-60 transition-colors"
              >
                {state.kind === 'authorizing' ? 'Authorizing…' : 'Authorize'}
              </button>
              <button
                onClick={() => router.push('/')}
                disabled={state.kind === 'authorizing'}
                className="px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-md transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {state.kind === 'authorized' && (
          <div className="rounded-lg border border-success/30 bg-success/10 p-5 text-center space-y-2">
            <p className="text-lg font-semibold text-success-text">
              ✅ Authorized!
            </p>
            <p className="text-sm text-muted-foreground">
              Your terminal should detect this shortly and complete setup automatically.
            </p>
            <p className="text-xs text-muted-foreground">You can close this tab.</p>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-5 space-y-3">
            <p className="text-sm font-medium text-destructive">Authorization failed</p>
            <p className="text-xs text-muted-foreground">{state.message}</p>
            <button
              onClick={() => { setState({ kind: 'loading' }); checkAuth(); }}
              className="text-xs text-primary hover:underline"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    }>
      <ConnectPageInner />
    </Suspense>
  );
}
