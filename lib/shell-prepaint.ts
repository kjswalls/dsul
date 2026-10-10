/**
 * A pre-paint script in app/layout.tsx that sizes the server shell's braindump
 * silhouette (components/shell/app-shell.tsx, the `mounted` gate) from this
 * browser's own braindump, so the canvas's left edge does not jump when the
 * real shell mounts.
 *
 * It writes `--boot-sidebar-w` on <html>: 0px for a closed braindump, else the
 * width the column will render at, which is renderedSidebarWidth with no rail
 * reserve (nothing docks before the AI gate answers): the stored width, or the
 * default when there is none or it is not a number, bounded by the window as
 * clampSidebarWidth bounds it. Unreadable storage writes nothing, and the
 * silhouette falls back to --sidebar-w's default.
 *
 * ES5 and self-contained: it runs before React. The numbers and the key mirror
 * lib/sidebar-store.ts, which this must not import (that would pull the planner
 * store into the root layout); tests/unit/shell-prepaint.test.ts holds them
 * equal and runs the script against renderedSidebarWidth.
 */

export const SIDEBAR_SETTINGS_KEY = 'dsul-sidebar-settings';
export const PREPAINT_SIDEBAR = { min: 280, max: 720, fallback: 406, minCanvas: 520 } as const;
export const BOOT_SIDEBAR_VAR = '--boot-sidebar-w';

const { min, max, fallback, minCanvas } = PREPAINT_SIDEBAR;

export const SIDEBAR_PREPAINT =
  '(function(){try{' +
  `var s=JSON.parse(localStorage.getItem(${JSON.stringify(SIDEBAR_SETTINGS_KEY)})||'null'),w;` +
  "s=s&&typeof s==='object'&&s.state&&typeof s.state==='object'?s.state:{};" +
  'if(s.leftSidebarOpen===false){w=0}else{' +
  'w=s.leftSidebarWidth;' +
  `if(typeof w!=='number'||!isFinite(w))w=${fallback};` +
  `w=Math.round(Math.min(Math.max(w,${min}),Math.max(${min},Math.min(${max},window.innerWidth-${minCanvas}))))}` +
  `document.documentElement.style.setProperty(${JSON.stringify(BOOT_SIDEBAR_VAR)},w+'px')` +
  '}catch(e){}})()';
