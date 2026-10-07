'use client';

import { MOD_HOST_BACKSTOP_MS, MOD_LOAD_WALL_MS } from './limits';
import {
  fault,
  parseFrameMessage,
  type Fault,
  type HostMessage,
  type ModEventKind,
  type ParsedFrameMessage,
} from './protocol';
import { silentFrameStatus } from './sandbox-probe';
import { MOD_RUNTIME_VERSION } from './sandbox/generated/version';

/**
 * The host's side of the mod sandbox (memory/plans/mods.md, build order 8):
 * one hidden `<iframe sandbox="allow-scripts">` at /mods/sandbox/<version>,
 * shared by the runtime (lib/mods/runtime-manager.ts) and Make's editor, so
 * there is never a second one.
 *
 * Boot: on the iframe's load, one window.postMessage to the frame (target
 * '*', since the frame's origin is opaque) carries the version and a
 * MessageChannel port. From then on the host listens only on its end of that
 * port, and parses every message with parseFrameMessage before anything
 * reads it.
 *
 * - No `ready` within MOD_LOAD_WALL_MS of the iframe's load: the iframe
 *   goes and mods are unavailable in this browser for the session. That is a
 *   console line, not a mod's fault. A frame URL that is a 404 (this tab is
 *   from an older deploy) is `outdated` instead, and a page that never
 *   arrives latches nothing.
 * - `boot-failed` for the version: this tab and the deploy disagree, and
 *   mods wait for a reload.
 * - remove() is the hard kill: every worker in the frame goes with it, and
 *   everyone listening hears onRemoved. The next ensure() mounts a new one.
 *
 * Scratch evaluations (the editor's save) run one at a time, each in a
 * worker of its own, with the host's backstop over the frame's own clock.
 */

export type SandboxStatus = 'idle' | 'booting' | 'ready' | 'unavailable' | 'outdated';

export type ScratchResult =
  | { ok: true; manifestJson: string; hooks: ModEventKind[] }
  | { ok: false; fault: Fault }
  /** The sandbox cannot run here (`unavailable`) or needs a reload (`outdated`). */
  | { ok: false; status: 'unavailable' | 'outdated' };

type Listener = (p: ParsedFrameMessage) => void;

const listeners = new Set<Listener>();
const removedListeners = new Set<() => void>();
let status: SandboxStatus = 'idle';
let iframe: HTMLIFrameElement | null = null;
let port: MessagePort | null = null;
let booting: Promise<SandboxStatus> | null = null;
let holds = 0;

let scratchChain: Promise<unknown> = Promise.resolve();
const scratchWaiters = new Map<string, (r: ScratchResult) => void>();

function settle(next: SandboxStatus): SandboxStatus {
  status = next;
  booting = null;
  return next;
}

function teardown(): void {
  port?.close();
  port = null;
  iframe?.remove();
  iframe = null;
}

function onPortMessage(e: MessageEvent): void {
  const parsed = parseFrameMessage(e.data);
  if (parsed.ok) {
    const m = parsed.message;
    if (m.t === 'ready' || m.t === 'boot-failed') return;
    if (m.t === 'scratched') {
      const done = scratchWaiters.get(m.reqId);
      if (done) done(m.ok ? { ok: true, manifestJson: m.manifestJson, hooks: m.hooks } : { ok: false, fault: m.fault });
      return;
    }
  }
  for (const fn of [...listeners]) {
    try {
      fn(parsed);
    } catch (err) {
      console.error('[mods] sandbox listener failed:', err);
    }
  }
}

/**
 * How long the frame's page may take to arrive. Separate from the boot clock,
 * which starts at the iframe's load: a ~1MB page on a slow connection is not
 * a browser that cannot run mods, so running out of this one latches nothing,
 * and the next ensure() tries again.
 */
const FRAME_FETCH_MS = 30_000;

/** Ends the boot in flight, if any, as `idle`: remove() was called under it. */
let cancelBoot: (() => void) | null = null;

const OUTDATED_WHY = 'Mods wait for a reload: the sandbox is from another version of dsul.';
const UNAVAILABLE_WHY = 'Mods are unavailable in this browser: the sandbox did not start.';

