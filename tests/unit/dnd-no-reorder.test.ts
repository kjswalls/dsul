import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { resolveDrop, type DropCommand, type DropContext } from '@/lib/dnd/handle-drag-end';

/**
 * Drag never reorders — which is why "no row reorder on mobile" needs no
 * mobile branch.
 *
 * ## The decision this pins
 *
 * Kirby: "I don't think we need to be able to drag Rows on mobile." Read as
 * REORDER — the reading the ticket carried — the removal turned out to be a
 * removal of nothing:
 * dsul has no drag-to-reorder on any platform. `planner-store.reorderTasks`
 * exists and has zero call sites; `@dnd-kit/sortable` is in package.json and is
 * imported nowhere; the only reorder UI in the product is the Organize console's
 * up/down buttons (`components/planner/organize/member-list.tsx`), which are
 * buttons on purpose and already work with a thumb.
 *
 * Every drop the grammar in lib/dnd/CONTRACT.md can resolve is a MOVE: it
 * assigns a bucket, a day, a time, a project block, or unschedules. None of them
 * writes `items.order`. So the property "a finger cannot initiate a reorder" is
 * currently true for the strongest possible reason — there is no reorder in the
 * drag path for any input type to reach — and gating it on `isMobile` would be a
 * branch guarding a thing that does not exist.
 *
 * ## Why a test rather than a code change
 *
 * Because the property is free today and would stop being free silently.
 * `lib/sort-rows.ts` already names the follow-up ("Wire drag-to-reorder into the
 * untimed section…"), and `orderable: true` on the task type is standing
 * permission to do it. The day someone does, touch inherits it by default —
 * dnd-kit sensors do not distinguish drop targets — and Kirby's decision is
 * reversed without anyone deciding to reverse it. These two checks are the
 * tripwire on that, and they are what "capability-shaped" can mean when the
 * capability's answer is currently "nobody has this".
 *
 * Deliberately NOT blocked: a reorder driven by BUTTONS. That is the pattern the
 * Organize console already uses, it is the WCAG 2.5.7 single-pointer
 * alternative, and it is the shape a mobile reorder should take if one is ever
 * wanted. The second check below scopes itself to files that import dnd-kit for
 * exactly that reason.
 */

/**
 * Move or reorder, declared once per command kind.
 *
 * A `Record` keyed by the union, so this is a COMPILE-time exhaustiveness check
 * as much as a runtime one: adding a variant to `DropCommand` without answering
 * this question fails `tsc`, and answering `'reorder'` fails the assertion
 * below. That is the single place the rule lives — the alternative (an
 * `isMobile &&` at each of the six droppable definition sites) is the scattering
 * this repo's registry convention exists to avoid.
 */
const COMMAND_INTENT: Record<DropCommand['kind'], 'move' | 'reorder'> = {
  'schedule-task': 'move',
  'schedule-habit': 'move',
  'assign-habit-bucket': 'move',
  unschedule: 'move',
  'move-task-to-project-block': 'move',
  'move-task-to-date': 'move',
  'pause-item': 'move',
};

function ctx(overrides: Partial<DropContext> = {}): DropContext {
  return {
    itemType: 'task',
    selectedDate: new Date('2026-07-04T12:00:00Z'),
    userTimezone: 'UTC',
    // Overridden per target by the sweep below. Two ids in the grammar are
    // input-restricted (lib/dnd/drop-targets.ts): the 8px timed sliver is
    // offered to a cursor only, and the `spine:` box that replaces it in the
    // same gap is offered to a finger only. Each is swept with the input it is
    // offered, so this file keeps covering the WHOLE grammar — a touch-only
    // target that started writing `order` must fail here too.
    input: 'pointer',
    draggedTaskProject: 'Work',
    getRefTime: () => '10:00',
    inferDropTime: () => '10:30',
    ...overrides,
  };
}

/**
 * Every droppable ID pattern in CONTRACT.md § Droppable IDs, for both item
 * types. The list is the contract restated — if a row here stops resolving, the
 * grammar moved and this file is as much a parity check as `handle-drag-end`'s.
 */
