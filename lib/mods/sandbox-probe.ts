/**
 * Why a sandbox frame that loaded never answered its boot. Only the current
 * runtime version's page exists (`dynamicParams = false` in
 * app/mods/sandbox/[v]/route.ts), so a tab from an older deploy asks for a
 * path that is now a 404: that tab is `outdated` and wants a reload, not a
 * browser that cannot run mods.
 *
 * Its own module so the broker boundary (tests/unit/mods-runtime-boundary)
 * can keep network calls out of everything in a mod's reach: this asks only for
 * the HEAD of the app's own frame URL, and nothing a mod wrote reaches it.
 */
export async function silentFrameStatus(src: string): Promise<'outdated' | 'unavailable'> {
  try {
    const res = await fetch(src, { method: 'HEAD', cache: 'no-store' });
    return res.status === 404 ? 'outdated' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
