// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * WHICH CONTAINERS AN ITEM MAY JOIN — the pure answer, and the two surfaces
 * that render it differently on purpose.
 *
 * Ticket D4 gave the item surface a stack of labelled BANDS: Project
 * (classify), Routine and Program (gate), Goal (aspire), ordered by the ROLE
 * that lib/container-registry.ts spends four screens distinguishing and which,
 * as five identical pills in source order, had reached the user as no
 * distinction at all.
 *
 * Every EDITING surface has since dropped the band stack for the Clearing
 * field — one label-less wrapping row of the properties the item actually
 * carries, with the rest folded behind one "+ Add property" seed. The bands
 * survive on /item/[id], where `ContainerBandsReadout` is a readout rather
 * than a form and an empty row is a way in rather than a blank.
 *
 * Four claims are load-bearing here, and each is a thing a later edit could
 * quietly undo:
 *
 *  1. THE ORDER AND THE SET ARE DERIVED. `CONTAINER_BANDS` iterates the
 *     registry and sorts by ROLE. Hand-listing the four kinds would look
 *     identical today and would silently drop the fifth. The field wraps into
 *     one row and the seed menu is flat, so role order is the only thing left
 *     deciding what the eye meets first.
 *  2. THE LABEL IS THE REGISTRY'S NOUN. CLAUDE.md: the user-facing noun lives
 *     only in `CONTAINER_KINDS[kind].label`. A literal 'Project' in a component
 *     turns a rename from a string edit into a hunt. The field leans on this
 *     HARDER than the bands did — with no band label beside it, an unset chip
 *     carrying a bare "Add" would be a nameless control.
 *  3. THE FIELD SHOWS WHAT IS SET, and nothing else — on EVERY surface, capture
 *     included. That is the claim the capture modal exists to pin: it is the
 *     one place where nothing is set yet, so a layout keyed on capability put
 *     five empty rows between the title and the button.
 *  4. AN EMPTY BAND STILL RENDERS IN THE READOUT, and its affordance is
 *     actionable — with ONE exception (a gate with nothing to join and no
 *     console to open), asserted just as hard so it cannot be "fixed" by
 *     accident.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useParams: () => ({}),
}));

vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  fetchTrashedNames: vi.fn(async () => []),
  fetchItemEvents: vi.fn(async () => []),
  getItemEventsAvailable: () => false,
}));

import { ItemDialog } from '@/components/planner/item-dialog';
import { ContainerBandsReadout } from '@/components/planner/item-bands';
import {
  CONTAINER_BANDS,
  CONTAINER_ROLE_ORDER,
  bandTestId,
  membershipSummary,
  visibleContainerBands,
  type ContainerBandContext,
} from '@/lib/item-bands';
import { CONTAINER_KINDS } from '@/lib/container-registry';
import { usePlannerStore } from '@/lib/planner-store';
import { EXT_GOALS, EXT_ORGANIZE } from '@/lib/extension-registry';
import { disableExtensions, enableExtensions } from './support/extensions';
import type { Goal, Item, Program, Routine, TaskItem } from '@/lib/planner-types';

/* ── the pure module ────────────────────────────────────────────────────── */

describe('the band list is derived from the container registry', () => {
  it('holds every kind exactly once — nothing hand-listed, nothing dropped', () => {
    expect([...CONTAINER_BANDS].map((b) => b.kind).sort()).toEqual(
      Object.keys(CONTAINER_KINDS).sort()
    );
  });

  it('orders by ROLE: what it is about, what switches it off, what it is for', () => {
    const roleIndex = CONTAINER_BANDS.map((b) => CONTAINER_ROLE_ORDER.indexOf(b.role));
    expect(roleIndex).toEqual([...roleIndex].sort((a, b) => a - b));
    // Not vacuous: the three roles are all actually present in that order.
    expect([...new Set(CONTAINER_BANDS.map((b) => b.role))]).toEqual([...CONTAINER_ROLE_ORDER]);
  });

  it('labels every band with the registry noun and nothing else', () => {
    for (const band of CONTAINER_BANDS) {
      expect(band.label).toBe(CONTAINER_KINDS[band.kind].label);
      expect(band.labelPlural).toBe(CONTAINER_KINDS[band.kind].labelPlural);
    }
  });

  it('keeps the two GATE kinds as two bands — a merged one could not be named', () => {
    // Kirby's rule is nouns, and the registry supplies a noun per KIND. A single
    // gate band would have to invent one, which is the literal this whole module
    // exists to avoid.
    const gates = CONTAINER_BANDS.filter((b) => b.role === 'gate');
    expect(gates.map((b) => b.kind)).toEqual(['routine', 'program']);
  });
});

