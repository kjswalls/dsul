'use client';

import { useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { usePlannerStore } from '@/lib/planner-store';
import { usePlannerSettled } from '@/lib/planner-ready';
import { useOrganizeEnabled } from '@/lib/extension-gates';
import { useOpenConsole } from '@/lib/console-door';
import {
  countLive,
  formatShort,
  parseDay,
  routinePillLabel,
  useLiveItemIds,
  useToday,
} from '@/lib/collections';
import { isPausedOn, isSeasonActiveOn } from '@/lib/active';
import { accentColorForName } from '@/lib/accent-colors';
import { containerMemberIds } from '@/lib/container-schedule';
import { CategoryIcon } from '@/lib/category-icons';
import { RhythmGrid, SeasonHeatmap, WeekProgress, useWeekDotsFor } from '@/components/planner/schedule/schedule-views';
import { ContainerActivity } from '@/components/planner/organize/container-activity';
import { TimeBlockChip } from '@/components/planner/organize/project-time-block';
import { SeasonStateNote } from '@/components/planner/organize/sections/seasons';
import { renameIconKey, takenBy } from '@/components/planner/organize/sections/labels';
import { heldByTrash, useTrashedNames } from '@/components/planner/organize/use-trashed-names';
import { BufferedTextarea, DayChip, TimeChip, TitleRow } from '@/components/planner/organize/detail-parts';
import { ROUTINE_STATES, seasonStates } from '@/components/planner/organize/container-fields';
import { ChoiceChip, ColorChip, DateRangeChip } from '@/components/primitives/organizer-chips';
import { RoutineToday } from '@/components/planner/routine-today';
import { formatCueTime } from '@/lib/reminders/copy';
import type { Item, Season, Project, Routine } from '@/lib/planner-types';

/**
 * A routine's, season's or project's page — the reading surface /goal/[id]
 * already is for goals (Kirby, 2026-09-26). Same posture: a client route,
 * deep-linkable, the store hydrated by the root layout.
 *
 * Its FIELDS edit in place (Kirby, 2026-09-27): the title, the note and every
 * property row are the console pane's own controls — the same store verbs, the
 * same buffering, the same clears — so a page never needs the console to change
 * what the thing is. Membership still lives in the Organize console, reached
 * through the console door (lib/console-door.ts), because the console only
 * exists on `/`.
 *
 * Each page leads with where the container's items land — the schedule charts
 * from components/planner/schedule — and every item row is a link to the item.
 */

export type PageKind = 'routine' | 'season' | 'project';

const SECTION: Record<PageKind, 'routines' | 'seasons' | 'projects'> = {
  routine: 'routines',
  season: 'seasons',
  project: 'projects',
};

const NOUN: Record<PageKind, string> = { routine: 'Routine', season: 'Season', project: 'Project' };

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

/** A linked row in the page's lists — the console's row height and hover. */
const ROW_LINK =
  'hover:bg-accent/60 -mx-2 flex h-9 items-center gap-2.5 rounded-md px-2 text-sm transition-colors';

function Shell({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex max-w-lg flex-col items-start gap-4 px-6 py-16">{children}</main>;
}

export function ContainerPage({ kind, id }: { kind: PageKind; id: string | undefined }) {
  const routines = usePlannerStore((s) => s.routines);
  const seasons = usePlannerStore((s) => s.seasons);
  const projects = usePlannerStore((s) => s.projects);
  const items = usePlannerStore((s) => s.items);
  const userId = usePlannerStore((s) => s.userId);
  const settled = usePlannerSettled();
  const timeFormat = usePlannerStore((s) => s.timeFormat);
  const updateRoutine = usePlannerStore((s) => s.updateRoutine);
  const setRoutinePaused = usePlannerStore((s) => s.setRoutinePaused);
  const updateSeason = usePlannerStore((s) => s.updateSeason);
  const setSeasonState = usePlannerStore((s) => s.setSeasonState);
  const updateProject = usePlannerStore((s) => s.updateProject);
  // Only a project's rename is fenced against the Trash (see labels.tsx) — and
  // the hook costs a fetch, so the other kinds never ask it.
  const trashed = useTrashedNames({ enabled: kind === 'project' });
  const organizeOn = useOrganizeEnabled();
  const openConsole = useOpenConsole();
  const { todayStr, tz } = useToday();
  const liveIds = useLiveItemIds();

  // Only once SETTLED: during the look-only preview (reached by client
  // navigation from `/`) the containers are cached, and the pause and state
  // toggles below write at once.
  const container: Routine | Season | Project | undefined = !settled
    ? undefined
    : kind === 'routine'
      ? routines.find((r) => r.id === id)
      : kind === 'season'
        ? seasons.find((p) => p.id === id)
        : projects.find((p) => p.id === id);

  const memberIds = useMemo(() => {
    if (!container) return [];
    if (kind === 'routine') return containerMemberIds({ kind, routine: container as Routine }, items, routines);
    if (kind === 'season') return containerMemberIds({ kind, season: container as Season }, items, routines);
    return containerMemberIds({ kind, project: container as Project }, items, routines);
  }, [kind, container, items, routines]);
  const members = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    return memberIds.map((m) => byId.get(m)).filter((i): i is Item => !!i);
  }, [memberIds, items]);
  const week = useWeekDotsFor(memberIds, undefined, kind === 'project' && container ? { block: container as Project } : undefined);

  // Routines and seasons live behind the Organize extension, as their console
  // sections do. Off is INERT, not "not found" — the /goal page's reasoning.
  if (kind !== 'project' && !organizeOn) {
    return (
      <Shell>
        <h1 className="text-foreground text-lg font-semibold">Organize is switched off</h1>
        <p className="text-muted-foreground text-sm" data-testid="container-page-extension-off">
          Your routines and seasons are still here. Switch the extension back on and this page
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
    // "loaded" — without the settled check a valid link flashes not-found.
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
  const icon = kind === 'project' ? (container as Project).emoji : (container as Routine | Season).icon;
  const accent = container.color ?? accentColorForName(name);

  const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  // The properties column: what the thing IS, as label/value rows (Linear's
  // sidebar). Each settable value is the console pane's own chip, so it edits
  // — and clears — in place; counts and sentences stay read-only.
  const props: { label: string; value: ReactNode }[] = [];
  let notes: string | undefined;
  let saveNotes: (next: string | undefined) => void;
  let saveColor: (color: string | undefined) => void;
  if (kind === 'routine') {
    const routine = container as Routine;
    notes = routine.notes;
    saveNotes = (next) => updateRoutine(routine.id, { notes: next });
    saveColor = (color) => updateRoutine(routine.id, { color });
    const holders = seasons.filter((p) => p.routineIds.includes(routine.id));
    const paused = isPausedOn(routine, todayStr, tz);
    // Its own switch is on and a season is holding it off — the chip writes
    // LOCAL (the value it owns), so the pill says what that is achieving.
    const held = !paused ? routinePillLabel(routine, todayStr, tz, seasons) : null;
    // pausedUntil is EXCLUSIVE, so the resume picker's floor is tomorrow.
    const today = parseDay(todayStr)!;
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 12);
    props.push({
      label: 'Status',
      value: (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {/* setRoutinePaused directly, as the console pane does — it stamps
              its own history label. */}
          <ChoiceChip
            label="Status"
            value={paused ? 'paused' : 'active'}
            options={ROUTINE_STATES}
            testIdPrefix="container-page-routine-state"
            onChange={(next) => setRoutinePaused(routine.id, next === 'paused')}
          />
          {held && <span className="text-muted-foreground text-xs">{held}</span>}
        </span>
      ),
    });
    if (paused) {
      props.push({
        label: 'Comes back',
        value: (
          <DayChip
            label="Comes back"
            keyed={false}
            value={routine.pausedUntil}
            testId="container-page-routine-resume"
            clearLabel="Clear resume date"
            disabledDays={{ before: tomorrow }}
            // `?? null`: clearing the date is a request; undefined is a no-op.
            onChange={(next) => setRoutinePaused(routine.id, true, next ?? null)}
          />
        ),
      });
    }
    props.push({
      label: 'Usually at',
      value: (
        <TimeChip
          label="Usually at"
          keyed={false}
          value={routine.usualTime}
          display={routine.usualTime ? formatCueTime(routine.usualTime, timeFormat) : undefined}
          testId="container-page-routine-usual-time"
          clearLabel="Clear time"
          onChange={(usualTime) => updateRoutine(routine.id, { usualTime })}
        />
      ),
    });
    props.push({ label: 'Items', value: plural(countLive(routine.itemIds, liveIds), 'item') });
    if (holders.length) props.push({ label: holders.length === 1 ? 'Season' : 'Seasons', value: holders.map((p) => p.name).join(', ') });
  } else if (kind === 'season') {
    const season = container as Season;
    notes = season.notes;
    saveNotes = (next) => updateSeason(season.id, { notes: next });
    saveColor = (color) => updateSeason(season.id, { color });
    const live = isSeasonActiveOn(season, todayStr);
    props.push({
      label: 'Status',
      value: (
        <ChoiceChip
          label="Status"
          value={season.state}
          options={seasonStates(live)}
          testIdPrefix="container-page-season-state"
          onChange={(state) => setSeasonState(season.id, state)}
        />
      ),
    });
    // Under Dates alone, as in the pane: On and Off always win, so a range
    // beside them would be a control with no effect.
    if (season.state === 'auto') {
      props.push({
        label: 'Runs',
        value: (
          <DateRangeChip
            start={season.startsOn}
            end={season.endsOn}
            startLabel="Starts"
            endLabel="Ends"
            emptyLabel="Runs"
            testIdPrefix="container-page-season-runs"
            onChange={(startsOn, endsOn) => updateSeason(season.id, { startsOn, endsOn })}
          />
        ),
      });
    }
    props.push({ label: 'Routines', value: plural(season.routineIds.length, 'routine') });
    // The console pane's own sentence, so the two surfaces cannot disagree.
    props.push({ label: 'Schedule', value: <span className="text-xs"><SeasonStateNote season={season} live={live} /></span> });
  } else {
    const project = container as Project;
    notes = project.notes;
    saveNotes = (next) => updateProject(project.id, { notes: next });
    saveColor = (color) => updateProject(project.id, { color });
    // Live items, as the routine counts them — not finished one-offs.
    props.push({ label: 'Items', value: plural(countLive(memberIds, liveIds), 'item') });
    props.push({ label: 'Time block', value: <TimeBlockChip project={project} /> });
  }
  props.push({
    label: 'Color',
    value: <ColorChip value={container.color} testId={`container-page-color`} onChange={saveColor} />,
  });

  // The rename, per kind — a project's goes through the pane's collision fence
  // and its emoji column, the others patch straight through.
  const title =
    kind === 'project' ? (
      <TitleRow
        id={container.id}
        name={name}
        icon={icon}
        label="Project"
        testPrefix="container-page"
        size="page"
        validate={(next) =>
          takenBy(projects, container.id, next, 'project') ?? heldByTrash(trashed.projects, next, 'project')
        }
        onPatch={(patch) =>
          updateProject(container.id, {
            ...renameIconKey(patch, 'emoji'),
            ...('name' in patch && { name: patch.name }),
          })
        }
      />
    ) : (
      <TitleRow
        id={container.id}
        name={name}
        icon={icon}
        label={NOUN[kind]}
        testPrefix="container-page"
        size="page"
        onPatch={(patch) =>
          kind === 'routine' ? updateRoutine(container.id, patch) : updateSeason(container.id, patch)
        }
      />
    );
  const totals = week.weekTotals(memberIds);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-8 pt-[max(2rem,env(titlebar-area-height,0px))]" data-testid={`${kind}-page`}>
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
            {/* The title is a field now; the heading stays for the outline. */}
            <h1 className="sr-only">{name}</h1>
            {title}
            {/* Buffered — committed on blur, one undo per edit, as in the pane.
                Emptying it removes the note. */}
            <BufferedTextarea
              value={notes ?? ''}
              onCommit={(next) => saveNotes(next.trim() || undefined)}
              placeholder="Add a note…"
              ariaLabel={`${NOUN[kind]} note`}
              testId="container-page-notes"
              className="text-muted-foreground focus:text-foreground"
            />
          </header>

          {/* A routine leads with today, in its order — the page is where you run
              it from (⌘K "Run …" lands here). The Rhythm below is the week. */}
          {kind === 'routine' && (
            <Section title="Today" testId="container-page-today">
              <RoutineToday routine={container as Routine} />
            </Section>
          )}

          {kind === 'season' && (
            <Section title="Calendar" testId="container-page-calendar">
              <SeasonHeatmap season={container as Season} memberIds={memberIds} />
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

          {kind === 'season' && (container as Season).routineIds.length > 0 && (
            <Section title="Routines">
              <ul className="flex flex-col">
                {(container as Season).routineIds
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
              {seasons.some((p) => p.routineIds.includes(container.id)) ? (
                <ul className="flex flex-col">
                  {seasons
                    .filter((p) => p.routineIds.includes(container.id))
                    .map((p) => (
                      <li key={p.id}>
                        <Link href={`/season/${p.id}`} className={ROW_LINK}>
                          <CategoryIcon glyph={p.icon} name={p.name} className="size-3.5" />
                          <span className="min-w-0 flex-1 truncate">{p.name}</span>
                          <span className="text-muted-foreground text-xs">
                            {isSeasonActiveOn(p, todayStr) ? 'on' : `off${p.startsOn && p.startsOn > todayStr ? ` until ${formatShort(p.startsOn)}` : ''}`}
                          </span>
                        </Link>
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="text-muted-foreground text-sm">No season. It answers for itself.</p>
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
                <div key={p.label} className="grid min-h-8 grid-cols-[84px_minmax(0,1fr)] items-center gap-2 py-1 text-sm">
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
