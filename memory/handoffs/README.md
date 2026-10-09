# Thread handoffs

One doc per piece of work that is in flight or waiting on Kirby: the goal, what shipped,
what is in progress (branches and PRs), what waits on Kirby, the next steps, and the key
files and artifact links. They are copies of the project's handoff folder
(`/mnt/project-files/handoffs/`, as of 2026-10-09) so a session on another account can pick
the work up from the repo alone.

| Doc | Work |
| --- | --- |
| [app-ai.md](app-ai.md) | The AI: bring your own model, Ask, AI setup |
| [ios-app.md](ios-app.md) | The iPhone app (SwiftUI, `ios/`) |
| [mobile-web.md](mobile-web.md) | Mobile web to match the iPhone app |
| [desktop-app.md](desktop-app.md) | The Electron desktop app |
| [blank-content-on-load.md](blank-content-on-load.md) | Skeletons on reload after the instant planner |
| [stale-braindump.md](stale-braindump.md) | Getting a stale braindump moving |
| [vacation-mode.md](vacation-mode.md) | Vacation mode |
| [youtube-plan.md](youtube-plan.md) | Kirby's YouTube plan set up in dsul |
| [right-click-menu.md](right-click-menu.md) | Tidying the right-click menu |

Paths inside the docs that pointed at the project folder now point here where the file was
copied. Claude artifact links (claude.ai/artifact/...) are kept as they were; they open for
the account that owns them.

## What was copied

Text sources only, next to the docs:

- `vacation-mode/`: plan.md and the mockup sources (`mockups/*.dc.html`, canvas.json).
- `braindump-ideas/`: brainstorm.md and the mock sources (`mocks/*.dc.html`, canvas.json).
- `mobile-web/`: round 1 sources, the round 2 and 3 prototype overrides, and the Vite
  `harness/` (scripts, stubs, config).
- `ios-app/`: the 063 SQL for the SQL editor, the board HTML sources
  (`mockups-*-source.html`, fonts.css), stack.md, and the cloud Swift toolchain scripts.
- `youtube-in-dsul/`: setup.md and setup-youtube.mjs (reads its agent key from the
  environment or pairs; no key is stored).
- `instant-planner/claude-md-additions.md` and `ai-setup/spec.md` (the AI setup spec).

None of this is built, linted or type-checked: `memory/` is excluded in `tsconfig.json`
and `eslint.config.mjs`. Scripts that name `/mnt/project-files/...` paths were copied
as they are.

## What stayed in the project folder only

- Screenshots, boards and films: every PNG and MP4 (mobile-web rounds and shots, iOS
  boards and `screens/`, instant-planner films, AI setup frames).
- Fonts (`*.woff2`) and anything under `node_modules/`.
- Large finished-work notes: the iOS briefs (`*-brief.md`, `item-detail-part2-design.md`,
  `expo-vs-swiftui*`, `generators/`, `wip/2f-a-paused.patch`) and the AI setup PR 7
  design, maps and build reports (`ai-vision/ai-setup/pr7/`).
