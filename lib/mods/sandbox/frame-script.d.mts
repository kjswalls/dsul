/** The frame's inline script, less the `const SANDBOX_VERSION='…';` the build puts in front. Holds no `<`. */
export const FRAME_SCRIPT_BODY: string;
/** Runs first in every mod worker, before the QuickJS glue. */
export const LOCKDOWN_JS: string;
/** The globals LOCKDOWN_JS takes away (navigator.serviceWorker is handled on its own). */
export const LOCKDOWN_GLOBALS: readonly string[];
