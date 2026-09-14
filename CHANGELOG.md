# Flint 0.9

## Migration

**Flint detects an existing JAN installation on first launch.**

Because Flint keeps JAN's bundle identifier (`jan.ai.app`) and data path, an existing JAN install is found automatically, and the first-launch assistant offers four choices. **Copy to Flint** duplicates the selected data and preserves your original JAN installation and data untouched. **Reuse JAN data** shares the selected existing data in place, with concurrency protection so both apps do not corrupt it. **Move to Flint** copies into Flint and then removes the JAN source once every item succeeds, keeping a recoverable backup and supporting rollback. **Start fresh** begins with an empty Flint profile and leaves JAN untouched. You can also migrate later from **Settings → General → Migrate from JAN**.

Your existing settings, credentials, providers, models, threads, projects, rooms, mailboxes, extensions, and related state are preserved where compatible. Secrets continue through the protected keychain/backend-store path and are never copied into plaintext or logs. A newer item already in Flint is never silently overwritten, and your existing JAN data is never deleted automatically. Legacy compatibility is kept throughout: `JAN_*` environment variables (with `FLINT_*` preferred), the `jan://` protocol (alongside `flint://`), `JAN.md` project files (alongside `FLINT.md`), the legacy data locations, and the persisted identifiers all continue to work.

Flint is an independent fork of [Jan](https://github.com/menloresearch/jan) by Menlo Research and preserves JAN's Apache-2.0 license, copyright notices, contributor attribution, acknowledgements, and upstream provenance.

---

## What's Changed
* feat(rebrand): present the product as Flint — app name, window title, rail wordmark, default assistant, and every locale
* feat(packaging): rename the desktop binary to Flint-Desktop and register the `flint://` deep link, keeping `jan://` for compatibility
* docs(rebrand): add an original Flint logo and replace the JAN logo in the favicon, boot splash, window title, and in-app badges
* feat(design): JAN Atelier redesign, integrated with the agent phases and beginner workflows by @Jozkah in https://github.com/Jozkah/jan/pull/11
* feat(design): Graphite Studio redesign, with a neutral charcoal dark theme by @Jozkah in https://github.com/Jozkah/jan/pull/15
* feat(design): redesigned navigation, a Rooms rail, agent workflows, and the workspace experience
* docs(readme): rewrite the README as "Flint — a fork of Jan" with provenance, migration, and feature sections by @Jozkah in https://github.com/Jozkah/jan/pull/12
* docs(readme): fix the model-import path and the local-only guard claim by @Jozkah in https://github.com/Jozkah/jan/pull/13
* docs(readme): make the screenshot captions read as captions by @Jozkah in https://github.com/Jozkah/jan/pull/14
* docs(license): retain Apache-2.0, the Menlo Research copyright, acknowledgements, and upstream provenance
* feat(migration): first-launch JAN → Flint migration assistant — detect, plan, and execute over six Tauri commands, with a guided UI
* feat(migration): Copy, Reuse, Move, and Start-fresh paths, with per-category selection and conflict resolution
* feat(migration): rollback and retry on failure, and idempotent resume of an interrupted migration
* feat(migration): reopen the assistant any time from Settings → General → Migrate from JAN
* feat(env): prefer `FLINT_*` environment variables, with a `JAN_*` fallback
* feat(project-init): write and discover `FLINT.md`, still reading legacy `JAN.md` (web, Rust, and CLI/agent context)
* chore(compat): keep the `jan.ai.app` identifier, legacy data locations, and persisted IDs so an existing JAN install upgrades in place
* feat(agent-tools): backend mailbox for cross-session agent messaging, scoped to the same project
* feat(messaging): same-project session discovery and isolation
* feat(messaging): attributed messages and addressed replies, with queued delivery to idle sessions
* feat(messaging): `stop_session` — a permission-safe, user-approved stop of a running same-project peer, with stale-run protection and attribution
* security(messaging): fence and scrub incoming message bodies against prompt injection, keeping them to safe boundaries
* fix(messaging): claim mail at drain so a message is delivered exactly once
* fix(messaging): recover a corrupt mailbox state file instead of failing
* feat(rooms): multi-model Discussion Rooms — engine, store, controller, and a typed persistence service
* feat(rooms): multiple providers and models in one room, with moderator and speaking/turn policies
* feat(rooms): shared transcript with addressed replies, participant isolation, budgets, and limits
* feat(rooms): restart recovery, termination, and synthesis
* fix(rooms): frame transcript text, cap dissent, and classify storage errors
* feat(usage): token and prompt-cache accounting carried end to end, per request, turn, and session (AH-211)
* feat(chat): vision-disabled attachment handling — warn before sending images to a model without vision
* feat(chat,context): project memory binding, request attribution, and a verified context panel
* feat(web-search): native `web_search` / `web_fetch` tooling and provider improvements
* feat(models): rename models and put the model list in an order by @Jozkah in https://github.com/Jozkah/jan/pull/5
* feat(app): local-only build — no telemetry, catalog, or downloads by @Jozkah in https://github.com/Jozkah/jan/pull/10
* chore(llamacpp): upgrade the bundled llama.cpp engine to b10809 (0.4.0)
* feat(llamacpp): embedded-engine and worker improvements, including per-model chat-template kwargs
* fix(providers): keep a still-resolving single-label LAN provider in the settings list while its address resolves
* fix(windows): startup and title-bar fixes, and scope the desktop manifest link
* fix(windows): JSON path handling and DLL-loading test fixes
* fix(chat): stop duplicate message delivery and bound agent loops
* security(logs): redact API keys and private-key material from logs, audit records, and the event log
* build(release): align version sources to 0.9.0 and add the Flint 0.9 changelog
* fix(build): make the pre-commit gate one Git for Windows can start
* test(smoke): real-app Cowork smoke journeys for messaging, `stop_session`, Discussion Rooms, and migration
* test(migration): realistic-data Copy/Reuse/Move/Fresh, interrupted-resume, rollback, and conflict coverage

## New Contributors
* @Jozkah made their first contribution in https://github.com/Jozkah/jan/pull/1

**Full Changelog**: https://github.com/Jozkah/jan/compare/1c70d7288a5811d72e5cec8bd61f052e40981bca...v0.9.0

### Contributors
* @Jozkah
