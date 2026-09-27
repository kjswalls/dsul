import { describe, it, expect } from 'vitest';
import {
  ASPIRE_KINDS,
  CLASSIFY_KINDS,
  CONTAINER_KINDS,
  GATE_KINDS,
  NO_CONTAINER,
  classifyKindForItemType,
  containerKindOf,
  containerName,
  containerRef,
  foldContainerName,
  foldRef,
  getContainerKindConfig,
  sameContainerName,
  namesOfKind,
  sameContainerRef,
  unsetContainerRef,
  type ContainerKind,
} from '@/lib/container-registry';
import { getAllItemTypeNames, getItemTypeConfig } from '@/lib/item-registry';
import { containerRefOf } from '@/lib/filters';
import type { Item } from '@/lib/planner-types';

/**
 * Phase A — the container registry.
 *
 * Two things are being pinned, and they are different in kind. The first is the
 * ROLE SEAM: classify kinds are the ones an item answers with, gate kinds are
 * the ones that switch it off, aspire kinds are the ones that say why the work
 * matters, and no kind may hold two of those jobs. That seam is what keeps a
 * routine out of a filter clause, a project out of the scope rail, and a goal
 * out of both — and it is stated once here rather than implied by which module
 * you happen to be reading.
 *
 * This test is also the tripwire that a new KIND has to walk past. Widening
 * `ContainerKind` produces exactly one compiler error (the CONTAINER_KINDS
 * record) because every consumer narrows to one role's union first, so nothing
 * else in the codebase objects on its own — see the note in the registry's
 * header. The partition assertions below are what force the question.
 *
 * The second is the REF GRAMMAR, which moved out of lib/filters.ts unchanged.
 * Its cases are all real data: names with colons in them, both spellings of a
 * container, and the legacy unprefixed values a stored payload still holds.
 *
 * Migration 039 collapsed the two classify kinds into one. The seam assertions
 * are unchanged in shape and are what pins that the ROLES survived it: one
 * classify kind, two gates, one aspire, and nothing in two boxes.
 */

describe('the role seam', () => {
  it('sorts the four kinds into classify, gate and aspire, and nothing sits in two', () => {
    // ONE classify kind since 039 - `group` was the same shape wearing a second
    // name. The three ROLES are intact, which is the property this file exists
    // to hold: collapsing a kind must not collapse a role.
    expect([...CLASSIFY_KINDS]).toEqual(['project']);
    expect([...GATE_KINDS]).toEqual(['routine', 'season']);
    expect([...ASPIRE_KINDS]).toEqual(['goal']);

    const all = Object.keys(CONTAINER_KINDS) as ContainerKind[];
    expect(all.length).toBe(CLASSIFY_KINDS.length + GATE_KINDS.length + ASPIRE_KINDS.length);
    // Exactly one membership each — asserted as a count rather than the old
    // `inClassify === !inGate`, which only had two boxes to talk about and
    // would have quietly passed a kind that was in all three.
    for (const kind of all) {
      const memberships = [CLASSIFY_KINDS, GATE_KINDS, ASPIRE_KINDS].filter((list) =>
        (list as readonly string[]).includes(kind),
      );
      expect(memberships).toHaveLength(1);
    }
  });

  it('derives the three lists from `role`, so a kind cannot be forgotten in one of them', () => {
    // The lists are Object.values(...).filter(role === …) rather than literals.
    // If any is ever hand-listed this disagrees the moment a role changes.
    for (const kind of CLASSIFY_KINDS) expect(getContainerKindConfig(kind).role).toBe('classify');
    for (const kind of GATE_KINDS) expect(getContainerKindConfig(kind).role).toBe('gate');
    for (const kind of ASPIRE_KINDS) expect(getContainerKindConfig(kind).role).toBe('aspire');
  });

  it('keeps goals out of the two axes that resolve visibility', () => {
    // The whole argument for a third role rather than a fourth gate. A goal
    // that reached ScopeKind would suppress its members the day someone paused
    // it; a goal that reached a container REF would make "which project is this
    // in?" ambiguous. Both unions are narrowed at their use sites, so this
    // asserts the property those narrowings depend on.
    const goal = getContainerKindConfig('goal');
    expect(goal.itemField).toBeNull();
    expect(goal.itemTypeKey).toBeNull();
    expect(goal.unsetLabel).toBeNull();
    expect((CLASSIFY_KINDS as readonly string[]).includes('goal')).toBe(false);
    expect((GATE_KINDS as readonly string[]).includes('goal')).toBe(false);
  });

  /**
   * The load-bearing half. A gate is many-to-many through a join table, so it
   * has no column on the item and no unset state — an item is in a routine or it
   * is not. Give one an `itemField` and `containerRefOf` starts answering with
   * it, which is the filter axis quietly acquiring a value no single item can
   * hold.
   */
  it('gives every classify kind an item field and an unset label, and no gate kind either', () => {
    for (const kind of CLASSIFY_KINDS) {
      const config = getContainerKindConfig(kind);
      expect(config.itemField).not.toBeNull();
      expect(config.unsetLabel).toBeTruthy();
      expect(config.itemTypeKey).not.toBeNull();
    }
    for (const kind of GATE_KINDS) {
      const config = getContainerKindConfig(kind);
      expect(config.itemField).toBeNull();
      expect(config.unsetLabel).toBeNull();
      expect(config.itemTypeKey).toBeNull();
    }
  });

  /**
   * A gate kind is not a ref namespace. `routine:abc` looks exactly like a
   * container ref and must still resolve to null, or a routine id could be
   * dropped into `filters.containers` and read as a container the user picked.
   */
  it('refuses to read a gate kind as a ref namespace', () => {
    for (const kind of GATE_KINDS) {
      expect(containerKindOf(`${kind}:some-uuid`)).toBeNull();
    }
  });

  /**
   * Cross-registry: the field a classify kind names must actually exist on the
   * item types that resolve to it. `fields` is Object.keys(taskShape) /
   * Object.keys(habitShape), so this is checked against the wire schemas rather
   * than against a second copy of them — which is the check that bites when
   * packages/types moves in Phase B.
   */
  it('names a field the item types carrying that kind actually have', () => {
    for (const typeName of getAllItemTypeNames()) {
      const config = getItemTypeConfig(typeName);
      const kind = classifyKindForItemType(config.containerKind);
      if (kind === null) continue;
      const field = getContainerKindConfig(kind).itemField!;
      expect(config.fields, `${typeName} carries ${field}`).toContain(field);
    }
  });
});