const ctx = (over: Partial<ContainerBandContext> = {}): ContainerBandContext => ({
  classifyKind: 'project',
  collectible: true,
  collectionsAvailable: true,
  goalsAvailable: true,
  goalsEnabled: true,
  organizeEnabled: true,
  counts: { project: 0, routine: 0, program: 0, goal: 0 },
  ...over,
});

const kindsFor = (over: Partial<ContainerBandContext> = {}) =>
  visibleContainerBands(ctx(over)).map((b) => b.kind);

describe('which bands render', () => {
  it('answers with every kind from zero — capability, never content', () => {
    // The module is asked the same question by both surfaces; what differs is
    // what they do with a kind the item has not joined. The readout draws it as
    // an empty band; the field folds it into the seed.
    expect(kindsFor()).toEqual(['project', 'routine', 'program', 'goal']);
  });

  it('gives the classify band only to a type that answers with that kind', () => {
    expect(kindsFor({ classifyKind: null })).not.toContain('project');
    expect(kindsFor({ classifyKind: null })).toEqual(['routine', 'program', 'goal']);
  });

  it('drops a gate band with nothing to join AND no console to open', () => {
    // The one exception to the empty-band rule, inherited from the chip it
    // replaced: the band's only content would be a door, and the door is gone
    // while Organize is off.
    expect(kindsFor({ organizeEnabled: false })).toEqual(['project', 'goal']);
    // …and it comes straight back as soon as there is a container to name.
    expect(kindsFor({ organizeEnabled: false, counts: { routine: 1 } })).toEqual([
      'project',
      'routine',
      'goal',
    ]);
  });

  it('drops the gates for an item that cannot join one, and when the tables are gone', () => {
    expect(kindsFor({ collectible: false })).toEqual(['project']);
    expect(kindsFor({ collectionsAvailable: false })).toEqual(['project', 'goal']);
  });

  it('renders the aspire band from zero, and never consults the console', () => {
    expect(kindsFor({ organizeEnabled: false, counts: { goal: 0 } })).toContain('goal');
    expect(kindsFor({ goalsEnabled: false })).not.toContain('goal');
    expect(kindsFor({ goalsAvailable: false })).not.toContain('goal');
  });
});

describe('membershipSummary', () => {
  it('is undefined for none, the name for one, and name +n for many', () => {
    expect(membershipSummary([])).toBeUndefined();
    expect(membershipSummary(['Deep work'])).toBe('Deep work');
    expect(membershipSummary(['Deep work', 'Evening', 'Weekly'])).toBe('Deep work +2');
  });
});

/* ── the surfaces ───────────────────────────────────────────────────────── */

const task = (over: Partial<TaskItem> = {}): TaskItem => ({
  type: 'task',
  id: 't1',
  title: 'Draft the Q3 handoff note',
  status: 'pending',
  isScheduled: false,
  order: 0,
  ...over,
});

/** A habit — the one type with a REQUIRED container, hence its own fixture. */
const habitItem = (over: Record<string, unknown> = {}): Item =>
  ({
    type: 'habit',
    id: 'h1',
    title: 'Morning pages',
    status: 'pending',
    repeatFrequency: 'daily',
    completedDates: [],
    skippedDates: [],
    streak: 0,
    ...over,
  }) as unknown as Item;

const routine = (over: Partial<Routine> = {}): Routine => ({
  id: 'r1',
  name: 'Deep work',
  itemIds: [],
  ...over,
});

