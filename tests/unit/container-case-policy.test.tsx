// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase A′ — the case policy stops being read-time patchwork.
 *
 * Phase A gave `caseFold` one home. It did not change what the STORE does, and
 * the store is where the asymmetry actually bit: three lookups folded by hand
 * (`getHabitGroupColor`, `getHabitGroupEmoji`, `addHabitGroup`'s duplicate
 * check) and the two verbs that REPAIR references compared exactly. So a habit
 * stored as 'personal' — which `makeAddDraft` writes against the seeded
 * 'Personal' whenever the container list has not loaded yet — took the folded
 * colour and the folded emoji, and then survived the deletion of its own
 * container pointing at a row that no longer existed.
 *
 * MIGRATION 039 MADE THE POLICY UNIVERSAL rather than deleting half of it.
 * There was one folding kind (habit groups) and one exact kind (projects); the
 * merged kind kept the FOLDING half, because the 'personal' write above is
 * still there and taking the exact half would have re-opened the bug on the day
 * the kinds merged. So the assertions below moved from "these fold, those do
 * not" to "these fold, and here is what that costs" — a user holding both
 * `Work` and `work` as containers now resolves both to one row, which is
 * asserted just as hard as the folding itself so the trade is visible rather
 * than discovered.
 */

vi.mock('@/lib/db', () => ({
  fetchItems: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => []),
  fetchItemTypes: vi.fn(async () => []),
  createItemType: vi.fn(async () => {}),
  updateItemType: vi.fn(async () => {}),
  deleteItemType: vi.fn(async () => {}),
  createItem: vi.fn(async () => {}),
  updateItem: vi.fn(async () => {}),
  deleteItem: vi.fn(async () => {}),
  restoreItem: vi.fn(async () => {}),
  setItemCompletion: vi.fn(async () => {}),
  createProject: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  deleteProject: vi.fn(async () => {}),
  restoreProject: vi.fn(async () => {}),
  fetchRoutines: vi.fn(async () => []),
  createRoutine: vi.fn(async () => {}),
  updateRoutine: vi.fn(async () => {}),
  deleteRoutine: vi.fn(async () => {}),
  restoreRoutine: vi.fn(async () => {}),
  fetchSeasons: vi.fn(async () => []),
  createSeason: vi.fn(async () => {}),
  updateSeason: vi.fn(async () => {}),
  deleteSeason: vi.fn(async () => {}),
  restoreSeason: vi.fn(async () => {}),
  fetchGoals: vi.fn(async () => []),
  createGoal: vi.fn(async () => {}),
  updateGoal: vi.fn(async () => {}),
  deleteGoal: vi.fn(async () => {}),
  restoreGoal: vi.fn(async () => {}),
}));
vi.mock('@/lib/settings-service', () => ({ saveSettings: vi.fn(async () => {}) }));

import { render, cleanup } from '@testing-library/react';
import { usePlannerStore } from '@/lib/planner-store';
import { GroupSection } from '@/components/primitives/group-section';
import type { Item, Project } from '@/lib/planner-types';

const CONTAINERS: Project[] = [
  { id: 'p-personal', name: 'Personal', emoji: '⭐' },
  { id: 'p-health', name: 'Health', emoji: '💚' },
];

const task = (id: string, project?: string): Item =>
  ({ type: 'task', id, title: id, status: 'pending', isScheduled: false, order: 0, project }) as Item;

const habit = (id: string, project: string): Item =>
  ({
    type: 'habit',
    id,
    title: id,
    status: 'pending',
    repeatFrequency: 'daily',
    completedDates: [],
    skippedDates: [],
    streak: 0,
    project,
  }) as unknown as Item;

function seed(items: Item[], projects: Project[] = CONTAINERS) {
  usePlannerStore.setState({
    userId: 'user-1',
    userTimezone: 'UTC',
    items,
    projects,
  });
}

