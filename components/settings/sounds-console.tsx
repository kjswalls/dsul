'use client';

import { useRef } from 'react';
import { Play, Volume2, VolumeX } from 'lucide-react';

import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { EXT_SOUNDS, resolveEnabled } from '@/lib/extension-registry';
import { useExtensionsStore } from '@/lib/extensions-store';
import type { SettingCtx } from '@/lib/settings/manifest';
import { auditionSound } from '@/lib/sounds/cue';
import {
  SOUND_COPY,
  SOUND_GROUPS,
  SOUND_PACKS,
  SOUNDS_CONFIG_GROUPS,
  SOUNDS_CONFIG_PACK,
  readSoundsConfig,
  type SoundEvent,
  type SoundPackId,
} from '@/lib/sounds/registry';
import { DEFAULT_SOUND_VOLUME, setSoundVolume, useSoundVolume } from '@/lib/sounds/volume';
import { cn } from '@/lib/utils';

/**
 * The Sounds pane's console, under its one switch: pick a pack, set this
 * device's volume, and choose which moments make a sound, hearing each as you
 * go. Every pack and every sound can be tried here, on or off, because a sound
 * is something you have to hear before you can choose it.
 *
 * Pack and switches are the account's (user_extensions.config, written whole
 * by setConfigValue, so they wait for the config to load like every other
 * extension field). Volume is this device's (lib/sounds/volume.ts).
 */

/** What a pack plays when you pick it or press its play button. */
const SAMPLE: readonly SoundEvent[] = ['complete', 'add', 'drop'];
const SAMPLE_GAP_MS = 300;

export function SoundsConsole({ ctx }: { ctx: SettingCtx }) {
  const on = useExtensionsStore((s) => resolveEnabled(s.enabled, EXT_SOUNDS));
  const ready = useExtensionsStore((s) => s.available && s.configsLoaded);
  const stored = useExtensionsStore((s) => s.configs[EXT_SOUNDS]);
  const setConfigValue = useExtensionsStore((s) => s.setConfigValue);
  const config = readSoundsConfig(stored);
  const volume = useSoundVolume();
  const canWrite = ready && ctx.userId !== null;

  // One sample at a time: a second press cuts the first one's tail short.
  const sampleTimers = useRef<number[]>([]);
  const playSample = (pack: SoundPackId) => {
    for (const t of sampleTimers.current) window.clearTimeout(t);
    sampleTimers.current = SAMPLE.map((event, i) =>
      window.setTimeout(() => auditionSound(pack, event), i * SAMPLE_GAP_MS)
    );
  };

  const pickPack = (pack: SoundPackId) => {
    playSample(pack);
    if (canWrite && pack !== config.pack) setConfigValue(ctx.userId!, EXT_SOUNDS, SOUNDS_CONFIG_PACK, pack);
  };

  const setGroup = (id: string, value: boolean) => {
    if (!canWrite) return;
    setConfigValue(ctx.userId!, EXT_SOUNDS, SOUNDS_CONFIG_GROUPS, { ...config.groups, [id]: value });
    const first = SOUND_GROUPS.find((g) => g.id === id)?.events[0];
    if (value && first) auditionSound(config.pack, first);
  };

  return (
    <section className="mt-6 flex flex-col gap-7" data-sounds-console aria-label="Sound packs">
      {!on && (
        <p className="text-muted-foreground text-xs" data-testid="sounds-off-note">
          Sounds are off, so nothing plays while you use dsul. You can still try every pack here.
        </p>
      )}

      <div className="flex flex-col gap-2.5">
        <h3 className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">Pack</h3>
        <div role="radiogroup" aria-label="Sound pack" className="grid gap-2 sm:grid-cols-2">
          {SOUND_PACKS.map((p) => {
            const picked = config.pack === p.id;
            return (
              <div
                key={p.id}
                className={cn(
                  'relative flex min-w-0 items-start gap-2 rounded-[10px] border transition-colors',
                  picked
                    ? 'border-foreground shadow-[inset_0_0_0_1px_var(--foreground)]'
                    : 'border-border hover:bg-accent'
                )}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={picked}
                  data-testid={`sounds-pack-${p.id}`}
                  disabled={!canWrite}
                  onClick={() => pickPack(p.id)}
                  className={cn(
                    'flex min-w-0 flex-1 flex-col gap-0.5 rounded-[10px] py-2.5 pr-1 pl-3 text-left',
                    'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                    'disabled:cursor-default'
                  )}
                >
                  <span className="text-foreground text-sm font-medium">{p.name}</span>
                  <span className="text-muted-foreground text-xs leading-snug">{p.blurb}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Play ${p.name}`}
                  data-testid={`sounds-pack-play-${p.id}`}
                  onClick={() => playSample(p.id)}
                  className={cn(
                    'text-muted-foreground hover:text-foreground hover:bg-muted mt-2 mr-2 grid size-7 shrink-0 place-items-center rounded-full transition-colors',
                    'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
                  )}
                >
                  <Play className="size-3.5 translate-x-px" aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <h3 className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">Volume on this device</h3>
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={volume === 0 ? 'Unmute' : 'Mute'}
            data-testid="sounds-mute"
            onClick={() => setSoundVolume(volume === 0 ? DEFAULT_SOUND_VOLUME : 0)}
            className={cn(
              'text-muted-foreground hover:text-foreground grid size-7 shrink-0 place-items-center rounded-full transition-colors',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
            )}
          >
            {volume === 0 ? <VolumeX className="size-4" aria-hidden /> : <Volume2 className="size-4" aria-hidden />}
          </button>
          <Slider
            value={[volume]}
            min={0}
            max={100}
            step={1}
            aria-label="Sound volume"
            onValueChange={([v]) => setSoundVolume(v)}
            // A tick at the new level once the thumb is let go, so you hear where you put it.
            onValueCommit={([v]) => v > 0 && auditionSound(config.pack, 'complete')}
            className="max-w-[320px]"
          />
          <span className="text-muted-foreground w-[3ch] text-right font-mono text-xs tabular-nums">{volume}</span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="text-muted-foreground font-mono text-[11px] tracking-wide uppercase">Plays a sound when</h3>
        <div className="divide-border divide-y">
          {SOUND_GROUPS.map((g) => {
            const value = config.groups[g.id];
            const id = `sounds-group-${g.id}`;
            return (
              <div key={g.id} className="flex items-start justify-between gap-6 py-3" data-testid={id}>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <label htmlFor={id} className="text-foreground text-sm">
                    {g.label}
                    <span className="text-muted-foreground block text-xs">{g.note}</span>
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {g.events.map((event) => (
                      <button
                        key={event}
                        type="button"
                        title={SOUND_COPY[event].when}
                        data-testid={`sounds-try-${event}`}
                        onClick={() => auditionSound(config.pack, event)}
                        className={cn(
                          'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-2 text-xs transition-colors',
                          'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none'
                        )}
                      >
                        <Play className="size-2.5" aria-hidden />
                        {SOUND_COPY[event].label}
                      </button>
                    ))}
                  </div>
                </div>
                <Switch
                  id={id}
                  checked={value}
                  disabled={!canWrite}
                  onCheckedChange={(v) => setGroup(g.id, v)}
                  className="mt-0.5 shrink-0"
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