const program = (over: Partial<Program> = {}): Program => ({
  id: 'p1',
  name: 'Autumn term',
  state: 'auto',
  itemIds: [],
  routineIds: [],
  ...over,
});

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g1',
  name: 'Ship v2',
  state: 'active',
  memberIds: [],
  milestoneIds: [],
  checkinIds: [],
  ...over,
});

const seed = (over: Record<string, unknown> = {}) =>
  usePlannerStore.setState({
    items: [task()],
    projects: [{ name: 'Onboarding' }],
    routines: [routine()],
    programs: [program()],
    goals: [goal()],
    itemTypes: [],
    collectionsAvailable: true,
    goalsAvailable: true,
    itemTypesAvailable: true,
    userTimezone: 'UTC',
    isLoading: false,
    userId: 'u1',
    ...over,
  } as never);

beforeEach(() => {
  enableExtensions(EXT_GOALS, EXT_ORGANIZE);
  seed();
});
afterEach(cleanup);

const panel = (item: Item = task()) =>
  render(
    <ItemDialog
      presentation="panel"
      state={{ mode: 'edit', item }}
      onOpenChange={() => {}}
      withDetailSections={false}
    />
  );

/** The capture modal — the surface that held the bands longest. */
const capture = (type = 'task', over: Record<string, unknown> = {}) =>
  render(
    <ItemDialog state={{ mode: 'add', type, ...over }} onOpenChange={() => {}} />
  );

/**
 * The mobile edit drawer — and the Zen edit modal, which resolves identically.
 * The ONLY surface that is Clearing and does NOT autosave, which makes it the
 * only fixture that can tell `autosaves` apart from `mode`: every other pairing
 * moves both at once (the panel is edit+autosaving, capture is add+not). Without
 * it a footer keyed on `mode === 'add'` would pass every test in this file.
 */
const modalEdit = (item: Item = task()) =>
  render(
    <ItemDialog state={{ mode: 'edit', item }} onOpenChange={() => {}} withDetailSections={false} />
  );

const field = () => screen.getByTestId('item-clearing-field');
const seedOptions = () =>
  Array.from(document.querySelectorAll('[data-testid="item-clearing-seed-option"]')).map(
    (o) => o.textContent ?? ''
  );

/** The band rows on screen, top to bottom, by their label text. */
const bandLabels = () =>
  Array.from(document.querySelectorAll('[data-testid^="item-band-"]')).map(
    (row) => row.querySelector('p')?.textContent ?? ''
  );

