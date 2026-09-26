'use client';

import { useMemo, useState } from 'react';
import { ProjectTimeBlock } from '../project-time-block';
import { BUILTIN_ITEM_TYPE_NAMES, ORGANIZER_TYPE_NAMES, usePlannerStore } from '@/lib/planner-store';
import { useUIStore } from '@/lib/ui-store';
import { byName, matching, useToday } from '@/lib/collections';
import { makeIconToken } from '@/lib/category-icons';
import { ObjectRow, SettingRow } from '../primitives';
import { heldByTrash, useTrashedNames } from '../use-trashed-names';
import type { TrashedName } from '@/lib/db';
import {
  BackRow,
  BufferedInput,
  DangerZone,
  CreateForm,
  DetailColumn,
  IdentityRow,
  ListColumn,
  OpenAsPageLink,
  SectionWelcome,
} from '../detail-parts';
import type { Item, ItemTypeDef, Project } from '@/lib/planner-types';
import { getItemTypeConfig, itemTypeName } from '@/lib/item-registry';
import { containerMemberIds } from '@/lib/container-schedule';
import {
  UnscheduledTray,
  useContainerSchedule,
  useWeekDotsFor,
} from '@/components/planner/schedule/schedule-views';
import { ItemMemberList, MEMBER_ROW_TRAILING_PAD_WITH_MENU } from '../member-list';
import { useMemberActions } from '../member-row-actions';
import { canBulkClearProject, canBulkSetProject } from '@/lib/bulk-edit';

/** Projects never suppress, so nothing here is dimmed for activation. */
const NOTHING_HIDDEN: ReadonlySet<string> = new Set();

/**
 * PROJECTS and ITEM TYPES — the half of the console that came from
 * ManageCategoriesDialog.
 *
 * ONE FILE, not two, and that is deliberate. The plan's file list named
 * `sections/{projects,types,groups}.tsx`, but they are the same section over
 * again — a list of labels, a usage count, a colour, a delete — and the
 * interesting differences (a project's time block, a type's frozen slug and
 * un-undoable delete) are a dozen lines each. Separate files would have been
 * copies of the identical scaffolding, which is precisely the drift that put
 * `lib/collections.ts` in the tree. HABIT GROUPS was the third of them until
 * migration 039 collapsed the two CLASSIFY kinds.
 *
 * WHAT THIS HALF HAS NEVER HAD: a detail pane, a usage count, or a single
 * data-testid. The dialog it replaces is a 400px box of rows with a hover trash
 * on each, and `tests/` reaches none of it. Every testid here is new, which is
 * what makes Phase 3's e2e possible.
 *
 * THE NAMES ARE EDITABLE, as of migration 027. `items.project` was a NAME
 * reference, so a rename orphaned every child and the detail said so in a
 * sentence instead of showing a disabled input. The children carry stable ids
 * now and `updateProject` fans the new name out to every member, so the
 * sentence is gone and the field is live — guarded by `takenBy`, because the rename's two writes do not fail
 * together and a collision would leave a container's items claiming a name the
 * container itself never got.
 *
 * ONE NAME IS STILL FROZEN, permanently: an item type's `name` is the DB slug
 * stored in `items.type`, so it is identity rather than a label. That row edits
 * `label`/`labelPlural` and shows the slug in its meta line.
 */

/* ── projects ─────────────────────────────────────────────────────────── */

