# Claude Code docs gap analysis for Flint

Date: 2026-10-20. Source: https://code.claude.com/docs/llms.txt (228 pages). Each page was fetched and checked against this repo by eight parallel readers; the lead reviewed their evidence files and spot-checked the top claims in code (`permissions.rs:70` drops unparseable rules via `filter_map`; `hooks.rs:712` sets `stdin(Stdio::null())`; `web.rs:20` `FETCH_MAX_CHARS = 40_000`; zero matches for `worktreeinclude` and for invisible-Unicode stripping outside fence defanging). Already-known areas (workflow tool, subagent fields, `spawn_session`, cross-session messaging gaps, worktrees) are not re-derived.

## 1. Summary

Flint already matches or beats Claude Code on permission rules, trust, sandboxing, retries, secrets, usage accounting, MCP basics, skills, checkpoints and cost caps (section 3). The gaps cluster in five places. (a) Hooks are the largest: command-only, no tool input on stdin, no decisions or context returned, `run-end` never fires and there is no Stop-style gate. (b) Safety polish: a mistyped `deny` rule is silently dropped, persistence paths (`.husky`, `.envrc`, shell rc) are not protected, invisible Unicode is not stripped, and the CLI sandbox can read `~/.ssh`. (c) Cheap context and prompt controls: `/compact` focus text, `/btw`, `!cmd`, `web_fetch` pagination, `.worktreeinclude`, plan-phase routing. (d) Headless/CI ergonomics: structured output, per-run prompt/tool/effort flags, safe mode. (e) Plugins and reviews: no update flow or SHA pin, one flat marketplace index, no one-command diff review. Ranking is value over effort; rows 1 to 3 are small fixes with outsized safety value.

## 2. Ranked improvements

| # | Feature | Docs page | What Claude Code does | What Flint has today | Value | Effort | Risk / notes |
|---|---|---|---|---|---|---|---|
| 1 | Warn on invalid or ineffective permission rules | /errors, /permissions | Reports skipped rules (malformed, unknown tool, path rule on a tool that ignores it, unsafe `*` placement). | `src-tauri/plugins/tauri-plugin-agent-tools/src/permissions.rs:70` `filter_map(ResourceRule::parse)` discards bad rules with no warning, so a typo in a `deny` removes that deny. | high | S | Surface in `flint doctor` and the permissions UI; fail closed for deny typos. |
| 2 | Protected persistence paths for writes | /permission-modes | Never auto-approves writes to `.git`, `.husky`, `.vscode`, `.devcontainer`, shell rc, `.envrc`, `.npmrc`, `lefthook.*`, etc. | Gate hard-denies `.jan/agent/**` and `.git` internals only (`tools/gate.rs`). Nothing for hook, rc or CI-runner files. | high | S | Extend the denylist; ask even in auto mode. |
| 3 | Strip invisible Unicode from prompts and fetched content | /terminal-config, /security | Removes tag characters and bidi overrides from pasted prompts. | Nothing found (searched `u200b`, `u202e`, `E0000`, bidi in web-app/src and src-tauri). Only fence defanging in `web-app/src/lib/coworkPrompt.ts:363`. | high | S | Apply to pasted text, web_fetch results and tool output before the model sees them. |
| 4 | Hook upgrade: tool input on stdin, `if` filter, fire `run-end`, Stop-style gate, `additionalContext`, more events, `/hooks` viewer | /hooks, /hooks-guide, /agent-sdk/hooks | About 30 events, JSON stdin with `tool_input`, JSON stdout decisions (`additionalContext`, `updatedInput`), Stop hook blocks turn end with an 8-block cap, regex matchers. | `docs/HOOKS.md`, `plugins/tauri-plugin-agent-tools/src/hooks.rs:712` (stdin null): 6 events, `run-end` parsed but never fired, `session-start` refused, command type only, only a failed hook's message reaches the model. No hooks UI. | high | M | Stdin and decisions were withheld on purpose. Ship opt-in per hook; keep "hooks never grant permission". Copy the Stop block cap. |
| 5 | Built-in read-only shell allowlist | /permissions | `ls cat grep git status ...` run without a prompt in every mode, flag-aware. | Nothing found (searched `gate.rs`, `handlers.rs`, `web-app/src/lib`). Every Ask-mode shell call prompts. | high | S-M | Needs a flag-aware parser (`find -exec`, `git -c`). Largest prompt-fatigue win. |
| 6 | `/compact <focus>` and "summarize up to here" | /context-window, /commands, /checkpointing | Focus text steers the summary; a "Compact instructions" section is honored; rewind can summarize before or after a message. | `compact_command` takes no argument (`core/cli/tui.rs`); fixed `FULL_COMPACTION_SYSTEM_PROMPT` in `core/agent/compaction_policy.rs`; `CoworkRewind.tsx` only truncates. | med | S | Append user text to the summarizer prompt; range mode reuses `compaction.rs`. |
| 7 | `web_fetch` pagination and cache | /tools-reference | Reads up to 100k chars, reports unread amount, fetch next part; 15-min cache; cross-host redirects returned, not followed. | `plugins/tauri-plugin-agent-tools/src/tools/web.rs:20` 40k cap with truncation note; schema has only `url`. | med | S | Add `offset`; small local models often need page 2. |
| 8 | `/btw` side question | /interactive-mode, /best-practices | Tool-less answer from a copy of the thread, shown in an overlay, never enters history. | Nothing found (searched `btw`, `side question`, slash lists in `tui.rs`, `slashCommands.ts`). | med | S | One completion on a thread snapshot; works while a run streams. |
| 9 | Safe mode (start with all customizations off) | /cli-reference, whats-new w24 | `--safe-mode` / `--bare` disables CLAUDE.md, skills, plugins, hooks, MCP. | Nothing found (searched `safe-mode`, `--bare`, `--no-hooks` in `bin/flint.rs`, core/cli). | med | S | Pairs with `flint bug-report`; also gives reproducible CI starts. |
| 10 | Per-run CLI flags: append system prompt, allow/deny tools, effort, ephemeral | /cli-reference, /agent-sdk/configuration | `--append-system-prompt[-file]`, `--allowedTools`, `--effort`, `persistSession:false`. | `agent run` args (`bin/flint.rs` ~995-1070) have none; `--allow-tool` only on `schedule add`; RPC lacks effort and permission-mode switch (`core/cli/rpc.rs`). | med | S | Mirror the schedule allow-list freeze. |
| 11 | `.worktreeinclude` (copy gitignored `.env` into new worktrees) | /worktrees, /large-codebases | Gitignore-syntax file copies matching ignored files into every worktree. | Zero matches for `worktreeinclude` in src-tauri/src, plugins, web-app/src. Sparse and symlinked dirs exist (`core/agent/worktree.rs`). | med | S | New bit on a known area; common papercut (missing `.env`). |
| 12 | `!cmd` shell mode | /interactive-mode | Prefix runs a command directly; output joins the conversation. | Nothing found (searched `startsWith('!')` in web-app/src and core/cli). | med | S | Must run through the confined bash path, unlike Claude Code. |
| 13 | Plan-phase model routing (`role:plan`) | /model-config (`opusplan`) | Strong model while planning, fast model executing. | `[[routing]]` in `core/agent/routing.rs` matches `role:task/smol`, `agent:`, `model:`; no plan role. | med | S | Fits local-fast plus cloud-strong setups. |
| 14 | Execute plan in a fresh context | /permission-modes | Accepting a plan can clear the conversation and implement from the plan alone. | Plan accept keeps full history (`coworkPlanReview.ts`, `tui.rs apply_plan_review`). | med | S | Valuable on small context windows. |
| 15 | One-command review of the current diff with findings list | /code-review-local, /ultrareview, /code-review | Fresh-context reviewer, verify pass, ranked findings, `--fix`, `REVIEW.md` rules. | `reviewer`/`security` roles (`core/agent/roles.rs`), verification agent, `review.rs` (works through existing PR comments). No diff-review command or findings list. | high | M | Reuse hunk UI and consensus gates; inline diff comments (`CoworkDiffPanel.tsx` has none) as phase two. |
| 16 | Parallel MCP calls using `readOnlyHint` | /agent-sdk/custom-tools | Read-only MCP tools run concurrently. | `core/agent/upstream.rs execute_mcp_tool_calls` runs a sequential `for`; native tools already concurrent (`loop.rs`). | med | S | Honor the annotation only for trusted servers. |
| 17 | Plugin update, SHA pin, multi-marketplace | /plugins/install, /plugins/marketplace-reference | `plugin update`, auto-update, `ref`/`sha`/`sha256` pins, N marketplaces. | `core/agent/plugins.rs`: install/remove/enable only; one flat-JSON index; `InstallRecord` has `git_ref`, no SHA. Update is reinstall. | high | M | Record resolved SHA first (S); multi-marketplace later. |
| 18 | Structured final output (`--json-schema`) | /headless, /agent-sdk/structured-outputs | Validated `structured_output`, retry on mismatch. | Only the OpenAI-compat proxy route (`core/server/responses_route.rs`); nothing in `core/agent` or `core/cli`. | med | M | Needs a repair loop for small models. |
| 19 | Sandbox filesystem and credential allow/deny lists | /sandboxing | `allowRead/denyRead/allowWrite/denyWrite`, credential entries for `~/.ssh`, `~/.aws`. | Fixed shape plus `allow_home_read` all-or-nothing; CLI default lets sandboxed commands read `~/.ssh` (`docs/src/pages/docs/agent/permissions.mdx`). | med | M | Security-relevant for the CLI. |
| 20 | Usage and context cost attribution by skill, MCP server, plugin, subagent; unused-item report | /costs, /skills, /plugins/measure | `/usage` attributes spend, flags behaviours; `/skill-doctor` per-skill cost and use. | `core/agent/spend.rs` by model only; context report has a skills total; per-subagent stats only per session (`coworkSubagentStats.ts`). | med | M | Dispatch records already carry the data. |
| 21 | Monitor tool (stream watcher lines into the run) | /tools-reference, whats-new w15 | Each stdout event from a background watcher wakes the model. | `bash background:true` notifies only on finish (`loop.rs finished_background_jobs`); no per-line events. | med | M | Rate-cap matched lines. |
| 22 | MCP elicitation (form and URL) | /mcp, /hooks-guide | Server asks the user for input mid-call. | Zero hits for `elicit` across src-tauri, plugins, web-app, docs. | med | M | Reuse approval-card UI; more OAuth-in-tool servers appear. |
| 23 | Agent-managed schedules and in-session loop | /desktop-scheduled-tasks, /scheduled-tasks | Create or reschedule tasks from chat; `/loop` with model-chosen interval. | Schedules via Settings, CLI, TUI `/schedule` only; no agent tool; `Schedule` enum has no one-shot (`core/schedule/spec.rs`). | med | S-M | Agent-created unattended work needs an approval gate. |
| 24 | Advisor tool (stronger model consulted with full transcript) | /advisor | Cheap model calls a strong one before planning or finishing. | Nothing found (searched tool schema, `core/agent`, docs). | med | M | Good fit for a small local model plus optional cloud. |
| 25 | Subagent turn-limit returns partial output; resume finished subagent | /agent-sdk/subagents | Partial result kept; resume by id with full history. | `subagent.rs child_failure_text`: turn limit returns no answer; cancel discards partial work. | med | M | Overlaps subagent work already in flight; check before starting. |

