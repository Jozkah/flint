# Consolidation of every Flint branch into `main`, 2026-09-08

Every branch that existed on the `origin` (private) remote is now an ancestor of
`main`. This is the record of how each one was treated and why.

## The shape of the problem

`main` shares no commit with any other branch. It is an orphan history of 50
commits whose root, `ff91aaf58` (2026-09-07), already carries a complete
2611-file tree — a squashed snapshot, not a fork point. `git merge-base
origin/main origin/feat/local-only` returns nothing at all.

That makes the ordinary reading of "merge the branch in" the wrong one. An
ordinary merge of two unrelated histories collides on every one of ~2600 files
as an add/add conflict, and resolving 2600 conflicts by hand is not a
consolidation, it is a rewrite with a merge commit on top.

It is also the wrong direction. `main` is the *newest and richest* tree, not the
oldest: measured against it, the branches are net deletions of 36,000 to 64,000
lines. What they hold that `main` does not is, with the exceptions listed below,
precisely what the local-only work deliberately removed:

| Removed on `main`, still present on the old branches | Files |
| --- | --- |
| `extensions/download-extension/` | 10 |
| `src-tauri/src/core/updater/`, `core/cli/updater.rs` | 6 |
| `web-app/src/services/updater/`, `hooks/useAppUpdater`, `AppUpdater` dialog | 8 |
| `web-app/src/services/analytic/`, `AnalyticProvider`, `PromptAnalytic`, `AnalyticConsent` | 7 |
| `web-app/src/routes/hub/`, `remoteModelCatalog`, `useModelSources`, `ModelDownloadAction` | 15 |
| `core/cli/telemetry.rs`, `useJanBrowserExtension` | 4 |

Merging those trees in would reintroduce telemetry, the automatic updater, the
Flint model hub and runtime model downloading — the four things the task forbids.

## The treatment

Each branch was merged with `git merge --no-ff -s ours
--allow-unrelated-histories`. That is the task's "unique history whose tree is
obsolete" path: the branch's commits become ancestors of `main`, the integration
tree is unchanged, and no obsolete file returns. The integration tree was
verified byte-identical before and after all sixteen merges.

Only four merges were needed. The branches share history *with each other* — they
all descend from the same upstream Flint trunk — so merging the four newest tips
made the other twelve ancestors as well.

| Branch | Original tip | Ancestor of `main` | Treatment |
| --- | --- | --- | --- |
| `claude/windows-build-consolidation-nttrud` | `3554f6a03` | yes | identical to `main` |
| `feat/agent-harness-phase-1` | `6f5b1fcd8` | yes | ancestry-preserving merge |
| `feat/agent-harness-phase-3` | `dd2ca0a45` | yes | ancestry-preserving merge |
| `feat/cowork-background-tasks` | `7c48d71aa` | yes | ancestor of the above |
| `feat/cowork-code-workspace` | `c2522cd81` | yes | ancestor of the above |
| `feat/cowork-file-workflow` | `b306d8553` | yes | ancestor of the above |
| `feat/harness-integration` | `71ad4d40a` | yes | ancestry-preserving merge + salvage |
| `feat/jan-complete-workspace` | `1006dd700` | yes | ancestor of the above |
| `feat/local-only` | `559b744a6` | yes | ancestor of the above |
| `feat/local-only-completion` | `3554f6a03` | yes | identical to `main` |
| `feat/model-organization` | `332a2986a` | yes | ancestor of the above |
| `feat/per-chat-model-config` | `b8b7c1d90` | yes | ancestor of the above |
| `feat/temporary-chat-lifecycle` | `13bb21523` | yes | ancestor of the above |
| `fix/cowork-runtime-evidence` | `7d1c886a2` | yes | ancestor of the above |
| `rescue/uncommitted-2026-09-08` | `e74960a29` | yes | ancestry-preserving merge + salvage |
| `test/cowork-transport-evidence` | `586770466` | yes | ancestor of the above |
| `wip/local-only-model-downloads` | `10dddb513` | yes | patch-equivalent, ancestor of the above |

