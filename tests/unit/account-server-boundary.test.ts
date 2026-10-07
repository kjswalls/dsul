// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The lines account deletion draws in the source (memory/plans/account-deletion.md),
 * held by a scan the way tests/unit/ai-server-boundary.test.ts holds the AI's:
 *
 *   - GoTrue's admin delete is called from one file, lib/account-server/delete.ts,
 *     so there is one place that deletes an account and one set of rules for it
 *     (the guard, the order, Apple after the delete).
 *   - lib/account-server (the service client's reads, the Apple key, the delete)
 *     is imported only from app/api/** and lib/account-server/**, so none of it
 *     can reach a browser bundle.
 *   - The client-safe account modules import nothing from it and no Node builtin.
 *   - Nothing secret is ever spelled under ios/: the server's secret key and the
 *     Apple key stay on the server. Code and config files are scanned, Swift
 *     comments included; Markdown is not, so ios/README.md may say which
 *     secrets stay on the server.
 */

const ROOT = path.resolve(__dirname, '../..');
const SCANNED = ['app', 'lib', 'components', 'hooks', 'scripts'];
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.build' || name.startsWith('.')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, keep, out);
    else if (keep(name)) out.push(full);
  }
  return out;
}

const read = (abs: string) => ({
  rel: path.relative(ROOT, abs).split(path.sep).join('/'),
  text: readFileSync(abs, 'utf8'),
});
const FILES = SCANNED.flatMap((d) => walk(path.join(ROOT, d), (n) => SOURCE_EXT.test(n))).map(read);

/** Every module specifier a file imports, re-exports, requires or dynamically imports. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
}

/** `@/lib/account-server`, or a relative path that resolves into it. */
function reachesAccountServer(spec: string, fromRel: string): boolean {
  if (spec === '@/lib/account-server' || spec.startsWith('@/lib/account-server/')) return true;
  if (!spec.startsWith('.')) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  return resolved === 'lib/account-server' || resolved.startsWith('lib/account-server/');
}
const serverSide = (rel: string) => rel.startsWith('app/api/') || rel.startsWith('lib/account-server/');

describe('the account deletion boundary', () => {
  it('scans a real tree', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((f) => f.rel === 'lib/account-server/delete.ts')).toBe(true);
    expect(FILES.some((f) => f.rel === 'app/api/app/account/delete/route.ts')).toBe(true);
  });

  it('calls GoTrue’s admin delete from lib/account-server/delete.ts only', () => {
    const hits = FILES.filter((f) => /\.auth\.admin\.deleteUser\(/.test(f.text)).map((f) => f.rel);
    expect(hits).toEqual(['lib/account-server/delete.ts']);
  });

  it('imports lib/account-server only from app/api/** and lib/account-server/**', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      if (serverSide(f.rel)) continue;
      for (const spec of specifiers(f.text)) {
        if (reachesAccountServer(spec, f.rel)) offenders.push(`${f.rel} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scan sees an import when there is one (guards the regexes)', () => {
    const route = FILES.find((f) => f.rel === 'app/api/account/delete/route.ts');
    expect(route).toBeDefined();
    expect(specifiers(route!.text).some((s) => reachesAccountServer(s, route!.rel))).toBe(true);
    expect(reachesAccountServer('./account-server/delete', 'lib/foo.ts')).toBe(true);
    expect(reachesAccountServer('../../lib/account-server', 'components/settings/x.tsx')).toBe(true);
    expect(reachesAccountServer('./account-types', 'lib/foo.ts')).toBe(false);
    expect(reachesAccountServer('@/lib/account-copy', 'lib/foo.ts')).toBe(false);
  });

  it.each(['lib/account-types.ts', 'lib/account-copy.ts', 'lib/account-client.ts'])(
    '%s is client-safe: no Node builtin, nothing from lib/account-server',
    (rel) => {
      const file = FILES.find((f) => f.rel === rel);
      expect(file, `${rel} exists`).toBeDefined();
      const builtins = new Set(builtinModules);
      const bad = specifiers(file!.text).filter(
        (s) => s.startsWith('node:') || builtins.has(s) || reachesAccountServer(s, rel),
      );
      expect(bad).toEqual([]);
    },
  );

  it('spells no server secret anywhere under ios/', () => {
    const IOS_EXT = /\.(swift|plist|xcconfig|json|yml|yaml|entitlements|sh)$/;
    const files = walk(path.join(ROOT, 'ios'), (n) => IOS_EXT.test(n)).map(read);
    expect(files.some((f) => f.rel.endsWith('.swift'))).toBe(true);
    expect(files.some((f) => f.rel === 'ios/project.yml')).toBe(true);
    // Built from parts so this file is no hit of its own anywhere it is copied.
    const NAMES = [
      ['SUPABASE', 'SECRET', 'KEY'].join('_'),
      ['APPLE', 'PRIVATE', 'KEY'].join('_'),
      ['BEGIN', 'PRIVATE', 'KEY'].join(' '),
      ['sb', 'secret', ''].join('_'),
    ];
    const hits = files.flatMap((f) => NAMES.filter((n) => f.text.includes(n)).map((n) => `${f.rel}: ${n}`));
    expect(hits).toEqual([]);
  });
});
