// Schemas (Zod) — use for runtime validation
export {
  PrioritySchema,
  ItemSizeSchema,
  TimeBucketSchema,
  TimeOfDaySchema,
  TaskStatusSchema,
  HabitStatusSchema,
  RepeatFrequencySchema,
  RecurrenceFieldsSchema,
  ProjectSchema,
  HabitGroupSchema,
  SeasonStateSchema,
  RoutineSchema,
  SeasonSchema,
  GoalStateSchema,
  GoalRoleSchema,
  GoalSchema,
  TaskSchema,
  HabitSchema,
  TaskItemSchema,
  HabitItemSchema,
  CustomItemSchema,
  ItemSchema,
  ItemTypeDefSchema,
  TaskCreateSchema,
  HabitCreateSchema,
  TaskUpdateSchema,
  HabitUpdateSchema,
  RoutineCreateSchema,
  RoutineUpdateSchema,
  SeasonCreateSchema,
  SeasonUpdateSchema,
  GoalCreateSchema,
  GoalUpdateSchema,
  DsulContextResponseSchema,
  DsulChangeEventSchema,
  AiStatusSchema,
  ProposalCreateOpSchema,
  ProposalUpdateOpSchema,
  ProposalOperationSchema,
  ProposalSchema,
  ProposalDraftSchema,
  DevicePlatformSchema,
  DeviceTransportSchema,
  DeviceDeliverySchema,
  DeviceFormSchema,
  DeviceSendKindSchema,
  DevicePrefsSchema,
  DeviceRegistrationSchema,
  DeviceSchema,
} from './schemas.js'

// Schema-derived field lists (values, not types)
export {
  TASK_FIELDS,
  HABIT_FIELDS,
  PROJECT_FIELDS,
  HABIT_GROUP_FIELDS,
  ROUTINE_FIELDS,
  SEASON_FIELDS,
  GOAL_FIELDS,
} from './schemas.js'

// Types (inferred from schemas — no duplication)
import { z } from 'zod'
import {
  PrioritySchema,
  ItemSizeSchema,
  TimeBucketSchema,
  TaskStatusSchema,
  HabitStatusSchema,
  RepeatFrequencySchema,
  RecurrenceFieldsSchema,
  ProjectSchema,
  HabitGroupSchema,
  SeasonStateSchema,
  RoutineSchema,
  SeasonSchema,
  GoalStateSchema,
  GoalRoleSchema,
  GoalSchema,
  TaskSchema,
  HabitSchema,
  TaskItemSchema,
  HabitItemSchema,
  CustomItemSchema,
  ItemSchema,
  ItemTypeDefSchema,
  DsulContextResponseSchema,
  DsulChangeEventSchema,
  AiStatusSchema,
  ProposalCreateOpSchema,
  ProposalUpdateOpSchema,
  ProposalOperationSchema,
  ProposalSchema,
  ProposalDraftSchema,
  DevicePlatformSchema,
  DeviceTransportSchema,
  DeviceDeliverySchema,
  DeviceFormSchema,
  DeviceSendKindSchema,
  DevicePrefsSchema,
  DeviceRegistrationSchema,
  DeviceSchema,
} from './schemas.js'

export type Priority         = z.infer<typeof PrioritySchema>
export type ItemSize         = z.infer<typeof ItemSizeSchema>
export type TimeBucket       = z.infer<typeof TimeBucketSchema>
export type TaskStatus       = z.infer<typeof TaskStatusSchema>
export type HabitStatus      = z.infer<typeof HabitStatusSchema>
export type RepeatFrequency  = z.infer<typeof RepeatFrequencySchema>
export type RecurrenceFields = z.infer<typeof RecurrenceFieldsSchema>
export type Project          = z.infer<typeof ProjectSchema>
export type HabitGroupType   = z.infer<typeof HabitGroupSchema>
export type SeasonState     = z.infer<typeof SeasonStateSchema>
export type Routine          = z.infer<typeof RoutineSchema>
export type Season          = z.infer<typeof SeasonSchema>
export type GoalState        = z.infer<typeof GoalStateSchema>
/** What a member does for its goal: ordinary work, a checkpoint, or a recurring review. */
export type GoalRole         = z.infer<typeof GoalRoleSchema>
export type Goal             = z.infer<typeof GoalSchema>
export type Task             = z.infer<typeof TaskSchema>
export type Habit            = z.infer<typeof HabitSchema>
export type TaskItem         = z.infer<typeof TaskItemSchema>
export type HabitItem        = z.infer<typeof HabitItemSchema>
export type CustomItem       = z.infer<typeof CustomItemSchema>
export type Item             = z.infer<typeof ItemSchema>
/** Open — user-defined types widen this to arbitrary slugs (Phase 6). */
export type ItemType         = Item['type']
/** The built-in types with dedicated schema branches and static registry configs. */
export type KnownItemType    = TaskItem['type'] | HabitItem['type']
export type ItemTypeDef      = z.infer<typeof ItemTypeDefSchema>
export type DsulContextResponse = z.infer<typeof DsulContextResponseSchema>
export type DsulChangeEvent     = z.infer<typeof DsulChangeEventSchema>
export type AiStatus              = z.infer<typeof AiStatusSchema>
export type ProposalCreateOp      = z.infer<typeof ProposalCreateOpSchema>
export type ProposalUpdateOp      = z.infer<typeof ProposalUpdateOpSchema>
export type ProposalOperation     = z.infer<typeof ProposalOperationSchema>
export type Proposal              = z.infer<typeof ProposalSchema>
export type ProposalDraft         = z.infer<typeof ProposalDraftSchema>
export type DevicePlatform        = z.infer<typeof DevicePlatformSchema>
export type DeviceTransport       = z.infer<typeof DeviceTransportSchema>
export type DeviceDelivery        = z.infer<typeof DeviceDeliverySchema>
export type DeviceForm            = z.infer<typeof DeviceFormSchema>
export type DeviceSendKind        = z.infer<typeof DeviceSendKindSchema>
export type DevicePrefs           = z.infer<typeof DevicePrefsSchema>
export type DeviceRegistration    = z.infer<typeof DeviceRegistrationSchema>
export type Device                = z.infer<typeof DeviceSchema>