export function ProjectsSection({
  selectedId,
  onSelect,
  creating,
  onNew,
  onCreated,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  creating: boolean;
  onNew: () => void;
  onCreated: (id: string | null) => void;
}) {
  const projects = usePlannerStore((s) => s.projects);
  const items = usePlannerStore((s) => s.items);
  const addProject = usePlannerStore((s) => s.addProject);
  const trashed = useTrashedNames();
  const [query, setQuery] = useState('');

  const selected = projects.find((p) => p.id === selectedId) ?? null;
  const visible = matching(projects, query, byName);
  const usage = (name: string) => countProjectItems(items, name);
  const showCreate = creating || projects.length === 0;

  return (
    <>
      <ListColumn
        eyebrow="PROJECTS"
        count={visible.length}
        hasSelection={!!selected || showCreate}
        filter={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter projects…',
          testId: 'project-filter',
        }}
        onNew={{ onClick: onNew, label: 'New project', testId: 'project-new' }}
      >
        {projects.length === 0 ? (
          <p className="text-muted-foreground px-[7px] pt-2 text-xs">No projects yet.</p>
        ) : (
          visible.map((project) => (
            <ObjectRow
              key={project.id}
              testId="project-row"
              idAttr={{ 'data-project-id': project.id }}
              icon={project.emoji}
              color={project.color}
              name={project.name}
              selected={selectedId === project.id}
              pill={null}
              count={usage(project.name)}
              onSelect={() => onSelect(project.id)}
            />
          ))
        )}
      </ListColumn>

      <DetailColumn hasSelection={!!selected || showCreate}>
        {showCreate ? (
          <CreateForm
            eyebrow="NEW PROJECT"
            placeholder="Name your project…"
            addLabel="Create project"
            icon={makeIconToken('Briefcase')}
            testPrefix="project"
            autoFocus={creating}
            hint="Projects file your tasks, and can carry a repeating block on the grid."
            // The create path had NO validate at all, and the store's own
            // de-dupe cannot see the bin — so typing the name of a project you
            // deleted yesterday produced a row that opened, accepted edits, and
            // never existed. See useTrashedNames.
            validate={(name) => heldByTrash(trashed.projects, name, 'project')}
            onCreate={(name, icon) => {
              addProject(name, icon ?? makeIconToken('Briefcase'));
              onCreated(created(usePlannerStore.getState().projects, name));
            }}
            onCancel={projects.length > 0 ? () => onCreated(null) : undefined}
          />
        ) : selected ? (
          // Threaded rather than re-hooked: the detail remounts on every
          // selection change, and a hook there would refetch the bin each time.
          <ProjectDetail project={selected} trashed={trashed.projects} onBack={() => onSelect(null)} />
        ) : (
          <SectionWelcome section="projects">
            Projects file your tasks, and can carry a repeating block on the grid.
          </SectionWelcome>
        )}
      </DetailColumn>
    </>
  );
}

