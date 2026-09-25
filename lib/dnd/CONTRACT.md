# DnD ID Contract

Parity spec for the view rewrites. `tests/e2e/dnd.spec.ts` is the acceptance gate and
asserts against this grammar — views may change styling and DOM structure freely, but
every draggable/droppable ID below must keep its exact shape and semantics, and every
DOM marker in the next section must keep appearing on the equivalent element. Edits to
either are forbidden without updating this document and the spec together.

Source of truth: `handleDragEnd` in `lib/dnd/handle-drag-end.ts`, wired up by
`components/shell/app-shell.tsx`.

## DOM markers (what the tests actually select on)

The droppable IDs below are dnd-kit's internal registry — invisible to Playwright. These
attributes are how they become testable, and they are as much a part of the contract as
the IDs:

| Attribute | On | Meaning |
|---|---|---|
| `data-dnd-bucket="{bucket}"` | bucket section container | that bucket's region |
| `data-dnd-id="{id}"` | every droppable | its ID from the table below |
| `data-dnd-over="true\|false"` | every droppable | dnd-kit reports the pointer over it |
| `data-testid="item-card"` + `data-item-id` + `data-item-kind` | every draggable row | identity |
| `data-bucket` / `data-start-time` | every draggable row | the row's resolved slot |

`data-dnd-over` is load-bearing, not decorative: it is the only way a test can wait for
the app to confirm a drop target instead of sleeping. `tests/e2e/helpers/dnd.ts` homes in
on it, and `dnd.spec.ts` asserts that no droppable is missing it.

## Draggable IDs

Raw item ids: `active.id === item.id`. Type is resolved by store lookup, not encoded in
the id. **Both tasks and habits are drag sources** (`components/primitives/task-row.tsx`).

## Droppable IDs

| Pattern | Meaning | Action on drop (task / habit) |
|---|---|---|
| `scheduled:{bucket}:{pos}:{refType}:{refId}` | Timed slot relative to a reference item. `pos` = `before` \| `after`; `refType` = `task` \| `habit`. **Mouse/pen only** — a finger gets `spine:*` in the same box (see below) | `scheduleTask(id, bucket, inferDropTime(bucket, pos, refTime), selectedDateStr)` / `scheduleHabit(id, bucket, time)` |
| `spine:{bucket}:{above\|below}:{itemId}` | **Touch only.** The same 8px box between two timed rows, meaning the BUCKET instead of a time. The `{above\|below}:{itemId}` tail only makes the id unique per gap and is not read | same as `unscheduled:{bucket}` |
| `scheduled:{bucket}:empty` | Empty timed section of a bucket | same, with `inferDropTime(bucket, 'empty')` |
| `unscheduled:{bucket}` | Untimed section of a bucket | `scheduleTask(id, bucket, undefined, selectedDateStr)` / `assignHabitToBucket(id, bucket)` |
| `anytime` \| `morning` \| `afternoon` \| `evening` | Bare outer bucket (fallback) | same as `unscheduled:{bucket}` |
| `week:{yyyy-MM-dd}:{bucket}` | Week-view day cell | `scheduleTask(id, bucket, undefined, date)` / `scheduleHabit(id, bucket)` |
| `hour:{H}` | Day-schedule grid slot (0–23) | schedule at `HH:00`; bucket = morning <12, afternoon <17, else evening |
| `weekhour:{yyyy-MM-dd}:{H}` | Week-schedule grid slot | schedule task on that day at `HH:00` (habit: time only, no date) |
| `week:{yyyy-MM-dd}:anytime` | Week-schedule per-day Anytime strip | schedule on that day, `anytime` bucket, no time |
| `projectblock:{projectName}` | Project block in day view | `moveTaskToProjectBlock(id)` — only if `task.project === projectName`; habits ignored |
| `sidebar` | Braindump | `unscheduleTask(id)`; **no-ops for habits** (they are not braindump-eligible) |

