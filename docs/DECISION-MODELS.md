# Decision models: Jev or an open model

The Jev opt-ins (skill suggestion and prompt routing, attachment reranking, and
the `[auto_mode] judge = "jev"` tool-call review) ask a model a **bounded
question**: pick exactly one of these options, or say how relevant each of these
passages is. By default TypeSafe's Jev answers ([JEV.md](JEV.md)). Settings →
*Jev decision support* → *Decision model* lets you pick an **open model**
instead:

- a local llama.cpp or MLX model already loaded in Flint, or
- any OpenAI-compatible provider/model you have configured, including
  self-hosted open-weight models.

One backend is used for every opt-in. Nothing else changes: the opt-ins, their
`off` / `shadow` / `on` modes and the settings keys (`flint-jev`) are the same,
and existing Jev users see no change (`backend` absent = Jev).

## Presets

Small CPU-sized typed-decision models are offered as presets: **Von**, **Laya**,
**Kev-0.8B**, **Kev-4B**, **Rizzo Flow 4B**, **Rizzo Flow 1.7B** and **Our
Qwen3-4B service**. Flint does not ship their endpoints or ids. Add the model as
an OpenAI-compatible provider (or load it locally), then pick the preset: it
selects a configured model whose id or name starts with the preset's name, or
asks you to pick one. Until a model is chosen, Jev is used.

## How an open model answers

An open model has no bounded-choice endpoint, so Flint (`core::jev::backend`)
turns the same request it would send Jev into one chat-completions call:

- a short system prompt; the user turn is a single JSON value with the
  untrusted text under `data`, so message text cannot close a delimiter or pose
  as instructions;
- `response_format: json_schema` (strict) that allows exactly the asked
  questions: a choice is an `enum` of the option keys plus a confidence, a
  relevance is a number in [0, 1]. llama.cpp compiles this into a grammar, so a
  local model cannot emit anything else. A provider that rejects
  `response_format` returns an HTTP error, which falls back;
- `temperature: 0`, `max_tokens` 32 + 24 per question.

The reply is read **strictly**: the whole reply (or one ```` ```json ```` fence)
must be one JSON object with exactly the asked keys; every choice must be one of
its option keys (option *keys* like `s0`, never skill names), every number a
probability. Prose, extra keys, a missing answer, an unknown choice or an
invented option such as `approve` is a bad answer, and Flint decides. The
answer then goes through the very same readers as Jev's, so every existing
guarantee holds:

- **Off means no request**; with the opt-in off, the provider is not even
  looked up.
- **Shadow** records the decision and uses Flint's behaviour.
- **Abstention** (`none`, confidence < 0.7, or no passage ≥ 0.1) falls back.
- **Rerank** output is used only if it is an exact permutation of the
  shortlist (checked again in `rag-extension`).
- **Tool-call review** can only say `ask` or refuse; there is no approve option
  in the schema or the reader.
- Same bounds: input clipping, ≤ 12,000 estimated tokens a request, the same
  2,000,000-token daily budget (shared with Jev), 1.5 s / 2.5 s timeouts,
  responses over 256 KB not read, redirects refused.

## Receipts

Receipts record `backend` (`jev` or `open_model`) and the model as
`open:<provider>/<model>`, plus latency, token counts reported by the provider
and the fallback reason. Cost is shown as 0 for open models (Flint does not
know their price). The provider key, message and passage text are never
recorded; provider keys are registered for log redaction when used.

## What leaves the device

| Backend | Where the text goes |
| --- | --- |
| Jev | `api.typesafe.ai` (see [JEV.md](JEV.md)) |
| Local llama.cpp / MLX model | nowhere: the request goes to Flint's own engine on `127.0.0.1` |
| OpenAI-compatible provider on this machine or your LAN | that server only |
| Remote OpenAI-compatible provider | **the same text listed in [JEV.md](JEV.md#what-leaves-the-device) goes to that provider** instead of TypeSafe, under that provider's terms |

## Evaluating an open model

`scripts/jev-eval/eval.mjs` runs an open model on the same labeled fixtures:

```
node scripts/jev-eval/eval.mjs --split holdout \
  --open-url http://127.0.0.1:8080/v1 --open-model kev-4b --preset kev-4b
```

`OPEN_MODEL_API_KEY` is sent as a bearer token when set. The requests and the
strict reader mirror the app's. Turn an opt-in on by default with an open model
only by the same rule as Jev: it beats Flint on holdout without more wrong
suggestions where none applies.
