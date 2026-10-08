'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AskMark } from '@/components/ai/ask-mark';
import { useAICapabilities } from '@/lib/ai-connection-store';
import { MAKE_KINDS, MAX_MAKE_ASK_CHARS, type MakeKind } from '@/lib/ai-limits';
import { chatErrorCopy } from '@/lib/chat-errors';
import { writeWithAI } from '@/lib/make-ai';
import { finishModDraft, parseMakeDraft, type DraftResult, type MakeDraft } from '@/lib/make-draft';
import { useModsStore } from '@/lib/mods-store';
import { usePlannerStore } from '@/lib/planner-store';
import { fetchItemTypes } from '@/lib/db';
import { getItemTypeConfig } from '@/lib/item-registry';
import { currentRecipeEnv } from '@/lib/recipes/validate';
import { describeRecipe, LOOK_TOUCHES, recipeTouches, THEME_TOUCHES } from '@/lib/recipes/describe';
import { DARK_LOOKS, LIGHT_LOOKS, resolveDarkPick, resolveLightPick } from '@/lib/theme-looks';
import { LOOKS } from '@/lib/looks';
import { layoutDef } from '@/lib/layout-themes';
import { lookRefForId } from '@/lib/user-looks';
import { themeSlugForId } from '@/lib/user-themes/css';
import { modLabel, type ModManifest, type UserMod } from '@/lib/mods/schema';
import { modSandbox, type SandboxStatus } from '@/lib/mods/sandbox-host';
import { hooksInWords, panelsInWords, usesInWords } from '@/lib/mods/words';
import { usePaletteStore } from '@/lib/palette-store';
import { useViewStore } from '@/lib/view-store';
import { ThemeDraftPreview } from './theme-draft-preview';
import { LookMini } from './look-mini';

/**
 * "Write with AI" in Settings → Make (memory/plans/mods.md, "AI writes it"):
 * one box, a kind picker, and a Write press that asks the person's own model
 * for one recipe, theme, Look or mod. The reply is checked against the same
 * schemas as everything Make saves (lib/make-draft.ts) and shown as a draft
 * card: what it does in plain words, what it can touch, its source, and
 * Install, Edit or Discard. Install saves it switched off, like everything here.
 *
 * A mod's code is run once in the sandbox before its card shows (build order
 * 10): no `$`, no hook, only `register` and the manifest it declares, as the
 * mod editor's Save does. So Write needs a sandbox that can run here, and
 * asks for one before it calls the model.
 *
 * Shown only while the AI gate's `canMake` holds (a connected, working model
 * this device answers with; never OpenClaw alone), and hidden while that is
 * unknown. No AI call happens but the Write press (and Try again, which is
 * another press): not on mount, typing, a kind change, or a `?write=` link.
 * Nothing is stored or cached: a draft lives in this component's state.
 */

export type MakeEditRequest =
  | { kind: Exclude<MakeKind, 'mod'>; initial: { name: string; manifest: unknown } }
  /** `fromAI`: the editor holds the draft to draftChecks on every Save of its session. */
  | { kind: 'mod'; initial: { name: string; source: string; manifest: ModManifest | null; fromAI: true } };

const KIND_LABEL: Record<MakeKind, string> = { recipe: 'Recipe', theme: 'Theme', look: 'Look', mod: 'Mod' };
const KIND_NOUN: Record<MakeKind, string> = { recipe: 'a recipe', theme: 'a theme', look: 'a Look', mod: 'a mod' };
const PLACEHOLDER: Record<MakeKind, string> = {
  recipe: 'When I tick Run, add Stretch 10 min to this evening',
  theme: 'A calm green paper theme with warm ink',
  look: 'Notebook by day, Night after dark',
  mod: 'A card that counts the pages I read today, with a +10 button',
};

export const UNREADABLE_COPY = 'That did not come back as something Make can use.';
export const CUT_SHORT_COPY = 'The reply was cut short. Try a shorter ask.';

/** Why a mod cannot be written here: its code could not be checked. */
export const WRITE_SANDBOX_WORDS = {
  unavailable: 'Mods can’t run in this browser, so AI can’t check one here.',
  outdated: 'dsul was updated; reload to write mods.',
} as const;

