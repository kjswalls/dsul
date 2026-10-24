import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * The iOS jobs run only when a change could break the Swift port
 * (.github/workflows/ios.yml, the `changes` job): a `grep -E` over the
 * changed paths. Every DsulCore source names the TypeScript it mirrors in its
 * header ("Port of lib/active.ts …"), and that TypeScript changing without the
 * Swift is drift the Swift tests exist to catch. So every path a header cites
 * must be one the filter matches, or the PR that changes it skips the very
 * jobs that would have failed.
 *
 * A header may also cite TypeScript it deliberately does NOT port, or only
 * describes; those are listed below with the reason, and a stale entry fails.
 */

const ROOT = process.cwd();
const SOURCES = path.join(ROOT, 'ios/DsulCore/Sources/DsulCore');
const WORKFLOW = path.join(ROOT, '.github/workflows/ios.yml');

/** Cited in a header, and rightly outside the filter. */
const NOT_MIRRORED: Record<string, string> = {
  'lib/reminders/nudge.ts': 'ReminderCopy.swift: spokenLine and smsLine take its Nudge, and no phone surface says them; not ported',
  'lib/day-done.ts': 'AppIcon.swift: the phone never re-tints its icon at the end of a day; not ported',
  'lib/db.ts':
    'the server\'s row mapping and membership writes, described, not ported: the phone meets them only through app/api/app/ and tests/fixtures/app/, both in the filter',
  'components/planner/item-dialog.tsx': 'EditCopy.swift: a reader of lib/item-edit.ts EDIT_COPY, whose words are the source (in the filter)',
  'components/planner/item-detail-sections.tsx': 'EditCopy.swift: a reader of lib/item-edit.ts EDIT_COPY (in the filter)',
};

/** The pattern the `changes` job greps the changed paths with. */
function changeFilter(): RegExp {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const match = /git diff --name-only[^\n]*\n\s*\|\s*grep -E '([^']+)'/.exec(yml);
  expect(match, 'ios.yml: the changes job\'s grep -E pattern').not.toBeNull();
  return new RegExp((match as RegExpExecArray)[1]);
}

/**
 * The file's header: the comment block before its first declaration, after
 * its imports. Doc comments further down cite helpers they lean on, which is
 * not the same as mirroring them.
 */
function header(source: string): string {
  const lines: string[] = [];
  for (const line of source.split('\n')) {
    if (/^import\s/.test(line) || line.trim() === '') continue;
    if (!line.startsWith('//')) break;
    lines.push(line);
  }
  return lines.join('\n');
}

function citations(): Map<string, string[]> {
  const cited = new Map<string, string[]>();
  for (const file of readdirSync(SOURCES).filter((f) => f.endsWith('.swift')).sort()) {
    const text = header(readFileSync(path.join(SOURCES, file), 'utf8'));
    for (const [p] of text.matchAll(/\b(?:lib|app|components|packages)\/[\w./[\]-]+?\.tsx?\b/g)) {
      cited.set(p, [...(cited.get(p) ?? []), file]);
    }
  }
  return cited;
}

