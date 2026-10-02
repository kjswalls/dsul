'use strict';

// Where the desktop window opens: the size and place it was left at, fitted to the displays that
// are connected now. Pure, like policy.cjs, so the root unit suite can test it
// (tests/unit/electron-window-state.test.ts). main.cjs reads and writes window-state.json and
// asks Electron's screen module for the displays; every decision about them is made here.
//
// Every rect is Electron's: DIP, the window's outer frame, measured from the primary display's
// top-left corner. A display left of or above the primary has negative coordinates, so a
// negative x or y is a place, not damage.
//
// This is not Electron's experimental windowStatePersistence option, and that option must never
// be turned on beside it: two restorers would fight over one window. memory/plans/desktop-app.md
// ("Size and place") says why it was passed over.

// The file's format. A file of any other version is ignored, and the next save replaces it.
const VERSION = 1;
// The first launch, and whenever nothing usable was saved.
const DEFAULT_SIZE = Object.freeze({ width: 1280, height: 860 });
// Below 768px the mobile shell renders and below 1180px the item panel overlays the page; 900
// keeps the desktop layout. main.cjs passes these as minWidth and minHeight, and the OS holds the
// window to them, so a placement smaller than this would not be the window that opens.
const MIN_SIZE = Object.freeze({ width: 900, height: 600 });
// The window is dragged by its top band: TITLE_BAND_PX in lib/window-chrome.cjs on macOS, the
// native title bar (a little shorter) on Windows. A saved place stands only if the band's whole
// height, and GRAB_PX of its width, are on one display: room to take hold of it beside Windows'
// caption buttons (three of 46px) or the Mac's traffic lights.
const BAND_PX = 43;
const GRAB_PX = 200;
// A window snapped to a Windows screen edge hangs its invisible resize borders (7px a side) past
// the work area. Up to this much overhang is the OS's doing, so the fit rule neither moves nor
// shrinks a snapped window for it. It cannot keep the overhang: Electron's constructor caps a
// Windows window at its display's work area, so a snapped window reopens up to 7px shorter.
const SLACK_PX = 16;
// Larger than any desktop's DIP coordinates. Past it a number is damage, not a place.
const MAX_COORD = 100_000;
// Ids Chromium gives a display that is not a real one: -1 for one not known yet, and -2 for the
// 1920x1080 stand-in it reports when no display is connected (ui/display/types/
// display_constants.h). Windows' own stand-in, and a display that has gone to sleep, report
// `detected: false` instead.
const PLACEHOLDER_IDS = Object.freeze([-1, -2]);

const isCoord = (v) => Number.isInteger(v) && Math.abs(v) <= MAX_COORD;

/** True for a rect Electron could have handed out: integers in range, with a positive size. */
function isRect(r) {
  return (
    !!r &&
    typeof r === 'object' &&
    isCoord(r.x) &&
    isCoord(r.y) &&
    isCoord(r.width) &&
    isCoord(r.height) &&
    r.width > 0 &&
    r.height > 0
  );
}

const rect = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
const sameRect = (a, b) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
// lo wins when the range is empty, which is what puts an oversized window's top-left corner on
// its display rather than its bottom-right one.
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const sharedArea = (a, b) =>
  overlap(a.x, a.x + a.width, b.x, b.x + b.width) *
  overlap(a.y, a.y + a.height, b.y, b.y + b.height);

function isRealDisplay(d) {
  return (
    !!d &&
    typeof d === 'object' &&
    d.detected !== false &&
    !PLACEHOLDER_IDS.includes(d.id) &&
    !!d.size &&
    d.size.width > 0 &&
    d.size.height > 0 &&
    isRect(d.workArea)
  );
}

/**
 * The work areas to place the window on, from screen.getAllDisplays() and
 * screen.getPrimaryDisplay(), without Chromium's placeholders: a window placed on one of those
 * lands nowhere real. The primary counts only if it is one of the real displays; when it is not,
 * fitBounds falls back to the first of them, and with none at all Electron centres the window.
 */
