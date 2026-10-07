import { MOD_FAULTS_TO_OFF, MOD_FAULT_WINDOW_MS } from './limits';
import type { FaultCode } from './protocol';

/**
 * When a mod's faults switch it off (memory/plans/mods.md, build order 8):
 * MOD_FAULTS_TO_OFF counted faults inside MOD_FAULT_WINDOW_MS, per tab and in
 * memory. A `rate` fault switches off at once and never waits for the count
 * (lib/mods/runtime-manager.ts). Pure.
 */

export interface FaultCounter {
  /** Counts one fault; true when this one trips the switch. */
  record(modId: string, nowMs: number): boolean;
  /** A save from this tab, or the mod switched on: a fresh start. */
  clear(modId: string): void;
}

export function createFaultCounter({
  threshold = MOD_FAULTS_TO_OFF,
  windowMs = MOD_FAULT_WINDOW_MS,
}: { threshold?: number; windowMs?: number } = {}): FaultCounter {
  const seen = new Map<string, number[]>();
  return {
    record(modId, nowMs) {
      const recent = (seen.get(modId) ?? []).filter((t) => nowMs - t < windowMs);
      recent.push(nowMs);
      seen.set(modId, recent);
      return recent.length >= threshold;
    },
    clear(modId) {
      seen.delete(modId);
    },
  };
}

/** 061 holds disabled_reason to 200 characters. */
const REASON_MAX = 200;

const CODE_WORDS: Record<FaultCode, string> = {
  load: 'It did not load',
  error: 'It hit an error',
  cpu: 'It used too much time',
  memory: 'It used too much memory',
  wall: 'It took too long',
  calls: 'It asked for too much at once',
  rate: 'It ran too often',
  history: 'It changed too much too fast',
  protocol: 'It sent something the app could not read',
  broken: 'It stopped working',
};

/** A fault code in plain words, for Problems and the editor. */
export function faultCodeWords(code: FaultCode): string {
  return CODE_WORDS[code];
}

/**
 * The reason Make shows after "Switched off:". Everything after "Last:" is
 * the mod's own text, so Make draws it under a host frame (build order 8).
 */
export function faultReason(code: FaultCode, message: string): string {
  const head = `${MOD_FAULTS_TO_OFF} errors in ${MOD_FAULT_WINDOW_MS / 60_000} minutes. Last: `;
  return `${head}${message.trim() || faultCodeWords(code)}`.slice(0, REASON_MAX);
}

/**
 * Whether a `wall` fault counts toward switching off: not when the tab was
 * hidden during the hook (hidden frames' timers are throttled), nor after a
 * sleep (the wall clock and the monotonic clock drifted more than 2s apart).
 */
export function wallFaultCounts(t: { hidden: boolean; wallElapsedMs: number; monoElapsedMs: number }): boolean {
  return !t.hidden && Math.abs(t.wallElapsedMs - t.monoElapsedMs) <= 2000;
}