const PRIVACY: Record<'mod' | 'rest', string> = {
  rest: 'Your model sees what you write here and the names of your projects, types, themes and Looks. Never your items, notes or conversations.',
  mod: 'Your model sees what you write here and the names of your types, themes and Looks, never your projects’ names, items, notes or conversations. A mod it writes cannot use AI.',
};

const sandboxDown = (s: SandboxStatus | null): s is 'unavailable' | 'outdated' =>
  s === 'unavailable' || s === 'outdated';

const selectClass =
  'field dark:bg-input/30 h-9 min-w-0 border bg-transparent px-2 py-1 text-sm outline-none';

type Phase =
  | { at: 'idle' }
  /** `checking`: a mod's code is being run once in the sandbox. */
  | { at: 'running'; checking?: boolean }
  /** `suggest`: the reply named another kind, offered as one press. `reload`: offer Reload. */
  | { at: 'failed'; message: string; suggest?: MakeKind; reload?: boolean }
  | { at: 'draft'; draft: MakeDraft; problems: string[] };

function failureCopy(r: Extract<DraftResult, { ok: false }>, kind: MakeKind): string {
  if (r.message) return r.message;
  if (r.reason === 'unreadable') return UNREADABLE_COPY;
  if (r.reason === 'cut_short') return CUT_SHORT_COPY;
  if (r.suggest) return `That sounds like ${KIND_NOUN[r.suggest]}, not ${KIND_NOUN[kind]}.`;
  return `That does not sound like ${KIND_NOUN[kind]}. Try saying it another way.`;
}

