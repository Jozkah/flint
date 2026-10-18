# Prompt library

A prompt library entry is a named piece of plain text you reuse. It is inserted
into the composer as ordinary text, which you can edit before sending. Nothing
is expanded or hidden at send time.

How it differs from what already existed:

- `@alias:name` names a file or line range in the attached folder.
- Skills and `/commands` are packaged instructions the agent runs.
- A library prompt is only text you own. No tools, no folder, no authority.

## Data

`web-app/src/lib/promptLibrary.ts`, a zustand store persisted through the
backend settings store under `prompt-library` (same mechanism as
`referenceAliases`).

```
{ id, name, body, folder?, tags?, createdAt, updatedAt }
```

Names are trimmed, up to 80 characters. Bodies are up to 20 000 characters.

## Variables

- `{{topic}}` asks for a value.
- `{{tone:friendly}}` asks, with a default.
- A name used more than once is asked for once; the first default wins.
- `\{{` writes a literal `{{`.
- A value is inserted as typed and is never read as another variable.

`parseVars`, `fillPrompt` and `missingVars` are pure and covered by
`lib/__tests__/promptLibrary.test.ts`.

## Using a prompt

- `@` menu: library prompts appear as a `prompt` kind in the ranked list
  (`lib/referenceMenu.ts`), with or without an attached folder. Picking one
  replaces the `@query` with the prompt text. `@prompt:` narrows to prompts.
- `/` list: each prompt is offered as `/prompt:<slug>`. Picking it replaces the
  draft with the prompt text.
- A prompt with variables opens a small form first
  (`containers/PromptFillDialog.tsx`). Required variables (no default) must be
  filled; Cancel inserts nothing.

## Managing prompts

Settings > Assistants, "Prompt library" card
(`containers/PromptLibraryCard.tsx`): add, edit, delete, search by name, text,
folder or tag, and import / export as JSON (`{ version: 1, prompts: [...] }`).
Import adds new entries with fresh ids, skips exact duplicates and never
overwrites an existing prompt.

## Not done

- The Rooms composer shares the `/` hook but does not offer library prompts.
- Folders are a single label for grouping in the settings list, not a tree.
