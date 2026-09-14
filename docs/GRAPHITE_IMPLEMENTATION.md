# Flint Graphite Studio: implementation handoff

This document records the production implementation of the Flint Graphite Studio
design. It supersedes the visual direction described in
`docs/ATELIER_IMPLEMENTATION.md` (ivory surfaces, Newsreader headings); that
document's feature-preservation map and contracts still apply. Functional
behaviour is defined by `docs/IMPLEMENTATION_BASELINE.md`,
`docs/BEGINNER_WORKFLOWS_HANDOFF.md` and the feature registry
(`docs/agent-harness-features.json`, 211 items).

## Design reference

- Approved reference: Flint Graphite Studio artifact
  `https://claude.ai/code/artifact/96229b22-48ea-4257-b729-3cd24fb15b6c`,
  published version `1789377038-712e` (the latest version when implementation
  started on 2026-09-14).
- The artifact defines appearance and interaction intent only. Its demo data
  and simulated behaviour were not carried into the app.

## Design system

| Area | Where | Notes |
| --- | --- | --- |
| Tokens | `web-app/src/index.css` | Dark (neutral charcoal, no hue): sidebar `#141414`, pane `#191919`, raised `#1F1F1F`, popover `#242424`, secondary pane `#161616`, rail `#0F0F0F`. Light (cool mineral greys): sidebar `#ECEEF1`, pane `#F7F8F9`, raised `#FFFFFF`, secondary pane `#EFF1F3`, rail `#E3E6EA`. Semantic (`success`, `warning`, `destructive`) and diff (`diff-add`, `diff-del`) colours are separate tokens and never follow the accent. Tertiary text (`muted-foreground`) is at least 4.5:1 on every surface; translucent text variants were removed. |
| Typography | `web-app/src/main.tsx` | Geist and Geist Mono (`@fontsource-variable`), bundled locally. `font-display` and `font-studio` resolve to Geist; there is no serif. Conversation text uses a reading width token (`--read-w`). |
| Shell geometry | `index.css`, `components/shell/*`, `containers/HeaderPage.tsx` | Rail 64px, context bar 46px, status bar 26px, inspector 328px. |
| Accent | `lib/accent.ts`, `containers/AccentSettings.tsx` | Presets Vermilion (default), Ink, Moss and Slate blue, custom hex with validation, reset, persistence. Derived text and indicator colours meet contrast against the pane, raised, sidebar and secondary surfaces. Existing saved accents keep working (Slate blue is additive; no store migration needed). |
| Selection vs activity | `containers/StatusChip.tsx` (`WorkStatus`) | The accent marks selection and one primary action per working context. Running, queued, waiting, blocked, needs you, done, failed and cancelled use an icon and a word; running spins only when motion is allowed. |
| Primitives | `components/ui/*` | Compact controls (buttons `h-8`, inputs `h-8`, sidebar rows `h-8`) with 44px targets on coarse pointers; destructive stays outlined; dialogs are bottom sheets on phones. |

## Dark palette refinement

After the lanes were merged, the dark theme's blue-tinted neutrals were replaced
with neutral charcoal, one step darker, using Claude Code's dark appearance as
the reference. Only shared `.dark` tokens in `index.css` changed (plus the
matching `ACCENT_SURFACES.dark` entry in `lib/accent.ts`, which the accent
contrast derivation and its stylesheet test use). The light theme, accent
presets and custom accents, semantic status colours, diff colours and chart
series colours other than the neutral `chart-4` are unchanged.

| Token | Before | After |
| --- | --- | --- |
| `background` | `#1B1C1F` | `#191919` |
| `card` | `#222327` | `#1F1F1F` |
| `popover` | `#26282C` | `#242424` |
| `secondary`, `muted` | `#26282B` | `#232323` |
| `accent` (hover/selected fill) | `#2A2C30` | `#282828` |
| `border` | `#2C2E33` | `#2C2C2C` |
| `line-strong` | `#3E4147` | `#3C3C3C` |
| `input` | `#737880` | `#767676` |
| `sidebar` | `#161719` | `#141414` |
| `sidebar-accent` | `#24262A` | `#222222` |
| `sidebar-border` | `#2A2C30` | `#282828` |
| `rail` | `#111214` | `#0F0F0F` |
| `rail-hover` | `#1D1E21` | `#1B1B1B` |
| `rail-active` | `#27292D` | `#252525` |
| `sunken` | `#18191B` | `#161616` |
| `code` | `#131416` | `#111111` |
| `foreground` and `*-foreground` | `#E9EAEC` | `#EAEAEA` |
| `ink-2` | `#B7BBC1` | `#BABABA` |
| `muted-foreground`, `rail-muted` | `#A0A5AC` | `#A3A3A3` |
| `chart-4` (neutral series) | `#8C9198` | `#8F8F8F` |

Computed contrast after the change: primary text at least 12.25:1, `ink-2` at
least 7.6:1 and `muted-foreground` at least 5.84:1 on every dark surface
(before: 11.62, 7.25, 5.64). Surface steps are kept: card on pane 1.07:1,
border on card 1.18:1, strong line on card 1.49:1, input outline on card
3.63:1.

## Implementation lanes

The redesign was built on `feat/graphite-integration` from `fork/main`
`185a06f7e`, as a shared foundation followed by five parallel lanes, each
merged after review:

| Lane | Branch | Scope |
| --- | --- | --- |
| Foundation | `feat/graphite-integration` | Tokens, fonts, rail, header, status bar, primitives, accent presets, work status |
| Chat | `lane/graphite-chat` | Conversation, composer, message actions, tool rows and reasoning trace, Details inspector ("What Flint is using"), split conversations, home, collections, workspace sidebar |
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

Numbers are recorded in the PR description. Checks run
on the combined revision: JavaScript gate (typecheck, lint, production web
build, web, core, extension and script tests, registry validation and render,
local-only guard, diff check), Rust gate (desktop and CLI library tests,
binaries, golden repositories, clippy, agent tools, LSP, TLS, semantic), and
real-app journeys on the `cowork-smoke` build (27 of 27 after the dark palette
refinement: shell geometry, chat send and regenerate, Details inspector, reading
width, split panes and drafts, Cowork output and changes, wide Models view, dark
and light rendered contrast, search focus return, focus ring, accent presets,
invalid hex, custom accent persistence and reset, reduced motion, 200% text
zoom, viewports 1440x900, 1280x720, 1024x768, 768x1024, 390x844, 360x800 and
844x390, phone drawer and composer).

Screenshots are kept outside the repository in
`C:\Users\Jozkah\Desktop\JAN-Graphite-Screenshots` (`journeys/` for the
journey run, `dark-palette/before` and `dark-palette/after` for matching dark
theme captures with rendered-contrast reports).

## Known limitations

- The real-provider discussion-rooms lane was rerun on the frozen
  `feature/discussion-rooms` tip `fa3585d0b` (11 of 11, plus the keep/restart
  pair); the rooms runtime is unchanged by the redesign.
- Phone and tablet layouts were checked with viewport emulation in the app's
  WebView, not on phone hardware.