describe('the ref grammar', () => {
  it('round-trips a name containing a colon', () => {
    // Project names are unvalidated free text — manage-categories only trims,
    // and there is no CHECK constraint — so "Client: Acme" is a legal name.
    const ref = containerRef('project', 'Client: Acme');
    expect(containerKindOf(ref)).toBe('project');
    expect(containerName(ref)).toBe('Client: Acme');
  });

  it('returns an unprefixed legacy value as-is, with no kind', () => {
    expect(containerName('Work')).toBe('Work');
    expect(containerKindOf('Work')).toBeNull();
  });

  it('no longer has a second namespace to keep apart', () => {
    // There WAS one: DEFAULT_PROJECTS and DEFAULT_HABIT_GROUPS both seeded
    // Work, and `project:Work` had to be distinguishable from `group:Work`.
    // 039 removed the ambiguity at the source, and the retired prefix must now
    // read as no kind at all - which is exactly what makes `normalizeFilters`
    // rewrite a stored `group:` ref instead of silently ignoring it.
    expect(containerKindOf('group:Work')).toBeNull();
    expect(CLASSIFY_KINDS).toHaveLength(1);
  });

  it('tags the unset key by kind, and cannot collide with a real ref', () => {
    expect(unsetContainerRef('project')).toBe(`${NO_CONTAINER}project`);
    // 'none' is not a kind, so a heading key never reads as a container.
    expect(containerKindOf(unsetContainerRef('project'))).toBeNull();
  });

  it('splits a selection by kind, ignoring what is not a container ref', () => {
    const refs = [
      containerRef('project', 'Work'),
      // A retired-kind ref and a bare legacy name are both dropped, which is
      // why normalizeFilters rewrites the first before it can get this far.
      'group:Work',
      containerRef('project', 'Q3: launch'),
      'legacy-bare-name',
    ];
    expect(namesOfKind(refs, 'project')).toEqual(['Work', 'Q3: launch']);
  });
});

