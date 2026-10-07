/**
 * A mod's limits (memory/plans/mods.md, build order 8). Shared by the worker
 * bundle (lib/mods/runtime/), the sandbox frame and the host, so it imports
 * nothing: anything it pulled in would land in the worker
 * (scripts/build-mod-runtime.mjs). The frame script cannot import it either,
 * and repeats the four numbers it needs; tests/unit/mods-frame-script.test.ts
 * pins those to these.
 */

/** QuickJS heap and native stack per mod. */
export const MOD_MEMORY_BYTES = 16 << 20;
export const MOD_STACK_BYTES = 256 << 10;

/** CPU per hook, and per load (module body plus register). The interrupt cannot be caught. */
export const MOD_CPU_MS = 50;
export const MOD_LOAD_CPU_MS = 250;

/** The frame's wall clock: per hook (paused while a call is out), per hook in all, and per load or scratch. */
export const MOD_WALL_MS = 500;
export const MOD_WALL_TOTAL_MS = 5000;
export const MOD_LOAD_WALL_MS = 2000;
/** The host's own clock, for a frame that stops answering. */
export const MOD_HOST_BACKSTOP_MS = 6000;

/** `$` calls per hook. */
export const MOD_CALLS_PER_HOOK = 50;
/** RUN_WRITE_CAP (lib/recipes/limits.ts), repeated so this file stays import-free; a test pins the two. */
export const MOD_WRITES_PER_HOOK = 25;

export const MOD_TIMERS_PENDING = 10;
export const MOD_TIMER_MIN_MS = 1000;
export const MOD_TIMER_MAX_MS = 3_600_000;

export const MOD_HOOKS_PER_MINUTE = 30;
export const MOD_HOOKS_PER_DAY = 1000;

/** Real history entries per mod, and for every mod together, in the window. */
export const MOD_HISTORY_PER_WINDOW = 10;
export const MOD_HISTORY_ALL_PER_WINDOW = 20;
export const MOD_HISTORY_WINDOW_MS = 600_000;

export const MOD_TOASTS_PER_HOOK = 1;
export const MOD_TOASTS_PER_MINUTE = 3;

export const MOD_STORE_FLUSH_MS = 5000;
export const MOD_STORE_VALUE_MAX_BYTES = 8192;

export const MOD_FAULTS_TO_OFF = 3;
export const MOD_FAULT_WINDOW_MS = 600_000;
export const MOD_FAULT_LOGS_PER_HOUR = 20;

export const MOD_QUERY_LIMIT = 100;
/**
 * Items one hook's queries may look at in all. The host answers on the main
 * thread while the mod's own clock is paused, so this is what bounds that
 * time on a large planner.
 */
export const MOD_SCAN_PER_HOOK = 10_000;
export const MOD_QUEUE_MAX = 50;
/** One `$` call's arguments, as JSON text. */
export const MOD_ARGS_MAX_BYTES = 16_384;
/** The manifest a mod's code declares, as JSON text. */
export const MOD_MANIFEST_MAX_BYTES = 8192;
/** 061's octet_length cap on user_mods.source (MOD_SOURCE_MAX_BYTES in ./schema.ts). */
export const MOD_SOURCE_MAX_BYTES = 65536;
/** A fault's message, and a reply's error, as the mod and Problems see them. */
export const MOD_FAULT_MESSAGE_MAX = 300;
export const MOD_REPLY_ERROR_MAX = 200;

export const MOD_HANDLERS_MAX = 20;
export const MOD_COMMANDS_MAX = 20;
export const MOD_LOADED_MAX = 8;
export const MOD_IDLE_UNLOAD_MS = 600_000;
