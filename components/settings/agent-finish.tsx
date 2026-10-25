'use client';

import { useEffect, useId, useState } from 'react';
import { Switch } from '@/components/ui/switch';

/**
 * Settings → AI: may agents tick off the work handed to them
 * (lib/agent-finish.ts, /api/ai/agents/finish)? Off by default: an agent's
 * "done" is its report, and the item waits, with a "finished" chip, for the
 * user to check the work and tick it. Kirby, 2026-10-25.
 *
 * Every agent, OpenClaw and connected apps alike, so it sits below both. The
 * server's answer, fetched when shown and never stored; a switch the server
 * cannot save yet (migration 085 unapplied) says so rather than snapping back.
 */

type Load = { kind: 'loading' } | { kind: 'ready'; on: boolean } | { kind: 'unavailable' };

export function AgentFinishSection() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch('/api/ai/agents/finish', { cache: 'no-store' });
        const body = res.ok ? ((await res.json()) as { mayComplete?: boolean | null }) : null;
        if (!live) return;
        setLoad(typeof body?.mayComplete === 'boolean' ? { kind: 'ready', on: body.mayComplete } : { kind: 'unavailable' });
      } catch {
        if (live) setLoad({ kind: 'unavailable' });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function change(on: boolean) {
    setSaving(true);
    setError(null);
    setLoad({ kind: 'ready', on });
    try {
      const res = await fetch('/api/ai/agents/finish', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mayComplete: on }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setLoad({ kind: 'ready', on: !on });
      setError("Couldn't save that just now. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      data-ai-section="agent-finish"
      data-testid="ai-agent-finish"
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3"
    >
      <h3 id={`${id}-title`} className="text-foreground text-sm font-medium">
        Handed-off work
      </h3>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-6">
        <div className="min-w-0">
          <label htmlFor={`${id}-switch`} className="text-foreground text-sm">
            Let agents mark it done
          </label>
          <p id={`${id}-desc`} className="text-muted-foreground mt-[3px] max-w-[46ch] text-xs">
            {load.kind === 'unavailable'
              ? "Can't be changed until dsul's database is updated. Until then, you tick off what agents finish."
              : 'Off: when OpenClaw, Claude or another agent finishes something you handed it, the item waits for you to check it and tick it off. On: the agent can tick it off itself.'}
          </p>
        </div>
        <Switch
          id={`${id}-switch`}
          data-testid="ai-agent-finish-switch"
          aria-describedby={`${id}-desc`}
          checked={load.kind === 'ready' && load.on}
          disabled={load.kind !== 'ready' || saving}
          onCheckedChange={(checked) => void change(checked)}
        />
      </div>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </section>
  );
}
