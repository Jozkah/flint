# GGUF models gone from the UI, files intact (janhq/jan#8374)

Status: **open, waiting on a product/security decision.** The part that
needs no decision is done.

## What the evidence shows

Two confirmed ways the local model list loses models whose files are still on
disk. Neither is the reporter's theory or the backslash id slice.

1. **The saved data folder is unusable at launch** (drive not mounted, folder
   renamed, locked). `choose_data_folder` (`core/app/commands.rs`) runs the
   session on the default folder and leaves the setting alone, so the models
   come back when the drive does. The only notice was in Settings > General:
   the model list itself was simply empty.
2. **Models behind a link.** A junction or symlink under
   `<data>/llamacpp/models` (a common way to keep models on another drive)
   resolves outside the data folder. The `read_yaml` scope check refuses it,
   and the extension's `list()` skips the model with only a warning. Pinned by
   `core/filesystem/helpers.rs`
   `a_model_behind_a_junction_resolves_outside_the_data_folder` (Windows,
   `mklink /J`).

Not causes:
- Backslash ids are consistent within listing.
- A stale absolute `model_path` after a move: listing does not check it, and
  the load fails instead.
- Folders without `model.yml` only matter once `model.yml` is lost.

## Done (no decision needed)

The llama.cpp and MLX provider pages now say when this run could not use the
configured data folder. They name the folder and say the models are not
deleted and come back when it is available. Before, the list was simply
empty. Tests: `routes/settings/providers/__tests__/$providerName.test.tsx`
(`local model list when the data folder was unavailable`).

## Open: whether and how to allow models outside the data folder

Simply letting the scope check follow links under the data folder would let
any link planted there read outside it, and it is not done. The options:

1. **Trusted model roots (recommended).** The user adds a model directory in
   Settings. It is canonicalized and stored as an explicit root, and reads are
   authorized against the canonical final target of each file, re-resolved at
   read time to defeat a swap between check and read.
   - Models under a root whose drive is absent are listed as *unavailable*,
     not removed, and reappear when it returns without the configuration
     being rewritten.
   - The UI distinguishes unavailable drive, unreadable metadata, invalid
     model and security refusal.
2. **A per-link grant.** When `list()` meets a link that leaves the data
   folder, it asks the user once to trust that exact target, recorded like an
   edit grant.
3. **Keep refusing, explain it.** Keep today's boundary but list such models
   as "refused: stored outside the data folder through a link", with
   instructions to move them or use Settings > Data folder.

Each needs changes across the llama.cpp extension (`list()`, `model.yml`
reads), the filesystem scope helpers, and Settings. Option 1 is the only one
that also covers models on a drive that comes and goes. Until one is chosen,
the security boundary stays as it is.
