// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Two lines the page-as-a-device draws in the source (reminders PR-1b,
 * memory/plans/reminders-platforms.md §5.2):
 *
 *   - Nothing under app/, components/, lib/ or hooks/ constructs `new
 *     Notification(`. A page-made notification has no buttons, and its click
 *     never reaches the service worker's notificationclick, so a cue shown
 *     that way could not be marked done from the shade. Every notification
 *     goes through a registration's showNotification (lib/sw/handlers.ts).
 *   - The page tick's modules never import the sender. lib/sw/handlers.ts is
 *     bundled into the worker and imports nothing at all; the client-side
 *     reminder modules import nothing that reaches web-push, the service
 *     client or the scan.
 */

const ROOT = path.resolve(__dirname, '../..');
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'generated' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}

const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join('/');
const FILES = ['app', 'components', 'lib', 'hooks'].flatMap((d) => walk(path.join(ROOT, d)));

/** The code without its comments, which may name the very spelling refused. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function importsOf(src: string): string[] {
  return [...code(src).matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

describe('no page-made notifications', () => {
  it('nothing constructs `new Notification(`', () => {
    const offenders = FILES.filter((f) => /\bnew\s+(?:window\.)?Notification\s*\(/.test(code(readFileSync(f, 'utf8')))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('the rule bites', () => {
    expect(/\bnew\s+(?:window\.)?Notification\s*\(/.test(code("const n = new Notification('hi');"))).toBe(true);
    expect(/\bnew\s+(?:window\.)?Notification\s*\(/.test(code('// new Notification( is refused'))).toBe(false);
  });
});

describe('the page tick never imports the sender', () => {
  it('lib/sw/handlers.ts imports nothing (it is bundled into the worker)', () => {
    expect(importsOf(readFileSync(path.join(ROOT, 'lib/sw/handlers.ts'), 'utf8'))).toEqual([]);
  });

  const CLIENT = [
    'lib/reminders/local-tick.ts',
    'lib/reminders/claim-wire.ts',
    'lib/reminders/cue-log.ts',
    'hooks/use-local-cue-tick.ts',
  ];
  const SERVER_ONLY = /(?:channels\/|devices\/send|devices\/transports|push-send|supabase-service|supabase-server|reminders\/scan|reminders\/deliver|reminders\/act|reminders\/page-claim|^web-push$)/;

  it.each(CLIENT)('%s imports nothing server-only', (file) => {
    const bad = importsOf(readFileSync(path.join(ROOT, file), 'utf8')).filter((s) => SERVER_ONLY.test(s));
    expect(bad).toEqual([]);
  });
});
