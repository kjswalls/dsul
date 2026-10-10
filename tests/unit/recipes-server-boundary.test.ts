// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The recipe server runner (lib/recipes/server/) runs in a route handler, for
 * every user, from one process. Nothing it reaches may be a client module: a
 * `'use client'` file imported from a route becomes a client reference, and a
 * zustand store there is a module singleton shared by every user the process
 * serves. So the planner, mods, extensions and UI stores, and sonner, are out,
 * and it asks the pure halves instead (lib/verb-gates.ts,
 * lib/recipes/validate-core.ts, lib/recipes/stake-rule.ts, lib/item-intents.ts).
 *
 * Walks static value imports from the door (index.ts); `import type` erases,
 * and a dynamic import loads only when run (see valueSpecifiers).
 * And the routes reach the runner only through that door.
 */

const ROOT = process.cwd();
const FORBIDDEN = new Set([
  'lib/planner-store.ts',
  'lib/mods-store.ts',
  'lib/extensions-store.ts',
  'lib/ui-store.ts',
  'lib/item-verbs.ts',
  'lib/recipes/engine.ts',
  'lib/recipes/stake-lock.ts',
  'lib/recipes/validate.ts',
]);

/** Value imports and re-exports only: `import type` / `export type` erase. */
function valueSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(import|export)\s+(type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) {
    if (m[2]) continue;
    out.push(m[3]);
  }
  // Dynamic imports are not followed: they load only when run, and the one on
  // this path (lib/db.ts reportCompletion's stakes/live-client) runs only
  // under `typeof window !== 'undefined'`, which the server never is.
  return out;
}

function resolveSpec(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else return null; // a package
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    const abs = path.join(ROOT, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  }
  return null;
}

function reach(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.pop()!;
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    for (const spec of valueSpecifiers(text)) {
      const next = resolveSpec(spec, rel);
      if (next) queue.push(next);
    }
  }
  return seen;
}

describe('the recipe server runner reaches no client module', () => {
  const reached = reach('lib/recipes/server/index.ts');

  it('walks a real graph', () => {
    expect(reached.has('lib/recipes/server/run.ts')).toBe(true);
    expect(reached.has('lib/item-intents.ts')).toBe(true);
    expect(reached.has('lib/verb-gates.ts')).toBe(true);
    expect(reached.size).toBeGreaterThan(20);
  });

  it.each([...reached].sort().map((r) => [r]))('%s is not a client module', (rel) => {
    expect(FORBIDDEN.has(rel), rel).toBe(false);
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    expect(text.trimStart().startsWith("'use client'") || text.trimStart().startsWith('"use client"'), rel).toBe(false);
    expect(valueSpecifiers(text), rel).not.toContain('sonner');
  });
});

describe('one door', () => {
  const files = (dir: string): string[] =>
    readdirSync(path.join(ROOT, dir)).flatMap((name) => {
      const rel = `${dir}/${name}`;
      return statSync(path.join(ROOT, rel)).isDirectory() ? files(rel) : /\.tsx?$/.test(name) ? [rel] : [];
    });
  // The act route's writes live in lib/reminders/act.ts since reminders PR-1b.
  const callers = [...files('app/api/app'), 'app/api/reminders/act/route.ts', 'lib/reminders/act.ts', 'app/api/cron/reminders/route.ts'];

  it.each(callers.map((c) => [c]))('%s reaches recipes only through @/lib/recipes/server', (rel) => {
    const specs = valueSpecifiers(readFileSync(path.join(ROOT, rel), 'utf8')).filter((s) => s.includes('recipes'));
    for (const s of specs) expect(s, rel).toBe('@/lib/recipes/server');
  });

  it('the item-write routes and the act route’s writes (lib/reminders/act.ts) use it', () => {
    for (const rel of ['app/api/app/items/route.ts', 'app/api/app/items/[id]/route.ts', 'lib/reminders/act.ts']) {
      expect(readFileSync(path.join(ROOT, rel), 'utf8'), rel).toContain("from '@/lib/recipes/server'");
    }
  });
});
