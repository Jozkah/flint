#!/usr/bin/env bash
#
# Cowork compatibility smoke: the runtime evidence, in one command.
#
# What this is. Every check below exercises a real service — a real Seatbelt
# sandbox confining a real child process, a real MCP handshake with a real
# server on stdio, the real resolver the prompt and readiness read. Nothing
# here is a mock standing in for a runtime.
#
# What this is not. It does not drive the Tauri window, so it proves nothing
# about pixels, focus order, or whether a control is where someone expects it.
# Those need a GUI driver this repository does not have. The script says so at
# the end rather than letting a green run imply more than it checked.
#
# Usage:  scripts/cowork-compat-smoke.sh
# Exit:   0 when every check passed; non-zero otherwise.

set -uo pipefail

cd "$(dirname "$0")/.."
FAILED=0

step() {
  printf '\n\033[1m== %s\033[0m\n' "$1"
}

check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf '  \033[32mpass\033[0m  %s\n' "$name"
  else
    printf '  \033[31mFAIL\033[0m  %s\n' "$name"
    FAILED=1
  fi
}

# Seatbelt is macOS-only, so the checks that need a real one are gated rather
# than the whole script. Everything else — the worktree lifecycle, the
# checkpoint asymmetry, context measurement, the opening-turn gate, the
# coordination layer — is platform-independent and worth running wherever
# someone is working, which is usually not macOS.
IS_MACOS=0
[[ "$(uname -s)" == "Darwin" ]] && IS_MACOS=1

skip() {
  printf '  \033[33mskip\033[0m  %s (%s)\n' "$1" "$2"
}

step "The safety properties, anywhere"
# These are the guarantees the access modes rest on, and none of them needs a
# particular platform to be true.
check "managed worktree: creation, reuse, refusal, and the source left alone" \
  cargo test --quiet --manifest-path src-tauri/Cargo.toml --lib worktree

check "checkpoints: a managed tree restores, a user's checkout never does" \
  cargo test --quiet --manifest-path src-tauri/Cargo.toml --lib checkpoint

check "access: a grant for the source checkout cannot serve a worktree run" \
  web-app/node_modules/.bin/vitest run --root web-app \
  src/lib/__tests__/coworkAccess.test.ts

check "context: measured from the payload, estimates labelled as estimates" \
  web-app/node_modules/.bin/vitest run --root web-app \
  src/lib/__tests__/coworkContext.test.ts \
  src/lib/__tests__/coworkReadiness.test.ts \
  src/containers/__tests__/CoworkContextBreakdown.test.tsx

check "opening turn: an ambiguous request proposes rather than acts" \
  web-app/node_modules/.bin/vitest run --root web-app \
  src/lib/__tests__/coworkContinuity.test.ts

check "coordination: a failed child never becomes a finished task" \
  web-app/node_modules/.bin/vitest run --root web-app \
  src/lib/__tests__/coworkTeam.test.ts

# The graph rules proved against a table say nothing about the wiring. This
# drives a team through the real subagent runner and the real dispatcher, with
# only the model replaced, because the bugs live in the seams.
check "team dispatch: children inherit the run's tools and none of its own" \
  web-app/node_modules/.bin/vitest run --root web-app \
  src/lib/__tests__/coworkTeamDispatch.test.ts

if [[ "$IS_MACOS" -eq 0 ]]; then
  step "Seatbelt, and what needs a real one"
  skip "Seatbelt confinement and the MCP runtime suites" "not macOS"
fi

if [[ "$IS_MACOS" -eq 1 ]]; then
step "Sandbox confinement, under the real backend"
# Policy construction and real confined processes: review-only cannot write the
# repository, edit-folder writes only the authorized root, and neither sibling
# — including the prefix sibling — can be read or written.
check "mcp_confine (policy + runtime enforcement)" \
  cargo test --quiet \
  --manifest-path src-tauri/plugins/tauri-plugin-agent-tools/Cargo.toml mcp_confine

step "The launch capability"
# Nothing outside the module can build or open a launch, the process builder is
# called in exactly one place, and an import with no confinement is refused.
check "ConfinedMcpLaunch invariants" \
  cargo test --quiet --manifest-path src-tauri/Cargo.toml --lib launch

step "MCP, end to end"
# A confined child, a real JSON-RPC handshake, tools/list and tools/call.
check "confined stdio server: handshake, list, call, shutdown" \
  cargo test --quiet --manifest-path src-tauri/Cargo.toml --lib mcp_end_to_end

