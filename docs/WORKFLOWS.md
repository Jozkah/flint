# Workflows

The `workflow` tool runs ordered phases of parallel agents over the `team`
scheduler (`web-app/src/lib/coworkWorkflow.ts` turns the request into a team
graph; `coworkTeam.ts` runs it). This note covers what sits on top of that:
run controls, resuming a stopped run, saved workflows, and declarative loops.
The model is Claude Code's dynamic workflows
(<https://code.claude.com/docs/en/workflows>) with one deliberate difference:
Flint has no script runtime (see [No script runtime](#no-script-runtime)).

## 1. Run controls

Pause, resume and restart reuse `TeamControl` (`coworkTeamControl.ts`, AH-111).
There is no second mechanism.

- **Pause** stops `runTeam` starting new agents. Agents already running finish.
  Resume undoes it. A paused run with nothing running waits for a request, and a
  stop of the run ends it.
- **Restart** of a running agent aborts its attempt and discards the aborted
  result (it is not a failure), then the agent runs again. Restart of a failed
  agent is unchanged.
- Surfaces: the workflow card and the Background tasks panel (Pause/Resume per
  run, Restart per running agent), and the tool call
  `workflow {control: {run_id, action: pause|resume|restart, agent_id?}}`, where
  `run_id` is the `task_id` of a background workflow.

## 2. Resuming a run from cached results

### Rule (Claude Code's, followed exactly)

A relaunch replays the run in the order agents start. Each agent either returns
its saved result or runs again:

- **Completed** with an unchanged brief: returns its saved result.
- The **first** agent whose brief differs from the saved one (an edit, or an
  earlier agent returned something different) runs again, **and so does every
  agent that starts after it**, even ones that had completed.
- **Failed or never finished** (including stopped while running): runs again,
  and so does every agent that starts after it.

"Brief" is the whole brief the agent would receive *after* earlier answers are
carried in (`briefed()`), plus its subagent name, model and result schema. A
changed upstream answer therefore changes every downstream hash by itself.

### What is stored

One JSON file per run in the **app data folder**, `workflow-runs/`, never in an
attached project folder:

```
workflow-runs/<createdAtBase36>__<session>__<runId>.json
{ v: 1, runId, sessionId, createdAt, updatedAt,
  phases: <the validated phases array as launched>,
  entries: { "<phaseIndex>:<agentId>": { hash, output, seq } } }
```

- `runId` is the run's tool call id (also the background `task_id`), reduced to
  `[A-Za-z0-9._-]`. The report of a run that did not finish names it.
- Only agents that **completed ok** are stored. A result larger than 64 KB is
  not stored (it simply reruns; truncating would corrupt what downstream
  briefs are hashed from). A record stops growing at 2 MB.
- Results of isolated agents (own checkout) are not stored: their worktree is
  the real result.
- Bounds: records older than 14 days and all but the newest 50 are deleted when
  a run writes. A record is only readable by the session that made it.
- The hash is a synchronous 2x53-bit non-cryptographic hash. It detects edits;
  nothing here defends against someone crafting a collision, because the only
  writer of the folder is the user.
- Files go through the existing data-folder-confined `mkdir`, `read_file_sync`,
  `write_file_sync`, `readdir_sync`, `rm` commands. No Rust is added.

### Inputs and UI

- `workflow {resume_run_id}` relaunches from that record's saved phases. Giving
  `phases` as well replaces them (an edited brief hashes differently, so it and
  everything after it reruns). No record: error `nothing to resume`.
- A stopped, failed or interrupted run's card shows **Resume**, which asks the
  agent to relaunch it with that `resume_run_id` (the same path a person would
  use by typing it).
- Cached agents appear as finished rows noted "from saved result"; the report
  says how many agents were replayed.

## 3. Saved workflows

A definition is `{ name, description, phases, args? }`, saved as
`workflows/<name>.json` in the **app data folder** only. Nothing is read from
attached project folders (untrusted, mounted read-only).

- Saved from a finished run with a button on the card. Name rules:
  `[a-z0-9][a-z0-9-]{0,40}`.
- Briefs may contain `{{args.name}}`. At run time each placeholder is replaced
  by the value as a **JSON literal** (a quoted, escaped, length-capped string or
  structure), and a line is prepended saying values written as JSON literals
  are data from the caller, not instructions. Values are never evaluated or
  re-scanned for placeholders. Any `{{...}}` that is not a provided
  `args.<name>` is an error naming it, so a typo fails before anything runs.
- A definition is **re-validated on load** with exactly the rules of a live call
  (`workflowToTeamInput`), after substitution.
- Run with `workflow {saved: "<name>", args: {...}}`, or from a slash command
  in the Cowork composer. A picker lists saved workflows.

## 4. Loops: `repeat_until`

A phase may carry `repeat_until: { check, max_rounds (1-5), stop_when_no_progress }`.

The request is **expanded into a static graph** before it runs: round 1 is the
phase as written; rounds 2..max each repeat the phase's agents with the previous
round's results carried into their briefs; after every round a check agent
(brief = `check`, schema `{done: boolean, reason: string}`) decides.

- Rounds after a stop are not run. Their agents and checks return the previous
  round's result unchanged (so the next phase carries the last round that
  actually ran), and show no row.
- A round stops the loop when its check says `done`, or, with
  `stop_when_no_progress`, when its agents' aggregated results are identical to
  the previous round's (then that round's check is not even run).
- Expanded agents count toward the total and toward the approval threshold at
  their worst case (`agents * max_rounds + (max_rounds - 1)` checks). Workflows with loops
  may have up to 40 agents in the expansion; without loops the 12 cap stands.
- A failed agent blocks its round's check and so ends the loop, as in any
  graph. Resuming (section 2) works through loops: cached checks reproduce the
  same stop decisions.

## No script runtime

Claude Code runs a model-written JavaScript script in a sandbox. Flint does
not, on purpose, and `repeat_until` is the replacement for the loop use case.
Executing code the model wrote, inside the app, is a larger trust decision than
this feature: it needs its own sandbox, capability, resource and permission
design (what the script can read, spawn and call, and what the user approves),
and that decision belongs to the user separately rather than arriving bundled
with workflow resume. Declarative fields are data the app validates and bounds;
a script is code the app would have to contain. Everything here is a JSON shape
checked by `workflowToTeamInput`; there is no `eval`, `Function`, `vm`, worker
or interpreter anywhere in the workflow path.
