import type { ItemTypeConfig } from './item-registry';

/**
 * container-registry.ts — what each KIND of container is, and how its
 * references behave.
 *
 * The sibling of item-registry.ts, and the same bargain: every place the app
 * used to ask "is this a project or a habit group?" asks the registry a
 * capability question instead. Adding a kind means adding config.
 *
 * ── the three roles ──────────────────────────────────────────────────────────
 *
 * dsul has four container tables and they are not four of a kind. One says
 * what an item IS ABOUT, two say WHEN IT COUNTS, and one says WHY IT MATTERS —
 * and that difference decides every question anyone asks about them:
 *
 *   CLASSIFY — projects. Exactly one per item, stored as a name on the item
 *     itself (`items.project`). One item, one answer, so it is a partition:
 *     filterable, groupable, and the thing a coloured dot names. This is the
 *     "container axis" the Display menu speaks about.
 *
 *     There were TWO classify kinds until migration 039 — `project` for tasks
 *     and `group` (habit group) for habits — which were the same shape wearing
 *     two names. Tasks and habits have been ONE entity since 019, with an
 *     open-text `type` discriminator, so a second classify kind was a
 *     distinction the data model no longer made: a custom type had to pick a
 *     side, and the Display menu had to draw one question as two lists. The
 *     ROLE is what says one-per-item; the noun is just a noun, and it lives in
 *     `CONTAINER_KINDS.project.label` so changing it later is a string edit
 *     rather than a migration. `habit_groups` and `items."group"` survive as
 *     frozen rollback ballast — nothing here reads them.
 *
 *   GATE — routines, seasons. Many-to-many through join tables, and membership
 *     does not describe the work, it SWITCHES it — pausing a routine takes its
 *     members off the grid. An item can sit in three routines at once, so there
 *     is no "the" routine to file it under; `lib/grouping.ts` groups by routine
 *     only through a documented first-claim-wins rule, and the Display menu
 *     deliberately offers no routine FILTER because the scope rail already owns
 *     that question per-date, through the DB, with a resume date. That last
 *     argument is what a GOAL filter does not have to answer to: nothing else
 *     in the app narrows a view to one goal, and a goal has no resume date to
 *     own it with.
 *
 *   ASPIRE — goals. Many-to-many like a gate, but membership switches NOTHING:
 *     a goal says why work matters, and a goal you are behind on is the last
 *     thing that should quietly hide its work. Its members carry a ROLE
 *     (`member` | `milestone` | `checkin`, on goal_items), which is the one
 *     thing no other kind has — and the reason it is a role of its own rather
 *     than a gate with suppression turned off: an item can sit in a goal AND a
 *     season at once (the Chinese habit inside the school-year season), so
 *     the two questions have to be asked separately or the answers merge.
 *     Since the goal display work it IS a filter and a grouping axis — by id,
 *     never by ref, and never as suppression; see the seam below.
 *
 * The seam is enforced by types, not by convention: `ClassifyKind` is what a ref
 * can name and what `containerRefOf` returns; `GateKind` is what `ScopeKind` is
 * and what `ActivationContext` carries; `AspireKind` is neither, and nothing
 * downstream widens to it. So a routine cannot leak into a filter clause and a
 * project cannot gate a day. `ClassifyKind` being a single-member union is not
 * an invitation to delete it: it is what keeps `containerRef`, `foldRef` and
 * `containerRefOf` refusing a gate or a goal, and a second classify kind (if one
 * is ever justified again) rejoins by declaring its role.
 *
 * A GOAL is now visible to filters.ts and grouping.ts, and that is a narrowing
 * of the original claim, not an exception to the seam — the type unions are
 * untouched. What crosses is never an `AspireKind` and never a ref; the seam is
 * about the KIND, not about how much of a goal a view module may hold:
 *
 *   - `ViewFilters.goals` holds ids, and `lib/filters.ts` sees only those ids
 *     plus a `ReadonlySet` of item ids resolved from `goal_items` — it is
 *     store-free by contract, so it is handed the answer rather than the goals.
 *     `containerRef`/`containerKindOf` still answer only for CLASSIFY kinds, so
 *     a goal cannot enter `containers` and `containerRefOf` cannot return one.
 *     The two clauses never mix.
 *   - `lib/grouping.ts` takes whole `readonly Goal[]` records, exactly as it
 *     already takes `Routine[]` and `Season[]`: a section needs the name for
 *     its heading and the role arrays to claim its rows. That is more than an
 *     id and it is still inside the seam — nothing in a `Goal` resolves
 *     activation, and the kind never appears.
 *   - Grouping by goal is `lib/grouping.ts`'s first-claim-wins rule — the one
 *     the gates already needed, because a many-to-many is not a partition. A
 *     goal section carries no `gate`, so its heading has no switch: the gates'
 *     grouping can pause a container from a header and the aspire one cannot.
 *   - Nothing goal-shaped reaches `lib/active.ts`, `isItemActiveOn`,
 *     `inactiveItemIdsOn` or scope-rail.ts. A goal STILL cannot suppress an
 *     item — the filter narrows a view the user is looking at and clears with
 *     Reset display; suppression is DB state that outlives the session.
 *
 * The distinction the seam is really making, then: CLASSIFY is the axis an item
 * ANSWERS WITH, GATE is the axis that RESOLVES ACTIVATION, and ASPIRE may
 * organise a view while doing neither.
 *
 * A NOTE ON DISCOVERY, because the obvious assumption is wrong: widening
 * `ContainerKind` does NOT light up the codebase with exhaustive-switch errors.
 * There are no switches over it — every consumer narrows to `ClassifyKind` or
 * `GateKind` first, which is exactly the property above. The compiler forces
 * one edit (the `CONTAINER_KINDS` record) and the role-partition test in
 * tests/unit/container-registry.test.ts forces the rest of the thinking. A
 * sixth kind's real touchpoints are hand-wired and listed in its plan.
 *
 * ── what is deliberately NOT here ────────────────────────────────────────────
 *
 * `item_types` is the fifth table and stays out. A type is what a thing IS, not
 * what it belongs to; it already has its own registry, and folding it in here
 * would make "which container does this item answer with" ambiguous at the one
 * call site that has to be unambiguous (`containerRefOf`).
 *
 * CUSTOM container kinds are not v1. The four below are the four tables that
 * are read; `CONTAINER_KINDS` is a closed record, so a fifth is a type error at
 * the record itself rather than a silent fallthrough.
 *
 * The table names and the id columns are not here either. Migration 027
 * (`feat/organize-console`, organize-console.md Phase 0) gives items
 * `project_id`, and the resolution that goes with it lives with that work —
 * this module stays pure and store-free, so it has nothing to resolve a name
 * against. A config field no code reads is a field that drifts.
 *
 * 027 shipped TWO id columns, one per classify kind, so each could carry a real
 * foreign key with ON DELETE SET NULL — which one column pointing at either of
 * two tables cannot. 039 removed the second kind rather than the second column:
 * `items.group_id` stays as ballast beside `items."group"`, unread.
 */