export function MakeWrite({
  userId,
  initialKind = 'recipe',
  focus = false,
  hidden = false,
  settled = 0,
  onEdit,
}: {
  userId: string;
  initialKind?: MakeKind;
  /** Put the caret in the box on mount (a `?write=` link). Sends nothing. */
  focus?: boolean;
  /**
   * Out of sight while the draft is open in a builder: kept mounted so Cancel
   * comes back to the same card and ask, with no second AI call. Its theme
   * miniature steps aside meanwhile, so the editor's preview is the only
   * writer of the draft slot.
   */
  hidden?: boolean;
  /** Bumped by the pane when a draft opened in Edit was saved there: the card goes. */
  settled?: number;
  onEdit: (request: MakeEditRequest) => void;
}) {
  const { canMake } = useAICapabilities();
  const [kind, setKind] = useState<MakeKind>(initialKind);
  const [ask, setAsk] = useState('');
  const [phase, setPhase] = useState<Phase>({ at: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  /** A failed Install, kept apart from the draft's problems so Install stays pressable. */
  const [installError, setInstallError] = useState<string | null>(null);
  /**
   * The sandbox as last answered, asked for when the kind becomes a mod: null
   * until it answers, and Write waits. A getter, not a subscription, so this
   * is a copy, and Write asks again before it calls the model.
   */
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null);
  const abort = useRef<AbortController | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const boxId = useId();

  const [seenSettled, setSeenSettled] = useState(settled);
  if (seenSettled !== settled) {
    setSeenSettled(settled);
    setPhase({ at: 'idle' });
    setAsk('');
    setInstallError(null);
  }

  // A new `?write=` kind while Make is open picks that kind (state adjusted
  // during render, not in an effect).
  const [seenKind, setSeenKind] = useState(initialKind);
  if (seenKind !== initialKind) {
    setSeenKind(initialKind);
    setKind(initialKind);
  }
  useEffect(() => {
    if (focus && canMake) box.current?.focus();
  }, [focus, canMake]);
  // Leaving Make stops a reply still streaming.
  useEffect(() => () => abort.current?.abort(), []);
  // So does the gate closing ("No AI, thanks", a key that starts failing): a
  // reply asked for while AI was on never lands after it went off.
  const [seenCanMake, setSeenCanMake] = useState(canMake);
  if (seenCanMake !== canMake) {
    setSeenCanMake(canMake);
    if (!canMake) {
      setPhase({ at: 'idle' });
      setInstallError(null);
    }
  }
  useEffect(() => {
    if (canMake) return;
    abort.current?.abort();
    abort.current = null;
  }, [canMake]);
  // A mod's Write needs the sandbox: boot it as soon as the kind is a mod, so
  // the frame is up (or known to be missing) before the press. No AI call.
  useEffect(() => {
    if (kind !== 'mod' || !canMake) return;
    let live = true;
    void modSandbox.ensure().then((s) => {
      if (live) setSandbox(s);
    });
    return () => {
      live = false;
    };
  }, [kind, canMake]);
  // A failure takes focus, so the person hears it and lands on Try again.
  useEffect(() => {
    if (phase.at === 'failed') errorRef.current?.focus();
  }, [phase]);

  if (!canMake) return null;

  const running = phase.at === 'running';
  const modDown = kind === 'mod' && sandboxDown(sandbox);
  const modWaiting = kind === 'mod' && sandbox === null;

  const write = async (as: MakeKind = kind) => {
    const text = ask.trim();
    if (!text || abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setNotice(null);
    setInstallError(null);
    setKind(as);
    setPhase({ at: 'running' });
    const asked = as;
    try {
      if (asked === 'mod') {
        // No sandbox, no way to check the code: no model call either.
        const s = await modSandbox.ensure();
        if (controller.signal.aborted) return;
        setSandbox(s);
        if (sandboxDown(s)) {
          setPhase({ at: 'failed', message: WRITE_SANDBOX_WORDS[s], reload: s === 'outdated' });
          return;
        }
      }
      const reply = await writeWithAI({ kind: asked, ask: text, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!reply.ok) {
        if (reply.code === 'stopped') setPhase({ at: 'idle' });
        else setPhase({ at: 'failed', message: reply.message ?? chatErrorCopy(reply.code, 'model') });
        return;
      }
      // The person's own type names, as the recipe form asks them: a database
      // read, never another AI call.
      const types = await fetchItemTypes(userId).catch(() => null);
      if (controller.signal.aborted) return;
      const names = [...currentRecipeEnv().customTypeNames, ...(types ?? []).map((t) => t.name)];
      const result = parseMakeDraft(reply.text, asked, {
        recipe: { customTypeNames: [...new Set(names)] },
        rows: useModsStore.getState().rows,
      });
      if (result.ok === 'scratch') {
        // Run once, with no `$` and no hook, for the manifest it declares.
        setPhase({ at: 'running', checking: true });
        const scratch = await modSandbox.scratch(result.source);
        if (controller.signal.aborted) return;
        if ('status' in scratch) {
          setSandbox(scratch.status);
          setPhase({ at: 'failed', message: WRITE_SANDBOX_WORDS[scratch.status], reload: scratch.status === 'outdated' });
          return;
        }
        const done = finishModDraft(result, scratch);
        if (done.ok === true) setPhase({ at: 'draft', draft: done.draft, problems: done.problems });
        return;
      }
      setPhase(
        result.ok
          ? { at: 'draft', draft: result.draft, problems: result.problems }
          : { at: 'failed', message: failureCopy(result, asked), ...(result.suggest && { suggest: result.suggest }) }
      );
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  };

  const stop = () => {
    abort.current?.abort();
    abort.current = null;
    setPhase({ at: 'idle' });
    box.current?.focus();
  };

  const install = async (draft: MakeDraft) => {
    const store = useModsStore.getState();
    // Through the same create every builder uses, which saves it switched off.
    let created: Awaited<ReturnType<typeof store.createMod>>;
    if (draft.kind === 'mod') {
      // Exactly the code that was run, and the manifest it declared then.
      if (!draft.manifest) return;
      created = await store.createMod(userId, { name: draft.name, source: draft.source, manifest: draft.manifest });
    } else {
      created =
        draft.kind === 'recipe'
          ? await store.createRecipe(userId, { name: draft.name, manifest: draft.manifest })
          : draft.kind === 'theme'
            ? await store.createTheme(userId, { name: draft.name, manifest: draft.manifest })
            : await store.createLook(userId, { name: draft.name, manifest: draft.manifest });
    }
    if (created.ok) {
      setPhase({ at: 'idle' });
      setAsk('');
      setInstallError(null);
      setNotice('Saved. It starts switched off.');
      box.current?.focus();
    } else {
      setInstallError(created.reason);
    }
  };

  return (
    <section data-testid="make-write" hidden={hidden} className="border-border mt-3 rounded-[8px] border p-3">
      <div className="mb-2 flex items-center gap-2">
        <AskMark className="size-4" />
        <label htmlFor={boxId} className="text-foreground text-sm font-medium">
          Write with AI
        </label>
        <select
          data-testid="make-write-kind"
          aria-label="What to write"
          className={`${selectClass} ml-auto`}
          value={kind}
          disabled={running}
          onChange={(e) => {
            setKind(e.target.value as MakeKind);
            if (phase.at === 'failed') setPhase({ at: 'idle' });
          }}
        >
          {MAKE_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      <Textarea
        id={boxId}
        ref={box}
        data-testid="make-write-ask"
        value={ask}
        maxLength={MAX_MAKE_ASK_CHARS}
        rows={2}
        placeholder={PLACEHOLDER[kind]}
        readOnly={running}
        aria-busy={running}
        onChange={(e) => setAsk(e.target.value)}
      />
      <p data-testid="make-write-privacy" className="text-muted-foreground mt-1 text-xs">
        {PRIVACY[kind === 'mod' ? 'mod' : 'rest']}
      </p>
      {modDown && phase.at !== 'failed' && (
        <div data-testid="make-write-sandbox" className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-muted-foreground flex-1 text-xs">{WRITE_SANDBOX_WORDS[sandbox]}</p>
          {sandbox === 'outdated' && <ReloadButton />}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        {running ? (
          <>
            <span role="status" data-testid="make-write-running" className="text-muted-foreground text-xs">
              {phase.checking ? 'Checking it…' : 'Writing…'}
            </span>
            <Button type="button" size="sm" variant="outline" data-testid="make-write-stop" onClick={stop}>
              Stop
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            data-testid="make-write-go"
            disabled={!ask.trim() || modDown || modWaiting}
            onClick={() => void write()}
          >
            <AskMark className="size-3.5" /> Write with AI
          </Button>
        )}
        {notice && (
          <p role="status" data-testid="make-write-notice" className="text-muted-foreground text-xs">
            {notice}
          </p>
        )}
      </div>

      {phase.at === 'failed' && (
        <div
          ref={errorRef}
          tabIndex={-1}
          data-testid="make-write-error"
          role="alert"
          className="mt-3 flex flex-wrap items-center gap-3 outline-none"
        >
          <p className="text-destructive flex-1 text-xs">{phase.message}</p>
          {phase.reload && <ReloadButton />}
          {phase.suggest && (
            <Button
              type="button"
              size="sm"
              data-testid="make-write-as"
              onClick={() => void write(phase.suggest)}
            >
              Write it as {KIND_NOUN[phase.suggest]}
            </Button>
          )}
          <Button type="button" size="sm" variant="outline" data-testid="make-write-retry" onClick={() => void write()}>
            Try again
          </Button>
        </div>
      )}

      {phase.at === 'draft' && (
        <MakeDraftCard
          draft={phase.draft}
          problems={phase.problems}
          installError={installError}
          preview={!hidden}
          onInstall={() => install(phase.draft)}
          onEdit={() => onEdit(editRequest(phase.draft))}
          onDiscard={() => {
            setPhase({ at: 'idle' });
            setInstallError(null);
            box.current?.focus();
          }}
        />
      )}
    </section>
  );
}

function editRequest(draft: MakeDraft): MakeEditRequest {
  if (draft.kind === 'mod') {
    const { name, source, manifest } = draft;
    return { kind: 'mod', initial: { name, source, manifest, fromAI: true } };
  }
  return { kind: draft.kind, initial: { name: draft.name, manifest: draft.manifest } };
}

function ReloadButton() {
  return (
    <Button type="button" size="sm" variant="outline" data-testid="make-write-reload" onClick={() => window.location.reload()}>
      Reload
    </Button>
  );
}

function themeLabel(ref: string, rows: readonly UserMod[]): string {
  const builtIn = [...LIGHT_LOOKS, ...DARK_LOOKS].find((l) => l.value === ref);
  if (builtIn) return builtIn.label;
  const row = rows.find((r) => r.kind === 'theme' && themeSlugForId(r.id) === ref);
  return row ? modLabel(row) : 'a theme you do not have';
}

function lookLabel(ref: string, rows: readonly UserMod[]): string {
  const builtIn = LOOKS.find((l) => l.id === ref);
  if (builtIn) return builtIn.label;
  const row = rows.find((r) => r.kind === 'look' && lookRefForId(r.id) === ref);
  return row ? modLabel(row) : 'a Look you do not have';
}

export function MakeDraftCard({
  draft,
  problems,
  installError = null,
  preview = true,
  onInstall,
  onEdit,
  onDiscard,
}: {
  draft: MakeDraft;
  problems: string[];
  /** Why the last Install failed. Install stays pressable, so it can be tried again. */
  installError?: string | null;
  /** False while the draft is open in the theme editor, whose preview owns the draft slot. */
  preview?: boolean;
  onInstall: () => void | Promise<void>;
  onEdit: () => void;
  onDiscard: () => void;
}) {
  const [source, setSource] = useState(false);
  const [installing, setInstalling] = useState(false);
  const rows = useModsStore((s) => s.rows);
  const timeFormat = usePlannerStore((s) => s.timeFormat);
  const sourceId = useId();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  // A new draft takes focus, so it is heard and the next Tab is its buttons.
  useEffect(() => {
    title.current?.focus();
  }, [draft]);

  const touches =
    draft.kind === 'recipe'
      ? recipeTouches(draft.manifest, timeFormat)
      : draft.kind === 'theme'
        ? THEME_TOUCHES
        : draft.kind === 'look'
          ? LOOK_TOUCHES
          : null;

  return (
    <div
      role="region"
      aria-labelledby={titleId}
      data-testid="make-draft"
      data-make-draft-kind={draft.kind}
      className="border-border mt-3 space-y-3 rounded-[8px] border p-3"
    >
      <div>
        <p className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
          Draft {KIND_LABEL[draft.kind].toLowerCase()}
        </p>
        <h3
          id={titleId}
          ref={title}
          tabIndex={-1}
          data-testid="make-draft-name"
          className="text-foreground text-sm font-medium outline-none"
        >
          {draft.name}
        </h3>
      </div>

      {draft.kind === 'recipe' && <RecipeSummary draft={draft} rows={rows} timeFormat={timeFormat} />}
      {draft.kind === 'theme' && (
        <div data-testid="make-draft-theme" className="space-y-2">
          {preview && <ThemeDraftPreview manifest={draft.manifest} />}
          <p className="text-muted-foreground text-xs">
            {draft.manifest.mode === 'light' ? 'A light theme' : 'A dark theme'}, starting from{' '}
            {themeLabel(draft.manifest.base, rows)}.
          </p>
        </div>
      )}
      {draft.kind === 'look' && <LookSummary draft={draft} rows={rows} />}
      {draft.kind === 'mod' && <ModSummary draft={draft} />}

      {touches && (
        <div>
          <p className="text-foreground text-xs font-medium">What it can touch</p>
          <ul data-testid="make-draft-touches" className="text-muted-foreground list-disc pl-4 text-xs">
            {touches.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}

      {problems.length > 0 && (
        <ul data-testid="make-draft-problems" role="alert" className="text-destructive space-y-1 text-xs">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="make-draft-source-toggle"
          aria-expanded={source}
          aria-controls={sourceId}
          onClick={() => setSource((v) => !v)}
        >
          {source ? 'Hide source' : 'Show source'}
        </Button>
        {source &&
          (draft.kind === 'mod' ? (
            // A plain capped box: <ScrollArea> drops max-h.
            <div id={sourceId} className="bg-secondary mt-1 max-h-80 overflow-y-auto rounded-[6px] p-2">
              <pre data-testid="make-draft-source" className="text-foreground text-[11px] whitespace-pre-wrap break-words">
                {draft.source}
              </pre>
            </div>
          ) : (
            <pre
              id={sourceId}
              data-testid="make-draft-source"
              className="bg-secondary text-foreground mt-1 max-h-64 overflow-auto rounded-[6px] p-2 text-[11px]"
            >
              {JSON.stringify(draft.manifest, null, 2)}
            </pre>
          ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          data-testid="make-draft-install"
          disabled={problems.length > 0 || installing}
          onClick={() => {
            setInstalling(true);
            Promise.resolve(onInstall()).finally(() => setInstalling(false));
          }}
        >
          Install
        </Button>
        <Button type="button" size="sm" variant="outline" data-testid="make-draft-edit" onClick={onEdit}>
          Edit
        </Button>
        <Button type="button" size="sm" variant="ghost" data-testid="make-draft-discard" onClick={onDiscard}>
          Discard
        </Button>
        <span className="text-muted-foreground text-xs">It starts switched off.</span>
      </div>
      {installError && (
        <p data-testid="make-draft-install-error" role="alert" className="text-destructive text-xs">
          {installError}
        </p>
      )}
    </div>
  );
}

function RecipeSummary({
  draft,
  rows,
  timeFormat,
}: {
  draft: Extract<MakeDraft, { kind: 'recipe' }>;
  rows: readonly UserMod[];
  timeFormat: '12h' | '24h';
}) {
  const d = describeRecipe(
    draft.manifest,
    {
      type: (n) => getItemTypeConfig(n).label,
      theme: (ref) => themeLabel(ref, rows),
      look: (ref) => lookLabel(ref, rows),
    },
    timeFormat
  );
  return (
    <div data-testid="make-draft-recipe" className="space-y-1 text-xs">
      <p className="text-foreground">{d.when}</p>
      {d.only.map((line) => (
        <p key={line} className="text-muted-foreground">
          {line}
        </p>
      ))}
      <ol className="text-foreground list-decimal pl-4">
        {d.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </div>
  );
}

function LookSummary({ draft, rows }: { draft: Extract<MakeDraft, { kind: 'look' }>; rows: readonly UserMod[] }) {
  const def = layoutDef(draft.manifest.layout);
  const tint = usePaletteStore((s) => s.palette);
  const bucketStyle = useViewStore((s) => s.bucketStyle);
  const typeMode = useViewStore((s) => s.typeMode);
  const showCompleted = usePlannerStore((s) => s.showCompletedTasks);
  const light = resolveLightPick(draft.manifest.light);
  const dark = resolveDarkPick(draft.manifest.dark);
  return (
    <div data-testid="make-draft-look" className="space-y-2 text-xs">
      <div className="grid grid-cols-2 gap-2">
        {(['light', 'dark'] as const).map((mode) => (
          <LookMini
            key={mode}
            def={def}
            mode={mode}
            light={light}
            dark={dark}
            tint={tint}
            bucketStyle={bucketStyle}
            typeMode={typeMode}
            showCompleted={showCompleted}
            className="border-border rounded-[8px] border"
          />
        ))}
      </div>
      <p className="text-foreground">
        {def.label}. <span className="text-muted-foreground">{def.description}</span>
      </p>
      <p className="text-muted-foreground">
        By day {themeLabel(draft.manifest.light, rows)}, at night {themeLabel(draft.manifest.dark, rows)}.
      </p>
    </div>
  );
}

/**
 * What a mod draft does, from the manifest its code declared when it was run
 * once. With no manifest (it would not load), nothing here: the problems say
 * why. The unattended line comes from the manifest alone, because the hooks
 * are only as written now; they add detail and never take the line away.
 */
function ModSummary({ draft }: { draft: Extract<MakeDraft, { kind: 'mod' }> }) {
  const m = draft.manifest;
  if (!m) return null;
  const runs = hooksInWords(draft.hooks);
  const draws = panelsInWords(m);
  const itemHook = draft.hooks.includes('item.completed');
  return (
    <div data-testid="make-draft-mod" className="space-y-2 text-xs">
      <div>
        <p className="text-foreground font-medium">What it can do</p>
        <p data-testid="make-draft-uses" className="text-muted-foreground">
          {usesInWords(m.uses)}
        </p>
        {m.uses.includes('items:write') && (
          <p data-testid="make-draft-unattended" className="text-foreground">
            It can change items when its code runs, including on its own
            {itemHook ? ', for example when you tick an item' : ''}.
          </p>
        )}
      </div>
      {runs && (
        <p data-testid="make-draft-hooks" className="text-muted-foreground">
          {runs}
        </p>
      )}
      {m.commands.length > 0 && (
        <div>
          <p className="text-foreground font-medium">Commands</p>
          <ul data-testid="make-draft-commands" className="text-muted-foreground list-disc pl-4">
            {m.commands.map((c) => (
              <li key={c.id}>
                In the command bar as Your mod · {draft.name}: {c.label}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(m.panels.length > 0 || m.settings.length > 0) && (
        <div data-testid="make-draft-panels">
          <p className="text-foreground font-medium">Panels and settings</p>
          {draws && <p className="text-muted-foreground">{draws}</p>}
          <ul className="text-muted-foreground list-disc pl-4">
            {m.panels.map((p) => (
              <li key={`panel-${p.id}`}>
                Panel: {p.label}
                {p.card ? ', under the braindump' : ''}
              </li>
            ))}
            {m.settings.map((x) => (
              <li key={`setting-${x.key}`}>Setting: {x.label}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