describe('every item surface renders the Clearing field, not bands', () => {
  it('drops the labelled band stack for one label-less field', () => {
    panel();
    expect(screen.getByTestId('item-clearing-field')).toBeTruthy();
    // The band grammar belongs to the /item readout alone now; every surface
    // you EDIT on shows only what the item actually carries.
    expect(document.querySelectorAll('[data-testid^="item-band-"]').length).toBe(0);
  });

  it('shows only SET properties, folding the rest behind one "+ Add property" seed', () => {
    // A bare task carries nothing but a title, so the field is just the seed —
    // none of the four containers render a chip while empty.
    panel();
    const field = screen.getByTestId('item-clearing-field');
    expect(field.querySelector('[data-testid="item-clearing-seed"]')).toBeTruthy();
    for (const kind of ['project', 'routine', 'program', 'goal'] as const) {
      expect(field.textContent).not.toContain(CONTAINER_KINDS[kind].label);
    }
  });

  it('renders a set membership as its value chip, the noun kept in the a11y name', () => {
    seed({ routines: [routine({ itemIds: ['t1'] })] });
    panel();
    const field = screen.getByTestId('item-clearing-field');
    expect(field.textContent).toContain('Deep work');
    const chip = Array.from(field.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Deep work')
    );
    expect(chip?.getAttribute('aria-label')).toBe(`${CONTAINER_KINDS.routine.label}: Deep work`);
  });

  it('moves Priority into the field — a value when set, in the seed when not', () => {
    panel(); // unset (the seeded t1 has no priority)
    expect(screen.getByTestId('item-clearing-field').textContent).not.toContain('Medium');
    cleanup();
    // editItem re-resolves against the store, so the priority must live there.
    seed({ items: [task({ priority: 'medium' })] });
    panel();
    expect(screen.getByTestId('item-clearing-field').textContent).toContain('Medium');
  });

  it('offers every unset property by its registry noun in the seed, and a revealed container keeps that noun', () => {
    panel();
    fireEvent.click(screen.getByTestId('item-clearing-seed'));
    const optionText = () =>
      Array.from(document.querySelectorAll('[data-testid="item-clearing-seed-option"]')).map(
        (o) => o.textContent ?? ''
      );
    // The container nouns and Priority are all reachable from the seed.
    expect(optionText().some((t) => t.includes(CONTAINER_KINDS.routine.label))).toBe(true);
    expect(optionText().some((t) => t.includes('Priority'))).toBe(true);
    // Revealing a container gives it a chip that carries its kind noun — not a
    // bare "Add" (the band label that used to sit beside it is gone).
    const routineOption = Array.from(
      document.querySelectorAll('[data-testid="item-clearing-seed-option"]')
    ).find((o) => o.textContent?.includes(CONTAINER_KINDS.routine.label));
    fireEvent.click(routineOption!);
    const revealed = Array.from(
      screen.getByTestId('item-clearing-field').querySelectorAll('button')
    ).find((b) => b.getAttribute('aria-label') === CONTAINER_KINDS.routine.label);
    expect(revealed?.textContent).toContain(CONTAINER_KINDS.routine.label);
  });
});

