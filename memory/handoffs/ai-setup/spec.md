# AI onboarding, final: "Ask is always there"

Kirby, this is the decided direction drawn as one set of screens, with every judge copy fix and
visual fix that touches them applied. The screens are in `final/` and listed in story order in
`final/screens.json`. They were drawn on the production build with a fake Supabase, by injecting
markup into the real page, so the header, dock, rail, settings shell and tokens are real. Every
frame is new; the scripts that drew them are adapted from the ask, connect, tour and moments
designers' (`final/work/`).

## 1. The journey in plain words

1. **First login.** The tour runs as today. Its last step spotlights the Ask key in the top-right
   corner, which is unlit because nothing is connected. The card says what AI could do in one
   line. It then shows two example questions built from the task you just typed, and offers
   **Set up AI**, **Not now** and **No AI, thanks**. The streak toast now waits until the tour is
   over and you have a habit, so nothing covers the tour on the phone. (F01, F02)
2. **The door stays.** Whether you pick Not now or skip the tour, the key stays in the corner. It
   is the same plate as the lit key, with grey tiles instead of lime, and it reads "Set up AI".
   Three other doors lead to the same place:
   - Ctrl+J;
   - "?" in the dock, which keeps your question;
   - Ctrl+K, where "Set up AI" replaces the AI commands. (F03, F04, F14, F15)
3. **Setup lives where Ask lives.** Opening any door opens Ask's own column, or the Ask tab on the
   phone. You see the questions you could ask, then one recommended way in: a free Gemini key
   from Google with three steps, and a box with a Paste button.
   - Pasting checks the key right away with one tiny test question.
   - If the check fails, the key stays in the box and the reason is shown in plain words.
   - Other ways (OpenRouter sign-in, a key you already have, your own server, OpenClaw) are
     folded underneath.
   - What it costs, what is sent and how to take it back are stated at normal text size.
   - "No AI, thanks" is always at the foot. (F05–F11b, F14b, F17)
4. **It works.** The card turns into "It works." and names the service and the model. The column
   becomes Ask in place, the key lights, and a question you brought from "?" is sent. From then
   on the key is lit and reads "Ask". (F12, F13, F13b)
5. **No AI.** "No AI, thanks" hides every AI surface and every invitation, on every device. An
   undo strip offers Undo. Settings → AI can turn it back on. (F16, F22)
6. **Settings → AI** is the connect designer's pane with the fixes applied. In order: what AI
   does, Use AI in dsul, Connection (with one status pill), Good to know, OpenClaw, and On this
   device. Searching settings for connect, API key, Gemini, OpenRouter or ChatGPT finds it. When
   a saved key stops working, the key reads "Fix AI" and Ask's column offers the fix. (F18–F22,
   F20b)
7. **The desktop app** uses the Gemini path unchanged. OpenRouter sign-in happens in the browser.
   (F11b)

## 2. Copy, verbatim

### The key (desktop header, `components/ai/rail/ask-opener.tsx`)
| State | Word | Beside the plate | Title / aria-label |
|---|---|---|---|
| Unlit, before the first visit | Set up AI | Set up | Set up AI (Ctrl+J) / Set up AI |
| Unlit, after the first visit | Set up AI | Ctrl+J | Set up AI (Ctrl+J) / Set up AI |
| Unlit, saved connection failing | Fix AI | Ctrl+J | Fix AI (Ctrl+J) / Fix AI |
| Lit (unchanged) | Ask | Ctrl+J | as today |

The chord is the bound one (`chordLabel`), so a rebinding reads right; Ctrl+J is the default on
Windows and Linux.