/**
 * Kinds an item answers with. One per item; the filter/group axis.
 *
 * One member since 039 — see the CLASSIFY note above for why, and why the union
 * stays rather than being inlined.
 */
export type ClassifyKind = 'project';
/** Kinds that switch items off. Many-to-many; the scope rail's axis. */
export type GateKind = 'routine' | 'season';
/**
 * Kinds that say why work matters. Many-to-many, and they suppress NOTHING —
 * deliberately not a `GateKind`, so a goal can never reach a resolver.
 *
 * It may still ORGANISE a view (the Display menu's Goal filter and grouping),
 * which reads goal ids and member id sets, never this union. Narrowing what you
 * are looking at is not gating what counts.
 */
export type AspireKind = 'goal';
export type ContainerKind = ClassifyKind | GateKind | AspireKind;

export type ContainerRole = 'classify' | 'gate' | 'aspire';

/** The `ItemTypeConfig.containerKind` vocabulary, read from the source so it cannot drift. */
type ItemTypeContainerKind = ItemTypeConfig['containerKind'];

export interface ContainerKindConfig {
  kind: ContainerKind;
  role: ContainerRole;
  /** Singular noun, as the user sees it. */
  label: string;
  labelPlural: string;
  /**
   * The heading for "carries this axis, value unset" — `null` on gates, which
   * have no unset state (an item is in a routine or it is not).
   *
   * Per-kind rather than one shared "No container" because the two sides of the
   * axis are visibly different work: "No project" over a stack of habits is
   * false, and habits are exactly what the axis used to hoist out of the
   * question. The FILTER still needs one checkbox catching both sides — that is
   * `NO_CONTAINER`, undecorated — but a heading has room to say which side it is.
   */
  unsetLabel: string | null;
   /**
   * The label of the "create one from here" row inside a container picker.
   *
   * Set on every kind that offers inline creation from the item dialog. It used
   * to be projects-only — gates and goals were created solely in the Organize
   * console — but "attach this to a NEW goal (or routine, or season)" is a real
   * gesture the add dialog now answers, so each kind names its create row here
   * and the console stays the place to rename and delete. `null` only if a kind
   * should never be inline-creatable.
   */
  newLabel: string | null;
  /**
   * The `Item` field naming this container, or `null` for gates (their
   * membership lives in join tables, never on the item).
   */
  itemField: 'project' | null;
  /** The `ItemTypeConfig.containerKind` value that resolves to this kind, or null. */
  itemTypeKey: ItemTypeContainerKind;
  /**
   * Do two refs of this kind compare case-INSENSITIVELY?
   *
   * TRUE, and it is not a preference. `makeAddDraft` writes a lowercase
   * 'personal' against the seeded, capitalised 'Personal' whenever the container
   * list has not loaded yet, so both spellings live in real data and must select
   * together. That was the habit-group half of the axis before 039; folding it
   * away with the kind would have re-opened the exact bug the flag was added to
   * close, so the merged kind inherits the folding half rather than the exact
   * half.
   *
   * The cost is real and small: an account holding both `Work` and `work` as
   * PROJECTS now resolves both names to one row (the first in store order), and
   * `addProject` refuses the second spelling. Migration 039 rewrites
   * `items.project` to its container's canonical spelling precisely so this is a
   * belt-and-braces fold for stragglers rather than the only thing holding a
   * reference together.
   *
   * This flag is the WHOLE policy: it is read at exactly one site,
   * `foldContainerName`, which `foldRef` and `sameContainerName` are both built
   * from — so every comparison, every group key and every store lookup answers
   * through it.
   *
   * It is still NOT the same as the stored data being normalized: two rows
   * differing only in case remain two rows, and folding only decides which one a
   * name resolves to. Merging them is a data decision with a visible consequence
   * (which colour and which icon survive) and belongs to whoever runs a
   * migration, not here.
   */
  caseFold: boolean;
}