function boot(): Promise<SandboxStatus> {
  if (typeof document === 'undefined') return Promise.resolve(settle('unavailable'));
  status = 'booting';
  return new Promise<SandboxStatus>((resolve) => {
    const src = `/mods/sandbox/${MOD_RUNTIME_VERSION}`;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.hidden = true;
    frame.src = src;
    iframe = frame;

    let finished = false;
    let bootTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * `latch` false: this attempt failed, but the next ensure() boots again.
     * A frame that is no longer the mounted one (remove() ran, or a newer boot
     * took its place) settles nothing: status and `booting` are theirs now.
     */
    const finish = (next: SandboxStatus, why?: string, latch = true) => {
      if (finished) return;
      finished = true;
      clearTimeout(fetchTimer);
      if (bootTimer) clearTimeout(bootTimer);
      if (cancelBoot === cancel) cancelBoot = null;
      if (iframe !== frame) return resolve('idle');
      if (next !== 'ready') {
        if (why) console.warn(`[mods] ${why}`);
        teardown();
      }
      if (!latch) {
        settle('idle');
        return resolve(next);
      }
      resolve(settle(next));
    };
    const cancel = () => finish('idle');
    cancelBoot = cancel;
    const fetchTimer = setTimeout(
      () => finish('unavailable', 'The mod sandbox did not load; it will be tried again.', false),
      FRAME_FETCH_MS
    );

    frame.addEventListener('load', () => {
      // Only the first load boots; the frame never navigates itself.
      if (finished || bootTimer) return;
      if (iframe !== frame || !frame.contentWindow) return finish('unavailable');
      clearTimeout(fetchTimer);
      // The boot clock starts once the page is here, as the plan says: it
      // covers the frame's compile and the ready round trip, not the network.
      bootTimer = setTimeout(() => {
        void silentFrameStatus(src).then((s) => finish(s, s === 'outdated' ? OUTDATED_WHY : UNAVAILABLE_WHY));
      }, MOD_LOAD_WALL_MS);
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (e) => {
        const parsed = parseFrameMessage(e.data);
        if (!finished && parsed.ok) {
          const m = parsed.message;
          if (m.t === 'ready') {
            if (m.v === MOD_RUNTIME_VERSION) {
              port!.onmessage = onPortMessage;
              return finish('ready');
            }
            return finish('outdated', OUTDATED_WHY);
          }
          if (m.t === 'boot-failed') {
            return m.reason === 'version'
              ? finish('outdated', OUTDATED_WHY)
              : finish('unavailable', `Mods are unavailable in this browser: ${m.message ?? 'the sandbox did not start'}.`);
          }
        }
      };
      frame.contentWindow.postMessage({ ch: 'dsul-mods', t: 'boot', v: MOD_RUNTIME_VERSION }, '*', [channel.port2]);
    });
    document.body.appendChild(frame);
  });
}

export const modSandbox = {
  status: (): SandboxStatus => status,

  /** Mounts and boots the frame if it is not up. `unavailable` and `outdated` hold for the session. */
  ensure(): Promise<SandboxStatus> {
    if (status === 'ready' || status === 'unavailable' || status === 'outdated') return Promise.resolve(status);
    return (booting ??= boot());
  },

  /** False when the frame is not up, and nothing was sent. */
  post(message: HostMessage): boolean {
    if (status !== 'ready' || !port) return false;
    port.postMessage(message);
    return true;
  },

  /** Every message from the frame but the boot and scratch ones, parsed, failures included. */
  onMessage(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },

  /** The frame went: every worker in it, and every load and hook in flight, with it. */
  onRemoved(fn: () => void): () => void {
    removedListeners.add(fn);
    return () => {
      removedListeners.delete(fn);
    };
  },

  /** The hard kill. A latched `unavailable` or `outdated` stays. */
  remove(): void {
    const was = iframe;
    const cancel = cancelBoot;
    teardown();
    if (status === 'ready' || status === 'booting') settle('idle');
    // A boot in flight ends here, as `idle`: its clocks must not latch a
    // frame that is already gone, or overwrite a newer boot's status.
    cancel?.();
    for (const [, done] of scratchWaiters) done({ ok: false, fault: fault('wall', 'the sandbox was stopped') });
    scratchWaiters.clear();
    if (was) {
      for (const fn of [...removedListeners]) {
        try {
          fn();
        } catch (err) {
          console.error('[mods] sandbox listener failed:', err);
        }
      }
    }
  },

  /** Keeps the frame while held; the last release removes it. Returns the release. */
  hold(): () => void {
    holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds--;
      if (holds === 0) modSandbox.remove();
    };
  },

  /**
   * Evaluates source in a throwaway worker with no `$` and no hook: its
   * manifest and the events it registers, or the fault. One at a time.
   */
  scratch(source: string): Promise<ScratchResult> {
    const run = async (): Promise<ScratchResult> => {
      const release = modSandbox.hold();
      try {
        const s = await modSandbox.ensure();
        if (s === 'unavailable' || s === 'outdated') return { ok: false, status: s };
        if (s !== 'ready') return { ok: false, status: 'unavailable' };
        const reqId = crypto.randomUUID();
        return await new Promise<ScratchResult>((resolve) => {
          const timer = setTimeout(() => {
            scratchWaiters.delete(reqId);
            resolve({ ok: false, fault: fault('wall', 'the sandbox stopped answering') });
            modSandbox.remove();
          }, MOD_HOST_BACKSTOP_MS);
          scratchWaiters.set(reqId, (r) => {
            clearTimeout(timer);
            scratchWaiters.delete(reqId);
            resolve(r);
          });
          if (!modSandbox.post({ t: 'scratch', reqId, source })) {
            scratchWaiters.get(reqId)?.({ ok: false, status: 'unavailable' });
          }
        });
      } finally {
        release();
      }
    };
    const next = scratchChain.then(run, run);
    scratchChain = next.catch(() => {});
    return next;
  },
};

export type ModSandbox = typeof modSandbox;

/** Test-only: back to no frame, no listeners. */
export function __resetModSandboxForTests(): void {
  const cancel = cancelBoot;
  teardown();
  cancel?.();
  cancelBoot = null;
  listeners.clear();
  removedListeners.clear();
  scratchWaiters.clear();
  status = 'idle';
  booting = null;
  holds = 0;
  scratchChain = Promise.resolve();
}