### Tour step 4, nothing connected (`components/onboarding/onboarding-tour.tsx`)
- Title: **AI, if you want it**
- Body: AI can plan the day with you, break big tasks into steps, and answer questions about your plan. You always decide.
- Heading: WHAT YOU COULD ASK NOW
- “Plan tomorrow” · Drafts tomorrow from your braindump, like “Call the dentist”.
- “Review today” · Looks back at today with you, and what you'd carry into tomorrow.
- Caption: Built from your planner. Each becomes one click once AI is connected.
- Phone only, under the preview: Later, it waits under the mode button.
- Buttons: **Set up AI** (lime, full width) · **Not now** · **No AI, thanks** (equal outline pair) · ‹ Back
- The openers come from `buildChatOpeners` over the real planner. The example in quotes is the
  task typed at step 2; if step 2 was skipped, the line drops the example ("Drafts tomorrow from
  your braindump.").
- The tour's completion toast, after **Not now**: title "You're all set. One thing at a time.";
  description "Set up AI waits at the top right whenever you want it." (phone: "Set up AI waits
  under the mode button whenever you want it."). After **No AI, thanks** there is no completion
  toast, only the undo strip. After **Set up AI** there is no toast, and the column opens.
- The connected card ("Your AI is ready") keeps its copy but loses its Settings button (C6).

### Setup home (Ask's column; the phone's Ask tab)
- Header: unlit mark + **Set up AI**. History and New chat are hidden.
- Greeting: the real Ask greeting ("Evening, Kirby.").
- WHAT YOU COULD ASK NOW (quoted, no row borders, no hover, no arrows):
  - “Plan tomorrow” · Drafts tomorrow from what's on it and your braindump. You keep, move or drop each line.
  - “What's been sitting?” · Goes through things that have waited a while, like “Fix the squeaky door”, and helps you keep them or let them go.
  - “Review today” · Looks back at today with you: what got done, and what you'd carry into tomorrow.
  - Caption: Each becomes one click once AI is connected.
- Phone order: the key card first, then two openers (engineering visual fix 6).
- Pinned foot (desktop): AI is optional. dsul works fully without it. · **No AI, thanks**. On the
  phone the same line and button close the page.

### Connect V1 card
- Tag: Free, no card
- Title: **Get a free key from Google**
- Body: Anyone with a Google account can make one. It works in dsul on the web and in the desktop app.
- Inline note: A ChatGPT or Claude subscription isn't an API key. This free key works instead.
- WHAT YOU’LL SEE
  1. Google AI Studio opens. Sign in with your Google account. [Open Google AI Studio ↗]
  2. Press **Get API key**, then **Create API key**. If it asks about a project, keep the one it offers.
  3. Copy the key and paste it below. It starts with `AIza`. (prefix in the mono face)
- Label: Your Gemini key · placeholder: Paste your key · [Paste]
- Helper: dsul checks it the moment you paste, with one tiny test question.
- Helper with a kept question: dsul checks it with one tiny test question, then asks yours.
- Once a key is in the box, the steps fold to "WHAT YOU’LL SEE · Show the steps ⌄". They come
  back open on a refusal.
- Checking: Checking your key with Google…
- Refused (honey note, key kept): Google didn’t accept that key. It may be cut short, or it was deleted in AI Studio. It’s still in the box, so you can check it or paste a new one. · [Check again] [Open Google AI Studio ↗]
- Wrong kind (neutral note): That looks like an OpenAI key, not a Google one. OpenAI keys work too, but they need credit on your OpenAI account. · [Use it with OpenAI] [Clear]
- Typed rather than pasted: [Connect]. With a kept question: consent line, then [Connect and ask].
- Consent line: Connecting sends your question, and the parts of your plan it needs, from dsul’s server to Google.

### Folds under the card
- **Sign in with OpenRouter** · Free models on a new, free account. Nothing to copy.
  - Open (web): Make a free OpenRouter account, then come back here. On a new account, dsul picks a free model, which has a daily limit. · [Sign in with OpenRouter ↗] · OpenRouter opens in this tab and sends you back to this column.
  - Open (desktop app): the same first line, then: Sign-in can’t finish inside the desktop app yet. Open dsul in your browser and sign in there. This window picks up the connection when you come back. · [↗ Open dsul in your browser] · Or use the free Google key above, which works here as it is. The button opens `do.dsul.app/settings/ai?start=openrouter`, an alias route, so "beacon" never shows.
- **I already use OpenAI, Anthropic, Gemini or another service** · Paste a key you have, use your own server, or pair OpenClaw.
  - Open: Paste a key from any of them. dsul reads which service it’s for and checks it the same way. · Your key · Paste your key · Need one? OpenAI · Anthropic · OpenRouter
  - Note: A ChatGPT Plus or Claude Pro plan isn't an API key. Each company bills its API on its own, with credit you add first.
  - Rows: **Another service** · Your own address, if it speaks the OpenAI API and is on the internet. / **OpenClaw** · Your own agent answers in Ask. Pair it in Settings → AI.
  - Detected chip after paste: ✓ OpenAI key / ✓ Anthropic key / ✓ OpenRouter key / ✓ Gemini key.

### Good to know (normal size, 13px, body contrast)
- **Cost.** Google’s free key costs nothing. It has a daily limit, and AI pauses until Google resets it. dsul never charges for AI.
- **What’s sent.** Only when you ask: your question and the parts of your plan it needs, from dsul’s server to Google. On the free plan, Google may use it to improve its products.
- **Your key.** Stored encrypted on dsul’s server and never shown again, not even to you.
- **Taking it back.** Disconnect any time in Settings → AI, and dsul deletes the key. (In the pane itself: Disconnect here any time, and dsul deletes the key.)

### Kept question (from "?")
- YOUR QUESTION · “what should I do first” · [Clear] · It’s kept here, and sent once AI is connected.

### Success and Ask home
- **It works.** Google Gemini answered a test question. Ask will use **Gemini Flash**, Google’s quick everyday model, on the free plan.
- Well: Connected to your account, so dsul on the web and in the desktop app both use it.
- After: Change the model or disconnect in Settings → AI.
- START WITH ONE OF THESE, with live rows (no quotes, arrow, hover wash) and the caption "Pick one to start, or ask anything below."
- Next open, a one-time notice: Connected to Google Gemini. Ask is using Gemini Flash on Google’s free plan. Change model
- Answerer label under the box: Gemini Flash (catalog names only, never raw ids).
- Other services' notices follow the pattern "Connected to {provider}. Ask is using {catalog model name}." For example, Llama 3.3 70B (free) on OpenRouter.

### Fix state (Ask's column, opened from "Fix AI")
- Header: unlit mark + **Fix AI**
- Card: **Google Gemini** · Free key · Google turned it down an hour ago
- Honey note: Google stopped accepting your key, so AI can’t answer right now. Paste a new one and Ask picks up where it left off.
- New Gemini key · Paste your key · Your old key is replaced only once this one works.
- [Open Google AI Studio ↗] [Check the old key again]
- Caption: Other services, the model and Disconnect are in Settings → AI.

### Doors
- Dock "?" with nothing connected: group **Ask**, row **Set up AI to ask this**, hint "↵ open".
- Ctrl+K while nothing answers: **Set up AI** (unlit mark, "↵ open"), first in Actions. "Ask AI",
  "New chat" and the footer's "Ctrl↵ AI" hint are hidden. The footer's chat hint wears the unlit
  mark, not Sparkles.
- Phone mode switcher: **Set up AI** · Optional, with the unlit AskMark. Once connected the row
  reads Ask, with the lit mark. Sparkles is gone from the switcher row and the dock's mode button.

### No AI
- Undo strip (UI face, not the numeric face): AI is off. dsul won’t bring it up again. · Undo

### Settings → AI (F18–F22)
- Header: unlit or lit mark + AI · Optional help that knows your planner.
- What AI does in dsul (tiles, shown while not connected): **Ask** · Talk through your day, or ask what to do next. Open it with Ctrl+J. / **Plan suggestions** · Drafts today or tomorrow from your list. You keep, move or drop each line. / **Break it down** · Turns a big task into small steps you can start. · Nothing in your planner changes unless you say yes.
- Folded when connected: AI in dsul is **Ask** (Ctrl+J), **plan suggestions** and **Break it down**. Nothing in your planner changes unless you say yes.
- Use AI in dsul [All your devices]:
  - not connected: AI is optional. No AI, thanks hides Ask and every invitation to set it up, on all your devices. You can turn it back on here. · [No AI, thanks]
  - on: Off hides Ask, plan suggestions, Break it down and every invitation to set AI up, on all your devices. dsul works fully either way. · switch on
  - off: AI is off. Ask, plan suggestions, Break it down and every invitation to set AI up are hidden on all your devices. · switch off
- Connection pills: Not set up · Checking… · Working · Needs attention · Daily limit · back at {7 am}
- Working: **Google Gemini** · Free key · answered a test question 2 hours ago · Check again / Model · Answers in Ask and drafts your plans. · [Gemini Flash ⌄] / Replace key · Use a different service · Disconnect
- Needs attention: Free key · Google turned it down an hour ago / Google stopped accepting this key. It may have been deleted in AI Studio, or its project was turned off. Ask and plan suggestions are paused until a working key is in. / New Gemini key / Your old key is replaced only once this one works. Open Google AI Studio ↗ / Check the old key again · Use a different service · Disconnect
- Daily limit: Free key · today’s limit reached at 5:52 pm / You’ve used today’s free questions. Google resets free keys once a day, and AI comes back by itself at 7 am. / Google’s paid plan lifts the daily limit. dsul never charges for AI. / [Open Google AI Studio ↗] Use a different service
- Good to know, connected (folded row: "Cost, what’s sent, your key, and taking it back"): Cost. Free. Google’s free key has a daily limit. If you reach it, AI pauses until Google resets it. dsul never charges for AI. / What’s sent. (as above) / Your key. Stored encrypted on dsul’s server and never shown again, not even here. The web and the desktop app share this one connection. / Taking it back. Disconnect above and dsul deletes the key. To cancel the key itself, delete it in Google AI Studio.
- OpenClaw [Not paired]: Run your own OpenClaw agent? Pair it, and it can answer in Ask and take on tasks you hand it. · [Pair OpenClaw]
- On this device [This browser only, monitor glyph; phone glyph on the phone, laptop glyph in the desktop app]: These two stay on this device, so your phone and the desktop app can each have their own. / Who answers in chat · Who replies when you open Ask here. Off keeps Ask closed on this device only. / Custom instructions (unchanged)
- AI off card: **AI is off** · dsul won’t show AI or bring it up again until you turn it back on above. Your planner works exactly the same. / Google Gemini is still connected · Your key stays saved, so turning AI back on picks up where you left off. Disconnect to delete it. · [Disconnect] / (when paired) atlas is still paired · OpenClaw reads your planner through its own pairing, which this switch doesn’t touch. Unpair it to stop that. · [Unpair]
- Chat error for a free-tier daily cap (`lib/chat-errors.ts`, new kind `daily_limit`): That's today's free limit. AI is back when it resets at {7 am}.

## 3. State rules

Inputs: `phase`, `available`, `model`, `openclaw` (from `GET /api/ai/connection`) and the new
`aiHidden` (`user_settings.ai_hidden`, read at sign-in with the rest of the profile).

| Capability | Rule |
|---|---|
| `askInvite` (unlit "Set up AI") | `phase === 'ready' && available && !model && !openclaw.gateway && !openclaw.pluginChat && !openclaw.agent && aiHidden === false` |
| `askFix` (unlit "Fix AI") | `phase === 'ready' && available && modelNeedsAttention && !canChat && aiHidden === false` |
| lit key, Ask column, `canChat` | as today, and additionally `aiHidden === false` |
| nothing | `phase !== 'ready'` (unknown or error), or `available === false` (no `MODEL_KEYS_ENCRYPTION_KEY`), or `aiHidden === true` |

- **When the key shows.** Desktop header, under exactly one of `canChat`, `askInvite` and `askFix`.
  It never shows while the answer is unknown, so a slow or failed status read never flashes an
  invitation. On the phone the header has no key. Instead, the mode switcher gets the "Set up AI ·
  Optional" row under the same rule.
- **When it lights.** Only with `canChat`, meaning something answers. The unlit plate shows no lime
  anywhere: no lime tiles, no rim light, no glow. So there is no dimming question, and the lime
  rule is untouched.
- **The "Set up" note.** It shows until the setup home has been opened once, then turns into the
  chord. This is recorded server side as a new nudge id, `ask-setup-seen`, in
  `dismissed_nudges`, so it counts once across devices. See open question 5.
- **Not now** writes only `onboarding_completed`. The key stays unlit until something connects or
  No AI is chosen (open question 3).
- **The kept question.** `?` with text and nothing connected stores
  `{ text, at }` in sessionStorage (`dsul-ask-pending`). This survives the same-tab OpenRouter
  round trip. "Clear" removes it. When `canChat` turns true it is sent exactly once, then removed.
  With a kept question, a paste does not auto-send: the button reads "Connect and ask" and the
  consent line sits right above it.
- **The check.** Pasting runs a check before anything is saved: one test call capped at one
  output token. Failures come back typed: `key_rejected`, `wrong_provider` (the prefix is
  checked first on the client), `no_credit`, `daily_limit`, `region`, `network`. The key stays in
  the field on the client only, and nothing ever sends it back to the browser. "Working" in the
  pill always means a model answered a test question.
- **Prefix detection** (pure, client side): `AIza` → Gemini, `sk-ant-` → Anthropic, `sk-or-` →
  OpenRouter, `sk-` / `sk-proj-` → OpenAI. A detection is only a guess: the test call decides.
- **Success** replaces the card in place, lights the header and the key, turns the previews into
  live rows, and shows the composer with the catalog model name. The one-time notice appears on
  the next open only.
- **No AI, thanks** (tour, column foot, Settings) writes `ai_hidden = true` for the account.
  - What it hides, on every device:
    - the key, lit or unlit;
    - Ask's column and the Ask tab;
    - Ctrl+J (it does nothing, and stays reserved so the browser does not take it);
    - the dock's `?` AI row (`?` becomes plain text, as today with no AI);
    - every AI row in Ctrl+K;
    - the switcher row;
    - plan suggestions and Break it down;
    - the settings no-results "Ask AI" button;
    - the tour's step-4 AI card (a replay says "AI stays off");
    - every future moment offer.
  - What it does not touch: the saved key in `model_connections`, the OpenClaw pairing and the
    agent API, webhooks, transcripts, and the device-local chat target (`chooseChatTarget` stays
    the only path that wipes transcripts). It is a pause, not a delete. The AI-off card says what
    is still connected.
  - Undo (strip, about 5 s) writes `ai_hidden = false`. The Settings switch does the same later.
- **The Settings switch.** While nothing is connected, the "Use AI in dsul" row shows a quiet
  "No AI, thanks" button instead of a lit switch (visual fixes 15 and 8). The switch appears
  once something is connected or AI is off.
- **Daily limit.** A provider 429 marked as a daily quota sets
  `model_connections.limited_until`. The connection API returns it as `model.limitedUntil`. The
  pill and the chat error show it in the user's own time zone. If the provider gives no reset
  time, they say "back tomorrow". A connection over its limit keeps the key lit, because it is
  connected and comes back by itself. The chat answers with the `daily_limit` copy.
- **The streak toast** mounts with `enabled={extReady && streaksOn && !showTour && hasHabit}`.

## 4. Build plan, in PRs

1. **Ships alone, no AI.**
   - Gate the streak nudge: `!showTour && hasHabit` at `components/shell/app-shell.tsx:716`.
   - Settings search: add `connect`, `set up`, `sign in`, `api`, `ai` to the `beacon.apiKey`
     keywords (`lib/settings/manifest.ts` around 1420). "connect" finds the form today only by luck.
   - Remove the Settings button from the connected step-4 card (C6, `onboarding-tour.tsx`
     around 737 and 782).
   - Retitle the no-AI card "AI, if you want it".
   - Tests: `onboarding-tour-ask.test.tsx:121-129`, `settings-manifest.test.ts`,
     `nudges.test.ts`.
2. **Migration and gate.**
   - `058_ai_hidden.sql`: `alter table public.user_settings add column if not exists ai_hidden
     boolean not null default false;` and `alter table public.model_connections add column if
     not exists limited_until timestamptz;`. It is idempotent and replays on an empty database.
     `model_connections` stays service-role only.
   - `lib/user-profile.ts` reads `ai_hidden`.
   - `lib/ai-registry.ts` takes `aiHidden` and returns `askInvite` and `askFix`, fail-closed in
     `NO_AI`.
   - Tests: `ai-registry.test.ts` (new truth-table rows), `ai-routes-security.test.ts` (limitedUntil
     only, never the key).
3. **The key and the column.**
   - `AskMark` gets `lit={false}`, which draws neutral tiles.
   - `AskOpener` renders for `askInvite` and `askFix`, using the same plate, the word and the
     note. The header-fit budget must cover the longer word.
   - Ctrl+J opens the column, which renders the setup home or the fix home while `!canChat`.
   - Tests: `ask-key.test.tsx` (the unlit mark paints no accent), `ask-opener.test.tsx`,
     `ai-gating-desktop.test.tsx:299` (Ctrl+J opens setup when invited) and `:315` (Ask mounts as
     setup home when invited, still nothing when hidden), e2e `rail.spec.ts`.
4. **Connect V1 and server checks.**
   - One `ConnectAI` component (key card, folds, facts) used by the column, the phone tab and the
     pane.
   - Check-before-save on `POST /api/ai/connection`, with typed failure kinds and a per-user rate
     limit on checks.
   - Prefix detection lib.
   - The `daily_limit` kind in `chat-errors.ts`.
   - The OpenRouter return seals a closed enum `r: 'settings' | 'home'` in the PKCE cookie
     (`lib/ai-server/pkce.ts`) and rejects unknown values.
   - The `/settings/ai` alias route.
   - Tests: `model-connection-panel.test.tsx`, `ai-pkce.test.ts`, `ai-routes-security.test.ts`,
     `no-beacon-copy.test.ts`, and the AI server boundary test.
5. **Doors.**
   - The dock's `?` row and the sessionStorage question.
   - A Ctrl+K `ai.setup` command. Add the new id and never rename the old ones, because the frozen
     shortcut test pins them.
   - The phone switcher row, and AskMark in place of Sparkles.
   - Tests: `ai-gating-desktop.test.tsx:237`, `:251` and `:287` (they flip to "offers Set up AI"
     while invited and stay as they are while hidden), `command-bar-ask.test.ts`,
     `ask-tab.test.tsx`, `ai-gating-mobile-item.test.tsx` (three surfaces while invited, two while
     hidden), e2e `ask-mobile.spec.ts`.
6. **The tour.**
   - The new step-4 card spotlights the key (desktop) or the mode card (phone).
   - Openers come from a pure selector over `buildChatOpeners`.
   - **Set up AI** completes the tour and opens the column. **Not now** gets the completion
     toast's new description. **No AI, thanks** writes `ai_hidden` and shows the undo strip.
   - Tests: `onboarding-tour-ask.test.tsx`.
7. **The Settings → AI pane.**
   - The connect designer's pane with the fixes, the Use AI row, the pills, the fix and limit
     states, and the AI-off card.
   - A settings record for the switch, `beacon.useAi`: new and permanent, under the existing
     `beacon.*` id family.
   - Tests: `settings-manifest.test.ts`, `model-connection-panel.test.tsx`, e2e
     `settings-page.spec.ts`.
8. **Phase 2.** Moments' Break it down offer, gated on `askInvite`, with one ✕ that is a nudge id.

## 5. Tests that must change (from the engineering judge)

- `onboarding-tour-ask.test.tsx:121-129`
- `ai-gating-desktop.test.tsx:237`, `:251`, `:287`, `:299`, `:315`
- `ai-gating-mobile-item.test.tsx`
- `ask-key.test.tsx`
- `ask-tab.test.tsx`
- `ask-opener.test.tsx`
- `command-bar-ask.test.ts`
- `model-connection-panel.test.tsx`
- `ai-registry.test.ts`
- `settings-manifest.test.ts`
- `nudges.test.ts`
- `ai-pkce.test.ts`
- `ai-routes-security.test.ts`
- `no-beacon-copy.test.ts`
- e2e `rail.spec.ts` and `ask-mobile.spec.ts`

## 6. Risks

- **Google's free tier is the lead path.**
  - It is not offered in every country, and Google changes it without notice. Its terms let
    Google use free-plan data, which "What’s sent" says plainly.
  - A `region` failure needs its own copy, pointing to "I already use…".
  - The `gemini-flash-latest` alias can move. Names must come from the catalog (`model_meta`).
- **The check endpoint is a key oracle.**
  - It needs rate limiting per user and must never log or echo the key.
  - An `AIza` prefix also matches other Google Cloud keys. Only the test call is the truth.
- **A permanent unlit key** is chrome for people who ignore AI without choosing No AI. This is
  open question 3.
- **"Set up AI" is wider than "Ask".** The header-fit fallback must handle the longer word at
  1100px and in every layout. Notebook was drawn; Writer and the Notepads were not.
- **No AI does not stop OpenClaw.** The agent API reads the planner through its own pairing. The
  AI-off card must say so whenever a pairing exists.
- **The kept question.**
  - It could be lost if a sign-in opens a new tab, as on iOS standalone. That is why the phone
    and PWA lead with the Gemini key.
  - It must send exactly once, even if the connection status flaps.
- **Test churn.** Several suites assert today's "no AI means no Ask" rule. They now need three
  cases: invited, hidden and connected.
- **iOS native is out of scope.** It keeps "Ask arrives later". No connect form ships there before
  a consent screen exists.

## 7. Open questions for Kirby (each with the default I'd ship)

1. **Where does setup open?** In Ask's column, or in a dialog?
   **Default: the column.** It is where Ask will be, so success needs no navigation.
2. **Which free path leads?** The Gemini key, or OpenRouter sign-in?
   **Default: the Gemini key.** It works in the desktop app and the PWA. OpenRouter sign-in has
   not been run end to end from a home-screen app.
3. **Does the unlit key stay after "Not now"?**
   **Default: yes, until something connects or you choose No AI.** It costs one plate in the
   corner, and No AI removes it.
4. **May the tour end with Ask open after a successful connect?**
   **Default: yes, for that session only.** You asked for it by pressing Set up AI. The column's
   open state is not persisted, so the next load starts closed, as today.
5. **The "Set up" note.** Read literally, the key says "Set up AI  Set up" until the first visit
   (F03, F04).
   **Default: drop the note and show Ctrl+J from day one.** This also drops the `ask-setup-seen`
   nudge id. The word "Set up AI" already does the note's job.

## 8. What is reused and what is new

- **All 26 frames are new.** They were drawn on the real build at :3160 with
  `final/work/shoot.js`, `pane.js`, `kit.js` and `compose-keys.js`.
- **Copied from the other designers:**
  - from the ask designer: the key and column injection, the dock and launcher methods, the
    fresh-account tour walk, and the phone helpers;
  - from the connect designer: `ui.js`, for its CSS and the pane's structure;
  - from moments: the undo-strip markup.
- **None of the connect designer's `s-*.png` were copied.** Each needed a fix: the letter tiles,
  the globe on both chips, the resting focus ring, the lime switch while not set up, "Alza", the
  limit pill, the upsell, and "every device".

**Not drawn:**
- the key's light travelling in once (frames are static);
- the OpenRouter pages and the return trip;
- the kept question being answered after connect (F12 shows the case with no question);
- Settings → AI and the setup home in Writer and the Notepads;
- the settings search results;
- the phone pane;
- the iOS app;
- the phase-2 offer.

F20b is drawn over a working connection, because the real column does not mount while the
connection is failing. Building that is part of PR 3.