const store = () => usePlannerStore.getState();
const containerOf = (id: string) =>
  store().items.find((i) => i.id === id) as unknown as { project?: string };

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe('removeProject reassigns every spelling of the deleted container', () => {
  it('catches a habit stored in a different case', () => {
    // The exact case makeAddDraft produces: lowercase 'personal' written against
    // the seeded 'Personal'. Before A′ this habit kept pointing at a container
    // that no longer existed — the orphan the reassignment exists to prevent.
    // Three spellings, for the same reason the orphan sweep below takes two:
    // a one-sided fold passes whichever case happens to match already.
    seed([
      habit('h1', 'personal'),
      habit('h2', 'PERSONAL'),
      habit('h3', 'Personal'),
      habit('h4', 'Health'),
    ]);

    store().removeProject('p-personal');

    // Every spelling caught. Unfiled since habits' project became optional
    // (2026-10-01) — `unfiled` in planner-store reads `containerRequired`.
    expect(containerOf('h1').project).toBeUndefined();
    expect(containerOf('h2').project).toBeUndefined();
    expect(containerOf('h3').project).toBeUndefined();
    expect(containerOf('h4').project).toBe('Health');
  });

  it('leaves items in other containers alone', () => {
    seed([habit('h1', 'personal'), habit('h3', 'Health')]);
    store().removeProject('p-personal');
    expect(containerOf('h3').project).toBe('Health');
  });

  it('UNFILES a task and a habit alike, now that both containers are optional', () => {
    // The merged action asks the registry (`containerRequired`) rather than
    // whether the item is a habit. Habits answered "required" until 2026-10-01,
    // when they were reassigned here instead; now no shipped type is.
    seed([task('t1', 'Personal'), habit('h1', 'Personal')]);
    store().removeProject('p-personal');
    expect(containerOf('t1').project).toBeUndefined();
    expect(containerOf('h1').project).toBeUndefined();
  });

  it('folds for a TASK too, now that one policy covers the axis', () => {
    // Before 039 this was the asserted opposite: projects compared exactly, so
    // deleting 'Work' left an item stored as 'work' filed under a container that
    // no longer existed. That is the cost the merge accepted in the other
    // direction — two containers differing only in case are now one to every
    // lookup — and it is pinned here so the trade cannot be made silently.
    seed([task('t1', 'Work'), task('t2', 'work')], [{ id: 'p-work', name: 'Work', emoji: '💼' }]);

    store().removeProject('p-work');

    expect(containerOf('t1').project).toBeUndefined();
    expect(containerOf('t2').project).toBeUndefined();
  });
});

describe('cleanupOrphanedReferences asks the same question the rest of the app does', () => {
  /**
   * BOTH spellings, deliberately. The sweep folds twice — once building the set
   * of live names, once asking about the item — and a fixture that only differs
   * on one side pins only one of them. 'personal' against the stored 'Personal'
   * catches an unfolded SET; 'PERSONAL' catches an unfolded LOOKUP, which the
   * lowercase case cannot, because it already equals its own folded form.
   */
  it('does not call a case-variant container an orphan, in either direction', () => {
    seed([habit('h1', 'personal'), habit('h2', 'PERSONAL'), task('t1', 'health')]);
    store().cleanupOrphanedReferences();
    expect(containerOf('h1').project).toBe('personal');
    expect(containerOf('h2').project).toBe('PERSONAL');
    expect(containerOf('t1').project).toBe('health');
  });

  it('unfiles a habit whose container is genuinely gone, as it does a task', () => {
    seed([habit('h1', 'ghost')]);
    store().cleanupOrphanedReferences();
    expect(containerOf('h1').project).toBeUndefined();
  });

  it('unfiles a task whose container is genuinely gone', () => {
    seed([task('t1', 'ghost')]);
    store().cleanupOrphanedReferences();
    expect(containerOf('t1').project).toBeUndefined();
  });
});