describe('a cancelled add keeps its draft across the body unmount', () => {
  /**
   * "A cancelled dialog deliberately keeps its other draft fields" used to be
   * held trivially: the body was mounted for the whole session, so its
   * useState never died. The body now unmounts after the close grace and the
   * contract flows through the wrapper's draft stash — this is the only test
   * that walks that path (close → grace elapses → body unmounts → reopen), so
   * a later edit to the stash plumbing fails HERE rather than silently
   * dropping half-typed drafts.
   */
  it('keeps a typed title through close, the grace unmount, and reopen', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <ItemDialog state={{ mode: 'add', type: 'task' }} onOpenChange={() => {}} />
      );
      fireEvent.change(screen.getByTestId('item-dialog-title-input'), {
        target: { value: 'Halfway through a thought' },
      });

      // Cancel. Advancing well past the close grace forces the body's unmount,
      // so the reopen below can only re-seed from the wrapper's stash.
      rerender(<ItemDialog state={null} onOpenChange={() => {}} />);
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.queryByTestId('item-dialog-title-input')).toBeNull();

      // A fresh payload object, as ui-store's openDialog stamps per open.
      rerender(
        <ItemDialog state={{ mode: 'add', type: 'task' }} onOpenChange={() => {}} />
      );
      expect(
        (screen.getByTestId('item-dialog-title-input') as HTMLInputElement).value
      ).toBe('Halfway through a thought');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the capture surface gets the field too', () => {
  /**
   * The modal held the bands longest, and it is where they cost most: NOTHING
   * is set on a new item, so a stack keyed on what the type COULD carry was
   * five empty labelled rows between the title and the button — "a lot of
   * different empty rows for things you can add", which is the complaint that
   * closed the gate.
   */
  it('shows one field and no band rows', () => {
    capture();
    expect(field()).toBeTruthy();
    expect(bandLabels()).toEqual([]);
  });

  it('folds an unset property into the seed instead of drawing an empty row', () => {
    capture();
    // Priority left the header for the field, and a fresh task has none — so it
    // is reachable BY NAME from the seed rather than parked unset on screen.
    expect(field().textContent).not.toContain('Priority');
    for (const kind of ['project', 'routine', 'program', 'goal'] as const) {
      expect(field().textContent).not.toContain(CONTAINER_KINDS[kind].label);
    }
    fireEvent.click(screen.getByTestId('item-clearing-seed'));
    expect(seedOptions().some((t) => t.includes('Priority'))).toBe(true);
    for (const kind of ['project', 'routine', 'program', 'goal'] as const) {
      expect(seedOptions().some((t) => t.includes(CONTAINER_KINDS[kind].label))).toBe(true);
    }
  });

  it('folds the WHEN cluster away too — the rows the complaint was actually about', () => {
    /**
     * The container nouns above are the easy half. The five schedule properties
     * — Date, Time, Repeat, Remind, Times per day — were the `When` band, the
     * first and widest of the five empty rows a fresh capture used to draw, and
     * nothing in this file pinned them.
     *
     * MUTATION-CHECKED: flipping `set: !!d.startDate` to `set: true` on the date
     * prop (item-dialog.tsx) leaves every other test in the repo green while the
     * capture modal draws a valueless "Date" chip again — exactly the empty
     * affordance this layout exists to delete. This test is what fails instead.
     */
    capture(); // an undated task: the braindump / omnibar capture path
    for (const noun of ['Date', 'Repeat', 'Remind']) {
      expect(field().textContent).not.toContain(noun);
    }
    // A dateless task is not date-anchored ANYWHERE yet, so Time goes with it —
    // `showTime` is a capability question, not a value one.
    expect(field().textContent).not.toContain('Time');
    // Absent from the field, present in the seed: folded, never removed.
    fireEvent.click(screen.getByTestId('item-clearing-seed'));
    for (const noun of ['Date', 'Repeat', 'Remind']) {
      expect(seedOptions().some((t) => t.includes(noun))).toBe(true);
    }
  });

  it('keeps what the open ALREADY set on screen — the date you added from', () => {
    // The seed is not a diet: a capture anchored to a day carries that day, so
    // the chip is set and shows at rest. This is why the field is not simply
    // empty in add mode.
    capture('task', { date: new Date(2026, 8, 18) });
    expect(field().textContent).toContain('Sep 18');
  });

  it('shows a habit what it already carries: its file, its cadence, its count', () => {
    // The field is not a diet — a habit reaches capture with a required
    // container already filled (makeAddDraft seeds the first one), a default
    // frequency and a daily count, so all three show at rest. Only the
    // properties a new habit genuinely has none of go to the seed.
    capture('habit');
    expect(screen.getByTestId('item-dialog-container-chip').textContent).toContain('Onboarding');
    expect(field().textContent).toContain('Daily');
    // The count chip is asserted BY VALUE, not just by the section it sits in:
    // `timesPerDay` is the one prop hardcoded `set: true` (it always carries a
    // value, defaulting to 1×), and flipping that to false silently drops it
    // into the seed on every surface with nothing else in the suite noticing.
    expect(field().textContent).toContain('1×');
    // …and the chip keeps the registry noun in its accessible name, which is
    // the only place the band label used to live.
    expect(screen.getByTestId('item-dialog-container-chip').getAttribute('aria-label')).toBe(
      `${CONTAINER_KINDS.project.label}: Onboarding`
    );
  });

  it("never offers a habit's own container in the seed — it cannot be un-set", () => {
    /**
     * Honest about WHY this passes, because the obvious reading is wrong: it is
     * `set`, not `required`, that carries it. Neither draft builder can produce
     * `container: 'none'` for a type that requires one — makeAddDraft seeds the
     * first container (or legacy 'personal'), and draftFromItem falls back to
     * `''` — and `set` is `d.container !== 'none'`, so it is true even for a
     * habit filed nowhere. `required` is the backstop behind that, not the
     * mechanism, and there is no state reachable from either builder that
     * exercises it alone. What this pins is the USER-FACING guarantee: the one
     * property a habit cannot do without is never folded out of reach.
     */
    capture('habit');
    fireEvent.click(screen.getByTestId('item-clearing-seed'));
    expect(seedOptions().some((t) => t.includes(CONTAINER_KINDS.project.label))).toBe(false);
    cleanup();
    // The same guarantee on the edit side, where the project really IS empty:
    // draftFromItem gives a container-requiring type `''` rather than 'none'.
    seed({ items: [habitItem()] });
    panel(habitItem());
    expect(screen.getByTestId('item-dialog-container-chip')).toBeTruthy();
    fireEvent.click(screen.getByTestId('item-clearing-seed'));
    expect(seedOptions().some((t) => t.includes(CONTAINER_KINDS.project.label))).toBe(false);
  });

  it('offers the type as a control here and only whispers it when editing', () => {
    capture();
    expect(screen.getByTestId('item-dialog-type-chip')).toBeTruthy();
    expect(screen.queryByTestId('item-dialog-type-whisper')).toBeNull();
    cleanup();
    panel();
    expect(screen.getByTestId('item-dialog-type-whisper')).toBeTruthy();
    expect(screen.queryByTestId('item-dialog-type-chip')).toBeNull();
  });

  it('keeps its submit button in the footer — only autosave lifts Done to the rail', () => {
    // Clearing is a LAYOUT decision; where the commit lives is a persistence
    // one. The capture modal has a moment of commitment and still says so.
    capture();
    expect(screen.getByTestId('item-dialog-submit').textContent).toContain('Add');
    cleanup();
    panel();
    expect(screen.getByTestId('item-dialog-submit').textContent).toBe('Done');
  });
});

