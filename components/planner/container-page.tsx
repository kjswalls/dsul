'use client';

import { useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { usePlannerStore } from '@/lib/planner-store';
import { useOrganizeEnabled } from '@/lib/extension-gates';
import { useOpenConsole } from '@/lib/console-door';
import {
  countLive,
  formatShort,
  programPillLabel,
  routinePillLabel,
  useLiveItemIds,
  useToday,
} from '@/lib/collections';
import { isProgramActiveOn } from '@/lib/active';
import { accentColorForName } from '@/lib/accent-colors';
import { containerMemberIds } from '@/lib/container-schedule';
import { CategoryIcon } from '@/lib/category-icons';
import { RhythmGrid, SeasonHeatmap, WeekProgress, useWeekDotsFor } from '@/components/planner/schedule/schedule-views';
import { ContainerActivity } from '@/components/planner/organize/container-activity';
import { timeBlockSummary } from '@/components/planner/organize/project-time-block';
import { ProgramStateNote } from '@/components/planner/organize/sections/programs';
import type { Item, Program, Project, Routine } from '@/lib/planner-types';

/**
 * A routine's, program's or project's page — the reading surface /goal/[id]
 * already is for goals (Kirby, 2026-09-26). Same posture: a client route,
 * deep-linkable, the store hydrated by the root layout; editing stays in the
 * Organize console, reached through the console door (lib/console-door.ts),
 * because the console only exists on `/`.
 *
 * Each page leads with where the container's items land — the schedule charts
 * from components/planner/schedule — and every item row is a link to the item.
 */

export type PageKind = 'routine' | 'program' | 'project';

const SECTION: Record<PageKind, 'routines' | 'programs' | 'projects'> = {
  routine: 'routines',
  program: 'programs',
  project: 'projects',
};

const NOUN: Record<PageKind, string> = { routine: 'Routine', program: 'Program', project: 'Project' };

function Square({ color }: { color: string }) {
  return <span className="inline-block size-[9px] shrink-0 rounded-[3px]" style={{ background: color }} aria-hidden />;
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-3" data-testid={testId}>
      <h2 className="text-muted-foreground text-xs font-medium">{title}</h2>
      {children}
    </section>
  );
}

/** Lime only when live; anything else is a quiet ring, never a warning. */
function StatusValue({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn('size-2 shrink-0 rounded-full', on ? 'bg-primary' : 'border-muted-foreground/60 border-[1.5px]')}
        aria-hidden
      />
      {children}
    </span>
  );
}

/** A linked row in the page's lists — the console's row height and hover. */
const ROW_LINK =
  'hover:bg-accent/60 -mx-2 flex h-9 items-center gap-2.5 rounded-md px-2 text-sm transition-colors';

