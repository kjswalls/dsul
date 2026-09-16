import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { LEAN_ROUTES, routeNeedsItems } from '@/lib/route-data';

/**
 * The half of `lib/route-data.ts` a human cannot hold in their head.
 *
 * A route named in `LEAN_ROUTES` does not get the item load. If one of them
 * ever starts reading items — a goal chip added to the ledger, a project picker
 * added to settings — it renders an empty store as though the account owned
 * nothing, and no type error says so.
 *
 * FOLLOWS THE IMPORT GRAPH, not just the page file. `/settings` reads the store
 * through `lib/settings/manifest.ts` and a tree of components below
 * `SettingsShell`; a check that only opened `page.tsx` would stay green through
 * exactly the change it exists to catch. The walk reaches 90-odd files from
 * that one page.
 *
 * `userId` and `isLoading` are deliberately NOT item reads: they are the
 * identity and its settled-ness, which is the whole of what a lean route is
 * allowed to want, and why `identifyUser` exists.
 */

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'app');

/** Fields whose presence means "this file renders the account's data". */
const ITEM_FIELDS = [
  'items',
  'tasks',
  'habits',
  'projects',
  'routines',
  'programs',
  'goals',
  'itemTypes',
];

/**
 * The four ways this codebase reaches a planner field.
 *
 * `planner()` is the settings manifest's own accessor (manifest.ts:349), and it
 * is the one that matters most here: every settings record reads through it, so
 * a new `planner().projects` record is precisely how `/settings` would start
 * needing the load. Matching only `s.` / `state.` would miss all of them.
 */
const readPattern = (field: string) =>
  new RegExp(
    `\\bs\\.${field}\\b|\\bstate\\.${field}\\b|planner\\(\\)\\.${field}\\b|getState\\(\\)\\.${field}\\b`
  );

/**
 * Store modules are excluded: `lib/planner-store.ts` obviously contains
 * `s.items`, and so do the other stores that derive from it. They are the
 * DEFINITION of these fields, imported by every route alike — what this test is
 * looking for is a route that CONSUMES them.
 */
const isStoreModule = (file: string) =>
  /(^|\/)lib\/[a-z-]+-store\.ts$/.test(path.relative(ROOT, file));

/**
 * Where a READ counts. The walk follows every import, but only these places
 * can put a field on screen for the route being checked.
 *
 * `lib/commands/**` is the reason this filter exists rather than "anywhere in
 * the graph". The settings manifest imports the shortcut list, which reaches
 * `lib/commands/registry.ts`, whose command HANDLERS read `planner().projects`
 * and `planner().itemTypes` — inside function bodies that run when a command is
 * invoked from the planner's ⌘K, never while /settings renders. Counting those
 * would condemn the route for code it only links to.
 */
const isRenderSurface = (file: string) => {
  const rel = path.relative(ROOT, file);
  return (
    rel.startsWith('app/') || rel.startsWith('components/') || rel.startsWith('lib/settings/')
  );
};

function resolveImport(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null; // a package, not ours
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    base,
  ];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/** Every file reachable from a page, and the item fields each one reads. */
function itemReadsUnder(entry: string): { file: string; fields: string[] }[] {
  const seen = new Set<string>();
  const found: { file: string; fields: string[] }[] = [];

  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');

    if (isRenderSurface(file) && !isStoreModule(file) && src.includes('usePlannerStore')) {
      const fields = ITEM_FIELDS.filter((f) => readPattern(f).test(src));
      if (fields.length) found.push({ file: path.relative(ROOT, file), fields });
    }

    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const resolved = resolveImport(m[1], file);
      if (resolved) walk(resolved);
    }
  };

  walk(entry);
  return found;
}

/** Every `app/**‍/page.tsx`, as the URL path it answers on. */
function pageRoutes(dir: string, urlPath = ''): { route: string; file: string }[] {
  const out: { route: string; file: string }[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Route groups `(x)` add no segment; dynamic `[id]` and catch-alls do.
      const segment = entry.startsWith('(') ? '' : `/${entry}`;
      out.push(...pageRoutes(full, urlPath + segment));
    } else if (entry === 'page.tsx') {
      out.push({ route: urlPath || '/', file: full });
    }
  }
  return out;
}

describe('routeNeedsItems', () => {
  it('defaults to loading — an unknown route is never starved', () => {
    expect(routeNeedsItems('/')).toBe(true);
    expect(routeNeedsItems('/item/abc')).toBe(true);
    expect(routeNeedsItems('/goal/abc')).toBe(true);
    expect(routeNeedsItems('/some/route/invented/later')).toBe(true);
  });

  it('treats a null pathname as unknown, and so as needing items', () => {
    expect(routeNeedsItems(null)).toBe(true);
    expect(routeNeedsItems(undefined)).toBe(true);
    expect(routeNeedsItems('')).toBe(true);
  });

  it('skips the lean routes, including their sub-paths', () => {
    expect(routeNeedsItems('/settings')).toBe(false);
    expect(routeNeedsItems('/settings/day')).toBe(false);
    expect(routeNeedsItems('/settings/extensions/beemindr')).toBe(false);
    expect(routeNeedsItems('/ledger')).toBe(false);
    expect(routeNeedsItems('/connect')).toBe(false);
  });

  it('matches on segment boundaries, not bare prefixes', () => {
    // A future sibling route must not inherit an opt-out by spelling.
    expect(routeNeedsItems('/settings-import')).toBe(true);
    expect(routeNeedsItems('/ledgers')).toBe(true);
    expect(routeNeedsItems('/connective')).toBe(true);
  });

  it('never names a route whose page tree reads item data', () => {
    const offenders = pageRoutes(APP)
      .filter(({ route }) => !routeNeedsItems(route))
      .flatMap(({ route, file }) =>
        itemReadsUnder(file).map((hit) => ({ route, ...hit }))
      );

    // If this fails, something in that route's tree won a planner read since
    // the list was written. Take the route OUT of LEAN_ROUTES — do not weaken
    // the matcher here; the empty store it would otherwise render is silent.
    expect(offenders).toEqual([]);
  });

  it('reaches past the page file, or the check above proves nothing', () => {
    // A positive control for the walk itself. The planner's own page is three
    // lines and reads nothing; every hit here comes from the tree beneath it.
    const settingsPage = pageRoutes(APP).find((p) => p.route.startsWith('/settings'));
    expect(settingsPage).toBeDefined();
    expect(itemReadsUnder(settingsPage!.file).length).toBe(0);

    const planner = pageRoutes(APP).find((p) => p.route === '/');
    expect(readFileSync(planner!.file, 'utf8')).not.toContain('s.items');
    expect(itemReadsUnder(planner!.file).length).toBeGreaterThan(0);
  });

  it('covers every lean route with a page that exists', () => {
    // A stale entry is not dangerous, but it is a claim about a route nobody
    // can check — and it would silently start applying if the path came back.
    const routes = pageRoutes(APP).map((p) => p.route);
    const stale = LEAN_ROUTES.filter(
      (lean) =>
        // `/auth` is a route handler, not a page — it has no page.tsx by design.
        lean !== '/auth' &&
        !routes.some((route) => route === lean || route.startsWith(`${lean}/`))
    );
    expect(stale).toEqual([]);
  });
});
