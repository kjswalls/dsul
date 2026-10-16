'use strict';

// Pocket: the numbers and decisions main.cjs uses for the Do stuff pocket, a small always-on-top
// window that keeps the current item in view while another app is in front (Kirby's pick,
// 2026-10-16; memory/plans/power-mode.md). Pure, like find-bar.cjs, so the root unit suite can
// test it (tests/unit/electron-pocket.test.ts). The window's page is pocket.html, wired by
// pocket-preload.cjs; the page in the main window decides what is current and does every write.

// The window, in DIPs, and how far it keeps from the work area's top-right corner.
const POCKET = Object.freeze({ width: 320, height: 104, margin: 16 });

// pocket.html's ground in each scheme, painted on the window too so nothing flashes before the
// page does. It follows the OS scheme (nativeTheme), like the find bar, not dsul's Theme setting.
const POCKET_BG = Object.freeze({ light: '#ffffff', dark: '#1b1e24' });

// A title or a block's name is typed by hand; anything longer is cut, never refused.
const MAX_TEXT = 200;

// What the pocket can ask for. done and skip go to the page, which checks the id is still its
// current item; open and close are main's own.
const ACTIONS = Object.freeze(['done', 'skip', 'open', 'close']);

const text = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT) : '');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * What the page publishes, cut down to what the pocket shows, or null for "nothing current" (Do
 * stuff off, or a shape this shell doesn't know). The page is the live do.dsul.app, so anything
 * an XSS could send lands here first: only these fields pass, as plain strings and numbers.
 */
function shapePocket(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = text(raw.id);
  const title = text(raw.title);
  if (!id || !title) return null;
  const done = finite(raw.done) ? Math.max(0, Math.min(999, Math.floor(raw.done))) : 0;
  let sprint = null;
  const s = raw.sprint;
  if (s && typeof s === 'object' && finite(s.startedAt) && finite(s.endsAt) && s.endsAt > s.startedAt) {
    sprint = { startedAt: s.startedAt, endsAt: s.endsAt, until: text(s.until) || null };
  }
  return { id, title, done, sprint };
}

/** A pocket button's message, or null for anything else. */
function parseAction(raw) {
  if (!raw || typeof raw !== 'object' || !ACTIONS.includes(raw.action)) return null;
  const id = text(raw.id);
  if ((raw.action === 'done' || raw.action === 'skip') && !id) return null;
  return id ? { action: raw.action, id } : { action: raw.action };
}

/**
 * Where the pocket opens: where it was last left, while that is still on a display, or else the
 * top-right corner of `workArea` (the primary display's). `last` is kept in memory only; a
 * pocket is something you open for a while, like the mode it shows.
 */
function pocketBounds(workArea, last, displays) {
  const size = { width: POCKET.width, height: POCKET.height };
  if (last && finite(last.x) && finite(last.y)) {
    const onScreen = (displays || []).some((d) => {
      const a = d && d.workArea;
      return (
        a &&
        last.x >= a.x &&
        last.y >= a.y &&
        last.x + size.width <= a.x + a.width &&
        last.y + size.height <= a.y + a.height
      );
    });
    if (onScreen) return { x: Math.round(last.x), y: Math.round(last.y), ...size };
  }
  const a = workArea || { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: Math.round(a.x + Math.max(0, a.width - size.width - POCKET.margin)),
    y: Math.round(a.y + POCKET.margin),
    ...size,
  };
}

module.exports = { POCKET, POCKET_BG, MAX_TEXT, ACTIONS, shapePocket, parseAction, pocketBounds };
