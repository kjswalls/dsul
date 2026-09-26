'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { usePlannerStore } from '@/lib/planner-store';
import { useToday } from '@/lib/collections';
import { makeIconToken } from '@/lib/category-icons';
import { CreateForm } from './detail-parts';
import {
  buildGoal,
  buildProgram,
  buildRoutine,
  ContainerDraftFields,
  initialDraft,
  type ContainerDraft,
  type DraftKind,
} from './container-fields';

/**
 * The console's "+ New" for a goal, routine or program — CreateForm's shell (its
 * testids, its Escape rungs, its Cancel) around the SAME body the "new" dialog
 * renders, so the two create surfaces cannot drift apart again.
 */

const COPY: Record<
  DraftKind,
  { eyebrow: string; placeholder: string; addLabel: string; icon: string; hint: string }
> = {
  goal: {
    eyebrow: 'NEW GOAL',
    placeholder: 'Name your goal…',
    addLabel: 'Create goal',
    icon: makeIconToken('Target'),
    hint:
      'A goal is the reason a stretch of work exists. It holds the habits and tasks that serve it, the checkpoints along the way, and a recurring check-in — and it never hides anything.',
  },
  routine: {
    eyebrow: 'NEW ROUTINE',
    placeholder: 'Name your routine…',
    addLabel: 'Create routine',
    icon: makeIconToken('Repeat'),
    hint: 'A routine groups items you want to pause together.',
  },
  program: {
    eyebrow: 'NEW PROGRAM',
    placeholder: 'Name your program…',
    addLabel: 'Create program',
    icon: makeIconToken('CalendarRange'),
    hint:
      'A program is a stretch of life — a summer, a term — that switches whole routines on and off. Without dates it starts always-on, hiding nothing.',
  },
};

export function ContainerCreateForm({
  kind,
  autoFocus,
  onCreated,
  onCancel,
}: {
  kind: DraftKind;
  autoFocus: boolean;
  onCreated: (id: string | null) => void;
  onCancel?: () => void;
}) {
  const addGoal = usePlannerStore((s) => s.addGoal);
  const addRoutine = usePlannerStore((s) => s.addRoutine);
  const addProgram = usePlannerStore((s) => s.addProgram);
  // The USER's today, so a goal's window opens on the day the "new" dialog
  // would open it — not the browser's, which differs for a traveller near midnight.
  const { todayStr, tz } = useToday();
  const [draft, setDraft] = useState<ContainerDraft>(() => initialDraft(kind, todayStr));
  const copy = COPY[kind];

  const create = (name: string, icon: string | undefined) => {
    const nowIso = new Date().toISOString();
    // One add per kind, carrying everything — never a create then a patch.
    const id =
      kind === 'goal'
        ? addGoal(buildGoal(name, icon, draft, nowIso))
        : kind === 'routine'
          ? addRoutine(buildRoutine(name, icon, draft, todayStr, nowIso, tz))
          : addProgram(buildProgram(name, icon, draft));
    if (!id) {
      // A refusal (addGoal's two-roles guard) is not a cancel: keep the draft.
      toast.error(`Couldn't create “${name}”. Nothing was saved.`);
      return;
    }
    onCreated(id);
  };

  return (
    <CreateForm
      eyebrow={copy.eyebrow}
      placeholder={copy.placeholder}
      addLabel={copy.addLabel}
      icon={copy.icon}
      testPrefix={kind}
      autoFocus={autoFocus}
      hint={copy.hint}
      fields={
        <ContainerDraftFields
          kind={kind}
          draft={draft}
          onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          testPrefix={`${kind}-new`}
          ownerName={`this ${kind}`}
          todayStr={todayStr}
          tz={tz}
        />
      }
      onCreate={create}
      onCancel={onCancel}
    />
  );
}
