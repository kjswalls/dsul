'use client';

import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useModsStore } from '@/lib/mods-store';
import { modDisplayLabel } from '@/lib/mods/labels';
import { parseModManifest, parseModSettings, type ModSetting, type ModSettingValue, type UserMod } from '@/lib/mods/schema';

/**
 * Settings → Make's fields for a mod's own settings (memory/plans/mods.md,
 * build order 9). The fields and their labels are the mod's manifest; the
 * host frames them as "Set by your mod <name>", so a mod's field never reads
 * as one of the app's. Current values come from the mod's store
 * (loadModCode, since the list never selects it), held to the manifest by
 * parseModSettings. Save is explicit, through mods-store's setModSettings,
 * and a running mod takes the new values with no reload. Works in safe mode.
 *
 * The text and number fields take no autofill, as a panel's fields do.
 */

type Draft = Record<string, string | boolean | null>;

function draftOf(settings: readonly ModSetting[], values: Record<string, ModSettingValue>): Draft {
  const out: Draft = {};
  for (const s of settings) {
    const v = values[s.key];
    out[s.key] = s.kind === 'toggle' ? v === true : s.kind === 'select' ? (typeof v === 'string' ? v : null) : v === null ? '' : String(v);
  }
  return out;
}

const NO_AUTOFILL = {
  autoComplete: 'off',
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-form-type': 'other',
  spellCheck: false,
  autoCorrect: 'off',
} as const;

export function ModSettingsForm({ row }: { row: UserMod }) {
  const settings = parseModManifest(row)?.settings ?? [];
  const baseId = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [fieldName] = useState(() => `s${Math.random().toString(36).slice(2, 10)}`);
  const manifestKey = JSON.stringify(settings);

  useEffect(() => {
    let live = true;
    void useModsStore
      .getState()
      .loadModCode(row.id)
      .then((code) => {
        if (!live) return;
        if (!code) return setLoadFailed(true);
        const manifest = parseModManifest(row);
        setDraft(draftOf(manifest?.settings ?? [], parseModSettings(manifest, code.store['@settings'])));
      });
    return () => {
      live = false;
    };
    // The row object changes on every list refresh; its id and declarations are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, manifestKey]);

  if (settings.length === 0) return null;

  const save = async () => {
    if (!draft) return;
    const values: Record<string, ModSettingValue> = {};
    for (const s of settings) {
      const d = draft[s.key];
      if (s.kind === 'number') {
        const text = typeof d === 'string' ? d.trim() : '';
        if (text === '') {
          values[s.key] = null;
          continue;
        }
        const n = Number(text);
        if (!Number.isFinite(n)) return setMessage({ text: `${s.label} needs a number.`, error: true });
        if ((s.min !== undefined && n < s.min) || (s.max !== undefined && n > s.max)) {
          const range =
            s.min !== undefined && s.max !== undefined
              ? `between ${s.min} and ${s.max}`
              : s.min !== undefined
                ? `${s.min} or more`
                : `${s.max} or less`;
          return setMessage({ text: `${s.label} needs a number ${range}.`, error: true });
        }
        values[s.key] = n;
      } else if (s.kind === 'text') {
        values[s.key] = typeof d === 'string' && d !== '' ? d : null;
      } else {
        values[s.key] = d as ModSettingValue;
      }
    }
    setSaving(true);
    setMessage(null);
    try {
      const result = await useModsStore.getState().setModSettings(row.id, values);
      if (!result.ok) return setMessage({ text: result.reason, error: true });
      setDraft(draftOf(settings, result.values));
      setMessage({ text: 'Saved.', error: false });
    } finally {
      setSaving(false);
    }
  };

  const put = (key: string, v: string | boolean | null) => {
    setDraft((d) => (d ? { ...d, [key]: v } : d));
    setMessage(null);
  };

  return (
    <div data-testid="mod-settings-form" className="border-border mb-3 space-y-3 rounded-[6px] border px-3 py-3">
      <p className="text-muted-foreground text-xs">Set by your mod {modDisplayLabel(row)}</p>
      {loadFailed ? (
        <p className="text-muted-foreground text-xs">Could not load its settings. Try again later.</p>
      ) : !draft ? (
        <p className="text-muted-foreground text-xs">Loading its settings.</p>
      ) : (
        <>
          {settings.map((s) => {
            const id = `${baseId}-${s.key}`;
            const label = (
              <label htmlFor={id} className="text-foreground min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">
                {s.label}
              </label>
            );
            if (s.kind === 'toggle') {
              return (
                <div key={s.key} className="flex items-center gap-3">
                  {label}
                  <Switch id={id} checked={draft[s.key] === true} onCheckedChange={(on) => put(s.key, on)} />
                </div>
              );
            }
            if (s.kind === 'select') {
              const v = draft[s.key];
              return (
                <div key={s.key} className="flex items-center gap-3">
                  {label}
                  <Select value={typeof v === 'string' ? v : undefined} onValueChange={(next) => put(s.key, next)}>
                    <SelectTrigger id={id} size="sm" className="w-40">
                      <SelectValue placeholder="Pick one" />
                    </SelectTrigger>
                    <SelectContent>
                      {s.options.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              );
            }
            return (
              <div key={s.key} className="flex items-center gap-3">
                {label}
                <Input
                  id={id}
                  type={s.kind === 'number' ? 'number' : 'text'}
                  {...NO_AUTOFILL}
                  name={`${fieldName}-${s.key}`}
                  className="h-8 w-40"
                  value={typeof draft[s.key] === 'string' ? (draft[s.key] as string) : ''}
                  min={s.kind === 'number' ? s.min : undefined}
                  max={s.kind === 'number' ? s.max : undefined}
                  maxLength={s.kind === 'text' ? (s.maxLength ?? 200) : undefined}
                  onChange={(e) => put(s.key, e.target.value)}
                />
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" data-testid="mod-settings-save" disabled={saving} onClick={() => void save()}>
              Save
            </Button>
            {message && (
              <p
                role={message.error ? 'alert' : 'status'}
                className={message.error ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}
              >
                {message.text}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
