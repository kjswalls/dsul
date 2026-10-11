/** Plugin config (from openclaw.json) */
export interface PluginConfig {
  dsulUrl: string
  apiKey: string
  publicUrl?: string   // Gateway's public URL (e.g. https://midgar-1b4eaa3.turkey-rockhopper.ts.net)
  /**
   * HMAC secret dsul signs change events with. Required for the hand-off wake,
   * which refuses an unsigned request; optional in the type so a config from
   * before the wake still loads.
   */
  webhookSecret?: string
  /** OpenClaw agent that answers in dsul's Ask (default: main). */
  agentId?: string
  /** Fallback agent id if agentId unset (legacy / alternate key in openclaw.json). */
  id?: string
}
