import { beforeEach, describe, expect, it } from 'vitest';
import { adoptLegacyViewPrefs, useViewStore } from '@/lib/view-store';
import { usePlannerStore } from '@/lib/planner-store';
import { EMPTY_VIEW_FILTERS, isEmptyFilters, normalizeFilters } from '@/lib/filters';
import { containerKindOf, containerName, containerRef, namesOfKind } from '@/lib/container-registry';

const projectNamesFrom = (refs: string[]) => namesOfKind(refs, 'project');

/**
 * The rehydration gap the e2e suite structurally cannot cover.
 *
 * zustand's persist `merge` defaults to a SHALLOW `{...current, ...persisted}`,
 * so a nested object is replaced wholesale rather than merged. A stored
 * `dsul-view` blob predates `containers`, so without a custom merge every
 * existing install reads `filters.containers` as `undefined` and `.length`
 * throws on the first render — a white screen, not a degraded filter.
 *
 * tests/e2e/helpers/session.ts seeds a blob that OMITS both filter objects, so
 * every spec rehydrates fresh defaults and stays green while a real browser
 * breaks. That is why these are unit tests against `normalizeFilters` — the
 * function the store's `merge` runs both filter objects through — rather than
 * an e2e assertion. Do not delete them on the grounds that "e2e covers this".
 */

/**
 * The store's own `merge`, exercised through a real rehydrate.
 *
 * The tests below this block cover `normalizeFilters` in isolation, which is
 * necessary but NOT sufficient: delete the whole `merge:` block from
 * view-store's persist config and every one of them still passes, because none
 * of them touches the store. So does the e2e suite — its seeded blob omits both
 * filter objects and takes the trivial branch.
 *
 * These seed the blob a real pre-Phase-0 browser holds and drive
 * `persist.rehydrate()`. Both filter objects are asserted deliberately: a
 * half-wired merge that normalizes `canvasFilters` and passes
 * `braindumpFilters` through raw type-checks fine (the payload is cast to
 * Record<string, unknown>), leaves the suite green, and still white-screens the
 * sidebar.
 */
describe('the persist merge, through a real rehydrate', () => {
  const LEGACY = {
    projects: ['Work', 'Client: Acme'],
    priorities: ['high'],
    hideCompleted: true,
  };

  const seed = (state: Record<string, unknown>) =>
    localStorage.setItem('dsul-view', JSON.stringify({ version: 1, state }));

  beforeEach(() => {
    localStorage.clear();
  });

  it('fills containers on BOTH filter objects from a legacy payload', async () => {
    seed({ canvasFilters: { ...LEGACY }, braindumpFilters: { ...LEGACY } });

    await useViewStore.persist.rehydrate();
    const s = useViewStore.getState();

    for (const filters of [s.canvasFilters, s.braindumpFilters]) {
      expect(filters.containers).toEqual(['project:Work', 'project:Client: Acme']);
      expect(filters.priorities).toEqual(['high']);
      expect(filters.hideFinished).toBe(true);
    }
  });

  it('survives a payload that carries neither filter object', async () => {
    // This is what tests/e2e/helpers/session.ts seeds — which is exactly why
    // the e2e suite cannot catch a missing merge.
    seed({ scope: 'week', layout: 'list' });

    await useViewStore.persist.rehydrate();
    const s = useViewStore.getState();

    expect(s.canvasFilters.containers).toEqual([]);
    expect(s.braindumpFilters.containers).toEqual([]);
    expect(s.scope).toBe('week');
  });

  it('keeps the other top-level keys the shallow merge was already protecting', async () => {
    seed({ canvasFilters: { ...LEGACY }, collapsedBuckets: ['morning'], weekDaysVisible: 5 });

    await useViewStore.persist.rehydrate();
    const s = useViewStore.getState();

    expect(s.collapsedBuckets).toEqual(['morning']);
    expect(s.weekDaysVisible).toBe(5);
  });

  it('does not throw on a filter object stored as the wrong type', async () => {
    seed({ canvasFilters: 'nonsense', braindumpFilters: ['also', 'nonsense'] });

    await expect(useViewStore.persist.rehydrate()).resolves.not.toThrow();
    const s = useViewStore.getState();

    expect(s.canvasFilters.containers).toEqual([]);
    expect(s.braindumpFilters.containers).toEqual([]);
  });

  it("drops a persisted 'status' grouping, which Phase 5a deleted from the union", async () => {
    // It WAS a legal GroupBy and is sitting in real payloads. Left alone it
    // falls through groupRows' branches to the container arm, so the day would
    // silently section by project — while the Grouping row rendered "None" over
    // it (no option matches) and the trigger counted it as one active clause.
    seed({ canvasGroupBy: 'status' });

    await useViewStore.persist.rehydrate();

    expect(useViewStore.getState().canvasGroupBy).toBe('none');
  });

  it('keeps a grouping value that is still legal', async () => {
    // The coercion must not be a reset in disguise.
    seed({ canvasGroupBy: 'routine' });

    await useViewStore.persist.rehydrate();

    expect(useViewStore.getState().canvasGroupBy).toBe('routine');
  });

  it('coerces a braindumpGroupBy that is not a BraindumpGroupBy, even a legal canvas GroupBy', async () => {
    // The braindump axis was uncoerced until the routine/program values landed,
    // and its union is not the canvas one — 'bucket' is a legal canvas GroupBy
    // but not a braindump value. Left alone it reaches groupRows through
    // braindump.tsx and sections the braindump by an axis its menu never offers,
    // the same hazard the canvasGroupBy 'status' case guards, on the axis this
    // file otherwise never exercises.
    seed({ braindumpGroupBy: 'bucket' });

    await useViewStore.persist.rehydrate();

    expect(useViewStore.getState().braindumpGroupBy).toBe('none');
  });

  it('keeps a braindumpGroupBy of priority, which the braindump now offers', async () => {
    seed({ braindumpGroupBy: 'priority' });

    await useViewStore.persist.rehydrate();

    expect(useViewStore.getState().braindumpGroupBy).toBe('priority');
  });

  it('keeps a braindumpGroupBy value that is still legal', async () => {
    // The coercion must not be a reset in disguise: a newly-widened value passes.
    seed({ braindumpGroupBy: 'program' });

    await useViewStore.persist.rehydrate();

    expect(useViewStore.getState().braindumpGroupBy).toBe('program');
  });
});

