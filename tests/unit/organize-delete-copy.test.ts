import { describe, expect, it } from 'vitest';
import { makeIconToken } from '@/lib/category-icons';
import {
  CONTAINER_CREATE_COPY,
  DELETE_CONFIRM_LABELS,
  DELETE_STAYS_IN_TRASH,
  TRASH_WINDOW_DAYS,
  deleteConsequence,
  deleteTitle,
  type DeleteConsequenceInput,
} from '@/lib/organize-copy';

/**
 * The delete confirms' words and the create form's (O10, O11), moved out of
 * the Organize panes into lib/organize-copy.ts so the iPhone can say the same
 * thing. Each `before*` below is the pane's own formula as it stood before the
 * move, copied verbatim (routines.tsx, seasons.tsx, goals.tsx, labels.tsx,
 * container-create-form.tsx), and the web shell must answer exactly as it
 * did, over every branch but the ones it said wrongly: an empty routine
 * ("its 0 items stay exactly as they are"), which now says only that it is
 * removed, and one thing held by a season ("the 1 item it holds stay") or
 * coming back from a routine ("and they come back"), which both shells now
 * say in the singular. The phone shell is the same sentence with no undo,
 * ending on the bin by kind.
 */

// ── the panes' formulas, before ─────────────────────────────────────────────

/** routines.tsx RoutineDetail's `consequence`. */
function beforeRoutine(routine: { name: string }, liveCount: number, reappear: boolean): string {
  return `“${routine.name}” is removed, but its ${liveCount} ${
    liveCount === 1 ? 'item stays' : 'items stay'
  } exactly as ${liveCount === 1 ? 'it is' : 'they are'}. ${
    liveCount === 1 ? 'It just stops' : 'They just stop'
  } being grouped${reappear ? ', and they come back into view' : ''}.`;
}

/** seasons.tsx's module-level deleteConsequence. */
function beforeSeason(season: { name: string }, itemCount: number, routineCount: number, live: boolean): string {
  const held = [
    itemCount > 0 ? `${itemCount} ${itemCount === 1 ? 'item' : 'items'}` : null,
    routineCount > 0 ? `${routineCount} ${routineCount === 1 ? 'routine' : 'routines'}` : null,
  ]
    .filter(Boolean)
    .join(' and ');

  return (
    `“${season.name}” is removed` +
    (held ? `, but the ${held} it holds stay exactly as they are` : '') +
    (!live && (itemCount > 0 || routineCount > 0)
      ? '. Anything it was hiding comes back into view'
      : '') +
    '.'
  );
}

/** goals.tsx's confirm description. */
const BEFORE_GOAL =
  `The goal moves to the trash for 30 days. Its habits, tasks and milestones ` +
  `are ordinary items and stay exactly where they are. Only the goal and its ` +
  `links go.`;

/** labels.tsx ProjectDetail's `consequence`. */
function beforeProject(project: { name: string }, n: number, requireds: number, destination: string | undefined): string {
  return (
    (n === 0
      ? 'Nothing is filed under it, so nothing moves.'
      : `Its ${n} ${n === 1 ? 'item stays' : 'items stay'} exactly as ${
          n === 1 ? 'it is' : 'they are'
        }. ${n === 1 ? 'It just stops' : 'They just stop'} being filed under ${project.name}.`) +
    (requireds > 0 && destination
      ? ` The ${requireds === 1 ? 'habit moves' : `${requireds} habits move`} to “${destination}”.`
      : '') +
    ' ⌘Z brings it back now, and it stays in the Trash for 30 days.'
  );
}

/** container-create-form.tsx's COPY, and labels.tsx's project CreateForm props. */
const BEFORE_CREATE = {
  goal: {
    eyebrow: 'NEW GOAL',
    placeholder: 'Name your goal…',
    addLabel: 'Create goal',
    icon: makeIconToken('Target'),
    hint:
      'A goal is the reason a stretch of work exists. It holds the habits and tasks that serve it, the checkpoints along the way, and a recurring check-in. It never hides anything.',
  },
  routine: {
    eyebrow: 'NEW ROUTINE',
    placeholder: 'Name your routine…',
    addLabel: 'Create routine',
    icon: makeIconToken('Repeat'),
    hint: 'A routine is a set of things you do regularly, in order, like a morning or a workout week. Pause it and they all step off your day together.',
  },
  season: {
    eyebrow: 'NEW SEASON',
    placeholder: 'Name your season…',
    addLabel: 'Create season',
    icon: makeIconToken('CalendarRange'),
    hint:
      'A season is a stretch of life (a summer, a term, a training block) that switches whole routines on and off. Without dates it starts always-on, hiding nothing.',
  },
  project: {
    eyebrow: 'NEW PROJECT',
    placeholder: 'Name your project…',
    addLabel: 'Create project',
    icon: makeIconToken('Briefcase'),
    hint: 'Projects file your tasks, and can carry a repeating block on the grid.',
  },
};

