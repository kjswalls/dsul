import { describe, expect, it } from 'vitest';
import builder from '../../electron/electron-builder.config.cjs';
import loginItem from '../../electron/lib/login-item.cjs';
import { fnSource, read } from './helpers/electron-main';

// Open at login (electron/lib/login-item.cjs): what the tray's checkbox shows for each
// platform's reading of app.getLoginItemSettings(), and the exact requests main sends. The
// readings are shaped like Electron 44's own (shell/common/gin_converters/
// login_item_settings_converter.cc): every platform gets openAtLogin, wasOpenedAtLogin and
// executableWillLaunchAtLogin; macOS adds status, Windows adds launchItems.
const {
  LOGIN_ITEM_ID,
  FROM_APPLICATIONS,
  NOT_OFFERED,
  loginItemQuery,
  loginItemView,
  loginItemRequest,
  showLoginItemsPane,
} = loginItem;

const INSTALLED = { packaged: true, inApplications: true };
const mac = (status: string) => ({
  status,
  openAtLogin: status === 'enabled',
  wasOpenedAtLogin: false,
  executableWillLaunchAtLogin: false,
});
const win = (willLaunch: boolean, openAtLogin = willLaunch) => ({
  openAtLogin,
  wasOpenedAtLogin: false,
  executableWillLaunchAtLogin: willLaunch,
  launchItems: [],
});

