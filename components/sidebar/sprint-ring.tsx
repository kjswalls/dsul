'use client';

import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { startSprint, stopSprint, useDoStuffStore } from '@/lib/do-stuff';
import { spanLabel } from '@/lib/do-stuff-walk';
import { cn } from '@/lib/utils';

/**
 * Sprint (Kirby's add-on, 2026-10-16; memory/plans/power-mode.md, the polish
 * round): a ring sized to the gap before the next block (lib/do-stuff-walk.ts
 * sprintFor). It fills as the time goes, in lime on its own stroke, and when it
 * is up it says so and stays, quietly, until tapped: no sound, no red, and the
 * day goes on whether or not the thing got done.
 */

/** The wall clock, once a second while a sprint is running. */
function useSecondClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** The ring itself, with the minutes left in it; tapping it ends the sprint. */
export function SprintRing({ size = 22, className }: { size?: number; className?: string }) {
  const sprint = useDoStuffStore((s) => s.sprint);
  const now = useSecondClock(!!sprint);
  if (!sprint) return null;
  const total = sprint.endsAt - sprint.startedAt;
  const left = Math.max(0, sprint.endsAt - now);
  const pct = total > 0 ? 1 - left / total : 1;
  const up = left === 0;
  const stroke = size >= 40 ? 3.5 : 2.5;
  const r = size / 2 - stroke;
  const c = 2 * Math.PI * r;
  const mins = Math.ceil(left / 60_000);
  const label = up
    ? sprint.until
      ? `time's up · ${sprint.until} next`
      : "time's up"
    : `${spanLabel(mins)} left${sprint.until ? ` · till ${sprint.until}` : ''}`;
  return (
    <button
      type="button"
      onClick={stopSprint}
      title={up ? 'Clear the sprint' : 'End the sprint'}
      aria-label={`Sprint: ${label}. ${up ? 'Clear it' : 'End it'}`}
      data-testid="sprint-ring"
      data-up={up || undefined}
      className={cn('flex min-w-0 items-center gap-2 rounded-[7px] text-left hover:bg-accent/60', className)}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="shrink-0">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-1000 motion-safe:ease-linear"
        />
        {size >= 40 && !up && (
          <text
            x="50%"
            y="50%"
            dominantBaseline="central"
            textAnchor="middle"
            className="fill-foreground font-num text-[13px] font-medium"
          >
            {mins}
          </text>
        )}
      </svg>
      <span className="truncate text-xs text-muted-foreground" data-testid="sprint-label">
        {label}
      </span>
    </button>
  );
}

/** "sprint till Lunch with Ana", offered when the gap is worth one and none is running. */
export function SprintButton({
  offer,
  className,
}: {
  offer: { minutes: number; until: string | null } | null;
  className?: string;
}) {
  const running = useDoStuffStore((s) => !!s.sprint);
  if (!offer || running) return null;
  return (
    <button
      type="button"
      onClick={() => startSprint(offer.minutes, offer.until)}
      title={`A ${spanLabel(offer.minutes)} sprint${offer.until ? `, ending 5 minutes before ${offer.until}` : ''}`}
      data-testid="sprint-start"
      className={cn(
        'flex h-7 min-w-0 items-center gap-1 rounded-[7px] px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground',
        className
      )}
    >
      <Timer aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{offer.until ? `sprint till ${offer.until}` : `sprint ${spanLabel(offer.minutes)}`}</span>
    </button>
  );
}