function ProjectDetail({
  project,
  trashed,
  onBack,
}: {
  project: Project;
  trashed: TrashedName[];
  onBack: () => void;
}) {
  const items = usePlannerStore((s) => s.items);
  // Siblings, for the rename collision check — see takenBy.
  const projects = usePlannerStore((s) => s.projects);
  const updateProject = usePlannerStore((s) => s.updateProject);
  const removeProject = usePlannerStore((s) => s.removeProject);
  const confirm = useUIStore((s) => s.confirm);

  const n = countProjectItems(items, project.name);
  // Held BY NAME (items.project), folded as every project lookup is.
  const projectMembers = useMemo(() => {
    const ids = new Set(containerMemberIds({ kind: 'project', project }, items, []));
    // Not subtasks: they carry their parent's project but no scheduling, and
    // every row verb here would be wrong for one.
    return items.filter((i) => ids.has(i.id) && !(i as { parentItemId?: string }).parentItemId);
  }, [project, items]);
  const memberIds = projectMembers.map((i) => i.id);
  const setItemsProject = usePlannerStore((s) => s.setItemsProject);
  const week = useWeekDotsFor(memberIds);
  const { todayStr } = useToday();
  const { unscheduled } = useContainerSchedule(memberIds, todayStr, 1);
  const controls = useMemberActions({
    ownerName: project.name,
    onRemove: (id) => setItemsProject([id], undefined),
    removable: canBulkClearProject,
    todayState: week.todayState,
  });

  // THE SENTENCE MIRRORS `unfiled`, which is what removeProject actually runs.
  // Most items are simply unfiled; a type whose container is REQUIRED (a habit)
  // is reassigned instead, and the old habit-group copy was written because
  // "unassigns it" was a lie the user could not check. So the sentence names the
  // destination whenever one of those is in the count — a count that disagrees
  // with its own write is worse than no count.
  const requireds = countRequiredContainerItems(items, project.name);
  const destination = projects.find((p) => p.id !== project.id)?.name;
  const consequence =
    (n === 0
      ? 'Nothing is filed under it, so nothing moves.'
      : `Its ${n} ${n === 1 ? 'item stays' : 'items stay'} exactly as ${
          n === 1 ? 'it is' : 'they are'
        } — ${n === 1 ? 'it just stops' : 'they just stop'} being filed under ${project.name}.`) +
    (requireds > 0 && destination
      ? ` The ${requireds === 1 ? 'habit moves' : `${requireds} habits move`} to “${destination}”.`
      : '') +
    ' ⌘Z brings it back now, and it stays in the Trash for 30 days.';

  return (
    <div className="flex flex-col" data-testid="project-detail" data-project-id={project.id}>
      <BackRow label="Projects" testId="project-detail-back" onBack={onBack} />

      <IdentityRow
        id={project.id}
        name={project.name}
        icon={project.emoji}
        color={project.color}
        label="Project"
        testPrefix="project"
        // Unparked by migration 027: items point at this project by ID now, and
        // updateProject fans the new name out to every member in the same set().
        //
        // The TRASH half was the deferred piece and it needed the Trash's data:
        // the unique index spans soft-deleted rows, so renaming onto a name a
        // deleted project still holds passed `takenBy` and produced exactly the
        // split write it exists to prevent.
        validate={(next) =>
          takenBy(projects, project.id, next, 'project') ??
          heldByTrash(trashed, next, 'project')
        }
        meta={
          <>
            Project · <span className="font-num">{n}</span> {n === 1 ? 'item' : 'items'}
          </>
        }
        // The persisted canvas/braindump filters hold `project:<NAME>` and a
        // stale ref empties the view rather than degrading — but the remap is
        // NOT fired here. view-store watches the store for a container whose
        // name changed under a stable id, so rename, undo and redo are one case
        // and none of them can leave the refs behind. See remapRefs.
        onPatch={(patch) =>
          updateProject(project.id, {
            ...renameIconKey(patch, 'emoji'),
            ...('name' in patch && { name: patch.name }),
          })
        }
      />

      <div className="mt-2 flex">
        <OpenAsPageLink href={`/project/${project.id}`} testId="project-open-page" />
      </div>

      <div className="bg-border my-4 h-px" />

      <ProjectTimeBlock project={project} />

      <div className="mt-5 flex flex-col gap-4">
        <ItemMemberList
          label="Items"
          ownerId={project.id}
          ownerName={project.name}
          memberIds={memberIds}
          members={projectMembers}
          hiddenIds={NOTHING_HIDDEN}
          testPrefix="project"
          lead={projectMembers.length > 0 ? week.header(MEMBER_ROW_TRAILING_PAD_WITH_MENU) : undefined}
          row={{ trailing: week.trailing, ...controls }}
          removable={canBulkClearProject}
          // What setItemsProject will actually accept, and nothing already
          // filed elsewhere — linking would re-file it without a word.
          eligible={(i) =>
            canBulkSetProject(i) &&
            !(i as { parentItemId?: string }).parentItemId &&
            !(i as { project?: string }).project
          }
          pickerHint="Items not yet in a project."
          emptyPoolLabel="Everything is already filed somewhere — move items from their own project."
          // Membership is the item's own `project` field, so linking and
          // removing are re-files — setItemsProject, which also brings a task
          // out of the old block it was parked in.
          onChange={(next) => {
            const before = new Set(memberIds);
            const after = new Set(next);
            const added = next.filter((id) => !before.has(id));
            const removed = memberIds.filter((id) => !after.has(id));
            if (added.length) setItemsProject(added, project.name);
            if (removed.length) setItemsProject(removed, undefined);
          }}
        />
        <UnscheduledTray items={unscheduled} testId="project-unscheduled" />
      </div>

      <DangerZone
        label="Delete this project"
        testId="project-delete"
        consequence={consequence}
        onDelete={() =>
          confirm({
            title: `Delete “${project.name}”?`,
            description: consequence,
            confirmLabel: 'Delete',
            testId: 'category-delete-confirm',
            onConfirm: () => {
              removeProject(project.id);
              onBack();
            },
          })
        }
      />
    </div>
  );
}

/* ── item types ───────────────────────────────────────────────────────── */

