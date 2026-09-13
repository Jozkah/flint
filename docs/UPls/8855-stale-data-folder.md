# A saved data folder that no longer exists (janhq/jan#8855, #8794)

Upstream PR #8855 (open) makes the app and the CLI fall back to the default
data folder when the saved one is missing or unreadable. The diff does not
apply to the fork (the `JAN_DATA_FOLDER` override, the `cfg!(test)` branch and
the relative-folder anchoring all sit in the same functions), so this is an
attributed reimplementation, not a cherry-pick.

## Defect in the fork

`resolve_jan_data_folder` (CLI) and `get_app_configurations` (app) returned
the saved `data_folder` without checking it. On Windows that folder is often on
a second drive: with the drive disconnected, or the profile renamed, Jan
started against a path that did not exist. Where the parent still existed it
silently created a fresh, empty data folder, so the user's threads, models and
settings appeared to be gone.

## Fix

- One decision for both paths, `choose_data_folder`: the saved folder when it
  is a readable directory, the default otherwise. A relative folder is left for
  the existing working-directory anchoring.
- The saved setting is never rewritten. Upstream's fallback is silent; here,
  writing the default back would make the move permanent and strand the data
  on the drive once it returned. Left alone, the next start finds it again.
- A folder passed over once stays passed over for the rest of the run, so a
  drive reconnected mid-session does not switch the folder under work already
  written to the default.
- The app reports the passed-over folder (`unavailable_data_folder`, never
  serialised into the configuration file) and Settings > General says so under
  the data folder path. The CLI logs a warning.

## Tests

- `core::app::commands::tests`: a usable folder is kept; a missing one falls
  back and is reported; a file in its place is not usable; a passed-over folder
  stays passed over for the run and is found again by a fresh run; a relative
  folder is left to be anchored. Run under both the default and `cli` features.
- `models::tests::serializes_round_trip_via_json` asserts the report stays out
  of the file.
- `routes/settings/__tests__/general.test.tsx`: the warning appears when the
  backend reports an unavailable folder and not otherwise.
