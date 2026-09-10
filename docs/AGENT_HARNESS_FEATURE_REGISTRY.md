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
| 0 | Foundation | 0 | 0 | 0 | 12 | 0 | 0 | 0 | 12 |
| 1 | Core execution | 0 | 0 | 2 | 18 | 0 | 0 | 0 | 20 |
| 2 | Security and permissions | 1 | 0 | 1 | 18 | 0 | 0 | 0 | 20 |
| 3 | Repository intelligence | 18 | 0 | 2 | 0 | 0 | 0 | 0 | 20 |
| 4 | Context and memory | 2 | 0 | 8 | 6 | 0 | 0 | 0 | 16 |
| 5 | Agent orchestration | 8 | 0 | 6 | 11 | 0 | 0 | 0 | 25 |
| 6 | Compatibility and integrations | 11 | 0 | 6 | 15 | 0 | 0 | 0 | 32 |
| 7 | Coding and Git workflows | 20 | 0 | 4 | 2 | 0 | 0 | 0 | 26 |
| 8 | UX, automation and operations | 17 | 0 | 6 | 6 | 0 | 0 | 0 | 29 |
| 9 | Approved additions | 9 | 0 | 0 | 1 | 0 | 0 | 0 | 10 |
| **all** | | **86** | **0** | **35** | **89** | **0** | **0** | **0** | **210** |

## Ownership lanes

Each lane owns its files exclusively. Two lanes never edit the same module in the same
phase; where a change crosses a boundary the owning lane makes it and the other lane
consumes the result.