describe('emptying a property keeps its chip', () => {
  /**
   * The rule is "show what is SET", and taken literally it eats the control you
   * are using: clear a date from inside the date chip and the chip fails `set`,
   * fails `required`, fails `revealed` — and unmounts, from under the pointer,
   * with the value you were about to replace now two clicks away behind the
   * seed. `clearProp` writes the same `revealed` set the seed menu does, on the
   * grounds that deliberately emptying a property is the same statement as
   * summoning one: I am using this.
   */
  const openChipAndClear = (chipTestId: string, optionText: string) => {
    fireEvent.click(screen.getByTestId(chipTestId));
    const option = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === optionText
    );
    expect(option).toBeTruthy();
    fireEvent.click(option!);
  };

  it('keeps the date chip after "No date", empty rather than gone', () => {
    seed({ items: [task({ startDate: '2026-09-18' })] });
    panel(task({ startDate: '2026-09-18' }));
    expect(field().textContent).toContain('Sep 18');

    openChipAndClear('item-dialog-date-chip', 'No date');

    // Still there, now carrying its noun instead of a value — ready to re-pick
    // in one click. Before `clearProp` this assertion failed: the field
    // collapsed to a lone "+ Add property".
    expect(screen.getByTestId('item-dialog-date-chip')).toBeTruthy();
    expect(field().textContent).toContain('Date');
    expect(field().textContent).not.toContain('Sep 18');
    // …and it is NOT also sitting in the seed, which would be two ways in.
    fireEvent.click(screen.getByTestId('item-clearing-seed'));
    expect(seedOptions().some((t) => t.includes('Date'))).toBe(false);
  });

  it('applies on the capture modal too — where the date arrives pre-filled', () => {
    // The surface that made this reachable: a capture anchored to a day opens
    // with a date already set, so "change my mind about the day" is an ordinary
    // first move rather than an edge case.
    capture('task', { date: new Date(2026, 8, 18) });
    expect(field().textContent).toContain('Sep 18');
    openChipAndClear('item-dialog-date-chip', 'No date');
    expect(screen.getByTestId('item-dialog-date-chip')).toBeTruthy();
  });

  it('leaves the TIME chip to its capability rule, which is a different question', () => {
    // Clearing a task's date really does take Time with it: `showTime` asks
    // whether the property applies at all, not whether it holds a value, and an
    // undated task has no bucket to be in. That is correct and must not be
    // "fixed" by the same mechanism — `clearProp` only answers `set`.
    seed({ items: [task({ startDate: '2026-09-18' })] });
    panel(task({ startDate: '2026-09-18' }));
    expect(field().textContent).toContain('30 min');
    openChipAndClear('item-dialog-date-chip', 'No date');
    expect(field().textContent).not.toContain('30 min');
  });
});

