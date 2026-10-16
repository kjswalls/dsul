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
  /*
   * Reminders (memory/plans/reminders-platforms.md §5.2, PR-1c). Optional like
   * setAppIcon: a shell built before them lacks every one, and the page then
   * leaves reminders to the server. Feature-detect with `desktopNotifier`.
   */
  /** Shows a native notification main has checked (electron/lib/notify.cjs). False when it refused. */
  notify?(spec: DesktopNotificationSpec): Promise<boolean>;
  closeNotification?(tag: string): Promise<boolean>;
  /** Seconds since the last input anywhere on the computer, or null. */
  idleSeconds?(): Promise<number | null>;
  /** Whether a notification shown here would be seen: 'unsigned' is a Mac build that shows none. */
  notifyProbe?(): Promise<'ok' | 'unsupported' | 'unsigned'>;
  /** A click on one of those notifications, or one of its buttons. Returns an unsubscribe. */
  onNotification?(cb: (event: DesktopNotificationEvent) => void): () => void;
  /** The computer woke or was unlocked. Returns an unsubscribe. */
  onWake?(cb: () => void): () => void;
  /*
   * Do stuff's pocket (electron/main.cjs "Pocket"): a small always-on-top
   * window with the current item. Optional like setAppIcon; feature-detect
   * with `desktopPocket`.
   */
  /** What the pocket shows, or null when nothing is current (which closes it). */
  setPocket?(state: PocketState | null): void;
  /** Shows the pocket without taking the focus. False when there is nothing to show. */
  openPocket?(): Promise<boolean>;
  /** A pocket button pressed on the item `id`. Returns an unsubscribe. */
  onPocketAction?(cb: (message: { action: 'done' | 'skip'; id: string }) => void): () => void;
}

/** What the pocket shows: main keeps only these fields (electron/lib/pocket.cjs shapePocket). */
export interface PocketState {
  id: string;
  title: string;
  /** Done this run. */
  done: number;
  /** The running sprint, as epoch ms (lib/do-stuff.ts Sprint). */
  sprint: { startedAt: number; endsAt: number; until: string | null } | null;
}

export type DesktopPocket = Required<Pick<DsulDesktop, 'setPocket' | 'openPocket' | 'onPocketAction'>>;

/** The bridge's pocket members, all present, or null when this shell has none. */
export function desktopPocket(bridge: DsulDesktop | null = getDesktopBridge()): DesktopPocket | null {
  if (!bridge) return null;
  const { setPocket, openPocket, onPocketAction } = bridge;
  if (typeof setPocket !== 'function' || typeof openPocket !== 'function' || typeof onPocketAction !== 'function') {
    return null;
  }
  return {
    setPocket: setPocket.bind(bridge),
    openPocket: openPocket.bind(bridge),
    onPocketAction: onPocketAction.bind(bridge),
  };
}

export interface DesktopNotificationSpec {
  /** `dsul-…`, the push's tag: one cue, one notification. */
  tag: string;
  title: string;
  body?: string;
  /** An in-app path a click opens. */
  url?: string;
  actions?: { action: 'done' | 'snooze'; title: string }[];
  data?: { itemId?: string; dateStr?: string; kind?: 'cue'; key?: string };
}

export interface DesktopNotificationEvent {
  type: 'click' | 'action';
  action?: 'done' | 'snooze';
  tag: string;
  data: { url: string; itemId?: string; dateStr?: string; kind?: 'cue'; key?: string };
}

/** The bridge's reminder members, all present, or null when this shell has none. */
export type DesktopNotifier = Required<
  Pick<DsulDesktop, 'notify' | 'idleSeconds' | 'notifyProbe' | 'onNotification' | 'onWake'>
>;

export function desktopNotifier(bridge: DsulDesktop | null = getDesktopBridge()): DesktopNotifier | null {
  if (!bridge) return null;
  const { notify, idleSeconds, notifyProbe, onNotification, onWake } = bridge;
  if (
    typeof notify !== 'function' ||
    typeof idleSeconds !== 'function' ||
    typeof notifyProbe !== 'function' ||
    typeof onNotification !== 'function' ||
    typeof onWake !== 'function'
  ) {
    return null;
  }
  return {
    notify: notify.bind(bridge),
    idleSeconds: idleSeconds.bind(bridge),
    notifyProbe: notifyProbe.bind(bridge),
    onNotification: onNotification.bind(bridge),
    onWake: onWake.bind(bridge),
  };
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