function displayAreas(displays, primaryDisplay) {
  const real = Array.isArray(displays) ? displays.filter(isRealDisplay) : [];
  const primary =
    isRealDisplay(primaryDisplay) && real.some((d) => d.id === primaryDisplay.id)
      ? rect(primaryDisplay.workArea)
      : null;
  return { workAreas: real.map((d) => rect(d.workArea)), primary };
}

function grabbableOn(b, wa) {
  return (
    b.y >= wa.y &&
    b.y + BAND_PX <= wa.y + wa.height &&
    overlap(b.x, b.x + b.width, wa.x, wa.x + wa.width) >= GRAB_PX
  );
}

/** True when the window's top band can be taken hold of on one of these work areas. */
function grabbable(bounds, workAreas) {
  if (!isRect(bounds) || !Array.isArray(workAreas)) return false;
  return workAreas.some((wa) => isRect(wa) && grabbableOn(bounds, wa));
}

// No smaller than the minimum, and no larger than the work area (give or take the slack) unless
// the minimum is.
const fitLength = (length, min, room) => Math.max(min, length <= room + SLACK_PX ? length : room);
function fitSize(size, wa) {
  return {
    width: fitLength(size.width, MIN_SIZE.width, wa.width),
    height: fitLength(size.height, MIN_SIZE.height, wa.height),
  };
}

function centre(size, wa) {
  return {
    x: wa.x + Math.max(0, Math.floor((wa.width - size.width) / 2)),
    y: wa.y + Math.max(0, Math.floor((wa.height - size.height) / 2)),
    width: size.width,
    height: size.height,
  };
}

// The least move that puts the whole window on the work area, or its top-left corner there when
// the window is the larger.
function clampInto(b, wa) {
  return {
    x: clamp(b.x, wa.x, wa.x + wa.width - b.width),
    y: clamp(b.y, wa.y, wa.y + wa.height - b.height),
    width: b.width,
    height: b.height,
  };
}

// fitBounds' rect, with the work area it was fitted to.
function fit(bounds, workAreas, primary) {
  const areas = Array.isArray(workAreas) ? workAreas.filter(isRect) : [];
  const home = isRect(primary) ? primary : areas[0];
  if (!home) return null;
  if (!isRect(bounds)) return { rect: centre(fitSize(DEFAULT_SIZE, home), home), area: home };

  let target = null;
  let most = 0;
  for (const wa of areas) {
    const shared = sharedArea(bounds, wa);
    if (shared > most) {
      most = shared;
      target = wa;
    }
  }
  if (!target) return { rect: centre(fitSize(bounds, home), home), area: home };

  const size = fitSize(bounds, target);
  const kept = { x: bounds.x, y: bounds.y, width: size.width, height: size.height };
  const resized = size.width !== bounds.width || size.height !== bounds.height;
  if (!resized && grabbable(kept, areas)) return { rect: kept, area: target };
  return { rect: clampInto(kept, target), area: target };
}

/**
 * Where a window with these bounds should open, given the work areas of the displays connected
 * now and the primary's. A window that keeps its size and can still be grabbed on some display
 * opens exactly where it was, even partly off one, since people put windows there on purpose. A
 * window across two displays is kept only if it fits the one it is mostly on. One that had to
 * change size, or whose band is out of reach, moves wholly onto the display it overlaps most.
 * One that overlaps none (its display was unplugged, or the displays were rearranged) is centred
 * on the primary. Null when there is no display to place on.
 */
function fitBounds(bounds, workAreas, primary) {
  const placed = fit(bounds, workAreas, primary);
  return placed && placed.rect;
}

