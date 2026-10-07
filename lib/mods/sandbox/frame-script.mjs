/**
 * The two scripts the mod sandbox runs (memory/plans/mods.md, build order 8).
 * Plain strings in a plain .mjs, so scripts/build-mod-runtime.mjs imports them
 * with node and hashes exactly these bytes into the page, its CSP and the
 * runtime version.
 *
 * FRAME_SCRIPT_BODY is the frame page's one inline script. The build puts
 * `const SANDBOX_VERSION='…';` in front of it. It must never hold a `<`, so
 * nothing in it can end the script element early (comparisons are written
 * with `>`), and it is a template literal, so it never holds a backtick or a
 * dollar brace either. tests/unit/mods-frame-script.test.ts runs it against
 * fakes.
 *
 * What the frame does:
 * - Takes one boot, only from its parent, on window.postMessage, with the
 *   port it will use from then on. A boot for another version fails, so a
 *   page and a host from different deploys never talk.
 * - Compiles the wasm once, builds one blob of LOCKDOWN_JS plus the worker
 *   bundle, and spawns a worker per mod (and per scratch evaluation).
 * - Relays host ↔ worker. It stamps modId and gen from its own map on every
 *   worker message, drops a message with an unknown `t` or a string over its
 *   cap, and keeps the wall clock: per hook, paused while a call is out, plus
 *   a total; and per load or scratch. On expiry it terminates the worker.
 *
 * The four limits repeat lib/mods/limits.ts, which this file cannot import;
 * the frame test pins them.
 */

