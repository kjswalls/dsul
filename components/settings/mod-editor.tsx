'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { MOD_NAME_REFUSED, useModsStore } from '@/lib/mods-store';
import {
  MOD_SOURCE_MAX_BYTES,
  ModManifestSchema,
  isModLabel,
  isModName,
  parseModManifest,
  type ModManifest,
  type ModUse,
  type UserMod,
} from '@/lib/mods/schema';
import { faultCodeWords } from '@/lib/mods/faults';
import { modSandbox } from '@/lib/mods/sandbox-host';
import { activeModRuntime } from '@/lib/mods/runtime-manager';
import { MOD_TEMPLATE, MOD_TEMPLATE_NAME, MOD_TEMPLATE_USES } from '@/lib/mods/template';

/**
 * Settings → Make's mod editor (memory/plans/mods.md, build order 8): a name
 * and the code, plain text. No AI here (that is build order 10) and no
 * syntax colouring: a textarea the browser already makes accessible.
 *
 * Save runs the code once in a throwaway sandbox worker with no `$` and no
 * hook (modSandbox.scratch), reads the manifest the code declares, and saves
 * that with it. Anything that fails stops there and says why inline; the
 * row is untouched, so the version already saved keeps running. Saving works
 * in safe mode, which stops mods running, not being fixed.
 *
 * A switched-on mod stays on across a save and hot reloads in this tab
 * (activeModRuntime().saved). One whose code now asks for more than before is
 * saved switched off: switching it back on is the consent.
 */

/** What a mod may do, in the words the editor uses under the code. */
export const MOD_USE_WORDS: Record<ModUse, string> = {
  'items:read': 'see your items and container names',
  'items:write': 'add and change items',
  ui: 'show short messages, and open items and views from its commands',
  storage: 'keep its own saved data',
  look: 'change your theme or Look from its commands',
};

const encoder = new TextEncoder();
const bytesOf = (s: string) => encoder.encode(s).length;

/** "It may keep its own saved data and show short messages." */
export function usesInWords(uses: readonly ModUse[]): string {
  if (uses.length === 0) return 'It asks for nothing: it can read the date and time, and log.';
  const words = uses.map((u) => MOD_USE_WORDS[u]);
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `It may ${list}.`;
}

/**
 * What a mod draws and asks of the person, in plain words (build order 9):
 * its panels and where they show, its settings, and that a panel can show
 * the titles of items it links to when it may read items. Empty for a mod
 * with neither panels nor settings.
 */
export function panelsInWords(m: Pick<ModManifest, 'uses' | 'panels' | 'settings'>): string {
  const parts: string[] = [];
  const n = m.panels.length;
  if (n > 0) {
    const card = m.panels.some((p) => p.card);
    const what = `Draws ${n} panel${n === 1 ? '' : 's'}`;
    parts.push(card ? `${what}, ${n === 1 ? '' : 'one '}shown under the braindump.` : `${what}.`);
    if (m.uses.includes('items:read')) parts.push('Shows titles of items you link to.');
  }
  const k = m.settings.length;
  if (k > 0) parts.push(`Has ${k} setting${k === 1 ? '' : 's'} you set in Make.`);
  return parts.join(' ');
}

const SANDBOX_WORDS = {
  unavailable: 'Mods can’t run in this browser yet, so it was not saved.',
  outdated: 'dsul was updated; reload to save mods.',
} as const;

interface Problem {
  text: string;
  /** The code's own words (an error message), shown apart from the app's. */
  detail?: string;
  reload?: boolean;
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="text-muted-foreground mb-1 block text-xs">
        {label}
      </label>
      {children}
    </div>
  );
}

