// The desktop shell's bridge, set only by electron/preload.cjs. A global script
// file (no top-level import) so this augments the DOM's Window rather than
// declaring a new one; tsconfig picks it up through its `**/*.ts` include.
interface Window {
  dsulDesktop?: import('@/lib/desktop').DsulDesktop;
}