| Lane | Features |
| --- | --- |
| `lane-01-architecture-registry` | 12 (AH-001-AH-012) |
| `lane-02-execution-runtime` | 20 (AH-013-AH-032) |
| `lane-03-permission-security` | 20 (AH-033-AH-052) |
| `lane-04-repo-index-lsp` | 20 (AH-053-AH-072) |
| `lane-05-context-memory` | 16 (AH-073-AH-088) |
| `lane-06-agents-worktrees` | 25 (AH-089-AH-113) |
| `lane-07-mcp-skills-plugins` | 32 (AH-114-AH-145) |
| `lane-08-git-pr-workflows` | 26 (AH-146-AH-171) |
| `lane-09-ux-observability` | 16 (AH-172-AH-200) |
| `lane-10-provider-enterprise` | 10 (AH-186-AH-195) |
| `lane-12-security-regression-review` | 3 (AH-196-AH-198) |
| `lane-21-sessions` | 3 (AH-201-AH-210) |
| `lane-22-checkpoints` | 1 (AH-202-AH-202) |
| `lane-23-composer` | 2 (AH-204-AH-205) |
| `lane-24-navigation` | 2 (AH-206-AH-207) |
| `lane-25-agents` | 1 (AH-208-AH-208) |
| `lane-26-projects` | 1 (AH-209-AH-209) |

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
| `AH-006` | Tool capability model | 0 | foundation | P0 | `implemented` | high | `AH-003` |
| `AH-007` | Permission model core types | 0 | foundation | P0 | `implemented` | critical | `AH-006` |
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
| `AH-018` | Step and iteration budget enforcement | 1 | execution | P0 | `implemented` | medium | `AH-017` |
| `AH-019` | Wall-clock budget enforcement | 1 | execution | P1 | `implemented` | medium | `AH-017` |
| `AH-020` | Per-tool timeouts | 1 | execution | P0 | `implemented` | medium | `AH-009` |
| `AH-021` | Per-run timeout | 1 | execution | P1 | `implemented` | medium | `AH-019` |
| `AH-022` | Cancellation propagation | 1 | execution | P0 | `implemented` | high | `AH-008` |
| `AH-023` | In-flight tool-call cancellation | 1 | execution | P0 | `implemented` | high | `AH-022` |
| `AH-024` | Retry policy with backoff | 1 | execution | P1 | `implemented` | low | `AH-009` |
| `AH-025` | Retryable-error classification | 1 | execution | P1 | `implemented` | low | `AH-024`, `AH-009` |
| `AH-026` | Run resume after restart | 1 | execution | P1 | `in-progress` | medium | `AH-010` |
| `AH-027` | Run checkpoints | 1 | execution | P1 | `implemented` | medium | `AH-010` |
| `AH-028` | Checkpoint rollback | 1 | execution | P1 | `implemented` | high | `AH-027` |
| `AH-029` | Stuck-loop detection | 1 | execution | P1 | `implemented` | medium | `AH-004` |
| `AH-030` | Doom-loop detection | 1 | execution | P1 | `implemented` | medium | `AH-029` |
| `AH-031` | Human takeover mid-run | 1 | execution | P1 | `implemented` | medium | `AH-022` |
| `AH-032` | Run replay from the event log | 1 | execution | P1 | `in-progress` | low | `AH-005` |
| `AH-033` | Ordered allow/deny/ask evaluation | 2 | security | P0 | `implemented` | critical | `AH-007` |
| `AH-034` | Rule resource matching | 2 | security | P0 | `implemented` | critical | `AH-033` |
| `AH-035` | Rule precedence and specificity | 2 | security | P0 | `implemented` | critical | `AH-033` |
| `AH-036` | Per-path permissions | 2 | security | P0 | `implemented` | critical | `AH-034` |
| `AH-037` | Per-command permissions | 2 | security | P0 | `implemented` | critical | `AH-034` |
| `AH-038` | Shell command argument parsing | 2 | security | P0 | `implemented` | high | `AH-037` |
| `AH-039` | Per-agent permissions | 2 | security | P0 | `implemented` | critical | `AH-007` |
| `AH-040` | Per-skill permissions | 2 | security | P1 | `in-progress` | high | `AH-007` |
| `AH-041` | Per-MCP-server permissions | 2 | security | P0 | `implemented` | critical | `AH-007` |
| `AH-042` | Network egress permissions | 2 | security | P0 | `implemented` | critical | `AH-006` |
| `AH-043` | Network domain allow/deny lists | 2 | security | P1 | `implemented` | high | `AH-042` |
| `AH-044` | Secret-file protections | 2 | security | P0 | `implemented` | critical | `AH-036` |
| `AH-045` | Secret redaction in logs and transcripts | 2 | security | P0 | `implemented` | critical | `AH-044` |
| `AH-046` | Git destructive-operation protections | 2 | security | P0 | `implemented` | critical | `AH-038` |
| `AH-047` | Temporary session-scoped approvals | 2 | security | P0 | `implemented` | high | `AH-033` |
| `AH-048` | Approval prompt contract | 2 | security | P0 | `implemented` | high | `AH-033` |
| `AH-049` | Permission decision audit log | 2 | security | P0 | `implemented` | critical | `AH-005`, `AH-033` |
| `AH-050` | Tool invocation audit log | 2 | security | P0 | `implemented` | high | `AH-049` |
| `AH-051` | Emergency kill switch | 2 | security | P0 | `implemented` | critical | `AH-022` |
| `AH-052` | Permission policy import and export | 2 | security | P2 | `missing` | high | `AH-007` |
| `AH-053` | Repository index store | 3 | repo-intelligence | P1 | `in-progress` | medium | `AH-010` |
| `AH-054` | Initial index build | 3 | repo-intelligence | P1 | `in-progress` | low | `AH-053` |
| `AH-055` | Incremental index updates | 3 | repo-intelligence | P1 | `missing` | low | `AH-053` |
| `AH-056` | Index invalidation on branch change | 3 | repo-intelligence | P2 | `missing` | low | `AH-055` |
| `AH-057` | LSP client integration | 3 | repo-intelligence | P1 | `missing` | medium | `AH-053` |
| `AH-058` | LSP server lifecycle management | 3 | repo-intelligence | P1 | `missing` | medium | `AH-057` |
| `AH-059` | Symbol search | 3 | repo-intelligence | P1 | `missing` | low | `AH-057` |
| `AH-060` | Find references | 3 | repo-intelligence | P1 | `missing` | low | `AH-059` |
| `AH-061` | Go to definition | 3 | repo-intelligence | P1 | `missing` | low | `AH-059` |
| `AH-062` | Call hierarchy | 3 | repo-intelligence | P2 | `missing` | low | `AH-060` |
| `AH-063` | Diagnostics collection | 3 | repo-intelligence | P1 | `missing` | low | `AH-057` |
| `AH-064` | Diagnostics surfaced to the agent | 3 | repo-intelligence | P1 | `missing` | low | `AH-063` |
| `AH-065` | Dependency graph extraction | 3 | repo-intelligence | P2 | `missing` | low | `AH-053` |
| `AH-066` | Test-to-source mapping | 3 | repo-intelligence | P1 | `missing` | low | `AH-065` |
| `AH-067` | Changed-file impact analysis | 3 | repo-intelligence | P1 | `missing` | low | `AH-065` |
| `AH-068` | Framework detection | 3 | repo-intelligence | P2 | `missing` | none | `AH-053` |
| `AH-069` | Build-system detection | 3 | repo-intelligence | P1 | `missing` | none | `AH-068` |
| `AH-070` | Test-runner detection | 3 | repo-intelligence | P1 | `missing` | none | `AH-068` |
| `AH-071` | Semantic code search | 3 | repo-intelligence | P2 | `missing` | medium | `AH-053` |
| `AH-072` | Repository health scan | 3 | repo-intelligence | P2 | `missing` | low | `AH-069`, `AH-070` |
| `AH-073` | Exact dispatched-payload accounting | 4 | context-memory | P0 | `implemented` | low | `AH-078` |
| `AH-074` | Per-segment token attribution | 4 | context-memory | P1 | `implemented` | low | `AH-073` |
| `AH-075` | Compaction visibility | 4 | context-memory | P0 | `implemented` | low | `AH-004` |
| `AH-076` | Compaction strategy configuration | 4 | context-memory | P1 | `in-progress` | low | `AH-075` |
| `AH-077` | Context pressure warnings | 4 | context-memory | P1 | `in-progress` | none | `AH-073` |
| `AH-078` | Prompt snapshots | 4 | context-memory | P0 | `implemented` | medium | `AH-010` |
| `AH-079` | Context replay | 4 | context-memory | P1 | `missing` | medium | `AH-078` |
| `AH-080` | Project memory | 4 | context-memory | P0 | `implemented` | medium | `AH-114` |
| `AH-081` | Session memory | 4 | context-memory | P1 | `in-progress` | medium | `AH-010` |
| `AH-082` | User-level memory | 4 | context-memory | P1 | `in-progress` | medium | `AH-081` |
| `AH-083` | Memory provenance | 4 | context-memory | P1 | `in-progress` | low | `AH-081` |
| `AH-084` | Memory precedence resolution | 4 | context-memory | P1 | `in-progress` | medium | `AH-083` |
| `AH-085` | Instruction conflict detection | 4 | context-memory | P2 | `in-progress` | medium | `AH-084` |
| `AH-086` | Context diffing between turns | 4 | context-memory | P2 | `missing` | low | `AH-078` |
| `AH-087` | What-the-model-saw inspector | 4 | context-memory | P1 | `in-progress` | medium | `AH-078` |
| `AH-088` | Context budget planner | 4 | context-memory | P2 | `implemented` | low | `AH-073` |
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
| `AH-147` | Per-hunk approval | 7 | git-workflows | P1 | `in-progress` | high | `AH-146` |
| `AH-148` | Patch application with conflict detection | 7 | git-workflows | P1 | `in-progress` | high | `AH-147` |
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
| `AH-172` | Live tool timeline | 8 | ux-operations | P1 | `implemented` | none | `AH-004` |
| `AH-173` | Process tree view | 8 | ux-operations | P2 | `missing` | low | `AH-172` |
| `AH-174` | Resource usage monitor | 8 | ux-operations | P2 | `in-progress` | low | `AH-173` |
| `AH-175` | Token and cost dashboard | 8 | ux-operations | P1 | `in-progress` | low | `AH-073` |
| `AH-176` | Event replay UI | 8 | ux-operations | P2 | `in-progress` | low | `AH-032` |
| `AH-177` | Event export | 8 | ux-operations | P1 | `missing` | medium | `AH-005` |
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
| `AH-195` | Local and offline model support | 8 | ux-operations | P1 | `implemented` | low | - |
| `AH-196` | Benchmark harness | 8 | ux-operations | P2 | `missing` | none | `AH-011` |
| `AH-197` | Golden-repository regression suite | 8 | ux-operations | P1 | `missing` | medium | `AH-011`, `AH-196` |
| `AH-198` | Security regression corpus | 8 | ux-operations | P0 | `implemented` | critical | `AH-011`, `AH-049` |
| `AH-199` | Telemetry controls | 8 | ux-operations | P1 | `implemented` | high | - |
| `AH-200` | Full audit export | 8 | ux-operations | P1 | `missing` | critical | `AH-049`, `AH-177` |
| `AH-201` | Conversation and session forking | 9 | sessions | P2 | `implemented` | medium | `AH-078` |
| `AH-202` | User-facing message and file undo/redo | 9 | checkpoints | P2 | `missing` | high | `AH-146` |
| `AH-203` | Portable conversation import and export | 9 | sessions | P2 | `missing` | high | `AH-201` |
| `AH-204` | Unified @ reference autocomplete | 9 | composer | P2 | `missing` | medium | - |
| `AH-205` | Persistent reference aliases | 9 | composer | P2 | `missing` | medium | `AH-204` |
| `AH-206` | Local command palette | 9 | navigation | P2 | `missing` | low | - |
| `AH-207` | Customizable keybindings | 9 | navigation | P2 | `missing` | low | `AH-206` |
| `AH-208` | Hidden internal utility agents | 9 | agents | P2 | `missing` | high | `AH-107` |
| `AH-209` | Project initialization assistant | 9 | projects | P2 | `missing` | medium | `AH-204` |
| `AH-210` | Portable PC-to-PC handoff bundle | 9 | sessions | P2 | `missing` | high | `AH-203`, `AH-146` |