`{bucket}` ∈ `anytime | morning | afternoon | evening` (`TimeBucket`).

### Not every target is offered to every input

Touch and cursor see the same grammar with **one substitution**. In each 8px box between
two timed rows (`h-2 -my-0.5`, `day-buckets.tsx`):

| Input | Id mounted there | What a drop does |
|---|---|---|
| mouse / pen | `scheduled:{bucket}:{before\|after}:{ref}` | schedule at that row's time ±30 min |
| touch | `spine:{bucket}:{above\|below}:{id}` | assign the bucket, no time |

**Why.** The sliver is 8px — a third of WCAG 2.5.8's 24px minimum target size, on the
input with the coarsest pointer. It is a *move*, not a reorder (`inferDropTime` resolves
it from the reference row's own time), so it survived the sweep in "Every drop is a MOVE"
below; it went for aim, not for intent. Kirby's call, with the cost stated and accepted:
**on a phone there is no "put this just before that one"** — you drop the row in the
bucket and set its time in the item dialog. Mouse and pen are unchanged in every respect.

**Why a substitution and not a deletion — this part is load-bearing.** Collision is
`closestCenter`, which compares CENTRES, not containment. Those gap boxes are what give a
bucket's timed spine a droppable centre every ~44px; the card's other droppables sit at or
above its middle. Mount nothing in their place and the lowest centre a tall card owns
becomes its own midpoint, so everything below the midpoint between that and the NEXT
card's centre resolves to the next bucket — a silent wrong-bucket write in the view whose
whole job is bucket placement. Measured on a Morning card with an empty Afternoon below
it: a band of 44px at 4 timed rows, 68px at 6, 96px at 8, growing without bound. The
condition is `H > h + 2·gap` (this card's height vs the next card's). Mounting the same
box with a different id keeps every rect and every centre exactly where they were — touch
geometry is the cursor's, to the pixel — and changes only what the drop means.
`tests/unit/dnd-touch-drop-geometry.test.tsx` sweeps the card at 4px and holds it shut.

**Where the rule lives.** `lib/dnd/drop-targets.ts`: `DropTargetKind` names each pattern
in the table above, and `OFFERED_TO` is a `Record` keyed by that union — so a new kind of
drop target fails `tsc` until someone answers "can a thumb hit this?". `dropTargetKind(id)`
parses an id into its kind; an id it does not recognise is offered to everything
(permissive, so a droppable nobody classified keeps working — made safe by the test
asserting every id in § Droppable IDs classifies). Exactly one of the pair above is
offered to any given input: two would double the centres in the spine, none opens the band.

**Two rules, two levels — neither is a backstop for the other:**

1. **View-level — what should this user be OFFERED?** Per view, about geometry and
   affordance, and only the view knows what it renders, which is why the substitution can
   only happen there. `TimedGapDropZone` in `day-buckets.tsx`.
   *Limitation (D2):* it is the only mount site that consults the table. The other
   droppables (empty tray, week cells, hour slots, project blocks, braindump) do not, so
   restricting a FUTURE kind means giving its mount site the same gate — otherwise only
   the grammar-level rule fires and the drop becomes a silent no-op.
2. **Grammar-level — what does this id MEAN for this input?** A total function over every
   id shape here and every view that will ever emit one. `DropContext.input` in
   `resolveDrop`, which returns `null` for an id this input is not offered.

**How "is this a touch drag" is known: from the gesture, never from the device.**
`dragInputOf(event.activatorEvent)` (`lib/dnd/sensors.ts`) reads the event the sensor
activated on — a `PointerEvent`'s `pointerType` for `NonTouchPointerSensor`, `touches` for
the `TouchSensor`'s `touchstart`, which carries no `pointerType` at all. `beginDrag` in
`app-shell.tsx` records it in `lib/drag-store.ts` alongside `activeId`, in the same `set`;
`onDragEnd`/`onDragCancel` clear both together. A `(pointer: coarse)` media query would
answer for the *device* and take the sliver away from a touchscreen laptop's mouse; this
answers per drag, so that machine keeps it for the mouse and loses it for the finger, in
the same session. Anything unlabelled reads as `pointer` — the same direction
`isTouchPointer` errs in, so an unknown input never silently loses a capability.

`tests/unit/dnd-touch-drop-targets.test.tsx` pins the table, the classifier, both halves
of the swap, and the wiring: it imports `beginDrag` from the shell rather than rebuilding
it, because a shell that hard-coded `'pointer'` would otherwise leave every other
assertion green.

**Not a claim this makes:** that the sliver is what a scrolling thumb collides with.
Droppables are only consulted once a drag is already active; scroll-versus-drag is settled
250ms earlier by the `TouchSensor` hold below, before any droppable is considered.

### The bare bucket and `unscheduled:{bucket}` are not separable by pointer

For an EMPTY bucket their centres sit ~3px apart (measured: 802 vs 799), and collision is
`closestCenter`, which compares centres — so no pointer position reliably selects one over
the other. They are defined as the same action, so this is harmless, but a test must accept
either. `dragItemToBucket(..., 'untimed')` does exactly that. Demanding one specific id is a
test that cannot pass.

### The bucket droppables only have a rect while a drag is in progress

The day-spine layout (`components/primitives/bucket-card.tsx`) gives a bucket no filled box
at rest — an empty one is a 22px caption on a hairline. Two consequences the IDs above do not
show:

1. **Nothing moved.** `setBucketRef` is still on the always-present wrapper in
   `day-buckets.tsx`, so `{bucket}` always has a measurable rect and every `data-dnd-*`
   marker still appears on the equivalent element. No ID, marker or action changed.
2. **The slot opens on activation, by design.** `BucketCard` takes a `dragging` prop and
   renders a recess for the duration of the drag. Four caption-only buckets would otherwise
   put their centres ~44px apart — inside the noise floor for `closestCenter` — and give the
   hover state nothing to paint. The slot must never be *animated* in: `MeasuringStrategy`
   is `Always`, but the rect has to be stable before the first collision pass, so only its
   height and fill transition. `helpers/dnd.ts` already relies on this ordering — it waits
   for the target *after* crossing the activation threshold, with the comment "the target
   may only have mounted just now."

### A collapsed bucket drops its inner droppables on purpose

A bucket the user has shut (`view-store.collapsedBuckets`, chevron on the caption) renders
its slot under a drag but **not its children** — so for that bucket
`unscheduled:{bucket}`, `scheduled:{bucket}:{pos}:…` and `scheduled:{bucket}:empty` do not
mount at all, and every drop onto it resolves on the bare `{bucket}` id.

That is safe rather than lossy: `resolveDrop` maps bare `{bucket}` and `unscheduled:{bucket}`
to the *same* command (assign the bucket, no time), so the outcome is identical to dropping
on the untimed section of an open bucket. It is also the point — a shut card holds one rect
instead of three, so there is nothing inside it for `closestCenter` to have to separate. The
alternative (mounting the real rows under a drag) would reflow the column at drag start,
which the rect-stability rule above forbids.

Two consequences for tests: `dragItemToBucket(..., 'untimed')` must accept the bare id (it
already does), and a spec that needs a *timed* drop has to ensure the target bucket is
expanded first — `[data-testid=bucket-card][data-bucket=X][data-collapsed=false]`.

`app-shell.tsx` expands the target bucket after any drop that carries one, so a drop never
lands in a bucket that stays shut.

### Known-flaky: leftover rows change every bucket drag's geometry

`global-setup.ts` sweeps litter, but only titles matching `TEST_TITLE_PREFIX` (`e2e_`). Rows
from older conventions (`Panel first …`, `EOD complete test …`, `Mobile daily future …`)
accumulate permanently in the shared test user, make the morning bucket arbitrarily tall, and
push later buckets toward or past the scroll boundary — which is the autoscroll
non-determinism described at the bottom of this file. Measured on 2026-08-09: with ~23 such
rows present, `dnd.spec.ts` fails a *different* test on each run, and does so identically on
a pristine checkout. If a bucket drag flakes, check the account's row count before the diff.
Locally also pass `--workers=1`: `workers` is only pinned under `CI`, and parallel specs
share one test user.

## Sensors (`components/shell/app-shell.tsx`, policy in `lib/dnd/sensors.ts`)

- `NonTouchPointerSensor` — activationConstraint `{ distance: 5 }`
- `TouchSensor` — activationConstraint `{ delay: 250, tolerance: 5 }`
- `collisionDetection` — `closestCenter`

`NonTouchPointerSensor` is `PointerSensor` with one extra line in its activator:
it returns `false` for `pointerType === 'touch'`. That line is the whole reason
touch drag and touch scroll can coexist, and it is load-bearing rather than
cosmetic — a plain `PointerSensor` also fires for fingers, and dnd-kit lets only
the *first* sensor claim a gesture (`activeRef.current !== null` → "another
sensor is already instantiating"). Since `pointerdown` precedes `touchstart`,
the pointer sensor used to win every touch and the `TouchSensor` line below was
dead configuration: a 5px flick dragged a row instead of scrolling the list, and
raced `components/mobile/swipe-row.tsx`, which claims horizontal intent at 10px.

**Split by input type, never by viewport.** A media query mis-handles a
touchscreen laptop in both directions. `pointerType` is per-gesture and honest.

Two consequences for tests and helpers:

- Anything driving a drag through Playwright's `page.mouse` (`tests/e2e/helpers/dnd.ts`)
  is unaffected — those are `pointerType: 'mouse'`, so the 5px distance
  constraint still governs, exactly as before.
- A drag driven by *touch* must press and hold ≥250ms, moving <5px, before it
  moves. There is no e2e touch drag today; one would need that hold.

`closestCenter` compares the **dragged element's rect centre**, not the cursor. A helper
that aims the pointer at the target's centre is aiming at the wrong thing whenever the grab
point is off-centre on the row.

Both halves of the split are pinned, and it takes both files: `tests/unit/dnd-sensors.test.ts`
exercises the activator predicate, and `tests/unit/dnd-sensor-pipeline.test.tsx` mounts the
shell's own `useShellSensors` in a real `DndContext` and drives pointerdown/touchstart
through it. Only the second goes red if the shell is wired back to a plain `PointerSensor`.

### The schedule grid's resize handles are mouse/pen only

`components/views/day-schedule.tsx` declines `onResizeDown` for touch pointers.
The hit zone is 12px tall — unaimable with a fingertip, yet crossed constantly by
a scrolling thumb, and every crossing captured the pointer and wrote a new
duration on release. It is not a drop target and no ID above changes; the touch
path to the same edit is the duration field in the item dialog.
Covered by `tests/unit/schedule-resize-pointer.test.tsx`, which presses a handle as each
input type — every other resize test in the suite sends a blank `pointerType`, which reads
as non-touch and so exercises the mouse path.

The sliver between two timed rows is the same shape of problem in the drop grammar rather
than in a handle — 8px against WCAG 2.5.8's 24px — and is withheld from touch the same
way, except that a `spine:` box takes its place so the geometry does not move; see "Not
every target is offered to every input" above. Those two, plus the sensor split, are the
whole of what touch does differently. Every other drag is identical for a finger and a
cursor.

### Every drop is a MOVE. No drop reorders.

Read the action column above as a set: it assigns a bucket, a day, a time, a project
block, or it unschedules. Not one of the five `DropCommand` kinds writes `items.order`.
dsul has no drag-to-reorder — on touch, on a mouse, anywhere. `planner-store.reorderTasks`
exists with zero call sites, `@dnd-kit/sortable` is a dependency imported nowhere, and the
only reorder UI in the product is the Organize console's up/down buttons
(`components/planner/organize/member-list.tsx`, "Buttons, not drag").

This is load-bearing for a decision, not trivia. Asked whether rows should be
drag-reorderable on a phone, Kirby said no. That answer is already in force — and it is in
force for the strongest possible reason, that there is nothing for a finger to reach — so
there is no `isMobile` gate anywhere, and there must not be one: a branch guarding a
capability nobody has is a branch that rots.

What makes it fragile is that it is free by accident. `lib/sort-rows.ts` names the
follow-up ("Wire drag-to-reorder into the untimed section…"), `orderable: true` on the task
type is standing permission to build it, and dnd-kit sensors do not distinguish drop
targets — so the day one lands, touch inherits it silently and the decision reverses with
nobody deciding to reverse it. `tests/unit/dnd-no-reorder.test.ts` is the tripwire: it
classifies every `DropCommand` kind through a `Record` keyed by the union (so a new kind
fails `tsc` until someone answers move-or-reorder), and it fails if any file that imports
dnd-kit calls a `reorder*` action or if `@dnd-kit/sortable` is ever imported.

A reorder driven by BUTTONS is deliberately still allowed, and is the shape any mobile
reorder should take: it is what the Organize console already does, and it is the
single-pointer alternative WCAG 2.5.7 asks for.

## Helpers

- `inferDropTime(bucket, pos, refTime?)` — `lib/dnd/infer-drop-time.ts`. Derives a `HH:mm`
  for a drop relative to a reference item's `startTime`, or a bucket default for `empty`.
- `autoCorrectBucket(time, bucket)` — re-derives the bucket from an explicit time, so a
  drop that sets a time cannot leave the row in a contradictory bucket.
- `dropTargetKind(id)` / `isDropTargetOffered(id, input)` — `lib/dnd/drop-targets.ts`.
  Which input types a target is offered to, and the `relative-time` / `bucket-spine`
  substitution; see "Not every target is offered to every input".
- `dragInputOf(activatorEvent)` — `lib/dnd/sensors.ts`. `'touch' | 'pointer'` for the
  gesture in progress, from the event that activated it.

## Store actions consumed

`scheduleTask(id, bucket, time?, dateStr?)` · `scheduleHabit(id, bucket, time?)` ·
`assignHabitToBucket(id, bucket)` · `unscheduleTask(id)` · `moveTaskToProjectBlock(id)`
(all `lib/planner-store.ts`).

## Definition sites

`useDroppable`: `components/views/day-buckets.tsx` (bucket, unscheduled, scheduled:*:empty,
and the gap box that is scheduled:*:before/after for a cursor and spine:* for a finger),
`components/views/week-buckets.tsx` (`week:*`),
`components/views/day-schedule.tsx` (`hour:*`, `unscheduled:anytime`),
`components/views/week-schedule.tsx` (`weekhour:*`, `week:*:anytime`),
`components/views/project-block.tsx` (`projectblock:*`), `components/sidebar/braindump.tsx`
(`sidebar`).

`useDraggable`: `components/primitives/task-row.tsx` (rows),
`components/views/day-schedule.tsx` (schedule blocks).

## Testing note: autoscroll

A drag that crosses a scroll boundary triggers dnd-kit's autoscroll, and dnd-kit collides
droppable rects measured at drag START against a scroll-COMPENSATED active rect. After an
autoscroll its model and the live layout disagree by the scroll delta, so the outcome
depends on how much scrolling accumulated mid-gesture and is not deterministically
drivable from Playwright. Test bucket reassignment against a NEIGHBOURING bucket — the
store action and observable are identical — and cover long-distance moves through the
schedule sheet, which issues the same commands without a gesture.
