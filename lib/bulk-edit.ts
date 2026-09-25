import { getItemTypeConfig, itemTypeName, isCollectible, isRemindable } from './item-registry';
import { classifyKindForItemType } from './container-registry';
import type { Item } from './planner-types';

/**
 * bulk-edit.ts — which items in a multi-selection each bulk PROPERTY edit may
 * touch, asked once and answered for both the store verbs and the bar.
 *
 * The two must agree exactly. The bar prints an eligible count beside each row
 * ("Priority · 3"), and the store filters to the same subset before writing;
 * if either drifted, the count would promise a write the verb then refuses, or
 * the verb would touch items the count never mentioned. So neither asks its own
 * question — both ask here, and everything here asks the registry, never `type`.
 */

/**
 * Priority applies where the TYPE carries the field (habits do not), and never
 * to a cancelled item: re-prioritising something already called off is noise
 * in a sweep that was aimed at live work.
 */
export function canBulkSetPriority(item: Item): boolean {
  if (!getItemTypeConfig(itemTypeName(item)).fields.includes('priority')) return false;
  return (item as { status?: string }).status !== 'cancelled';
}

/**
 * The Project chip's own question: does this type answer with the project
 * classify kind? The same predicate the dialog's classify band resolves through
 * (`classifyKindForItemType`), so a type that declares no container axis never
 * appears here.
 */
export function canBulkSetProject(item: Item): boolean {
  return classifyKindForItemType(getItemTypeConfig(itemTypeName(item)).containerKind) === 'project';
}

/**
 * Clearing is narrower than setting: a type whose container is REQUIRED (habits)
 * must always answer with one, so "No project" skips it rather than blanking it.
 */
export function canBulkClearProject(item: Item): boolean {
  return canBulkSetProject(item) && !getItemTypeConfig(itemTypeName(item)).containerRequired;
}

/** Reminders: the registry's own rule, subtasks excluded. */
export const canBulkSetReminder = isRemindable;

/** Routines, programs and goals: the collect rule, subtasks excluded. */
export const canBulkCollect = isCollectible;

/**
 * Would a cue set on this item never fire for want of a day? A date-anchored
 * type with no startDate occurs on none — the dialog's `reminderNeedsDate`.
 */
export function reminderNeedsDate(item: Item): boolean {
  return getItemTypeConfig(itemTypeName(item)).dateAnchored && !(item as { startDate?: string }).startDate;
}

/** "1 item" / "3 items" — the count half of every bulk label. */
export const itemCount = (n: number): string => `${n} ${n === 1 ? 'item' : 'items'}`;