describe('electron/lib/login-item.cjs', () => {
  it('stays pure: no requires and no imports, so this suite can load it without Electron', () => {
    const source = read('electron/lib/login-item.cjs');
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/^\s*import\b/m);
  });

  it('offers nothing in a dev build, whatever the OS says', () => {
    // Registering from `electron .` would start the bare Electron binary at login.
    for (const [platform, settings] of [
      ['darwin', mac('enabled')],
      ['win32', win(true)],
    ] as const) {
      expect(loginItemView(platform, settings, { packaged: false, inApplications: true })).toEqual(NOT_OFFERED);
      expect(loginItemView(platform, settings, undefined)).toEqual(NOT_OFFERED);
    }
  });

  it('offers nothing on Linux, or without a reading', () => {
    expect(loginItemView('linux', win(false), INSTALLED).offered).toBe(false);
    expect(loginItemView('freebsd', win(false), INSTALLED).offered).toBe(false);
    for (const settings of [null, undefined, 'enabled', 1]) {
      expect(loginItemView('darwin', settings, INSTALLED).offered).toBe(false);
      expect(loginItemView('win32', settings, INSTALLED).offered).toBe(false);
    }
  });

  it("macOS: ticks only for 'enabled'", () => {
    expect(loginItemView('darwin', mac('enabled'), INSTALLED)).toEqual({
      offered: true,
      enabled: true,
      checked: true,
      note: null,
    });
    // A held login item, one macOS refused or can't find, or a status Electron adds later.
    for (const status of ['requires-approval', 'not-registered', 'not-found', 'something-new']) {
      expect(loginItemView('darwin', mac(status), INSTALLED)).toEqual({
        offered: true,
        enabled: true,
        checked: false,
        note: null,
      });
    }
  });

  it('macOS: reads status, not openAtLogin', () => {
    expect(loginItemView('darwin', { ...mac('not-registered'), openAtLogin: true }, INSTALLED).checked).toBe(false);
  });

  it('macOS: a copy outside Applications shows the truth but cannot change it, and says why', () => {
    // The disk image, or a translocated copy opened from Downloads.
    const away = { packaged: true, inApplications: false };
    expect(loginItemView('darwin', mac('not-registered'), away)).toEqual({
      offered: true,
      enabled: false,
      checked: false,
      note: FROM_APPLICATIONS,
    });
    expect(loginItemView('darwin', mac('enabled'), away)).toMatchObject({ enabled: false, checked: true });
    // Only a definite yes counts as being in Applications.
    expect(loginItemView('darwin', mac('enabled'), { packaged: true }).enabled).toBe(false);
    expect(FROM_APPLICATIONS).toBe('Open dsul from Applications to use this');
  });

  it('Windows: ticks when dsul.exe will actually start, and not when Task Manager disabled it', () => {
    expect(loginItemView('win32', win(true), INSTALLED)).toEqual({
      offered: true,
      enabled: true,
      checked: true,
      note: null,
    });
    // The Run value is still there (openAtLogin), but StartupApproved says Disabled.
    expect(loginItemView('win32', win(false, true), INSTALLED).checked).toBe(false);
    expect(loginItemView('win32', win(false), INSTALLED).checked).toBe(false);
    // inApplications is a macOS question.
    expect(loginItemView('win32', win(true), { packaged: true, inApplications: false })).toMatchObject({
      enabled: true,
      note: null,
    });
  });

  it('asks Windows about the quoted executable, so a path with a space still matches', () => {
    // Electron parses the path as a command line, and an unquoted one ends at its first space.
    expect(loginItemQuery('win32', 'C:\\Users\\First Last\\AppData\\Local\\Programs\\dsul-desktop\\dsul.exe')).toEqual({
      path: '"C:\\Users\\First Last\\AppData\\Local\\Programs\\dsul-desktop\\dsul.exe"',
    });
    expect(loginItemQuery('win32', 'C:\\dsul\\dsul.exe')).toEqual({ path: '"C:\\dsul\\dsul.exe"' });
    // Everywhere else Electron's defaults stand: no path, and on macOS the main app's status.
    expect(loginItemQuery('darwin', '/Applications/dsul.app/Contents/MacOS/dsul')).toBeUndefined();
    expect(loginItemQuery('linux', '/opt/dsul/dsul')).toBeUndefined();
    // Without a path to quote, Electron's own default beats a query for "".
    expect(loginItemQuery('win32', '')).toBeUndefined();
    expect(loginItemQuery('win32', undefined)).toBeUndefined();
  });

  it('asks macOS for the main app and nothing else', () => {
    // SMAppService.mainAppService is Electron's default type; path and args are Windows-only.
    expect(loginItemRequest('darwin', true, 'app.dsul.desktop')).toEqual({ openAtLogin: true });
    expect(loginItemRequest('darwin', false, 'app.dsul.desktop')).toEqual({ openAtLogin: false });
  });

  it('asks Windows for a Run value named after the app id, running dsul.exe with no arguments', () => {
    expect(loginItemRequest('win32', true, 'app.dsul.desktop')).toEqual({
      openAtLogin: true,
      name: 'app.dsul.desktop',
    });
    expect(loginItemRequest('win32', false, 'app.dsul.desktop')).toEqual({
      openAtLogin: false,
      name: 'app.dsul.desktop',
    });
    // No `enabled: false`, which would write the value pre-disabled; no path or args, so the
    // value is exactly the quoted process.execPath.
    const request = loginItemRequest('win32', true, 'app.dsul.desktop');
    expect(request).not.toHaveProperty('enabled');
    expect(request).not.toHaveProperty('path');
    expect(request).not.toHaveProperty('args');
  });

  it('sends a Mac user to Login Items only when a tick did not take', () => {
    const unticked = loginItemView('darwin', mac('requires-approval'), INSTALLED);
    const refused = loginItemView('darwin', mac('not-registered'), INSTALLED);
    const ticked = loginItemView('darwin', mac('enabled'), INSTALLED);
    expect(showLoginItemsPane('darwin', true, unticked)).toBe(true);
    expect(showLoginItemsPane('darwin', true, refused)).toBe(true);
    expect(showLoginItemsPane('darwin', true, ticked)).toBe(false);
    // Unticking never opens anything, and nor does Windows, or a read that failed.
    expect(showLoginItemsPane('darwin', false, refused)).toBe(false);
    expect(showLoginItemsPane('win32', true, loginItemView('win32', win(false), INSTALLED))).toBe(false);
    expect(showLoginItemsPane('darwin', true, NOT_OFFERED)).toBe(false);
    expect(showLoginItemsPane('darwin', true, undefined)).toBe(false);
  });
});

