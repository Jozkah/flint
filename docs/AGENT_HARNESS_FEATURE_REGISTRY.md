# Agent harness feature registry

Generated from `docs/agent-harness-features.json`, which is the source of truth.
Run `node scripts/agent-harness/validate-registry.mjs` after any edit: it enforces the
schema, the status vocabulary, dependency integrity and this file staying in sync.
Regenerate with `node scripts/agent-harness/render-registry.mjs`; never hand-edit it.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| `missing` | No implementation exists. |
| `planned` | Design agreed and owned, no code yet. |
| `in-progress` | Partially implemented; does not yet satisfy its acceptance criteria. |
| `implemented` | Implementation and call-site wiring exist; verification is outstanding. |
| `verified` | Implementation plus tests and documentation satisfy every acceptance criterion. |
| `platform-blocked` | Blocked by an external platform constraint recorded in blockedReason. |
| `rejected-with-decision` | Deliberately not implemented; blockedReason records the decision. |

No backlog item may be deleted, merged, renumbered or silently downgraded. An item
leaves the backlog only as `verified`, `platform-blocked` or `rejected-with-decision`,
and the latter two require a recorded `blockedReason`.

## Totals by phase

| Phase | Name | `missing` | `planned` | `in-progress` | `implemented` | `verified` | `platform-blocked` | `rejected-with-decision` | Total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | Foundation | 0 | 0 | 2 | 10 | 0 | 0 | 0 | 12 |
| 1 | Core execution | 0 | 0 | 5 | 15 | 0 | 0 | 0 | 20 |
| 2 | Security and permissions | 2 | 0 | 8 | 10 | 0 | 0 | 0 | 20 |
| 3 | Repository intelligence | 7 | 0 | 2 | 11 | 0 | 0 | 0 | 20 |
| 4 | Context and memory | 6 | 0 | 7 | 3 | 0 | 0 | 0 | 16 |
| 5 | Agent orchestration | 8 | 0 | 6 | 11 | 0 | 0 | 0 | 25 |
| 6 | Compatibility and integrations | 11 | 0 | 6 | 15 | 0 | 0 | 0 | 32 |
| 7 | Coding and Git workflows | 22 | 0 | 2 | 2 | 0 | 0 | 0 | 26 |
| 8 | UX, automation and operations | 20 | 0 | 10 | 3 | 0 | 0 | 1 | 34 |
| **all** | | **76** | **0** | **48** | **80** | **0** | **0** | **1** | **205** |

## Ownership lanes

Each lane owns its files exclusively. Two lanes never edit the same module in the same
phase; where a change crosses a boundary the owning lane makes it and the other lane
consumes the result.

| Lane | Features |
| --- | --- |
| `lane-01-architecture-registry` | 12 (AH-001-AH-012) |
| `lane-02-execution-runtime` | 20 (AH-013-AH-032) |
| `lane-03-permission-security` | 21 (AH-033-AH-204) |
| `lane-04-repo-index-lsp` | 20 (AH-053-AH-072) |
| `lane-05-context-memory` | 16 (AH-073-AH-088) |
| `lane-06-agents-worktrees` | 25 (AH-089-AH-113) |
| `lane-07-mcp-skills-plugins` | 32 (AH-114-AH-145) |
| `lane-08-git-pr-workflows` | 26 (AH-146-AH-171) |
| `lane-09-ux-observability` | 20 (AH-172-AH-205) |
| `lane-10-provider-enterprise` | 10 (AH-186-AH-195) |
| `lane-12-security-regression-review` | 3 (AH-196-AH-198) |

`lane-11-cross-platform-verification` owns `docs/AGENT_HARNESS_VERIFICATION.md` and the
per-OS evidence log rather than backlog items.

## Features

