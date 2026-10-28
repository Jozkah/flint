/**
 * @file Generates `router.preset.ini` from the per-model `model.yml` files under
 * `<providerPath>/models/<modelId>/model.yml`.
 *
 * The file has a `[*]` section of engine-wide defaults, then one `[<modelId>]`
 * section per model. Only values that differ from llama.cpp's own defaults are
 * written, so the preset stays intent-revealing and a setting left alone keeps
 * whatever upstream (or the GGUF) decided. `load-on-startup = false` is the one
 * unconditional line.
 *
 * An ini key is the CLI flag with its leading dashes removed, resolved by
 * `common/preset.cpp` `get_map_key_opt`. Defaults quoted below are from
 * `common/common.h` at the pinned build.
 */

import { fs, joinPath } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import { gpuFlashAttnDefault, resolveKvCacheTypes } from './kvCache'
import type { LlamacppConfig, ModelConfig } from '@janhq/tauri-plugin-llamacpp-api'

// ModelConfig is intentionally widened — model.yml may carry extra fields like
// `chat_template` that aren't yet in the strict typing.
type ModelYaml = ModelConfig & {
  chat_template?: string
  grammar?: string
  ctx_size?: number
  n_gpu_layers?: number
  flash_attn?: string
  cache_type_k?: string
  cache_type_v?: string
  parallel?: number
  /** false: no extra slots beyond `parallel`, so `parallel = 1` is one slot. */
  reserve_background_slots?: boolean
  cont_batching?: boolean
  pooling?: 'none' | 'mean' | 'cls' | 'last' | 'rank'
  ubatch_size?: number
  batch_size?: number
  mtp_layers?: number
  mtp?: boolean
  mtp_model_path?: string
  spec_type?: string
  temperature?: number
  top_k?: number
  top_p?: number
  min_p?: number
  repeat_last_n?: number
  repeat_penalty?: number
  presence_penalty?: number
  frequency_penalty?: number
  seed?: number
  spec_draft_n_max?: number
  spec_draft_n_min?: number
  spec_draft_p_min?: number
  spec_draft_sampling?: 'greedy' | 'probabilistic'
  cpu_moe?: boolean
  n_cpu_moe?: number
  n_cpu_ffn?: number
  no_kv_offload?: boolean
  /** Per-model override of the global Context Shift setting. */
  ctx_shift?: boolean
  override_tensor?: string
  mmproj_offload?: boolean
  reasoning?: 'on' | 'off'
  extra_args?: string
}

// One extra llama-server slot beyond the user-visible "Parallel Sequences"
// count, reserved for background requests (e.g. thread auto-titling) that
// must never be able to evict the user's own chat KV cache from its slot.
// Hidden from the setting's UI value.
//
// Added unconditionally, and that is load-bearing. The emitted `parallel` is
// therefore always 3 or more, which is what lets the frontend pin background
// work and Cowork to fixed slot ids (web-app/src/constants/models.ts) instead
// of computing an index here that the two sides then have to keep in sync.
// Upstream wraps an out-of-range id_slot modulo the slot count rather than
// rejecting it, so any such desync is silent: the background request lands back
// on the chat slot and overwrites the cache it was meant to protect.
export const RESERVED_BACKGROUND_SLOTS = 2

/**
 * Slots, after the chat, background and Cowork slots (ids 0-2), for requests
 * that name no slot: subagents, workflow agents, API-server clients. The engine
 * proxy spreads them over ids `FIRST_AGENT_SLOT` and up (`engine/http.rs`), so
 * they cannot land on, and evict, the chat or Cowork prefix. The KV pool is
 * unified, so a slot adds no KV memory of its own.
 */
export const DEFAULT_AGENT_SLOTS = 2
export const MAX_AGENT_SLOTS = 8

/**
 * The ubatch every embedding model's preset section is pinned to.
 *
 * Exported because `embed()` has to budget its batches against the *embedder's*
 * ubatch, not the engine-wide setting: llama.cpp rejects a batch wider than
 * n_ubatch outright, with no retry path.
 */
export const DEFAULT_EMBEDDING_UBATCH = 2048

/** The ubatch an `auto` setting falls back to when VRAM or model size is unknown. */
export const DEFAULT_UBATCH = 1024

const GIB = 1024 ** 3

/**
 * The ubatch for a chat model when the setting is `auto` (0), from what its
 * weights leave of the GPU. Measured on an RTX 5080 (Qwen3-8B, Gemma-3-4B,
 * Qwen3.5-35B-A3B; CUDA 13 and Vulkan):
 * - Weights spill to system RAM: 2048. Each ubatch streams the host-side
 *   weights over PCIe, so a wider one halves that traffic: prompt processing
 *   went 462 -> 876 tok/s on the 35B MoE, generation unchanged.
 * - Fits, with >= 1.5 GiB left after the weights: 1024. Over 512 it was
 *   +4-5% prompt processing on CUDA and +31% on Vulkan for ~100 MiB; 2048 was
 *   within +-5% of 1024 (better on the 8B, worse on the 4B) for another
 *   ~250-350 MiB, and 4096 slower on both.
 * - Fits with less than that: 512, so the ~100 MiB goes to KV and layers.
 * `undefined` when either number is unknown.
 */
export function autoUbatchSize(
  weightsBytes: number | undefined,
  gpuMemoryMiB: number | undefined
): number | undefined {
  if (!weightsBytes || weightsBytes <= 0 || !gpuMemoryMiB || gpuMemoryMiB <= 0) {
    return undefined
  }
  const headroom = gpuMemoryMiB * 1024 * 1024 - weightsBytes
  if (headroom < 0) return 2048
  if (headroom >= 1.5 * GIB) return 1024
  return 512
}

/** Fit target llama.cpp uses when none is set: MiB left free per device. */
export const DEFAULT_FIT_TARGET_MIB = 1024

/**
 * The first entry of a `fit_target` setting ("1024" or "1024,2048") in MiB.
 * Blank or unreadable means the default; 0 is a real value (keep nothing free)
 * and must not be mistaken for "unset", or the slot plan would assume 1 GiB.
 */
export function fitTargetFirstMiB(value: unknown): number {
  const first = String(value ?? '').split(',')[0].trim()
  if (first === '') return DEFAULT_FIT_TARGET_MIB
  const n = Number(first)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FIT_TARGET_MIB
}