const EVERY_DROP_TARGET = [
  ['scheduled:morning:before:task:t2', 'pointer'],
  ['scheduled:morning:after:habit:h2', 'pointer'],
  ['spine:morning:above:t2', 'touch'],
  ['spine:morning:below:h2', 'touch'],
  ['scheduled:afternoon:empty', 'pointer'],
  ['anytime', 'pointer'],
  ['morning', 'pointer'],
  ['afternoon', 'pointer'],
  ['evening', 'pointer'],
  ['unscheduled:evening', 'touch'],
  ['week:2026-07-06:morning', 'touch'],
  ['hour:9', 'touch'],
  ['weekhour:2026-07-06:14', 'touch'],
  ['week:2026-07-06:anytime', 'touch'],
  ['projectblock:2026-07-06:Work', 'touch'],
  ['sidebar', 'touch'],
  ['list:2026-07-06', 'touch'],
] as const satisfies readonly (readonly [string, DropContext['input']])[];

describe('no drop in the grammar reorders anything', () => {
  it.each(EVERY_DROP_TARGET)('%s resolves to a move, for a task and for a habit', (target, input) => {
    const commands = [
      resolveDrop('t1', target, ctx({ itemType: 'task', input })),
      resolveDrop('h1', target, ctx({ itemType: 'habit', input })),
    ].filter((c): c is DropCommand => c !== null);

    // Guards the guard: a target that silently stopped resolving would pass an
    // "every command is a move" assertion vacuously.
    expect(commands.length).toBeGreaterThan(0);

    for (const command of commands) {
      expect(COMMAND_INTENT[command.kind]).toBe('move');
      // The positive half. `order` is the column a reorder writes; no drop
      // command may carry one, whatever its kind is called.
      expect(command).not.toHaveProperty('order');
    }
  });

  it('classifies every command kind, and classifies none of them as a reorder', () => {
    // `Object.values` rather than a spot-check: the Record's keys are pinned by
    // the compiler, so this asserts over the whole union by construction.
    expect(Object.values(COMMAND_INTENT)).not.toContain('reorder');
    expect(Object.keys(COMMAND_INTENT).length).toBeGreaterThanOrEqual(5);
  });
});

/**
 * The source-scan half.
 *
 * A walk from the repo root rather than a hand-listed set of directories: a new
 * drag surface in a directory nobody thought to enumerate is precisely the case
 * this needs to catch. It also has to see files git has not been told about yet
 * — a `git ls-files` version passes on the working copy that introduces the
 * regression and only fails after it is staged, which is the wrong end of the
 * loop. Tests are excluded because this file names both symbols itself.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.claude',
  'dist',
  'tests',
  'packages',
]);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const SOURCE_FILES = walk(process.cwd());

const DND_IMPORT = /from ['"]@dnd-kit\//;

describe('the drag path cannot acquire a reorder without this failing', () => {
  it('finds the drag surfaces (guards against the file list matching nothing)', () => {
    const draggers = SOURCE_FILES.filter((f) => DND_IMPORT.test(readFileSync(f, 'utf8')));
    expect(draggers.length).toBeGreaterThan(5);
  });

  it('no file that imports dnd-kit also calls a reorder action', () => {
    // Scoped to dnd-kit importers on purpose: a BUTTON-driven reorder is the
    // accessible pattern and must stay allowed. It is drag-driven reorder that
    // silently re-arms the gesture Kirby declined.
    const offenders = SOURCE_FILES.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return DND_IMPORT.test(source) && /\breorder[A-Z]\w*\s*\(/.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it('@dnd-kit/sortable is imported nowhere', () => {
    // It is a dependency, so an import would typecheck and ship. `SortableContext`
    // over a row list is drag-to-reorder by definition, and on touch it inherits
    // the 250ms hold rather than declining — the reversal, arriving quietly.
    const offenders = SOURCE_FILES.filter((file) =>
      /@dnd-kit\/sortable/.test(readFileSync(file, 'utf8'))
    );

    expect(offenders).toEqual([]);
  });
});
