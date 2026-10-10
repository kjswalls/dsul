// Sets up the KW YouTube Channel plan in dsul through dsul's MCP server.
// Run:  node setup-youtube.mjs
// With no DSUL_AGENT_KEY set, it pairs the way OpenClaw's setup does: it prints a
// link and a code, you approve in the browser, and it receives your agent key
// (the same key OpenClaw uses; pairing never replaces it). The key is never printed.
// Safe to re-run: anything that already exists (matched by title or name) is reused.
const BASE = process.env.DSUL_URL ?? 'https://do.dsul.app'
const KEY = process.env.DSUL_AGENT_KEY ?? (await pair())

async function pair() {
  const init = await (await fetch(`${BASE}/api/agent/connect/init`, { method: 'POST' })).json()
  if (!init.sessionId) throw new Error(`Could not start pairing: ${JSON.stringify(init)}`)
  console.log(`\nOpen ${init.connectUrl}\nCheck the code shows ${init.userCode}, then authorize. Waiting...\n`)
  const deadline = Date.parse(init.expiresAt)
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const res = await fetch(`${BASE}/api/agent/connect/poll?session=${encodeURIComponent(init.sessionId)}`)
    if (res.status === 429) continue
    const poll = await res.json()
    if (poll.status === 'authorized' && poll.apiKey) { console.log('Paired.'); return poll.apiKey }
    if (poll.status !== 'pending') throw new Error(`Pairing ended: ${poll.status ?? JSON.stringify(poll)}`)
  }
  throw new Error('The code expired. Run the script again.')
}

const PROJECT = 'KW YouTube Channel'
let rpcId = 0
async function call(name, args = {}) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
      'x-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  })
  const msg = await res.json()
  if (msg.error) throw new Error(`${name}: ${msg.error.message}`)
  const text = msg.result?.content?.[0]?.text ?? ''
  return { isError: !!msg.result?.isError, text, json: safeJson(text) }
}
const safeJson = (t) => { try { return JSON.parse(t) } catch { return null } }
const idOf = (body) => body && Object.values(body).find((v) => v && typeof v === 'object' && v.id)?.id
async function must(name, args) {
  const r = await call(name, args)
  if (r.isError) throw new Error(`${name} failed: ${r.text}`)
  return r
}

const ctx = (await must('dsul_get_context')).json
const items = ctx.items ?? [...(ctx.tasks ?? []), ...(ctx.habits ?? [])]
const fold = (s) => s.trim().toLowerCase()
const existingItem = (title) => items.find((i) => fold(i.title) === fold(title))
const existingIn = (list, name) => (list ?? []).find((x) => fold(x.name) === fold(name))

// 1. Project
let project = existingIn(ctx.projects, PROJECT)
if (!project) {
  const r = await call('dsul_create_project', {
    name: PROJECT,
    emoji: 'icon:Sparkles',
    notes: 'Weekly devlog, published every Sunday. Season 1 is 12 episodes; success is shipping every week, not views.',
  })
  if (r.isError && !r.json?.project) throw new Error(`dsul_create_project failed: ${r.text}`)
  project = r.json.project
  console.log(r.isError ? `Project exists: ${project.name}` : `Created project: ${project.name}`)
} else console.log(`Project exists: ${project.name}`)
const group = project.name

// 2. Weekly habits, in the order the routine runs them
const HABITS = [
  { title: 'Capture a clip and a one-line note', repeatDays: [1, 2, 3, 4], duration: 5,
    notes: 'Keep OBS running with a replay buffer; save a clip when something works, breaks, or looks interesting. Log a one-line note per clip (voice memo is fine). Done when at least one clip and note are saved today.' },
  { title: 'Record narration', repeatDays: [5], duration: 90,
    notes: 'Review the week\'s clips and talk over them in one long take (60 to 90 min). Done when the raw narrated recording is saved.\n\nEpisode template, four beats:\n1. What I set out to do: the project and goal for the week.\n2. What I built: a demo, narrated over the captured clips.\n3. What went wrong: bugs, dead ends, and what was learned.\n4. What\'s next: the plan for next week.' },
  { title: 'Edit and package the episode', repeatDays: [6], duration: 120,
    notes: 'Rough cut with automatic silence removal, then title, thumbnail and description. 2 hour hard cap: stop at the cap. Done when exported and uploaded as scheduled or private.' },
  { title: 'Publish and share the episode', repeatDays: [0], duration: 15,
    notes: 'Make the episode public and share it. Done when it is live. Never skip two Sundays in a row: with no episode banked, publish a minimum viable episode (5 to 10 min of unedited screen share). A rough episode still counts.' },
  { title: 'Buffer check', repeatDays: [0], duration: 5,
    notes: 'Count banked episodes and write the number here.\n\nRules: keep 1 to 2 finished episodes banked, no more (devlogs go stale). In a week the workflow can\'t happen, publish a banked one. In a good week, make an extra until the bank is back to 2. With none left, publish a minimum viable episode instead of skipping. Never skip two weeks in a row.\n\nBanked: 0' },
]
const habitIds = []
for (const h of HABITS) {
  const found = existingItem(h.title)
  if (found) { habitIds.push(found.id); console.log(`Habit exists: ${h.title}`); continue }
  const r = await must('dsul_create_habit', { ...h, group, repeatFrequency: 'custom' })
  habitIds.push(idOf(r.json)); console.log(`Created habit: ${h.title}`)
}

// 3. Launch tasks: one parent, seven ordered subtasks, in the Braindump (no date yet)
const PARENT = 'Launch the devlog'
let parent = existingItem(PARENT)
if (!parent) {
  const r = await must('dsul_create_task', { title: PARENT, project: group,
    notes: 'Launch once two finished episodes are banked. No launch date yet. Steps are in order; each depends on the one before.' })
  parent = { id: idOf(r.json) }; console.log(`Created task: ${PARENT}`)
} else console.log(`Task exists: ${PARENT}`)
const STEPS = [
  'Set up capture: OBS replay buffer, save-clip hotkey or voice command, quick one-line notes',
  'Set up editing: automatic silence removal (e.g. Descript), reusable thumbnail and title format',
  'Pick a launch Sunday and add it to the calendar',
  'Produce banked episode 1 using the weekly workflow',
  'Produce banked episode 2 using the weekly workflow',
  'Launch: publish episode 1, keep episode 2 banked, start the cycle for episode 3',
  'After episode 12: review Season 1 and decide what to change for Season 2',
]
for (const title of STEPS) {
  if (existingItem(title)) { console.log(`Subtask exists: ${title}`); continue }
  await must('dsul_create_task', { title, parentItemId: parent.id }); console.log(`Created subtask: ${title}`)
}

// 4. Routine holding the habits, in order
const ROUTINE = 'Episode week'
let routine = existingIn(ctx.routines, ROUTINE)
if (!routine) {
  const r = await must('dsul_create_collection', { kind: 'routine', name: ROUTINE, icon: 'icon:Sparkles', itemIds: habitIds })
  routine = { id: idOf(r.json) }; console.log(`Created routine: ${ROUTINE}`)
} else console.log(`Routine exists: ${ROUTINE}`)

// 5. Season holding the routine, paused until launch Sunday
const SEASON = 'Devlog Season 1'
if (!existingIn(ctx.seasons, SEASON)) {
  await must('dsul_create_collection', { kind: 'season', name: SEASON, icon: 'icon:Sparkles', state: 'paused', routineIds: [routine.id] })
  console.log(`Created season: ${SEASON} (paused until launch)`)
} else console.log(`Season exists: ${SEASON}`)

console.log('Done.')
