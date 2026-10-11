import { COMMAND_GROUPS, isAvailable, isHidden, resolveLabel } from './types';
import type {
  Command,
  CommandArgOption,
  CommandContext,
  CommandEntityOption,
  CommandGroupId,
} from './types';
import { resolveCommands } from './registry';
import { NO_MATCH, scoreAliases, scoreKeywords, scoreText } from './score';
import {
  frequencyBoost,
  recentCommandIds,
  type CommandUsageEntry,
} from '../command-usage-store';

/**
 * Ranking for the palette.
 *
 * The omnibar runs cmdk with shouldFilter={false} and does all its own
 * filtering, which was a pair of `includes()` calls back when there were six
 * commands. At this size that ranks badly — "task" would surface "Toggle
 * end-of-day review" above "Add task" — so scoring is explicit: exact label,
 * then label prefix, then word prefix, then substring, then keywords, with
 * measured usage and declaration order breaking ties.
 */

export interface CommandRow {
  /**
   * Unique within a rendered list, and the cmdk item `value`.
   *
   * It must encode the bound argument, not just the command id: a flattened
   * enum emits several rows for ONE command, and cmdk keys selection off
   * `value`, so identical values collapse into a single selectable item and
   * arrow-key navigation desyncs from what is painted.
   */
  value: string;
  command: Command;
  /** Set when the row is a flattened enum option that runs in one step. */
  arg?: CommandArgOption;
  /**
   * Set when the query was a text command's alias and its value on one line
   * ("vacation until tue"): the value as typed, for the row to preview and
   * Enter to run in one step.
   */
  inlineArg?: string;
  label: string;
  group: CommandGroupId;
  disabled: boolean;
  score: number;
}

/**
 * Flattened option rows sit one notch below a plain command at the same
 * textual score, so a built-in always wins a tie against a value nested
 * under another command.
 */
const FLATTENED_PENALTY = 30;

export interface MatchOptions {
  usage?: Record<string, CommandUsageEntry>;
  /** Cap the result set — the mobile panel has room for far fewer rows. */
  limit?: number;
}

export function matchCommands(
  query: string,
  ctx: CommandContext,
  options: MatchOptions = {}
): CommandRow[] {
  const q = query.trim().toLowerCase();
  const usage = options.usage ?? {};
  const rows: CommandRow[] = [];

  // Resolved, not static: dynamic commands (one per custom item type) are
  // ordinary rows, and their index here is their tie-break rank.
  const commands = resolveCommands(ctx);
  const order = new Map(commands.map((command, i) => [command.id, i]));

  for (const command of commands) {
    if (isHidden(command, ctx)) continue;

    const label = resolveLabel(command, ctx);
    const disabled = !isAvailable(command, ctx);
    const boost = frequencyBoost(usage, command.id);

    // A text command's alias followed by its value, on one line: "vacation
    // until tue". Ranked above everything, since the alias was typed whole.
    if (command.argument?.kind === 'text' && command.aliases?.length) {
      const alias = command.aliases.find((a) => q.startsWith(`${a} `));
      const rest = alias ? query.trim().slice(alias.length).trim() : '';
      if (rest) {
        rows.push({
          value: `cmd:${command.id}:inline`,
          command,
          label,
          group: command.group,
          disabled,
          inlineArg: rest,
          score: 1300 + boost,
        });
        continue;
      }
    }

    // The command itself. Score against both the canonical label (what the
    // matcher is specced on) and the displayed one, which may differ —
    // "Toggle completed tasks" vs the rendered "Hide completed tasks".
    const own = Math.max(
      scoreAliases(q, command.aliases),
      scoreText(q, command.label),
      scoreText(q, label),
      scoreKeywords(q, command.keywords)
    );
    if (own !== NO_MATCH) {
      rows.push({
        value: `cmd:${command.id}`,
        command,
        label,
        group: command.group,
        disabled,
        score: own + boost,
      });
    }

    // Flattened enum options become their own rows, but only once the user has
    // typed. Showing every option at rest would triple the resting list on a
    // surface with ~320px of vertical room.
    const arg = command.argument;
    if (!q || !arg || arg.kind !== 'enum' || !arg.flatten) continue;

    for (const option of arg.options(ctx)) {
      const optionScore = Math.max(
        scoreAliases(q, option.aliases),
        scoreText(q, option.label),
        scoreText(q, `${command.label} ${option.label}`),
        scoreKeywords(q, option.keywords)
      );
      if (optionScore === NO_MATCH) continue;
      rows.push({
        value: `cmd:${command.id}::${option.value}`,
        command,
        arg: option,
        label: `${label} → ${option.label}`,
        group: command.group,
        disabled,
        score: optionScore + boost - FLATTENED_PENALTY,
      });
    }
  }

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ai = order.get(a.command.id) ?? 0;
    const bi = order.get(b.command.id) ?? 0;
    if (ai !== bi) return ai - bi;
    // Same command: the plain row before its flattened options.
    return (a.arg ? 1 : 0) - (b.arg ? 1 : 0);
  });

  return options.limit ? rows.slice(0, options.limit) : rows;
}

/**
 * The "Recent" group — a custom-commands section that needs no authoring UI
 * and is non-empty after your very first command.
 */
export function recentRows(
  ctx: CommandContext,
  usage: Record<string, CommandUsageEntry>,
  limit = 4
): CommandRow[] {
  const rows: CommandRow[] = [];
  const commands = resolveCommands(ctx);
  for (const id of recentCommandIds(usage, limit * 2)) {
    // Misses when a recently used command no longer exists — you deleted the
    // custom type it created items for. Skipping is the whole handling needed.
    const command = commands.find((c) => c.id === id);
    if (!command || isHidden(command, ctx)) continue;
    rows.push({
      // Prefixed so it never collides with the same command's row in its own
      // group further down the list.
      value: `recent:${command.id}`,
      command,
      label: resolveLabel(command, ctx),
      group: 'recent',
      disabled: !isAvailable(command, ctx),
      score: 0,
    });
    if (rows.length === limit) break;
  }
  return rows;
}

/** Rows bucketed into palette render order; empty groups are dropped. */
export function groupRows(rows: CommandRow[]): { id: CommandGroupId; heading: string; rows: CommandRow[] }[] {
  return COMMAND_GROUPS.map((group) => ({
    ...group,
    rows: rows.filter((row) => row.group === group.id),
  })).filter((group) => group.rows.length > 0);
}

/**
 * Rows for a command waiting on an ENTITY argument.
 *
 * Unlike the enum path, the filtering happens inside the argument itself: the
 * candidate set is the planner store, not a fixed option list, so ranking it
 * here would mean teaching the matcher about items. An empty query is a real
 * state with real rows (the items nearest the day you are looking at), not a
 * "show everything" fallback.
 */
export function matchEntityOptions(
  command: Command,
  query: string,
  ctx: CommandContext
): CommandEntityOption[] {
  const arg = command.argument;
  return arg?.kind === 'entity' ? arg.search(query, ctx) : [];
}

/** Options for a command in argument mode, filtered by the typed value. */
export function matchArgOptions(
  command: Command,
  query: string,
  ctx: CommandContext
): CommandArgOption[] {
  const arg = command.argument;
  if (!arg || arg.kind !== 'enum') return [];
  const all = arg.options(ctx);
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all
    .map((option) => ({
      option,
      score: Math.max(
        scoreAliases(q, option.aliases),
        scoreText(q, option.label),
        scoreKeywords(q, option.keywords)
      ),
    }))
    .filter((entry) => entry.score !== NO_MATCH)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.option);
}