/**
 * The BrowserWindow bounds and maximized flag to open with: parseWindowState's result (or null)
 * fitted to the displays connected now. With no display to measure, today's default size and no
 * position, which Electron centres.
 *
 * A window that had to shrink until it is exactly its display's work area (a large window whose
 * display was unplugged, or a scale that went up) opens maximized from the default size instead.
 * On a Mac a frame exactly the size of the work area already counts as zoomed, so maximize()
 * would do nothing and the green button would have no smaller frame to go back to. A window the
 * user left exactly that size is not one the fit made, and opens as it was.
 */
function placeWindow(saved, workAreas, primary) {
  const usable = saved && isRect(saved.bounds) ? saved : null;
  const placed = fit(usable && usable.bounds, workAreas, primary);
  if (!placed) return { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height, maximized: false };
  const { rect: b, area } = placed;
  const filled =
    !!usable &&
    b.width === area.width &&
    b.height === area.height &&
    (usable.bounds.width > b.width || usable.bounds.height > b.height);
  if (filled) return { ...centre(fitSize(DEFAULT_SIZE, area), area), maximized: true };
  return { ...b, maximized: !!usable && usable.maximized === true };
}

/**
 * window-state.json's text read back as `{ bounds, maximized }`, or null for anything this
 * version did not write: an empty or cut-short file, another version, a hand edit out of shape.
 */
function parseWindowState(text) {
  if (typeof text !== 'string' || text.length > 1024) return null;
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object' || record.v !== VERSION) return null;
  if (typeof record.maximized !== 'boolean') return null;
  const bounds = rect(record);
  return isRect(bounds) ? { bounds, maximized: record.maximized } : null;
}

/** The file's text for a state from windowStateToSave. */
function serializeWindowState(state) {
  const { x, y, width, height } = state.bounds;
  return JSON.stringify({ v: VERSION, x, y, width, height, maximized: state.maximized === true });
}

/**
 * What to save for the window as it is now, or null to leave the file alone. `now` is read off
 * the BrowserWindow, `{ bounds, normalBounds, maximized, minimized, fullScreen }`; `last` is the
 * state last saved, or the one the window opened with. `opened` is `{ asked, got }`: the bounds
 * the window was created with and the bounds it reported straight after.
 *
 * - Full screen is never saved, so the window reopens as it was before it went full screen. On a
 *   Mac a restored full screen would open into a Space of its own at launch.
 * - A minimized window saves nothing: Windows reports a minimized window as not maximized even
 *   when it will restore maximized. So a move made in the half second before a minimize can be
 *   lost.
 * - A maximized window saves the bounds it un-maximizes to, and the flag. Windows reads those
 *   from the window's placement. macOS answers getNormalBounds from a frame that AppKit's own
 *   zoom (the green button, Window > Zoom) never updates, so a Mac keeps the last bounds it saw
 *   while the window was normal. A move in the half second before a zoom is missed, since
 *   nothing main can see marks the start of one.
 * - At 125% or 150% on Windows a DIP rect does not survive the trip to pixels and back, and
 *   Electron's constructor makes several, so a window can open a pixel or two larger than it was
 *   asked to be. Bounds equal to what the window got are saved as what it asked for, or the
 *   window would grow at every launch. Only a real move or resize changes the file.
 */
function windowStateToSave(now, last, platform, opened) {
  if (!now || now.fullScreen || now.minimized) return null;
  let bounds = now.bounds;
  if (now.maximized) {
    bounds = platform === 'darwin' && last && isRect(last.bounds) ? last.bounds : now.normalBounds;
  }
  if (!isRect(bounds)) return null;
  if (opened && isRect(opened.asked) && isRect(opened.got) && sameRect(bounds, opened.got)) {
    bounds = opened.asked;
  }
  return { bounds: rect(bounds), maximized: !!now.maximized };
}

module.exports = {
  VERSION,
  DEFAULT_SIZE,
  MIN_SIZE,
  BAND_PX,
  GRAB_PX,
  displayAreas,
  grabbable,
  fitBounds,
  placeWindow,
  parseWindowState,
  serializeWindowState,
  windowStateToSave,
};
