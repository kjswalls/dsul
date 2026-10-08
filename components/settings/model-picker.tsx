'use client';

import { useEffect, useMemo, useState } from 'react';
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PropertyChip } from '@/components/primitives/property-chip';
import { useAIConnectionStore, type ApiResult } from '@/lib/ai-connection-store';
import { modelName } from '@/lib/ai-model-names';
import { isModelId, type ApiErrorCode, type ModelOption } from '@/lib/ai-types';
import { cn } from '@/lib/utils';

/**
 * The model chip on Settings → AI's Connection card: which of the provider's
 * models answers.
 *
 * The list is the provider's own, fetched live through the server (the key
 * never leaves it), so it is as long as the provider makes it: OpenRouter lists
 * hundreds. Hence a search box, our own substring filter (cmdk's fuzzy scorer
 * reorders ids in ways that read as random), and a render cap.
 *
 * A typed id is always a way out: a provider that hides a model from its list,
 * or one released this morning, is still one "Use …" away. It must pass the
 * one model-id rule (`isModelId`), which is also what the server checks.
 */

/** Rows drawn at once. The rest are one more keystroke away. */
const RENDER_CAP = 300;

export function ModelPicker({
  disabled,
  defaultOpen,
  errorCopy,
}: {
  disabled?: boolean;
  defaultOpen?: boolean;
  /**
   * A refused pick in the panel's words (connectErrorCopy), from the route's
   * code and the field it named (`model` when the key can't use the pick).
   * One "try again" for every code was wrong whenever trying again cannot
   * help: a model the key can't use, or a rate limit.
   */
  errorCopy: (code: ApiErrorCode, field: string | null) => string;
}) {
  const model = useAIConnectionStore((s) => s.model);
  const busy = useAIConnectionStore((s) => s.busy);
  // Shown on the chip while the PATCH is out, and dropped on failure: the
  // store only moves once the server agrees.
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const current = optimistic ?? model?.model ?? '';
  // A model's name as a person reads it ("Gemini Flash", "GPT-4o mini"), even
  // before the list loads: the catalog and the id's shape name most, then the
  // label the provider listed it under (the loaded list's, or the one saved
  // with the connection, which is only the saved model's), then the raw id.
  const listedLabel = useAIConnectionStore((s) => s.models?.find((m) => m.id === current)?.label);
  const savedLabel = model && current === model.model ? model.modelLabel : null;
  const shown = model && current ? modelName(model.provider, current, listedLabel ?? savedLabel).name : current;

  const choose = async (id: string) => {
    if (!model || id === model.model) return;
    setError(null);
    setOptimistic(id);
    let result: ApiResult;
    try {
      result = await useAIConnectionStore.getState().setModel(id);
    } catch {
      result = { ok: false, code: 'server' };
    }
    setOptimistic(null);
    if (!result.ok) setError(errorCopy(result.code, result.field ?? null));
  };

  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <PropertyChip
        label="Model"
        ariaLabel={current ? `Model: ${shown}` : 'Choose a model'}
        value={shown}
        alwaysChevron
        align="end"
        disabled={disabled || busy === 'model' || !model}
        defaultOpen={defaultOpen}
        testId="model-picker"
        className="max-w-full"
        contentClassName="w-[min(22rem,var(--radix-popover-content-available-width))] p-0"
      >
        {(close) => (
          <ModelPickerContent
            current={model?.model ?? null}
            provider={model?.provider ?? null}
            onPick={(id) => {
              close();
              void choose(id);
            }}
          />
        )}
      </PropertyChip>
      {error && (
        <p role="alert" className="text-destructive text-[11px]" data-testid="model-picker-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** What the popover holds. Mounted only while it is open, so its mount IS "first open". */
function ModelPickerContent({
  current,
  provider,
  onPick,
}: {
  current: string | null;
  provider: string | null;
  onPick: (id: string) => void;
}) {
  const models = useAIConnectionStore((s) => s.models);
  const listed = useAIConnectionStore((s) => s.modelsListed);
  const status = useAIConnectionStore((s) => s.modelsStatus);
  const [query, setQuery] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);

  useEffect(() => {
    void useAIConnectionStore.getState().loadModels();
  }, []);

  const filtered = useMemo(() => {
    const all = models ?? [];
    const q = query.trim().toLowerCase();
    return all.filter(
      (m) =>
        (!freeOnly || m.free) && (q === '' || `${m.label} ${m.id}`.toLowerCase().includes(q))
    );
  }, [models, query, freeOnly]);

  // A host that does not list its models (an OpenAI-compatible server with no
  // /models) gets a plain field: there is nothing to search.
  if (provider === 'custom' && status === 'ready' && !listed) {
    return <TypedModelForm current={current} onPick={onPick} />;
  }

  const loading = status === 'idle' || status === 'loading';
  if (status === 'error') {
    return (
      <div className="flex flex-col items-start gap-2 p-3" data-testid="model-picker-failed">
        <p className="text-muted-foreground text-xs">Couldn’t load the model list.</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void useAIConnectionStore.getState().loadModels({ force: true })}
        >
          Try again
        </Button>
      </div>
    );
  }

  const typed = query.trim();
  const shown = filtered.slice(0, RENDER_CAP);
  const more = filtered.length - shown.length;
  const total = models?.length ?? 0;

  return (
    <Command shouldFilter={false} loop className="bg-popover">
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={loading ? 'Search models…' : `Search ${total} models…`}
        aria-label="Search models"
      />
      {provider === 'openrouter' && !loading && (
        <div className="border-border flex items-center gap-2 border-b px-2 py-1.5">
          <button
            type="button"
            aria-pressed={freeOnly}
            onClick={() => setFreeOnly((v) => !v)}
            data-testid="model-picker-free-only"
            className={cn(
              'rounded-[5px] px-2 py-0.5 text-[11px] font-medium transition-colors',
              'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
              freeOnly
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Free only
          </button>
        </div>
      )}
      <CommandList className="max-h-64 p-1" data-testid="model-picker-list">
        {loading ? (
          <p className="text-muted-foreground px-2 py-3 text-xs" role="status">
            Loading models…
          </p>
        ) : (
          <>
            {shown.map((m) => (
              <ModelRow key={m.id} option={m} selected={m.id === current} onPick={onPick} />
            ))}
            {more > 0 && (
              <p className="text-muted-foreground px-2 py-2 text-[11px]">
                Keep typing to narrow {more} more
              </p>
            )}
            {shown.length === 0 &&
              (typed === '' ? (
                <p className="text-muted-foreground px-2 py-3 text-xs">
                  {freeOnly ? 'No free models listed.' : 'No models listed.'}
                </p>
              ) : isModelId(typed) ? (
                <CommandItem
                  value={`use:${typed}`}
                  onSelect={() => onPick(typed)}
                  data-testid="model-picker-use-typed"
                  className="text-xs"
                >
                  Use “{typed}”
                </CommandItem>
              ) : (
                <p className="text-muted-foreground px-2 py-3 text-xs" data-testid="model-picker-bad-id">
                  Model names can’t contain spaces.
                </p>
              ))}
          </>
        )}
      </CommandList>
    </Command>
  );
}

function ModelRow({
  option,
  selected,
  onPick,
}: {
  option: ModelOption;
  selected: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <CommandItem
      value={option.id}
      onSelect={() => onPick(option.id)}
      data-model-id={option.id}
      data-selected-model={selected || undefined}
      className={cn('flex min-w-0 items-center gap-2 text-xs', selected && 'font-medium')}
    >
      <span className="text-foreground min-w-0 truncate">{option.label}</span>
      {option.label !== option.id && (
        <span className="text-muted-foreground font-num min-w-0 truncate text-[10px]">
          {option.id}
        </span>
      )}
      {option.free && (
        <span className="bg-secondary text-secondary-foreground ml-auto shrink-0 rounded-[4px] px-1 text-[10px] font-medium">
          Free
        </span>
      )}
    </CommandItem>
  );
}

/** For a host with no model list: the id, typed. */
function TypedModelForm({
  current,
  onPick,
}: {
  current: string | null;
  onPick: (id: string) => void;
}) {
  const [draft, setDraft] = useState(current ?? '');
  const id = draft.trim();
  const valid = isModelId(id);
  return (
    <form
      className="flex flex-col gap-2 p-3"
      data-testid="model-picker-typed"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onPick(id);
      }}
    >
      <label htmlFor="model-picker-typed-id" className="text-foreground text-xs font-medium">
        Model
      </label>
      <p className="text-muted-foreground text-[11px]">
        This service doesn’t list its models. Type the name it expects.
      </p>
      <div className="flex items-center gap-2">
        <Input
          id="model-picker-typed-id"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="h-8 text-xs"
        />
        <Button type="submit" size="sm" disabled={!valid || id === current} className="h-8">
          Save
        </Button>
      </div>
      {id !== '' && !valid && (
        <p className="text-muted-foreground text-[11px]">Model names can’t contain spaces.</p>
      )}
    </form>
  );
}