// main.cjs can't run in CI. These hold the few lines the behaviour hangs on.
describe('main.cjs: Open at login', () => {
  const main = read('electron/main.cjs');

  it('writes the setting in one place, with the request this file builds', () => {
    expect(main.match(/setLoginItemSettings\(/g)).toHaveLength(1);
    expect(main).toContain('app.setLoginItemSettings(loginItemRequest(process.platform, open, APP_ID));');
  });

  it('reads it in one place, with the Windows path quoted', () => {
    expect(main.match(/getLoginItemSettings\(/g)).toHaveLength(1);
    expect(main).toContain('app.getLoginItemSettings(loginItemQuery(process.platform, process.execPath));');
  });

  it('never lets a failed read break the tray menu or clear a good tick', () => {
    expect(fnSource(main, 'readLoginItem')).toMatch(/\n {2}\} catch \{\n {4}return NOT_OFFERED;\n {2}\}\n\}/);
    // isInApplicationsFolder is bound only on macOS: unguarded, it throws on Windows and the
    // catch above hides the box there.
    expect(fnSource(main, 'readLoginItem')).toContain('inApplications: IS_MAC && app.isInApplicationsFolder(),');
    expect(main.match(/isInApplicationsFolder\(/g)).toHaveLength(1);
    expect(fnSource(main, 'syncLoginItem')).toMatch(/^function syncLoginItem\(view\) \{\n {2}if \(!view\.offered \|\| !trayMenu\) return;/);
  });

  it('finds the box by the id this file exports, and refreshes it without rebuilding the menu', () => {
    expect(LOGIN_ITEM_ID).toMatch(/^[a-z-]+$/);
    expect(main).not.toContain(`'${LOGIN_ITEM_ID}'`);
    expect(fnSource(main, 'loginMenuItems')).toContain('id: LOGIN_ITEM_ID,');
    const sync = fnSource(main, 'syncLoginItem');
    expect(sync).toContain('trayMenu.getMenuItemById(LOGIN_ITEM_ID)');
    for (const name of ['syncLoginItem', 'refreshLoginItem']) {
      expect(fnSource(main, name)).not.toMatch(/buildFromTemplate|setContextMenu|refreshTrayMenu/);
    }
  });

  it('checks for updates again when the app comes back from the offline page', () => {
    // The retry has to read the offline count before stopOfflineRetry clears it.
    expect(main).toMatch(
      /if \(isApp\(url\)\) \{\n(?: {6}\/\/.*\n)* {6}if \(offlineTries > 0\) checkForUpdate\(\);\n {6}stopOfflineRetry\(\);\n {4}\}/,
    );
  });

  it('names the Run value with the id the uninstaller deletes, and keeps it through an update', () => {
    // electron-builder passes appId to NSIS as ${APP_ID} (app-builder-lib NsisTarget.js), and
    // main names the Run value after APP_ID: the three must stay one string.
    expect(main).toContain("const APP_ID = 'app.dsul.desktop';");
    expect(builder.appId).toBe('app.dsul.desktop');
    const nsh = read('electron/build/installer.nsh');
    const uninstall = nsh.slice(nsh.indexOf('!macro customUnInstall'));
    const kept = uninstall.slice(uninstall.indexOf('${ifNot} ${isUpdated}'), uninstall.indexOf('${endIf}'));
    expect(kept).toContain('DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "${APP_ID}"');
    expect(kept).toContain(
      'DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run" "${APP_ID}"',
    );
    // Nowhere else: an update must keep both.
    expect(nsh.match(/CurrentVersion\\Run" "\$\{APP_ID\}"/g)).toHaveLength(1);
  });
});
