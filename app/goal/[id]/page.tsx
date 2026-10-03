'use client';

import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CheckinHistory,
  GoalMemberGroups,
  GoalMemberNote,
  GoalSummary,
  MilestoneTimeline,
} from '@/components/planner/goal-sections';
import { usePlannerStore } from '@/lib/planner-store';
import { usePlannerSettled } from '@/lib/planner-ready';
import { BufferedTextarea, TitleRow } from '@/components/planner/organize/detail-parts';
import { GOAL_STATES } from '@/components/planner/organize/container-fields';
import { ChoiceChip, ColorChip, DateRangeChip } from '@/components/primitives/organizer-chips';
import { useUIStore } from '@/lib/ui-store';
import { checkinStanding, isGoalActive } from '@/lib/goals';
import { useGoalsEnabled } from '@/lib/extension-gates';
import { formatShort, useToday } from '@/lib/collections';
import { accentColorForName } from '@/lib/accent-colors';

/**
 * The goal page — a goal's reading surface, and the one container detail that
 * is a destination rather than a settings screen.
 *
 * Follows /item/[id]'s model exactly: a client route, deep-linkable so Beacon
 * can answer with a URL, with the same client-side auth posture (the root
 * layout hydrates the store when a session exists and sends the page to /login
 * when none is stored; a stored one it cannot use leaves this page with no
 * goals, on the not-found state). Its fields — name, why, status, window,
 * colour — edit in place with the console pane's own controls (Kirby,
 * 2026-09-27); membership still lives in the Organize console.
 *
 * See memory/plans/long-term-goals.md, Phase 2.
 */