export function ModEditor({
  userId,
  editing,
  onDone,
  onCancel,
}: {
  userId: string;
  /** The mod being edited, or null for a new one. */
  editing: UserMod | null;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(editing ? editing.name : MOD_TEMPLATE_NAME);
  /** null while an existing mod's code loads; the list never selects it. */
  const [source, setSource] = useState<string | null>(editing ? null : MOD_TEMPLATE);
  const [loadFailed, setLoadFailed] = useState(false);
  const [uses, setUses] = useState<ModUse[]>(() =>
    editing ? (parseModManifest(editing)?.uses ?? []) : MOD_TEMPLATE_USES
  );
  /** The panels and settings line, from the stored manifest until a save reads the code's own. */
  const [drawsWords, setDrawsWords] = useState(() => {
    const m = editing ? parseModManifest(editing) : null;
    return m ? panelsInWords(m) : '';
  });
  const [problem, setProblem] = useState<Problem | null>(() => {
    const s = modSandbox.status();
    return s === 'unavailable' || s === 'outdated' ? { text: SANDBOX_WORDS[s], reload: s === 'outdated' } : null;
  });
  const [saving, setSaving] = useState(false);
  const editingId = editing?.id ?? null;

  useEffect(() => {
    if (!editingId) return;
    let live = true;
    void useModsStore
      .getState()
      .loadModCode(editingId)
      .then((code) => {
        if (!live) return;
        if (code) setSource(code.source);
        else setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, [editingId]);

  const bytes = source === null ? 0 : bytesOf(source);
  const tooBig = bytes > MOD_SOURCE_MAX_BYTES;

  const save = async () => {
    if (source === null) return;
    const trimmed = name.trim();
    if (!isModName(trimmed) || !isModLabel(trimmed)) return setProblem({ text: MOD_NAME_REFUSED });
    if (tooBig) return setProblem({ text: `The code is over ${MOD_SOURCE_MAX_BYTES / 1024}KB.` });
    setProblem(null);
    setSaving(true);
    try {
      const result = await modSandbox.scratch(source);
      if (!result.ok) {
        if ('status' in result) {
          return setProblem({ text: SANDBOX_WORDS[result.status], reload: result.status === 'outdated' });
        }
        return setProblem({ text: `${faultCodeWords(result.fault.code)}.`, detail: result.fault.message });
      }
      let manifest: ModManifest;
      try {
        const parsed = ModManifestSchema.safeParse(JSON.parse(result.manifestJson));
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return setProblem({
            text: 'Its manifest is not valid.',
            detail: issue ? `${issue.path.join('.') || 'manifest'}: ${issue.message}` : undefined,
          });
        }
        manifest = parsed.data;
      } catch {
        return setProblem({ text: 'Its manifest is not valid.' });
      }
      setUses(manifest.uses);
      setDrawsWords(panelsInWords(manifest));

      const store = useModsStore.getState();
      if (editing) {
        const saved = await store.saveMod(editing.id, { name: trimmed, source, manifest });
        if (!saved.ok) return setProblem({ text: saved.reason });
        activeModRuntime()?.saved(editing.id);
        onDone(
          saved.switchedOff
            ? 'Saved. It now asks for more than before, so it is switched off until you switch it on.'
            : 'Saved.'
        );
      } else {
        const created = await store.createMod(userId, { name: trimmed, source, manifest });
        if (!created.ok) return setProblem({ text: created.reason });
        onDone('Saved. It starts switched off.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="mod-editor" className="space-y-4 py-3">
      <h2 className="text-foreground text-sm font-medium">{editing ? 'Edit mod' : 'New mod'}</h2>

      <Field label="Name" htmlFor="mod-editor-name">
        <Input
          id="mod-editor-name"
          data-testid="mod-name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      <div>
        <Field label="Code" htmlFor="mod-editor-source">
          {loadFailed ? (
            <p data-testid="mod-editor-load-failed" className="text-muted-foreground text-xs">
              Could not load its code. Close this and try again.
            </p>
          ) : source === null ? (
            <p className="text-muted-foreground text-xs">Loading its code.</p>
          ) : (
            <Textarea
              id="mod-editor-source"
              data-testid="mod-source"
              value={source}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              rows={18}
              className="font-mono text-xs leading-relaxed"
              onChange={(e) => setSource(e.target.value)}
            />
          )}
        </Field>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2 text-xs">
          <p data-testid="mod-uses" className="text-muted-foreground">
            {usesInWords(uses)}
            {drawsWords && <span data-testid="mod-draws"> {drawsWords}</span>}
          </p>
          <p
            data-testid="mod-bytes"
            className={tooBig ? 'text-destructive' : 'text-muted-foreground'}
          >
            {bytes.toLocaleString('en-US')} of {MOD_SOURCE_MAX_BYTES.toLocaleString('en-US')} bytes
          </p>
        </div>
      </div>

      {problem && (
        <div data-testid="mod-editor-error" role="alert" className="space-y-1 text-xs">
          <p className="text-destructive">{problem.text}</p>
          {problem.detail && (
            <p className="text-muted-foreground">
              The code said: <span className="font-mono break-words">{problem.detail}</span>
            </p>
          )}
          {problem.reload && (
            <Button type="button" size="sm" variant="outline" onClick={() => window.location.reload()}>
              Reload
            </Button>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          data-testid="mod-save"
          disabled={saving || source === null}
          onClick={() => void save()}
        >
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-muted-foreground text-xs">
          {editing ? 'Saving keeps it on, unless it now asks for more.' : 'It starts switched off.'}
        </span>
      </div>
    </div>
  );
}
