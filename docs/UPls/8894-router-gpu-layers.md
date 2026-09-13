# janhq/jan#8894 — router never forwards the per-model GPU Layers setting

- Upstream: https://github.com/janhq/jan/issues/8894
- Kind: issue, open upstream
- Priority: P1 (model runs CPU-only despite correct configuration)
- Status in this fork: **fixed**

## Applies to us, by a different route

Upstream's symptom — GPU Layers set to 100, no `-ngl` anywhere in the launch
args, generation pinned to the CPU — reproduces here, but our cause is a
deliberate suppression rather than missing plumbing.

`extensions/llamacpp-extension/src/preset.ts` did emit `n-gpu-layers` into the
model's router preset section, but only when auto-fit was off:

```ts
if (!fitEnabled && typeof mc.n_gpu_layers === 'number' && mc.n_gpu_layers >= -2)
```

`fit` defaults to on (`config.fit !== false`), so on a default installation the
per-model GPU Layers setting did nothing at all. The reasoning behind the gate
was sound as far as it went — an explicit `n-gpu-layers` makes llama.cpp fit
abort its own layer-offload computation — but the conclusion was backwards: it
silently discarded the user's explicit instruction.

## Why the override is safe to honour

`n_gpu_layers` only reaches `model.yml` when the user set GPU Layers for that
model. The settings writer deletes the key when the field is cleared
(`extensions/llamacpp-extension/src/index.ts`, `MODEL_SETTINGS_YAML_MAPPING`
coercion returning `null`), so its presence is always an explicit override,
never a default. Making fit skip layer offload for that one model is exactly
what overriding it means.

## Fix

Drop the `!fitEnabled` gate. `n-gpu-layers` is emitted whenever the model config
carries it, whatever fit is doing. A model the user never touched still emits
nothing and still gets automatic offload.

## Verification

```
vitest --project @janhq/llamacpp-extension    202 passed (8 files)
```

The old test `omits per-model n-gpu-layers when auto-fit is enabled` asserted the
defect and was replaced by `emits per-model n-gpu-layers even when auto-fit is
enabled`, plus a case pinning that an untouched model still emits nothing.

## Not addressed here

The reporter also noted three different backend names in one startup log
(`Determined best available backend` / `Using stored backend preference` /
the name actually launched). That is a separate claim about backend resolution,
not about GPU layers, and it has not been reproduced against this fork. It stays
open in the ledger rather than being folded into this fix.
