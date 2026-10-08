/**
 * The text that runs in a mod's QuickJS context before the mod does
 * (memory/plans/mods.md, build order 8). ./core.ts evaluates it to a function
 * and calls it once with the host bridge and a JSON config, and keeps the
 * object it returns. The mod's global scope is what QuickJS ships, minus
 * `eval`, plus a read-only `$`.
 *
 * - `$` is built from the config's method list (MOD_METHODS in
 *   lib/mods/protocol.ts), so the two cannot drift. Every method sends its
 *   one argument as JSON and answers with a deep-frozen parse of the reply.
 * - `on(kind, fn)` works only inside register: an unknown kind, a second
 *   handler for one kind, or one too many throws there, which is a load fault.
 * - `describe(e)` turns whatever was thrown into "Name: message" for a fault.
 *   It runs under its own small CPU budget, so a hostile getter costs only
 *   the description.
 *
 * Plain ES5 with the builtins it needs captured up front: a mod that
 * replaces JSON or Object.freeze after this runs changes only what its own
 * code sees. Never a template literal or `${`: this is one.
 */
export const PRELUDE_JS = `(function (host, configJson) {
  'use strict';
  var parse = JSON.parse;
  var stringify = JSON.stringify;
  var freeze = Object.freeze;
  var isFrozen = Object.isFrozen;
  var keys = Object.keys;
  var config = parse(configJson);

  function deepFreeze(v) {
    if (v !== null && typeof v === 'object' && !isFrozen(v)) {
      freeze(v);
      var k = keys(v);
      for (var i = 0; i < k.length; i++) deepFreeze(v[k[i]]);
    }
    return v;
  }
  function wrap(s) { return deepFreeze(parse(s)); }

  var $ = {};
  config.methods.forEach(function (m) {
    var path = m.split('.');
    var o = $;
    for (var i = 0; i < path.length - 1; i++) o = o[path[i]] || (o[path[i]] = {});
    o[path[path.length - 1]] = function (a) {
      return host(m, stringify(a === undefined ? null : a)).then(wrap);
    };
  });
  deepFreeze($);
  // Also a global, so code in the module body or in register can reach it,
  // and be told it is not available yet instead of failing on a name.
  Object.defineProperty(globalThis, '$', { value: $, writable: false, configurable: false, enumerable: false });

  var handlers = Object.create(null);
  var count = 0;
  var open = true;
  function on(kind, fn) {
    if (!open) throw new Error('on() works only inside register');
    if (config.kinds.indexOf(kind) === -1) throw new Error('unknown event: ' + String(kind).slice(0, 40));
    if (typeof fn !== 'function') throw new TypeError('on(kind, fn) needs a function');
    if (handlers[kind]) throw new Error('a handler for ' + kind + ' is already registered');
    if (++count > config.handlersMax) throw new Error('too many handlers');
    handlers[kind] = fn;
  }

  function describe(e) {
    try {
      var s = e instanceof Error ? String(e.name) + ': ' + String(e.message) : 'Uncaught ' + String(e);
      return s.slice(0, 400);
    } catch (x) {
      return 'Uncaught exception';
    }
  }

  delete globalThis.eval;

  return {
    $: $,
    wrap: wrap,
    on: on,
    seal: function () { open = false; },
    handlers: handlers,
    next: function () {},
    stringify: function (v) { return stringify(v); },
    describe: describe
  };
})`;