describe('the iOS change filter', () => {
  const filter = changeFilter();
  const cited = citations();

  it('reads the headers it means to', () => {
    // A guard on the guard: the headers still name their TypeScript.
    expect(cited.get('lib/active.ts')).toContain('Active.swift');
    expect(cited.get('lib/reminders/plan.ts')).toContain('ReminderPlan.swift');
    expect(cited.get('lib/reminders/snooze.ts')).toContain('ReminderSnooze.swift');
  });

  it('matches every TypeScript file a DsulCore header cites, or says why not', () => {
    for (const [p, files] of cited) {
      expect(existsSync(path.join(ROOT, p)), `${p}, cited by ${files.join(', ')}, does not exist`).toBe(true);
      if (p in NOT_MIRRORED) continue;
      expect(filter.test(p), `${p} (cited by ${files.join(', ')}) is not in ios.yml's filter`).toBe(true);
    }
  });

  it('lists nothing as not mirrored that a header no longer cites, or that the filter already matches', () => {
    for (const p of Object.keys(NOT_MIRRORED)) {
      expect(cited.has(p), `${p} is no longer cited; drop it from NOT_MIRRORED`).toBe(true);
      expect(filter.test(p), `${p} is in the filter; drop it from NOT_MIRRORED`).toBe(false);
    }
  });

  it('matches the shared fixtures and the reminder modules, and nothing beside them', () => {
    for (const p of [
      'tests/fixtures/day/notification-plan.json',
      'tests/fixtures/day/due.json',
      'tests/fixtures/day/copy.json',
      'lib/reminders/plan.ts',
      'lib/reminders/snooze.ts',
      'lib/reminders/clock.ts',
      'lib/reminders/due.ts',
      'lib/reminders/copy.ts',
      'lib/reminders/channels/push.ts',
      'lib/eod.ts',
      'ios/DsulCore/Sources/DsulCore/ReminderPlan.swift',
    ]) {
      expect(filter.test(p), p).toBe(true);
    }
    for (const p of ['lib/reminders/scan.ts', 'lib/reminders/plan.test.ts', 'lib/eod-link.ts', 'lib/reminders/channels/sms.ts']) {
      expect(filter.test(p), p).toBe(false);
    }
  });

  it('matches what Week reads, and the fixtures that pin it', () => {
    // A phone week is seven calls of the day pipeline (week.json), each day's
    // Anytime rows `deriveUntimedRows` (timed.json's `untimed`), its days
    // `weekStartOf` plus `addDaysStr`.
    for (const p of [
      'tests/fixtures/day/week.json',
      'tests/fixtures/day/timed.json',
      'components/views/day-schedule.tsx',
      'lib/container-schedule.ts',
      'lib/day-items.ts',
      'lib/active.ts',
      'lib/away.ts',
    ]) {
      expect(filter.test(p), p).toBe(true);
    }
    // The web's week views and their desktop geometry are not ported: the phone
    // draws its own seven sections over the same per-day answers.
    for (const p of [
      'components/views/week-list.tsx',
      'components/views/week-buckets.tsx',
      'components/shell/day-tabs.tsx',
      'lib/week-columns.ts',
      'lib/use-week-columns.ts',
    ]) {
      expect(filter.test(p), p).toBe(false);
    }
  });

  it('matches what Move to Braindump reads, and the fixtures that pin it', () => {
    // The gate (lib/row-moves.ts canSendToBraindump, through lib/verb-gates.ts
    // VERB_GATES.braindump and lib/item-verbs.ts), the step (the store's
    // unscheduleTask, lib/item-edit.ts UNSCHEDULE_TASK_PATCH), the milestones
    // (lib/goals.ts milestoneItemIds), "already listed" (lib/braindump-members.ts)
    // and the route's `unschedule` intent (lib/app-api.ts, app/api/app/).
    for (const p of [
      'lib/row-moves.ts',
      'lib/verb-gates.ts',
      'lib/item-verbs.ts',
      'lib/item-edit.ts',
      'lib/planner-store.ts',
      'lib/goals.ts',
      'lib/braindump-members.ts',
      'lib/item-registry.ts',
      'lib/app-api.ts',
      'app/api/app/items/[id]/route.ts',
      'tests/fixtures/day/row-moves.json',
      'tests/fixtures/day/verbs.json',
      'tests/fixtures/day/verb-writes.json',
      'tests/fixtures/app/planner-response.json',
    ]) {
      expect(filter.test(p), p).toBe(true);
    }
    // The web's own surfaces each check "already in the braindump" inline; the
    // phone asks lib/braindump-members.ts instead, so they are not ported.
    for (const p of ['components/primitives/task-row.tsx', 'components/mobile/schedule-sheet.tsx']) {
      expect(filter.test(p), p).toBe(false);
    }
  });

  it('matches the shared block drop rule, and not the web drop that maps it', () => {
    // The rule (lib/block-moves.ts planBlockDrop, PR 7) and what it reads: the
    // registry's dateAnchored and pausable, Move to Braindump's gate
    // (lib/row-moves.ts), "already listed" (lib/braindump-members.ts), the
    // hour's part of day (lib/time-bucket.ts), and the fixture BlockMoves.swift
    // is checked against.
    for (const p of [
      'lib/block-moves.ts',
      'lib/row-moves.ts',
      'lib/item-registry.ts',
      'lib/braindump-members.ts',
      'lib/time-bucket.ts',
      'lib/recurrence.ts',
      'tests/fixtures/day/block-moves.json',
      // The phone's drops (PR 8): each answer's intent through the route
      // (app/api/app/, and the `schedule` and `time` writes in lib/app-api.ts
      // and lib/item-edit.ts), pinned by block-drop-writes.json for the
      // iPhone's hosted tests. lib/item-intents.ts (`unschedule`'s handler) is
      // cited by no header; a change there that moves a write moves that
      // fixture, which is in the filter.
      'tests/fixtures/day/block-drop-writes.json',
      'app/api/app/items/[id]/route.ts',
      'lib/app-api.ts',
      'lib/item-edit.ts',
    ]) {
      expect(filter.test(p), p).toBe(true);
    }
    // The web maps the rule's answers to store calls (PR 11); the phone maps
    // them to intents of its own, so none of these is ported.
    for (const p of [
      'lib/dnd/handle-drag-end.ts',
      'lib/dnd/sidebar-drop.ts',
      'components/shell/app-shell.tsx',
      'components/sidebar/braindump.tsx',
    ]) {
      expect(filter.test(p), p).toBe(false);
    }
  });

  it('matches what Organize ports, and the fixtures that pin it', () => {
    for (const p of [
      'tests/fixtures/organize/labels.json',
      'tests/fixtures/organize/look.json',
      'tests/fixtures/organize/schedule.json',
      'tests/fixtures/organize/standing.json',
      'tests/fixtures/organize/goals.json',
      'tests/fixtures/organize/copy.json',
      'lib/organize-copy.ts',
      'lib/project-block.ts',
      'lib/accent-colors.ts',
      'lib/category-icons.ts',
      'lib/scope-rail.ts',
      'lib/collections.ts',
      'lib/goals.ts',
      'lib/active.ts',
      'lib/container-schedule.ts',
      'lib/app-api.ts',
      // The summary cards, Paused and the Trash (O4, O5, O14).
      'tests/fixtures/organize/organize.json',
      'tests/fixtures/organize/paused.json',
      'tests/fixtures/app/trash-response.json',
      'lib/organize.ts',
      'lib/paused-shelf.ts',
      'lib/app-containers.ts',
      'lib/app-http.ts',
      'app/api/app/trash/route.ts',
      'app/api/app/trash/restore/route.ts',
      // Routine pause, season state and Paused's Resume (O8a): the route, the
      // fixture its rule is pinned by, and the switch "Turn on now" mirrors.
      'tests/fixtures/organize/container-writes.json',
      'app/api/app/containers/[kind]/[id]/route.ts',
      'lib/gate-toggle.ts',
      // The create route (O11), whose body and defaults the + menu ports.
      'app/api/app/containers/[kind]/route.ts',
    ]) {
      expect(filter.test(p), p).toBe(true);
    }
    // The components the extractions left: the lib/ homes are what a header cites.
    for (const p of [
      'components/primitives/color-swatch-picker.tsx',
      'components/planner/goal-sections.tsx',
      'components/planner/routine-today.tsx',
      'components/planner/container-page.tsx',
      'components/planner/organize/project-time-block.tsx',
      'components/planner/organize/sections/routines.tsx',
      'lib/organize-copy.test.ts',
      'components/planner/organize/sections/paused.tsx',
      'components/planner/organize/sections/trash.tsx',
      'components/planner/organize/use-trashed-names.ts',
      // O9's name_taken words moved to lib/organize-copy.ts (nameTakenSentence).
      'components/planner/organize/sections/labels.tsx',
      // O10's delete words and O11's create words moved there too
      // (deleteConsequence, deleteTitle, CONTAINER_CREATE_COPY).
      'components/planner/organize/sections/seasons.tsx',
      'components/planner/organize/sections/goals.tsx',
      'components/planner/organize/container-create-form.tsx',
      'tests/unit/organize-delete-copy.test.ts',
      // The alternation is anchored: a longer name sharing a prefix is not a port.
      'lib/organize-console.ts',
      'lib/paused-shelf-extra.ts',
      'lib/gate-toggle.test.ts',
      'tests/fixtures/organize.json',
      'lib/category-icons.test.ts',
    ]) {
      expect(filter.test(p), p).toBe(false);
    }
  });

  it('matches the rule Today’s project dots read (O15), and not the web rows that draw it', () => {
    // Today's dots and section marks, the item sheet's chip and its project
    // menu rows are the grid's rule: projectColorToken (lib/accent-colors.ts),
    // which planner-store's getProjectColor answers through, folding as the
    // project kind does, pinned by look.json's projectColor, tokens and colors.
    for (const p of [
      'lib/accent-colors.ts',
      'lib/planner-store.ts',
      'lib/container-registry.ts',
      'tests/fixtures/organize/look.json',
    ]) {
      expect(filter.test(p), p).toBe(true);
    }
    // The web's readers of getProjectColor: the rule lives in lib/, so how a
    // web row draws its dot is not a port.
    for (const p of [
      'components/primitives/task-row.tsx',
      'components/primitives/lane-cap.tsx',
      'components/primitives/display-menu.tsx',
      'components/shell/bulk-edit-menu.tsx',
    ]) {
      expect(filter.test(p), p).toBe(false);
    }
  });

  it('matches what the Schedule’s blocks read (Week and blocks PRs 4 to 6), and not the web’s grid around them', () => {
    // A block's words (schedule-copy.json: formatClock and formatHourLabel in
    // day-schedule.tsx, formatDuration in pills.tsx, the stored time format
    // through use-time-format.ts), its pane and lane numbers
    // (schedule-constants.ts) and the overlap pass (schedule-overlap.ts
    // `planOverlaps`, overlap.json).
    for (const p of [
      'tests/fixtures/day/schedule-copy.json',
      'tests/fixtures/day/overlap.json',
      'components/views/day-schedule.tsx',
      'components/primitives/pills.tsx',
      'lib/use-time-format.ts',
      'lib/schedule-constants.ts',
      'lib/schedule-overlap.ts',
    ]) {
      expect(filter.test(p), p).toBe(true);
    }
    // The desktop grid around the blocks: grouping lanes and their focus, the
    // fit-to-window hour height and the settle glide. The phone has none of
    // them (a fixed 75pt hour, one field, no lanes).
    for (const p of [
      'lib/schedule-lanes.ts',
      'lib/schedule-focus-store.ts',
      'lib/use-fit-hour-px.ts',
      'lib/settle.ts',
      'tests/unit/overlap-fixtures.test.ts',
      'tests/unit/schedule-overlap.test.ts',
    ]) {
      expect(filter.test(p), p).toBe(false);
    }
  });
});
