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
  'components/primitives/pills.tsx': 'EditCopy.swift: a reader of lib/item-edit.ts streakRunText (in the filter)',
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
});