export function TypesSection({
  selectedId,
  onSelect,
  creating,
  onNew,
  onCreated,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  creating: boolean;
  onNew: () => void;
  onCreated: (id: string | null) => void;
}) {
  const itemTypes = usePlannerStore((s) => s.itemTypes);
  const itemTypesAvailable = usePlannerStore((s) => s.itemTypesAvailable);
  const items = usePlannerStore((s) => s.items);
  const addItemType = usePlannerStore((s) => s.addItemType);

  const [query, setQuery] = useState('');

  const selected = itemTypes.find((t) => t.id === selectedId) ?? null;
  // Label AND slug: the slug is on the row and is what a user hunting for the
  // type they created as "Side Quest" may well type.
  const visible = matching(itemTypes, query, (t) => `${t.label} ${t.name}`);
  const showCreate = itemTypesAvailable && (creating || itemTypes.length === 0);

  return (
    <>
      <ListColumn
        eyebrow="ITEM TYPES"
        count={visible.length}
        hasSelection={!!selected || showCreate}
        filter={{
          value: query,
          onChange: setQuery,
          placeholder: 'Filter item types…',
          testId: 'type-filter',
        }}
        onNew={{
          onClick: onNew,
          label: 'New item type',
          testId: 'type-new',
          disabled: !itemTypesAvailable,
        }}
      >
        {!itemTypesAvailable ? (
          <p
            className="text-muted-foreground px-[7px] pt-2 text-xs"
            data-testid="types-unavailable"
          >
            Custom types aren&apos;t available on this account yet.
          </p>
        ) : itemTypes.length === 0 ? (
          <p className="text-muted-foreground px-[7px] pt-2 text-xs">No custom types yet.</p>
        ) : (
          visible.map((type) => (
            <ObjectRow
              key={type.id}
              testId="type-row"
              idAttr={{ 'data-type-id': type.id }}
              icon={type.icon}
              color={type.color}
              name={type.label}
              // The SLUG, because that is what item-registry hashes for a
              // custom type's accent — the label is only what it is called.
              accentName={type.name}
              selected={selectedId === type.id}
              pill={null}
              count={countTypeItems(items, type.name)}
              onSelect={() => onSelect(type.id)}
            />
          ))
        )}
      </ListColumn>

      <DetailColumn hasSelection={!!selected || showCreate}>
        {showCreate ? (
          <CreateForm
            eyebrow="NEW ITEM TYPE"
            placeholder="Name your type… (e.g. Errand)"
            addLabel="Create item type"
            icon={makeIconToken('Target')}
            testPrefix="type"
            autoFocus={creating}
            hint="Custom types work like tasks — they get their own tab in the add dialog and their own section in Beacon's context."
            // The store silently no-ops on a bad slug, so the form has to know
            // the same rules — and say them out loud rather than greying a
            // button and leaving the user to guess.
            validate={(name) => slugProblem(name, itemTypes)}
            onCreate={(name, icon) => {
              const slug = slugForLabel(name);
              addItemType({
                name: slug,
                label: name,
                labelPlural: `${name}s`,
                icon: icon ?? makeIconToken('Target'),
              });
              const made = usePlannerStore.getState().itemTypes.find((t) => t.name === slug);
              onCreated(made?.id ?? null);
            }}
            onCancel={itemTypes.length > 0 ? () => onCreated(null) : undefined}
          />
        ) : selected ? (
          <TypeDetail type={selected} onBack={() => onSelect(null)} />
        ) : (
          <SectionWelcome section="types">
            Custom types work like tasks — they get their own tab in the add dialog and their own
            section in Beacon&apos;s context.
          </SectionWelcome>
        )}
      </DetailColumn>
    </>
  );
}

function TypeDetail({ type, onBack }: { type: ItemTypeDef; onBack: () => void }) {
  const items = usePlannerStore((s) => s.items);
  const updateItemType = usePlannerStore((s) => s.updateItemType);
  const removeItemType = usePlannerStore((s) => s.removeItemType);
  const confirm = useUIStore((s) => s.confirm);

  const n = countTypeItems(items, type.name);
  const plural = (type.labelPlural ?? `${type.label}s`).toLowerCase();

  // The one delete in the console that genuinely cannot be undone — itemTypes
  // sit outside HistoryState, so there is no ⌘Z and no 30-day window. It is the
  // only place the filled destructive button is spent.
  const consequence =
    (n === 0
      ? 'Nothing uses it yet.'
      : n === 1
        ? `Your one existing ${type.label.toLowerCase()} is kept and keeps working with a generic label.`
        : `Your ${n} existing ${plural} are kept and keep working with a generic label.`) +
    ' This one isn’t undoable — custom types sit outside the undo history.';

  return (
    <div className="flex flex-col" data-testid="type-detail" data-type-id={type.id}>
      <BackRow label="Item types" testId="type-detail-back" onBack={onBack} />

      <IdentityRow
        id={type.id}
        name={type.label}
        accentName={type.name}
        icon={type.icon}
        color={type.color}
        label="Item type"
        testPrefix="type"
        // Editable, unlike projects and habit groups: a type's children point at
        // its SLUG, not its label, so renaming the label orphans nothing. The
        // slug itself is what is permanent, and the meta line shows it.
        meta={
          <>
            Item type · <span className="font-num">{n}</span> {n === 1 ? 'item' : 'items'} ·{' '}
            <span className="font-mono">{type.name}</span>
          </>
        }
        onPatch={(patch) => {
          const next = renameIconKey(patch, 'icon');
          if (patch.name === undefined) {
            updateItemType(type.id, next);
            return;
          }
          // The label and its plural travel TOGETHER, and this is the whole
          // reason the pair shipped at once rather than the label alone: rename
          // "Goal" to "Objective" and leave the plural at "Goals", and every
          // list header in the app reads "Objective / Goals" with no control
          // anywhere to fix it.
          //
          // Only an untouched plural follows. Once someone has written "People"
          // for "Person", a later rename must not silently overwrite it — the
          // irregular plural is exactly the thing this field exists to hold.
          const auto = type.labelPlural === `${type.label}s`;
          updateItemType(type.id, {
            ...next,
            label: patch.name,
            ...(auto && { labelPlural: `${patch.name}s` }),
          });
        }}
      />

      <div className="bg-border my-4 h-px" />

      <SettingRow label="Plural" description="Used wherever more than one is counted.">
        <BufferedInput
          value={type.labelPlural ?? `${type.label}s`}
          testId="type-plural"
          ariaLabel="Item type plural"
          className="w-[160px]"
          onCommit={(next) => updateItemType(type.id, { labelPlural: next })}
        />
      </SettingRow>

      <DangerZone
        label="Delete this type"
        testId="type-delete"
        destructive
        consequence={consequence}
        onDelete={() =>
          confirm({
            title: `Delete “${type.label}”?`,
            description: consequence,
            confirmLabel: 'Delete',
            destructive: true,
            testId: 'category-delete-confirm',
            onConfirm: () => {
              removeItemType(type.id);
              onBack();
            },
          })
        }
      />
    </div>
  );
}