function Square({ color }: { color: string }) {
  return (
    <span
      className="inline-block size-[9px] shrink-0 rounded-[3px]"
      style={{ background: color }}
      aria-hidden
    />
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function GoalPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const goals = usePlannerStore((s) => s.goals);
  const items = usePlannerStore((s) => s.items);
  const userId = usePlannerStore((s) => s.userId);
  const openDialog = useUIStore((s) => s.openDialog);
  const updateGoal = usePlannerStore((s) => s.updateGoal);
  const setGoalState = usePlannerStore((s) => s.setGoalState);
  const router = useRouter();
  const { todayStr, tz } = useToday();

  const goalsOn = useGoalsEnabled();

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  // Only once SETTLED: during the look-only preview (reached by client
  // navigation from `/`) `goals` is cached, and every field here writes.
  const settled = usePlannerSettled();
  const goal = settled ? goals.find((g) => g.id === id) : undefined;

  /**
   * Goals switched off — INERT, and deliberately not the not-found state below.
   *
   * "Goal not found" would be a lie about the data (the goal is right there in
   * the store, untouched) and would teach the user that a link they saved is
   * dead. This says what is actually true and points at the one switch that
   * changes it, which is the whole "extension store" posture: off is a thing
   * you can see and undo, not a thing that vanished. Nothing here reads the
   * goal, so an inert page cannot leak one either.
   */
  if (!goalsOn) {
    return (
      <main
        className="mx-auto flex max-w-lg flex-col items-start gap-4 px-6 py-16"
        data-testid="goal-page-extension-off"
      >
        <h1 className="text-foreground text-lg font-semibold">Goals is switched off</h1>
        <p className="text-muted-foreground text-sm">
          Your goals are still here — switch the extension back on and this page picks up
          where it left off. Nothing was deleted.
        </p>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/extensions/goals">Open the setting</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/">Open dsul</Link>
          </Button>
        </div>
      </main>
    );
  }

  if (!goal) {
    // Same reasoning as the item page: initializeStore stamps userId BEFORE the
    // fetches resolve, so "signed in" alone is not "loaded" — without the
    // settled check a valid deep link flashes not-found for the whole fetch.
    return (
      <main className="mx-auto flex max-w-lg flex-col items-start gap-4 px-6 py-16">
        <h1 className="text-foreground text-lg font-semibold">
          {settled ? 'Goal not found' : 'Loading…'}
        </h1>
        <p className="text-muted-foreground text-sm">
          {settled
            ? 'It may have been deleted, or the link is from another account.'
            : 'If nothing loads, you may need to sign in.'}
        </p>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/">Open dsul</Link>
          </Button>
          {!userId && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/login?redirect=${encodeURIComponent(`/goal/${id ?? ''}`)}`}>
                Sign in
              </Link>
            </Button>
          )}
        </div>
      </main>
    );
  }

  const accent = goal.color ?? accentColorForName(goal.name);
  const checkin = checkinStanding(goal, itemsById, todayStr, tz);

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-8 pt-[max(2rem,env(titlebar-area-height,0px))]">
      <nav className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Link
          href="/"
          className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
        >
          <ChevronLeft className="size-3.5" />
          dsul
        </Link>
        <span>/</span>
        <span className="text-foreground inline-flex items-center gap-1.5 font-medium">
          <Square color={accent} />
          Goal
        </span>
      </nav>

      <header className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {/* The title is a field now; the heading stays for the outline. */}
            <h1 className="sr-only">{goal.name}</h1>
            <TitleRow
              id={goal.id}
              name={goal.name}
              icon={goal.icon}
              label="Goal"
              testPrefix="goal-page"
              size="page"
              onPatch={(patch) => updateGoal(goal.id, patch)}
            />
            {/* The why sits directly under the name and above every number.
                It is the reason a three-year goal survives, and the numbers
                below only mean anything in its light. Buffered, as in the
                pane; emptying it removes it. */}
            <BufferedTextarea
              value={goal.why ?? ''}
              onCommit={(next) => updateGoal(goal.id, { why: next.trim() || undefined })}
              placeholder="Why this matters…"
              ariaLabel="Why this goal matters"
              testId="goal-page-why"
              className="text-muted-foreground focus:text-foreground max-w-prose"
            />
            <div className="flex flex-wrap items-center gap-1.5" data-testid="goal-page-properties">
              {/* setGoalState directly — it stamps achievedAt and its own label. */}
              <ChoiceChip
                label="Status"
                value={goal.state}
                options={GOAL_STATES}
                testIdPrefix="goal-page-state"
                onChange={(state) => setGoalState(goal.id, state)}
              />
              <DateRangeChip
                start={goal.startsOn}
                end={goal.targetOn}
                startLabel="Started"
                endLabel="Target"
                emptyLabel="Target"
                testIdPrefix="goal-page-window"
                onChange={(startsOn, targetOn) => updateGoal(goal.id, { startsOn, targetOn })}
              />
              <ColorChip
                value={goal.color}
                testId="goal-page-color"
                onChange={(color) => updateGoal(goal.id, { color })}
              />
            </div>
          </div>
          {/* Editing lives in one place, and getting there means NAVIGATING
              there: OrganizeConsole is mounted once, in AppShell, which this
              route deliberately does not render — so arming the dialog alone
              set a field nothing here reads. Worse than a no-op, because
              ui-store is a module singleton: the armed dialog survived, and the
              breadcrumb home then sprang the console open unasked. Arm, then
              push, exactly as the settings page does. */}
          <Button
            variant="outline"
            size="sm"
            data-testid="goal-page-organize"
            onClick={() => {
              openDialog({ type: 'organize', section: 'goals', focusId: goal.id });
              router.push('/');
            }}
          >
            <Settings2 className="size-3.5" />
            Organize
          </Button>
        </div>

        {!isGoalActive(goal) && (
          <p
            className="text-muted-foreground bg-muted/50 rounded-md px-3 py-2 text-sm"
            data-testid="goal-page-state"
          >
            {goal.state === 'achieved'
              ? `Achieved${goal.achievedAt ? ` on ${formatShort(goal.achievedAt.slice(0, 10))}` : ''}. Everything below is the record of how it went.`
              : 'Set aside. Its work is untouched — nothing here was cancelled on your behalf.'}
          </p>
        )}

        <GoalSummary goal={goal} itemsById={itemsById} />
      </header>

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
        <div className="flex flex-col gap-8">
          <Section title="Milestones">
            <MilestoneTimeline goal={goal} itemsById={itemsById} />
          </Section>

          <CheckinHistory goal={goal} itemsById={itemsById} />

          <Section title="Supporting work">
            <GoalMemberGroups
              ids={goal.memberIds}
              itemsById={itemsById}
              empty="Nothing else is filed under this goal yet."
            />
          </Section>
        </div>

        <aside className="lg:border-border flex flex-col gap-8 lg:border-l lg:pl-6">
          <Section title="Check-in">
            {checkin.item ? (
              <div className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">{checkin.item.title}</span>
                {/* The one member surface that skipped this, and it is the one
                    that makes a claim about a DATE. A check-in inside a paused
                    routine reads "Due today" while rendering on no column —
                    the exact silent lie the annotation exists to prevent. */}
                <GoalMemberNote item={checkin.item} />
                <span className="text-muted-foreground text-[13px]">
                  {checkin.dueToday
                    ? 'Due today'
                    : checkin.nextDue
                      ? `Next on ${formatShort(checkin.nextDue)}`
                      : 'No upcoming date'}
                </span>
                <span className="text-muted-foreground text-[13px]">
                  {checkin.lastDone
                    ? `Last one ${formatShort(checkin.lastDone)}`
                    : 'No check-ins yet'}
                </span>
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                No check-in yet. A recurring review — weekly is usually right — is what keeps a
                long goal from going quiet for a month at a time.
              </p>
            )}
          </Section>

        </aside>
      </div>
    </main>
  );
}