function Shell({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex max-w-lg flex-col items-start gap-4 px-6 py-16">{children}</main>;
}

export function ContainerPage({ kind, id }: { kind: PageKind; id: string | undefined }) {
  const routines = usePlannerStore((s) => s.routines);
  const programs = usePlannerStore((s) => s.programs);
  const projects = usePlannerStore((s) => s.projects);
  const items = usePlannerStore((s) => s.items);
  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const organizeOn = useOrganizeEnabled();
  const openConsole = useOpenConsole();
  const { todayStr, tz } = useToday();
  const liveIds = useLiveItemIds();

  const container: Routine | Program | Project | undefined =
    kind === 'routine'
      ? routines.find((r) => r.id === id)
      : kind === 'program'
        ? programs.find((p) => p.id === id)
        : projects.find((p) => p.id === id);

  const memberIds = useMemo(() => {
    if (!container) return [];
    if (kind === 'routine') return containerMemberIds({ kind, routine: container as Routine }, items, routines);
    if (kind === 'program') return containerMemberIds({ kind, program: container as Program }, items, routines);
    return containerMemberIds({ kind, project: container as Project }, items, routines);
  }, [kind, container, items, routines]);
  const members = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    return memberIds.map((m) => byId.get(m)).filter((i): i is Item => !!i);
  }, [memberIds, items]);
  const week = useWeekDotsFor(memberIds, undefined, kind === 'project' && container ? { block: container as Project } : undefined);

  // Routines and programs live behind the Organize extension, as their console
  // sections do. Off is INERT, not "not found" — the /goal page's reasoning.
  if (kind !== 'project' && !organizeOn) {
    return (
      <Shell>
        <h1 className="text-foreground text-lg font-semibold">Organize is switched off</h1>
        <p className="text-muted-foreground text-sm" data-testid="container-page-extension-off">
          Your routines and programs are still here — switch the extension back on and this page
          picks up where it left off. Nothing was deleted.
        </p>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/extensions/organize">Open the setting</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/">Open dsul</Link>
          </Button>
        </div>
      </Shell>
    );
  }

  if (!container) {
    // userId is stamped before the fetches resolve, so "signed in" is not
    // "loaded" — without isLoading a valid link flashes not-found.
    const settled = !!userId && !isLoading;
    return (
      <Shell>
        <h1 className="text-foreground text-lg font-semibold" data-testid="container-page-missing">
          {settled ? `${NOUN[kind]} not found` : 'Loading…'}
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
              <Link href={`/login?redirect=${encodeURIComponent(`/${kind}/${id ?? ''}`)}`}>Sign in</Link>
            </Button>
          )}
        </div>
      </Shell>
    );
  }

  const name = container.name;
  const icon = kind === 'project' ? (container as Project).emoji : (container as Routine | Program).icon;
  const accent = container.color ?? accentColorForName(name);

  const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  // The properties column: what the thing IS, as label/value rows (Linear's
  // sidebar). Read-only on purpose — editing lives in the console.
  const props: { label: string; value: ReactNode }[] = [];
  let notes: string | undefined;
  if (kind === 'routine') {
    const routine = container as Routine;
    notes = routine.notes;
    const holders = programs.filter((p) => p.routineIds.includes(routine.id));
    const pill = routinePillLabel(routine, todayStr, tz, programs);
    props.push({ label: 'Status', value: <StatusValue on={!pill}>{pill ?? 'Active'}</StatusValue> });
    props.push({ label: 'Items', value: plural(countLive(routine.itemIds, liveIds), 'item') });
    if (holders.length) props.push({ label: holders.length === 1 ? 'Program' : 'Programs', value: holders.map((p) => p.name).join(', ') });
  } else if (kind === 'program') {
    const program = container as Program;
    notes = program.notes;
    props.push({ label: 'Status', value: <StatusValue on={isProgramActiveOn(program, todayStr)}>{programPillLabel(program, todayStr) ?? 'On'}</StatusValue> });
    props.push({ label: 'Routines', value: plural(program.routineIds.length, 'routine') });
    // The console pane's own sentence, so the two surfaces cannot disagree.
    props.push({ label: 'Season', value: <ProgramStateNote program={program} live={isProgramActiveOn(program, todayStr)} /> });
  } else {
    const project = container as Project;
    notes = project.notes;
    // Live items, as the routine counts them — not finished one-offs.
    props.push({ label: 'Items', value: plural(countLive(memberIds, liveIds), 'item') });
    const block = timeBlockSummary(project);
    if (block) props.push({ label: 'Time block', value: block });
  }
  props.push({
    label: 'Color',
    value: (
      <span className="inline-flex items-center gap-1.5">
        <Square color={accent} />
        {container.color ? 'Set' : 'Automatic'}
      </span>
    ),
  });
  const totals = week.weekTotals(memberIds);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-8" data-testid={`${kind}-page`}>
      <div className="flex items-center justify-between gap-4">
        <nav className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
          <Link href="/" className="hover:text-foreground inline-flex items-center gap-1 transition-colors">
            <ChevronLeft className="size-3.5" />
            dsul
          </Link>
          <span aria-hidden>›</span>
          <span>{NOUN[kind]}s</span>
          <span aria-hidden>›</span>
          <span className="text-foreground inline-flex min-w-0 items-center gap-1.5 font-medium">
            <Square color={accent} />
            <span className="truncate">{name}</span>
          </span>
        </nav>
        {organizeOn && (
          <Button
            variant="ghost"
            size="sm"
            data-testid="container-page-organize"
            onClick={() => openConsole({ section: SECTION[kind], focusId: container.id })}
          >
            <Settings2 className="size-3.5" />
            Edit in Organize
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-10 md:grid-cols-[minmax(0,1fr)_240px]">
        <div className="flex min-w-0 flex-col gap-8">
          <header className="flex flex-col gap-2">
            <h1 className="text-foreground inline-flex items-center gap-2.5 text-2xl font-semibold tracking-[-0.01em] text-balance">
              <CategoryIcon glyph={icon} name={name} className="size-5" />
              {name}
            </h1>
            {notes?.trim() && (
              <p className="text-muted-foreground text-sm whitespace-pre-line" data-testid="container-page-notes">
                {notes}
              </p>
            )}
          </header>

          {kind === 'program' && (
            <Section title="Season" testId="container-page-season">
              <SeasonHeatmap program={container as Program} memberIds={memberIds} />
            </Section>
          )}

          {/* The grid carries its own "Rhythm" heading and controls. */}
          {members.length === 0 ? (
            <Section title="Rhythm">
              <p className="text-muted-foreground text-sm">
                Nothing is in it yet. Link items from the Organize console.
              </p>
            </Section>
          ) : (
            <RhythmGrid
              members={members}
              block={kind === 'project' ? (container as Project) : undefined}
              onlyActive={kind === 'project'}
              linkItems
              testId="container-page-rhythm"
            />
          )}

          {kind === 'program' && (container as Program).routineIds.length > 0 && (
            <Section title="Routines">
              <ul className="flex flex-col">
                {(container as Program).routineIds
                  .map((rid) => routines.find((r) => r.id === rid))
                  .filter((r): r is Routine => !!r)
                  .map((r) => (
                    <li key={r.id}>
                      <Link href={`/routine/${r.id}`} className={ROW_LINK}>
                        <CategoryIcon glyph={r.icon} name={r.name} className="size-3.5" />
                        <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        <span className="text-muted-foreground text-xs">{plural(countLive(r.itemIds, liveIds), 'item')}</span>
                      </Link>
                    </li>
                  ))}
              </ul>
            </Section>
          )}

          {kind === 'routine' && (
            <Section title="Held by">
              {programs.some((p) => p.routineIds.includes(container.id)) ? (
                <ul className="flex flex-col">
                  {programs
                    .filter((p) => p.routineIds.includes(container.id))
                    .map((p) => (
                      <li key={p.id}>
                        <Link href={`/program/${p.id}`} className={ROW_LINK}>
                          <CategoryIcon glyph={p.icon} name={p.name} className="size-3.5" />
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          <span className="text-muted-foreground text-xs">
                            {isProgramActiveOn(p, todayStr) ? 'on' : `off${p.startsOn && p.startsOn > todayStr ? ` until ${formatShort(p.startsOn)}` : ''}`}
                          </span>
                        </Link>
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="text-muted-foreground text-sm">No program — it answers for itself.</p>
              )}
            </Section>
          )}

          <ContainerActivity members={members} testId="container-page-activity" />
        </div>

        <aside
          className="flex min-w-0 flex-col gap-6 md:border-l md:border-border/60 md:pl-6"
          aria-label="Properties"
          data-testid="container-page-summary"
        >
          <div className="flex flex-col">
            <p className="text-muted-foreground mb-1 text-xs font-medium">Properties</p>
            <dl className="flex flex-col">
              {props.map((p) => (
                <div key={p.label} className="grid min-h-8 grid-cols-[84px_minmax(0,1fr)] items-baseline gap-2 py-1 text-sm">
                  <dt className="text-muted-foreground text-xs">{p.label}</dt>
                  <dd className="text-foreground/90 min-w-0">{p.value}</dd>
                </div>
              ))}
            </dl>
          </div>
          {totals.total > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-muted-foreground text-xs font-medium">Progress</p>
              <WeekProgress totals={totals} testId="container-page-progress" />
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
