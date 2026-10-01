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
// - height 43: the band. It is taller than the buttons plus twice macOS's default margin, so
//   Electron reports it as the overlay height (window_buttons_proxy.mm, useCustomHeight).
//
// Windows and Linux keep the native frame. Electron ignores drag regions in a framed window and
// defines no env(titlebar-area-*), so the page's titlebar CSS does nothing there.
const TITLE_BAND_PX = 43;
const MAC_LIGHTS = Object.freeze({ x: 37, y: 20 });

function windowChrome(platform) {
  if (platform !== 'darwin') return {};
  return {
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: MAC_LIGHTS.x, y: MAC_LIGHTS.y },
    titleBarOverlay: { height: TITLE_BAND_PX },
  };
}

module.exports = { TITLE_BAND_PX, MAC_LIGHTS, windowChrome };
