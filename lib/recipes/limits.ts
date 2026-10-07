/**
 * A recipe run's limits (memory/plans/mods.md, "Runs"), shared by the browser
 * engine (./engine.ts) and the server runner (./server/). Pure.
 */

/** A run stops at this many writes and logs "did 25 of 31". */
export const RUN_WRITE_CAP = 25;
/** More runs than this in a minute switches the recipe off and says why. */
export const RATE_PER_MINUTE = 10;
/** More runs than this in a day switches the recipe off and says why. */
export const RATE_PER_DAY = 100;
/**
 * 061's CHECK on mod_runs.summary: octet_length(summary::text) <= 4096.
 * tests/unit/mods-migration.test.ts pins the two together. A server run's
 * summary that would pass it drops its Revert ops rather than its log line.
 */
export const MOD_RUN_SUMMARY_MAX_BYTES = 4096;

export const rateReason = (over: 'minute' | 'day') =>
  over === 'minute'
    ? `It ran more than ${RATE_PER_MINUTE} times in a minute.`
    : `It ran more than ${RATE_PER_DAY} times today.`;
