# Shared folder coordination

Status: approved design, phase 1 (core + agent behaviour) implemented. Phase 2 (UI bar, sidebar mark) is separate and consumes the API listed at the end.

## Problem

Several Chat/Cowork sessions can be attached to the same folder. Nothing tells them. A real incident: a fork session ran `git checkout feat/multi-game-catalog` in a shared working tree and the other session kept finding the tree on the wrong branch. Choice made with the user: **awareness plus soft file claims**, plus a git-state guard.

## Principles

- Advisory, never a permanent block. A claim, a hold or a guard can always be passed after one retry that follows a message, so a dead or silent session cannot wedge another.
- Bypass permissions does not skip any of it: a hold is not an approval prompt.
- Tool-schema tokens matter (PR #428): no new tool. Agents use the existing `send_message`.
- Only sessions registered in the session mailbox take part (Cowork sessions on the desktop; headless and browser clients use the same registry server side). A call without a mailbox identity (CLI, subagent child, plain chat thread) is never held.

## 1 Detection

Sessions are grouped by a **folder key**, computed by `shared_folder::path_key::folder_key`:

1. canonicalize (when the path does not exist yet, canonicalize its nearest existing ancestor and re-append the rest), which resolves symlinks and expands Windows 8.3 short names;
2. strip the verbatim prefix (`\\?\`, `\\?\UNC\` becomes `\\`);
3. unify separators to `/`, drop trailing `/`;
4. case-fold on Windows (and for drive-letter/UNC spellings).

The registry (`<data>/mailbox/sessions.json`, the existing session mailbox) is the folder registry. `SessionRecord` gains one optional block, `shared` (all fields defaulted so old files load):
`folderKey`, `access` (the session's access mode), `isolated` (worktree or copy), `git` (the folder is a repo), `startBranch`, `startHead` (taken from `.git` when the folder is first registered), `registeredEpoch`.

`mailbox_session_register` takes two new optional arguments, `access` and `isolated`. A session registers when it attaches a folder (the existing presence sync) and leaves when it is archived or deleted. A session also counts as **live in the folder** only when it is registered in this process epoch, is not archived or deleted, and its status is not `unavailable` (a `running` record without a heartbeat for 90 s, or from another epoch, is dead). So a crash or restart drops stale entries; sessions re-register as the app loads them.

Worktree-isolated sessions register under their **source** repo (the session's attached folder), marked `isolated`. They are visible to others (awareness) but are never held, never hold claims, and are not counted as "others" by the git guard.

The same session id registering twice (resume) is one session, never "another".

## 2 Visibility

Rust commands/events for the UI (see API) and one compact line in the environment block. The line is appended to the `Runtime Environment` block once per run (that block already survives the small-context/fast path), absent when alone:

```
Shared folder: also here: Fix auth (running, on feat/x, edited src/a.ts, src/b.ts 2m ago); Docs (idle, on main, isolated). A held write names its owner: use send_message.
```

Capped at 480 characters, 3 files per session, 10-minute window, names sanitised (they are untrusted).

## 3 Soft file claims

`write` and `edit` (the only file-mutating built-ins; shell edits are covered by the git guard only) go through `shared_folder::tools::write_gate` before the existing stale-read check, and record on success.

- First write/edit of a file records a claim: session, resolved file key, content hash, time.
- A claim expires after 5 minutes without a write by its owner, when the owner's run ends, or when the owner is no longer live.
- Check, for a non-isolated writer: (a) a live, unexpired claim by another non-isolated session; (b) the file's hash changed since this session last read or wrote it. (b) already existed as the "modified since it was read" refusal and is kept as is.
- A hold returns plain text (not an `ERROR`): `Not written. src/x.ts is being edited by <session name>. Message them with send_message, re-read the file, then retry.`
- One retry passes after the agent sent a message or re-read the file since the hold. With no such evidence it is held once more; the third attempt passes regardless. A pass takes over the claim.
- User override: `shared_folder_allow` lets a session edit anyway for a bounded time.

## 4 Talking

The hold names the session, so the agent uses `send_message` (existing hop limit, held-mail and untrusted-message rules). Convention, documented in `docs/AGENT_MESSAGING.md`: a one-line "Editing <path> for <reason>" message is the announcement. No `announce_edit` tool is added.

## 7 Git state guard

When another live non-isolated session shares a git folder, tree-changing git operations are held: checkout/switch to another branch or commit, `checkout .`/`restore` with a broad pathspec, `reset --hard|--merge|--keep`, stash (push/save/pop/apply/branch/bare), rebase, merge, pull, cherry-pick, revert, am, `clean` with `-f`, `gh pr checkout`. Read-only forms, `checkout -- <file>`, `restore <file>`, `restore --staged`, `reset --soft/--mixed`, `stash list/show/drop/clear`, `clean -n` pass.

Checked in the `git` tool, and in the command text of `bash`, `host_powershell` and `host_wsl` using `cmdscan::simple_commands` (so `cd x && git checkout main`, `env`/`sudo`/`bash -c` wrappers, quoted programs, `git.exe`, full paths and `git -C dir` are seen). `git -C dir` into a different repo is not held. The held text: `<session> is working on <branch> in this folder. Switching changes its files. Start an isolated worktree for this session or message them.` The same one-retry-after-message rule applies.

HEAD moved: the current branch is recorded after every tool and compared before the next one. A mover that is not the session itself produces, appended to that tool result: `The branch changed from X to Y since your last step. Do not commit until it is back (or ask <session>).` The baseline resets at each run start.

## Default change

`shared_folder::isolation::default_isolation` is a pure function: a git folder where another live non-isolated session already is (a fork, or a second session) defaults to an isolated worktree, unless the user chose the shared tree; non-git folders never. The command `shared_folder_default_isolation` exposes it; `useAutoSessionWorktree` consults it for a new session (no turns, default access) and uses the existing worktree machinery. Choosing the shared tree keeps guard and claims in force.

## Edge cases

Chat sessions without agent tools get awareness data only. Folders that are not git repos skip section 7. Claims and holds live in process memory (documented limit: two separate processes on one data folder see each other through the registry, not through claims).

## Phase 2 API

Commands (plugin `agent-tools`; all take `dataFolder`): `shared_folder_peers`, `shared_folder_overview`, `shared_folder_recent_edits`, `shared_folder_allow`, `shared_folder_default_isolation`. Event: `agent-shared-folder-updated` with `{ folderKey, sessionId, reason }`. Payload shapes are the `serde(rename_all = "camelCase")` structs in `shared_folder/view.rs`.