// ── grids ────────────────────────────────────────────────────────────────────

const NAMES = ['Morning', 'Café ☕', '“Quoted”', 'A'];
const COUNTS = [0, 1, 2, 7];
const BOOLS = [false, true];

const routineInputs: Extract<DeleteConsequenceInput, { kind: 'routine' }>[] = NAMES.flatMap((name) =>
  COUNTS.flatMap((liveCount) => BOOLS.map((reappear) => ({ kind: 'routine' as const, name, liveCount, reappear }))),
);
const seasonInputs: Extract<DeleteConsequenceInput, { kind: 'season' }>[] = NAMES.flatMap((name) =>
  COUNTS.flatMap((itemCount) =>
    COUNTS.flatMap((routineCount) => BOOLS.map((live) => ({ kind: 'season' as const, name, itemCount, routineCount, live }))),
  ),
);
const projectInputs: Extract<DeleteConsequenceInput, { kind: 'project' }>[] = NAMES.flatMap((name) =>
  COUNTS.flatMap((itemCount) =>
    COUNTS.flatMap((requiredCount) =>
      [undefined, 'Home', 'Café ☕'].map((destination) => ({ kind: 'project' as const, name, itemCount, requiredCount, destination })),
    ),
  ),
);
const allInputs: DeleteConsequenceInput[] = [...routineInputs, ...seasonInputs, { kind: 'goal' }, ...projectInputs];

/** The two branches the panes said wrongly, which the move corrects. */
const routineFixed = (input: { liveCount: number; reappear: boolean }) =>
  input.liveCount === 0 || (input.liveCount === 1 && input.reappear);
const seasonFixed = (input: { itemCount: number; routineCount: number }) => input.itemCount + input.routineCount === 1;

describe('the web says exactly what it said before the words moved', () => {
  it('a routine, over every count and whether its members come back', () => {
    for (const input of routineInputs.filter((i) => !routineFixed(i))) {
      expect(deleteConsequence(input, 'web')).toBe(beforeRoutine(input, input.liveCount, input.reappear));
    }
  });

  it('a season, over every count of items and routines, live and off', () => {
    for (const input of seasonInputs.filter((i) => !seasonFixed(i))) {
      expect(deleteConsequence(input, 'web')).toBe(beforeSeason(input, input.itemCount, input.routineCount, input.live));
    }
  });

  it('a goal', () => {
    expect(deleteConsequence({ kind: 'goal' }, 'web')).toBe(BEFORE_GOAL);
  });

  it('a project, over every count, required habits and destination', () => {
    for (const input of projectInputs) {
      expect(deleteConsequence(input, 'web')).toBe(beforeProject(input, input.itemCount, input.requiredCount!, input.destination));
    }
    // The pane always passes requiredCount; one left out is none.
    expect(deleteConsequence({ kind: 'project', name: 'Home', itemCount: 2 }, 'web')).toBe(beforeProject({ name: 'Home' }, 2, 0, undefined));
  });

  it('the titles and buttons, as each pane spelled them', () => {
    expect(deleteTitle('routine', 'Morning')).toBe('Delete this routine?');
    expect(deleteTitle('season', 'Autumn')).toBe('Delete this season?');
    expect(deleteTitle('goal', 'Learn Chinese')).toBe('Delete Learn Chinese?');
    expect(deleteTitle('project', 'Home')).toBe('Delete “Home”?');
    expect(DELETE_CONFIRM_LABELS).toEqual({ routine: 'Delete', season: 'Delete', goal: 'Delete goal', project: 'Delete' });
  });

  it('the create form’s words and starting glyph, for every kind', () => {
    expect(CONTAINER_CREATE_COPY).toEqual(BEFORE_CREATE);
  });
});