| ID | Title | Phase | Category | Priority | Status | Security | Depends on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `AH-001` | Machine-readable feature registry | 0 | foundation | P0 | `implemented` | none | - |
| `AH-002` | Registry schema validation | 0 | foundation | P0 | `implemented` | none | `AH-001` |
| `AH-003` | Architecture decision records | 0 | foundation | P0 | `implemented` | none | `AH-001` |
| `AH-004` | Canonical harness event model | 0 | foundation | P0 | `implemented` | low | `AH-003` |
| `AH-005` | Event serialization and schema versioning | 0 | foundation | P0 | `implemented` | low | `AH-004` |
| `AH-006` | Tool capability model | 0 | foundation | P0 | `in-progress` | high | `AH-003` |
| `AH-007` | Permission model core types | 0 | foundation | P0 | `in-progress` | critical | `AH-006` |
| `AH-008` | Run and session identity | 0 | foundation | P0 | `implemented` | low | `AH-003` |
| `AH-009` | Harness error taxonomy | 0 | foundation | P0 | `implemented` | medium | `AH-003` |
| `AH-010` | Persistent state schema | 0 | foundation | P0 | `implemented` | medium | `AH-008` |
| `AH-011` | Harness test fixture library | 0 | foundation | P0 | `implemented` | none | `AH-004`, `AH-009` |
| `AH-012` | Agent worktree conventions | 0 | foundation | P0 | `implemented` | medium | `AH-003` |
| `AH-013` | Plan mode | 1 | execution | P0 | `implemented` | high | `AH-006` |
| `AH-014` | Plan approval gate | 1 | execution | P0 | `implemented` | medium | `AH-013` |
| `AH-015` | Todo/task state machine | 1 | execution | P0 | `implemented` | none | `AH-004` |
| `AH-016` | Task board persistence | 1 | execution | P1 | `implemented` | none | `AH-015`, `AH-010` |
| `AH-017` | Token budget enforcement | 1 | execution | P0 | `implemented` | medium | `AH-008` |
| `AH-018` | Step and iteration budget enforcement | 1 | execution | P0 | `in-progress` | medium | `AH-017` |
| `AH-019` | Wall-clock budget enforcement | 1 | execution | P1 | `implemented` | medium | `AH-017` |
| `AH-020` | Per-tool timeouts | 1 | execution | P0 | `implemented` | medium | `AH-009` |
| `AH-021` | Per-run timeout | 1 | execution | P1 | `implemented` | medium | `AH-019` |
| `AH-022` | Cancellation propagation | 1 | execution | P0 | `implemented` | high | `AH-008` |
| `AH-023` | In-flight tool-call cancellation | 1 | execution | P0 | `in-progress` | high | `AH-022` |
| `AH-024` | Retry policy with backoff | 1 | execution | P1 | `in-progress` | low | `AH-009` |
| `AH-025` | Retryable-error classification | 1 | execution | P1 | `in-progress` | low | `AH-024`, `AH-009` |
| `AH-026` | Run resume after restart | 1 | execution | P1 | `in-progress` | medium | `AH-010` |
| `AH-027` | Run checkpoints | 1 | execution | P1 | `implemented` | medium | `AH-010` |
| `AH-028` | Checkpoint rollback | 1 | execution | P1 | `implemented` | high | `AH-027` |
| `AH-029` | Stuck-loop detection | 1 | execution | P1 | `implemented` | medium | `AH-004` |
| `AH-030` | Doom-loop detection | 1 | execution | P1 | `implemented` | medium | `AH-029` |
| `AH-031` | Human takeover mid-run | 1 | execution | P1 | `implemented` | medium | `AH-022` |
| `AH-032` | Run replay from the event log | 1 | execution | P1 | `implemented` | low | `AH-005` |
| `AH-033` | Ordered allow/deny/ask evaluation | 2 | security | P0 | `implemented` | critical | `AH-007` |
| `AH-034` | Rule resource matching | 2 | security | P0 | `in-progress` | critical | `AH-033` |
| `AH-035` | Rule precedence and specificity | 2 | security | P0 | `implemented` | critical | `AH-033` |
| `AH-036` | Per-path permissions | 2 | security | P0 | `in-progress` | critical | `AH-034` |
| `AH-037` | Per-command permissions | 2 | security | P0 | `in-progress` | critical | `AH-034` |
| `AH-038` | Shell command argument parsing | 2 | security | P0 | `implemented` | high | `AH-037` |
| `AH-039` | Per-agent permissions | 2 | security | P0 | `implemented` | critical | `AH-007` |
| `AH-040` | Per-skill permissions | 2 | security | P1 | `in-progress` | high | `AH-007` |
| `AH-041` | Per-MCP-server permissions | 2 | security | P0 | `in-progress` | critical | `AH-007` |
| `AH-042` | Network egress permissions | 2 | security | P0 | `in-progress` | critical | `AH-006` |
| `AH-043` | Network domain allow/deny lists | 2 | security | P1 | `missing` | high | `AH-042` |
| `AH-044` | Secret-file protections | 2 | security | P0 | `in-progress` | critical | `AH-036` |
| `AH-045` | Secret redaction in logs and transcripts | 2 | security | P0 | `implemented` | critical | `AH-044` |
| `AH-046` | Git destructive-operation protections | 2 | security | P0 | `implemented` | critical | `AH-038` |
| `AH-047` | Temporary session-scoped approvals | 2 | security | P0 | `implemented` | high | `AH-033` |
| `AH-048` | Approval prompt contract | 2 | security | P0 | `implemented` | high | `AH-033` |
| `AH-049` | Permission decision audit log | 2 | security | P0 | `implemented` | critical | `AH-005`, `AH-033` |
| `AH-050` | Tool invocation audit log | 2 | security | P0 | `implemented` | high | `AH-049` |
| `AH-051` | Emergency kill switch | 2 | security | P0 | `in-progress` | critical | `AH-022` |
| `AH-052` | Permission policy import and export | 2 | security | P2 | `missing` | high | `AH-007` |
| `AH-053` | Repository index store | 3 | repo-intelligence | P1 | `implemented` | medium | `AH-010` |
| `AH-054` | Initial index build | 3 | repo-intelligence | P1 | `implemented` | low | `AH-053` |
| `AH-055` | Incremental index updates | 3 | repo-intelligence | P1 | `implemented` | low | `AH-053` |
| `AH-056` | Index invalidation on branch change | 3 | repo-intelligence | P2 | `implemented` | low | `AH-055` |
| `AH-057` | LSP client integration | 3 | repo-intelligence | P1 | `missing` | medium | `AH-053` |
| `AH-058` | LSP server lifecycle management | 3 | repo-intelligence | P1 | `missing` | medium | `AH-057` |
| `AH-059` | Symbol search | 3 | repo-intelligence | P1 | `implemented` | low | `AH-057` |
| `AH-060` | Find references | 3 | repo-intelligence | P1 | `missing` | low | `AH-059` |
| `AH-061` | Go to definition | 3 | repo-intelligence | P1 | `missing` | low | `AH-059` |
| `AH-062` | Call hierarchy | 3 | repo-intelligence | P2 | `missing` | low | `AH-060` |
| `AH-063` | Diagnostics collection | 3 | repo-intelligence | P1 | `missing` | low | `AH-057` |
| `AH-064` | Diagnostics surfaced to the agent | 3 | repo-intelligence | P1 | `missing` | low | `AH-063` |
| `AH-065` | Dependency graph extraction | 3 | repo-intelligence | P2 | `implemented` | low | `AH-053` |
| `AH-066` | Test-to-source mapping | 3 | repo-intelligence | P1 | `implemented` | low | `AH-065` |
| `AH-067` | Changed-file impact analysis | 3 | repo-intelligence | P1 | `implemented` | low | `AH-065` |
| `AH-068` | Framework detection | 3 | repo-intelligence | P2 | `implemented` | none | `AH-053` |
| `AH-069` | Build-system detection | 3 | repo-intelligence | P1 | `implemented` | none | `AH-068` |
| `AH-070` | Test-runner detection | 3 | repo-intelligence | P1 | `implemented` | none | `AH-068` |
| `AH-071` | Semantic code search | 3 | repo-intelligence | P2 | `in-progress` | medium | `AH-053` |
| `AH-072` | Repository health scan | 3 | repo-intelligence | P2 | `in-progress` | low | `AH-069`, `AH-070` |
| `AH-073` | Exact dispatched-payload accounting | 4 | context-memory | P0 | `in-progress` | low | `AH-078` |
| `AH-074` | Per-segment token attribution | 4 | context-memory | P1 | `implemented` | low | `AH-073` |
| `AH-075` | Compaction visibility | 4 | context-memory | P0 | `implemented` | low | `AH-004` |
| `AH-076` | Compaction strategy configuration | 4 | context-memory | P1 | `in-progress` | low | `AH-075` |
| `AH-077` | Context pressure warnings | 4 | context-memory | P1 | `in-progress` | none | `AH-073` |
| `AH-078` | Prompt snapshots | 4 | context-memory | P0 | `missing` | medium | `AH-010` |
| `AH-079` | Context replay | 4 | context-memory | P1 | `missing` | medium | `AH-078` |
| `AH-080` | Project memory | 4 | context-memory | P0 | `implemented` | medium | `AH-114` |
| `AH-081` | Session memory | 4 | context-memory | P1 | `in-progress` | medium | `AH-010` |
| `AH-082` | User-level memory | 4 | context-memory | P1 | `missing` | medium | `AH-081` |
| `AH-083` | Memory provenance | 4 | context-memory | P1 | `in-progress` | low | `AH-081` |
| `AH-084` | Memory precedence resolution | 4 | context-memory | P1 | `missing` | medium | `AH-083` |
| `AH-085` | Instruction conflict detection | 4 | context-memory | P2 | `missing` | medium | `AH-084` |
| `AH-086` | Context diffing between turns | 4 | context-memory | P2 | `missing` | low | `AH-078` |
| `AH-087` | What-the-model-saw inspector | 4 | context-memory | P1 | `in-progress` | medium | `AH-078` |
| `AH-088` | Context budget planner | 4 | context-memory | P2 | `in-progress` | low | `AH-073` |
| `AH-089` | Named agent profiles | 5 | orchestration | P0 | `implemented` | medium | `AH-007` |
| `AH-090` | Agent profile discovery | 5 | orchestration | P0 | `implemented` | medium | `AH-089` |
| `AH-091` | Per-agent model configuration | 5 | orchestration | P1 | `implemented` | low | `AH-089` |
| `AH-092` | Per-agent tool allowlist | 5 | orchestration | P0 | `implemented` | critical | `AH-039` |
| `AH-093` | Per-agent permission scope | 5 | orchestration | P0 | `implemented` | critical | `AH-039` |
| `AH-094` | Explorer agent role | 5 | orchestration | P1 | `missing` | low | `AH-089` |
| `AH-095` | Planner agent role | 5 | orchestration | P1 | `missing` | low | `AH-089`, `AH-013` |
| `AH-096` | Implementer agent role | 5 | orchestration | P1 | `missing` | medium | `AH-089` |
| `AH-097` | Reviewer agent role | 5 | orchestration | P1 | `missing` | low | `AH-089` |
| `AH-098` | Test agent role | 5 | orchestration | P1 | `missing` | medium | `AH-089` |
| `AH-099` | Security agent role | 5 | orchestration | P1 | `missing` | medium | `AH-089` |
| `AH-100` | Forked contexts | 5 | orchestration | P1 | `in-progress` | medium | `AH-078` |
| `AH-101` | Background agents | 5 | orchestration | P0 | `implemented` | medium | `AH-089` |
| `AH-102` | Background agent lifecycle control | 5 | orchestration | P1 | `in-progress` | medium | `AH-101` |
| `AH-103` | Agent-to-agent messaging | 5 | orchestration | P1 | `missing` | medium | `AH-101` |
| `AH-104` | Shared task board | 5 | orchestration | P1 | `implemented` | medium | `AH-016` |
| `AH-105` | Task dependency graph | 5 | orchestration | P1 | `implemented` | low | `AH-104` |
| `AH-106` | Ready-task scheduling | 5 | orchestration | P1 | `implemented` | medium | `AH-105` |
| `AH-107` | Per-agent git worktrees | 5 | orchestration | P0 | `in-progress` | high | `AH-012` |
| `AH-108` | Worktree lifecycle management | 5 | orchestration | P0 | `implemented` | high | `AH-107` |
| `AH-109` | Conflict-aware merge of agent output | 5 | orchestration | P0 | `in-progress` | high | `AH-107` |
| `AH-110` | Agent provenance on changes | 5 | orchestration | P1 | `in-progress` | medium | `AH-107` |
| `AH-111` | Agent restart and replacement | 5 | orchestration | P2 | `in-progress` | medium | `AH-102` |
| `AH-112` | Consensus gates | 5 | orchestration | P2 | `missing` | medium | `AH-101` |
| `AH-113` | Recursive-spawn protection | 5 | orchestration | P0 | `implemented` | high | `AH-101` |
| `AH-114` | Scoped project instruction files | 6 | integrations | P0 | `implemented` | medium | `AH-003` |
| `AH-115` | CLAUDE.md compatibility | 6 | integrations | P1 | `implemented` | medium | `AH-114` |
| `AH-116` | AGENTS.md compatibility | 6 | integrations | P1 | `implemented` | medium | `AH-114` |
| `AH-117` | Instruction precedence chain | 6 | integrations | P1 | `implemented` | medium | `AH-084` |
| `AH-118` | OpenCode agent format import | 6 | integrations | P2 | `missing` | medium | `AH-089` |
| `AH-119` | Qwen agent format import | 6 | integrations | P2 | `missing` | medium | `AH-089` |
| `AH-120` | Project-level skills | 6 | integrations | P0 | `implemented` | medium | `AH-040` |
| `AH-121` | User-level skills | 6 | integrations | P1 | `in-progress` | medium | `AH-120` |
| `AH-122` | Skill permissions | 6 | integrations | P1 | `implemented` | high | `AH-040` |
| `AH-123` | Skill versioning | 6 | integrations | P2 | `missing` | low | `AH-120` |
| `AH-124` | Skill dependency resolution | 6 | integrations | P2 | `missing` | medium | `AH-123` |
| `AH-125` | Slash commands | 6 | integrations | P0 | `implemented` | medium | `AH-003` |
| `AH-126` | Slash command argument expansion | 6 | integrations | P1 | `implemented` | medium | `AH-125` |
| `AH-127` | Lifecycle hooks | 6 | integrations | P1 | `missing` | critical | `AH-004` |
| `AH-128` | Hook sandboxing and timeouts | 6 | integrations | P1 | `missing` | critical | `AH-127` |
| `AH-129` | Hook failure policy | 6 | integrations | P1 | `missing` | high | `AH-127` |
| `AH-130` | Plugin packaging format | 6 | integrations | P1 | `implemented` | medium | `AH-003` |
| `AH-131` | Plugin installation and removal | 6 | integrations | P1 | `implemented` | high | `AH-130` |
| `AH-132` | Plugin source registry | 6 | integrations | P2 | `implemented` | medium | `AH-130` |
| `AH-133` | MCP OAuth authorization | 6 | integrations | P1 | `implemented` | critical | `AH-041` |
| `AH-134` | MCP token refresh and storage | 6 | integrations | P1 | `in-progress` | critical | `AH-133` |
| `AH-135` | MCP scopes | 6 | integrations | P2 | `missing` | high | `AH-133` |
| `AH-136` | MCP tools | 6 | integrations | P0 | `implemented` | high | `AH-041` |
| `AH-137` | MCP resources | 6 | integrations | P1 | `missing` | medium | `AH-136` |
| `AH-138` | MCP prompts | 6 | integrations | P2 | `missing` | medium | `AH-136` |
| `AH-139` | MCP server health checks | 6 | integrations | P1 | `in-progress` | medium | `AH-136` |
| `AH-140` | MCP server logs | 6 | integrations | P2 | `in-progress` | low | `AH-136` |
| `AH-141` | MCP server restart | 6 | integrations | P1 | `implemented` | medium | `AH-136` |
| `AH-142` | MCP request cancellation | 6 | integrations | P1 | `implemented` | medium | `AH-023` |
| `AH-143` | MCP pagination | 6 | integrations | P2 | `missing` | low | `AH-136` |
| `AH-144` | MCP per-server budgets | 6 | integrations | P2 | `in-progress` | medium | `AH-017` |
| `AH-145` | Compatibility bundle import and export | 6 | integrations | P2 | `in-progress` | medium | `AH-115`, `AH-116` |
| `AH-146` | Patch previews | 7 | git-workflows | P0 | `in-progress` | medium | `AH-048` |
| `AH-147` | Per-hunk approval | 7 | git-workflows | P1 | `missing` | high | `AH-146` |
| `AH-148` | Patch application with conflict detection | 7 | git-workflows | P1 | `missing` | high | `AH-147` |
| `AH-149` | Automatic formatting on edit | 7 | git-workflows | P2 | `missing` | low | `AH-150` |
| `AH-150` | Formatter detection | 7 | git-workflows | P2 | `missing` | none | `AH-069` |
| `AH-151` | Automatic test selection | 7 | git-workflows | P1 | `missing` | low | `AH-066`, `AH-067` |
| `AH-152` | Test failure clustering | 7 | git-workflows | P2 | `missing` | low | `AH-151` |
| `AH-153` | Flake detection | 7 | git-workflows | P2 | `missing` | low | `AH-151` |
| `AH-154` | Dependency-change warnings | 7 | git-workflows | P1 | `missing` | high | `AH-146` |
| `AH-155` | Lockfile-change warnings | 7 | git-workflows | P1 | `missing` | high | `AH-154` |
| `AH-156` | Migration warnings | 7 | git-workflows | P1 | `missing` | high | `AH-146` |
| `AH-157` | Secret scanning on diffs | 7 | git-workflows | P0 | `implemented` | critical | `AH-045` |
| `AH-158` | License scanning | 7 | git-workflows | P2 | `missing` | medium | `AH-154` |
| `AH-159` | Commit message generation | 7 | git-workflows | P1 | `missing` | low | `AH-146` |
| `AH-160` | Commit splitting | 7 | git-workflows | P2 | `missing` | low | `AH-159` |
| `AH-161` | Branch management | 7 | git-workflows | P1 | `in-progress` | high | `AH-046` |
| `AH-162` | Pull request creation | 7 | git-workflows | P1 | `missing` | high | `AH-161` |
| `AH-163` | Pull request description synchronization | 7 | git-workflows | P2 | `missing` | medium | `AH-162` |
| `AH-164` | Review-response mode | 7 | git-workflows | P1 | `missing` | medium | `AH-162` |
| `AH-165` | Merge conflict resolution assistance | 7 | git-workflows | P1 | `missing` | high | `AH-109` |
| `AH-166` | Rebase assistance | 7 | git-workflows | P2 | `missing` | high | `AH-165` |
| `AH-167` | Cherry-pick assistance | 7 | git-workflows | P2 | `missing` | medium | `AH-165` |
| `AH-168` | Worktree export | 7 | git-workflows | P1 | `missing` | medium | `AH-108` |
| `AH-169` | Worktree apply | 7 | git-workflows | P1 | `missing` | high | `AH-168` |
| `AH-170` | Worktree cleanup | 7 | git-workflows | P1 | `implemented` | medium | `AH-108` |
| `AH-171` | Remote divergence handling | 7 | git-workflows | P1 | `missing` | high | `AH-161` |
| `AH-172` | Live tool timeline | 8 | ux-operations | P1 | `in-progress` | none | `AH-004` |
| `AH-173` | Process tree view | 8 | ux-operations | P2 | `missing` | low | `AH-172` |
| `AH-174` | Resource usage monitor | 8 | ux-operations | P2 | `in-progress` | low | `AH-173` |
| `AH-175` | Token and cost dashboard | 8 | ux-operations | P1 | `in-progress` | low | `AH-073` |
| `AH-176` | Event replay UI | 8 | ux-operations | P2 | `in-progress` | low | `AH-032` |
| `AH-177` | Event export | 8 | ux-operations | P1 | `implemented` | medium | `AH-005` |
| `AH-178` | Searchable transcripts | 8 | ux-operations | P2 | `in-progress` | low | `AH-010` |
| `AH-179` | Screen-reader accessibility | 8 | ux-operations | P1 | `missing` | none | - |
| `AH-180` | Keyboard navigation | 8 | ux-operations | P1 | `missing` | none | `AH-179` |
| `AH-181` | Compact and verbose output modes | 8 | ux-operations | P2 | `missing` | none | `AH-172` |
| `AH-182` | Headless JSON API | 8 | ux-operations | P1 | `in-progress` | medium | `AH-008` |
| `AH-183` | Headless event-stream API | 8 | ux-operations | P1 | `missing` | medium | `AH-005`, `AH-182` |
| `AH-184` | Webhooks | 8 | ux-operations | P2 | `missing` | high | `AH-183` |
| `AH-185` | Notifications | 8 | ux-operations | P2 | `missing` | low | `AH-004` |
| `AH-186` | Project profiles | 8 | ux-operations | P2 | `missing` | medium | `AH-010` |
| `AH-187` | Organization policies | 8 | ux-operations | P1 | `missing` | critical | `AH-052` |
| `AH-188` | Secrets vault integration | 8 | ux-operations | P1 | `implemented` | critical | `AH-045` |
| `AH-189` | Proxy configuration | 8 | ux-operations | P2 | `implemented` | medium | - |
| `AH-190` | Custom CA certificates | 8 | ux-operations | P2 | `missing` | high | `AH-189` |
| `AH-191` | Usage quotas | 8 | ux-operations | P2 | `missing` | medium | `AH-017` |
| `AH-192` | Spend budgets | 8 | ux-operations | P2 | `missing` | medium | `AH-175`, `AH-191` |
| `AH-193` | Provider fallback | 8 | ux-operations | P1 | `missing` | medium | `AH-025` |
| `AH-194` | Provider routing rules | 8 | ux-operations | P2 | `in-progress` | medium | `AH-193` |
| `AH-195` | Local and offline model support | 8 | ux-operations | P1 | `in-progress` | low | - |
| `AH-196` | Benchmark harness | 8 | ux-operations | P2 | `missing` | none | `AH-011` |
| `AH-197` | Golden-repository regression suite | 8 | ux-operations | P1 | `missing` | medium | `AH-011`, `AH-196` |
| `AH-198` | Security regression corpus | 8 | ux-operations | P0 | `missing` | critical | `AH-011`, `AH-049` |
| `AH-199` | Telemetry controls | 8 | ux-operations | P1 | `rejected-with-decision` | high | - |
| `AH-200` | Full audit export | 8 | ux-operations | P1 | `in-progress` | critical | `AH-049`, `AH-177` |
| `AH-201` | Detailed in-chat activity timeline | 8 | ux-operations | P0 | `in-progress` | medium | `AH-004`, `AH-005`, `AH-177` |
| `AH-202` | Expandable project navigation | 8 | ux-operations | P1 | `missing` | low | - |
| `AH-203` | Side-by-side chat panes | 8 | ux-operations | P1 | `missing` | medium | `AH-202` |
| `AH-204` | Global permission centre | 8 | permission-security | P0 | `missing` | critical | `AH-007`, `AH-049` |
| `AH-205` | Cross-run audit export | 8 | ux-operations | P1 | `missing` | critical | `AH-177`, `AH-200`, `AH-201` |

