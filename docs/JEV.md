# Jev decision support (TypeSafe)

Flint can ask TypeSafe's **Jev** model (`jev-1.13.0`, pinned) for two narrow
decisions. Both are **optional, separate, and off by default** (Settings →
General → *Jev decision support*). Flint stays authoritative:

- Jev never approves, denies or gates a tool, and is not a security control.
- **Skill suggestion** shows a chip ("Jev suggests /skill-name") above the
  Cowork composer. Nothing happens until you click *Use*, which writes the same
  `/skill` command you could type. The `/` menu, skills the model loads itself,
  user-invoked skills and permissions are unchanged. A message that already
  starts with `/` is never sent.
- **Attachment reranking** may only reorder the shortlist Flint's vector search
  returned. Every citation keeps its exact id, text, file id, score and chunk
  order; an answer that is not an exact permutation of the shortlist is ignored.

## What leaves the device

| Opt-in | Sent to `api.typesafe.ai` | Not sent |
| --- | --- | --- |
| Skill suggestion | the message you are typing in Cowork (first 2,000 chars, after a 1.2 s pause) and the names + descriptions of that surface's skills | file contents, paths, history, anything once a message starts with `/` |
| Reranking | the retrieval query (first 1,000 chars) and up to 20 shortlisted passages (1,200 chars each) | file names, paths, citation ids (positions are sent instead) |

**Off means no request.** The backend (`src-tauri/src/core/jev`) reads the
opt-ins itself on every call and returns before touching the network or the key.

## Modes, bounds, fallback

- `off` — no request. `shadow` — request made and its decision recorded, but
  Flint behaves as if Jev were off. `on` — the decision is used.
- Timeouts 1.5 s (skills) / 2.5 s (rerank); ≤ 12,000 estimated input tokens a
  request; 2,000,000 input tokens a day (~$0.08 at $0.042/M); responses over
  256 KB are not read; redirects are refused so the key only goes to TypeSafe.
- Timeout, HTTP error, bad answer, abstention (skill probability < 0.7, or no
  passage ≥ 0.1 relevance), no key, over budget, or `off` → Flint's existing
  behaviour, with the reason recorded.
- The key is stored with `provider_secrets` (OS keyring or the encrypted file)
  and is write-only from the UI; it is registered for log redaction when loaded.
- Receipts (Settings card, and the app log) record time, feature, mode, the
  model version TypeSafe reports, the decision (a skill name, or how the
  top-k moved), latency, input/output tokens, cost and fallback reason —
  never the key, the message or passage text.

## Gate before enabling by default

`node scripts/jev-eval/eval.mjs --split holdout` compares Jev with Flint on
labeled tasks (`scripts/jev-eval/*.labeled.json`, dev/holdout split). Flint's
arm runs offline; Jev's needs `TYPESAFE_API_KEY` and network access, and is
reported as *not measured* otherwise. Retrieval uses a TF-IDF order as a
stand-in for Flint's embedding order unless `--baseline-order` supplies orders
recorded from Flint — record them before treating the retrieval numbers as a
gate. Turn a feature on by default only if Jev beats Flint on holdout without
more wrong suggestions where none applies.

### Measured so far

#### Jev evaluation (holdout split, jev-1.13.0)

| Skill selection | Flint (catalog search) | Jev |
| --- | --- | --- |
| Accuracy (incl. none) | 50% | not measured |
| Precision of suggestions | 100% | not measured |
| Recall | 30% | not measured |
| Wrong suggestion where none applies | 0 | not measured |

| Retrieval (baseline: TF-IDF proxy) | Flint | Jev rerank |
| --- | --- | --- |
| Hit@1 | 0% | not measured |
| Hit@3 | 20% | not measured |
| MRR | 0.21 | not measured |

Jev: not measured -- TYPESAFE_API_KEY is not set. Both opt-ins stay off by default until this is measured.

_Recorded 2026-09-27 in a sandbox where `api.typesafe.ai` is blocked by the network policy and no key is available: the Flint column is measured, the Jev column is not._
