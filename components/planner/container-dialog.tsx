'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  ResponsiveModalDescription,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal';
import { IconPicker } from '@/components/primitives/icon-picker';
import { PropertyChip } from '@/components/primitives/property-chip';
import { ColorChip, DateRangeChip } from '@/components/primitives/organizer-chips';
import {
  ADD_MODAL_CLASS,
  EnterHint,
  NewTypeMenu,
  ORGANIZER_SECTION,
  SERIF_NOTES_CLASS,
  SERIF_TITLE_CLASS,
  SurfaceA11yHeader,
  SurfaceContent,
  SurfaceRoot,
  OrganizerGlyph,
} from '@/components/planner/surface';
import { heldByTrash, useTrashedNames } from '@/components/planner/organize/use-trashed-names';
import { useIsMobile } from '@/hooks/use-mobile';
import { usePlannerStore } from '@/lib/planner-store';
import { useOrganizeEnabled } from '@/lib/extension-gates';
import { useOpenConsole } from '@/lib/console-door';
import { CONTAINER_KINDS, sameContainerName } from '@/lib/container-registry';
import { formatShort, useToday } from '@/lib/collections';
import { makeIconToken } from '@/lib/category-icons';
import { openAddDialog, openNewContainer, type NewContainerKind } from '@/lib/ui-store';

/**
 * The "new" dialog, making an organizer — a goal, routine, program or project —
 * instead of an item (Kirby, 2026-09-25).
 *
 * The SAME dialog to the eye: ItemDialog's shell, add-modal geometry, Zone-0
 * type chip (whose menu is shared, see NewTypeMenu), serif title, chip row,
 * serif notes and ↵ footer, all from ./surface. A separate component to the
 * code, because everything ItemDialog does below the title is item-shaped —
 * per-type drafts, getItemTypeConfig (which would quietly synthesize a custom
 * type called "goal"), the property chips, the save adapters. A container kind
 * never reaches any of it; this body is its sibling, not a branch inside it.
 *
 * One create call per kind, with everything the dialog asked for in it, so the
 * arrival is one ⌘Z. After ↵ the dialog closes and a toast offers "Open";
 * "Add & open" closes FIRST and then opens the console on the new object —
 * never a dialog stacked on a dialog (the single slot would swap anyway, but
 * closing first keeps the order honest for the console's own guard).
 */

export interface ContainerDialogState {
  kind: NewContainerKind;
  title?: string;
  notes?: string;
}

/** See ItemDialog's CLOSE_ANIMATION_GRACE_MS — the same exit, the same grace. */
const CLOSE_ANIMATION_GRACE_MS = 600;

/** The glyph a new one starts with — the console's CreateForm defaults. */
const DEFAULT_ICON: Record<NewContainerKind, string | undefined> = {
  goal: makeIconToken('Target'),
  routine: makeIconToken('Repeat'),
  program: makeIconToken('CalendarRange'),
  // None: create.project's rule — resolveCategoryIcon derives one from the name
  // ("Gym" → dumbbell), where a fixed token would give every project the same
  // wrong icon.
  project: undefined,
};

/**
 * Thin permanent wrapper, ItemDialog's pattern: the body mounts on open and
 * lingers through the exit animation on the latched payload, so a closed
 * dialog costs no store subscription.
 *
 * `useOpenConsole` is called HERE, not in the body, because the toast's "Open"
 * fires after the body has unmounted.
 */