## What was salvaged into the tree

**`rescue/uncommitted-2026-09-08` (`e74960a29`).** Both files taken. The
`formatDate` UTC fix is correct against `main`'s own tests, which assert the UTC
calendar day (`2023-12-25T15:30:45Z` is expected to render as Dec 25) while the
function formatted in local time. `docs/COWORK_REWORK_PLAN.md` exists nowhere
else in the history.

**`feat/harness-integration` (`71ad4d40a`).** Taken:

- `scripts/agent-harness/*` — the registry validator and renderer. `main` carries
  `docs/agent-harness-features.json` but had no tooling for it, and the markdown
  had drifted to claiming 99/45/66 where the JSON says 91/35/84.
- `scripts/check-tauri-resources.mjs` and `web-app/src/__tests__/tauriResources.test.ts`
  — the bundle-resource preflight, which is the foundation the new sidecar
  integrity gate sits beside.

## What was deliberately not brought forward

**`CoworkPlanToggle.tsx`** (on 7 branches). Superseded. `main` replaced the
boolean `planMode` with a three-valued `mode` (`auto` / `ask` / `review`) and
migrates `planMode` away as a legacy field — `web-app/src/lib/coworkMode.ts`
reads `planMode: true` as `review` and `planMode: false` as `auto`, and
`useCoworkSessions.ts` clears the field on write. Restoring a toggle for a field
the tree is migrating off would be a regression, not a recovery.

**`activityRecorder.ts`, `ActivityTimeline.tsx`, `secretRedaction.ts`** (on
`feat/harness-integration` only). Superseded by `main`'s richer
`coworkActivityRecorder.ts`, `coworkActivityTimeline.ts`,
`tauri-plugin-agent-tools/src/activity.rs` and `.../src/secrets.rs`.

**`wip/local-only-model-downloads` (`10dddb513`).** Patch-equivalent. Its single
commit removed `catalog.jan.ai` screenshots and vendor links from the AppStream
metadata, dropped the download-extension paragraph from
`extensions/CONTRIBUTING.md`, and replaced two assertions that mocked deleted
methods. Every one of those is already true on `main`: `catalog.jan.ai` appears
zero times in `flatpak/ai.jan.Jan.metainfo.xml`, `extensions/CONTRIBUTING.md`
does not mention the download extension, and `pullModelWithMetadata` appears
nowhere in `SetupScreen.test.tsx`. The commit differs by SHA and by nothing else.

## Unique work preserved in history but not ported

These are real, unfinished features that exist only on older branches. They are
reachable from `main` and recoverable from the archive tags, and they were not
ported because each needs backend support `main`'s tree does not carry — porting
half of one would be worse than leaving it where it can be read.

| Work | Branch | Why not ported |
| --- | --- | --- |
| `web-app/src/lib/coworkRepoMap.ts` | `feat/harness-integration` | Needs `project_browse::build_map` and a `projectMap` binding, neither of which exists on `main`. The `repositoryMap` readiness category is still the always-zero placeholder this was written to fill. |
| `src-tauri/harness/` crate | `feat/harness-integration` | A separate crate (envelope, event, identity, state, secrets) with no call sites on `main`. |
| `core/agent/{search,index,impact,health,project_kind}.rs`, `recorder.rs`, `progress.rs`, `cli/runs.rs` | agent-harness phases 1 and 3 | Phase-3 repository-intelligence work against an agent module that has since been restructured. |
| `tools/secretguard.rs`, `tools/gitrisk.rs`, `docs/security/secret-corpus.json` | `feat/harness-integration` | Depends on the harness crate above. |

## Recovery

Annotated tags exist locally for all sixteen tips under
`archive/pre-consolidation/<sanitized-branch-name>`. Pushing them to `origin`
was refused with HTTP 403 — this session's credential can write `refs/heads/*`
but not `refs/tags/*`. Since every tip is an ancestor of `main`, no commit
depends on the tags for its survival; they are a convenience, and can be pushed
by anyone with ordinary tag-write access:

    git push origin 'refs/tags/archive/pre-consolidation/*'
