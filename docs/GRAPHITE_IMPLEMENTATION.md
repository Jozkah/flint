# JAN Graphite Studio: implementation handoff

This document records the production implementation of the JAN Graphite Studio
design. It supersedes the visual direction described in
`docs/ATELIER_IMPLEMENTATION.md` (ivory surfaces, Newsreader headings); that
document's feature-preservation map and contracts still apply. Functional
behaviour is defined by `docs/IMPLEMENTATION_BASELINE.md`,
`docs/BEGINNER_WORKFLOWS_HANDOFF.md` and the feature registry
(`docs/agent-harness-features.json`, 211 items).

## Design reference

- Approved reference: JAN Graphite Studio artifact
  `https://claude.ai/code/artifact/96229b22-48ea-4257-b729-3cd24fb15b6c`,
  published version `1789377038-712e` (the latest version when implementation
  started on 2026-09-14).
- The artifact defines appearance and interaction intent only. Its demo data
  and simulated behaviour were not carried into the app.

## Design system

| Area | Where | Notes |
| --- | --- | --- |
| Tokens | `web-app/src/index.css` | Dark: sidebar `#161719`, pane `#1B1C1F`, raised `#222327`, secondary pane `#18191B`, rail `#111214`. Light (cool mineral greys): sidebar `#ECEEF1`, pane `#F7F8F9`, raised `#FFFFFF`, secondary pane `#EFF1F3`, rail `#E3E6EA`. Semantic (`success`, `warning`, `destructive`) and diff (`diff-add`, `diff-del`) colours are separate tokens and never follow the accent. Tertiary text (`muted-foreground`) is at least 4.5:1 on every surface; translucent text variants were removed. |
| Typography | `web-app/src/main.tsx` | Geist and Geist Mono (`@fontsource-variable`), bundled locally. `font-display` and `font-studio` resolve to Geist; there is no serif. Conversation text uses a reading width token (`--read-w`). |
| Shell geometry | `index.css`, `components/shell/*`, `containers/HeaderPage.tsx` | Rail 64px, context bar 46px, status bar 26px, inspector 328px. |
| Accent | `lib/accent.ts`, `containers/AccentSettings.tsx` | Presets Vermilion (default), Ink, Moss and Slate blue, custom hex with validation, reset, persistence. Derived text and indicator colours meet contrast against the pane, raised, sidebar and secondary surfaces. Existing saved accents keep working (Slate blue is additive; no store migration needed). |
| Selection vs activity | `containers/StatusChip.tsx` (`WorkStatus`) | The accent marks selection and one primary action per working context. Running, queued, waiting, blocked, needs you, done, failed and cancelled use an icon and a word; running spins only when motion is allowed. |
| Primitives | `components/ui/*` | Compact controls (buttons `h-8`, inputs `h-8`, sidebar rows `h-8`) with 44px targets on coarse pointers; destructive stays outlined; dialogs are bottom sheets on phones. |

## Implementation lanes

The redesign was built on `feat/graphite-integration` from `fork/main`
`185a06f7e`, as a shared foundation followed by five parallel lanes, each
merged after review:

| Lane | Branch | Scope |
| --- | --- | --- |
| Foundation | `feat/graphite-integration` | Tokens, fonts, rail, header, status bar, primitives, accent presets, work status |
| Chat | `lane/graphite-chat` | Conversation, composer, message actions, tool rows and reasoning trace, Details inspector ("What JAN is using"), split conversations, home, collections, workspace sidebar |
| Cowork | `lane/graphite-cowork` | Session header, plan strip, output and changes, per-hunk review bar, checkpoints and recovery dialogs, emergency stop, evidence-based verification summaries |
| Agents and models | `lane/graphite-agents-models` | Tasks, team reviews, child approvals, providers, model fit and compatibility, model picker and model dialogs, wide data views |
| Library and system | `lane/graphite-library-system` | Library list and inspector, system monitor, log viewer, search and command palette, onboarding, status bar, toasts, global error |
| Settings | `lane/graphite-settings` | Settings shell and groups, Appearance, Permissions, approval prompt, Memory, MCP, plugins, skills and the remaining settings pages |

Also integrated: `feature/discussion-rooms` at `fa3585d0b` (contains
`feature/session-messaging` at `623b0a29f`): cross-session messaging, the
`stop_session` tool and multi-model discussion rooms, restyled to Graphite.

## Functional changes made during the redesign

- Verification summaries (`lib/coworkRunOutcome.ts`, `CoworkRunSummary.tsx`,
  `locales/en/results.json`) are derived from recorded results: a check passes
  only when it completed with exit code 0. The summary says "Automated tests
  passed." and adds "Visual and end-to-end behaviour have not been checked."
  only when no end-to-end or screenshot verification was recorded.
- Library rows open a preview or the source session in one click, and an
  inspector shows details; no delete action was added.
- Log views gained search, a level filter and a line count (`lib/logFilter.ts`).
- The approval prompt lists Deny first so keyboard order matches focus.

## Verification

Recorded in the final report for the merge; see the PR description. Checks run
on the combined revision: JavaScript gate (typecheck, lint, production web
build, web, core, extension and script tests, registry validation and render,
local-only guard, diff check), Rust gate (desktop and CLI library tests,
binaries, golden repositories, clippy, agent tools, LSP, TLS, semantic), and
real-app journeys on the `cowork-smoke` build.

## Known limitations

- The real-provider discussion-rooms run on the exact integrated SHA was not
  repeated (the provider host was unreachable); the rooms runtime is unchanged
  from the commit where that run passed.
- Phone and tablet layouts were checked with viewport emulation in the app's
  WebView, not on phone hardware.
