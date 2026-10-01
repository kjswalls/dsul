import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * No client surface asks the auth server who is signed in.
 *
 * Every `supabase.auth.getUser()` is a GET /auth/v1/user, and the ones that
 * lived in mount effects (the sidebar user card, the mobile profile menu,
 * AppShell's onboarding check, the chat conversation) all fired in the
 * cold-start burst on every load. The provider already holds the session user:
 *
 *   - for display (name, email, avatar) read `useSessionUserStore`
 *     (lib/session-user-store.ts) — display only, never authorization;
 *   - for "which account" read planner-store's `userId` (stamped by
 *     identifyUser before any load).
 *
 * app/api/** is server code, where getUser IS the access check, and is not
 * scanned. The allowlist is for a client page where a server-validated user is
 * the point.
 */
const ROOT = path.resolve(__dirname, '../..');
const SCAN = ['components', 'app', 'lib', 'hooks'];
const ALLOWED = new Set(['app/connect/page.tsx']);

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (rel === 'app/api' || name === 'node_modules') continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
}

describe('no mount-time auth.getUser() outside the API', () => {
  it('only allowlisted client files call .auth.getUser(', () => {
    const files: string[] = [];
    for (const d of SCAN) walk(path.join(ROOT, d), files);
    expect(files.length).toBeGreaterThan(50);

    const offenders = files.filter(
      (f) => !ALLOWED.has(f) && /\.auth\.getUser\(/.test(readFileSync(path.join(ROOT, f), 'utf8'))
    );
    expect(
      offenders,
      'Read the signed-in user from useSessionUserStore (display) or planner-store `userId` ' +
        '(which account) instead of a GET /auth/v1/user — see lib/session-user-store.ts'
    ).toEqual([]);
  });

  it('still finds the allowlisted call, so the scan is not vacuous', () => {
    for (const f of ALLOWED) {
      expect(readFileSync(path.join(ROOT, f), 'utf8')).toMatch(/\.auth\.getUser\(/);
    }
  });
});