export const CONTAINER_KINDS: Record<ContainerKind, ContainerKindConfig> = {
  /**
   * THE NOUN LIVES HERE AND NOWHERE ELSE.
   *
   * 'Project' is provisional — it was chosen because it is already the DB
   * column, the agent API's field, and the word in every shipped string, so
   * renaming would buy a synonym and cost a migration plus a contract change.
   *
   * If it ever moves (to 'Collection', say), NO MIGRATION IS NEEDED — `kind`,
   * `itemField` and the DB column are MACHINE names and stay `project`
   * regardless. These four strings are where the change starts: the Display
   * menu's section and unset row, the item dialog's picker label and its
   * create-new row, the Organize console's rail, the grouping headings and the
   * failed-create toast all read them through `getContainerKindConfig`.
   *
   * IT IS NOT *ONLY* THESE FOUR, and pretending otherwise is how a rename ships
   * half-done. About eight user-visible strings still spell the noun by hand,
   * all of them pre-dating this record: `sections/labels.tsx` ("No projects
   * yet.", the back row, the identity row's label, the meta line),
   * `sections/trash.tsx`'s KIND_LABEL, `bulk-add-dialog.tsx`'s placeholder and
   * its "No project" option, and `day-list.tsx`'s own PROJECTS section heading —
   * which is a type-shaped section rather than this axis and may not want to
   * follow at all. Moving them here is cheap and was left out of 039 on purpose:
   * it is a copy refactor with no behaviour in it, and bundling it would have
   * hidden it inside a data migration.
   */
  project: {
    kind: 'project',
    role: 'classify',
    label: 'Project',
    labelPlural: 'Projects',
    unsetLabel: 'No project',
    /** The create-new option inside a container picker. */
    newLabel: 'New Project',
    itemField: 'project',
    itemTypeKey: 'projects',
    caseFold: true,
  },
  routine: {
    kind: 'routine',
    role: 'gate',
    label: 'Routine',
    labelPlural: 'Routines',
    unsetLabel: null,
    newLabel: 'New routine',
    itemField: null,
    itemTypeKey: null,
    caseFold: false,
  },
  season: {
    kind: 'season',
    role: 'gate',
    label: 'Season',
    labelPlural: 'Seasons',
    unsetLabel: null,
    newLabel: 'New season',
    itemField: null,
    itemTypeKey: null,
    caseFold: false,
  },
  goal: {
    kind: 'goal',
    role: 'aspire',
    label: 'Goal',
    labelPlural: 'Goals',
    // No unset state, like the gates: an item serves a goal or it does not.
    unsetLabel: null,
    newLabel: 'New goal',
    // Membership lives in goal_items, never on the item — which is what lets it
    // carry a role, and what keeps `items` (and therefore the pinned legacy
    // projections) untouched by this whole feature.
    itemField: null,
    // No item TYPE resolves against goals. `containerKind` on an item type
    // answers "which container does this type file itself under", and a goal
    // files nothing — every type may join one.
    itemTypeKey: null,
    caseFold: false,
  },
};