describe('a goal that ended still says so', () => {
  /**
   * `endedGoals` exists for one sentence, written in the dialog: "a
   * still-scheduled milestone of a set-aside goal is otherwise a row with no
   * explanation anywhere in the app." Reading the chip's value from ACTIVE
   * memberships alone made the field hide the chip entirely for an item that
   * serves only ended goals — deleting the explanation that comment describes.
   */
  it('names the ended goal on the chip rather than folding it into the seed', () => {
    seed({ goals: [goal({ state: 'achieved', memberIds: ['t1'] })] });
    panel();
    expect(screen.getByTestId('item-dialog-goal-chip')).toBeTruthy();
    // Named AND marked: a bare name would read as a live membership, which
    // trades a missing explanation for a wrong one.
    expect(field().textContent).toContain('Ship v2 (ended)');
    fireEvent.click(screen.getByTestId('item-clearing-seed'));
    expect(seedOptions().some((t) => t.includes(CONTAINER_KINDS.goal.label))).toBe(false);
  });

  it('marks ONLY the fallback — a live membership says its name plainly', () => {
    seed({
      goals: [
        goal({ memberIds: ['t1'] }),
        goal({ id: 'g2', name: 'Old plan', state: 'achieved', memberIds: ['t1'] }),
      ],
    });
    panel();
    expect(field().textContent).toContain('Ship v2');
    expect(field().textContent).not.toContain('(ended)');
    // The ended one is still reachable where it always was — inside the chip.
    expect(field().textContent).not.toContain('Old plan');
  });

  it('says nothing at all when there is no membership of either kind', () => {
    // The fallback must not become a reason for the chip to exist: a task in no
    // goal, ended or otherwise, still folds Goal into the seed.
    panel();
    expect(screen.queryByTestId('item-dialog-goal-chip')).toBeNull();
    fireEvent.click(screen.getByTestId('item-clearing-seed'));
    expect(seedOptions().some((t) => t.includes(CONTAINER_KINDS.goal.label))).toBe(true);
  });
});

describe('the mobile drawer: Clearing without autosave', () => {
  /**
   * The second surface the gate held back, and the one no test in this repo
   * mounted. It matters more than its size suggests: it is the only place where
   * "is this Clearing?" and "does this save itself?" disagree, so it is the only
   * fixture that can prove the layout is universal while the COMMIT affordance
   * still tracks persistence.
   */
  it('gets the field and the whisper, like every other surface', () => {
    modalEdit();
    expect(screen.getByTestId('item-clearing-field')).toBeTruthy();
    expect(document.querySelectorAll('[data-testid^="item-band-"]').length).toBe(0);
    expect(screen.getByTestId('item-dialog-type-whisper')).toBeTruthy();
    expect(screen.queryByTestId('item-dialog-type-chip')).toBeNull();
  });

  it('keeps Save Changes in the footer — the layout is universal, the commit is not', () => {
    /**
     * The discriminator is `autosaves` (isPanel && edit), NOT `mode`. This is the
     * fixture that says so: it is mode 'edit' like the panel, but modal like the
     * capture, and it must follow the CAPTURE on the footer. A regression that
     * re-keyed the footer or the top-rail Done on `mode === 'add'` would satisfy
     * every other test in this file and strand this surface with a Done button
     * that flushes an autosave queue it never fills.
     */
    modalEdit();
    expect(screen.getByTestId('item-dialog-submit').textContent).toBe('Save Changes');
    cleanup();
    panel(); // same mode, different presentation → the other answer
    expect(screen.getByTestId('item-dialog-submit').textContent).toBe('Done');
  });
});

