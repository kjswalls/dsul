'use client';

import { useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { RhythmGrid, SeasonHeatmap } from '@/components/planner/schedule/schedule-views';
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
      <h2 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">{title}</h2>
      {children}
    </section>
  );
}

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
  let status: string | null = null;
  let summary: ReactNode;
  if (kind === 'routine') {
    const routine = container as Routine;
    status = routinePillLabel(routine, todayStr, tz, programs) ?? 'Active';
    const holders = programs.filter((p) => p.routineIds.includes(routine.id));
    summary =
      plural(countLive(routine.itemIds, liveIds), 'item') +
      (holders.length ? ` · held by ${holders.map((p) => p.name).join(', ')}` : '');
  } else if (kind === 'program') {
    const program = container as Program;
    status = programPillLabel(program, todayStr) ?? 'On';
    // The console pane's own sentence, so the two surfaces cannot disagree.
    summary = <ProgramStateNote program={program} live={isProgramActiveOn(program, todayStr)} />;
  } else {
    const project = container as Project;
    // Live items, as the routine counts them — not finished one-offs.
    summary =
      plural(countLive(memberIds, liveIds), 'item') +
      (project.startTime && project.repeatFrequency ? ` · a time block at ${project.startTime}` : '');
  }

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-8" data-testid={`${kind}-page`}>
      <nav className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Link href="/" className="hover:text-foreground inline-flex items-center gap-1 transition-colors">
          <ChevronLeft className="size-3.5" />
          dsul
        </Link>
        <span>/</span>
        <span className="text-foreground inline-flex items-center gap-1.5 font-medium">
          <Square color={accent} />
          {NOUN[kind]}
        </span>
      </nav>

      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-foreground inline-flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-balance">
            <CategoryIcon glyph={icon} name={name} className="size-5" />
            {name}
          </h1>
          <p className="text-muted-foreground text-sm" data-testid="container-page-summary">
            {status && (
              <span className="bg-muted text-foreground mr-2 rounded-full px-2 py-0.5 text-[11px]">{status}</span>
            )}
            {summary}
          </p>
        </div>
        {organizeOn && (
          <Button
            variant="outline"
            size="sm"
            data-testid="container-page-organize"
            onClick={() => openConsole({ section: SECTION[kind], focusId: container.id })}
          >
            <Settings2 className="size-3.5" />
            Organize
          </Button>
        )}
      </header>

      {kind === 'program' && (
        <Section title="Season" testId="container-page-season">
          <SeasonHeatmap program={container as Program} memberIds={memberIds} />
        </Section>
      )}

      <Section title={kind === 'program' ? 'Week by week' : 'Rhythm'}>
        {members.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing is in it yet. Link items from the Organize console.
          </p>
        ) : (
          <RhythmGrid
            members={members}
            block={kind === 'project' ? (container as Project) : undefined}
            onlyActive={kind === 'project'}
            linkItems
            testId="container-page-rhythm"
          />
        )}
      </Section>

      {kind === 'program' && (container as Program).routineIds.length > 0 && (
        <Section title="Routines">
          <ul className="flex flex-col gap-1.5">
            {(container as Program).routineIds
              .map((rid) => routines.find((r) => r.id === rid))
              .filter((r): r is Routine => !!r)
              .map((r) => (
                <li key={r.id}>
                  <Link href={`/routine/${r.id}`} className="hover:text-foreground inline-flex items-center gap-2 text-sm">
                    <CategoryIcon glyph={r.icon} name={r.name} className="size-3.5" />
                    {r.name}
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
            <ul className="flex flex-col gap-1.5">
              {programs
                .filter((p) => p.routineIds.includes(container.id))
                .map((p) => (
                  <li key={p.id}>
                    <Link href={`/program/${p.id}`} className="hover:text-foreground inline-flex items-center gap-2 text-sm">
                      <CategoryIcon glyph={p.icon} name={p.name} className="size-3.5" />
                      {p.name}
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
    </main>
  );
}