export const getContainerKindConfig = (kind: ContainerKind): ContainerKindConfig =>
  CONTAINER_KINDS[kind];

/**
 * Derived from the roles, never hand-listed — a fifth kind joins the right list
 * by declaring its role, and cannot be forgotten in one of two places.
 */
export const CLASSIFY_KINDS: readonly ClassifyKind[] = Object.values(CONTAINER_KINDS)
  .filter((c): c is ContainerKindConfig & { kind: ClassifyKind } => c.role === 'classify')
  .map((c) => c.kind);

export const GATE_KINDS: readonly GateKind[] = Object.values(CONTAINER_KINDS)
  .filter((c): c is ContainerKindConfig & { kind: GateKind } => c.role === 'gate')
  .map((c) => c.kind);

export const ASPIRE_KINDS: readonly AspireKind[] = Object.values(CONTAINER_KINDS)
  .filter((c): c is ContainerKindConfig & { kind: AspireKind } => c.role === 'aspire')
  .map((c) => c.kind);

/* ── the ref grammar ────────────────────────────────────────────────────────*/

/**
 * A container reference is `<kind>:<name>`.
 *
 * The prefix outlived the reason it was introduced. It was there because
 * Project and Habit Group were ONE axis with TWO namespaces, and a bare "Work"
 * could not say which it meant; 039 collapsed the namespaces, so today there is
 * only ever one kind in front of the colon.
 *
 * It stays, and not out of inertia. A ref shares a keyspace with grouping's
 * other section keys — `priority:high`, `routine:none`, `goal:none`,
 * `none:project`, `container:na` — and `containerKindOf` is what tells a
 * container ref apart from all of them (GroupSection hunts a glyph only for a
 * real ref; LaneCap picks a colour the same way). A bare name would collide
 * with every one of those the moment a user names a container "high". It is
 * also already the persisted format in `dsul-view`, so dropping it would be a
 * blob migration for no gain — `normalizeFilters` instead rewrites the retired
 * `group:` prefix to `project:` on read.
 *
 * Only CLASSIFY kinds have refs. Routines, seasons and goals are referenced by
 * id, because their names are not unique and rename ships from day one.
 */
export const containerRef = (kind: ClassifyKind, name: string): string => `${kind}:${name}`;

/** Sentinel for "carries this axis, but the value is unset". */
export const NO_CONTAINER = 'none:';