describe('the /item/[id] readout', () => {
  const readout = (item: Item, onAdd = vi.fn()) => {
    render(<ContainerBandsReadout item={item} onAdd={onAdd} />);
    return onAdd;
  };

  it('finally says which routines, programs and goals an item serves', () => {
    // The page showed a project and nothing else: an item could sit in a
    // routine, a program and a goal and its own page never said so.
    seed({
      routines: [routine({ itemIds: ['t1'] })],
      programs: [program({ itemIds: ['t1'] })],
      goals: [goal({ memberIds: ['t1'] })],
    });
    readout(task({ project: 'Onboarding' }));
    expect(screen.getByTestId(bandTestId('project')).textContent).toContain('Onboarding');
    expect(screen.getByTestId(bandTestId('routine')).textContent).toContain('Deep work');
    expect(screen.getByTestId(bandTestId('program')).textContent).toContain('Autumn term');
    expect(screen.getByTestId(bandTestId('goal')).textContent).toContain('Ship v2');
  });

  it('renders an empty band as a way in rather than a blank, and hands editing back', () => {
    const onAdd = readout(task());
    const add = screen.getByTestId('band-add-program');
    fireEvent.click(add);
    // One write path, still: the readout opens the editor, it does not grow a
    // second way to change a membership.
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0].kind).toBe('program');
  });

  // NOTE: the readout and the dialog's chip now DIVERGE here, deliberately. The
  // readout draws its Goal band whether or not it holds anything, so an ended
  // membership costs it no explanation — the row is on screen either way. The
  // dialog's field hides what is unset, so there the ended goal has to be named
  // on the chip or it disappears completely (see 'a goal that ended still says
  // so' above).
  it('counts an achieved goal out of the READOUT, whose empty band still shows', () => {
    seed({ goals: [goal({ state: 'achieved', memberIds: ['t1'] })] });
    readout(task());
    expect(screen.getByTestId(bandTestId('goal')).textContent).not.toContain('Ship v2');
  });
});

/* ── focus return (item-surface-growth "Open after Phase 8") ─────────────── */

describe('closing the panel gives the cursor back', () => {
  const Harness = ({ open, item = task() }: { open: boolean; item?: Item }) => (
    <>
      <button data-testid="opener">Row</button>
      <button data-testid="elsewhere">Elsewhere</button>
      <ItemDialog
        presentation="panel"
        state={open ? { mode: 'edit', item } : null}
        onOpenChange={() => {}}
        withDetailSections={false}
      />
    </>
  );

  it('returns it to whatever opened the panel, not to <body>', () => {
    const view = render(<Harness open={false} />);
    const opener = screen.getByTestId('opener');
    opener.focus();
    view.rerender(<Harness open />);

    // THE CASE THAT MATTERS is focus INSIDE the panel. The panel never steals
    // it, so a cursor left on the opener stays there whatever happens — the
    // first version of this test asserted exactly that and proved nothing (it
    // stayed green with the restore deleted). Tab in, or press the panel's own
    // close button, and the subtree that holds the cursor is about to vanish:
    // Radix's FocusScope returned focus for the modal, and the bare <aside>
    // (Phase 8) has nothing that does, so the cursor landed on <body> and the
    // next Tab restarted at the top of the document.
    // Clearing dropped the close-X; "Done" is the in-panel focusable now.
    const inside = screen.getByTestId('item-dialog-submit');
    inside.focus();
    expect(document.activeElement).toBe(inside);

    view.rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(opener);
  });

  it('leaves the cursor alone when something else has already claimed it', () => {
    const view = render(<Harness open={false} />);
    screen.getByTestId('opener').focus();
    view.rerender(<Harness open />);
    const elsewhere = screen.getByTestId('elsewhere');
    elsewhere.focus();
    view.rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(elsewhere);
  });

  it('remembers where the SESSION started, not the last row it retargeted to', () => {
    // The panel retargets to another item without ever closing — the ui-store's
    // dialog slot is the selection. Re-capturing on each payload would hand the
    // cursor to whatever happened to hold it at the third click.
    const view = render(<Harness open={false} />);
    const opener = screen.getByTestId('opener');
    opener.focus();
    view.rerender(<Harness open />);

    screen.getByTestId('elsewhere').focus();
    view.rerender(<Harness open item={task({ id: 't2', title: 'Another' })} />);
    screen.getByTestId('item-dialog-submit').focus();

    view.rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(opener);
  });
});