check "launcher confinement and environment rebuild" \
  cargo test --quiet --manifest-path src-tauri/Cargo.toml --lib mcp_confinement

step "Compatibility resolution"
# The resolver, discovery, scoped instructions, skill roots and the surfaces
# that render them.
check "compatibility suites" \
  web-app/node_modules/.bin/vitest run --root web-app \
  src/lib/__tests__/claudeCompat.test.ts \
  src/lib/__tests__/claudeCompatDiscovery.test.ts \
  src/lib/__tests__/claudeCompatIntegration.test.ts \
  src/lib/__tests__/claudeCompatScoping.test.ts \
  src/lib/__tests__/claudeCompatMcp.test.ts \
  src/lib/__tests__/claudeSkillRoots.test.ts \
  src/lib/__tests__/coworkDispatch.test.ts \
  src/lib/__tests__/coworkOriginAgreement.test.ts \
  src/containers/__tests__/CoworkCompatSection.test.tsx \
  src/containers/__tests__/ClaudeSkillRootsSettings.test.tsx \
  src/hooks/__tests__/useClaudeCompat.test.ts

step "MCP over a real remote transport"
# A loopback server, Jan's real streamable-HTTP transport, and the failure
# shapes a client has to survive.
check "loopback HTTP: handshake, list, call, refusal, malformed init" \
  cargo test --quiet --manifest-path src-tauri/Cargo.toml --lib mcp_http_integration

check "loopback SSE: stream, endpoint, handshake, call, shutdown" \
  cargo test --quiet --manifest-path src-tauri/Cargo.toml --lib mcp_sse_integration

check "registration refuses a different definition under the same name" \
  cargo test --quiet --manifest-path src-tauri/Cargo.toml --lib registration_decision

step "Restart, in two real processes"
# One process writes what Jan persists and exits; a second starts fresh and
# reads it. Clearing a store inside one process would test the clearing, not
# the restart.
restart_across_processes() {
  local fixture
  fixture="$(mktemp -t janrestart)".json
  JAN_RESTART_FIXTURE="$fixture" web-app/node_modules/.bin/vitest run --root web-app \
    src/hooks/__tests__/restart/processA.spec.ts >/dev/null 2>&1 || {
    rm -f "$fixture"
    return 1
  }
  JAN_RESTART_FIXTURE="$fixture" web-app/node_modules/.bin/vitest run --root web-app \
    src/hooks/__tests__/restart/processB.spec.ts >/dev/null 2>&1
  local status=$?
  rm -f "$fixture"
  return "$status"
}
check "consent and running servers do not survive a restart" restart_across_processes
fi

printf '\n'
if [[ "$FAILED" -eq 0 ]]; then
  printf '\033[32mAll runtime checks passed.\033[0m\n'
else
  printf '\033[31mSome checks failed.\033[0m\n'
fi

cat <<'NOTE'

Covered by an executing runtime, on any platform:
  - a real Git worktree created outside the checkout, reused across restarts,
    and refusing a branch or directory that is already someone else's
  - the source checkout left untouched while its worktree is edited
  - a checkpoint restoring a managed tree, and refusing to restore over the
    user's own checkout
  - a write grant naming the source checkout refused for a worktree run
  - context measured from the payload the run actually sends
  - an ambiguous opening request answered with a proposal rather than an edit
  - a failed child staying failed in the parent's report
  - a team dispatched through the real subagent runner: ordering honoured,
    tools inherited, `team` and `task` withheld from children, a cancelled
    team reaching the child already in flight

Covered by an executing runtime, on macOS:
  - Seatbelt confining a real child process, on this host
  - review-only vs edit-folder write boundaries
  - sibling and prefix-sibling refusal, for reads and writes
  - a confined MCP server: handshake, tools/list, tools/call, shutdown
  - refusal to launch an import that carries no confinement
  - the environment a confined server is given
  - a real remote MCP handshake, tool call, and failure handling on loopback
    over both streamable HTTP and SSE
  - refusing to start a different definition under a name already running
  - a restart, across two separate processes

Not covered here:
  - the Tauri window: layout, focus order, where a control sits
  - clicking through consent in the running application
  - Linux bubblewrap and Windows AppContainer at runtime (see the
    "Cowork sandbox runtime" workflow; it needs Actions billing enabled)

NOTE

exit "$FAILED"
