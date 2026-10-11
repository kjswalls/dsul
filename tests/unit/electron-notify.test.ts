import { describe, expect, it } from 'vitest';
import notify from '../../electron/lib/notify.cjs';
import builderConfig from '../../electron/electron-builder.config.cjs';
import { fnSource, read } from './helpers/electron-main';

// The desktop app's reminders (memory/plans/reminders-platforms.md §5.2, PR-1c). The page is the
// clock and claims the cue; main only draws what electron/lib/notify.cjs lets through. CI can't
// run Electron, so main.cjs's load-bearing lines are held as text below, as the other
// electron-*.test.ts files do.
const { shapeNotification, clickEvent, probe, appPath, MAC_BODY_BYTES } = notify;

const ITEM = '44444444-4444-4444-8444-444444444444';
const cue = (over: Record<string, unknown> = {}) => ({
  tag: `dsul-item-${ITEM}`,
  title: 'Vitamins',
  body: '7:30 AM · 3 days',
  url: `/item/${ITEM}`,
  actions: [
    { action: 'done', title: 'Done' },
    { action: 'snooze', title: 'Snooze 15m' },
  ],
  data: { url: `/item/${ITEM}`, itemId: ITEM, dateStr: '2026-10-10', kind: 'cue', key: `cue:${ITEM}:2026-10-10T07:30` },
  ...over,
});

describe('electron/lib/notify.cjs', () => {
  it('stays pure: no requires and no imports, so this suite can load it without Electron', () => {
    const source = read('electron/lib/notify.cjs');
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/^\s*import\b/m);
  });

  it('shapes a cue as the push would show it, with both buttons on macOS and Windows', () => {
    for (const platform of ['darwin', 'win32']) {
      const shaped = shapeNotification(cue(), platform);
      expect(shaped).toEqual({
        tag: `dsul-item-${ITEM}`,
        title: 'Vitamins',
        body: '7:30 AM · 3 days',
        url: `/item/${ITEM}`,
        actions: [
          { type: 'button', text: 'Done' },
          { type: 'button', text: 'Snooze 15m' },
        ],
        actionIds: ['done', 'snooze'],
        data: { url: `/item/${ITEM}`, itemId: ITEM, dateStr: '2026-10-10', kind: 'cue', key: `cue:${ITEM}:2026-10-10T07:30` },
      });
    }
  });

  it('drops the buttons on Linux, and on a notification that names no item and day', () => {
    expect(shapeNotification(cue(), 'linux')?.actions).toEqual([]);
    const noDay = shapeNotification(cue({ data: { itemId: ITEM } }), 'darwin');
    expect(noDay?.actions).toEqual([]);
    expect(noDay?.actionIds).toEqual([]);
  });

  it.each([
    ['a tag that is not dsul’s', { tag: 'other-1' }],
    ['a tag with capitals', { tag: 'dsul-ITEM' }],
    ['no title', { title: '   ' }],
    ['an outside link', { url: 'https://evil.example/x' }],
    ['a protocol-relative link', { url: '//evil.example/x' }],
    ['a backslash link', { url: '/\\evil.example' }],
    ['a javascript link', { url: 'javascript:alert(1)' }],
    ['an unknown button', { actions: [{ action: 'delete', title: 'Delete' }] }],
    ['a repeated button', { actions: [{ action: 'done', title: 'Done' }, { action: 'done', title: 'Done' }] }],
    ['a button with no words', { actions: [{ action: 'done', title: '' }] }],
  ])('refuses %s', (_name, over) => {
    expect(shapeNotification(cue(over), 'darwin')).toBeNull();
  });

  it('refuses what is not a spec at all', () => {
    for (const bad of [null, undefined, 'x', 1, [], [cue()]]) expect(shapeNotification(bad, 'darwin')).toBeNull();
  });

  it('keeps only the data fields a reminder has, in their own shapes', () => {
    const shaped = shapeNotification(
      cue({ data: { itemId: 'not-a-uuid', dateStr: '10/10/2026', kind: 'eval', key: 'rm -rf', extra: 1 } }),
      'darwin',
    );
    expect(shaped?.data).toEqual({ url: `/item/${ITEM}` });
  });

  it('puts the body on one line, and clips it on macOS by bytes without splitting a character', () => {
    expect(shapeNotification(cue({ body: 'a\nb\u0007c' }), 'win32')?.body).toBe('a b c');
    const long = '🌙'.repeat(200);
    const body = shapeNotification(cue({ body: long }), 'darwin')!.body;
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAC_BODY_BYTES);
    expect(body).toBe('🌙'.repeat(MAC_BODY_BYTES / 4));
  });

  it('defaults the link to home, and resolves only in-app paths', () => {
    expect(shapeNotification(cue({ url: undefined }), 'darwin')?.url).toBe('/');
    expect(appPath('/?eod=2026-10-10')).toBe('/?eod=2026-10-10');
    expect(appPath('/item/x y')).toBeNull();
  });

  it('tells the page a plain click, or the button by its index, and nothing for an index nobody drew', () => {
    const shaped = shapeNotification(cue(), 'darwin')!;
    expect(clickEvent(shaped)).toEqual({ type: 'click', tag: shaped.tag, data: shaped.data });
    expect(clickEvent(shaped, 1)).toEqual({ type: 'action', action: 'snooze', tag: shaped.tag, data: shaped.data });
    expect(clickEvent(shaped, 2)).toBeNull();
    expect(clickEvent(shaped, 0.5)).toBeNull();
  });

  it('probes: an unsigned packaged Mac build shows nobody anything, so it never counts as ok', () => {
    expect(probe({ supported: false, platform: 'win32', packaged: true, signed: false })).toBe('unsupported');
    expect(probe({ supported: true, platform: 'darwin', packaged: true, signed: false })).toBe('unsigned');
    expect(probe({ supported: true, platform: 'darwin', packaged: true, signed: true })).toBe('ok');
    expect(probe({ supported: true, platform: 'darwin', packaged: false, signed: false })).toBe('ok');
    expect(probe({ supported: true, platform: 'win32', packaged: true, signed: false })).toBe('ok');
  });

  it('matches the web side’s action ids and cue_log key shape', async () => {
    const { ACTION_DONE, ACTION_SNOOZE } = await import('@/lib/sw/handlers');
    const { CUE_LOG_KEY } = await import('@/lib/reminders/cue-log');
    expect(notify.ACTIONS).toEqual([ACTION_DONE, ACTION_SNOOZE]);
    expect(read('electron/lib/notify.cjs')).toContain(CUE_LOG_KEY.source);
  });
});