/** Per-device fit targets in MiB; a single value is broadcast, as llama.cpp does. */
export function fitTargetsMiB(value: unknown, deviceCount: number): number[] {
  const parts = String(value ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map(Number)
  const ok = parts.length > 0 && parts.every((n) => Number.isFinite(n) && n >= 0)
  const list = ok ? parts : [DEFAULT_FIT_TARGET_MIB]
  return Array.from({ length: deviceCount }, (_, i) =>
    list.length === 1 ? list[0] : (list[i] ?? list[list.length - 1])
  )
}

/**
 * One line per GPU saying what auto-fit has to work with, for the app log.
 * llama.cpp's own fit lines are trace-level and never reach it, so without
 * this a user whose model stops short of their VRAM cannot tell whether the
 * card reported less than its size, other apps hold memory, or the memory to
 * keep free (fit_target) is what is left over.
 */
export function describeFitBudget(
  devices: ReadonlyArray<{ id: string; name: string; mem: number; free: number }>,
  fitEnabled: boolean,
  fitTarget: unknown
): string[] {
  if (devices.length === 0) return []
  const targets = fitTargetsMiB(fitTarget, devices.length)
  return devices.map((d, i) => {
    const total = Math.round(d.mem)
    const free = Math.round(d.free)
    const base = `GPU ${d.id} (${d.name}): ${total} MiB reported, ${free} MiB free now`
    if (!fitEnabled) return `${base}; auto-fit is off`
    const usable = Math.max(0, free - targets[i])
    return (
      `${base}; auto-fit keeps ${targets[i]} MiB free, ` +
      `so model, KV cache and compute buffers get up to ${usable} MiB`
    )
  })
}

/** Room beyond the weights below which a model counts as spilling for the slot plan. */
export const NEAR_SPILL_SLACK_BYTES = 1.5 * GIB

/** Smallest context one slot should get when auto-fit has to trim a model. */
export const MIN_SLOT_CTX = 8192

/**
 * Slot plan for a model that auto-fit will have to trim: its weights alone
 * leave less than the fit target free on the GPU. Fit then reduces the context
 * to its floor (fit-ctx) before offloading any layer, and with `slots` sharing
 * that floor each one gets fitCtx / slots. When that share is under
 * MIN_SLOT_CTX the model gets one slot and a floor of at least MIN_SLOT_CTX.
 * `undefined` when the model fits, a number is unknown, or the share is enough.
 */
export function spillSlotPlan(
  weightsBytes: number,
  gpuMemoryMiB: number | undefined,
  fitTargetMiB: number,
  fitCtx: number,
  slots: number
): { fitCtx: number } | undefined {
  if (!weightsBytes || weightsBytes <= 0 || !gpuMemoryMiB || gpuMemoryMiB <= 0) {
    return undefined
  }
  const usable = (gpuMemoryMiB - fitTargetMiB) * 1024 * 1024
  // A model that only just fits has the same problem: the KV and compute
  // buffers take what the weights left, fit trims the context toward its floor
  // and the slots share it. NEAR_SPILL_SLACK is the room those need.
  if (weightsBytes + NEAR_SPILL_SLACK_BYTES <= usable) return undefined
  if (fitCtx / Math.max(1, slots) >= MIN_SLOT_CTX) return undefined
  return { fitCtx: Math.max(fitCtx, MIN_SLOT_CTX) }
}

/** A `cache_ram` setting as a number: blank or unreadable means auto. */
export function cacheRamValue(value: unknown): number {
  if (value === undefined || value === null) return CACHE_RAM_AUTO
  if (typeof value === 'string' && value.trim() === '') return CACHE_RAM_AUTO
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : CACHE_RAM_AUTO
}

/** `cache_ram` value meaning "size it from this machine's RAM". */
export const CACHE_RAM_AUTO = -2

/**
 * Prompt cache size (MiB) for `cache_ram = auto`. The cache holds the KV state
 * of conversations that are not in a slot, so switching back to one is a
 * restore instead of a full re-read. Measured on an RTX 5080, Qwen3-8B f16 KV,
 * five 10k-token threads in turn: 4096 MiB missed every switch (1.6 s to
 * first token), 8192 hit every one (28 ms); off was 2.1 s even for four
 * threads. llama.cpp only grows it as states arrive, so the size is a ceiling:
 * 20% of total RAM, at most half of what was free at launch, 1024-8192.
 * Unknown RAM keeps the old fixed 4096.
 */
export function autoCacheRamMiB(
  totalMiB: number | undefined,
  freeMiB: number | undefined
): number {
  if (!totalMiB || !(totalMiB > 0)) return 4096
  let mib = totalMiB * 0.2
  if (freeMiB !== undefined && freeMiB >= 0) mib = Math.min(mib, freeMiB / 2)
  return Math.max(1024, Math.min(8192, Math.floor(mib / 512) * 512))
}

function isAutoUbatch(v: unknown): boolean {
  return !(typeof v === 'number' && Number.isFinite(v) && v > 0)
}

/**
 * Where each thread's saved KV cache lives.
 *
 * Under the provider directory rather than a temp dir: it is a cache the user
 * paid prefill time for and expects to survive a reboot, which is the whole
 * point. Shared verbatim with the Rust side, which llama.cpp joins file names
 * onto, so the two must not compute it differently -- this function is the one
 * definition.
 */
/**
 * The context size a load must write to model.yml first, or undefined when
 * model.yml already says it. The model settings show a context for every
 * model (8192 unless changed), but only an edit used to reach model.yml, so a
 * model never edited loaded at its native size with Auto-fit on while the app
 * showed 8192 (T7-123). A positive context is a cap passed as ctx-size. A
 * blank or 0 one means "the provider's Default context size": null asks to
 * remove a ctx_size model.yml still holds, which would otherwise win over
 * that default (C043). A missing key leaves model.yml as it is.
 */
export function contextSizeToPersist(
  loadSettings: Record<string, unknown> | undefined,
  cfg: object | undefined
): number | null | undefined {
  const raw = loadSettings?.ctx_size
  if (raw == null) return undefined
  const stored = (cfg as { ctx_size?: unknown } | undefined)?.ctx_size
  const n = raw === '' ? 0 : typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    return stored === undefined || stored === null ? undefined : null
  }
  const wanted = Math.floor(n)
  return stored === wanted
    ? undefined
    : wanted
}

/** Smallest window the provider's Default context size accepts. */
export const MIN_DEFAULT_CTX_SIZE = 512

/**
 * The provider-wide Default context size as tokens, or undefined for auto
 * (blank, 0, negative or unreadable). A positive value below 512 is raised to
 * 512: smaller windows cannot hold a system prompt and a reply.
 */
export function defaultContextSize(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.max(MIN_DEFAULT_CTX_SIZE, Math.floor(n))
}

export function threadCacheDir(providerPath: string): string {
  const sep = isWindowsPath(providerPath) ? '\\' : '/'
  return `${providerPath.replace(/[\\/]+$/, '')}${sep}thread-cache`
}

/**
 * Whether a path is rooted the Windows way: a drive letter, a UNC share, or an
 * extended `\\?\` prefix.
 *
 * Tested on the root rather than on "contains a backslash" because `\` is a
 * legal filename character on Linux. Win32 normalizes `/` to `\` for the first
 * two, but *not* for an extended path, where a `/` is a literal name character
 * -- `create_dir_all` then fails with ERROR_INVALID_NAME and the worker exits
 * before it serves anything.
 */
function isWindowsPath(p: string): boolean {
  return /^(?:[A-Za-z]:|\\\\)/.test(p)
}

// Fallback context size when the user hasn't set one, to avoid loading a
// model's full trained context (which can OOM on large-context models).
const DEFAULT_CTX_SIZE = 8192
/** Context cap for a speculative-decoding model that sets none (auto-fit on). */
export const SPEC_DEFAULT_CTX_SIZE = 32768

/**
 * The `--spec-type` values llama.cpp accepts for a draft model
 * (common/speculative.cpp). A model.yml records one at import; anything else
 * -- an older install with no record, or a value we do not recognise -- falls
 * back to MTP, which is what every embedded-head model is.
 */
