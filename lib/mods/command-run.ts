/**
 * The ⌘K door into the mod runtime, as a slot ModHost fills while mods run
 * (components/mods/mod-host.tsx). A slot for lib/recipes/command-run.ts's
 * reason: the command registry must not import the runtime. With the slot
 * empty (a lean route, safe mode, no mod on) a mod's command does nothing.
 */

let runner: ((modId: string, commandId: string) => void) | null = null;

export function setModCommandRunner(fn: (modId: string, commandId: string) => void): () => void {
  runner = fn;
  return () => {
    if (runner === fn) runner = null;
  };
}

export function runModCommand(modId: string, commandId: string): void {
  runner?.(modId, commandId);
}