describe('what the panes said wrongly, said right in both shells', () => {
  it('an empty routine says only that it goes', () => {
    for (const reappear of BOOLS) {
      expect(deleteConsequence({ kind: 'routine', name: 'Desk', liveCount: 0, reappear }, 'web')).toBe('“Desk” is removed.');
    }
    expect(beforeRoutine({ name: 'Desk' }, 0, false)).toBe(
      '“Desk” is removed, but its 0 items stay exactly as they are. They just stop being grouped.',
    );
  });

  it('one item coming back from a routine comes back in the singular', () => {
    expect(deleteConsequence({ kind: 'routine', name: 'Morning', liveCount: 1, reappear: true }, 'web')).toBe(
      '“Morning” is removed, but its 1 item stays exactly as it is. It just stops being grouped, and it comes back into view.',
    );
  });

  it('one thing in a season stays in the singular', () => {
    expect(deleteConsequence({ kind: 'season', name: 'Autumn', itemCount: 1, routineCount: 0, live: true }, 'web')).toBe(
      '“Autumn” is removed, but the 1 item it holds stays exactly as it is.',
    );
    expect(deleteConsequence({ kind: 'season', name: 'Winter', itemCount: 0, routineCount: 1, live: false }, 'web')).toBe(
      '“Winter” is removed, but the 1 routine it holds stays exactly as it is. Anything it was hiding comes back into view.',
    );
    expect(beforeSeason({ name: 'Autumn' }, 1, 0, true)).toBe('“Autumn” is removed, but the 1 item it holds stay exactly as they are.');
  });

  it('every other branch is unchanged, and the fixed ones are only the two', () => {
    expect(routineInputs.filter(routineFixed)).toHaveLength(NAMES.length * 3);
    expect(seasonInputs.filter(seasonFixed)).toHaveLength(NAMES.length * 2 * 2);
  });
});

describe('the phone’s sentence', () => {
  it('ends every kind on the bin, named, and offers no undo', () => {
    expect(DELETE_STAYS_IN_TRASH).toEqual({
      routine: 'The routine stays in the Trash for 30 days.',
      season: 'The season stays in the Trash for 30 days.',
      goal: 'The goal stays in the Trash for 30 days.',
      project: 'The project stays in the Trash for 30 days.',
    });
    expect(TRASH_WINDOW_DAYS).toBe(30);
    for (const input of allInputs) {
      const said = deleteConsequence(input, 'phone');
      expect(said.endsWith(` ${DELETE_STAYS_IN_TRASH[input.kind]}`)).toBe(true);
      expect(said).not.toMatch(/⌘|Cmd|undo|brings it back/i);
      // Said once: the goal's "moves to the trash for 30 days" is not kept beside it.
      expect(said.match(/30 days/g)).toHaveLength(1);
      expect(said).not.toContain('—');
    }
  });

  it('is the web’s sentence with the bin after it, for a routine and a season', () => {
    for (const input of [...routineInputs, ...seasonInputs]) {
      expect(deleteConsequence(input, 'phone')).toBe(`${deleteConsequence(input, 'web')} ${DELETE_STAYS_IN_TRASH[input.kind]}`);
    }
  });

  it('a goal keeps what stays and what goes, and the bin closes it', () => {
    expect(deleteConsequence({ kind: 'goal' }, 'phone')).toBe(
      'Its habits, tasks and milestones are ordinary items and stay exactly where they are. ' +
        'Only the goal and its links go. The goal stays in the Trash for 30 days.',
    );
  });

  it('a project never says a habit moves: the phone’s delete moves nothing', () => {
    for (const input of projectInputs) {
      const said = deleteConsequence(input, 'phone');
      expect(said).not.toMatch(/habits? moves?/);
      expect(said).toBe(deleteConsequence({ ...input, requiredCount: 0, destination: undefined }, 'phone'));
    }
    expect(deleteConsequence({ kind: 'project', name: 'Home', itemCount: 1 }, 'phone')).toBe(
      'Its 1 item stays exactly as it is. It just stops being filed under Home. The project stays in the Trash for 30 days.',
    );
    expect(deleteConsequence({ kind: 'project', name: 'Home', itemCount: 0 }, 'phone')).toBe(
      'Nothing is filed under it, so nothing moves. The project stays in the Trash for 30 days.',
    );
  });
});

describe('no em dash in any of it', () => {
  it('the sentences, titles, buttons and create words', () => {
    const words = [
      ...allInputs.flatMap((input) => [deleteConsequence(input, 'web'), deleteConsequence(input, 'phone')]),
      ...(['routine', 'season', 'goal', 'project'] as const).map((kind) => deleteTitle(kind, 'X')),
      ...Object.values(DELETE_CONFIRM_LABELS),
      ...Object.values(CONTAINER_CREATE_COPY).flatMap((c) => Object.values(c)),
    ];
    for (const said of words) expect(said).not.toContain('—');
  });
});