describe('the folded lookups still fold after the kinds merged', () => {
  it('rejects a case-variant container as a duplicate', () => {
    seed([], []);
    store().addProject('Personal', '⭐');
    store().addProject('personal', '⭐');
    expect(store().projects.filter((p) => p.name.toLowerCase() === 'personal')).toHaveLength(1);
  });

  it('resolves a stored colour and glyph through any spelling', () => {
    usePlannerStore.setState({
      projects: [{ id: 'p-x', name: 'Personal', emoji: '⭐', color: 'var(--picked)' }],
    });
    expect(store().getProjectColor('personal')).toBe('var(--picked)');
    expect(store().getProjectColor('PERSONAL')).toBe('var(--picked)');
    expect(store().getProjectEmoji('PERSONAL')).toBe('⭐');
  });

  /**
   * WHAT THE FOLD COSTS WHEN TWO CONTAINER ROWS COLLIDE — the case migration 039
   * refuses to run against (its section 1b), pinned here so the refusal has a
   * reason on this side of the line rather than only in SQL.
   *
   * It is not merely "one row is unreachable by name". Deleting EITHER row
   * unfiles the OTHER one's members, because `removeProject` matches with
   * `sameContainerName` — collateral damage across a container the user did not
   * touch. There is no app-side fix: folding is what makes a habit stored as
   * 'personal' resolve against a seeded 'Personal', and the two rows are
   * genuinely indistinguishable to every lookup once it is on.
   */
  it('cannot tell two live case-variant containers apart — the 039 pre-flight case', () => {
    const PAIR: Project[] = [
      { id: 'p-upper', name: 'Work', emoji: '💼' },
      { id: 'p-lower', name: 'work', emoji: '📐' },
    ];
    seed([task('t-upper', 'Work'), task('t-lower', 'work')], PAIR);

    // Both names resolve to the FIRST row in store order; the second is
    // unreachable by name, and takes the first's glyph.
    expect(store().getProject('Work')?.id).toBe('p-upper');
    expect(store().getProject('work')?.id).toBe('p-upper');
    expect(store().getProjectEmoji('work')).toBe('💼');

    // …and the collateral damage: deleting the upper row unfiles the lower
    // row's item too, while `p-lower` itself survives.
    store().removeProject('p-upper');
    expect(store().projects.map((p) => p.id)).toEqual(['p-lower']);
    expect(containerOf('t-upper').project).toBeUndefined();
    expect(containerOf('t-lower').project).toBeUndefined();
  });

  it('keeps the three legacy habit tokens on the merged colour getter', () => {
    // They came over from `getHabitGroupColor`. Dropping them would restyle
    // every account still holding a Wellness / Work / Personal container.
    usePlannerStore.setState({ projects: [] });
    expect(store().getProjectColor('Personal')).toBe('var(--habit-personal)');
    expect(store().getProjectColor('work')).toBe('var(--habit-work)');
    expect(store().getProjectColor('Wellness')).toBe('var(--habit-wellness)');
  });
});

/**
 * The glyph is resolved from the group KEY, not from the label.
 *
 * A label has had its namespace thrown away, and a heading is not the only
 * thing that can be called "Morning". The live path is narrow but real: a
 * *picked* icon (`icon:Anchor`) on a project named like a priority or bucket
 * label put that icon on the grouping heading. A seeded emoji is not an icon
 * token, so it falls through to the name-derived icon either way — which is
 * why this went unnoticed and why the fixtures below pick icons explicitly.
 */
describe('GroupSection resolves its glyph from the key, not the label', () => {
  const iconOf = (el: HTMLElement) => el.querySelector('svg')?.getAttribute('class') ?? '';

  it('does not let a project named "High" decorate the Priority heading', () => {
    usePlannerStore.setState({
      projects: [{ id: 'p-high', name: 'High', emoji: 'icon:Anchor' }],
    });

    const { container } = render(
      <GroupSection label="High" groupKey="priority:high">
        <div />
      </GroupSection>
    );

    expect(iconOf(container)).not.toContain('lucide-anchor');
  });

  it('resolves a container section through the container namespace', () => {
    usePlannerStore.setState({
      projects: [{ id: 'p-personal', name: 'Personal', emoji: 'icon:Anchor' }],
    });

    const { container } = render(
      <GroupSection label="Personal" groupKey="project:Personal">
        <div />
      </GroupSection>
    );

    expect(iconOf(container)).toContain('lucide-anchor');
  });

  it('folds the container key when looking the container up', () => {
    // groupRows emits a FOLDED key (`project:personal`) while the store holds
    // the stored spelling ('Personal'), so the lookup has to fold too or every
    // container heading loses its picked icon.
    usePlannerStore.setState({
      projects: [{ id: 'p-personal', name: 'Personal', emoji: 'icon:Star' }],
    });

    const { container } = render(
      <GroupSection label="Personal" groupKey="project:personal">
        <div />
      </GroupSection>
    );

    expect(iconOf(container)).toContain('lucide-star');
  });

  it('makes no container lookup at all for a section that is not one', () => {
    // 'Habits' / 'Tasks' / 'Projects' are Day × List's own type sections, and a
    // project literally called "Tasks" must not decorate them. A retired
    // `group:` key is in the same boat — it names no kind.
    usePlannerStore.setState({
      projects: [{ id: 'p-tasks', name: 'Tasks', emoji: 'icon:Anchor' }],
    });

    const { container } = render(
      <GroupSection label="Tasks" groupKey="Tasks">
        <div />
      </GroupSection>
    );

    expect(iconOf(container)).not.toContain('lucide-anchor');
  });
});