describe('adoptLegacyViewPrefs — the second door a stale grouping comes through', () => {
  beforeEach(() => {
    localStorage.clear();
    useViewStore.setState({ adoptedLegacy: false, canvasGroupBy: 'none' });
  });

  it("coerces 'status' out of the planner-store mirror", () => {
    // planner-storage partializes `groupBy`, so a blob written before Phase 5a
    // rehydrates planner-store with it and this copies it across on first
    // mount. The declared type says that cannot happen; the stored JSON
    // disagrees, which is the whole reason a runtime guard exists.
    usePlannerStore.setState({ groupBy: 'status' as never });

    adoptLegacyViewPrefs();

    expect(useViewStore.getState().canvasGroupBy).toBe('none');
  });

  it('still adopts a legal one', () => {
    usePlannerStore.setState({ groupBy: 'priority' });

    adoptLegacyViewPrefs();

    expect(useViewStore.getState().canvasGroupBy).toBe('priority');
  });
});

describe('normalizeFilters — rehydrating a stored payload', () => {
  it('fills in containers for a blob that predates the field', () => {
    // The exact shape a pre-Phase-0 install has in localStorage.
    const stored = { projects: ['Work', 'Home'], priorities: ['high'], hideCompleted: true };

    const merged = normalizeFilters(stored);

    expect(merged.containers).toEqual(['project:Work', 'project:Home']);
    expect(merged.priorities).toEqual(['high']);
    expect(merged.hideFinished).toBe(true);
  });

  it('yields empty arrays — never undefined — for a blob with no filter data', () => {
    // This is the case that throws without a merge: `.length` on undefined.
    for (const stored of [undefined, null, {}, 'nonsense', 42]) {
      const merged = normalizeFilters(stored);
      expect(merged.containers).toEqual([]);
      expect(merged.priorities).toEqual([]);
      // `goals` is the newest field and every stored blob predates it, so it is
      // the `containers` hazard again: `filters.goals.length` on an undefined
      // throws before the surface can render a row.
      expect(merged.goals).toEqual([]);
      expect(merged.hideFinished).toBe(false);
      expect(() => merged.containers.length).not.toThrow();
      expect(() => merged.goals.length).not.toThrow();
    }
  });

  it('keeps a stored goal selection, and drops a non-array one', () => {
    expect(normalizeFilters({ goals: ['g1', 'g2'] }).goals).toEqual(['g1', 'g2']);
    expect(normalizeFilters({ goals: 'g1' }).goals).toEqual([]);
  });

  it('is idempotent — an already-normalized value passes through unchanged', () => {
    // The merge runs on every rehydrate, so a second pass must not re-prefix.
    const once = normalizeFilters({ projects: ['Work'] });
    const twice = normalizeFilters(once);
    expect(twice).toEqual(once);
    expect(twice.containers).toEqual(['project:Work']);
  });

  it('prefixes a legacy name that CONTAINS a colon, rather than assuming it is a ref', () => {
    // Project names are unvalidated free text — manage-categories only trims,
    // and no migration adds a CHECK. A contains-a-colon test would leave this
    // bare, `projectNamesFrom` would drop it, and the project filter would
    // silently stop narrowing while the trigger still counted one active
    // clause. This asserts the whole round trip, not just the prefixing.
    const merged = normalizeFilters({ projects: ['Client: Acme', 'Work'] });

    expect(merged.containers).toEqual(['project:Client: Acme', 'project:Work']);
    expect(projectNamesFrom(merged.containers)).toEqual(['Client: Acme', 'Work']);
  });

  it('prefixes a legacy name that looks like a ref for the retired namespace', () => {
    // A project literally named "group:health" is a legal project name. Treated
    // as an already-formed ref it would have resolved to a habit GROUP — the
    // wrong container entirely. The legacy array only ever held project names,
    // so it is prefixed unconditionally.
    const merged = normalizeFilters({ projects: ['group:health'] });

    expect(merged.containers).toEqual(['project:group:health']);
    expect(projectNamesFrom(merged.containers)).toEqual(['group:health']);
  });

  /**
   * THE RETIRED KIND, rewritten on read (migration 039).
   *
   * A blob written before the collapse holds `group:Health`, and
   * `containerKindOf` answers null for it now — so `namesOfKind` drops it, the
   * menu never shows it ticked, and `passesContainerFilter` narrows to the
   * OTHER selections only while `activeFilterCount` still counts the clause.
   * The filter reads as active and quietly answers a different question.
   * localStorage survives the reload that would otherwise fix it, which is what
   * makes this a rewrite rather than a drop.
   */
  it('rewrites a retired group: ref into the one classify namespace', () => {
    const merged = normalizeFilters({ containers: ['project:Work', 'group:Health'] });
    expect(merged.containers).toEqual(['project:Work', 'project:Health']);
  });

  it('does not leave a duplicate when a blob held both spellings', () => {
    // Two containers named Work could exist before the collapse, one on each
    // side of the axis. Rewritten naively the chip row renders "Work" twice and
    // one click toggles only one of them off.
    const merged = normalizeFilters({ containers: ['project:Work', 'group:Work'] });
    expect(merged.containers).toEqual(['project:Work']);
  });

  it('leaves a blob with no retired refs strictly alone', () => {
    // Identity, not merely equality: the rewrite must not churn a new array on
    // every rehydrate.
    const containers = ['project:Work'];
    expect(normalizeFilters({ containers }).containers).toBe(containers);
  });

  it('prefers the new field when a blob carries both', () => {
    const merged = normalizeFilters({
      projects: ['Stale'],
      containers: ['project:Fresh'],
      hideCompleted: false,
      hideFinished: true,
    });
    expect(merged.containers).toEqual(['project:Fresh']);
    expect(merged.hideFinished).toBe(true);
  });

  it('drops a non-array containers value rather than passing it through', () => {
    expect(normalizeFilters({ containers: 'project:Work' }).containers).toEqual([]);
  });
});

