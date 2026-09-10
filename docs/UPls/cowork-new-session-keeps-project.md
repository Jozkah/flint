# "New session" kept the previous session's project attached

Not an upstream item. Found by the real-WebView scenario `session-isolation`
(run after `project-attachment`) in batch 3.

## Symptom

Attach a project folder to a Cowork session, send nothing, press New session:
the "new" session still has the project attached.

## Cause

`254e48eb6` made New session idempotent: on a session with nothing in it, the
press returns the same session instead of leaving a trail of blanks.
`isSessionEmpty` judged emptiness on the transcript, messages sent, todos and
open tabs -- not on an attached project. A session whose only content was an
attached folder counted as empty, so it was reused, folder and all.

## Fix

An attached project is content: `isSessionEmpty` returns false for a session
with a folder, so New session creates a fresh session (`folder: null`).

## Tests

`web-app/src/lib/__tests__/coworkSessionStart.test.ts`: a session with a
project is not empty, and New session on it decides `create`. Both fail on the
old rule.