## Audit notes

Recorded during the Phase 0 audit of `main`. Each note says why an item is not already
`implemented`, so later phases start from evidence rather than a re-audit.

- **`AH-004` Canonical harness event model** - Run lifecycle, turn boundaries, tool calls, permission decisions and budget crossings are all produced and persisted. Covers the Rust harness only; the Cowork desktop harness orchestrates in TypeScript and is not recorded yet.
- **`AH-005` Event serialization and schema versioning** - In real use: every run appends versioned envelopes to its own events.jsonl.
- **`AH-006` Tool capability model** - Capability{Read,Write,Exec,Net} covers the 16 built-ins; MCP tools carry no capability and are name-gated only. Extending the model to MCP is Phase 2 work under AH-041.
- **`AH-007` Permission model core types** - Rules are glob patterns over tool names; arguments and resources are never pattern-matched. The (subject, capability, resource) redesign is Phase 2 work under AH-034.
- **`AH-008` Run and session identity** - A run mints one RunIdentity in orchestrate_inner and every event carries it. A subagent inherits the parent's run and records under a fresh agent id rather than opening a run of its own. The legacy thread_id and session_id are still minted separately; folding them in is the remaining work.
- **`AH-009` Harness error taxonomy** - HarnessError classifies kind, retryability and audience, and preserves the existing `ERROR [tag]:` shape so migrating a call site does not change what the model sees.
- **`AH-010` Persistent state schema** - Each run writes a versioned record under <jan_data>/agent-state/runs/<run_id>/. thread.json and messages.jsonl remain unversioned.
- **`AH-012` Agent worktree conventions** - Convention is `jan/cowork/<slug>` branches under a data-directory worktree root keyed by RepoIdentity (the repo's first commit). Owned by core/agent/worktree.rs; nothing else may add a second scheme. The test reference previously pointed at src-tauri/harness/src/worktree.rs, a second worktree module that was deleted rather than reconciled with this one; the repo_health registry check (AH-072) found the dangling claim.
- **`AH-017` Token budget enforcement** - Crossing [budget] max_tokens now ends the run at the next turn boundary instead of appending a note and carrying on. on_exhausted = "continue" restores the old behaviour deliberately.
- **`AH-018` Step and iteration budget enforcement** - [budget] max_turns is configurable and enforced, completing the ceiling trio with max_tokens and max_duration_secs. It stays in-progress against its own criterion, which asks for a ceiling enforced by default: the default remains unbounded, because the config states the agent takes as many turns as the task needs and the token and wall-clock ceilings now genuinely bound a run. Choosing a non-zero default would cut off legitimate long tasks and is a product decision, not one to make silently.
- **`AH-019` Wall-clock budget enforcement** - [budget] max_duration_secs bounds a run that is cheap in tokens but stuck in a slow tool. Checked before the turn that would cross it, so no work is paid for past the deadline.
- **`AH-020` Per-tool timeouts** - Every dispatched built-in now runs under a timeout chosen by its capability class, on both the sequential and the concurrent-read paths. A timed-out call is classified as timed out rather than failed, and the model is told the call may still be running so it does not reissue a mutation still in flight. bash keeps its own inner timeout and backgrounding behaviour; this is the outer bound on the handler.
- **`AH-021` Per-run timeout** - One deadline bounds the whole orchestration: a dispatched subagent inherits what is left of it, rounded up to a second, so spawning a child is not a way around the run's deadline.
- **`AH-023` In-flight tool-call cancellation** - Foreground tool processes are killed on drop and run in their own process group, and a hung call is now abandoned on a timeout. The headless CLI leaked backgrounded bash trees on every exit -- the desktop app reaps on graceful exit, the CLI never did -- so every exit path now goes through a reaping helper, guarded by a source-level test. Still outstanding: no cancellation token, so an abandoned call is not itself killed, and a signal-terminated CLI still leaks because agent shells sit outside the terminal's process group.
- **`AH-024` Retry policy with backoff** - Retry exists for upstream HTTP only, and only before the first streamed event; tool failures are never retried.
- **`AH-025` Retryable-error classification** - Classification is local to the HTTP client.
- **`AH-026` Run resume after restart** - A resumed conversation is now handed what its interrupted run left in doubt: the run record keeps the surface's own thread id beside the harness one, and `--resume` injects a system note naming the tool calls dispatched with no recorded outcome before the new task. The in-flight turn is therefore carried forward rather than lost. Two boundaries remain: a conversation interrupted on its very first run has no saved thread to resume (threads persist only on success, which predates this work) though `runs show` still reports it, and the TUI does not yet set its thread id on the run, so the handoff is CLI-only.
- **`AH-027` Run checkpoints** - Capture, plan, restore and forget behind Tauri commands with a persisted chain; snapshot commits stay off the user's branch. The TUI is no longer the only driver.
- **`AH-028` Checkpoint rollback** - RewindPlan::{Restore,Patch}; restore refuses a UserCheckout destination, so a rewind can never rewrite the user's own checkout.
- **`AH-029` Stuck-loop detection** - A turn that asks for exactly what the previous turn asked for is treated as no progress: the model is told once, and the run is stopped if it keeps going. Deliberately narrow -- a turn of plain text, or any change to the calls, ends the streak.
- **`AH-030` Doom-loop detection** - Tool calls are fingerprinted by name and canonicalised arguments, so the same batch in a different order counts as a repeat and a partly-changed batch does not. Both the warning and the stop are recorded.
- **`AH-032` Run replay from the event log** - `jan cli agent runs show` replays a run from its persisted canonical events. An event written by a newer build is named rather than skipped, and an unmeasured duration prints as untimed rather than as zero.
- **`AH-034` Rule resource matching** - Globs match tool names only; arguments are never pattern-matched, so bash(git:*)-style rules are inexpressible.
- **`AH-036` Per-path permissions** - Path control is structural containment only; there are no user-authorable per-path allow/deny lists.
- **`AH-037` Per-command permissions** - Grants are session-scoped and per base command, so granting `git status` also permits `git push`.
- **`AH-040` Per-skill permissions** - Skills carry an availability whitelist only; skill tools are auto-allowed as workspace tools.
- **`AH-041` Per-MCP-server permissions** - advertises_mcp keys on tool name; server-level trust lives in renderer localStorage, outside the Rust gate.
- **`AH-042` Network egress permissions** - Shell egress is jailed, but Capability::Net web tools are allowed unconditionally even when allow_network is false.
- **`AH-044` Secret-file protections** - is_sensitive_name covers dotenv files, private keys and credential files, and is reachable only from the UI browse, repo-map and read commands. The model's own read/edit/bash path in tools/handlers.rs has no such check.
- **`AH-045` Secret redaction in logs and transcripts** - One detector (jan_agent_harness::secrets) redacts on the three paths where text becomes durable or is re-sent: the audit event resource field, write_journal, and the compaction summarizer input. Previously only field discipline existed, and the field it kept -- the command line -- is where credentials are passed. The wire transcript of the live turn is deliberately not rewritten: the model already saw the file it read, so rewriting the turn would break the task rather than prevent a leak. What remains before verified is the cross-platform execution the verification doc requires; the evidence recorded so far ran on Windows only.
- **`AH-046` Git destructive-operation protections** - Ten destructive operations are classified and gated as PromptKind::DestructiveGit, resolved before the base-command grant is consulted and granted only as exact command text. The escalation this closes: exec grants are per base command, so approving "git status" granted "git", which covered "git reset --hard". Ordinary git usage is untouched. On the desktop, which has no prompt round-trip, it is refused with the reason and the loss it would cause.
- **`AH-049` Permission decision audit log** - Prompts and decisions are recorded, auto-approval included -- previously the one case that converted every prompt to an allow with no trace. Covers the Rust harness only -- the CLI, the TUI, subagents and the API-server proxy, every surface reaching run_orchestration_streamed. The Cowork desktop harness orchestrates in TypeScript and is not recorded yet.
- **`AH-050` Tool invocation audit log** - Every dispatched call is recorded before it runs and again when it ends, in call order, with a duration measured around each call individually. Covers the Rust harness only; the Cowork desktop harness orchestrates in TypeScript and is not recorded yet.
- **`AH-051` Emergency kill switch** - Cancellation is per-run only; nothing halts background subagents and detached bash jobs application-wide.
- **`AH-053` Repository index store** - Persistent, versioned, one index per project under <jan_data>/agent-state/index/. An index from another schema is rebuilt rather than reinterpreted. A declaration index, not a parser: it finds declarations and never references, covers Rust, TypeScript/JavaScript, Python and Go only, skips line comments but can be fooled by a declaration inside a string literal, and honours .gitignore. Both behaviours are pinned by tests so the limits are known rather than assumed.
- **`AH-054` Initial index build** - Built on first use and refreshed at run start. Measured on this repository: 298ms cold for 1425 files and 7608 symbols, bounded by a file ceiling that is reported when hit. A declaration index, not a parser: it finds declarations and never references, covers Rust, TypeScript/JavaScript, Python and Go only, skips line comments but can be fooled by a declaration inside a string literal, and honours .gitignore. Both behaviours are pinned by tests so the limits are known rather than assumed.
- **`AH-055` Incremental index updates** - A file whose size and modification time are unchanged is not re-read; a deleted file's symbols are dropped rather than left pointing at a path that no longer exists. Measured on this repository: 81ms warm against 298ms cold.
- **`AH-056` Index invalidation on branch change** - Falls out of keying entries on size and modification time: a branch switch rewrites the files that differ, so exactly those are re-read and files absent on the new branch are dropped. A schema change discards the whole index rather than reading it as though the new fields were empty.
- **`AH-059` Symbol search** - A `symbol_search` tool, advertised on every run with a project root and in plan mode too since it is read-only. Exact matches rank before prefix before substring. A miss reports what the index does not cover and says to fall back to grep, so the model cannot read it as "this does not exist". A declaration index, not a parser: it finds declarations and never references, covers Rust, TypeScript/JavaScript, Python and Go only, skips line comments but can be fooled by a declaration inside a string literal, and honours .gitignore. Both behaviours are pinned by tests so the limits are known rather than assumed.
- **`AH-065` Dependency graph extraction** - File-level import edges, resolved only where resolution is sound: Rust `mod x;` to x.rs or x/mod.rs, relative TypeScript/JavaScript specifiers to a file or its index, relative Python imports. A bare specifier names a package rather than a file here and is deliberately left unresolved; Go imports are package-level and yield no file edge. Trustworthy in a way find-references would not be, because an import is unambiguous syntax at the top of a file.
- **`AH-066` Test-to-source mapping** - Conventions for Rust (an inline #[cfg(test)] module means the file tests itself, plus tests/<stem>.rs), TypeScript/JavaScript (.test./.spec./__tests__), Python (test_x.py, x_test.py, tests/) and Go (x_test.go). Only candidates that exist are offered. Mapping is by filename convention, not coverage: it does not know which tests exercise which code. A file with no conventionally-named test is reported as unmapped rather than omitted, because silence would read as covered, and every rendered report repeats that passing these tests does not prove a change safe.
- **`AH-067` Changed-file impact analysis** - A diff now resolves to both the tests that conventionally cover it and the files that import it one hop out, whose tests are included too -- so a change to a file with no test of its own still reaches the tests of its dependents. One hop, not a closure: further out, "affected by" stops meaning much. Still not coverage, and every report says so.
- **`AH-068` Framework detection** - Detected from a fixed set of manifests at the project root -- never a tree walk, which is the index's job -- and injected into the runtime block every run. Every claim names the file it came from, and an unrecognised project produces nothing rather than a plausible default: a confidently wrong command is worse than none, because the model runs it and the failure looks like the code's. Frameworks: React, Next.js, Vue, Svelte, Vitest, Jest, Playwright, Django, Flask, FastAPI, Tauri, and a Cargo workspace -- which matters because `cargo test` at a workspace root means every member.
- **`AH-069` Build-system detection** - Detected from a fixed set of manifests at the project root -- never a tree walk, which is the index's job -- and injected into the runtime block every run. Every claim names the file it came from, and an unrecognised project produces nothing rather than a plausible default: a confidently wrong command is worse than none, because the model runs it and the failure looks like the code's. The lockfile, not the manifest, decides the package manager: running the wrong one rewrites the other's lockfile.
- **`AH-070` Test-runner detection** - Detected from a fixed set of manifests at the project root -- never a tree walk, which is the index's job -- and injected into the runtime block every run. Every claim names the file it came from, and an unrecognised project produces nothing rather than a plausible default: a confidently wrong command is worse than none, because the model runs it and the failure looks like the code's. Only test commands with evidence behind them: a package.json `test` script that exists, a declared Makefile target, pytest named in a Python manifest.
- **`AH-071` Semantic code search** - Delivered as the `code_search` tool: a lexical multi-signal search over the declaration index -- symbol names, the words inside them (snake, kebab, dot, slash and camelCase), file paths and doc comments -- returning file, line, symbol, kind, match type and a confidence derived from the match type (exact 100, token 75, fuzzy 45, metadata 30). Ranking is deterministic: match type, then symbol name length, then path, then line, over a BTreeMap so the scan cap always falls in the same place. Query length (2..=128), result count (<=50) and scan cost (<=20000 symbols) are all bounded, and a refusal names its reason. An empty index, a capped scan and a genuine miss are three distinct outcomes, never one message. STATUS IS in-progress, NOT implemented: the registry's acceptance criterion asks for embedding search, and this is not that. No embedding model, vector store or conceptual similarity is involved, so a differently-named equivalent will not be found. Every rendered result and the tool description say so in those words rather than letting the model infer otherwise. Wiring embeddings (the rag-extension / vector-db stacks noted in the original audit) remains open work under this id. Index schema version bumped 2 -> 3 to carry the doc-comment field the metadata match reads; a version-2 index on disk is discarded and rebuilt rather than read.
- **`AH-072` Repository health scan** - Delivered as the `repo_health` tool: fourteen checks over the index and the tree -- missing index, schema mismatch, staleness (added/changed/removed), indexed files that cannot be read back, import edges whose target is gone, missing build or test command, names declared in more than one file, languages the indexer does not parse, files above the index's size ceiling, build output that reached the index, files with no conventionally-named test, feature-registry claims not backed by the tree, modules gated to one build configuration, and an unreadable scan root. Every check that could not run is listed with its reason, because a check that silently did not run reads exactly like one that passed. Findings that are usually deliberate (duplicate names, unsupported languages, configuration gates) are notes, not errors, so a report full of correct-but-uninteresting errors does not teach the reader to skip it. The report never says the repository is healthy: it runs no compiler, type checker, linter or test, and says so in every rendering. STATUS IS in-progress, NOT implemented: the registry's acceptance criterion asks for build, test, lint and dependency health, and this reports none of those four. Running them is a separate capability and stays open under this id. The scan found four real defects on its first run against this repository, two in its own code (files above the 1 MiB index ceiling reported as permanently 'added since the index was built', and a hand-written tauri-plugin-hardware/src/vendor/ directory flagged as vendored code) and two in this registry (AH-012 citing a deleted module, AH-199 claiming a file that does not exist). All four are fixed; the two code defects have regression tests.
- **`AH-073` Exact dispatched-payload accounting** - Now measures the payload actually dispatched: onPayloadShaped freezes prompt, tools, repository map and messages, and measurement reads only that record. Still no tokenizer -- it is UTF-8 bytes divided by 4, so the numbers are approximations of the right thing rather than counts.
- **`AH-074` Per-segment token attribution** - Per-category breakdown taken from the frozen dispatch; unmeasured categories report {known:false} rather than zero. Figures remain estimates until AH-073 lands a tokenizer.
- **`AH-075` Compaction visibility** - ContextShaping records what trimming and compaction removed and reports it beside the total. The Rust and TypeScript implementations are still separate (AH-076).
- **`AH-076` Compaction strategy configuration** - Two independent implementations (Rust and TypeScript) with different behaviour and thresholds.
- **`AH-077` Context pressure warnings** - Desktop shows a percentage ring; the CLI warns only when /context is invoked.
- **`AH-078` Prompt snapshots** - Closer than it was: the frozen dispatch exists in transport instance memory. Nothing writes it to disk, so it is gone when the run ends.
- **`AH-081` Session memory** - Recall is BM25 over past turns keyed by project path, not session; subagents are excluded.
- **`AH-082` User-level memory** - permanent_store exists in the workspace layer but no memory caller resolves to it.
- **`AH-083` Memory provenance** - Project files carry a path; curated notes carry a name only; BM25 recall carries neither.
- **`AH-087` What-the-model-saw inspector** - /context shows category sizes re-derived from disk, omits the date line and memory recall, and offers no text view.
- **`AH-088` Context budget planner** - should_auto_compact reserves headroom in the CLI only.
- **`AH-100` Forked contexts** - Children are isolated, not forked: they start from a fresh single-message history.
- **`AH-102` Background agent lifecycle control** - Only bulk abort_all on parent teardown exists; there is no per-agent cancel.
- **`AH-104` Shared task board** - TeamTask and TeamState carry one board across the team, settled centrally and reported through assembleReport.
- **`AH-105` Task dependency graph** - Tasks declare dependsOn; danglingDependencies and findCycle refuse a graph that could never run.
- **`AH-106` Ready-task scheduling** - readyTasks dispatches only tasks whose dependencies have completed, bounded by MAX_TEAM_PARALLEL and MAX_TEAM_TASKS.
- **`AH-107` Per-agent git worktrees** - Real git worktrees exist and Cowork team dispatch gives each isolated child its own worktree and write grant. The Rust dispatch_subagent path in loop.rs is not wired to them, so the fan-out of up to ten children there still shares one tree.
- **`AH-108` Worktree lifecycle management** - ensure/state/discard/list/prune over real `git worktree` invocations; WorktreeState reports Missing, Corrupt, BranchMoved and IdentityChanged and refuses rather than rebinding.
- **`AH-109` Conflict-aware merge of agent output** - Pre-flight conflict detection exists: conflicts() reports a shared write target between two tasks with no ordering between them. Merging an agent's worktree back is absent -- output is a branch and a diff the user lands manually.
- **`AH-110` Agent provenance on changes** - Events carry the agent that produced them, and a child's agent id names its parent. File changes still carry no agent attribution.
- **`AH-111` Agent restart and replacement** - MAX_TASK_RETRIES bounds automatic re-runs of a failed task; an agent cannot be restarted or replaced individually.
- **`AH-115` CLAUDE.md compatibility** - Ingested only after the user switches compatibility on for a folder, wrapped and labelled with its source file, ranked below JAN.md, and capped at 64 KiB.
- **`AH-116` AGENTS.md compatibility** - Same opt-in, labelling, ranking and size cap as CLAUDE.md.
- **`AH-117` Instruction precedence chain** - INSTRUCTION_PRECEDENCE with instructionOrder and scopedInstructionChain; no instruction file can move the repository, grant a tool or redirect changes however it is phrased.
- **`AH-121` User-level skills** - CompatSource covers project, user and plugin scopes for imported skills. Native Jan skills still resolve the project scope only in the CLI.
- **`AH-127` Lifecycle hooks** - The largest single compatibility gap; no hook registry exists anywhere in the codebase.
- **`AH-134` MCP token refresh and storage** - Refresh and expiry handling are not verified as complete.
- **`AH-139` MCP server health checks** - Liveness is probed by calling a tool that happens to be named `ping`, not by the protocol ping.
- **`AH-140` MCP server logs** - Server stderr goes to the application logger with no per-server view.
- **`AH-144` MCP per-server budgets** - Truncation is global, not per server, and is not budget-aware.
- **`AH-145` Compatibility bundle import and export** - CompatibilityManifest models an imported bundle and its components; there is no export path back out.
- **`AH-146` Patch previews** - The approval event carries a whole-change diff; there is no reviewable staged patch.
- **`AH-157` Secret scanning on diffs** - Two independent checks, both using the same detector as AH-045: the added lines of a write/edit diff, scanned between computing the diff and performing the write so a refusal leaves nothing on disk; and git diff --cached before a commit, because staging can reach the index without the write tools. Only added lines are scanned, so a key already in a file does not make that file uneditable. A guard that cannot run returns an error rather than a pass.
- **`AH-159` Commit message generation** - No git tool exists; git is reachable only through bash, and git.rs commits are internal snapshots.
- **`AH-161` Branch management** - The harness creates and deletes its own jan/cowork/* branches. There is no agent-facing git tool: the model reaches git only through bash, under per-base-command grants.
- **`AH-170` Worktree cleanup** - discard refuses while uncommitted changes exist unless forced, and names the files; prune and list recover strays.
- **`AH-172` Live tool timeline** - Subagent lanes and bash jobs are shown; there is no unified tool timeline.
- **`AH-174` Resource usage monitor** - Only host-level CPU and RAM; nothing is attributed per run or per agent.
- **`AH-175` Token and cost dashboard** - Tokens are tracked; there is no pricing model or cost figure anywhere in the product.
- **`AH-176` Event replay UI** - The CLI replays a rendering journal; there is no event-level replay UI.
- **`AH-177` Event export** - `jan cli agent runs export` emits the run record and every event as JSON, round-tripping back into the same types.
- **`AH-178` Searchable transcripts** - `jan cli agent runs list` makes past runs enumerable from the CLI and `show` renders one. Content search across runs is still absent; the desktop app searches threads, not runs.
- **`AH-179` Screen-reader accessibility** - Not audited in depth during Phase 0; status to be confirmed by an accessibility pass in Phase 8.
- **`AH-180` Keyboard navigation** - Not audited in depth during Phase 0; the CLI is keyboard-driven by nature, the desktop surfaces are unverified.
- **`AH-182` Headless JSON API** - --output-format json emits a single terminal object, not a machine API surface.
- **`AH-183` Headless event-stream API** - StreamEvent is already Tauri-free but is never exposed over stdout or a socket.
- **`AH-194` Provider routing rules** - Resolution prefers a credentialed provider and supports a small-model role; there are no user-authored rules.
- **`AH-195` Local and offline model support** - Local inference ships on the desktop app; the headless CLI is remote-only.
- **`AH-199` Telemetry controls** - Previously reverted to missing because it named web-app/src/containers/analytics/AnalyticConsent.tsx, which never existed in this tree. Now rejected with a decision: the telemetry it would have gated is gone, and a guard test keeps it gone.
- **`AH-200` Full audit export** - Permission decisions, tool calls and run events export together as one reviewable record per run, auto-approvals included. Still per-run rather than across runs, and it covers the Rust harness only -- the Cowork desktop harness records nothing to export.
- **`AH-201` Detailed in-chat activity timeline** - The canonical log, its store, the recorder and the inline timeline exist and are wired: the desktop run driver records a pending row when a tool call starts and settles the same row when it exits, and the conversation renders reads with line ranges, changes with diffs and line counts, commands with working directory, exit code, duration and output, permission decisions, git operations (destructive marked), retries and cancellations. Filtering, search, expansion, copy, file navigation, truncation, virtualization, persistence, session isolation, redaction and accessible labels are covered by 68 tests. Still in-progress because the other three surfaces have not been moved onto it: the activity rail and the Background Tasks panel still project coworkActivity, and the audit export still reads the Rust event log only. Also web-app only -- the Rust harness records its own events and the two logs are not yet one.
- **`AH-202` Expandable project navigation** - Requested directly by the operator and absent from the original 200-item backlog.
- **`AH-203` Side-by-side chat panes** - Requested directly by the operator and absent from the original 200-item backlog. Pane-scoped permission state depends on the permission model (AH-007) being addressable per session.
- **`AH-204` Global permission centre** - Requested directly by the operator. The gate, the decision events (AH-049) and the per-request registry exist, but a request is answerable only in the conversation that raised it, and nothing aggregates or expires them.
- **`AH-205` Cross-run audit export** - Splits the cross-run half out of AH-200, which is implemented per run and for the Rust harness only. Requested by the operator as "full audit export".