const SPEC_TYPES = new Set([
  'draft-mtp',
  'draft-eagle3',
  'draft-dflash',
  'draft-dspark',
])
const DEFAULT_SPEC_TYPE = 'draft-mtp'

function hasValue(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/**
 * A built-in template name (`chatml`, `llama3`, ...) as opposed to a template
 * body. `--chat-template` takes either, but `--chat-template-file` reads its
 * value as a path, so the two have to be told apart. Any real jinja carries
 * `{`, whitespace or a newline, none of which match here.
 */
const BUILTIN_TEMPLATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Model id of a model folder: path below `modelsDir`, always `/`-separated
 * (Windows join results may contain `\`).
 */
export function toModelId(modelsDir: string, currentDir: string): string {
  return currentDir
    .slice(modelsDir.length)
    .replace(/^[\\/]+/, '')
    .split(/[\\/]+/)
    .filter((seg) => seg.length > 0)
    .join('/')
}

// Absolute paths only: a relative one would resolve against llama.cpp's cwd,
// which is not something the user can predict. Covers POSIX, drive-letter and
// UNC forms.
const ABSOLUTE_PATH_RE = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/

/**
 * When a setting value is an absolute path to an existing file, the preset
 * passes it through to the corresponding `*-file` flag instead of treating it
 * as an inline body.
 */
async function existingFilePath(value: string): Promise<string | null> {
  if (!ABSOLUTE_PATH_RE.test(value)) return null
  try {
    return (await fs.existsSync(value)) ? value : null
  } catch {
    return null
  }
}

/**
 * Options a user may not set through free-form arguments: they would move the
 * server off its loopback address, replace its credentials, or change which
 * model files it opens, all of which Flint owns.
 */
const BLOCKED_EXTRA_ARGS = new Set([
  'host',
  'port',
  'api-key',
  'api-key-file',
  'path',
  'api-prefix',
  'ssl-key-file',
  'ssl-cert-file',
  'model',
  'model-url',
  'hf-repo',
  'hf-file',
  'hf-token',
  'models-dir',
  'models-preset',
  'models-max',
  'models-autoload',
  'slot-save-path',
  'webui',
  'webui-config',
  'webui-config-file',
])

/**
 * Sibling options the exact set above would miss: draft/vocoder/vision model
 * paths, Hugging Face downloads (`hf-repo-draft`, `hf-file-v`...), the `no-`
 * negations of the web UI and model options, and the router's model options.
 * `model-` is blocked as a whole prefix; none of its members is safe to let a
 * user redirect.
 */
const BLOCKED_EXTRA_ARG_PATTERN =
  /^(no-)?(hf-|model(-|$)|models-|webui|mmproj(-url)?$|api-key|ssl-)/

export function isBlockedExtraArg(key: string): boolean {
  return BLOCKED_EXTRA_ARGS.has(key) || BLOCKED_EXTRA_ARG_PATTERN.test(key)
}

/** A token is a flag only when it looks like one; `-1` and `-0.5` are values. */
const FLAG_LIKE = /^-{1,2}[A-Za-z]/
function isValueToken(t: string | undefined): t is string {
  return t !== undefined && t !== '' && !FLAG_LIKE.test(t)
}

function splitArgs(text: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || current) tokens.push(current)
      current = ''
      started = false
    } else {
      current += ch
      started = true
    }
  }
  if (started || current) tokens.push(current)
  return tokens
}

/**
 * Turn a free-form llama-server argument string into preset INI lines.
 *
 * `--rope-scaling yarn` becomes `rope-scaling = yarn`, a bare `--flag` becomes
 * `flag = true`, and `--key=value` is accepted. Quotes group a value that has
 * spaces; a backslash is kept as is, so a Windows path survives. Options the
 * server must not be redirected with are dropped and reported in `skipped`.
 */
export function extraArgsToIni(text: unknown): {
  lines: string[]
  skipped: string[]
} {
  const lines: string[] = []
  const skipped: string[] = []
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { lines, skipped }
  }
  const tokens = splitArgs(text)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.startsWith('-')) continue
    const body = token.replace(/^--?/, '')
    if (!/^[A-Za-z][A-Za-z0-9-]*(=|$)/.test(body)) continue
    const eq = body.indexOf('=')
    let key = eq === -1 ? body : body.slice(0, eq)
    let value: string | undefined = eq === -1 ? undefined : body.slice(eq + 1)
    // A single-dash short flag has no INI key; only long options are supported.
    if (!token.startsWith('--')) {
      skipped.push(token)
      if (eq === -1 && isValueToken(tokens[i + 1])) i++
      continue
    }
    key = key.toLowerCase()
    if (value === undefined && isValueToken(tokens[i + 1])) {
      value = tokens[i + 1]
      i++
    }
    if (isBlockedExtraArg(key)) {
      skipped.push(`--${key}`)
      continue
    }
    lines.push(`${key} = ${escapeIniValue(value ?? 'true')}`)
  }
  return { lines, skipped }
}

/** Number, or a numeric string (settings text inputs store strings). */
function asFiniteNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** A model id is written as an INI `[section]`; these characters break it. */
export function isSafePresetSectionId(id: string): boolean {
  return !/[[\];#=\r\n]/.test(id)
}

function escapeIniValue(v: string): string {
  // INI values for llama-server are read as strings; trim surrounding whitespace
  // and strip stray newlines that would break parsing.
  return String(v).replace(/[\r\n]+/g, ' ').trim()
}

/**
 * Walks `<providerPath>/models/*` recursively for `model.yml` files and emits
 * a router preset INI to `<providerPath>/router.preset.ini`. Returns the
 * absolute path of the written file.
 */
export async function generatePreset(
  providerPath: string,
  janDataFolderPath: string,
  config: LlamacppConfig,
  opts: {
    reservedBackgroundSlots?: number
    /** Overridable for tests only, like `reservedBackgroundSlots`. */
    agentSlots?: number
    /** Models whose KV cache defaults failed to load; they get f16 instead. */
    kvFallbackModels?: ReadonlySet<string>
    /**
     * Models whose load crashed on a CPU instruction the machine lacks; each is
     * written with `device = none` so it runs on the CPU backend only.
     */
    cpuFallbackModels?: ReadonlySet<string>
    /**
     * Device ids the engine currently reports. When given and non-empty, a
     * saved `device` that is not among them is dropped: after a driver update
     * or an eGPU unplug llama.cpp rejects the stale name and every load fails.
     */
    knownDeviceIds?: readonly string[]
    /**
     * Lowest CUDA compute capability among the machine's NVIDIA GPUs (`7.5` =
     * Turing), so KV cache and flash-attn defaults stay within what the cards
     * can run. Unset on CPU-only, AMD and Apple machines.
     */
    gpuComputeCapability?: number
    /**
     * VRAM of the machine's largest GPU, in MiB. Drives the `auto` ubatch per
     * model (autoUbatchSize). Unset when there is no GPU or it is unknown.
     */
    gpuMemoryMiB?: number
    /**
     * Every model runs on the CPU backend: the engine reports no GPU, or the
     * device setting is `none`. Drives the CPU KV cache default.
     */
    cpuOnly?: boolean
    /** Total and free system RAM in MiB at launch, for `cache_ram = auto`. */
    systemMemoryMiB?: { total?: number; free?: number }
  } = {}
): Promise<{ path: string; embeddingCount: number }> {
  // Overridable for tests only. Production callers take the default: gating it
  // on the auto-title setting made the reservation appear and disappear behind
  // a toggle that regenerates no preset, so the frontend's pin outlived the
  // slot it named.
  const reservedBackgroundSlots =
    typeof opts.reservedBackgroundSlots === 'number'
      ? opts.reservedBackgroundSlots
      : config.reserve_background_slots === false
        ? 0
        : RESERVED_BACKGROUND_SLOTS
  // Only alongside the reserved slots: with those off the user asked for
  // exactly Parallel Sequences slots, and the proxy's agent ids (3 and up)
  // would otherwise wrap onto the chat slot.
  const configuredAgent =
    typeof opts.agentSlots === 'number'
      ? opts.agentSlots
      : (asFiniteNumber((config as { agent_slots?: unknown }).agent_slots) ?? DEFAULT_AGENT_SLOTS)
  const agentSlots =
    reservedBackgroundSlots > 0
      ? Math.min(MAX_AGENT_SLOTS, Math.max(0, Math.floor(configuredAgent)))
      : 0
  const extraSlots = reservedBackgroundSlots + agentSlots
  const modelsDir = await joinPath([providerPath, 'models'])

  // Ensure the directory exists; an empty install is fine — we still emit a
  // valid (mostly empty) preset so the router can start.
  if (!(await fs.existsSync(modelsDir))) {
    await fs.mkdir(modelsDir)
  }

  // DFS for any directory containing model.yml — mirrors the logic in
  // index.ts:list() so nested model IDs (e.g. "huggingface/foo") work.
  const modelEntries: { modelId: string; configPath: string }[] = []
  const stack: string[] = [modelsDir]
  while (stack.length > 0) {
    const currentDir = stack.pop() as string
    const modelConfigPath = await joinPath([currentDir, 'model.yml'])
    if (await fs.existsSync(modelConfigPath)) {
      const modelId = toModelId(modelsDir, currentDir)
      if (modelId.length > 0) {
        if (isSafePresetSectionId(modelId)) {
          modelEntries.push({ modelId, configPath: modelConfigPath })
        } else {
          console.warn(
            `[llamacpp] skipping model with unsafe id in preset: ${JSON.stringify(modelId)}`
          )
        }
      }
      continue
    }
    let children: string[] = []
    try {
      children = await fs.readdirSync(currentDir)
    } catch {
      continue
    }
    for (const child of children) {
      try {
        const stat = await fs.fileStat(child)
        if (stat?.isDirectory) stack.push(child)
      } catch {
        /* ignore unreadable entries */
      }
    }
  }

  modelEntries.sort((a, b) => a.modelId.localeCompare(b.modelId))

  const kvUnifiedIsAuto =
    config.kv_unified !== 'on' && config.kv_unified !== 'off'

  const lines: string[] = []

  // Emit only values that differ from llama.cpp's compiled defaults so the
  // preset stays minimal and intent-revealing. Defaults sourced from
  // tools/server/README.md.
  lines.push('[*]')
  // fit default = 'on'
  if (config.fit === false) {
    lines.push('fit = off')
  }
  // fit-target default = '1024' (MiB per device)
  if (
    typeof config.fit_target === 'string' &&
    config.fit_target.length > 0 &&
    config.fit_target !== '1024'
  ) {
    lines.push(`fit-target = ${escapeIniValue(config.fit_target)}`)
  }
  // fit-ctx default = 4096
  const fitCtxNum =
    typeof config.fit_ctx === 'number'
      ? config.fit_ctx
      : typeof config.fit_ctx === 'string' && config.fit_ctx.length > 0
        ? Number(config.fit_ctx)
        : NaN
  if (Number.isFinite(fitCtxNum) && fitCtxNum > 0 && fitCtxNum !== 4096) {
    lines.push(`fit-ctx = ${fitCtxNum}`)
  }
  const fitCtxFloor =
    Number.isFinite(fitCtxNum) && fitCtxNum > 0 ? fitCtxNum : 4096
  // A per-device list ("1024,2048") is read by its first entry.
  const fitTargetMiB = fitTargetFirstMiB(config.fit_target)
  // ctx-size: llama.cpp's own default loads the model's full trained context,
  // which can OOM on a large-context model, so a conservative cap stands in.
  // There is no engine-level context setting to read here -- per-model
  // `ctx_len` owns that -- so this is purely the guard.
  //
  // Skipped when auto-fit is on: emitting it would make n_ctx non-zero for
  // every model and stop fit from reducing context to make a model fit.
  //
  // The provider's "Default context size" (ctx_size), when set, is the
  // window for every model that sets none of its own: a model section's
  // ctx-size wins over this [*] one. Blank or 0 keeps the behaviour above.
  const fitEnabled = config.fit !== false
  // Read loosely: a plugin API build older than this field has no type for it.
  const globalCtx = defaultContextSize(
    (config as { ctx_size?: unknown }).ctx_size
  )
  if (globalCtx !== undefined) {
    lines.push(`ctx-size = ${globalCtx}`)
  } else if (!fitEnabled) {
    lines.push(`ctx-size = ${DEFAULT_CTX_SIZE}`)
  }
  const noGpu = opts.cpuOnly === true
  const globalKv = resolveKvCacheTypes({
    cacheTypeK: config.cache_type_k,
    cacheTypeV: config.cache_type_v,
    flashAttn: config.flash_attn,
    computeCapability: opts.gpuComputeCapability,
    cpuOnly: noGpu,
  })
  // flash-attn default = 'auto'; explicit on/off only. A GPU too old for it
  // (pre-Pascal) is pinned off unless the user chose.
  if (
    typeof config.flash_attn === 'string' &&
    (config.flash_attn === 'on' || config.flash_attn === 'off')
  ) {
    lines.push(`flash-attn = ${config.flash_attn}`)
  } else if (gpuFlashAttnDefault(opts.gpuComputeCapability) === 'off') {
    lines.push('flash-attn = off')
  }
  // cache-type-k/v: llama.cpp's own default is f16; the `auto` setting maps to
  // q8_0 where that is safe (see kvCache.ts). Only non-f16 is written.
  if (globalKv.k !== 'f16') {
    lines.push(`cache-type-k = ${escapeIniValue(globalKv.k)}`)
  }
  if (globalKv.v !== 'f16') {
    lines.push(`cache-type-v = ${escapeIniValue(globalKv.v)}`)
  }
  // parallel default = -1 (auto); positive user value is intent. The reserved
  // slot is added on top and never exposed in the setting's own value.
  const userParallel = asFiniteNumber(config.parallel)
  if (userParallel !== undefined && userParallel > 0) {
    lines.push(`parallel = ${Math.floor(userParallel) + extraSlots}`)
    // llama.cpp only turns on unified KV as part of resolving parallel = -1;
    // passing parallel explicitly leaves it off, which splits ctx-size into
    // ctx-size/parallel per slot. Restore the auto behaviour so the configured
    // context is what each slot actually gets.
    if (kvUnifiedIsAuto) lines.push('kv-unified = true')
  }
  // spec-type default = none. ngram-mod drafts only after a 24-token match
  // with text already in the context, so on novel text it almost never
  // drafts. Measured on an RTX 5080: code-edit output 3x (first request) to
  // 10x faster on CUDA and Vulkan, also on the CPU; free-form text within
  // noise. A model section that names its own spec-type (MTP) replaces it.
  if (config.ngram_speculation !== false) {
    lines.push('spec-type = ngram-mod')
  }
  // cont-batching default = true; emit only the explicit-off case.
  if (config.cont_batching === false) {
    lines.push('cont-batching = false')
  }
  // threads default = -1 (logical cores)
  if (
    typeof config.threads === 'number' &&
    Number.isFinite(config.threads) &&
    config.threads > 0
  ) {
    lines.push(`threads = ${Math.floor(config.threads)}`)
  }
  // threads-batch default = same as threads; emit only if positive and distinct.
  if (
    typeof config.threads_batch === 'number' &&
    Number.isFinite(config.threads_batch) &&
    config.threads_batch > 0 &&
    config.threads_batch !== config.threads
  ) {
    lines.push(`threads-batch = ${Math.floor(config.threads_batch)}`)
  }
  // n-predict default = -1 (infinity)
  if (
    typeof config.n_predict === 'number' &&
    Number.isFinite(config.n_predict) &&
    config.n_predict !== -1
  ) {
    lines.push(`n-predict = ${Math.floor(config.n_predict)}`)
  }
  // batch-size default = 2048 (common.h: n_batch)
  if (
    typeof config.batch_size === 'number' &&
    Number.isFinite(config.batch_size) &&
    config.batch_size > 0 &&
    config.batch_size !== 2048
  ) {
    lines.push(`batch-size = ${Math.floor(config.batch_size)}`)
  }
  // ubatch-size: llama.cpp's default is 512. `auto` (0 or unset) writes
  // DEFAULT_UBATCH here and lets each model section refine it from VRAM.
  const globalUbatchAuto = isAutoUbatch(config.ubatch_size)
  const globalUbatch = globalUbatchAuto
    ? DEFAULT_UBATCH
    : Math.floor(config.ubatch_size as number)
  if (globalUbatch !== 512) {
    lines.push(`ubatch-size = ${globalUbatch}`)
  }
  // n-cpu-moe default = 0 (no MoE weights pinned to the host)
  if (
    typeof config.n_cpu_moe === 'number' &&
    Number.isFinite(config.n_cpu_moe) &&
    config.n_cpu_moe > 0
  ) {
    lines.push(`n-cpu-moe = ${Math.floor(config.n_cpu_moe)}`)
  }
  // n-cpu-ffn default = 0. The dense-model counterpart of n-cpu-moe, added in
  // llama.cpp 0.4.0; the two are independent and a model can want either.
  if (
    typeof config.n_cpu_ffn === 'number' &&
    Number.isFinite(config.n_cpu_ffn) &&
    config.n_cpu_ffn > 0
  ) {
    lines.push(`n-cpu-ffn = ${Math.floor(config.n_cpu_ffn)}`)
  }
  // no-kv-offload default = false (the cache is offloaded). Spelled negatively
  // to match llama.cpp's own flag and the existing no_mmap setting.
  // common_preset's parse_bool_arg recognises `no-kv-offload` as the negated
  // half of the kv-offload pair (arg.cpp:2403-2410) and inverts it, so `true`
  // here does disable offloading.
  if (config.no_kv_offload === true) {
    lines.push('no-kv-offload = true')
  }
  // tensor-split default = empty (even split across devices).
  if (
    typeof config.tensor_split === 'string' &&
    config.tensor_split.trim().length > 0
  ) {
    lines.push(`tensor-split = ${escapeIniValue(config.tensor_split.trim())}`)
  }
  // no-op-offload default = false (host tensor ops are offloaded).
  if (config.no_op_offload === true) {
    lines.push('no-op-offload = true')
  }
  // ctx-checkpoints default = 32, checkpoint-min-step default = 8192.
  if (
    asFiniteNumber(config.ctx_checkpoints) !== undefined &&
    asFiniteNumber(config.ctx_checkpoints)! >= 0 &&
    asFiniteNumber(config.ctx_checkpoints) !== 32
  ) {
    lines.push(`ctx-checkpoints = ${Math.floor(asFiniteNumber(config.ctx_checkpoints)!)}`)
  }
  if (
    asFiniteNumber(config.checkpoint_min_step) !== undefined &&
    asFiniteNumber(config.checkpoint_min_step)! >= 0 &&
    asFiniteNumber(config.checkpoint_min_step) !== 8192
  ) {
    lines.push(`checkpoint-min-step = ${Math.floor(asFiniteNumber(config.checkpoint_min_step)!)}`)
  }
  // device default = empty (auto-pick)
  if (typeof config.device === 'string' && config.device.trim().length > 0) {
    const wanted = config.device
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean)
    const known = opts.knownDeviceIds
    const stale =
      known && known.length > 0 ? wanted.filter((d) => !known.includes(d)) : []
    if (stale.length > 0) {
      console.warn(
        `[llamacpp] ignoring saved device(s) not reported by the engine: ${stale.join(', ')}`
      )
    } else {
      lines.push(`device = ${escapeIniValue(config.device)}`)
    }
  }
  // split-mode default = 'layer'
  if (
    typeof config.split_mode === 'string' &&
    config.split_mode.length > 0 &&
    config.split_mode !== 'layer'
  ) {
    lines.push(`split-mode = ${escapeIniValue(config.split_mode)}`)
  }
  // main-gpu default = 0
  if (
    typeof config.main_gpu === 'number' &&
    Number.isFinite(config.main_gpu) &&
    config.main_gpu > 0
  ) {
    lines.push(`main-gpu = ${Math.floor(config.main_gpu)}`)
  }
  // `--mlock`, `--mmap`/`--no-mmap` and `--direct-io` were deprecated aliases of
  // the single params.load_mode field and were deleted outright in 0.4.1, so
  // `load-mode` is now the only spelling llama.cpp understands. Flint keeps the
  // two familiar toggles in its settings and derives that one key from them.
  const wantsMlock = config.mlock === true
  const wantsNoMmap = config.no_mmap === true
  if (wantsMlock || wantsNoMmap) {
    const loadMode = wantsMlock
      ? wantsNoMmap
        ? 'mlock'
        : 'mmap+mlock'
      : 'none'
    lines.push(`load-mode = ${loadMode}`)
  }
  // rope-scaling default is UNSPECIFIED (let the model decide), not 'none'.
  // Treating 'none' as the default made "None" -- an explicit request to
  // disable scaling -- impossible to express.
  if (
    typeof config.rope_scaling === 'string' &&
    config.rope_scaling.length > 0 &&
    config.rope_scaling !== 'auto'
  ) {
    lines.push(`rope-scaling = ${escapeIniValue(config.rope_scaling)}`)
  }
  // rope-freq-base default = 0 (loaded from model).
  if (
    typeof config.rope_freq_base === 'number' &&
    Number.isFinite(config.rope_freq_base) &&
    config.rope_freq_base > 0
  ) {
    lines.push(`rope-freq-base = ${config.rope_freq_base}`)
  }
  // rope-freq-scale default = 0 (loaded from model). 1.0 is not the default: it
  // is an explicit "force no scaling", so it must still be emitted. `rope_scale`
  // is gone -- it was a second spelling of this same upstream field (as 1/N).
  if (
    typeof config.rope_freq_scale === 'number' &&
    Number.isFinite(config.rope_freq_scale) &&
    config.rope_freq_scale > 0
  ) {
    lines.push(`rope-freq-scale = ${config.rope_freq_scale}`)
  }
  // context-shift default = disabled
  if (config.ctx_shift === true) {
    lines.push('context-shift = true')
  }
  // cache-ram: llama.cpp's default is 8192 MiB; auto sizes it from RAM.
  // A blank field is auto too, like every other empty number here: left out,
  // llama.cpp would quietly apply its own 8192.
  const cacheRamSetting = cacheRamValue(config.cache_ram)
  const cacheRam =
    cacheRamSetting === CACHE_RAM_AUTO
      ? autoCacheRamMiB(opts.systemMemoryMiB?.total, opts.systemMemoryMiB?.free)
      : cacheRamSetting
  if (
    typeof cacheRam === 'number' &&
    Number.isFinite(cacheRam) &&
    cacheRam >= -1 &&
    cacheRam !== 8192
  ) {
    lines.push(`cache-ram = ${Math.floor(cacheRam)}`)
  }
  // lazy-mode default = auto (on for arch-marked tensors above 4 GiB). Needs
  // mmap, so it is silently inert with `no_mmap` on; `off` is the pre-0.4.0
  // behaviour of always keeping those tensors resident.
  if (config.lazy_mode === 'on' || config.lazy_mode === 'off') {
    lines.push(`lazy-mode = ${config.lazy_mode}`)
  }
  // slot-save-path has no default: naming it is what enables llama.cpp's slot
  // save/restore routes at all. Emitted even with the feature off, so the worker
  // knows which directory to keep clear and can still erase a deleted thread's
  // state; the *budget* is what decides whether anything is written. The C++ arg
  // handler throws if the directory is missing -- the worker creates it first.
  lines.push(`slot-save-path = ${escapeIniValue(threadCacheDir(providerPath))}`)
  // cache-reuse default = 0 (disabled)
  if (
    typeof config.cache_reuse === 'number' &&
    Number.isFinite(config.cache_reuse) &&
    config.cache_reuse > 0
  ) {
    lines.push(`cache-reuse = ${Math.floor(config.cache_reuse)}`)
  }
  if (config.swa_full === true) {
    lines.push('swa-full = true')
  }
  // auto is handled next to each `parallel` emission above; with no explicit
  // parallel the flag is omitted so llama.cpp's own auto resolution applies.
  if (config.kv_unified === 'on') {
    lines.push('kv-unified = true')
  } else if (config.kv_unified === 'off') {
    lines.push('kv-unified = false')
  }
  // kv-unified-per-slot default = unset. Caps one slot's share of the shared KV
  // pool, which is what bounds a single conversation once the pool is unified
  // and every surface shares a slot. Only sizes the pool itself when no
  // ctx-size is pinned (server.cpp:160-170, mirrored in the shim).
  if (
    typeof config.kv_unified_per_slot === 'number' &&
    Number.isFinite(config.kv_unified_per_slot) &&
    config.kv_unified_per_slot > 0
  ) {
    lines.push(`kv-unified-per-slot = ${Math.floor(config.kv_unified_per_slot)}`)
  }
  // reasoning-preserve defaults to on since 0.4.0, for any template advertising
  // `supports_preserve_reasoning`. Emitted only to turn it off, which restores
  // the template's own default and keeps a per-request `chat_template_kwargs`
  // (Jan's per-model `preserve_thinking`) the authoritative control.
  if (config.reasoning_preserve === false) {
    lines.push('reasoning-preserve = false')
  }
  // keep default = 0
  if (
    typeof config.keep === 'number' &&
    Number.isFinite(config.keep) &&
    config.keep !== 0
  ) {
    lines.push(`keep = ${Math.floor(config.keep)}`)
  }
  // Free-form options come last, so they win over the settings above when both
  // name the same one. Options the server must not be redirected with are
  // dropped (see BLOCKED_EXTRA_ARGS).
  lines.push(...extraArgsToIni(config.extra_args).lines)
  lines.push('')

  // ---------- per-model sections ----------
  let embeddingCount = 0
  for (const { modelId, configPath } of modelEntries) {
    let mc: ModelYaml
    try {
      mc = await invoke<ModelYaml>('read_yaml', { path: configPath })
    } catch {
      // Skip unreadable model entries rather than aborting the whole preset.
      continue
    }

    if (!mc?.model_path) continue

    const modelAbs = await joinPath([janDataFolderPath, mc.model_path])

    lines.push(`[${modelId}]`)
    lines.push(`model = ${escapeIniValue(modelAbs)}`)

    if (mc.mmproj_path) {
      const mmprojAbs = await joinPath([janDataFolderPath, mc.mmproj_path])
      lines.push(`mmproj = ${escapeIniValue(mmprojAbs)}`)
    }

    // A template body cannot survive the ini: values have no line
    // continuation, and `#`/`;` anywhere in one starts a comment. So an
    // absolute path to an existing file passes through as-is, a built-in name
    // goes inline, and anything else is written beside model.yml and passed by
    // path, which llama.cpp reads verbatim.
    const chatTemplate =
      typeof mc.chat_template === 'string' ? mc.chat_template.trim() : ''
    if (chatTemplate.length > 0) {
      const templateFile = await existingFilePath(chatTemplate)
      if (templateFile) {
        lines.push(`chat-template-file = ${escapeIniValue(templateFile)}`)
      } else if (BUILTIN_TEMPLATE_NAME_RE.test(chatTemplate)) {
        lines.push(`chat-template = ${chatTemplate}`)
      } else {
        const templatePath = await joinPath([
          modelsDir,
          modelId,
          'chat_template.jinja',
        ])
        await fs.writeFileSync(templatePath, chatTemplate)
        lines.push(`chat-template-file = ${escapeIniValue(templatePath)}`)
      }
    }

    // GBNF uses `#` for comments and is usually multi-line, so an inline body
    // can never go through the ini; it always reaches llama.cpp as a file.
    const grammar = typeof mc.grammar === 'string' ? mc.grammar.trim() : ''
    if (grammar.length > 0) {
      const grammarFile = await existingFilePath(grammar)
      if (grammarFile) {
        lines.push(`grammar-file = ${escapeIniValue(grammarFile)}`)
      } else {
        const grammarPath = await joinPath([modelsDir, modelId, 'grammar.gbnf'])
        await fs.writeFileSync(grammarPath, grammar)
        lines.push(`grammar-file = ${escapeIniValue(grammarPath)}`)
      }
    }

    // Per-model overrides -- same default-skipping rules as the [*] block.
    // An explicit 0 means "native" (load the model's own trained context).
    //
    // Emitted even with auto-fit on, unlike n-gpu-layers below: upstream's fit
    // explicitly leaves a user-set context alone (common/fit.cpp: "context size
    // set by user -> no change") and only bails on an explicit n_gpu_layers. The
    // old gate is why "Increase Context Size" did nothing while Fit was on.
    let ctxEmitted = false
    if (
      typeof mc.ctx_size === 'number' &&
      Number.isFinite(mc.ctx_size) &&
      mc.ctx_size >= 0
    ) {
      lines.push(`ctx-size = ${mc.ctx_size}`)
      ctxEmitted = true
    }
    // `n_gpu_layers` only reaches model.yml when the user set GPU Layers for
    // this model, so it is always an explicit override and always wins — even
    // with auto-fit on, where it makes fit skip its own layer-offload
    // computation for this model. That is the point of overriding it. This used
    // to be gated on `!fitEnabled`, and since fit defaults to on the setting
    // silently did nothing: set to 100, still running on CPU, no `-ngl` in the
    // launch args (janhq/jan#8894).
    //
    // -1 is auto and -2 or below means all layers, so the floor is -2, not 0.
    if (typeof mc.n_gpu_layers === 'number' && mc.n_gpu_layers >= -2) {
      lines.push(`n-gpu-layers = ${mc.n_gpu_layers}`)
    }
    if (
      typeof mc.flash_attn === 'string' &&
      (mc.flash_attn === 'on' || mc.flash_attn === 'off')
    ) {
      lines.push(`flash-attn = ${mc.flash_attn}`)
    }
    {
      // The model's value, else the global one, resolved the same way as the
      // [*] block; a line is written when it differs from what the model would
      // inherit, or when the model names a non-f16 type itself.
      const modelKv = resolveKvCacheTypes(
        {
          cacheTypeK: hasValue(mc.cache_type_k)
            ? mc.cache_type_k
            : config.cache_type_k,
          cacheTypeV: hasValue(mc.cache_type_v)
            ? mc.cache_type_v
            : config.cache_type_v,
          flashAttn: mc.flash_attn ?? config.flash_attn,
          computeCapability: opts.gpuComputeCapability,
          cpuOnly: noGpu || opts.cpuFallbackModels?.has(modelId) === true,
        },
        { fallback: opts.kvFallbackModels?.has(modelId) === true }
      )
      if (
        modelKv.k !== globalKv.k ||
        (hasValue(mc.cache_type_k) && modelKv.k !== 'f16')
      ) {
        lines.push(`cache-type-k = ${escapeIniValue(modelKv.k)}`)
      }
      if (
        modelKv.v !== globalKv.v ||
        (hasValue(mc.cache_type_v) && modelKv.v !== 'f16')
      ) {
        lines.push(`cache-type-v = ${escapeIniValue(modelKv.v)}`)
      }
    }
    if (opts.cpuFallbackModels?.has(modelId)) {
      lines.push('device = none')
    }
    // MTP either lives in the main gguf (mtp_layers > 0) or ships as a separate
    // draft gguf (mtp_model_path), which is passed to the engine as the draft.
    const hasMtpModel =
      typeof mc.mtp_model_path === 'string' && mc.mtp_model_path.length > 0
    const hasMtpLayers =
      typeof mc.mtp_layers === 'number' && mc.mtp_layers > 0
    const specDecoding = mc.mtp === true && (hasMtpLayers || hasMtpModel)

    const mcParallel = asFiniteNumber(mc.parallel)
    if (mcParallel !== undefined && mcParallel > 0) {
      lines.push(`parallel = ${Math.floor(mcParallel) + extraSlots}`)
      if (kvUnifiedIsAuto) lines.push('kv-unified = true')
    } else if (
      specDecoding &&
      !((asFiniteNumber(config.parallel) ?? 0) > 1)
    ) {
      // A speculative-decoding model gets exactly one slot unless the user asked
      // for more than one, and no reserved background slots: background requests
      // wrap onto slot 0 (upstream takes id_slot modulo the slot count). Every
      // slot of a hybrid model carries (1 + spec-draft-n-max) rows of recurrent
      // state plus its own draft context, which auto-fit does not count. With
      // three slots at native context the model overflows a 16 GB card as soon
      // as anything else holds VRAM; the driver spills into shared system RAM
      // and decode drops 5-8x (RTX 5080, Qwen3.5-9B MTP, Vulkan: 144 -> 19 t/s).
      lines.push('parallel = 1')
      if (kvUnifiedIsAuto) lines.push('kv-unified = true')
    } else if (
      fitEnabled &&
      globalCtx === undefined &&
      !ctxEmitted &&
      !((asFiniteNumber(config.parallel) ?? 0) > 1)
    ) {
      // A model whose weights do not fit VRAM: fit shrinks the context all the
      // way to its floor before it moves a single layer off the GPU, so the
      // context ends at fit-ctx (4096) and the slots share it. Measured on a
      // 16 GB RTX 5080 with the 21 GB Qwen3.5-35B-A3B: 3 slots on 4096, about
      // 1365 tokens each once they all run. One slot and an 8192 floor instead;
      // the extra KV is tens of MiB on such a model, against GiBs of weights.
      const spill = spillSlotPlan(
        (typeof mc.size_bytes === 'number' ? mc.size_bytes : 0) +
          (typeof mc.mmproj_size_bytes === 'number'
            ? mc.mmproj_size_bytes
            : 0),
        opts.gpuMemoryMiB,
        fitTargetMiB,
        fitCtxFloor,
        1 + extraSlots
      )
      if (spill) {
        lines.push('parallel = 1')
        if (kvUnifiedIsAuto) lines.push('kv-unified = true')
        if (spill.fitCtx !== fitCtxFloor) lines.push(`fit-ctx = ${spill.fitCtx}`)
      }
    }
    // Same reason: the draft context is sized like the main one and fit does
    // not see it, so a speculative model with no context of its own is capped
    // instead of loading its full trained context.
    if (specDecoding && fitEnabled && !ctxEmitted && globalCtx === undefined) {
      lines.push(`ctx-size = ${SPEC_DEFAULT_CTX_SIZE}`)
      ctxEmitted = true
    }
    if (mc.cont_batching === false) {
      lines.push('cont-batching = false')
    }
    if (
      typeof mc.batch_size === 'number' &&
      mc.batch_size > 0 &&
      mc.batch_size !== 2048
    ) {
      lines.push(`batch-size = ${Math.floor(mc.batch_size)}`)
    }
    // A per-model value is written whenever set: the [*] value it would
    // otherwise inherit is no longer llama.cpp's 512. Embedders pin their own
    // below.
    if (!isAutoUbatch(mc.ubatch_size)) {
      if (mc.embedding !== true) {
        lines.push(`ubatch-size = ${Math.floor(mc.ubatch_size as number)}`)
      }
    } else if (globalUbatchAuto && mc.embedding !== true) {
      const weights =
        (typeof mc.size_bytes === 'number' ? mc.size_bytes : 0) +
        (typeof mc.mmproj_size_bytes === 'number' ? mc.mmproj_size_bytes : 0)
      const ub = autoUbatchSize(weights, opts.gpuMemoryMiB)
      if (ub !== undefined && ub !== globalUbatch) {
        lines.push(`ubatch-size = ${ub}`)
      }
    }
    if (mc.cpu_moe === true) {
      lines.push('cpu-moe = true')
    }
    if (typeof mc.n_cpu_moe === 'number' && mc.n_cpu_moe > 0) {
      lines.push(`n-cpu-moe = ${Math.floor(mc.n_cpu_moe)}`)
    }
    if (typeof mc.n_cpu_ffn === 'number' && mc.n_cpu_ffn > 0) {
      lines.push(`n-cpu-ffn = ${Math.floor(mc.n_cpu_ffn)}`)
    }
    // A model's own Context Shift choice wins over the global one; a line is
    // written only when it differs from what the [*] block already gives it.
    if (
      typeof mc.ctx_shift === 'boolean' &&
      mc.ctx_shift !== (config.ctx_shift === true)
    ) {
      lines.push(`context-shift = ${mc.ctx_shift}`)
    }
    if (mc.no_kv_offload === true) {
      // INI key is the negated form; parse_bool_arg flips it server-side.
      // Writing `no-kv-offload = true` => kv-offload disabled.
      lines.push('no-kv-offload = true')
    }
    if (typeof mc.override_tensor === 'string' && mc.override_tensor.trim().length > 0) {
      lines.push(`override-tensor = ${escapeIniValue(mc.override_tensor)}`)
    }
    // mmproj-offload defaults to on; only emit when explicitly disabled.
    if (mc.mmproj_offload === false) {
      lines.push('mmproj-offload = false')
    }

    let dflashActive = false
    if (specDecoding) {
      const specType =
        typeof mc.spec_type === 'string' && SPEC_TYPES.has(mc.spec_type)
          ? mc.spec_type
          : DEFAULT_SPEC_TYPE
      lines.push(`spec-type = ${specType}`)
      // A DFlash draft only keeps its speed-up under greedy verification, so
      // the server default is temperature 0 (a request may still override it).
      if (specType === 'draft-dflash') {
        dflashActive = true
        lines.push('temperature = 0')
      }
      if (hasMtpModel) {
        const mtpAbs = await joinPath([janDataFolderPath, mc.mtp_model_path!])
        lines.push(`spec-draft-model = ${escapeIniValue(mtpAbs)}`)
      }
      if (
        typeof mc.spec_draft_n_max === 'number' &&
        mc.spec_draft_n_max > 0
      ) {
        lines.push(`spec-draft-n-max = ${Math.floor(mc.spec_draft_n_max)}`)
      }
      if (
        typeof mc.spec_draft_n_min === 'number' &&
        mc.spec_draft_n_min >= 0
      ) {
        lines.push(`spec-draft-n-min = ${Math.floor(mc.spec_draft_n_min)}`)
      }
      if (
        typeof mc.spec_draft_p_min === 'number' &&
        mc.spec_draft_p_min >= 0 &&
        mc.spec_draft_p_min <= 1
      ) {
        lines.push(`spec-draft-p-min = ${mc.spec_draft_p_min}`)
      }
      // llama.cpp 0.6.0 can sample the draft and have the target verify it by
      // rejection sampling, which keeps the speed-up at temperature > 0 where
      // an argmax draft is rejected more often. A DFlash draft only works under
      // greedy verification, so it never gets the probabilistic mode.
      if (
        !dflashActive &&
        (mc.spec_draft_sampling === 'greedy' ||
          mc.spec_draft_sampling === 'probabilistic')
      ) {
        lines.push(`spec-draft-sampling = ${mc.spec_draft_sampling}`)
      }
    }

    // Per-model sampling defaults. llama-server applies these as server-side
    // defaults for every request to the model (chat and external API clients);
    // a per-request JSON field still overrides them. INI keys are the CLI
    // long-form names minus dashes.
    //
    // Skipping a value equal to llama.cpp's default is not just tidiness here:
    // passing any of the first six sets a `user_sampling_config` bit that
    // suppresses the GGUF's own `general.sampling.*` recommendations, so writing
    // an identical-looking default silently overrode what the model asked for.
    // `null` means "no default, always emit" -- the two penalties set no bit.
    const samplingIniKeys: Array<[keyof ModelYaml, string, number | null]> = [
      ['temperature', 'temperature', 0.8],
      ['top_k', 'top-k', 40],
      ['top_p', 'top-p', 0.95],
      ['min_p', 'min-p', 0.05],
      ['repeat_last_n', 'repeat-last-n', 64],
      ['repeat_penalty', 'repeat-penalty', 1.0],
      ['presence_penalty', 'presence-penalty', null],
      ['frequency_penalty', 'frequency-penalty', null],
      // llama.cpp's own default is -1 (a random seed each request); only a
      // fixed, non-negative seed is written.
      ['seed', 'seed', -1],
    ]
    for (const [yamlKey, iniKey, upstreamDefault] of samplingIniKeys) {
      const v = mc[yamlKey]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      if (dflashActive && iniKey === 'temperature') continue
      if (upstreamDefault !== null && v === upstreamDefault) continue
      // Upstream throws on a negative window rather than clamping, which aborts
      // the load; a legacy -1 from the old "-1 = full context" UI must not reach
      // the preset.
      if (iniKey === 'repeat-last-n' && v < 0) continue
      if (iniKey === 'seed' && (v < 0 || !Number.isInteger(v))) continue
      lines.push(`${iniKey} = ${v}`)
    }

    if (mc.embedding === true) {
      embeddingCount++
      lines.push('embeddings = true')
      // Embedders have a small trained context (e.g. MiniLM = 512). Without an
      // explicit override they inherit the global [*] ctx-size (8192), which
      // exceeds n_ctx_train and fails to load. Pin to native (0 = load from
      // model) unless model.yml already set a positive per-model ctx-size.
      if (!ctxEmitted) {
        lines.push('ctx-size = 0')
      }
      const pooling =
        typeof mc.pooling === 'string' && mc.pooling.length > 0
          ? mc.pooling
          : 'mean'
      lines.push(`pooling = ${escapeIniValue(pooling)}`)
      const ubatch =
        typeof mc.ubatch_size === 'number' && mc.ubatch_size > 0
          ? mc.ubatch_size
          : DEFAULT_EMBEDDING_UBATCH
      const batch =
        typeof mc.batch_size === 'number' && mc.batch_size >= ubatch
          ? mc.batch_size
          : ubatch
      lines.push(`ubatch-size = ${ubatch}`)
      lines.push(`batch-size = ${batch}`)
    }

    // Server-side reasoning default for this model, so external API clients
    // that never send `chat_template_kwargs.enable_thinking` think (or don't)
    // the same way the chat UI does. A per-request value still overrides it.
    if (mc.reasoning === 'on' || mc.reasoning === 'off') {
      lines.push(`reasoning = ${mc.reasoning}`)
    }
    // Free-form per-model options come last, so they win over everything above
    // and over the global Additional arguments. Same blocked-option rules.
    lines.push(...extraArgsToIni(mc.extra_args).lines)

    lines.push('load-on-startup = false')
    lines.push('')
  }

  const outPath = await joinPath([providerPath, 'router.preset.ini'])
  const tmpPath = await joinPath([providerPath, 'router.preset.ini.tmp'])
  const body = lines.join('\n')

  // Atomic write: tmp + rename. fs.mv overwrites on Tauri's side.
  await fs.writeFileSync(tmpPath, body)
  try {
    // No rm first: that left a window with no preset for a concurrent load.
    // If the rename cannot overwrite, the fallback below writes in place.
    await fs.mv(tmpPath, outPath)
  } catch {
    // Fallback: if rename fails, write directly to the target.
    await fs.writeFileSync(outPath, body)
    try {
      await fs.rm(tmpPath)
    } catch {
      /* ignore */
    }
  }

  return { path: outPath, embeddingCount }
}
