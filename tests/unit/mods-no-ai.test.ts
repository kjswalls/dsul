// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { MOD_METHODS } from '@/lib/mods/protocol';

/**
 * memory/plans/mods.md, decision 6: `$` has no AI, ever. A mod calling the AI
 * could run up the person's bill and would be a path out of the box. Build
 * order 10 lets the AI write a mod; this locks that the mod it writes still
 * cannot reach one:
 *   - the `$` methods are exactly the list below, so a new one is a choice
 *     made here, in review;
 *   - nothing the broker, the runtime manager, a mod's commands or its panels
 *     run reaches the Make call or the server's AI code, however far the
 *     imports go;
 *   - none of their own files (lib/mods/**, walked from those) imports saved
 *     conversations or the chat target. The app's stores they use do, for
 *     the app's own chat; a mod reaches those only through the broker's
 *     method table, which is the list above. The one door into lib/open-chat
 *     is by name, and only `leaveZen` (a panel opening on the phone) is let
 *     through;
 *   - no file under lib/mods names an AI route.
 */

const ROOT = process.cwd();
const rel = (p: string) => p.slice(ROOT.length + 1).split('\\').join('/');

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : files(path);
    return /\.(ts|tsx|mjs)$/.test(name) ? [path] : [];
  });
}

/** Runtime imports only: `import type` and `export type` are erased and run nothing. */
function runtimeImports(source: string): { spec: string; names: string[] }[] {
  const out: { spec: string; names: string[] }[] = [];
  const re = /\b(import|export)\s+(?!type\b)([^'";]*?)\s*\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(re)) {
    if (m[3]) {
      const names = [...(m[2].match(/\{([^}]*)\}/)?.[1] ?? '').split(',')]
        .map((n) => n.trim())
        .filter((n) => n && !n.startsWith('type '))
        .map((n) => n.split(/\s+as\s+/)[0]);
      const bare = m[2].replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
      // `import { type A, type B } from` runs nothing either.
      if (names.length === 0 && !bare && m[2].includes('{')) continue;
      out.push({ spec: m[3], names: bare ? [...names, bare] : names });
    } else out.push({ spec: (m[4] ?? m[5])!, names: [] });
  }
  return out;
}

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Only these names may come out of lib/open-chat into a mod's own file. */
const OPEN_CHAT_ALLOWED = new Set(['leaveZen']);
/** Never reached, however far the imports go. */
const NEVER_REACHED = [/^lib\/make-ai\.ts$/, /^lib\/ai-server\//];
/** Never imported by a mod's own files. */
const NEVER_IMPORTED = [...NEVER_REACHED, /^lib\/conversations-store\.ts$/, /^lib\/chat-target\.ts$/];

interface Graph {
  reached: Set<string>;
  /** Every runtime edge out of a lib/mods file, as repo paths. */
  modEdges: { from: string; to: string }[];
  openChatNames: Map<string, string[]>;
}

function walk(entries: string[]): Graph {
  const reached = new Set<string>();
  const modEdges: Graph['modEdges'] = [];
  const openChatNames = new Map<string, string[]>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    const own = rel(file).startsWith('lib/mods/');
    for (const { spec, names } of runtimeImports(readFileSync(file, 'utf8'))) {
      const target = resolveSpec(file, spec);
      if (!target) continue;
      if (own) modEdges.push({ from: rel(file), to: rel(target) });
      // The names are held at this edge; the walk still goes on through
      // open-chat, so nothing past it may reach NEVER_REACHED either.
      if (own && rel(target) === 'lib/open-chat.ts') openChatNames.set(rel(file), names);
      stack.push(target);
    }
  }
  return { reached, modEdges, openChatNames };
}

describe('$ has no AI', () => {
  it('the $ methods are exactly these', () => {
    expect([...MOD_METHODS]).toEqual([
      'today',
      'log',
      'after',
      'items.get',
      'items.query',
      'containers.list',
      'verbs.eligible',
      'items.create',
      'items.edit',
      'verbs.run',
      'store.get',
      'store.keys',
      'store.set',
      'store.delete',
      'ui.toast',
      'ui.openItem',
      'nav.go',
      'nav.organize',
      'look.set',
      'ui.open',
      'atom.get',
      'atom.set',
      'settings.get',
    ]);
  });

  const entries = [
    'lib/mods/broker-core.ts',
    'lib/mods/broker.ts',
    'lib/mods/runtime-manager.ts',
    'lib/mods/command-run.ts',
    ...files(join(ROOT, 'lib/mods/ui')).map(rel),
  ].map((p) => join(ROOT, p));
  const { reached, modEdges, openChatNames } = walk(entries);

  it('walks a real graph, through lib/open-chat too', () => {
    expect(entries.length).toBeGreaterThan(8);
    expect(reached.size).toBeGreaterThan(30);
    expect([...reached].map(rel)).toEqual(
      expect.arrayContaining(['lib/mods/protocol.ts', 'lib/mods/schema.ts', 'lib/open-chat.ts'])
    );
  });

  it('what a mod runs never reaches the Make call or the server\'s AI', () => {
    const offenders = [...reached].map(rel).filter((f) => NEVER_REACHED.some((re) => re.test(f)));
    expect(offenders).toEqual([]);
  });

  it('a mod\'s own files never import conversations, the chat target, the Make call or the server\'s AI', () => {
    expect(modEdges.length).toBeGreaterThan(20);
    const offenders = modEdges.filter((e) => NEVER_IMPORTED.some((re) => re.test(e.to))).map((e) => `${e.from} → ${e.to}`);
    expect(offenders).toEqual([]);
  });

  it('takes only leaveZen from lib/open-chat, never sendFrom or openChat', () => {
    expect(openChatNames.size).toBeGreaterThan(0);
    for (const [file, names] of openChatNames) {
      expect(names.length, file).toBeGreaterThan(0);
      for (const n of names) expect(OPEN_CHAT_ALLOWED.has(n), `${file} takes ${n}`).toBe(true);
    }
  });

  it('the import reader skips type-only imports and keeps the names', () => {
    expect(
      runtimeImports(
        `import type { A } from './a'; import { type B } from './b'; import { c, d as e } from './c'; import f from './f'; import './g';`
      )
    ).toEqual([
      { spec: './c', names: ['c', 'd'] },
      { spec: './f', names: ['f'] },
      { spec: './g', names: [] },
    ]);
  });

  it('no file under lib/mods names an AI route', () => {
    for (const f of files(join(ROOT, 'lib/mods'))) {
      const text = readFileSync(f, 'utf8');
      expect(text, rel(f)).not.toMatch(/['"`]\/api\/ai\b/);
      expect(text, rel(f)).not.toMatch(/['"`]\/api\/chat\b/);
    }
  });
});
