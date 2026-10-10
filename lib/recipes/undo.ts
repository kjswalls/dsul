import { z } from 'zod';

/**
 * A server run's Revert (memory/plans/mods.md, "On the server": there is no
 * undo there, so the run log offers Revert). Each write the server runner
 * makes records its inverse here, newest first, in the run's mod_runs
 * summary; Revert in Make (./revert.ts) applies them through the planner
 * store as one undoable action. Tuples, not objects, to stay well inside
 * 061's 4096-byte summary CHECK.
 *
 * Owner-asserted on the way back in (the owner can insert any summary of their
 * own), so it is Zod-parsed before anything acts on it, and each op asks the
 * live store before it writes.
 */

const Id = z.string().uuid();
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const UndoOpSchema = z.union([
  /** Take back a completion: a recurring item's on `day`, a one-off's status when `day` is null. */
  z.tuple([z.literal('uncomplete'), Id, Day.nullable()]),
  /** Lift a skip on `day`. */
  z.tuple([z.literal('unskip'), Id, Day]),
  /** Put an item back on `from` (null: back to the braindump) if it still sits on `to`. */
  z.tuple([z.literal('move'), Id, Day.nullable(), Day]),
  /** Delete an item the run added. */
  z.tuple([z.literal('delete'), Id]),
]);
export type UndoOp = z.infer<typeof UndoOpSchema>;

export const UndoOpsSchema = z.array(UndoOpSchema).max(25);
