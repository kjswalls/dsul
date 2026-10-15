/**
 * What this browser is called in OpenClaw's own device list
 * (`openclaw devices list`, Devices in the Control UI), so two paired browsers
 * can be told apart: "dsul · Chrome on macOS", "dsul · Safari on iPhone",
 * "dsul · desktop app on Windows".
 *
 * It is the connect frame's `client.displayName`. The gateway keeps it as
 * display metadata and refreshes it on every connect; it pins only the
 * platform and device family, so a name that changes (a browser update, a
 * new OS) never asks for approval again. Derived from the user agent, never
 * stored: it is the same answer on every load of the same browser.
 */

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/Electron\//, 'desktop app'],
  [/Edg(A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/iPhone|iPod/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

const first = (ua: string, table: ReadonlyArray<[RegExp, string]>) => table.find(([re]) => re.test(ua))?.[1] ?? null;

export function browserDeviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const browser = first(ua, BROWSERS);
  const system = first(ua, SYSTEMS);
  const what = browser && system ? `${browser} on ${system}` : browser ?? system;
  return what ? `dsul · ${what}` : 'dsul';
}

/** This browser's name, or plain "dsul" where there is no navigator (the server, a test without one). */
export function thisBrowserName(): string {
  return browserDeviceName(typeof navigator === 'undefined' ? undefined : navigator.userAgent);
}