describe('the case policy', () => {
  /**
   * THE MERGED KIND FOLDS. It inherited the habit-group half's policy rather
   * than the project half's, and that direction is the whole decision:
   * `makeAddDraft` writes a lowercase 'personal' against a capitalised
   * 'Personal' whenever the container list has not loaded yet, so both
   * spellings live in real data and the menu's single "Personal" checkbox has
   * to select them together. Taking the exact half instead would have re-opened
   * that bug on the day the kinds merged.
   */
  it('folds container refs, whatever the spelling', () => {
    expect(sameContainerRef('project:Personal', 'project:personal')).toBe(true);
    expect(sameContainerRef('project:Work', 'project:work')).toBe(true);
    // Different names still differ - folding is case-only.
    expect(sameContainerRef('project:Work', 'project:Home')).toBe(false);
  });

  it('reads the policy off `caseFold` rather than off the prefix string', () => {
    // The assertion that makes A′ a one-line change: whatever each kind's flag
    // says, foldRef agrees with it.
    for (const kind of CLASSIFY_KINDS) {
      const folds = getContainerKindConfig(kind).caseFold;
      expect(sameContainerRef(containerRef(kind, 'Mixed Case'), containerRef(kind, 'mixed case'))).toBe(
        folds
      );
    }
  });

  it('leaves unprefixed and unset refs untouched', () => {
    // An unprefixed value is legacy free text whose case nothing has ever
    // folded; `none:project` is a heading key, not a name.
    expect(foldRef('Work')).toBe('Work');
    expect(foldRef(unsetContainerRef('project'))).toBe(unsetContainerRef('project'));
    expect(foldRef(NO_CONTAINER)).toBe(NO_CONTAINER);
  });

  it('answers the same question for a bare name as for a ref', () => {
    // The store holds bare names - `items.project` is 'personal',
    // `projects[i].name` is 'Personal' - so the name-level API is what every
    // identity lookup in planner-store.ts calls. It must not be a second policy.
    for (const kind of CLASSIFY_KINDS) {
      expect(sameContainerName(kind, 'Mixed Case', 'mixed case')).toBe(
        sameContainerRef(containerRef(kind, 'Mixed Case'), containerRef(kind, 'mixed case'))
      );
    }
    expect(foldContainerName('project', 'Personal')).toBe('personal');
  });

  it('does not fold a ref whose prefix is merely case-similar to a kind', () => {
    // 'PROJECT:a' names no kind, so it is not a container ref and must not
    // match one.
    expect(sameContainerRef('project:a', 'PROJECT:a')).toBe(false);
  });
});

describe('containerRefOf reads the field the registry names', () => {
  const asItem = (partial: Record<string, unknown>) => partial as unknown as Item;

  it('resolves every type through the one kind, with no task/habit branch', () => {
    expect(containerRefOf(asItem({ type: 'task', project: 'Work' }))).toBe('project:Work');
    expect(containerRefOf(asItem({ type: 'habit', project: 'health' }))).toBe('project:health');
    expect(containerRefOf(asItem({ type: 'custom', customType: 'goal', project: 'Work' }))).toBe(
      'project:Work'
    );
  });

  it('reads the RETIRED column as nothing, never as a container', () => {
    // `items."group"` survives as frozen ballast and `itemFromRow` no longer
    // maps it onto the item. A row that somehow still carries one answers
    // unset - the field is chosen by the registry, not by whichever one is
    // populated.
    expect(containerRefOf(asItem({ type: 'habit', group: 'health' }))).toBe(NO_CONTAINER);
    expect(containerRefOf(asItem({ type: 'task', group: 'health' }))).toBe(NO_CONTAINER);
  });

  it('treats an empty string as unset', () => {
    // itemFromRow maps an unset container to '', so '' is live data.
    expect(containerRefOf(asItem({ type: 'habit', project: '' }))).toBe(NO_CONTAINER);
    expect(containerRefOf(asItem({ type: 'task' }))).toBe(NO_CONTAINER);
  });
});

describe('classifyKindForItemType', () => {
  it('translates between the two registries\' spellings', () => {
    // The item registry names the TABLE (plural), the ref grammar names the
    // NAMESPACE (singular). This is the one function that knows both.
    expect(classifyKindForItemType('projects')).toBe('project');
    expect(classifyKindForItemType(null)).toBeNull();
  });

  it('agrees with every shipped item type', () => {
    // Including the habit, which is the point of 039: a habit answers on the
    // same axis as a task, and `containerRequired` is what still makes it
    // different.
    for (const typeName of getAllItemTypeNames()) {
      expect(classifyKindForItemType(getItemTypeConfig(typeName).containerKind)).toBe('project');
    }
    expect(getItemTypeConfig('habit').containerRequired).toBe(true);
    expect(getItemTypeConfig('task').containerRequired).toBe(false);
  });
});

describe('inline creation is offered from the item dialog for every kind (C2)', () => {
  it('names a create row on all four kinds, not projects alone', () => {
    // Used to be projects-only — gates and goals were created solely in the
    // console. "Attach this to a NEW goal/routine/season" is a real add-dialog
    // gesture now, so each kind names its create row. A regression to null here
    // silently drops the InlineCreate row from that kind's membership chip.
    for (const kind of ['project', 'routine', 'season', 'goal'] as const) {
      expect(CONTAINER_KINDS[kind].newLabel).toBeTruthy();
      expect(typeof CONTAINER_KINDS[kind].newLabel).toBe('string');
    }
    expect(CONTAINER_KINDS.routine.newLabel).toBe('New routine');
    expect(CONTAINER_KINDS.season.newLabel).toBe('New season');
    expect(CONTAINER_KINDS.goal.newLabel).toBe('New goal');
  });
});
