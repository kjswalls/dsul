'use strict';

// How the desktop window draws its top edge. Pure, like policy.cjs, so the root unit suite can
// hold these numbers to the page's (tests/unit/electron-window-chrome.test.ts).
//
// macOS has no title bar: the traffic lights sit in dsul's own top band, the 43px every desktop
// page already leaves at the top (desktop-shell.tsx's p-3 = 12px, plus the sidebar's 31px
// wordmark row). titleBarOverlay is what defines env(titlebar-area-*) for the page, and nothing
// else does: not a browser, not the installed PWA, not a framed window, not macOS full screen.
// So the page's titlebar rules (app/globals.css) fall back to today's layout everywhere else.
//
// - x 37: the close button starts on the column the braindump count starts on (12 + 25), which
//   is where the wordmark used to start, and it is about the smallest x at which all three
//   buttons sit inside the canvas card's 30px top-left corner when the sidebar is collapsed
//   (the card is then at x 24). sidebar.tsx's wordmark padding subtracts x - 14 + 12 = 35 from
//   env(titlebar-area-x) to start the word 14px past the green button: change one, change both.
// - y 20: centres a 14-16pt button on the band's midline, 12 + 31 / 2 = 27.5.
//   Both are the places at 100%; macLights, below, moves them with the page zoom.
// - height 43: the band. It is taller than the buttons plus twice macOS's default margin, so
//   Electron reports it as the overlay height (window_buttons_proxy.mm, useCustomHeight).
//
// Windows and Linux keep the native frame. Electron ignores drag regions in a framed window and
// defines no env(titlebar-area-*), so the page's titlebar CSS does nothing there.
const TITLE_BAND_PX = 43;
const MAC_LIGHTS = Object.freeze({ x: 37, y: 20 });

// Page zoom scales the page's band but not the native buttons, so main moves them (main.cjs
// placeLights). The page reads env(titlebar-area-*) as the overlay's points divided by the zoom,
// so the 37 has to scale with it: the word's `- 35px` then still lands about 14 CSS px past the
// green button at every zoom, where a fixed 37 puts the word under the buttons from about 160%.
//
// y keeps the buttons' centre on the zoomed row's midline. The buttons themselves never scale,
// so only the midline moves: y 20 is 7.5 above 27.5, half a button between 14 and 16pt.
const ROW_MIDLINE_PX = 27.5;
// The overlay's height is fixed once the window exists, because Electron has no
// setTitleBarOverlay on macOS. A button below its 43pt would hang out of the title bar view, so
// y stops where a 16pt button's bottom meets it. That is about 125%; past it the buttons sit
// above the midline.
const LIGHTS_Y_MAX = TITLE_BAND_PX - 16;
// Below about 67% the zoomed row is too short for the buttons anyway, and a y near macOS's
// default margin (about 7) makes Electron centre them instead of placing them. So y holds there.
// x has neither problem and keeps following the zoom.
const LIGHTS_Y_ZOOM_MIN = 0.67;
// Chromium's own ceiling on page zoom. A larger factor can't come from a real page.
const LIGHTS_ZOOM_MAX = 5;
// The View menu's step, which is the zoom roles' own: half a level, about 9.5% a press.
const ZOOM_STEP = 0.5;

function windowChrome(platform) {
  if (platform !== 'darwin') return {};
  return {
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: MAC_LIGHTS.x, y: MAC_LIGHTS.y },
    titleBarOverlay: { height: TITLE_BAND_PX },
  };
}

/** Where the traffic lights go at a page zoom factor, in window points. 1 gives MAC_LIGHTS. */
function macLights(zoomFactor) {
  const z = Number.isFinite(zoomFactor) && zoomFactor > 0 ? Math.min(zoomFactor, LIGHTS_ZOOM_MAX) : 1;
  const zy = Math.max(z, LIGHTS_Y_ZOOM_MIN);
  return {
    x: Math.round(MAC_LIGHTS.x * z),
    y: Math.min(LIGHTS_Y_MAX, Math.round(ROW_MIDLINE_PX * zy - (ROW_MIDLINE_PX - MAC_LIGHTS.y))),
  };
}

/** The zoom level after a View menu zoom item: 'in', 'out' or 'reset'. */
function nextZoomLevel(level, action) {
  if (action === 'reset') return 0;
  if (action === 'in') return level + ZOOM_STEP;
  if (action === 'out') return level - ZOOM_STEP;
  return level;
}

module.exports = {
  TITLE_BAND_PX,
  MAC_LIGHTS,
  ROW_MIDLINE_PX,
  LIGHTS_Y_MAX,
  LIGHTS_Y_ZOOM_MIN,
  LIGHTS_ZOOM_MAX,
  ZOOM_STEP,
  windowChrome,
  macLights,
  nextZoomLevel,
};
