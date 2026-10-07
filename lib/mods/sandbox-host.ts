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
 * - No `ready` within MOD_LOAD_WALL_MS: the iframe goes and mods are
 *   unavailable in this browser for the session. That is a console line,
 *   not a mod's fault.
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

function boot(): Promise<SandboxStatus> {
  if (typeof document === 'undefined') return Promise.resolve(settle('unavailable'));
  status = 'booting';
  return new Promise<SandboxStatus>((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.hidden = true;
    frame.src = `/mods/sandbox/${MOD_RUNTIME_VERSION}`;
    iframe = frame;

    let finished = false;
    const finish = (next: SandboxStatus, why?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Removed while it booted: whatever it says now, it is gone.
      if (iframe !== frame && next === 'ready') return resolve(settle('idle'));
      if (next !== 'ready') {
        if (why) console.warn(`[mods] ${why}`);
        if (iframe === frame) teardown();
      }
      resolve(settle(next));
    };
    const timer = setTimeout(
      () => finish('unavailable', 'Mods are unavailable in this browser: the sandbox did not start.'),
      MOD_LOAD_WALL_MS
    );

    frame.addEventListener('load', () => {
      if (iframe !== frame || !frame.contentWindow) return finish('unavailable');
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
            return finish('outdated', 'Mods wait for a reload: the sandbox is from another version of dsul.');
          }
          if (m.t === 'boot-failed') {
            return m.reason === 'version'
              ? finish('outdated', 'Mods wait for a reload: the sandbox is from another version of dsul.')
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
    teardown();
    if (status === 'ready' || status === 'booting') settle('idle');
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
  teardown();
  listeners.clear();
  removedListeners.clear();
  scratchWaiters.clear();
  status = 'idle';
  booting = null;
  holds = 0;
  scratchChain = Promise.resolve();
}
