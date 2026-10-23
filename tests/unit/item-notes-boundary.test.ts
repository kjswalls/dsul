// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Notes on an item's timeline are never sent to a model, and agents never
 * read them (migration 082, memory/plans/ai-vision.md "notes on the
 * timeline"). Held by a source scan of everything an agent, a model or user
 * code reads through: the API routes, lib/ai-server, MCP, the agent API, the
 * chat context and the stores that send it, the asks, background prep and
 * prep packs, recipes, mods and OpenClaw's browser link. None may name the
 * item_notes table or import an item-notes module. There is no allow-list.
 * (That ChatComposer's note branch never calls sendFrom is a behaviour test,
 * in chat-composer-notes.test.tsx.)
 */

const ROOT = path.resolve(__dirname, '../..');
const SCANNED = [
  'app/api',
  'lib/ai-server',
  'lib/mcp',
  'lib/agent-api.ts',
  'lib/ai-context.ts',
  'lib/conversations-store.ts',
  'lib/proposal-store.ts',
  'lib/open-chat.ts',
  'lib/item-asks.ts',
  'lib/container-asks.ts',
  'lib/background-prep.ts',
  'lib/recipes',
  'lib/mods',
  'lib/openclaw-browser',
];
const SOURCE_EXT = /\.(ts|tsx|js|mjs)$/;

function walk(p: string, out: string[] = []): string[] {
  let stat;
  try {
    stat = statSync(p);
  } catch {
    return out;
  }
  if (stat.isFile()) {
    if (SOURCE_EXT.test(p)) out.push(p);
    return out;
  }
  for (const name of readdirSync(p)) {
    if (name === 'generated' || name === 'node_modules') continue;
    walk(path.join(p, name), out);
  }
  return out;
}

const prepPacks = readdirSync(path.join(ROOT, 'lib'))
  .filter((name) => /^prep-packs.*\.(ts|tsx)$/.test(name))
  .map((name) => path.join('lib', name));

const files = [...SCANNED, ...prepPacks]
  .flatMap((d) => walk(path.join(ROOT, d)))
  .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));

const TABLE = /['"`]item_notes['"`]/;
const IMPORT = /from\s+['"][^'"]*item-notes[^'"]*['"]|import\(\s*['"][^'"]*item-notes[^'"]*['"]\s*\)/;

describe('no agent, model or user code reads a note', () => {
  it('scans something', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('lib/open-chat.ts');
    expect(files).toContain('lib/ai-context.ts');
    expect(files.some((f) => f.startsWith('app/api/agent/'))).toBe(true);
    expect(files.some((f) => f.startsWith('lib/mods/'))).toBe(true);
  });

  it.each(files)('%s names no item_notes table and imports no item-notes module', (f) => {
    const src = readFileSync(path.join(ROOT, f), 'utf8');
    expect(src).not.toMatch(TABLE);
    expect(src).not.toMatch(IMPORT);
  });
});