// The HABIT GROUPS section lived here until migration 039 collapsed the two
// CLASSIFY kinds. Projects above is the whole axis now, and the console rail has
// one row for it instead of two — a habit files itself under a project like
// everything else.

/* ── patches ──────────────────────────────────────────────────────────── */

/**
 * IdentityRow's `{name, icon, color}` → the field names these three tables
 * actually use. Projects and habit groups spell the glyph `emoji`; item types
 * spell it `icon`.
 *
 * KEY PRESENCE, not value, and the difference is a real bug rather than a
 * style point. ColorSwatchPicker's `Auto` means "clear the stored colour" and
 * says so by calling `onSelect(undefined)`; a `patch.color !== undefined` test
 * drops exactly that case, producing an empty patch that the store spreads to
 * nothing and `dbUpdateProject` discards before it builds a query. The result
 * is a swatch you can set and never unset — a regression against the dialog
 * this replaces, which passes `{ color }` straight through and whose db writer
 * has always keyed on `'color' in updates`.
 *
 * `name` is still dropped HERE, and now for one reason rather than three.
 * Projects and habit groups pass it back in explicitly at their call sites,
 * because 027 gave their children stable ids and updateProject/updateHabitGroup
 * fan the new name out. Item types are different and always will be: their
 * `name` is the DB SLUG stored in items.type, not a label, so a rename there
 * would orphan every item of that type with no fan-out possible. The item-type
 * row edits `label`/`labelPlural` and leaves the slug alone.
 */
function renameIconKey<K extends 'emoji' | 'icon'>(
  patch: { name?: string; icon?: string; color?: string },
  iconKey: K
): { color?: string } & Partial<Record<K, string>> {
  const next: { color?: string } & Partial<Record<K, string>> = {};
  // The glyph column is NOT NULL on projects and habit groups, so this one
  // stays a value test — IconPicker only ever sends a real token, and writing
  // an undefined would blank a required field.
  if (patch.icon !== undefined) next[iconKey] = patch.icon as never;
  if ('color' in patch) next.color = patch.color;
  return next;
}

/**
 * Refuse a rename that would collide with a sibling.
 *
 * Both tables carry UNIQUE (user_id, name), and a rename issues TWO writes that
 * do not fail together: the container UPDATE raises 23505 and is swallowed by
 * the store's `.catch(console.error)`, while the id-keyed member fan-out
 * succeeds. The container would keep its old name while every one of its items
 * claimed the new one — which reads as the items having moved into the OTHER
 * project. Nothing downstream can detect that, so it has to be refused here.
 *
 * Case-insensitive, excluding self. Insensitive because the app's own lookups
 * are (getHabitGroupColor normalises, addHabitGroup de-dupes that way) and two
 * containers differing only in case are indistinguishable in a list. Excluding
 * self so that fixing the capitalisation of your own project is still allowed —
 * a rename to a different id is the collision, a rename to your own case is not.
 */