describe('the container vocabulary', () => {
  it('reads a retired-kind ref as no kind at all', () => {
    // Which is exactly why normalizeFilters rewrites it before it can reach a
    // filter clause.
    expect(containerKindOf('group:Work')).toBeNull();
    expect(projectNamesFrom(['group:Work'])).toEqual([]);
  });

  it('round-trips a name through a ref', () => {
    expect(containerName(containerRef('project', 'Side project'))).toBe('Side project');
    expect(containerKindOf(containerRef('project', 'health'))).toBe('project');
  });

  it('survives a name containing a colon', () => {
    const ref = containerRef('project', 'Q3: launch');
    expect(containerName(ref)).toBe('Q3: launch');
    expect(containerKindOf(ref)).toBe('project');
    expect(projectNamesFrom([ref])).toEqual(['Q3: launch']);
  });

  it('reports no kind for an unprefixed legacy value', () => {
    expect(containerKindOf('Work')).toBeNull();
    expect(containerName('Work')).toBe('Work');
  });
});

describe('isEmptyFilters', () => {
  it('is true for the shared empty and false once any clause is set', () => {
    expect(isEmptyFilters(EMPTY_VIEW_FILTERS)).toBe(true);
    expect(isEmptyFilters({ ...EMPTY_VIEW_FILTERS, containers: ['project:Work'] })).toBe(false);
    expect(isEmptyFilters({ ...EMPTY_VIEW_FILTERS, priorities: ['high'] })).toBe(false);
    expect(isEmptyFilters({ ...EMPTY_VIEW_FILTERS, hideFinished: true })).toBe(false);
    expect(isEmptyFilters({ ...EMPTY_VIEW_FILTERS, goals: ['g1'] })).toBe(false);
  });
});

