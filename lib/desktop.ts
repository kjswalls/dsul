/**
 * What the desktop app's preload puts on `window.dsulDesktop` (electron/preload.cjs).
 *
 * It is everything the page can reach in the shell, and anything that runs on
 * the page can reach it too, so it stays this small: no generic send or
 * invoke, and every call is checked again in the main process. `version` is
 * what lets a newer site talk to an older shell: the web side only trusts a
 * shape it knows.
 */
export interface DsulDesktop {
  version: 1;
  shellVersion: string;
  electronVersion: string;
  platform: 'darwin' | 'win32' | 'linux';
  /** Fires on the global quick-capture shortcut and the tray's New task. Returns an unsubscribe. */
  onQuickCapture(cb: () => void): () => void;
  /**
   * Which providers `openAuthUrl` accepts. Optional, like `setAppIcon`: a shell
   * built before Apple lacks it and opens Google only.
   */
  authProviders?: readonly string[];
  /** Opens a Google or Apple authorize URL in the system browser. False when main refused it. */
  openAuthUrl(url: string): Promise<boolean>;
  /** Tells main an email link is on its way, so the dsul:// link it ends on is accepted. */
  armEmailSignIn(): Promise<void>;
  /** True once after a desktop sign-in handoff completed, then false. */
  takeSignInNotice(): Promise<boolean>;
  /**
   * Swaps the Dock / taskbar icon to the picked look (lib/app-icons.ts) and
   * remembers it for the next launch. False when main refused it.
   *
   * Optional, and `version` stays 1: a shell built before it simply lacks the
   * member, and bumping the version would make every older shell's bridge
   * unreadable, sign-in and quick capture included. Feature-detect it.
   */
  setAppIcon?(look: 'aurora' | 'lime'): Promise<boolean>;
}

/**
 * The desktop bridge, or null in a browser and on the server.
 *
 * Every desktop-only branch on the web side starts here rather than sniffing
 * the user agent. Call it in a handler or an effect, never during render: the
 * server has no window, so a render that branched on it would not hydrate.
 */
export function getDesktopBridge(): DsulDesktop | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.dsulDesktop;
  return bridge?.version === 1 ? bridge : null;
}
