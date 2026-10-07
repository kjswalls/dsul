import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * memory/plans/mods.md, build order 8. The worker bundle is built from
 * lib/mods/runtime/ (scripts/build-mod-runtime.mjs), so whatever it imports
 * runs beside a mod's code: only QuickJS, its own files, and the two
 * self-contained shared modules. Those two stay self-contained, because
 * lib/mods/schema.ts would bring @dsul/types and the theme code in with it.
 */
const ROOT = process.cwd();

function files(dir: string, ext = /\.(ts|tsx|mjs|cjs)$/): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

function specifiers(source: string): string[] {
  const re = /\b(?:import|export)\s[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;
  return [...source.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

const rel = (p: string) => p.slice(ROOT.length + 1);

describe('the mod runtime imports', () => {
  const runtime = files(join(ROOT, 'lib/mods/runtime'));

  it('scans the runtime', () => {
    expect(runtime.map(rel).sort()).toEqual(
      expect.arrayContaining(['lib/mods/runtime/core.ts', 'lib/mods/runtime/prelude.ts', 'lib/mods/runtime/worker-entry.ts'])
    );
  });

  it.each(runtime.map((p) => [rel(p), p]))('%s imports only QuickJS, ./*, protocol and limits', (_, path) => {
    for (const spec of specifiers(readFileSync(path, 'utf8'))) {
      expect(spec).toMatch(
        /^(?:quickjs-emscripten|@jitl\/quickjs-wasmfile-release-sync(?:\/[\w-]+)?|\.\/[\w-]+|@\/lib\/mods\/(?:protocol|limits))$/
      );
    }
  });

  it('protocol.ts imports only zod and ./limits, and limits.ts imports nothing', () => {
    expect(specifiers(readFileSync(join(ROOT, 'lib/mods/protocol.ts'), 'utf8')).sort()).toEqual(['./limits', 'zod']);
    expect(specifiers(readFileSync(join(ROOT, 'lib/mods/limits.ts'), 'utf8'))).toEqual([]);
  });

  it('the specifier reader sees every form', () => {
    expect(
      specifiers(`import a from 'a'; import { b } from "b"; import type { C } from 'c'; export * from './d'; import 'e'; await import('f'); require('g');`)
    ).toEqual(['a', 'b', 'c', './d', 'e', 'f', 'g']);
  });
});

describe('the sandbox holds no model key', () => {
  const KEY = ['OPENAI', 'API', 'KEY'].join('_');
  const scanned = [...files(join(ROOT, 'lib/mods/runtime')), ...files(join(ROOT, 'lib/mods/sandbox'))];

  it.each(scanned.map((p) => [rel(p), p]))('%s never names it', (_, path) => {
    expect(readFileSync(path, 'utf8')).not.toContain(KEY);
  });
});

describe('the broker reaches only what a mod may', () => {
  // The broker and the code around it, not the runtime: these run in the page,
  // with the planner and the session client in reach (mods.md, "Never reachable").
  const scanned = [
    'lib/mods/broker-core.ts',
    'lib/mods/broker.ts',
    'lib/mods/runtime-manager.ts',
    'lib/mods/sandbox-host.ts',
  ].map((p) => join(ROOT, p));
  const NEVER = [
    'conversations',
    'model_connections',
    'user_secrets',
    'stake_events',
    'ai-server',
    'fetch(',
    'completedDates',
    'streak',
    '.auth.getUser(',
  ];

  it('scans files that exist', () => {
    for (const path of scanned) expect(existsSync(path), rel(path)).toBe(true);
  });

  it.each(scanned.map((p) => [rel(p), p]))('%s names none of them', (_, path) => {
    const src = readFileSync(path, 'utf8');
    for (const word of NEVER) expect(src.includes(word), `${rel(path)}: ${word}`).toBe(false);
  });
});
