# Jev decision support (TypeSafe)

Flint can ask TypeSafe's **Jev** model (`jev-1.13.0`, pinned) for bounded
decisions. They are **optional and off by default** (Settings → General →
*Jev decision support*). Flint stays authoritative:

- Jev never approves, denies or gates a tool, and is not a security control.
- **Prompt routing** reuses the Skill suggestion opt-in and the same bounded
  choice endpoint. At the start of a new user turn, Jev may choose among the
  built-in Flint family: Flint, Quartz, Coal, Blaze and Redstone, plus a Review /
  Ask / Auto **work-style suggestion** for the chosen assistant. The mode is
  inserted as behavioural guidance only. In Cowork it never changes the actual
  permission mode, folder authority or approval requirements; in Chat it never
  changes tool approval rules. Custom/project assistants are pinned and are
  never automatically routed away from.
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
| Skill suggestion / prompt routing | for skill chips: the message you are typing in Cowork (first 2,000 chars, after a 1.2 s pause) plus skill names/descriptions. For routing: the submitted prompt (first 2,000 chars) plus the bounded 5-assistant × 3-advisory-mode catalog (15 choices) | file contents, paths, history, custom assistant prompts, tool grants, permission state, anything once a message starts with `/` |
| Reranking | the retrieval query (first 1,000 chars) and up to 20 shortlisted passages (1,200 chars each) | file names, paths, citation ids (positions are sent instead) |

**Off means no request.** Prompt routing deliberately uses the existing Skill
suggestion opt-in so there is still one backend-controlled network gate for
that TypeSafe choice channel. `shadow` records the decision without changing
the selected assistant or adding a mode hint; `on` uses it.

## Routing behaviour

- **Flint** is the generalist/default: mixed everyday requests and the fallback
  whenever active routing has no confident specialist choice.
- **Quartz** specializes in research, evidence, comparisons and calculations.
- **Coal** specializes in software engineering, implementation and debugging.
- **Blaze** specializes in creative/product ideation, naming, UX and copy.
- **Redstone** specializes in automation, integrations and repeatable systems.
- Chat routes once per new user-message id. The selected assistant and advisory
  mode stay fixed through that turn's tool follow-ups; regeneration does not
  make another Jev routing call for the same user message.
- Cowork also routes once per new user-message id. The selected specialist's
  persona is added below Cowork's own policy so it cannot supersede folder
  access, approvals or project instructions. Flint keeps Cowork's existing
  baseline prompt unchanged. The Review / Ask / Auto recommendation describes
  how the assistant should approach the turn; it does not change Cowork's real
  access mode.
- A custom/project assistant is an explicit user/project choice, so it is never
  replaced automatically.
- With the opt-in `off`, Flint's existing behaviour is untouched. In `shadow`,
  Jev's route is recorded but not applied. In active `on` mode, an abstention or
  invalid choice falls back to Flint rather than carrying the previous
  specialist into an unrelated prompt.

## Modes, bounds, fallback

- `off` — no request. `shadow` — request made and its decision recorded, but
  Flint behaves as if Jev were off. `on` — the decision is used.
- Timeouts 1.5 s (choice decisions) / 2.5 s (rerank); ≤ 12,000 estimated input
  tokens a request; 2,000,000 input tokens a day (~$0.08 at $0.042/M);
  responses over 256 KB are not read; redirects are refused so the key only
  goes to TypeSafe.
- Timeout, HTTP error, bad answer, abstention (choice probability < 0.7, or no
  passage ≥ 0.1 relevance), no key, over budget, or `off` → Flint's existing
  behaviour, with the reason recorded. For an active routing decision that
  returns no confident assistant, the turn uses Flint as the generalist.
- The key is stored with `provider_secrets` (OS keyring or the encrypted file)
  and is write-only from the UI; it is registered for log redaction when loaded.
- Receipts (Settings card, and the app log) record time, feature, mode, the
  model version TypeSafe reports, the validated choice (including a routing
  token such as `jev-route:coal:ask`) or how the top-k moved, latency,
  input/output tokens, cost and fallback reason — never the key, message or
  passage text.

## Gate before enabling by default

`node scripts/jev-eval/eval.mjs --split holdout` compares Jev with Flint on
labeled tasks (`scripts/jev-eval/*.labeled.json`, dev/holdout split). Flint's
arm runs offline; Jev's needs `TYPESAFE_API_KEY` and network access, and is
reported as *not measured* otherwise. Retrieval uses a TF-IDF order as a
stand-in for Flint's embedding order unless `--baseline-order` supplies orders
recorded from Flint — record them before treating the retrieval numbers as a
gate. Turn a feature on by default only if Jev beats Flint on holdout without
more wrong suggestions where none applies.

**Release blocker:** the retrieval comparison below uses a TF-IDF order, not
Flint's. Before release, record the order Flint's own embedding search
returns for each labeled query and rerun with `--baseline-order`, with
`TYPESAFE_API_KEY` set and `api.typesafe.ai` reachable.

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
