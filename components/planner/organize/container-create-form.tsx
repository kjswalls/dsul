'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useToday } from '@/lib/collections';
import { CONTAINER_CREATE_COPY } from '@/lib/organize-copy';
import { CreateForm } from './detail-parts';
import {
  ContainerDraftFields,
  createFromDraft,
  initialDraft,
  type ContainerDraft,
  type DraftKind,
} from './container-fields';

/**
 * The console's "+ New" for a goal, routine or season — CreateForm's shell (its
 * testids, its Escape rungs, its Cancel) around the SAME body the "new" dialog
 * renders, so the two create surfaces cannot drift apart again. Its words and
 * default glyph are lib/organize-copy.ts CONTAINER_CREATE_COPY, which the
 * iPhone's create sheet reads too.
 */

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
  // The USER's today, so a goal's window opens on the day the "new" dialog
  // would open it — not the browser's, which differs for a traveller near midnight.
  const { todayStr, tz } = useToday();
  const [draft, setDraft] = useState<ContainerDraft>(() => initialDraft(kind, todayStr));
  const copy = CONTAINER_CREATE_COPY[kind];

  const create = (name: string, icon: string | undefined) => {
    // One ⌘Z carrying everything — new member items included, created first
    // and linked in order (createFromDraft).
    const id = createFromDraft(kind, name, icon, draft, todayStr, tz);
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