/**
 * A rename now has to reach the PERSISTED filter refs (migration 027 / Phase 0b).
 *
 * `containers` holds `project:Work` — a NAME, in localStorage, from before
 * containers had stable ids. Renaming was parked until 027, so these could never
 * go stale; now they can, and a stale ref does not degrade gracefully.
 * `passesContainerFilter` matches nothing, so the canvas or the braindump
 * empties completely and the only clue on screen is a filter chip naming a
 * project that no longer exists.
 */
describe('renameContainerRef follows a container rename', () => {
  beforeEach(() => {
    useViewStore.setState({
      canvasFilters: { ...EMPTY_VIEW_FILTERS, containers: ['project:Work', 'project:Wellness'] },
      braindumpFilters: { ...EMPTY_VIEW_FILTERS, containers: ['project:Work'] },
    });
  });

  it('rewrites the ref in both filter sets', () => {
    useViewStore.getState().renameContainerRef('Work', 'Deep Work');
    expect(useViewStore.getState().canvasFilters.containers).toContain('project:Deep Work');
    expect(useViewStore.getState().canvasFilters.containers).not.toContain('project:Work');
    expect(useViewStore.getState().braindumpFilters.containers).toEqual(['project:Deep Work']);
  });

  it('leaves a value that merely CONTAINS the old name alone', () => {
    // The rewrite is on the whole ref, not on a substring: a container called
    // "Work Log" must not be dragged along by a rename of "Work". (This used to
    // assert that a `group:Work` ref stayed put — the second namespace is gone,
    // but the exact-match property it was really testing is not.)
    useViewStore.setState({
      canvasFilters: { ...EMPTY_VIEW_FILTERS, containers: ['project:Work', 'project:Work Log'] },
    });
    useViewStore.getState().renameContainerRef('Work', 'Deep Work');
    expect(useViewStore.getState().canvasFilters.containers).toEqual([
      'project:Deep Work',
      'project:Work Log',
    ]);
  });

  it('does not leave a duplicate when both were selected', () => {
    useViewStore.setState({
      canvasFilters: { ...EMPTY_VIEW_FILTERS, containers: ['project:Work', 'project:Home'] },
    });
    useViewStore.getState().renameContainerRef('Work', 'Home');
    expect(useViewStore.getState().canvasFilters.containers).toEqual(['project:Home']);
  });

  it('is inert when nothing referenced the old name', () => {
    const before = useViewStore.getState().canvasFilters;
    useViewStore.getState().renameContainerRef('Untouched', 'Renamed');
    expect(useViewStore.getState().canvasFilters).toBe(before);
  });

  /**
   * The remap is driven by the STORE, not by the rename call site — which is
   * what makes undo work. Fired optimistically from the console it had no
   * inverse: undo restored the container's old name and the ref kept the new
   * one, so one ⌘Z after a rename emptied the canvas. Worse than the stale ref
   * it was added to prevent, because localStorage survives the reload that
   * would otherwise have repaired it.
   */
  it('follows a rename made through the planner store', () => {
    usePlannerStore.setState({
      projects: [{ id: 'pr1', name: 'Work', emoji: 'icon:Briefcase' }],
    });
    usePlannerStore.setState({
      projects: [{ id: 'pr1', name: 'Deep Work', emoji: 'icon:Briefcase' }],
    });
    expect(useViewStore.getState().canvasFilters.containers).toContain('project:Deep Work');
  });

  it('follows it BACK when the rename is reverted', () => {
    usePlannerStore.setState({
      projects: [{ id: 'pr1', name: 'Work', emoji: 'icon:Briefcase' }],
    });
    usePlannerStore.setState({
      projects: [{ id: 'pr1', name: 'Deep Work', emoji: 'icon:Briefcase' }],
    });
    // What undo does: same id, previous name.
    usePlannerStore.setState({
      projects: [{ id: 'pr1', name: 'Work', emoji: 'icon:Briefcase' }],
    });
    expect(useViewStore.getState().canvasFilters.containers).toContain('project:Work');
    expect(useViewStore.getState().canvasFilters.containers).not.toContain('project:Deep Work');
  });

  it('ignores a DIFFERENT container that merely arrives holding the old name', () => {
    // Keyed on the id, so deleting Work and creating an unrelated project later
    // named Work does not retarget a ref that belonged to the first one.
    usePlannerStore.setState({
      projects: [{ id: 'pr1', name: 'Work', emoji: 'icon:Briefcase' }],
    });
    usePlannerStore.setState({
      projects: [{ id: 'pr2', name: 'Something Else', emoji: 'icon:Briefcase' }],
    });
    expect(useViewStore.getState().canvasFilters.containers).toContain('project:Work');
  });
});
