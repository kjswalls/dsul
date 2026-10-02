'use strict';

// Find in page: the numbers and decisions main.cjs uses for the find bar. Pure, like policy.cjs,
// so the root unit suite can test them (tests/unit/electron-find-bar.test.ts). The bar itself is
// find-bar.html, wired by find-preload.cjs; main.cjs "Find in page" says why it is a view of its
// own rather than part of the page.

// The bar's box in the window's content area, in DIPs. It hangs from the top-right corner like
// Chrome's: `top` below whatever the window keeps at the top, `right` in from the edge.
const FIND_BAR = Object.freeze({ width: 360, height: 44, right: 16, top: 8, radius: 10 });

// find-bar.html's ground in each scheme. Main paints the view with it too, so nothing flashes
// before the bar's page does. The bar follows the OS scheme (nativeTheme), like offline.html,
// not dsul's own Theme setting.
const FIND_BAR_BG = Object.freeze({ light: '#ffffff', dark: '#1b1e24' });

// A find string is typed by hand. Anything longer did not come from the bar's own field.
const MAX_QUERY = 500;

// How far Chrome's find bar keeps from a match it steps aside for (find_bar_host.cc,
// kMinFindWndDistanceFromSelection).
const MATCH_GAP = 5;

/**
 * Where the bar goes in a content area (`{ width }`, the window's contentView bounds), with
 * `topInset` DIPs kept at the top. main.cjs passes TITLE_BAND_PX on macOS, where the page's top
 * band is the window's drag region and a click on the bar there would drag the window instead,
 * and 0 under a native frame or in macOS full screen, where the band is gone. Page zoom never
 * moves it: the band is min(43px, env(titlebar-area-height)), and Blink scales env() by 1 / zoom,
 * rounding outward, so the band is ceil(43 / zoom) CSS px, under 43 + zoom DIPs (about 47.3 at
 * the menu's 430%, under 48 at Chromium's 500% ceiling), and the 8 DIPs below it absorb that.
 */
function barBounds(content, topInset) {
  const w = Math.max(0, Math.floor(Number(content && content.width) || 0));
  const barWidth = Math.min(FIND_BAR.width, Math.max(0, w - 2 * FIND_BAR.right));
  return {
    x: Math.max(0, w - FIND_BAR.right - barWidth),
    y: Math.max(0, Math.round(Number(topInset) || 0)) + FIND_BAR.top,
    width: barWidth,
    height: FIND_BAR.height,
  };
}

/**
 * The bar's box moved out of the way of the active match, by Chrome's rule (find_bar_host.cc
 * GetLocationForFindBarView): when the match overlaps the bar, the bar goes to the match's left,
 * MATCH_GAP clear of it, unless that would take it past the left edge, when it stays put.
 * `match` is found-in-page's selectionArea. It is in the bar's units already: DIPs from the
 * page's top-left with the page zoom in them, because Blink divides the match's root-frame rect
 * by the device scale factor and nothing else (find_in_page.cc ReportFindInPageSelection), which
 * is how Chrome's bar reads it too. An empty or unreadable rect moves nothing.
 */
function avoidMatch(bounds, match) {
  if (!match) return bounds;
  const { x, y, width, height } = match;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return bounds;
  const overlaps =
    x < bounds.x + bounds.width &&
    bounds.x < x + width &&
    y < bounds.y + bounds.height &&
    bounds.y < y + height;
  if (!overlaps) return bounds;
  const left = Math.floor(x) - bounds.width - MATCH_GAP;
  return left < 0 ? bounds : { ...bounds, x: left };
}

/** The text main searches for: the bar's field, capped, or '' for anything else. */
function cleanQuery(raw) {
  return typeof raw === 'string' ? raw.slice(0, MAX_QUERY) : '';
}

/**
 * A found-in-page reply as the bar shows it: `{ text: '3 of 12', none: false }`, or
 * `{ text: 'No results', none: true }`. An active-match ordinal outside 1..matches says only how
 * many there are.
 */
function countLabel(result) {
  const matches = result && Number.isInteger(result.matches) && result.matches > 0 ? result.matches : 0;
  if (!matches) return { text: 'No results', none: true };
  const at = result.activeMatchOrdinal;
  if (Number.isInteger(at) && at >= 1 && at <= matches) return { text: `${at} of ${matches}`, none: false };
  return { text: `${matches} found`, none: false };
}

/**
 * Whether a found-in-page reply belongs to the search the bar shows. Every findInPage call takes
 * a higher request id than the last, and `session` is the id of the call that started the shown
 * search: a next or previous step answers with a higher id, an abandoned search with a lower one.
 * No session (0) means no search, so nothing is current.
 */
function isCurrentReply(result, session) {
  return session > 0 && !!result && Number.isInteger(result.requestId) && result.requestId >= session;
}

/**
 * The Find items for the Edit menu, as data main.cjs turns into menu items; `action` names what
 * main does. Each is a menu accelerator, so it fires only for a key the page left alone.
 * - F3 is Windows' find-next key and a Mac's Mission Control, so it is off the Mac, and hidden.
 * - A Mac also gets Control+F, hidden, because Kirby reaches for Ctrl, and the page's own Ctrl/⌘ F
 *   handlers (the settings search, the Organize filter) take either key; the shortcut dispatcher
 *   leaves macOS Control to the text system (lib/commands/keys.ts). In a text field it is Cocoa's
 *   move-forward, which the page handles first, so it should not reach the menu there
 *   [unverified, desktop-app.md Open assumptions 12].
 */
function findMenu(platform) {
  const items = [
    { label: 'Find…', accelerator: 'CommandOrControl+F', action: 'open' },
    { label: 'Find Next', accelerator: 'CommandOrControl+G', action: 'next' },
    { label: 'Find Previous', accelerator: 'Shift+CommandOrControl+G', action: 'previous' },
  ];
  if (platform === 'darwin') {
    items.push({
      label: 'Find…',
      accelerator: 'Control+F',
      action: 'open',
      visible: false,
      acceleratorWorksWhenHidden: true,
    });
  } else {
    items.push(
      { label: 'Find Next', accelerator: 'F3', action: 'next', visible: false },
      { label: 'Find Previous', accelerator: 'Shift+F3', action: 'previous', visible: false },
    );
  }
  return items;
}

/**
 * Where the Find items go in the Edit menu the editMenu role built (`items`, its MenuItems, which
 * carry the role lowercased): right after Select All, where AppKit puts Find, behind a separator.
 * On a Mac one already follows Select All, before Substitutions and Speech; elsewhere Select All
 * is the last item, so one goes in first. `at` is the index for the first item main inserts.
 */
function findMenuPlace(items) {
  const selectAll = items.findIndex((item) => item.role === 'selectall');
  const after = selectAll === -1 ? items.length : selectAll + 1;
  const next = items[after];
  if (next && next.type === 'separator') return { at: after + 1, separator: false };
  return { at: after, separator: true };
}

module.exports = {
  FIND_BAR,
  FIND_BAR_BG,
  MAX_QUERY,
  MATCH_GAP,
  barBounds,
  avoidMatch,
  cleanQuery,
  countLabel,
  isCurrentReply,
  findMenu,
  findMenuPlace,
};