function takenBy(
  siblings: { id: string; name: string }[],
  selfId: string,
  next: string,
  noun: string,
): string | null {
  const clash = siblings.find(
    (s) => s.id !== selfId && s.name.toLowerCase() === next.toLowerCase()
  );
  return clash ? `You already have a ${noun} called “${clash.name}”.` : null;
}

/* ── counts and slugs ─────────────────────────────────────────────────── */

/**
 * Usage counts, computed live rather than stored, so the number in the delete
 * sentence is the number on the canvas.
 *
 * Each one mirrors the store action that will act on it — a count that
 * disagrees with its own write is worse than no count, because it is the
 * evidence the user is deciding on.
 */
const countProjectItems = (items: Item[], name: string) =>
  items.filter((i) => i.project === name).length;

/**
 * How many of those cannot simply be unfiled — the registry's
 * `containerRequired`, which is what `unfiled` in planner-store reads. Asked as
 * a capability rather than counted as habits, so a future required-container
 * type is described correctly by the delete sentence without an edit here.
 */
const countRequiredContainerItems = (items: Item[], name: string) =>
  items.filter((i) => i.project === name && getItemTypeConfig(itemTypeName(i)).containerRequired)
    .length;

const countTypeItems = (items: Item[], slug: string) =>
  items.filter((i) => i.type === 'custom' && i.customType === slug).length;

/**
 * The id of the thing just created, or null.
 *
 * `addProject` returns void and no-ops silently on a
 * duplicate name, so the id has to be read back out of the store — which is
 * safe because zustand's set() is synchronous. A no-op therefore selects the
 * row that was already there, which is the honest outcome: the name is taken,
 * and here is what has it.
 *
 * EXACT FIRST, then case-folded, because the two tables disagree on purpose.
 * `addHabitGroup` de-duplicates on `name.toLowerCase()` (matching how the rest
 * of the app compares group refs — see lib/filters.ts), so typing "personal"
 * against an existing "Personal" creates nothing; an exact-only lookup would
 * then return null, wipe the selection, and leave the user with no group, no
 * selection and no explanation. `addProject` compares exactly and really does
 * create a second "personal", so a fold-only lookup would select the OLDER row
 * instead of the one just made. Trying exact first satisfies both.
 */
const created = (rows: { id: string; name: string }[], name: string) =>
  (
    rows.find((r) => r.name === name) ??
    rows.find((r) => r.name.toLowerCase() === name.toLowerCase())
  )?.id ?? null;

/** 'Errand' → 'errand', 'Side Quest' → 'side-quest' (the items.type slug). */
const slugForLabel = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');

/**
 * The store's own rules, restated so the row can refuse BEFORE it writes — and
 * say which rule was broken.
 *
 * `addItemType` enforces all of these by returning early and writing nothing, so
 * without this the field would clear, no type would appear, and nothing on
 * screen would explain why. Each branch names the actual slug, because the slug
 * is derived from what was typed and the derivation is where the surprise is:
 * "Side Quest" becoming `side-quest` is obvious in hindsight and invisible
 * before it.
 */
function slugProblem(label: string, existing: ItemTypeDef[]): string | null {
  const slug = slugForLabel(label);
  if (!slug) return 'Use some letters or numbers.';
  if (!/^[a-z]/.test(slug)) return 'Start with a letter.';
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(slug)) {
    return slug.length > 32 ? 'A bit shorter — 32 characters at most.' : 'Letters, numbers and dashes.';
  }
  if (BUILTIN_ITEM_TYPE_NAMES.includes(slug)) return `“${slug}” is a built-in name — pick another.`;
  // The duplicate check runs before the organizer one: types made before the
  // organizer nouns were reserved keep those names, and to their owner "you
  // already have one" is the truer sentence.
  const clash = existing.find((t) => t.name === slug);
  if (clash) {
    return clash.label.toLowerCase() === label.toLowerCase()
      ? `You already have a type called “${clash.label}”.`
      : `“${clash.label}” already uses the name “${slug}”.`;
  }
  // Organizer nouns are refused for NEW types since the "new" dialog's type menu
  // started listing organizers beside item types (2026-09-25): a type called
  // "goal" would sit one row above the Goal organizer and mean something else.
  if (ORGANIZER_TYPE_NAMES.includes(slug)) {
    return `“${slug}” is an organizer, not a type — make one from the “new” dialog, or pick another name.`;
  }
  return null;
}
