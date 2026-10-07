/**
 * The ⌘K door into the recipe engine, as a slot the engine fills when it
 * starts.
 *
 * A slot rather than an import because the engine's UI steps reach the
 * settings manifest, which imports the keyboard-shortcuts store, which imports
 * lib/commands/registry.ts at module scope: the registry importing the engine
 * would close that loop and read STATIC_COMMANDS before it exists. With the
 * engine not mounted (a route that never loads the planner) the command does
 * nothing, which is also what the engine's own guard would answer there.
 */

let runner: ((modId: string) => void) | null = null;

export function setRecipeCommandRunner(fn: (modId: string) => void): () => void {
  runner = fn;
  return () => {
    if (runner === fn) runner = null;
  };
}

export function runRecipeCommand(modId: string): void {
  runner?.(modId);
}
