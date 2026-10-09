import { describe, expect, it } from 'vitest';
import { fnSource, read } from './helpers/electron-main';

// CI can't run Electron, so this holds main.cjs's permission handlers in place.
// memory/plans/desktop-app.md, "Permissions".
describe('main.cjs: permissions', () => {
  const session = fnSource(read('electron/main.cjs'), 'configureSession');

  it('grants only clipboard writes and notifications', () => {
    expect(session).toContain("new Set(['clipboard-sanitized-write', 'notifications'])");
  });

  it('refuses every subframe, in both the request and the check handler', () => {
    // The mod sandbox frame is an app URL; isApp alone would let it hold notifications.
    expect(session.match(/details\.isMainFrame !== false &&/g)).toHaveLength(2);
    expect(session.match(/allowed\.has\(permission\) &&\s+isApp\(/g)).toHaveLength(2);
  });
});