describe('main.cjs: the reminders it draws (text locks)', () => {
  const main = read('electron/main.cjs');

  it('never throttles the page, which is the desktop’s reminder clock', () => {
    expect(fnSource(main, 'createWindow')).toMatch(/webPreferences: \{[\s\S]*backgroundThrottling: false,[\s\S]*\}/);
  });

  it('checks the sending frame first in every reminder handler', () => {
    for (const channel of ['dsul:notify', 'dsul:notify-close', 'dsul:idle-seconds', 'dsul:notify-probe']) {
      const start = main.indexOf(`ipcMain.handle('${channel}', `);
      expect(start, channel).toBeGreaterThan(-1);
      const body = main.slice(start, main.indexOf('\n  });', start));
      expect(body.split('\n')[1].trim(), channel).toMatch(/^if \(!fromApp\(event\)/);
    }
  });

  it('draws only what notify.cjs shaped, one per tag, and tells the page through one channel', () => {
    const handler = main.slice(main.indexOf("ipcMain.handle('dsul:notify', "));
    expect(handler.slice(0, 400)).toContain('notify.shapeNotification(spec, process.platform)');
    const show = fnSource(main, 'showNotification');
    expect(show.indexOf('old.close()')).toBeLessThan(show.indexOf('new Notification('));
    expect(show).toContain('notify.clickEvent(shaped)');
    expect(show).toContain('notify.clickEvent(shaped, index)');
    expect(fnSource(main, 'tellNotification')).toContain("win.webContents.send('dsul:notification', message)");
  });

  it('ticks the page on a wake and an unlock', () => {
    expect(main).toMatch(/powerMonitor\.on\('resume', \(\) => \{\n\s+tellWake\(\);/);
    expect(main).toContain("powerMonitor.on('unlock-screen', tellWake);");
    expect(fnSource(main, 'tellWake')).toContain("win.webContents.send('dsul:wake')");
  });

  it('reads whether the build was signed from the packaged package.json, which the builder writes', () => {
    expect(main).toContain("require('./package.json').dsulSigned === true");
    expect(builderConfig.extraMetadata).toEqual({ dsulSigned: expect.any(Boolean) });
    expect(builderConfig.mac.extendInfo).toEqual({ NSUserNotificationAlertStyle: 'alert' });
  });
});

describe('preload.cjs: the reminder members', () => {
  const preload = read('electron/preload.cjs');

  it('adds them beside the rest without bumping the version', () => {
    expect(preload).toContain('version: 1,');
    for (const member of ['notify(spec)', 'closeNotification(tag)', 'idleSeconds()', 'notifyProbe()', 'onNotification(cb)', 'onWake(cb)']) {
      expect(preload, member).toContain(`  ${member} {`);
    }
  });

  it('invokes only the four reminder channels, and never hands the page the IPC event', () => {
    for (const channel of ['dsul:notify', 'dsul:notify-close', 'dsul:idle-seconds', 'dsul:notify-probe']) {
      expect(preload, channel).toContain(`.invoke('${channel}'`);
    }
    expect(preload).toContain("ipcRenderer.on('dsul:notification', (_event, message) => {");
    expect(preload).toContain("ipcRenderer.on('dsul:wake', () => {");
  });
});
