import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { resolveDrop, type DropCommand, type DropContext } from '@/lib/dnd/handle-drag-end';
import { registerReorderSection, reorderTargetAt } from '@/lib/dnd/reorder-sections';

/**
 * Drag reorders only on a pointer, and only through one door.
 *
 * ## The decisions this pins
 *
 * Kirby, earlier: "I don't think we need to be able to drag Rows on mobile."
 * Kirby, 2026-10-24: rows in a list in the user's own order reorder by drag on
 * desktop, and the phone gets Move up / Move down in the row's ⋯ sheet instead.
 *
 * So a reorder is NOT a drop. Every id in the grammar of lib/dnd/CONTRACT.md
 * still resolves to a MOVE (below, unchanged). A reorder is decided beside the
 * grammar, by `reorderTargetAt` (lib/dnd/reorder-sections.ts), from where the
 * pointer is among the row's own peers, and the shell writes it on release
 * instead of resolving the drop. That function answers null for a finger, so
 * a phone's long press is never a reorder — and since dnd-kit sensors do not
 * tell drop targets apart, this file is the tripwire on any second path that
 * would let touch inherit one silently.
 *
 * A reorder driven by BUTTONS stays allowed everywhere (Alt+↑/↓, the row
 * menu's and the sheet's Move up / Move down): the WCAG 2.5.7 single-pointer
 * alternative.
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

  it('the shell is the only drag surface that writes a reorder', () => {
    // Scoped to dnd-kit importers on purpose: a BUTTON-driven reorder is the
    // accessible pattern and stays allowed anywhere. A drag-driven one has one
    // door, the shell's release handler, which writes only what
    // `reorderTargetAt` answered — and that answers null for a finger.
    const writers = SOURCE_FILES.filter((file) => {
      const source = readFileSync(file, 'utf8');
      // The two questions (`reorderAllowed`, `reorderTargetAt`) write nothing.
      return DND_IMPORT.test(source) && /\breorder(?!Allowed\b|TargetAt\b)[A-Z]\w*\s*\(/.test(source);
    }).map((file) => file.slice(process.cwd().length + 1));

    expect(writers).toEqual(['components/shell/app-shell.tsx']);
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

describe('a finger never reorders', () => {
  function section() {
    document.body.innerHTML = `
      <div id="s">
        <div data-item-id="a"></div><div data-item-id="b"></div><div data-item-id="c"></div>
      </div>`;
    const el = document.getElementById('s')!;
    el.getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 120, width: 400, height: 120 }) as DOMRect;
    el.querySelectorAll<HTMLElement>('[data-item-id]').forEach((row, i) => {
      row.getBoundingClientRect = () => ({ left: 0, right: 400, top: i * 40, bottom: i * 40 + 40, width: 400, height: 40 }) as DOMRect;
    });
    return registerReorderSection('s', { el, peers: { task: ['a', 'b', 'c'], habit: [] } });
  }

  it('a cursor dragging c above a gets a reorder', () => {
    const off = section();
    expect(reorderTargetAt('c', ['c'], { x: 10, y: 5 }, 'pointer')?.sequence).toEqual(['c', 'a', 'b']);
    off();
  });

  it('a cursor in the grip gutter left of the rows still reorders', () => {
    // The grip sits about 14px left of the row; a drag started there rides
    // that gutter all the way down.
    const off = section();
    expect(reorderTargetAt('a', ['a'], { x: -7, y: 115 }, 'pointer')?.sequence).toEqual(['b', 'c', 'a']);
    expect(reorderTargetAt('a', ['a'], { x: -40, y: 115 }, 'pointer')).toBeNull();
    off();
  });

  it('the same gesture by a finger gets nothing', () => {
    const off = section();
    expect(reorderTargetAt('c', ['c'], { x: 10, y: 5 }, 'touch')).toBeNull();
    off();
  });
});