export function ContainerDialog({
  state,
  onOpenChange,
}: {
  /** null = closed. Referentially stable per open (the ui-store slot itself). */
  state: ContainerDialogState | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [present, setPresent] = useState(!!state);
  if (state && !present) setPresent(true);
  const isMobile = useIsMobile();
  const openConsole = useOpenConsole();

  // A new payload — a fresh open, or the type menu switching kind — remounts
  // the form (via `seq`) without remounting the modal around it.
  const [last, setLast] = useState<ContainerDialogState | null>(state);
  const [seq, setSeq] = useState(0);
  if (state && state !== last) {
    setLast(state);
    setSeq((n) => n + 1);
  }

  useEffect(() => {
    if (state || !present) return;
    const t = setTimeout(() => setPresent(false), CLOSE_ANIMATION_GRACE_MS);
    return () => clearTimeout(t);
  }, [state, present]);

  if (!present || !last) return null;
  const open = !!state;
  const { label } = CONTAINER_KINDS[last.kind];

  return (
    <SurfaceRoot panel={false} open={open} onOpenChange={onOpenChange} isMobile={isMobile}>
      <SurfaceContent
        panel={false}
        open={open}
        flat={false}
        panelLabel={`New ${label.toLowerCase()}`}
        data-testid="container-dialog"
        data-kind={last.kind}
        className={ADD_MODAL_CLASS}
      >
        <SurfaceA11yHeader panel={false}>
          <ResponsiveModalTitle>New {label.toLowerCase()}</ResponsiveModalTitle>
          <ResponsiveModalDescription>
            Add a new {label.toLowerCase()} to organize your planner.
          </ResponsiveModalDescription>
        </SurfaceA11yHeader>
        <ContainerForm
          key={seq}
          payload={last}
          isMobile={isMobile}
          close={() => onOpenChange(false)}
          openConsole={openConsole}
        />
      </SurfaceContent>
    </SurfaceRoot>
  );
}

/**
 * What a program's dates will do, in words — the Runs chip alone doesn't say
 * that a new program is `auto` and switches ITSELF. Inclusive at both ends, as
 * isProgramActiveOn (lib/active.ts) reads them; no dates means "on every day",
 * which needs no sentence.
 */
export function programRunsCopy(
  startsOn: string | undefined,
  endsOn: string | undefined,
  todayStr: string,
): string | null {
  if (endsOn && endsOn < todayStr) return 'Its dates are already over, so it starts switched off.';
  const startsLater = !!startsOn && startsOn > todayStr;
  if (startsLater && endsOn) {
    return `It switches on by itself on ${formatShort(startsOn!)} and off after ${formatShort(endsOn)}.`;
  }
  if (startsLater) return `It switches on by itself on ${formatShort(startsOn!)}.`;
  if (endsOn) return `It's on now, and switches off by itself after ${formatShort(endsOn)}.`;
  return null;
}

function ContainerForm({
  payload,
  isMobile,
  close,
  openConsole,
}: {
  payload: ContainerDialogState;
  isMobile: boolean;
  close: () => void;
  openConsole: ReturnType<typeof useOpenConsole>;
}) {
  const { kind } = payload;
  const config = CONTAINER_KINDS[kind];
  const noun = config.label.toLowerCase();

  const userId = usePlannerStore((s) => s.userId);
  const isLoading = usePlannerStore((s) => s.isLoading);
  const goalsAvailable = usePlannerStore((s) => s.goalsAvailable);
  const collectionsAvailable = usePlannerStore((s) => s.collectionsAvailable);
  const projects = usePlannerStore((s) => s.projects);
  const addGoal = usePlannerStore((s) => s.addGoal);
  const addRoutine = usePlannerStore((s) => s.addRoutine);
  const addProgram = usePlannerStore((s) => s.addProgram);
  const addProject = usePlannerStore((s) => s.addProject);
  const organizeOn = useOrganizeEnabled();
  const { todayStr } = useToday();
  // Only a project name can be held by the bin (projects_user_id_name_key is
  // the one plain unique index), so only the project body asks.
  const trashed = useTrashedNames({ enabled: kind === 'project' });

  const [name, setName] = useState(payload.title ?? '');
  const [icon, setIcon] = useState<string | undefined>(DEFAULT_ICON[kind]);
  const [color, setColor] = useState<string | undefined>(undefined);
  // A goal's window opens today unless told otherwise — the mockup's
  // "Window Today → …", waiting on a target. A program's dates are both
  // optional: undated, it is simply on.
  const [startsOn, setStartsOn] = useState<string | undefined>(kind === 'goal' ? todayStr : undefined);
  const [endsOn, setEndsOn] = useState<string | undefined>(undefined);
  // Notes become the goal's why. The other kinds have no free-text field, so a
  // note carried over from a task is dropped for them rather than invented a home.
  const [why, setWhy] = useState(payload.notes ?? '');

  const trimmed = name.trim();

  /**
   * Why the button waits, or null. The same guards the console's create rows
   * answer to: a table that isn't there, and the load window — creating before
   * initializeStore's fetch lands lets its set() overwrite the row just made
   * while the INSERT usually succeeds, so the user makes it again and owns two.
   * Then the project's name rules, because addProject refuses a case-folded
   * duplicate silently, and a name the bin holds fails its insert a round trip
   * later (see useTrashedNames).
   */
  const problem: string | null = (() => {
    if (kind === 'goal' && !goalsAvailable) return 'Goals aren’t available on this account yet.';
    if ((kind === 'routine' || kind === 'program') && !collectionsAvailable) {
      return 'Routines and programs aren’t available on this account yet.';
    }
    if (!userId) return `Sign in to add a ${noun}.`;
    if (isLoading) return 'Still loading your planner…';
    if (kind === 'project' && trimmed) {
      const clash = projects.find((p) => sameContainerName('project', p.name, trimmed));
      if (clash) return `You already have a ${noun} called ${clash.name}.`;
      return heldByTrash(trashed.projects, trimmed, noun);
    }
    return null;
  })();
  const canAdd = !!trimmed && !problem;
  // A project is openable only where its console section exists.
  const canOpen = kind !== 'project' || organizeOn;

  const create = (): string | null => {
    switch (kind) {
      case 'goal':
        return addGoal({
          name: trimmed,
          icon,
          color,
          why: why.trim() || undefined,
          startsOn,
          targetOn: endsOn,
          state: 'active',
          memberIds: [],
          milestoneIds: [],
          checkinIds: [],
        });
      case 'routine':
        return addRoutine({ name: trimmed, icon, color, itemIds: [] });
      case 'program':
        // 'auto', as the console makes them: the Runs dates ARE the switch.
        return addProgram({
          name: trimmed,
          icon,
          color,
          state: 'auto',
          startsOn,
          endsOn,
          itemIds: [],
          routineIds: [],
        });
      case 'project':
        return addProject(trimmed, icon ?? '', color ? { color } : undefined);
    }
  };

  const submit = (andOpen = false) => {
    if (!canAdd) return;
    const id = create();
    if (!id) return;
    const target = { section: ORGANIZER_SECTION[kind], focusId: id };
    // Closed first either way: the console door swaps the single slot, and a
    // close landing after it would shut the console it just opened.
    close();
    if (andOpen && canOpen) {
      openConsole(target);
      return;
    }
    toast(`${config.label} added`, {
      description: trimmed,
      action: canOpen ? { label: 'Open', onClick: () => openConsole(target) } : undefined,
    });
  };

  // Notes grow from one line, as ItemDialog's do.
  const whyRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const ta = whyRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [why]);

  let chips: ReactNode = null;
  if (kind === 'goal') {
    chips = (
      <DateRangeChip
        label="Window"
        start={startsOn}
        end={endsOn}
        onChange={(s, e) => {
          setStartsOn(s);
          setEndsOn(e);
        }}
        startLabel="Started"
        endLabel="Target"
        emptyLabel="Target"
        testIdPrefix="goal-dialog-window"
      />
    );
  } else if (kind === 'program') {
    chips = (
      <DateRangeChip
        label="Runs"
        start={startsOn}
        end={endsOn}
        onChange={(s, e) => {
          setStartsOn(s);
          setEndsOn(e);
        }}
        startLabel="Starts"
        endLabel="Ends"
        emptyLabel="Runs"
        testIdPrefix="program-dialog-runs"
      />
    );
  }
  const runsCopy = kind === 'program' ? programRunsCopy(startsOn, endsOn, todayStr) : null;

  return (
    <div
      className="flex flex-col gap-4"
      onKeyDown={(e) => {
        // ItemDialog's Enter rule, plus one clause: the event must come from
        // inside this dialog's own DOM. The IconPicker's search field is
        // portalled, and its Enter bubbles here through React's tree.
        const target = e.target as HTMLElement;
        if (
          e.key === 'Enter' &&
          !e.shiftKey &&
          !e.defaultPrevented &&
          e.currentTarget.contains(target) &&
          !target.closest('[data-sub-input]') &&
          !target.closest('button')
        ) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="flex flex-col gap-3">
        {/* Zone 0 — the same type chip as ItemDialog's, wearing the kind's
            glyph; its menu can switch back to any item type. pr-8 clears
            Radix's close X on desktop, as there. */}
        <div className={isMobile ? 'flex items-center gap-2' : 'flex items-center gap-2 pr-8'}>
          <PropertyChip
            glyph={<OrganizerGlyph kind={kind} className="size-3" />}
            label={config.label}
            value={config.label}
            testId="container-dialog-type-chip"
            alwaysChevron
            className="font-medium"
            contentClassName="w-60"
          >
            {(closeMenu) => (
              <NewTypeMenu
                active={`container:${kind}`}
                showOrganizers
                // The title travels back; the why does not, by the spec — the
                // add slot seeds a title only, and a goal's reason is not an
                // item's notes. What's lost is one sentence the user just wrote
                // for a different kind of thing.
                onPickType={(type) => openAddDialog(type, undefined, undefined, trimmed || undefined)}
                onPickOrganizer={(next) => {
                  if (next !== kind) openNewContainer(next, trimmed || undefined, why.trim() || undefined);
                }}
                close={closeMenu}
              />
            )}
          </PropertyChip>
        </div>
        {/* Zone 1 — icon + the serif title. */}
        <div className="flex items-center gap-2.5">
          <IconPicker value={icon} name={trimmed} onSelect={setIcon} className="size-[30px]" />
          <Input
            autoFocus
            data-testid={`${kind}-dialog-name`}
            placeholder={`Name this ${noun}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={SERIF_TITLE_CLASS}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {chips}
        <ColorChip value={color} onChange={setColor} testId={`${kind}-dialog-color`} />
      </div>

      {(runsCopy || problem) && (
        <div className="flex flex-col gap-1">
          {runsCopy && <p className="text-muted-foreground text-xs">{runsCopy}</p>}
          {problem && (
            <p className="text-muted-foreground text-xs" data-testid="container-dialog-problem">
              {problem}
            </p>
          )}
        </div>
      )}

      {kind === 'goal' && (
        <Textarea
          ref={whyRef}
          rows={1}
          data-sub-input
          data-testid="goal-dialog-why"
          placeholder="Why this matters…"
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          className={SERIF_NOTES_CLASS}
        />
      )}

      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <EnterHint verb="add" />
        <div className="flex items-center gap-1 max-sm:w-full">
          {canOpen && (
            <Button
              variant="ghost"
              onClick={() => submit(true)}
              disabled={!canAdd}
              data-testid={`${kind}-dialog-add-open`}
              className="text-muted-foreground h-9 max-sm:flex-1"
            >
              Add &amp; open
            </Button>
          )}
          <Button
            onClick={() => submit()}
            disabled={!canAdd}
            data-testid={`${kind}-dialog-add`}
            className="h-9 max-sm:flex-1"
          >
            Add {noun}
          </Button>
        </div>
      </div>
    </div>
  );
}