/**
 * The kind-tagged unset key — `none:project`.
 *
 * One kind means one key, so this and `NO_CONTAINER` now differ only in the
 * suffix. Kept tagged anyway: it is what keeps a heading key from ever being
 * mistaken for a real ref (no kind is named "none"), and a second classify kind
 * would need the tag back.
 */
export const unsetContainerRef = (kind: ClassifyKind): string => `${NO_CONTAINER}${kind}`;

/**
 * `project:Work` → `Work`. An unprefixed legacy value is returned as-is.
 *
 * Splits on the FIRST colon only: project names are unvalidated free text
 * (manage-categories only trims; there is no CHECK constraint), so "Client:
 * Acme" is a legal name and must survive the round trip.
 */
export function containerName(ref: string): string {
  const i = ref.indexOf(':');
  return i === -1 ? ref : ref.slice(i + 1);
}

/** `project:Work` → `'project'`, or null when the ref names no known classify kind. */
export function containerKindOf(ref: string): ClassifyKind | null {
  const i = ref.indexOf(':');
  if (i === -1) return null;
  const kind = ref.slice(0, i);
  return (CLASSIFY_KINDS as readonly string[]).includes(kind) ? (kind as ClassifyKind) : null;
}

/**
 * The classify kind an item TYPE answers with, resolved from the item registry's
 * own vocabulary — `'projects'` → `'project'`.
 *
 * The two registries name the same concept differently on purpose: the item
 * registry says which TABLE a type resolves against (plural), the ref grammar
 * says which NAMESPACE a value lives in (singular). This is the one function
 * that knows both, so neither has to learn the other's spelling. It survives the
 * collapse to one kind for the same reason `ClassifyKind` does — a type may
 * still declare `null` and carry no container axis at all.
 */
export function classifyKindForItemType(itemTypeKey: ItemTypeContainerKind): ClassifyKind | null {
  for (const kind of CLASSIFY_KINDS) {
    if (CONTAINER_KINDS[kind].itemTypeKey === itemTypeKey) return kind;
  }
  return null;
}

/**
 * The comparison key for a bare NAME of a known kind — the single expression of
 * the case policy, and the one every other fold is built from.
 *
 * Names, not refs, because that is what the store holds: `items.project` is
 * `'personal'`, `projects[i].name` is `'Personal'`, and every identity lookup
 * in planner-store.ts compares those two directly. Before A′ six of them
 * compared exactly and three folded by hand, which is how deleting the container
 * 'Personal' left an item stored as 'personal' pointing at a row that no longer
 * existed.
 */
export function foldContainerName(kind: ClassifyKind, name: string): string {
  return CONTAINER_KINDS[kind].caseFold ? name.toLowerCase() : name;
}

/** Do these two bare names name the same container of this kind? */
export const sameContainerName = (kind: ClassifyKind, a: string, b: string): boolean =>
  foldContainerName(kind, a) === foldContainerName(kind, b);

/**
 * The comparison key for a ref.
 *
 * Everything that compares, dedupes or keys on a container ref goes through
 * here: `sameContainerRef`, and `lib/grouping.ts`'s section key. Keyed on the
 * raw ref instead, one container split into two sections that the menu's
 * single checkbox selected together (shipped that way for one commit).
 *
 * Unknown and unprefixed refs pass through untouched rather than being folded
 * defensively — an unprefixed value is legacy free text whose case nothing has
 * ever folded, and `none:project` is a heading key, not a name.
 */
export function foldRef(ref: string): string {
  const kind = containerKindOf(ref);
  if (!kind) return ref;
  return containerRef(kind, foldContainerName(kind, containerName(ref)));
}

/** Do these two refs name the same container? See `foldRef` for the case policy. */
export const sameContainerRef = (a: string, b: string): boolean => foldRef(a) === foldRef(b);

/** The bare names of one kind's half of a mixed selection. */
export const namesOfKind = (refs: readonly string[], kind: ClassifyKind): string[] =>
  refs.filter((ref) => containerKindOf(ref) === kind).map(containerName);
