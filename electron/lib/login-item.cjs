'use strict';

// Open at login: what the tray's checkbox shows, and what main asks the OS for when it is
// clicked. Pure, like policy.cjs, so the root unit suite can test each platform's reading
// (tests/unit/electron-login-item.test.ts).
//
// The box shows what dsul registered, read back from app.getLoginItemSettings(), never what dsul
// last asked for. Electron hears nothing when macOS holds or refuses a registration, and on
// either OS the user can switch it off elsewhere without dsul hearing (System Settings > General
// > Login Items; Task Manager > Startup apps).

// main finds the tray item by this id to keep its tick current without rebuilding the menu.
const LOGIN_ITEM_ID = 'open-at-login';

// The greyed-out line under the box on a Mac copy that can't register from where it runs: the
// mounted disk image, or a copy macOS runs from a randomised path because it was opened where it
// was downloaded (translocation, which can happen inside Applications too). Both would register
// a path that is gone by the next login.
const FROM_APPLICATIONS = 'Open dsul from Applications to use this';

// No reading, or nothing to offer: no box at all, which beats a wrong one.
const NOT_OFFERED = Object.freeze({ offered: false, enabled: false, checked: false, note: null });

/**
 * The app.getLoginItemSettings() argument. Windows only: Electron works out
 * executableWillLaunchAtLogin by parsing the path as a command line, and an unquoted path ends
 * at its first space. Unquoted, a dsul.exe under C:\Users\First Last\ never matches the Run value
 * Electron itself wrote (quoted), so the box would never tick and every click would turn it on
 * again. Electron strips the quotes again where it compares the Run value's own text.
 */
function loginItemQuery(platform, execPath) {
  if (platform !== 'win32' || typeof execPath !== 'string' || !execPath) return undefined;
  return { path: `"${execPath}"` };
}

/**
 * The entry for one reading of app.getLoginItemSettings(): `{ offered, enabled, checked, note }`,
 * where note is the disabled line to show under the box, or null. `where` is
 * `{ packaged, inApplications }`: app.isPackaged, and on macOS app.isInApplicationsFolder().
 */
function loginItemView(platform, settings, where) {
  const { packaged, inApplications } = where || {};
  // A dev build would register the Electron binary itself, not dsul.
  if (packaged !== true || !settings || typeof settings !== 'object') return NOT_OFFERED;
  if (platform === 'darwin') {
    // Electron reads SMAppService.mainAppService's status, and its own openAtLogin is only
    // status === 'enabled'. 'requires-approval' is registered but won't run until the user allows
    // it in System Settings; 'not-registered' may be a registration macOS refused.
    const here = inApplications === true;
    return {
      offered: true,
      enabled: here,
      // Outside Applications the box still shows the truth (an Applications copy's registration,
      // say), but can't change it.
      checked: settings.status === 'enabled',
      note: here ? null : FROM_APPLICATIONS,
    };
  }
  if (platform === 'win32') {
    // Any HKCU or HKLM Run value that starts this dsul.exe, with whatever arguments, and that
    // Task Manager hasn't marked disabled under StartupApproved. openAtLogin is no use here: it
    // compares only the HKCU value's exact text and ignores Task Manager.
    return {
      offered: true,
      enabled: true,
      checked: settings.executableWillLaunchAtLogin === true,
      note: null,
    };
  }
  return NOT_OFFERED;
}

/**
 * The app.setLoginItemSettings() argument for turning it on or off. `appId` is the
 * AppUserModelId, which names the Windows Run value.
 */
function loginItemRequest(platform, open, appId) {
  // macOS: the main app itself (SMAppService.mainAppService, Electron's default type). Path and
  // arguments are Windows-only.
  if (platform !== 'win32') return { openAtLogin: open === true };
  // Windows: HKCU\...\CurrentVersion\Run, running process.execPath with no arguments (Electron's
  // defaults; the per-user installer puts dsul.exe in one place). The value is named after the
  // app id, which is Electron's default too, but build/installer.nsh deletes it by that name on
  // uninstall, so it is spelled out. `enabled` keeps its default, true, so ticking the box also
  // clears a Task Manager "Disabled": the user just asked for it.
  return { openAtLogin: open === true, name: appId };
}

/**
 * Whether main opens System Settings' Login Items after a click: on macOS, when the box was
 * ticked and the read-back says it didn't take. That is either a login item macOS holds until
 * the user allows it, or a registration it refused without a word (an ad-hoc signed build may
 * be refused). The pane is where either is put right, by allowing dsul or adding it with +.
 */
function showLoginItemsPane(platform, open, view) {
  return platform === 'darwin' && open === true && !!view && view.offered === true && !view.checked;
}

module.exports = {
  LOGIN_ITEM_ID,
  FROM_APPLICATIONS,
  NOT_OFFERED,
  loginItemQuery,
  loginItemView,
  loginItemRequest,
  showLoginItemsPane,
};
