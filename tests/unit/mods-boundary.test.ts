import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * memory/plans/mods.md, "Never reachable": user_mods is never exposed to
 * /api/agent/*, MCP or lib/app-api.ts. What a person made is theirs; the agent
 * API has no reason to read it and no business writing it.
 */
const ROOT = process.cwd();
const FORBIDDEN = /\buser_mods\b|\bmod_runs\b|mod_store_set|mods-store|lib\/mods\/|lib\/recipes\//;

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('mods stay out of the agent surface', () => {
  const scanned = [
    ...files(join(ROOT, 'app/api/agent')),
    ...files(join(ROOT, 'app/api/mcp')),
    join(ROOT, 'lib/app-api.ts'),
  ];

  it('scans something', () => {
    expect(scanned.length).toBeGreaterThan(1);
  });

  it.each(scanned.map((p) => [p.slice(ROOT.length + 1), p]))('%s never names user_mods', (_rel, path) => {
    expect(readFileSync(path, 'utf8')).not.toMatch(FORBIDDEN);
  });
});
