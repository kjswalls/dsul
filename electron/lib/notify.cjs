'use strict';

// PURE, zero imports: what the page may ask main to show as a native notification
// (memory/plans/reminders-platforms.md §5.2, PR-1c). The page is the desktop's reminder clock
// (lib/reminders/local-tick.ts); main only draws what it is handed, so everything the page sends
// over `dsul:notify` is checked here first. An XSS on do.dsul.app reaches this bridge too, so a
// notification can say nothing main would not let the app say anyway: a short title and body, a
// dsul-* tag, an in-app link, and the two buttons a pushed cue has.

/** The tags the web push uses (lib/reminders/channels/push.ts tagOf): one cue, one slot. */
const TAG = /^dsul-[a-z0-9-]{1,80}$/;

/** The buttons a cue offers, in order (lib/sw/handlers.ts ACTION_DONE, ACTION_SNOOZE). */
const ACTIONS = ['done', 'snooze'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** cue_log's key (lib/reminders/cue-log.ts CUE_LOG_KEY). */
const KEY = /^(?:cue|snooze|last-call|eod|pledge):[A-Za-z0-9:._TZ+-]{1,160}$/;

/** macOS cuts a banner's body long before this; past it the bytes are only a payload. */
const MAC_BODY_BYTES = 256;
const BODY_CHARS = 512;
const TITLE_CHARS = 120;

function str(v) {
  return typeof v === 'string' ? v : '';
}

/** Control characters out, one line, at most `max` characters. */
function oneLine(s, max) {
  const clean = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return [...clean].slice(0, max).join('');
}

/** At most `max` UTF-8 bytes, never cutting a character in half. */
function clipBytes(s, max) {
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > max) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/**
 * The in-app path a click opens, or null. A path on the app ('/item/<id>', '/?eod=…'), never
 * '//host' or a backslash: main resolves it against the app's own origin, and nothing else.
 */
function appPath(url) {
  const s = str(url);
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\') || s.length > 512) return null;
  if (/[\u0000-\u001f\u007f\s]/.test(s)) return null;
  return s;
}

/**
 * The notification to show, or null to refuse the whole request.
 *
 * `spec` is the page's: { tag, title, body?, url?, actions?: [{ action, title }], data? }.
 * Returns { tag, title, body, url, actions: [{ type, text }], actionIds, data }. Buttons go
 * only where Electron draws them (macOS, Windows); Linux gets the click alone.
 */
function shapeNotification(spec, platform) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const tag = str(spec.tag);
  if (!TAG.test(tag)) return null;
  const title = oneLine(str(spec.title), TITLE_CHARS);
  if (!title) return null;
  let body = oneLine(str(spec.body), BODY_CHARS);
  if (platform === 'darwin') body = clipBytes(body, MAC_BODY_BYTES);
  const url = spec.url === undefined ? '/' : appPath(spec.url);
  if (!url) return null;

  const asked = Array.isArray(spec.actions) ? spec.actions : [];
  const buttons = [];
  for (const a of asked) {
    if (!a || typeof a !== 'object') return null;
    const id = str(a.action);
    if (!ACTIONS.includes(id) || buttons.some((b) => b.id === id)) return null;
    const text = oneLine(str(a.title), 24);
    if (!text) return null;
    buttons.push({ id, text });
  }
  const withButtons = platform === 'darwin' || platform === 'win32' ? buttons : [];

  const raw = spec.data && typeof spec.data === 'object' && !Array.isArray(spec.data) ? spec.data : {};
  const data = { url };
  if (UUID.test(str(raw.itemId))) data.itemId = str(raw.itemId);
  if (DAY.test(str(raw.dateStr))) data.dateStr = str(raw.dateStr);
  if (str(raw.kind) === 'cue') data.kind = 'cue';
  if (KEY.test(str(raw.key)) && str(raw.key).length <= 200) data.key = str(raw.key);
  // A button acts on one item for one day; without both it is a plain click.
  const actionable = data.itemId && data.dateStr ? withButtons : [];

  return {
    tag,
    title,
    body,
    url,
    actions: actionable.map((b) => ({ type: 'button', text: b.text })),
    actionIds: actionable.map((b) => b.id),
    data,
  };
}

/**
 * What the page may be told about a click: a plain click, or one of the shown buttons by its
 * index (Electron's 'action' event gives an index into `actions`). Null for an index nobody drew.
 */
function clickEvent(shaped, index) {
  if (index === undefined) return { type: 'click', tag: shaped.tag, data: shaped.data };
  const action = Number.isInteger(index) ? shaped.actionIds[index] : undefined;
  return action ? { type: 'action', action, tag: shaped.tag, data: shaped.data } : null;
}

/**
 * The boot probe's answer: 'ok' when a notification can be seen here; 'unsupported' when the OS
 * has none; 'unsigned' for a packaged Mac build without a Developer ID, whose banners macOS never
 * shows (and so must never claim a cue, or the phone goes quiet for nothing).
 */
function probe({ supported, platform, packaged, signed }) {
  if (!supported) return 'unsupported';
  if (platform === 'darwin' && packaged && !signed) return 'unsigned';
  return 'ok';
}

module.exports = { TAG, ACTIONS, MAC_BODY_BYTES, shapeNotification, clickEvent, probe, appPath };
