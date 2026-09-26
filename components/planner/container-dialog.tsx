'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ResponsiveModalDescription,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal';
import { IconPicker } from '@/components/primitives/icon-picker';
import { PropertyChip } from '@/components/primitives/property-chip';
import { ColorChip } from '@/components/primitives/organizer-chips';
import {
  ADD_MODAL_CLASS,
  EnterHint,
  NewTypeMenu,
  ORGANIZER_SECTION,
  SERIF_TITLE_CLASS,
  SurfaceA11yHeader,
  SurfaceContent,
  SurfaceRoot,
  OrganizerGlyph,
} from '@/components/planner/surface';
import { heldByTrash, useTrashedNames } from '@/components/planner/organize/use-trashed-names';
import { useEscapeLadder } from '@/components/planner/organize/escape-ladder';
import {
  ContainerDraftFields,
  createFromDraft,
  initialDraft,
  type ContainerDraft,
} from '@/components/planner/organize/container-fields';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { usePlannerStore } from '@/lib/planner-store';
import { useOrganizeEnabled } from '@/lib/extension-gates';
import { useOpenConsole } from '@/lib/console-door';
import { CONTAINER_KINDS, sameContainerName } from '@/lib/container-registry';
import { useToday } from '@/lib/collections';
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
  // The member pickers, the why and the resume chip each claim Escape before
  // the dialog does — the console's ladder, owned here for the same reason.
  const { register, consume, Ladder } = useEscapeLadder();

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
        onEscapeKeyDown={(event) => {
          if (consume()) event.preventDefault();
        }}
        // An organizer's body carries its member lists, so it is a little wider
        // than an item's quick capture. A project's is not.
        className={cn(ADD_MODAL_CLASS, last.kind !== 'project' && 'sm:max-w-[520px]')}
      >
        <SurfaceA11yHeader panel={false}>
          <ResponsiveModalTitle>New {label.toLowerCase()}</ResponsiveModalTitle>
          <ResponsiveModalDescription>
            Add a new {label.toLowerCase()} to organize your planner.
          </ResponsiveModalDescription>
        </SurfaceA11yHeader>
        <Ladder value={register}>
          <ContainerForm
            key={seq}
            payload={last}
            isMobile={isMobile}
            close={() => onOpenChange(false)}
            openConsole={openConsole}
          />
        </Ladder>
      </SurfaceContent>
    </SurfaceRoot>
  );
}

// Moved to the shared body; re-exported for the callers that import it here.
export { programRunsCopy } from '@/components/planner/organize/container-fields';

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
  const addProject = usePlannerStore((s) => s.addProject);
  const organizeOn = useOrganizeEnabled();
  const { todayStr, tz } = useToday();
  // Only a project name can be held by the bin (projects_user_id_name_key is
  // the one plain unique index), so only the project body asks.
  const trashed = useTrashedNames({ enabled: kind === 'project' });

  const [name, setName] = useState(payload.title ?? '');
  const [icon, setIcon] = useState<string | undefined>(DEFAULT_ICON[kind]);
  // A project's one extra field. The other kinds keep everything in the draft.
  const [color, setColor] = useState<string | undefined>(undefined);
  // Every field the kind has, with its defaults: Active, a goal's window opening
  // today, a program on its (absent) dates. The shared body renders it; see
  // organize/container-fields.tsx.
  const [draft, setDraft] = useState<ContainerDraft>(() =>
    initialDraft(kind === 'project' ? 'goal' : kind, todayStr, payload.notes)
  );
  const nameRef = useRef<HTMLInputElement>(null);

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
    // One ⌘Z per kind, with everything the dialog asked for in it — new
    // member items included, created first and linked in order.
    if (kind === 'project') return addProject(trimmed, icon ?? '', color ? { color } : undefined);
    return createFromDraft(kind, trimmed, icon, draft, todayStr, tz);
  };

  const submit = (andOpen = false) => {
    if (!canAdd) return;
    const id = create();
    if (!id) {
      toast.error(`Couldn't create “${trimmed}”. Nothing was saved.`);
      return;
    }
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

  return (
    <div
      className="flex flex-col gap-4"
      onKeyDown={(e) => {
        // ItemDialog's Enter rule, plus two clauses. The event must come from
        // inside this dialog's own DOM: the IconPicker's search field is
        // portalled, and its Enter bubbles here through React's tree. And a
        // plain Enter only submits from the NAME — the why is a textarea and
        // the member pickers' search boxes own Enter (with nothing to add, an
        // Enter there must not create the container). ⌘/Ctrl-Enter submits from
        // the why; in a member search box with a row highlighted, the picker
        // takes it first (it adds the row), as it does without the modifier.
        const target = e.target as HTMLElement;
        const field = target.closest('input, textarea, [contenteditable="true"]');
        const fromOtherField = !!field && field !== nameRef.current;
        if (
          e.key === 'Enter' &&
          !e.shiftKey &&
          !e.defaultPrevented &&
          e.currentTarget.contains(target) &&
          !target.closest('[data-sub-input]') &&
          !target.closest('button') &&
          (!fromOtherField || e.metaKey || e.ctrlKey)
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
                  const why = draft.why.trim();
                  if (next !== kind) openNewContainer(next, trimmed || undefined, why || undefined);
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
            ref={nameRef}
            autoFocus
            data-testid={`${kind}-dialog-name`}
            placeholder={`Name this ${noun}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={SERIF_TITLE_CLASS}
          />
        </div>
      </div>

      {kind === 'project' ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <ColorChip value={color} onChange={setColor} testId="project-dialog-color" />
        </div>
      ) : (
        <ContainerDraftFields
          kind={kind}
          draft={draft}
          onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          testPrefix={`${kind}-dialog`}
          ownerName={trimmed || `this ${noun}`}
          todayStr={todayStr}
          tz={tz}
        />
      )}

      {problem && (
        <p className="text-muted-foreground text-xs" data-testid="container-dialog-problem">
          {problem}
        </p>
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