## Audit notes

Recorded during the Phase 0 audit of `main`. Each note says why an item is not already
`implemented`, so later phases start from evidence rather than a re-audit.

- **`AH-004` Canonical harness event model** - Canonical model landed in jan-agent-harness. StreamEvent is still never persisted, so replay, audit and export have no source; migrating the emitters is Phase 1 work (lane-02).
- **`AH-005` Event serialization and schema versioning** - Versioned envelope, forward-compatible reader and a crash-tolerant JSONL log. Adopted by the run store in Phase 1.
- **`AH-006` Tool capability model** - Capability{Read,Write,Exec,Net} now pairs with a canonical Resource (path, command, mcp, net, process, unknown) derived per call inside resolve_decision and consumed by the production gate. An argument that is present but unreadable becomes Resource::Unknown, which no allow rule matches and every deny rule does; the gate refuses it as DenyReason::Resource, and the production call site in commands.rs returns a message naming what could not be resolved. An absent argument stays the handler's schema business. MCP tools still carry no capability -- that remains AH-041.
- **`AH-007` Permission model core types** - Subject, capability and canonical resource are all matched, and all three reach production. `resolve_decision` takes the subject; `is_denied`/`is_allowed`/`advertises_mcp` take it too, so a rule naming one subagent no longer removes the tool from every agent's advertised toolset; `intersect_allowed_tools` reads the parent's rules for the child by the name it is dispatched under. A run's subject is decided once in `orchestrate_inner` from `OrchestrationArgs::agent_name`, which `run_subagent` sets on the child's cloned args, so the advertising pass, the MCP prune and the dispatcher cannot disagree about who is asking. An unqualified rule still covers every subject; an unknown subject matches no rule and is permitted by none. Documented in AGENT_HARNESS_ARCHITECTURE.md (AHD-005) and AGENT_HARNESS_VERIFICATION.md. Not `verified`: the generic cancellation criterion has no test on this path, and the dispatcher-level test in loop.rs runs under --features test-tauri (the 0xc0000139 seen earlier was the cowork-smoke feature combination, documented in build.rs, not the host); an earlier version of that test hung on an unanswered prompt and was fixed.
- **`AH-008` Run and session identity** - RunIdentity ties run, thread, session and agent together. The three existing ids are migrated onto it in Phase 1 (lane-02).
- **`AH-009` Harness error taxonomy** - HarnessError classifies kind, retryability and audience, and preserves the existing `ERROR [tag]:` shape so migrating a call site does not change what the model sees.
- **`AH-010` Persistent state schema** - Versioned run record with an atomic writer, strict version reads and interrupted-run detection. The existing thread.json and messages.jsonl remain unversioned until Phase 1 migrates them.
- **`AH-012` Agent worktree conventions** - Convention is `jan/cowork/<slug>` branches under a data-directory worktree root keyed by RepoIdentity (the repo's first commit). Owned by core/agent/worktree.rs; nothing else may add a second scheme.
- **`AH-017` Token budget enforcement** - The ceiling now stops the run. Crossing it used to record a system note and carry on, tool calls included, which -- with max_turns == 0 the normal case -- left user cancellation as the only bound on a run's spend: a run that went wrong could spend without limit while announcing that it had passed its limit. run_turn_cycle now returns as soon as the budget is exhausted. The turn that crossed the line is finished and returned intact, so its text and its tool_calls are preserved in the transcript; what stops is the next thing -- the tool calls that turn asked for are not dispatched and no further turn is taken. The system note says how many calls were skipped. Note that the pre-existing test an_exhausted_budget_is_announced_once_and_the_run_continues asserted the advisory behaviour this item exists to remove; it was replaced by an_exhausted_budget_is_announced_once_in_the_system_voice, which keeps its system-voice and once-only assertions and inverts the continuation one.
- **`AH-018` Step and iteration budget enforcement** - A step is one model turn; the cap is checked before the step that would exceed it, spend is persisted per step in the session's runBudget so a restart does not hand a half-finished run a fresh allowance, and the run ends with one canonical reason.
- **`AH-019` Wall-clock budget enforcement** - Absolute wall-clock deadline per run, including time spent waiting on models, tools and permissions. Persisted and restored; a deadline that passed while the app was closed is expired, and a backwards clock jump restarts the budget rather than expiring everything.
- **`AH-020` Per-tool timeouts** - Every built-in now runs under a deadline, not just bash. lifecycle::Timeouts gives a default plus per-tool limits and overrides, and an unknown tool gets the default rather than no limit. execute_builtin wraps the handler in run_with_deadline, so the clock starts when execution starts -- after the gate, not while a call waited for approval -- and a stopped call reports whether it hit a deadline or a person. The bash timeout previously *backgrounded* the command: it kept running, unowned, after the call returned, so the deadline and the stop were unrelated events. It now terminates the process tree, preserves whatever the command printed first, and warns rather than claiming success if the tree did not die; backgrounding survives as an explicit background:true argument. CORRECTION to the prior audit note: MCP tool calls already had both a timeout and a cancellation channel (core/mcp/commands.rs:494-506, tool_call_timeout_duration); the claim that they had none was wrong. Timeouts are proved with tokio's paused clock, so the tests assert deadlines without waiting for them. REMAINING: a timeout does not yet emit an activity/audit event of its own; that arrives with the AH-050 tool-invocation log.
- **`AH-021` Per-run timeout** - operationSignal chains a per-operation timeout to the run's own signal, so a stream that goes quiet and a user's Stop cancel identically; a timeout produces one terminal transition distinct from an abort, and terminalReason collapses simultaneous limits to one.
- **`AH-023` In-flight tool-call cancellation** - Cancellation reaches every path. lifecycle::Token is scoped to session/run/call, records why it stopped (first reason wins), owns and reaps child pids, kills a child adopted after cancellation so the spawn/cancel race cannot leak a process, and refuses results that arrive after the stop. CompositeToolInvoker owns the run's scope; all three dispatch paths (parallel reads, direct allow, both post-prompt branches) mint a call token under it and hold the guard across the await. The permission wait races the token, removes the pending request either way so the approval UI stops offering it, and treats an answer for an already-stopped call as stale. MCP calls race the canonical token, joining the pre-existing oneshot channel and timeout at core/mcp/commands.rs rather than replacing them; a batch completing during a stop is discarded. Retry backoff is cancellable through a task-local token -- the provider retry loop sits several calls below the dispatcher -- and stays scope-precise, proved by a test that one run's stop does not end another run's backoff. Subagents capture the parent token at spawn (a spawned task inherits no task-locals), get their own token under the parent's scope, race their body against it, and resolve to Cancelled rather than reporting a late answer. The AH-049 cancelled outcome has a single producer in CompositeToolInvoker::cancelled, which writes the transcript message and the audit record together. Guards mutation-checked: accepting late results, and ignoring scope boundaries, each turn the relevant tests red. Incidental safety fix: resolve_jan_data_folder had no cfg(test) redirect, so a cargo test run would have appended audit records to the data folder of whoever ran it.
- **`AH-024` Retry policy with backoff** - Bounded exponential backoff with full jitter, capped, honouring Retry-After in both spellings; waits are cancellable and a cut-short wait is never mistaken for a completed one. Each attempt is a fresh dispatch with its own invocation and snapshot.
- **`AH-025` Retryable-error classification** - Typed classification: transient, rate-limited, auth, invalid, refused, cancelled, deterministic, unknown. Only transient and rate-limited are eligible; auth, permissions, invalid input, refusals, cancellation and deterministic tool failures are never retried.
- **`AH-026` Run resume after restart** - State is written at turn boundaries only, so an interrupted turn is unrecoverable; resume lives in the CLI layer.
- **`AH-027` Run checkpoints** - Capture, plan, restore and forget behind Tauri commands with a persisted chain; snapshot commits stay off the user's branch. The TUI is no longer the only driver.
- **`AH-028` Checkpoint rollback** - RewindPlan::{Restore,Patch}; restore refuses a UserCheckout destination, so a rewind can never rewrite the user's own checkout.
- **`AH-029` Stuck-loop detection** - detectLoop counts repeated identical calls, canonically equivalent calls, and repeated identical failures from what actually happened, and stops the run. The model cannot waive it.
- **`AH-030` Doom-loop detection** - No-progress edit/revert cycles and recursive delegation depth are detected alongside the repeat guards, stopping the run before it spends its whole step budget going in circles.
- **`AH-032` Run replay from the event log** - display.jsonl is a rendering journal; StreamEvent is never persisted, so runs cannot be replayed or audited.
- **`AH-034` Rule resource matching** - Rules are ResourceRules: `tool` or `tool(pattern)`. bash(git:force-push) and read(**/.ssh/**) are now expressible, closing the gap where globs matched tool names only and arguments were never pattern-matched. Paths are lexically normalized and URLs canonicalized before matching, so one resource has one spelling and a rule cannot be dodged by rewriting the argument (proved by a test that spells the same file three ways). ToolPermissions holds one compiled rule set; is_denied/is_allowed are name-only views over it rather than a second representation.
- **`AH-036` Per-path permissions** - User-authorable per-path allow/deny rules from the project's agent.toml now reach the desktop gate, which previously built ToolPermissions::default() (allow everything). A relative rule such as read(secrets/**) also matches, anchored at a directory boundary; before this it compiled, was accepted, and matched nothing.
- **`AH-037` Per-command permissions** - Per-command rules (bash(git:force-push), bash(rm)) already worked; the interactive grant did not. grant_command recorded the base commands a string ran, so approving `git status` granted `git` and covered `git push` for the session, and approving a compound handed over every base inside it -- `git status && rm foo` granted `rm`, so `rm bar` ran unprompted. A grant is now the exact normalized command the user was shown: same command with different spacing is covered, a changed flag, path or order is a new decision. That also closes the composition routes by construction, since `&&`, `|`, `;` and `$(...)` all produce a string that was never approved. Desktop was checked and was never affected: `bash` is in AGENT_TOOL_NAMES, so it is auto-allowed in the renderer and gated in Rust, and the renderer per-thread approval (keyed on tool name) never covers it. The change is on the CLI/Cowork path, where the grant lives. Two pre-existing tests asserted the old behaviour and were rewritten to the new intent rather than deleted, with comments saying what they used to claim. Not `verified`: no cancellation test on this path, and no WebView scenario -- the CLI prompt flow is not driven by cowork-smoke.
- **`AH-038` Shell command argument parsing** - Each shell now declares the command language it speaks and is chosen by probing it under the real sandbox policy, not by assuming: on Windows the MSYS2 runtime Git Bash is built on cannot initialise inside an AppContainer, so a command needing POSIX syntax is refused with that reason rather than reinterpreted by cmd or PowerShell. The sandboxed environment block is built in one place (win_env), which is what fixes CreateProcessW failing with ERROR_ENVVAR_NOT_FOUND (203) for a missing LOCALAPPDATA. Readiness is now eight independently probed components rather than one boolean: a shell that cannot start costs the session its shell tool and nothing else. `advertised_tool_schemas` is the single production decision about what a model is offered, and both call sites (Cowork's tool builder, the chat transport) go through it; omissions keep their reason. The Cowork tool signature includes readiness state, so a retry that fixes a shell changes the tool set on the next message. A collapsed Environment section in session details renders the same report, and its Git Bash row names MSYS2 rather than an install location.
- **`AH-040` Per-skill permissions** - Skills carry an availability whitelist only; skill tools are auto-allowed as workspace tools.
- **`AH-041` Per-MCP-server permissions** - Trust keys on the MCP server, never on a tool name: a tool name is chosen by whoever publishes it, so two servers can both publish `fetch` and a call naming no server is answered by whichever the search reaches first. `mcp_trust` holds the per-server record, persisted to <jan_data>/mcp-trust.json with an atomic rename, and `call_tool` checks it against the server the tool was resolved on, before the arguments are sent. An "allow once" answer is a single-use, short-lived ticket that is never written to disk, so it cannot become a standing permission; a ticket is spent even when it does not match, so it cannot be retried against another server. An unreadable trust file trusts nothing. Scope: this moves the persisted decision into the backend and makes every call carry a backend-issued authorization. It is not a defence against the renderer, which is the thing that asks the user and can mint a ticket. Not `verified`: no test covers the generic cancellation criterion, and the Cowork/CLI path keeps its own separate MCP gate (SessionGrants::covers_mcp) rather than sharing this one.
- **`AH-042` Network egress permissions** - A Capability::Net call is refused when the run has no network. allow_network previously confined only the shell, so a run with its network off could still fetch a URL.
- **`AH-043` Network domain allow/deny lists** - allow_domains/deny_domains from agent.toml, matched on domain boundaries so a lookalike host cannot pass for an allowed one; deny is checked first and cannot be overridden by allow.
- **`AH-044` Secret-file protections** - Credential-bearing files are refused by the canonical gate, not only by the UI browse path. A blanket allow does not open them; a rule naming the file does.
- **`AH-045` Secret redaction in logs and transcripts** - Tool output the renderer persists into a thread now passes through `secrets::redact_secrets` via the `secrets_redact` command, at a single gate in the thread route -- every `addToolOutput` call site goes through it and none bypasses it. `redact_secrets` gained the word-level pass it was missing: it previously only recognised the assignment shape, so a credential in prose (a `curl -v` trace, an error quoting an `Authorization` header) was written verbatim, and when `classify_line` did recognise one the whole line was replaced, losing the sentence saying where it came from. Word-level replacement now runs first and the line-level pass is the fallback for values with no recognisable shape. Failure withholds the text rather than storing it raw, including when the call returns a non-string. The route test is mutation-checked: removing the redaction call fails it. Not `verified`: no test covers the generic cancellation criterion on this path, and redaction of MCP output happens at the renderer boundary rather than inside the MCP client, so a future second consumer of that client would need its own gate.
- **`AH-046` Git destructive-operation protections** - GitOp::classify recognises reset --hard/--merge/--keep, clean -f/-x/-d, force push (flag or +refspec), destructive checkout/restore, branch deletion, and history rewriting (rebase, filter-branch, commit --amend, reflog delete, gc --prune) from parsed argv, skipping git's own global options so `git -C /x push -f` is still a force push. Detection is structural, not substring: `echo 'git push --force'` and a commit message mentioning `reset --hard` are not flagged, and a mutation substituting substring matching turns those tests red. A destructive operation is refused with DenyReason::DestructiveGit unless a rule names it; a blanket allow=["bash"] does not count. Every decision reaches the AH-049 log.
- **`AH-049` Permission decision audit log** - Append-only JSONL at <jan_data>/audit/permissions.jsonl, one record per resource per decision, written from the production call site in commands.rs before the decision is acted on, so a refusal that returns early is still logged. Each record carries schema version, RFC3339 UTC timestamp, session, run, call, agent, project, tool, capability, resource kind and value, decision and reason. Secrets are redacted before the record is constructed, so a credential on a command line never reaches disk. The reader drops an unparseable line, so a process killed mid-write costs that record and nothing before it. Query and export are in place for the permission centre. NOTE: allow/deny/prompt have producers today; expired, revoked, stale and cancelled are representable and round-trip tested but are produced by the grant lifecycle, which lands with AH-023/AH-041. The registry's cited writer, harness/src/envelope.rs, does not exist in this tree; crash tolerance mirrors core/cli/journal.rs instead, because the plugin cannot depend on the main crate.
- **`AH-050` Tool invocation audit log** - Canonical lifecycle events for every dispatched tool call, written through the single dispatch chokepoint; append-only JSONL, session-scoped reads, stale settlement at startup.
- **`AH-051` Emergency kill switch** - Built on the one cancellation system: emergency_stop is stop_scope at a wider scope, so call/run/session/application fall out of one shape where an empty field means 'everything at this level'. It grants no authority -- stopping work never needs permission that starting it did not -- and never reaches outside the scope given, proved by tests that a sibling run and another session survive. The StopReport separates what this press stopped from what an earlier press had already stopped, counts child processes surviving the sweep, and sets complete:false whenever any remain; the UI then reports the survivors in the destructive colour rather than showing a clean result. Killed scopes persist to <jan_data>/audit/killed-scopes.jsonl, append-only and truncation-tolerant, and was_killed matches by scope containment so killing a session covers runs a later process has never heard of -- a restart cannot resume killed work. agent_emergency_stop exposes it over IPC and records the terminal state. The UI is mounted in the Cowork composer row while a run is active: scope selector with a sentence naming exactly what each choice covers, confirmation before anything stops, disabled and non-re-entrant while stopping, progress and outcome in one role=status live region, accessible trigger name, keyboard operation, and focus restoration on close. Transient grants need no separate revocation path: SessionGrants lives on the run's own CompositeToolInvoker and cannot outlive the run being stopped. Pending permission requests are removed by the AH-023 cancellation path. Guards mutation-checked: forcing complete:true, and making the restart check ignore its own log, each turn the relevant tests red. Note: the focus-restore needed a wrapper element because the shared Button is a plain function component and does not forward refs.
- **`AH-053` Repository index store** - build_map produces a bounded breadth-first ProjectMap that is embedded in the run's prompt. It is an orientation blob, not an index: no symbols, no cache, no persistence.
- **`AH-054` Initial index build** - The breadth-first walk is bounded by entry and depth caps and honours ignore rules, but produces no stored index.
- **`AH-055` Incremental index updates** - The repository map is re-walked in full on each use; there is no cache to update.
- **`AH-071` Semantic code search** - Two RAG stacks exist (rag-extension, vector-db) but neither is wired to the agent harness; one is dead code.
- **`AH-073` Exact dispatched-payload accounting** - The provider's own count for the dispatched payload is recorded against the invocation and that payload's snapshot; Jan's byte estimate stays separate and labelled, and never overwrites a real count. A window of zero from a runtime or an overflow error is now reported as not known rather than counted as a real capacity, so the indicator no longer renders 0 / 0.
- **`AH-074` Per-segment token attribution** - Per-category breakdown taken from the frozen dispatch; unmeasured categories report {known:false} rather than zero. Figures remain estimates until AH-073 lands a tokenizer.
- **`AH-075` Compaction visibility** - ContextShaping records what trimming and compaction removed and reports it beside the total. The Rust and TypeScript implementations are still separate (AH-076).
- **`AH-076` Compaction strategy configuration** - Two independent implementations (Rust and TypeScript) with different behaviour and thresholds.
- **`AH-077` Context pressure warnings** - Desktop shows a percentage ring; the CLI warns only when /context is invoked.
- **`AH-078` Prompt snapshots** - The snapshot is taken in HttpModelInvoker::invoke from `normalized` -- the exact serialized request, after context construction and after the model id is rewritten, at the last point before dispatch. Not reconstructed from earlier state. It carries schema version, stable id, RFC3339 UTC timestamp, session, run, thread, agent, provider, model, reasoning configuration, the redacted payload, its hash, and the redaction list; message count, tool names and system prompt are derived from the payload rather than stored twice. Redaction runs while the record is built, walks the whole document (a credential in a nested tool argument leaks as surely as one in a header), matches credential fields by name because an auth header's value is opaque, and still applies the value-shaped pass to free text for an env line pasted into a prompt. Each removal records its path and reason, so an empty field is distinguishable from a redacted one. The hash is FNV-1a over a canonical key-sorted serialization of the *redacted* payload: identical payloads hash identically however built, any change to a retry produces a different hash, and a reader can verify the record against its own hash. Storage is append-only JSONL at <jan_data>/audit/prompts.jsonl, flushed per record, with a reader that drops an unparseable line so a truncated tail costs one record. Lookup by id, run and session. A snapshot that cannot be taken is recorded as explicitly unavailable with its reason and identity intact. StreamEvent::PromptSnapshot carries id, hash and redaction count to the activity timeline, never the payload. Guards mutation-checked: removing redaction, and making the hash ignore its input, each turn the relevant tests red. The viewer is built (PromptSnapshotView, verified by cowork-smoke --only prompt-snapshot-panel), and a snapshot is now bound to the assistant turn that produced it rather than matched by position. Six earlier designs wrote the reference from the snapshot sink onto 'the last assistant turn'; instrumenting the live turn lane in the running app showed the lane holds only the user turn at dispatch time, so there was no assistant row to write onto and every one of those writes silently did nothing -- while passing in vitest, which hands the mutation an array that already contains one. The attach happens in pushLive, where the row is created, from the dispatch that just went out; coworkTurns.ts already emitted a data-prompt-snapshot part for any turn carrying one, so nothing downstream needed changing. The render prefers the message's own part and keeps positional matching as a fallback for turns written to disk before rows carried one. Proven by mutation in the real WebView: with the positional fallback disabled entirely the panel still renders, so the per-turn reference is what carries it. A continuation, a retry and a compaction each carry their own snapshot, which is what position could not express.
- **`AH-080` Project memory** - Project scope is on the canonical record and resolves through a project id derived from the checkout rather than its path, so moving a checkout takes its memories along and a project that cannot be identified retrieves nothing rather than everything. migrate::migrate_project_notes carries the legacy <name>.md notes into the store once, keyed by content so it is a no-op afterwards and never re-imports a renamed note; the legacy files are left untouched.
- **`AH-081` Session memory** - Session scope is a first-class scope on the canonical record, stored per scope and selected by session id in retrieve::select. Both production dispatch paths reach one selection: the CLI agent calls it in process, the desktop through the memory_retrieve command. Proved end to end against a real OpenAI-compatible server -- a session memory does not appear in another chat's serialized request, and a temporary chat selects nothing because it is answered before any store is opened. Not promoted: the evidence is Rust unit tests plus an end-to-end that drives a probe binary and real HTTP. There is no memory UI, no restart evidence and no scenario driven through the real Tauri application, which is what this registry requires before implemented.
- **`AH-082` User-level memory** - User scope resolves to the permanent store and reaches the model. The gap this closes was not storage but dispatch: retrieval was wired into the Rust agent loop only, so the desktop -- which drives its own tool loop -- never carried a remembered fact. Proved against a real server: a marker saved in one chat is present by memory id and by content in a different chat's serialized request body, and absent from a third chat's after forget. Not promoted: the evidence is Rust unit tests plus an end-to-end that drives a probe binary and real HTTP. There is no memory UI, no restart evidence and no scenario driven through the real Tauri application, which is what this registry requires before implemented.
- **`AH-083` Memory provenance** - Every record carries a Provenance -- creator, origin, source session and message, timestamps -- written at creation and preserved through edits and supersession. What is missing is the user-facing half: 'Why does Jan remember this?' does not navigate to the source message, and there is no unavailable-source state for a deleted origin.
- **`AH-084` Memory precedence resolution** - record::prefer applies a deterministic order -- scope specificity, then creator trust, then recency -- and records why, so a displaced record can say what displaced it. Applied inside retrieve::select, which is the only path either surface reaches, and covered by the focused memory tests. Not promoted: the evidence is Rust unit tests plus an end-to-end that drives a probe binary and real HTTP. There is no memory UI, no restart evidence and no scenario driven through the real Tauri application, which is what this registry requires before implemented.
- **`AH-085` Instruction conflict detection** - detect_conflicts finds instruction pairs that cannot both be followed, and retrieve::select withholds BOTH sides rather than picking one, so an unresolved conflict never reaches the model as authoritative -- asserted in the renderer tests. What is missing is the resolution UI: keep-first, keep-second, merge, narrow to chat or project, dismiss, bound to the conflict hash. Conflicts are reported to the renderer and cannot yet be acted on there.
- **`AH-087` What-the-model-saw inspector** - /context shows category sizes re-derived from disk, omits the date line and memory recall, and offers no text view.
- **`AH-088` Context budget planner** - planTurn reserves reply headroom and classifies the turn before dispatch; an over-capacity request raises ContextOverflowError instead of being sent. An undiscoverable window is reported, never refused. max_tokens: 0 is never dispatched: llama.cpp gets its -1 "no cap" spelling and every other provider gets the key omitted, because a zero reply cap asks for an empty answer. A context-overflow refusal is now read for the window the server itself named -- structured fields first, then only known message shapes, and only when the numbers agree -- and stored as a `server-response` capability bound to provider, base URL and model, forgotten when any of the three changes. Recovery allows one compaction and one retry, never a loop.
- **`AH-100` Forked contexts** - Children are isolated, not forked: they start from a fresh single-message history.
- **`AH-102` Background agent lifecycle control** - Only bulk abort_all on parent teardown exists; there is no per-agent cancel.
- **`AH-104` Shared task board** - TeamTask and TeamState carry one board across the team, settled centrally and reported through assembleReport.
- **`AH-105` Task dependency graph** - Tasks declare dependsOn; danglingDependencies and findCycle refuse a graph that could never run.
- **`AH-106` Ready-task scheduling** - readyTasks dispatches only tasks whose dependencies have completed, bounded by MAX_TEAM_PARALLEL and MAX_TEAM_TASKS.
- **`AH-107` Per-agent git worktrees** - Real git worktrees exist and Cowork team dispatch gives each isolated child its own worktree and write grant. The Rust dispatch_subagent path in loop.rs is not wired to them, so the fan-out of up to ten children there still shares one tree. Unchanged this batch: the Rust dispatch_subagent path still shares one tree; a Jan-owned worktree's ownership check now compares canonical paths (a lexical comparison refused a worktree Jan had just made on Windows).
- **`AH-108` Worktree lifecycle management** - ensure/state/discard/list/prune over real `git worktree` invocations; WorktreeState reports Missing, Corrupt, BranchMoved and IdentityChanged and refuses rather than rebinding.
- **`AH-109` Conflict-aware merge of agent output** - Merging an agent's worktree back now goes through the proposal record: the session's managed worktree is proposed, reviewed per hunk and applied with conflicts refused and named, never overwritten (see AH-146). Pre-flight conflict detection between team tasks remains. MISSING: team children's worktrees are not yet offered for review (owner ids are not recoverable from hashed branch names; the team report names each child's worktree), and the review UI is unreachable on Windows (Managed worktree mode disabled by the AppContainer boundary).
- **`AH-110` Agent provenance on changes** - Provenance exists at the event level only; file changes carry no agent attribution.
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
- **`AH-146` Patch previews** - One proposal record now carries AH-146/147/148/109 (tauri_plugin_agent_tools::proposal, schema 1): exact base and proposed bytes stored content-addressed and write-once before approval; approval bound to patch hash, base-state hash, session/run/agent/project/worktree scope and the exact hunk ids, every field compared by the backend; selection, three-way merge against the destination, conflict refusal by file and hunk, and all-or-nothing writes with rollback all happen in Rust; credential-shaped files, paths outside the project, .jan and .git never applied; audit/proposals.jsonl holds ids and hashes only. agent_proposal_from_worktree/list/apply/reject are wired; the Changes panel of a Managed-worktree session shows CoworkProposalReview with per-file and per-hunk checkboxes, conflict marking and reject. Windows: cowork-smoke proposal-review-apply passes over real IPC with real git. MISSING for implemented: the review UI is unreachable on Windows because Managed worktree mode is disabled there (AppContainer cannot confine a run to a repository: jail::supports_write_roots(AppContainer) is false), so the UI is covered on Windows by unit tests only, and macOS/Linux were not run.
- **`AH-147` Per-hunk approval** - One proposal record now carries AH-146/147/148/109 (tauri_plugin_agent_tools::proposal, schema 1): exact base and proposed bytes stored content-addressed and write-once before approval; approval bound to patch hash, base-state hash, session/run/agent/project/worktree scope and the exact hunk ids, every field compared by the backend; selection, three-way merge against the destination, conflict refusal by file and hunk, and all-or-nothing writes with rollback all happen in Rust; credential-shaped files, paths outside the project, .jan and .git never applied; audit/proposals.jsonl holds ids and hashes only. agent_proposal_from_worktree/list/apply/reject are wired; the Changes panel of a Managed-worktree session shows CoworkProposalReview with per-file and per-hunk checkboxes, conflict marking and reject. Windows: cowork-smoke proposal-review-apply passes over real IPC with real git. MISSING for implemented: the review UI is unreachable on Windows because Managed worktree mode is disabled there (AppContainer cannot confine a run to a repository: jail::supports_write_roots(AppContainer) is false), so the UI is covered on Windows by unit tests only, and macOS/Linux were not run.
- **`AH-148` Patch application with conflict detection** - One proposal record now carries AH-146/147/148/109 (tauri_plugin_agent_tools::proposal, schema 1): exact base and proposed bytes stored content-addressed and write-once before approval; approval bound to patch hash, base-state hash, session/run/agent/project/worktree scope and the exact hunk ids, every field compared by the backend; selection, three-way merge against the destination, conflict refusal by file and hunk, and all-or-nothing writes with rollback all happen in Rust; credential-shaped files, paths outside the project, .jan and .git never applied; audit/proposals.jsonl holds ids and hashes only. agent_proposal_from_worktree/list/apply/reject are wired; the Changes panel of a Managed-worktree session shows CoworkProposalReview with per-file and per-hunk checkboxes, conflict marking and reject. Windows: cowork-smoke proposal-review-apply passes over real IPC with real git. MISSING for implemented: the review UI is unreachable on Windows because Managed worktree mode is disabled there (AppContainer cannot confine a run to a repository: jail::supports_write_roots(AppContainer) is false), so the UI is covered on Windows by unit tests only, and macOS/Linux were not run.
- **`AH-157` Secret scanning on diffs** - Proposed diffs are scanned before they are written; a change that adds a credential is refused with the file, line and kind and never the value. Removals are ignored, so the warning does not fire on the fix.
- **`AH-159` Commit message generation** - No git tool exists; git is reachable only through bash, and git.rs commits are internal snapshots.
- **`AH-161` Branch management** - The harness creates and deletes its own jan/cowork/* branches. There is no agent-facing git tool: the model reaches git only through bash, under per-base-command grants.
- **`AH-170` Worktree cleanup** - discard refuses while uncommitted changes exist unless forced, and names the files; prune and list recover strays.
- **`AH-172` Live tool timeline** - Timeline built on the AH-050 record: one durable item per call, ordered by request time, restored after a restart, and never folded away behind an answer.
- **`AH-174` Resource usage monitor** - Only host-level CPU and RAM; nothing is attributed per run or per agent.
- **`AH-175` Token and cost dashboard** - Tokens are tracked; there is no pricing model or cost figure anywhere in the product.
- **`AH-176` Event replay UI** - The CLI replays a rendering journal; there is no event-level replay UI.
- **`AH-178` Searchable transcripts** - Search exists in the desktop app; there is no transcript export or CLI search.
- **`AH-179` Screen-reader accessibility** - Not audited in depth during Phase 0; status to be confirmed by an accessibility pass in Phase 8.
- **`AH-180` Keyboard navigation** - Not audited in depth during Phase 0; the CLI is keyboard-driven by nature, the desktop surfaces are unverified.
- **`AH-182` Headless JSON API** - --output-format json emits a single terminal object, not a machine API surface.
- **`AH-183` Headless event-stream API** - StreamEvent is already Tauri-free but is never exposed over stdout or a socket.
- **`AH-194` Provider routing rules** - Resolution prefers a credentialed provider and supports a small-model role; there are no user-authored rules.
- **`AH-195` Local and offline model support** - Canonical ModelCapabilities with a fixed discovery order over sources the app already has; no network lookup. llama.cpp's effective n_ctx is distinguished from n_ctx_train, and an unknown window stays unknown. usableContextValue is the single gate every context number passes: zero, negative, NaN, Infinity and malformed strings are non-answers, not capacities. Migration 19 rewrites already-persisted ones to "not set" without touching a positive value, so no profile has to be deleted. `server-response` ranks above every described source and below an explicit user decision, because a refusal is the one answer measured against a real request.
- **`AH-198` Security regression corpus** - Adversarial corpus in tools/gate.rs::security_corpus: bypass spellings, traversal, unreadable arguments, command wrappers and second commands, destructive git behind a blanket allow, secret files, network off, lookalike and case/trailing-dot domains, deny-over-allow, absent grants, hidden agent state. Each asserts the specific refusal. Two live defects were found by writing it.
- **`AH-201` Conversation and session forking** - forkSession copies the conversation up to a named turn and records parent and divergence. It carries no authority: no folder, access mode, edit consent, write grant or run budget, so forking cannot multiply what was granted once, and two sessions are never pointed at one checkout unknowingly. An unknown session or an out-of-range divergence point is refused rather than clamped. Reachable from the session row menu by keyboard (context menu key or Shift+F10) and announced by a toast.
