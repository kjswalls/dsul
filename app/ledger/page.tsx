'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { format, parseISO, subDays } from 'date-fns';
import { ChevronLeft, HandCoins, LineChart, Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase';
import { usePlannerStore } from '@/lib/planner-store';
import { formatMoney } from '@/lib/stakes/copy';
import {
  entriesFromRows,
  entryLabel,
  groupByDay,
  outstandingTotals,
  payees,
  since,
  type CurrencyTotal,
  type LedgerDay,
  type LedgerEntry,
  type LedgerRowFromDb,
} from '@/lib/stakes/ledger';
import { decodeDetail } from '@/lib/stakes/beeminder';
import { cn } from '@/lib/utils';

/**
 * The ledger — what your settled days came to.
 *
 * A ROUTE, not a settings pane, and not a dialog. The pledge notification says
 * "you owe £30" and has to be able to link somewhere that shows the rows behind
 * that number; a pane inside Settings would make the record a preference, and a
 * dialog could not be linked to at all. Follows the /item/[id] and /settings
 * precedent: no AppShell, the root layout's SupabaseProvider supplying the
 * session.
 *
 * READ-ONLY, and that is the design. stake_events grants the owner SELECT and
 * nothing else (migration 034) — a ledger the subject can edit is not a ledger.
 * There is no "mark as paid" here for the same reason there is no payment rail:
 * dsul records what a day concluded and says so plainly. Settling up happens
 * where the money is.
 */

const WINDOW_DAYS = 180;
const RECENT_DAYS = 30;

export default function LedgerPage() {
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!userId) return;
    const from = format(subDays(new Date(), WINDOW_DAYS), 'yyyy-MM-dd');
    // RLS scopes this to the signed-in user; the explicit user_id would be
    // belt-and-braces and is left off deliberately so a policy regression fails
    // loudly in tests rather than being masked here.
    const { data, error: queryError } = await createClient()
      .from('stake_events')
      .select('id, date, subject, subject_title, kind, channel, amount_cents, currency, detail, committed_at')
      .gte('date', from)
      .order('date', { ascending: false });

    if (queryError) {
      // A missing table means the migration has not reached this deployment —
      // which is an empty ledger, not a broken page.
      const missing = queryError.code === '42P01' || queryError.code === 'PGRST205';
      setEntries([]);
      setError(missing ? null : queryError.message);
      return;
    }
    setError(null);
    setEntries(entriesFromRows((data ?? []) as LedgerRowFromDb[]));
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const days = useMemo(() => groupByDay(entries ?? []), [entries]);
  const totals = useMemo(() => outstandingTotals(entries ?? []), [entries]);
  const recentTotals = useMemo(
    () => outstandingTotals(since(entries ?? [], format(subDays(new Date(), RECENT_DAYS), 'yyyy-MM-dd'))),
    [entries]
  );
  const owedTo = useMemo(() => payees(entries ?? []), [entries]);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-8 pt-[max(2rem,env(titlebar-area-height,0px))]">
      <nav className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Link href="/" className="hover:text-foreground inline-flex items-center gap-1 transition-colors">
          <ChevronLeft className="size-3.5" />
          dsul
        </Link>
        <span>/</span>
        <span className="text-foreground font-medium">Ledger</span>
      </nav>

      <header className="flex flex-col gap-2">
        <h1 className="text-foreground text-2xl font-semibold tracking-tight">Ledger</h1>
        <p className="text-muted-foreground max-w-prose text-sm leading-relaxed">
          What your settled days came to. Every row here was written by the nightly
          settlement — <span className="text-foreground">dsul keeps the record and cannot take
          payment</span>, so squaring up happens wherever you agreed it would.
        </p>
      </header>

      {/* userId alone is not "signed in": initializeStore stamps it BEFORE the
          items fetch resolves, so checking it on its own flashes the signed-out
          copy at every signed-in visitor for the length of the fetch. Same gate
          the item page uses, for the same reason. */}
      {!userId && isLoading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : !userId ? (
        <EmptyState
          title="Sign in to see your ledger"
          body="These rows belong to an account."
          action={<Button asChild size="sm" variant="outline"><Link href="/login">Sign in</Link></Button>}
        />
      ) : entries === null ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <>
          {error && (
            <p className="text-muted-foreground text-sm" data-testid="ledger-error">
              Could not read the ledger — {error}
            </p>
          )}

          {totals.length > 0 && (
            <section className="flex flex-col gap-3" aria-labelledby="ledger-owed">
              {/* Names the WINDOW. The rows below are the last 180 days, so a
                  heading that said "owed" flat would be asserting an all-time
                  total this page never read. */}
              <h2 id="ledger-owed" className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Recorded as owed · last {WINDOW_DAYS} days
              </h2>
              <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                {totals.map((total) => (
                  <Total key={total.currency} total={total} recent={recentTotals.find((r) => r.currency === total.currency)} />
                ))}
              </div>
              {owedTo.length > 0 && (
                <p className="text-muted-foreground text-sm">
                  Payable to {owedTo.join(', ')}.
                </p>
              )}
            </section>
          )}

          {days.length === 0 ? (
            <EmptyState
              title="Nothing settled yet"
              body="Turn on Settle the day in Rituals, attach a stake, and the first night that closes will show up here."
              action={<Button asChild size="sm" variant="outline"><Link href="/settings/rituals">Open Rituals</Link></Button>}
            />
          ) : (
            <section className="flex flex-col gap-6" aria-label="Settled days">
              {days.map((day) => (
                <DayBlock key={day.date} day={day} />
              ))}
              <p className="text-muted-foreground text-xs">
                The last {WINDOW_DAYS} days.
              </p>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function Total({ total, recent }: { total: CurrencyTotal; recent?: CurrencyTotal }) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={`ledger-total-${total.currency}`}>
      <span className="text-foreground text-3xl font-semibold tabular-nums tracking-tight">
        {formatMoney(total.cents, total.currency)}
      </span>
      <span className="text-muted-foreground text-xs">
        {total.misses} {total.misses === 1 ? 'miss' : 'misses'}
        {recent && recent.cents > 0 && ` · ${formatMoney(recent.cents, recent.currency)} in the last ${RECENT_DAYS} days`}
      </span>
    </div>
  );
}

function DayBlock({ day }: { day: LedgerDay }) {
  return (
    <article className="flex flex-col gap-2" data-testid={`ledger-day-${day.date}`}>
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-foreground text-sm font-medium">
          {format(parseISO(day.date), 'EEEE d MMMM yyyy')}
        </h3>
        <span className="text-muted-foreground text-xs tabular-nums">
          {day.hits > 0 && `${day.hits} done`}
          {day.hits > 0 && day.misses > 0 && ' · '}
          {day.misses > 0 && `${day.misses} missed`}
        </span>
      </div>
      <ul className="border-border divide-border divide-y rounded-md border">
        {day.entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </article>
  );
}

const CHANNEL_ICON = {
  pledge: HandCoins,
  beeminder: LineChart,
  'accountability-partner': Users,
} as const;

function EntryRow({ entry }: { entry: LedgerEntry }) {
  const Icon = CHANNEL_ICON[entry.channel as keyof typeof CHANNEL_ICON];
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 text-sm">
      {Icon ? <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden /> : null}
      <span className={cn('text-foreground min-w-0 flex-1 truncate', entry.kind === 'hit' && 'text-muted-foreground')}>
        {entryLabel(entry)}
      </span>
      <span className="text-muted-foreground shrink-0 text-xs">{detailText(entry)}</span>
      {entry.amountCents ? (
        <span className="text-foreground shrink-0 text-sm font-medium tabular-nums">
          {formatMoney(entry.amountCents, entry.currency ?? 'USD')}
        </span>
      ) : null}
      {/* A row the settlement claimed but never got out the door. Stated rather
          than hidden: "recorded" and "reported" are different facts, and the
          whole point of committed_at is that the ledger can tell them apart. */}
      {!entry.committedAt && (
        <span className="text-muted-foreground shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px]">
          not sent yet
        </span>
      )}
    </li>
  );
}

function detailText(entry: LedgerEntry): string {
  if (entry.channel === 'beeminder') {
    const { goal } = decodeDetail(entry.detail);
    return goal ? `→ ${goal}` : 'datapoint';
  }
  if (entry.channel === 'pledge') return entry.detail ?? 'pledged';
  if (entry.channel === 'accountability-partner') return 'digest';
  return entry.detail ?? '';
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="border-border flex flex-col items-start gap-3 rounded-md border border-dashed px-5 py-8">
      <h2 className="text-foreground text-sm font-medium">{title}</h2>
      <p className="text-muted-foreground max-w-prose text-sm">{body}</p>
      {action}
    </div>
  );
}