export const FRAME_SCRIPT_BODY = `
(function () {
  'use strict';
  var WALL_MS = 500;
  var WALL_TOTAL_MS = 5000;
  var LOAD_WALL_MS = 2000;
  var ARGS_MAX = 16384;
  var MANIFEST_MAX = 8192;
  var TEXT_MAX = 300;
  var FROM_WORKER = { loaded: 1, call: 1, done: 1, gone: 1, scratched: 1 };

  var booted = false;
  var port = null;
  var wasmModule = null;
  var blobUrl = null;
  var recs = new Map();

  function bytesOf(id) {
    var bin = atob(document.getElementById(id).textContent);
    var out = new Uint8Array(bin.length);
    for (var i = 0; bin.length > i; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function textOf(id) {
    return new TextDecoder().decode(bytesOf(id));
  }
  function send(m) {
    port.postMessage(m);
  }
  function failure(code, message) {
    return { code: code, message: String(message).slice(0, TEXT_MAX) };
  }

  addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== parent || booted || !d || d.ch !== 'dsul-mods' || d.t !== 'boot') return;
    if (!e.ports || !e.ports[0]) return;
    booted = true;
    port = e.ports[0];
    if (d.v !== SANDBOX_VERSION) {
      send({ t: 'boot-failed', reason: 'version' });
      return;
    }
    Promise.resolve()
      .then(function () {
        return WebAssembly.compile(bytesOf('wasm'));
      })
      .then(function (m) {
        wasmModule = m;
        var code = [textOf('lockdown'), ';\\n', textOf('w')];
        blobUrl = URL.createObjectURL(new Blob(code, { type: 'text/javascript' }));
        port.onmessage = fromHost;
        send({ t: 'ready', v: SANDBOX_VERSION });
      })
      .catch(function (err) {
        send({ t: 'boot-failed', reason: 'compile', message: String((err && err.message) || err).slice(0, TEXT_MAX) });
      });
  });

  function kill(rec) {
    if (!rec) return;
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = 0;
    clearHook(rec);
    if (rec.worker) rec.worker.terminate();
    if (recs.get(rec.key) === rec) recs.delete(rec.key);
  }

  function clearHook(rec) {
    var h = rec.hook;
    if (!h) return;
    if (h.timer) clearTimeout(h.timer);
    if (h.total) clearTimeout(h.total);
    rec.hook = null;
  }

  function pause(rec) {
    var h = rec.hook;
    if (h && h.timer) {
      clearTimeout(h.timer);
      h.timer = 0;
      h.left -= Date.now() - h.since;
    }
  }

  function resume(rec) {
    var h = rec.hook;
    if (h && !h.timer) {
      h.since = Date.now();
      h.timer = setTimeout(function () {
        hookExpired(rec, 'the hook took too long');
      }, Math.max(0, h.left));
    }
  }

  function hookExpired(rec, message) {
    var h = rec.hook;
    if (!h) return;
    var f = failure('wall', message);
    kill(rec);
    send({ t: 'done', modId: rec.modId, gen: rec.gen, hookId: h.hookId, ok: false, fault: f });
    send({ t: 'gone', modId: rec.modId, gen: rec.gen, fault: f });
  }

  function crashed(rec, message) {
    if (recs.get(rec.key) !== rec) return;
    var f = failure('broken', message);
    var h = rec.hook;
    kill(rec);
    if (rec.kind === 'scratch') {
      send({ t: 'scratched', reqId: rec.reqId, ok: false, fault: f });
    } else if (rec.loading) {
      send({ t: 'loaded', modId: rec.modId, gen: rec.gen, ok: false, fault: f });
    } else {
      if (h) send({ t: 'done', modId: rec.modId, gen: rec.gen, hookId: h.hookId, ok: false, fault: f });
      send({ t: 'gone', modId: rec.modId, gen: rec.gen, fault: f });
    }
  }

  function spawn(rec, request) {
    recs.set(rec.key, rec);
    try {
      rec.worker = new Worker(blobUrl);
    } catch (err) {
      crashed(rec, 'the worker did not start');
      return;
    }
    rec.worker.onmessage = function (e) {
      fromWorker(rec, e.data);
    };
    rec.worker.onerror = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      crashed(rec, 'the worker stopped: ' + String((e && e.message) || 'error'));
    };
    rec.worker.postMessage({ t: 'init', module: wasmModule });
    rec.worker.postMessage(request);
  }

  function tooBig(v, cap, depth) {
    if (typeof v === 'string') return v.length > cap;
    if (!v || typeof v !== 'object') return false;
    if (depth > 2) return true;
    var keys = Object.keys(v);
    if (keys.length > 12) return true;
    for (var i = 0; keys.length > i; i++) {
      var k = keys[i];
      var c = k === 'argsJson' ? ARGS_MAX : k === 'manifestJson' ? MANIFEST_MAX : TEXT_MAX;
      if (tooBig(v[k], c, depth + 1)) return true;
    }
    return false;
  }

  function fromHost(e) {
    var d = e.data;
    var rec;
    if (!d || typeof d.t !== 'string') return;
    if (d.t === 'load') {
      kill(recs.get(d.modId + ':' + d.gen));
      rec = { key: d.modId + ':' + d.gen, kind: 'mod', modId: d.modId, gen: d.gen, loading: true, worker: null, timer: 0, hook: null };
      rec.timer = setTimeout(function () {
        kill(rec);
        send({ t: 'loaded', modId: rec.modId, gen: rec.gen, ok: false, fault: failure('wall', 'the mod took too long to load') });
      }, LOAD_WALL_MS);
      spawn(rec, d);
    } else if (d.t === 'unload') {
      recs.forEach(function (r) {
        if (r.kind === 'mod' && r.modId === d.modId) kill(r);
      });
    } else if (d.t === 'hook') {
      rec = recs.get(d.modId + ':' + d.gen);
      if (!rec || rec.loading || rec.hook) {
        var f = failure('broken', 'the mod is not loaded');
        kill(rec);
        send({ t: 'done', modId: d.modId, gen: d.gen, hookId: d.hookId, ok: false, fault: f });
        send({ t: 'gone', modId: d.modId, gen: d.gen, fault: f });
        return;
      }
      rec.hook = { hookId: d.hookId, left: WALL_MS, since: 0, out: 0, timer: 0, total: 0 };
      rec.hook.total = setTimeout(function () {
        hookExpired(rec, 'the hook ran past its total time');
      }, WALL_TOTAL_MS);
      resume(rec);
      rec.worker.postMessage(d);
    } else if (d.t === 'reply') {
      rec = recs.get(d.modId + ':' + d.gen);
      if (!rec || !rec.hook || rec.hook.hookId !== d.hookId) return;
      if (rec.hook.out > 0) {
        rec.hook.out -= 1;
        if (rec.hook.out === 0) resume(rec);
      }
      rec.worker.postMessage(d);
    } else if (d.t === 'scratch') {
      rec = { key: 's:' + d.reqId, kind: 'scratch', reqId: d.reqId, worker: null, timer: 0, hook: null };
      kill(recs.get(rec.key));
      rec.timer = setTimeout(function () {
        kill(rec);
        send({ t: 'scratched', reqId: rec.reqId, ok: false, fault: failure('wall', 'the code took too long to load') });
      }, LOAD_WALL_MS);
      spawn(rec, d);
    }
  }

  function fromWorker(rec, d) {
    if (recs.get(rec.key) !== rec) return;
    if (!d || typeof d !== 'object' || !Object.prototype.hasOwnProperty.call(FROM_WORKER, d.t)) return;
    if (tooBig(d, TEXT_MAX, 0)) return;
    if (rec.kind === 'scratch') {
      if (d.t !== 'scratched') return;
      d.reqId = rec.reqId;
      kill(rec);
      send(d);
      return;
    }
    if (d.t === 'scratched') return;
    d.modId = rec.modId;
    d.gen = rec.gen;
    if (d.t === 'gone') {
      kill(rec);
      send(d);
    } else if (d.t === 'loaded') {
      if (!rec.loading) return;
      clearTimeout(rec.timer);
      rec.timer = 0;
      rec.loading = false;
      if (!d.ok) kill(rec);
      send(d);
    } else if (d.t === 'call') {
      var h = rec.hook;
      if (!h || h.hookId !== d.hookId) return;
      h.out += 1;
      if (h.out === 1) pause(rec);
      send(d);
    } else if (d.t === 'done') {
      if (!rec.hook || rec.hook.hookId !== d.hookId) return;
      clearHook(rec);
      send(d);
    }
  }
})();
`;

/** The globals LOCKDOWN_JS takes away, own or inherited. */
export const LOCKDOWN_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'EventSource',
  'WebTransport',
  'importScripts',
  'indexedDB',
  'caches',
  'BroadcastChannel',
  'Worker',
  'SharedWorker',
  'Notification',
];

/**
 * Runs first in each mod worker, before the QuickJS glue. Defence in depth:
 * code in QuickJS reaches none of these, because its only way out is the
 * bridge. Each name is deleted wherever it lives on the prototype chain and
 * then pinned to undefined on the worker's global, each step in its own try.
 */
export const LOCKDOWN_JS = `
(function () {
  'use strict';
  var names = ${JSON.stringify(LOCKDOWN_GLOBALS)};
  function lock(obj, k) {
    try { delete obj[k]; } catch (e) {}
    try { Object.defineProperty(obj, k, { value: undefined, writable: false, configurable: false }); } catch (e) {}
  }
  function strip(root, k) {
    var o = root;
    while (o) {
      if (Object.prototype.hasOwnProperty.call(o, k)) {
        try { delete o[k]; } catch (e) {}
      }
      o = Object.getPrototypeOf(o);
    }
    lock(root, k);
  }
  for (var i = 0; names.length > i; i++) strip(self, names[i]);
  try { if (self.navigator) strip(self.navigator, 'serviceWorker'); } catch (e) {}
})();
`;