Runners-up (details in the reader sections below): MCP `${VAR}` expansion and `headersHelper`; MCP `list_changed`; MCP spill-to-file for long results; skill `paths` and `context: fork`; domain-filtered network for sandboxed shell; PR auto-fix watcher and merge-when-ready; integrated terminal; computer-use safety tiers; keep-awake during runs; session recap; opt-in OpenTelemetry export; mTLS client certificates; custom status line; acceptEdits mode; rules on tool parameters; comment on approve; deep-link `project` parameter; plugin `.lsp.json`; `flint plugin validate`.

## 3. Already at parity or better

Evidence per reader (A: concepts, B: build-with, C: plugins, D: configuration, E: reference, F and G: Agent SDK, H: what's new).

### Reader A

- Agentic loop, plan mode, permission modes (Auto classifier / Ask / Review / bypass) | `src-tauri/src/core/agent/auto_mode.rs`, `plan.rs`, docs/FEATURES.md "Cowork: modes, scope and planning"
- Checkpoints + Esc Esc rewind, undo/redo turn | `web-app/src/containers/CoworkRewind.tsx`, `CoworkTurnUndo.tsx`, `src-tauri/src/core/agent/checkpoint.rs`, docs/src/pages/docs/agent/sessions.mdx
- Resume / fork (/fork, /tree, --fork-session), rename, session export, queue while working, steering | docs/src/pages/docs/agent/sessions.mdx, `src-tauri/src/core/agent/session_copy.rs`, `web-app/src/lib/coworkAutoTitle.ts`, `CoworkHeldInput.tsx`
- /context breakdown by category, proactive thresholds, microcompaction, rapid-refill breaker | docs/CONTEXT_COMPACTION.md, `src-tauri/plugins/tauri-plugin-agent-tools/src/context_report.rs`, `web-app/src/containers/CoworkContextBreakdown.tsx`; `/autocompact N` equivalent = Window(n)/Percentage override in `compaction_policy.rs`
- Auto memory (agent-written, file-based, reviewed before save; ranked retrieval) | docs/src/pages/docs/agent/memory.mdx, `src-tauri/plugins/tauri-plugin-agent-tools/src/memory/*`, `web-app/src/hooks/useMemoryProposals.ts` (Flint asks approval per write; CC saves silently - deliberate difference)
- CLAUDE.md / AGENTS.md / Flint.md loading, nested per-directory chain, /init | docs/FEATURES.md "Instruction files", `web-app/src/lib/claudeCompat.ts`, `src-tauri/src/core/agent/project.rs`
- /goal condition evaluator | `src-tauri/src/core/agent/goal.rs`, docs/src/pages/docs/agent/goals-and-todos.mdx
- Subagents in own context, forks, background agents, worktrees per agent | docs/FEATURES.md "Cowork: agents, teams and background work"
- Skills, slash commands, plugins, MCP (resources, OAuth), Claude Code import | docs/FEATURES.md "Tools, MCP, skills and plugins", `src-tauri/src/core/agent/cc_import.rs`
- Hooks (pre/post tool, batch, compact) + trusted-folder gating | docs/HOOKS.md
- Prompt library with variables (beyond CC's prompt-library page, which is static docs) | docs/PROMPT_LIBRARY.md
- Scheduled tasks: schedule presets + cron, Run now, history incl. skipped, per-task worktree, missed-run catch-up (once), OS scheduler entry | `web-app/src/containers/schedules/*`, `src-tauri/src/core/schedule/*`, docs/FEATURES.md "Scheduled tasks"
- Background tasks panel | `web-app/src/containers/CoworkBackgroundTasksPanel.tsx`
- Split view of two sessions | `web-app/src/routes/cowork.tsx` (CoworkSplitWorkspace), `web-app/src/containers/SplitConversation.tsx`
- Diff review per hunk, Changes panel, editable file pane, "Open in editor" | `CoworkDiffPanel.tsx`, `CoworkCodePanel.tsx`
- PR status + CI + fix failing check + resolve conflicts | `web-app/src/containers/PrBar.tsx`, `src-tauri/src/core/agent/github_pr.rs`
- Computer use (screenshot/click/type/key/scroll, exclusion regions, app allowlist, per-call approval) | docs/COMPUTER_CONTROL.md
- Browser tool for local pages + external-site consent, pointer | docs/FEATURES.md "Agent browser", `src-tauri/plugins/tauri-plugin-agent-tools/src/browser/*`
- Projects-style coordinator (Overview, parallel threads, PR per thread) | Campaigns: docs/CAMPAIGNS.md, `web-app/src/components/campaign/Board.tsx`
- Remote/mobile client (pairing, push via service worker, approvals from phone) | docs/MOBILE.md
- Usage/context ring, token + cost dashboard, cache reuse per turn | `web-app/src/components/TokenCounter.tsx`, `CacheReuseBadge.tsx`
- Retention/cleanup (archive 30 days, purge), plaintext-transcript controls, redaction | docs/FEATURES.md "Archive instead of delete", "Privacy and local-only"
- Non-interactive/headless runs with JSON/stream output | docs/FEATURES.md "The flint command line"
- @ mentions, image/PDF attachments, queued messages | docs/CHAT_MENTIONS.md, docs/FEATURES.md
- Interview-style questions to user (ask tool/card) | `web-app/src/containers/CoworkAskCard.tsx`
- Worktrees, `.worktreeinclude`-style copy not checked (other reader owns worktrees)

### Reader B

- /goal condition loop with fast evaluator, restart persistence | src-tauri/src/core/agent/goal.rs
- Claude Code project settings / hooks import (opt-in) | src-tauri/src/core/agent/cc_links.rs, cc_hooks.rs
- Cross-session messaging (list/send/wait/stop, loop guard, opt-out, rate limits) | docs/AGENT_MESSAGING.md, plugin session_mailbox.rs
- Subagent resume by id, completion notices, ask_parent/answer_subagent | docs/AGENT_MESSAGING.md "Subagents"
- Parallel/background subagents, concurrency cap (`max_parallel_subagents`), depth limits | src-tauri/src/core/agent/subagent.rs
- Agent teams: shared task board with dependencies, isolated checkouts, consensus gates | docs/FEATURES.md "Cowork: agents, teams and background work"
- Worktrees: managed per session/agent, sparse paths, symlink dirs, safe cleanup | src-tauri/src/core/agent/worktree.rs
- Scheduled tasks with cron, missed-run catch-up, OS entry, unattended deny-by-default | docs/FEATURES.md "Scheduled tasks", src-tauri/src/core/cli/schedule.rs
- Flint as an MCP server (`mcp serve`, stdio + loopback HTTP with bearer token) | src-tauri/src/core/cli/mcp_serve.rs
- MCP OAuth sign-in, trust bound to server config, lazy start + idle shutdown, stall cancel | src-tauri/src/core/mcp/oauth.rs, lazy.rs, stall.rs
- Skills: user-invocable / disable-model-invocation / allowed-tools / always | plugins/tauri-plugin-agent-tools/src/skills.rs
- Headless run, stream-json both directions, resume/continue/fork-session, budgets | src-tauri/src/bin/flint.rs, core/cli/mod.rs
- Deep link prompt prefill | web-app/src/lib/deepLinkPrompt.ts
- Large-repo basics: repo index, LSP, nested instruction files | docs/FEATURES.md "Coding intelligence and Git"

### Reader C

| feature | evidence file path |
|---|---|
| Plugin = dir of skills/commands/agents, conventional discovery, root SKILL.md single-skill plugin | src-tauri/src/core/agent/plugins.rs header L1-29 |
| Optional `.claude-plugin/plugin.json` manifest (name/description/version) | plugins.rs L15, L831, test `reads_claude_plugin_json_manifest` L2541 |
| Install from local folder / git URL / marketplace name, cancelable, staged then renamed into place, no code executed on install | plugins.rs (InstallCtx, STAGING_PREFIX, install_interactive), commands.rs agent_plugin_install / agent_plugin_install_cancel |
| Github `tree/main/plugins/<x>` URL parsing from anthropics/claude-plugins-official | plugins.rs tests L2479-2500 |
| Collection repos (several plugins in one repo): pick which to install | plugins.rs CollectionChoice / GitInstall::Collection |
| Scopes: project vs global, enable/disable per scope, remove | plugins.rs PluginScope, set_enabled_scoped, remove_plugin_scoped; commands.rs resolve_plugin_scope |
| Enable/disable without uninstall (`[plugins] disabled`) | plugins.rs L26-28, set_enabled |
| Marketplace search + browse UI, install-by-source form, details view | plugins.rs search_typed_scoped; web-app/src/containers/extensions/PluginsTab.tsx |
| Provenance record per install | plugins.rs INSTALL_RECORD_FILE, InstallRecord |
| Typed install errors with UI mapping | plugins.rs PluginErrorCode |
| Plugin skills namespaced `<plugin>:<skill>`, project skill shadows plugin skill | plugins.rs L161, skills.rs L396-412 |
| Import skills/plugins from `~/.claude` as live links, incl. running SessionStart/UserPromptSubmit hooks | src-tauri/src/core/agent/cc_import.rs, cc_links.rs, cc_hooks.rs |
| CLI plugin list/install/remove/search | src-tauri/src/core/cli/mod.rs L1157-1181 |
| Shell-command lifecycle hooks (project) | docs/HOOKS.md, plugins/tauri-plugin-agent-tools/src/hooks.rs |
| Language server client (definition/references/hover/diagnostics) | src-tauri/src/core/agent/lsp.rs |
| Local scripts in plugin only run under permission gate, executables listed in details | plugins.rs PluginDetails.executable_files |
| Shell-metacharacter / option-injection rejection in specs and refs | plugins.rs validate_spec L1107, validate_marketplace_entry L1527 |

### Reader D

| Feature | Evidence |
|---|---|
| Allow / ask / deny rules, deny wins, ask overrides allow, per-subject, per-resource patterns, Windows spellings, symlink-aware matching | `PLUGIN/permissions.rs`, `PLUGIN/resource.rs`, `PLUGIN/tools/gate.rs` |
| Standing approvals scoped to a folder or command prefix (stored outside the repo, never override hard denies) | `PLUGIN/scoped_rules.rs` |
| Project settings cannot loosen: untrusted folder drops loosening keys; workspace trust store | `AGENT/project.rs::drop_loosening_keys`, `PLUGIN/folder_trust.rs` |
| Machine/org policy a project cannot loosen, fail-closed on parse errors; managed-only MCP allowlists | `PLUGIN/org_policy.rs`, `AGENT/project.rs [mcp]` |
| Malformed agent.toml fails closed (read-only, offline) | `PLUGIN/policy.rs` |
| Permission modes: review (plan), ask, auto, bypass; plan mode read-only with plan review | `web-app/src/lib/coworkMode.ts`, `AGENT/plan.rs`, `TUI::apply_plan_review` |
| Unattended runs deny prompts by default (dontAsk-like), optional deferral | `AGENT/approval_flow.rs`, `AGENT/auto_mode.rs UNATTENDED_ENV` |
| Auto-mode rules (block taxonomy, allow, soft_deny, environment) plus optional model judge that can only deny | `AGENT/auto_mode.rs` |
| Destructive command detection incl. home/root deletes always ask, indirect forms (`eval`, `xargs rm`) | `AGENT/destructive.rs`, `PLUGIN/tools/gate.rs` ~L677 |
| Compound-command splitting, wrapper handling, injection-safe prefix grants | `PLUGIN/tools/cmdscan.rs`, `PLUGIN/scoped_rules.rs` |
| Deny-with-reason on approval prompts | `web-app/src/containers/CoworkChildApprovals.tsx` |
| Permissions page with grants, revoke, audit trail | FEATURES.md "Permissions page"; `PLUGIN/audit.rs` |
| OS sandbox (bubblewrap/Seatbelt/AppContainer), env allowlist for children, protected `.git`/`.jan`, unsandboxed retry offers | `PLUGIN/tools/sandbox.rs`, `appcontainer.rs`, `proc.rs SANDBOX_ENV_ALLOW`, `unsandboxed_retry.rs` |
| Narrow host tools instead of a generic unsandboxed escape hatch (git, powershell, docker, ssh, build) | `PLUGIN/tools/schema.rs`, `host_*.rs` |
| Model allowlist/aliases, routing rules, provider fallback chain, model status vocabulary | `AGENT/routing.rs`, `project.rs [models]`, `cli/mod.rs [agent].fallback` |
| Effort control (slider on desktop, low/medium/high cycle in TUI), reasoning toggles | `web-app/src/containers/ReasoningEffortSlider.tsx`, `TUI` |
| Auto-compaction with breaker, context window learned from server, `/context` breakdown | `AGENT/compaction_policy.rs`, `loop.rs MAX_COMPACTION_ATTEMPTS`, `TUI /context` |
| Retries with backoff (10 attempts), `Retry-After`, stream idle timeout, truncated-stream tool-call guard, typed error taxonomy | `AGENT/genai_bridge.rs`, `PLUGIN/harness_error.rs`, `loop.rs ~L9640` |
| Spend by model with user-declared prices, cached-token pricing, quotas and budgets, per-turn receipt | `AGENT/spend.rs`, `AGENT/quota.rs`, `TUI` receipt |
| Prompt-cache accounting per request/turn/session | FEATURES.md "Token & prompt-cache accounting" |
| Notifications by command and webhook; OSC title/status | `AGENT/notify.rs`, `cli/agent_status.rs` |
| Proxy, no-proxy, custom CA (fail-closed) | `src-tauri/src/core/net/tls.rs`, `core/net/transport.rs` |
| Secrets: protected secret files, env scrubbing, redaction, hide-secrets mode | `PLUGIN/secrets.rs`, `AGENT/secrets.rs`, `global_config.rs hide_secrets` |
| Ask-tool auto-timeout for unattended runs | `global_config.rs ask_timeout_secs`, console.mdx |
| Commit/PR attribution switches | `web-app/src/containers/AttributionSettings.tsx`, `PLUGIN/tools/git_attribution.rs` |
| Local voice dictation on desktop | `web-app/src/hooks/useVoiceInput.ts` |
| Large paste becomes an attachment | `web-app/src/hooks/useLargePaste.ts` |
| Reduced motion, high contrast, font size on desktop | `web-app/src/providers/InterfaceProvider.tsx` |
| Terminal setup helper (Shift+Enter, Option), `NO_COLOR` | `cli/terminal_setup.rs`, `cli/color.rs` |
| Rebindable shortcuts on desktop | `web-app/src/routes/settings/shortcuts.tsx` |
| Data retention, archive instead of delete, redacted diagnostic bundle | FEATURES.md "Archive", "Privacy and local-only"; `cli/doctor.rs` |
| Per-run profiles instead of `--settings` overrides | `AGENT/project.rs ProfileSection` |
| Cost: `/usage` in TUI, per-run process tree and stats | `cli/usage_view.rs`, FEATURES.md |

### Reader E

- Stop-hook equivalent: run must pass checks before final answer | `src-tauri/src/core/agent/final_checks.rs` (`[agent] final_checks`, one retry turn)
- Notification hook equivalent (run ended / waiting for you, command + webhook) | `src-tauri/src/core/agent/notify.rs` (`[notify]`)
- MCP tool search / deferred schemas | `src-tauri/src/core/agent/mcp_catalog.rs` (`mcp_tools`, 20k-char threshold); `tool_profile.rs` (minimal profile)
- `/goal` keep working until condition | `src-tauri/src/core/agent/goal.rs`
- Checkpoints and rewind (code + conversation), safety checkpoint, git-tree snapshots that include shell-made changes (CC does not track bash edits) | `src-tauri/src/core/agent/checkpoint.rs`, `git.rs`; double-Esc picker in `tui.rs`
- Bash timeout moves job to background and returns job_id; finished-job reminders | `plugins/tauri-plugin-agent-tools/src/tools/schema.rs:228-246`, `core/agent/loop.rs:8476-8521`
- Bash overflow spills to a file, big caps | `tools/handlers.rs:31-36` (BASH_SPILL_MAX_BYTES)
- Parallel read-only tool calls | `core/agent/loop.rs:5301`
- Read `allow_large` | `schema.rs:45-58`
- Plan mode, run modes (Manual/Auto/etc.), auto mode classifier | `core/agent/auto_mode.rs`, `plan.rs`, `flint --mode review|ask|auto|bypass` (bin/flint.rs)
- Deferred approvals (like PreToolUse `defer`) | `bin/flint.rs:636,1766` (`[approvals] defer`), `deferred_approvals.rs`
- Phone-relayed permission prompts (channels permission relay) | `docs/MOBILE.md`
- Stream-json in/out, host tools, cancel, event log | `bin/flint.rs:1027-1065`, `cli/json_api.rs`, `cli rpc`
- `--max-budget-usd`, `--max-turns`, `--resume`, `--continue`, `--fork-session`, worktree flag | `bin/flint.rs:126-195`
- `claude doctor`, bug report | `core/cli/doctor.rs`, `flint bug-report`
- `claude launch`-style wrappers, MCP serve | `core/cli/launch_cmd.rs`, `core/cli/mcp_serve.rs`
- `/context`, `/usage`, `/export`, `/fork`, `/mcp`, `/plugin`, `/schedule` in the TUI | `tui.rs:11170-11380`
- Background shell jobs, agent view analog (`claude agents`, `attach`, `logs`) | `flint cli job` (FEATURES.md), `cli/agent_status.rs`, `agent serve`
- Cross-session messaging, subagent questions, completion notices | `docs/AGENT_MESSAGING.md`
- Task list tool | `core/agent/todo.rs`
- AGENTS.md / CLAUDE.md instruction files | FEATURES.md "Instruction files"
- Archive instead of delete; project purge-ish | `core/archive/*`
- LaTeX math rendering | web-app `package.json` (katex, remark-math, rehype-katex)
- LSP tool | FEATURES.md "Language servers"; `core/agent/lsp.rs`
- Skills/plugins/slash commands from plugins | `core/agent/slash.rs`, `plugin_commands.rs`
- Compaction pre/post hooks, policy, reserve | `docs/CONTEXT_COMPACTION.md`, `hooks.rs`
- `@` mentions with line ranges, image paste | FEATURES.md, `tui.rs:4527 attach_clipboard_image`
- Folder trust gating for project hooks (CC workspace trust) | `folder_trust.rs`, `docs/HOOKS.md` Trusted folders

### Reader F

- max turns / budget caps with typed end reason | src-tauri/src/core/agent/end_reason.rs (Completed, UserStop, Budget, TurnLimit, Refusal, Error, LeaseLost); flags --max-turns --max-budget-usd --max-session-tokens in src/bin/flint.rs
- subagent spend counts toward parent budget | core/agent/loop.rs:548, core/agent/spend.rs
- fallback model chain | core/cli/mod.rs:1256 (`[agent].fallback`), core/agent/loop.rs
- mid-session model switch | core/cli/rpc.rs `session/model/set`
- continue/resume/fork sessions, list/archive | core/cli/rpc.rs session/*; docs/FEATURES.md line 90
- steer/interrupt while running (streaming input) | rpc.rs turn/steer, turn/interrupt; core/cli/stream_input.rs
- partial streaming events (token, tool-call args delta, tool output delta) | core/agent/events.rs StreamEvent::Token / ToolCallArgsDelta / ToolOutputDelta
- truncated tool call not executed | core/agent/loop.rs:13670 test turn_cycle_skips_execution_on_truncated_tool_calls
- permission modes (review/ask/auto/bypass), safety classifier | core/agent/auto_mode.rs, core/cli/mod.rs:1475
- approve-and-remember (AllowAlways with scope) and deferred approvals | core/agent/approval_loop_tests.rs, approval_flow.rs, plugins/tauri-plugin-agent-tools/src/deferred_approvals.rs
- clarifying questions with options | core/agent/interaction.rs (Question/OptionItem)
- parallel read-only tools, serialized mutators | core/agent/loop.rs:756 and ~4796
- compaction plus pre/post-compact hooks | docs/HOOKS.md, docs/CONTEXT_COMPACTION.md
- checkpoint/rewind | docs/FEATURES.md line 66
- JSON result envelope, exit codes, JSON-lines serve | core/cli/json_api.rs, rpc.rs, rpc_schema.rs, protocol_schema.rs
- skills / memory / MCP / plugins from project | core/agent/skills.rs, cc_import.rs, mcp_catalog.rs, plugins.rs
- diagnostics / bug report | `flint bug-report`, core/cli/doctor.rs, file_log.rs

### Reader G

| Feature | Evidence |
|---|---|
| Tool search / deferred MCP schemas, searched and loaded on demand, appended to keep prefix cache | src-tauri/src/core/agent/mcp_catalog.rs (`mcp_tools`, defer past 20k chars, max 15 results); loop.rs `deferred_mcp` |
| Lazy MCP server start, idle shutdown | src-tauri/src/core/mcp/lazy.rs |
| MCP result size cap, per-server result/session budgets | core/mcp/truncate.rs, core/mcp/budget.rs |
| Stuck MCP call cancel + stall stop, per-server timeout | core/mcp/stall.rs, `toolCallTimeoutSeconds` read in upstream.rs |
| MCP OAuth, trust bound to config, last-good tool listing reuse | core/mcp/oauth.rs, plugin `mcp_trust.rs`, upstream.rs `reuse_last_good_listings` |
| Arg-name repair for MCP tools | core/mcp/arg_align.rs |
| Tool allow/deny by name, scoped rules, bare-name removal from context | plugin `permissions.rs` (`advertises_mcp`), `scoped_rules.rs`, agent/tool_profile.rs, tool_rules.rs |
| Tool availability by model (profiles that only remove tools) | agent/tool_profile.rs |
| Permission modes (review/ask/auto/bypass), plan mode read-only, unattended deny-and-record | loop.rs (`bypass`, `plan_mode_read_only`), FEATURES.md |
| Auto-mode classifier with optional model judge, can only make safer | agent/auto_mode.rs |
| Critical/protected paths, destructive git gating | agent/destructive.rs, plugin `policy.rs` |
| Hooks: pre/post-tool, batch, compact; failure policy; timeouts; confinement same as bash; trusted folders | plugin hooks.rs, docs/HOOKS.md, plugin `folder_trust.rs` |
| Claude Code hook import (SessionStart, UserPromptSubmit additionalContext) | agent/cc_hooks.rs |
| Subagents: background, depth cap, concurrency cap (`max_parallel_subagents`), cancel one, durable detached subagents | agent/subagent.rs, durable_subagent.rs |
| Subagent final output neutralised against harness-imitating text | plugin `control_tags.rs`, subagent.rs line ~2057 |
| Skills: user-invocable / disable-model-invocation / allowed-tools frontmatter, slash dispatch | agent/skills.rs, plugin `skills.rs` |
| Plugins: skills, commands, agents, install without executing code | agent/plugins.rs |
| File checkpoint + rewind (git snapshot of whole tree, stronger than SDK which misses Bash edits), safety checkpoint, refuses overwrite of newer edits | agent/checkpoint.rs, agent/git.rs |
| Todo/task tracking | agent/todo.rs, shared task board (FEATURES.md) |
| Cost tracking: per-model prices, cache read/write ratios, per-run/period dashboard, budgets | agent/spend.rs, plugin `usage.rs`, quota.rs |
| Typed end-of-run reason (terminal_reason analogue) | agent/end_reason.rs |
| Model fallback chain | loop.rs `fallback_models`, `distinct_chain` |
| Parallel read-only native tools with per-call stall bound | loop.rs `bounded_read_only_call` |
| Prompt cache stability: deterministic trim, single writer above cache line | agent/prompt.rs, prompt_trim.rs |
| Injected guidance kept out of tool messages (untrusted) | agent/reminder.rs (`<SYSTEM>` tags) |
| Context usage breakdown incl. deferred tools | plugin `context_report.rs` |
| Session persistence / headless serve / detached jobs | `flint cli agent serve`, `cli job`, plugin `worker.rs`, `job_record.rs` |
| OS sandbox (bwrap / Seatbelt / AppContainer), network allowlists, read-only mounts | plugin `tools/sandbox.rs`, `jail.rs`, `appcontainer.rs` |
| Secure-deployment credential handling: keys in OS keyring, redaction, secret-file protection | secrets.rs, plugin `secrets.rs`, FEATURES.md "Secrets" |
| Notifications and webhooks on run end | agent/notify.rs |

### Reader H

| Feature | Evidence |
|---|---|
| Auto mode classifier / destructive git gating / protected paths | src-tauri/src/core/agent/auto_mode.rs, destructive.rs; docs/FEATURES.md Permissions |
| `/goal` completion loop | src-tauri/src/core/agent/goal.rs, web-app/src/hooks/useCoworkSessions.ts (setGoal), docs/src/pages/docs/agent/goals-and-todos.mdx |
| Agent view (all sessions in one screen) / background sessions in resume | docs/FEATURES.md (Cowork sidebar, team row, background shell jobs), web-app/src/hooks/useCoworkSessions.ts |
| Cross-session messaging, stop_session | docs/AGENT_MESSAGING.md, tools/schema.rs list_agents description |
| Transcript search | docs/FEATURES.md (search past transcripts), src-tauri/src/bin/flint.rs |
| Computer use | tools/computer.rs (+ computer_windows.ps1, computer_macos.rs, computer_wayland.rs), settings/agent.tsx Computer use card |
| Browser/Chrome-style page automation, console, upload, download, tabs | tools/browser_tool.rs (BROWSER_DESCRIPTION), FEATURES.md Agent browser |
| In-app browser with site consent | FEATURES.md Agent browser, browser_agent/ |
| MCP login/logout from shell, OAuth in keychain | FEATURES.md MCP sign-in, flint cli MCP OAuth management |
| MCP per-server result budget | src-tauri/src/core/mcp/budget.rs |
| Fallback models / provider routing | docs/FEATURES.md Models and providers, agent/routing.rs |
| Subagents (nested, background, fork, limits), worktrees | FEATURES.md Cowork agents; agent/subagent.rs, durable_subagent.rs, worktree.rs |
| Code review / ultrareview-style multi-reviewer | agent/review.rs, consensus.rs |
| Scheduled / routines (local cron + OS entry + webhooks) | docs/FEATURES.md Scheduled tasks, core/schedule/ |
| Mobile push + phone pairing (Remote Control equivalent) | core/remote/push.rs, docs/MOBILE.md, docs/ios-app.md |
| Session fork/export/import/handoff, resume | FEATURES.md Sessions; agent/session_copy.rs, session_bundle.rs |
| Resume from PR | agent/github_pr.rs, pull_request.rs |
| Prompt history recall (Up/Down) | web-app/src/containers/ChatInput.tsx navigateHistory |
| Compaction + context accounting | FEATURES.md Context and memory; agent/compaction.rs, context_pressure.rs |
| Cost/cache-hit stats, budgets, token limits | FEATURES.md Usage and cost; agent/spend.rs, quota.rs |
| Restricted/run modes, plan mode, read-only | FEATURES.md Cowork modes; docs/agent/run-modes.mdx |
| Screen-reader roles and labels | FEATURES.md Accessibility (partial pass noted by Flint itself) |
| Notifications and webhooks on run end | agent/notify.rs |
| Format on edit, diff review, per-hunk apply, Changes panel (live /diff) | FEATURES.md Cowork worktrees/changes |
| Plugin/skills/hooks basics, imports of Claude Code settings | agent/plugins.rs, skills.rs, cc_import.rs, cc_hooks.rs |
| Cwd/worktree move | managed worktrees (FEATURES.md); no `/cd` equivalent needed beyond new session in folder |
| Task tools / todo | agent/todo.rs, shared task board |
| OS sandbox for shell | FEATURES.md Platforms |
| Custom accent theme | FEATURES.md Workspace and design (full custom theme files not built, low value) |

## 4. Skipped pages

Not applicable (Anthropic-account, cloud, enterprise or IDE-install). Reasons per reader:

### Reader A

- /docs/en/overview, quickstart (install/login/Console/Bedrock/plans) - N/A account/installer content; nothing Flint-actionable beyond what is in PARITY.
- /docs/en/platforms - N/A surface comparison (IDE, Slack, Chrome ext, GitHub Actions, Channels, Dispatch); Channels (push events from Telegram/Discord into a session) is the one idea worth a later look but belongs with gap 11.
- /docs/en/mobile - N/A (Claude iOS/Android app, cloud sessions, Dispatch, claude.ai Remote Control); Flint has its own phone PWA (docs/MOBILE.md).
- /docs/en/ultrareview - cloud-only fleet billed as credits; local idea folded into gap 7.
- /docs/en/claude-projects - Anthropic cloud/GitHub-App/Pro-Max beta; local analogue already = Campaigns.
- /docs/en/routines - cloud execution, claude.ai connectors, GitHub App, API token minting are N/A; local-equivalent ideas are gaps 10-12.
- /docs/en/desktop - SSH remote-machine environments with background helper, org managed settings, Dispatch, cloud sessions, claude.ai connector sync, Windows remote caveats: N/A or other reader's area (remote runner / flint serve). Cross-session messaging, task chips, worktrees: told to ignore.
- /docs/en/features-overview, claude-directory, prompt-library, how-claude-code-works, best-practices, common-workflows - mostly concept/structure; only items in GAPS above mattered. `claude purge`, `cleanupPeriodDays`, `CLAUDE_CONFIG_DIR`, `/doctor prompt-audit`, `/insights`, `/powerup`, `/feedback` considered: Flint has archive/purge, diagnostic bundle, bug report; prompt-audit of stale instruction files is a low-value idea not listed.
- Dynamic workflows, subagent frontmatter fields, spawn_session/worktree/fork, cross-session messaging: skipped per brief.

### Reader B

- /agents, /sub-agents managed settings, plugin-agent trust, Bedrock model ARNs: Anthropic-account or provider specific (frontmatter fields handled elsewhere)
- /agent-view macOS permissions, claude.ai login, subscription quota text, Remote Control, Claude Tag: Anthropic-account only
- /mcp claude.ai connectors, managed MCP, `disableClaudeAiConnectors`: Anthropic-account only
- /artifacts publishing, sharing, org admin, Compliance API, CMEK: hosted on claude.ai
- /channels Telegram/Discord/iMessage plugins and enterprise `channelsEnabled`: account/org specific (the local push-event idea is in GAPS 9)
- /workflows: dynamic workflows already being worked on elsewhere
- /cross-session-messaging cross-machine, cloud sessions, `isolatePeerMachines`: Remote Control only; @mentions / notify_when_idle / hold-refuse-accept already assigned elsewhere
- /worktrees non-git `WorktreeCreate` hook and desktop worktrees: covered by gap 1 events list, rest known
- /scheduled-tasks cloud routines and Desktop scheduled tasks: Anthropic-hosted

### Reader C

- https://code.claude.com/docs/en/plugins/anthropic-marketplaces - mostly names of Anthropic marketplaces; only value is "read official marketplace.json" (covered in marketplace gap)
- https://code.claude.com/docs/en/plugins/org - managed-settings admin; N/A (one-line org policy row above)
- https://code.claude.com/docs/en/plugins/mods/admin - org admin of mods; N/A except the policy-mod idea noted in mods row
- https://code.claude.com/docs/en/plugins/troubleshooting - error-message catalog; only takeaway is an in-UI "Errors" tab listing load failures (Flint surfaces typed PluginErrorCode on install only; no persistent load-error list; low value)
- https://code.claude.com/docs/en/plugins/loading - cache layout, synced claude.ai plugins, managed precedence, name conflicts; N/A except version-as-cache-key (folded into update gap) and name-conflict rule (Flint: project shadows user, partially covered)
- https://code.claude.com/docs/en/plugins/security - telemetry tier redaction, Anthropic official/community/third-party name tiers; N/A (name-reservation checks could be borrowed but low value)
- https://code.claude.com/docs/en/plugins/publish - Anthropic directory submission requires claude.ai plan; N/A (own-marketplace publish path folded into marketplace gap)
- claude.ai/Cowork synced plugins, Analytics API, OTEL plugin events, Claude Marketplace website, VS Code/Desktop install tabs, JetBrains, Agent SDK plugins option, cloud sessions - Anthropic-account/surface only
- Channels (Telegram etc. via plugin `channels`) - Anthropic channels feature, not in assigned scope pages beyond manifest mention; not analysed

### Reader D

- `/docs/en/fast-mode` - Anthropic API/subscription billing feature (`speed` tier on Opus); no Flint equivalent needed. Idea only: a provider "priority tier" switch for Anthropic-style endpoints, not worth building now.
- `/docs/en/auto-mode-classifier-billing` - Anthropic server-side classifier billing and gateway eligibility notice; N/A.
- `/docs/en/data-usage` - Anthropic data policy, telemetry defaults, `/feedback` upload; N/A (Flint has no telemetry).
- `/docs/en/security` - mostly a summary of permissions/sandbox/cloud; only takeaway used (invisible-Unicode, item 12). WebFetch hostname safety check phones home, contradicts Flint's design.
- `/docs/en/devcontainer` - Docker dev-container recipe for running Claude Code itself; N/A (Flint ships its own OS sandbox).
- `/docs/en/sandbox-environments` - comparison of isolation options and org enforcement; N/A beyond items 3-4.
- `/docs/en/gateways`, `/docs/en/llm-gateway` - Claude apps gateway / LLM gateway rollout for Anthropic traffic; N/A (Flint talks to providers directly; its `[models]` and org policy cover the admin side).
- `/docs/en/troubleshooting` - install/login/ripgrep/WSL/clipboard fixes; N/A. `/heapdump` is Node-specific; Flint has `ram_guard` for model memory.
- `/docs/en/errors` - mapped to existing retry/error taxonomy (parity); the Anthropic account, billing and login errors are N/A.
- Managed-settings, server-managed-settings, claude.ai login, usage credits, Remote Control, cloud sessions, Bedrock/Vertex/Foundry setup, IDE integration, plugin marketplace admin keys inside the settings pages - Anthropic-account or admin-only; N/A.

### Reader E

- /setup - install channels, Homebrew/WinGet/apt, auto-update, `minimumVersion`, binary signing: Flint has no update checks by design (FEATURES.md Privacy); packaging covered by `docs/PACKAGING.md`
- /env-vars - 400 variables, mostly Anthropic auth, Bedrock/Vertex/Foundry, OTel telemetry, gateway, Remote Control, plugin marketplace, fullscreen/terminal tuning: N/A. Worth a thought only: retry/backoff knobs (`MAX_RETRIES`, 529 backoff), stream idle watchdog (not verified in Flint loop; searched loop.rs/upstream.rs for idle/stall/watchdog on the model stream, only MCP stall found), `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `BASH_MAX_OUTPUT_LENGTH` as user-visible settings
- /cli-reference - `auth login/logout/status`, `setup-token`, `claude gateway`, `--cloud/--remote/--teleport/--desktop`, `--chrome`, `--ide`, `self-hosted-runner`, `remote-control`, `--channels`, `--betas`, Bedrock flags, `--remote-control`: Anthropic account / cloud
- /commands - `/login /logout /upgrade /usage-credits /rate-limit-options /passes /privacy-settings /install-github-app /install-slack-app /chrome /desktop /mobile /teleport /remote-control /remote-env /web-setup /schedule(cloud) /ultrareview /design /slides /voice(account) /stickers /radio /team-onboarding /insights`: account/cloud/novelty
- /tools-reference - `Artifact`, `RemoteTrigger`, `PushNotification`, `SendUserFile`, `ShareOnboardingGuide`, `SendFeedback`, `EndConversation`, `SubagentHandback`, advisor tool: Anthropic-hosted or account-only; `EnterWorktree`, `Agent`, `SendMessage` belong to the worktree/subagent/messaging tracks
- /interactive-mode - usage-limit auto-continue, PR badge via `gh`, emoji shortcodes, spellcheck, "You should know" mod, terminal paste/vim minutiae: plan-only or cosmetic. (Vim mode in desktop composer not checked: only 13 `vim` hits in src, all unrelated)
- /checkpointing - fully read; Flint's checkpoint design is ahead (shell edits covered, safety checkpoint, no 100-checkpoint cap)
- /channels-reference - protocol is Claude-Code-specific (`notifications/claude/channel`); idea captured as G3
- /glossary - vocabulary only; maps to Flint terms (surface, turn, harness, transcript = event log). No action
- /vs-code - IDE install and extension; ideas: terminal output in prompt, built-in IDE MCP server (Flint already serves MCP via `mcp_serve.rs`), session groups; none new
- /gitlab-ci-cd - skip per brief
- /github-actions - idea-level: `@claude` mention trigger, `claude_args` pass-through, run a skill as `prompt:` in CI, schedule trigger, `--max-turns` cost caps. Flint equivalent would be documenting `flint cli agent run` in a self-hosted-runner workflow; no gap to build
- /desktop-ios-simulator - idea-level only (G6)
- /code-review - product needs Team/Enterprise + GitHub App; local analogue captured as G1

### Reader F

- https://code.claude.com/docs/en/agent-sdk/overview - SDK vs CLI/Managed Agents comparison, branding/license; library embedding already covered by `agent serve`/rpc/ACP.
- https://code.claude.com/docs/en/agent-sdk/quickstart - install, API key, Bedrock/Vertex/Foundry env vars: N/A.
- https://code.claude.com/docs/en/agent-sdk/migration-guide - package rename, old defaults: N/A (lesson folded into gap 5).
- https://code.claude.com/docs/en/agent-sdk/troubleshooting - CLINotFound/ProcessError/batch-script refusal: N/A; only "success but no structured output" idea (gap 1).
- https://code.claude.com/docs/en/agent-sdk/examples - links to demo repos and cookbook: nothing to build.
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode - input modes; Flint has turn/steer and stream_input.rs (parity).
- Anthropic-account items: claude.ai login restriction, server-managed settings, claude.ai MCP connectors.

### Reader G

- agent-sdk/hosting (container/K8s/Modal patterns, multi-tenant `CLAUDE_CONFIG_DIR`, Managed Agents): server-side hosting, Flint is a local desktop app. Only transferable idea (session store adapter) already covered by Flint's on-disk journal + `agent serve`.
- agent-sdk/secure-deployment: Docker/gVisor/Firecracker/proxy credential injection are deployment topologies; Flint already ships the OS sandbox and keyring model. Egress-proxy credential injection has no local analogue worth building.
- agent-sdk/cost-tracking `ENABLE_PROMPT_CACHING_1H` / TTL knobs, data-residency multiplier, Usage and Cost API: Anthropic API billing specifics; Flint prices are user-declared (`prices.toml`).
- Python-only items in python (`ClaudeSDKClient`, `@tool` dict schemas, asyncio notes): SDK ergonomics, not runtime features.
- Claude.ai-only fields in typescript (`SDKUsageReport`, fast-mode reasons, `RemoteTrigger`, `Agent isolation:"remote"`, Artifact tool, claude.ai connector `ask` policy, managedSettings admin): account/cloud features.
- Bedrock/Vertex/Foundry tool-search fallbacks in tool-search: provider-specific.
- Workflow tool in subagents/typescript: already being worked on elsewhere per brief.
- Subagent definition fields (`model`, `tools`, `skills`, `maxTurns`, `background`, `effort`, `permissionMode`, `omitClaudeMd`...) and fork subagent: already covered elsewhere per brief.

### Reader H

- whats-new: Opus/Sonnet/Fable/Mythos model launches, fast mode, effort pricing, model-picker, prompt-cache TTL, usage credits, Bedrock/Vertex/Foundry/Mantle/gateway items - Anthropic/provider specific.
- Ultraplan/ultrareview cloud, Routines (web), PR auto-fix (web), cloud/self-hosted environments, Claude Code on the web, Desktop-app features (iOS Simulator pane, pop-out panes, auto-continue on limit, resume CLI session in Desktop, Linux beta) - Anthropic-account/cloud/Desktop only.
- Artifacts to claude.ai (publish, MCP connectors, sharing links, /design), Claude Security plugin, security-guidance plugin, Claude in Chrome extension, JetBrains/VS Code extensions, /radio, /buddy - N/A.
- Managed settings admin keys (requiredMinimumVersion, enforceAvailableModels, managedMcpServers, modelPricing, parentSettingsBehavior), SSO/SCIM/ZDR/HIPAA - enterprise admin.
- Terminal UI polish (Vim visual mode, readline word-edit, emoji shortcodes, spellcheck, flicker-free renderer, Ctrl+R, status line, footer links, themes dir, `--ax-screen-reader`) - TUI-only or Flint has desktop equivalent; not worth building.
- Subagent frontmatter, spawn_session, worktrees, @mentions, notify_when_idle (w32-w34) - being worked on elsewhere.
- Windows-without-Git-Bash, native binaries, installer size, OTEL env, Perforce mode - Flint already ships its own builds / out of scope.
- claude-tag - redirects off docs host to claude.com Slack product; Slack-only.

Pages not listed above fall in the same classes: cloud and web sessions, Bedrock, Vertex, Foundry and Platform pages, Claude apps gateway pages, LLM gateway rollout pages, self-hosted environments, managed and server-managed settings, GitHub Enterprise, GitLab CI, HIPAA, ZDR and data usage, communications and champion kits, analytics, authentication and install troubleshooting, translation indexes.

## 5. Coverage

Reader caveats: the desktop page tail (SSH, enterprise, troubleshooting) was read by headings only (A); `claude-tag` redirected off-host and `remote-control` was read in part (H); changelog entries older than 2.1.6 were previewed only (E); the `plugin-evals`, `cli-reference` and plugin `troubleshooting` pages were read partially (C); `typescript.md` and `python.md` came via summarising fetches (G); hooks-guide recipe sections were skimmed (B). Everything else listed below was read in full.

### Reader A

- https://code.claude.com/docs/en/overview.md
- https://code.claude.com/docs/en/quickstart.md
- https://code.claude.com/docs/en/how-claude-code-works.md
- https://code.claude.com/docs/en/features-overview.md
- https://code.claude.com/docs/en/claude-directory.md
- https://code.claude.com/docs/en/context-window.md
- https://code.claude.com/docs/en/prompt-caching.md
- https://code.claude.com/docs/en/memory.md (full, via saved output)
- https://code.claude.com/docs/en/sessions.md
- https://code.claude.com/docs/en/common-workflows.md
- https://code.claude.com/docs/en/prompt-library.md
- https://code.claude.com/docs/en/best-practices.md
- https://code.claude.com/docs/en/claude-projects.md (full, via saved output)
- https://code.claude.com/docs/en/computer-use.md
- https://code.claude.com/docs/en/routines.md
- https://code.claude.com/docs/en/desktop.md (chars 0-100000 read as feature list; remainder 100000-163549 checked by section headings only: SSH details, enterprise config, CLI comparison, troubleshooting - not read in full)
- https://code.claude.com/docs/en/desktop-scheduled-tasks.md
- https://code.claude.com/docs/en/code-review-local.md
- https://code.claude.com/docs/en/ultrareview.md
- https://code.claude.com/docs/en/security-guidance.md
- https://code.claude.com/docs/en/claude-security.md
- https://code.claude.com/docs/en/platforms.md
- https://code.claude.com/docs/en/mobile.md

### Reader B

All fetched until the page ended (tails re-read with offset):
- https://code.claude.com/docs/en/agents.md
- https://code.claude.com/docs/en/agent-view.md (0-100k then 100k-end: limitations, version history table)
- https://code.claude.com/docs/en/sub-agents.md (0-100k then 100k-end: fork comparison tail, example subagents)
- https://code.claude.com/docs/en/agent-teams.md
- https://code.claude.com/docs/en/cross-session-messaging.md
- https://code.claude.com/docs/en/workflows.md
- https://code.claude.com/docs/en/worktrees.md
- https://code.claude.com/docs/en/mcp-quickstart.md
- https://code.claude.com/docs/en/mcp.md (0-100k then 100k-end: images, schema combinators, requiresUserInteraction, elicitation, resources, tool search, prompts)
- https://code.claude.com/docs/en/skills.md (0-100k then 100k-end: example script, troubleshooting, listing budget)
- https://code.claude.com/docs/en/artifacts.md
- https://code.claude.com/docs/en/hooks-guide.md (read from saved copy: first 2KB preview, lines 472-1077 in full; lines 20-471 recipe sections (notification, format, block edits, reinject context, config audit, env reload, auto-approve) were NOT read line by line, only their headings)
- https://code.claude.com/docs/en/hooks-guide.md recipes remain skimmed by heading
- https://code.claude.com/docs/en/scheduled-tasks.md
- https://code.claude.com/docs/en/goal.md
- https://code.claude.com/docs/en/headless.md
- https://code.claude.com/docs/en/channels.md
- https://code.claude.com/docs/en/deep-links.md
- https://code.claude.com/docs/en/large-codebases.md

Caveat: WebFetch returns a summarizer's rendering for the first 100k chars of agent-view, sub-agents, mcp, skills (not raw text), so minor details may be lost.
Not fetched: /docs/en/hooks (full reference), /docs/en/tools-reference.

### Reader C

All fully read via WebFetch (https://code.claude.com/docs/en/ + path.md). Pages with a `Max N bullets` extraction prompt were summarised by the fetch model, not verbatim read; the rest returned full text.

Full text returned: plugins/overview, plugins/install, plugins/components, plugins/dependencies, plugins/security, plugins/manifest-reference, plugins/marketplace-reference, plugins/mods/overview, plugins/anthropic-marketplaces, plugins/code-intelligence, plugins/create, plugins/publish, plugins/measure, plugins/cli-hints, plugins/relevance, plugins/mods/create, plugins/mods/reference, plugins/mods/interface, plugins/mods/gallery, plugins/mods/events, plugins/mods/api, plugins/mods/test, plugins/mods/troubleshoot, plugins/loading, plugins/host-marketplace, plugins/create-marketplace, plugins/org, plugins/mods/admin

Section-level only (page large, read via heading index + selected sections of the saved result): plugin-evals (How an eval run works, graders, mocks, isolation, headings of rest), plugins/cli-reference (subcommand headings only: init/install/uninstall/enable/disable/update/list/details/configure/prune/eval/eval init/tag/test/validate/marketplace add|list|remove|update, /plugin, /reload-plugins, session flags), plugins/troubleshooting (opening only)

Count: 31 assigned pages touched (28 full, 3 partial).

### Reader D

All 30 pages fully read via WebFetch (`https://code.claude.com/docs/en/<slug>.md`, every offset chunk until the end) or, for the four largest, the full saved text read line by line.

- settings, settings-reference (all 5 chunks, 0 to 404508 chars), settings-example
- permissions (all 786 lines), permission-modes (all 902 lines), auto-mode-config, auto-mode-classifier-billing
- sandboxing (all ~1010 lines), sandbox-environments
- model-config (both chunks), fast-mode, advisor, output-styles
- terminal-config, fullscreen, accessibility, voice-dictation
- statusline (all ~1213 lines), keybindings
- costs, monitoring-usage (both chunks, 0 to 156659 chars)
- security, data-usage, debug-your-config
- errors (all 6 chunks, 0 to 520529 chars), troubleshooting
- network-config, devcontainer, gateways, llm-gateway

Flint sources read for verification: `docs/FEATURES.md`, `docs/HOOKS.md` (head), `docs/src/pages/docs/agent/{permissions,run-modes,console,keybindings,slash-commands,project-config}.mdx`, and the Rust/TS files named in the tables.

Second-pass notes (after the full read): the extra material in permissions, permission-modes, sandboxing, errors and settings-reference added rows 25-29 and sharpened rows 2, 3, 4 and 15; nothing in them reversed an earlier finding. Statusline additionally offers `refreshInterval`, `hideVimModeIndicator` and a separate `subagentStatusLine`; monitoring-usage's events (compaction, subagent_completed, api_retries_exhausted, hook_registered, retention_sweep, managed_settings_resolved) are all covered by row 18 (OTLP export of Flint's existing event log).

### Reader E

- https://code.claude.com/docs/en/cli-reference.md
- https://code.claude.com/docs/en/commands.md
- https://code.claude.com/docs/en/env-vars.md (first 100k chars read; second chunk from 100k read as saved output preview only, remainder is mostly provider/telemetry/gateway variables)
- https://code.claude.com/docs/en/tools-reference.md
- https://code.claude.com/docs/en/interactive-mode.md
- https://code.claude.com/docs/en/checkpointing.md
- https://code.claude.com/docs/en/hooks.md (chars 0-200k via summaries, 200k-269k from the saved page tail: ConfigChange onward through Elicitation, prompt/agent hooks, async hooks, security, PowerShell, debug headings)
- https://code.claude.com/docs/en/channels-reference.md
- https://code.claude.com/docs/en/glossary.md
- https://code.claude.com/docs/en/setup.md
- https://code.claude.com/docs/en/desktop-quickstart.md
- https://code.claude.com/docs/en/desktop-ios-simulator.md
- https://code.claude.com/docs/en/code-review.md
- https://code.claude.com/docs/en/github-actions.md
- https://code.claude.com/docs/en/vs-code.md (skimmed by headings + first page, idea-level)
- https://code.claude.com/docs/en/changelog.md (1.07M chars: 11 offset chunks 0-1,000,000 read through WebFetch summaries, versions 2.1.304 down to 2.1.6; the last ~69k chars, 2.1.6 and older, previewed only). Features landed that Flint lacks, beyond the rows above: per-model effort/`xhigh`/ultracode levels (Flint has `/effort`), `fallbackModel` chain flag (config-only in Flint), model picker curation, `modelPricing` override (Flint has prices.toml), `Pre/PostModelSwitch` hooks (H2), subagent fork default (tracked elsewhere), `/diff` side panel with per-turn views (T1/T2 source picker: Flint has Changes panel + per-turn undo, no per-turn diff view not verified), session recap (I9), prompt-cache-miss cause in `/cost` (not verified), idle compaction before cache expiry (cloud-cache specific, N/A for local KV cache), `--safe-mode` (C4), `--restricted` eval mode (Flint has `review` mode + sandbox), read/edit of unread files after `cat`/`sed -n` (not verified in Flint `edit`)

Stale-doc note (not a gap): `src-tauri/plugins/tauri-plugin-agent-tools/src/tools/TOOLS_REFERENCE.md` still lists `Agent`, `AskUserQuestion`, `TodoWrite`, plan mode as "no Jan runtime", but Flint ships `dispatch_subagent`, `ask`, `todo`, plan mode (agent_import.rs:124-126, host_tools.rs:420, loop.rs plan_mode_read_only).

### Reader F

- https://code.claude.com/docs/en/agent-sdk/overview.md
- https://code.claude.com/docs/en/agent-sdk/quickstart.md
- https://code.claude.com/docs/en/agent-sdk/migration-guide.md
- https://code.claude.com/docs/en/agent-sdk/troubleshooting.md
- https://code.claude.com/docs/en/agent-sdk/configuration.md
- https://code.claude.com/docs/en/agent-sdk/examples.md
- https://code.claude.com/docs/en/agent-sdk/agent-loop.md
- https://code.claude.com/docs/en/agent-sdk/claude-code-features.md
- https://code.claude.com/docs/en/agent-sdk/sessions.md
- https://code.claude.com/docs/en/agent-sdk/session-storage.md
- https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode.md
- https://code.claude.com/docs/en/agent-sdk/user-input.md
- https://code.claude.com/docs/en/agent-sdk/streaming-output.md
- https://code.claude.com/docs/en/agent-sdk/structured-outputs.md
(All via WebFetch, returned in full.)

### Reader G

- https://code.claude.com/docs/en/agent-sdk/custom-tools.md
- https://code.claude.com/docs/en/agent-sdk/mcp.md
- https://code.claude.com/docs/en/agent-sdk/tool-search.md
- https://code.claude.com/docs/en/agent-sdk/subagents.md
- https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts.md
- https://code.claude.com/docs/en/agent-sdk/skills.md
- https://code.claude.com/docs/en/agent-sdk/plugins.md
- https://code.claude.com/docs/en/agent-sdk/permissions.md
- https://code.claude.com/docs/en/agent-sdk/hooks.md
- https://code.claude.com/docs/en/agent-sdk/file-checkpointing.md
- https://code.claude.com/docs/en/agent-sdk/cost-tracking.md
- https://code.claude.com/docs/en/agent-sdk/observability.md
- https://code.claude.com/docs/en/agent-sdk/todo-tracking.md
- https://code.claude.com/docs/en/agent-sdk/hosting.md
- https://code.claude.com/docs/en/agent-sdk/secure-deployment.md
- https://code.claude.com/docs/en/agent-sdk/typescript.md (read via summary at offsets 0, 100000, 200000; whole page covered, summarised)
- https://code.claude.com/docs/en/agent-sdk/python.md (read via summary at offsets 0, 100000; whole page covered, summarised)

### Reader H

- https://code.claude.com/docs/en/whats-new/index.md
- https://code.claude.com/docs/en/whats-new/2026-w13.md through 2026-w30.md (w13-w30, 18 pages) and 2026-w32.md through 2026-w37.md (6 pages) - all 24 weekly pages read in full (w31 absent) - note brief said 25 weekly pages; the actual count is 24.
- https://code.claude.com/docs/en/chrome.md (full)
- https://code.claude.com/docs/en/jetbrains.md (full)
- https://code.claude.com/docs/en/slack.md (full)
- https://code.claude.com/docs/en/legal-and-compliance.md (full)
- https://code.claude.com/docs/en/feature-availability.md (full)
- https://code.claude.com/docs/en/remote-control.md - fetched, only first section seen (output 56 KB persisted, not read further); ideas taken from whats-new (phone push, device cards, effort sync) which Flint covers via remote/push.rs and phone pairing.
- https://code.claude.com/docs/en/claude-tag.md - redirected to claude.com/docs/claude-tag, not fetched (Slack-only, N/A).
