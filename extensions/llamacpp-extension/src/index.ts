/**
 * @file This file exports a class that implements the InferenceExtension interface from the @janhq/core package.
 * The class provides methods for initializing and stopping a model, and for making inference requests.
 * It also subscribes to events emitted by the @janhq/core package and handles new message requests.
 * @version 1.0.0
 * @module llamacpp-extension/src/index
 */

import {
  AIEngine,
  type EmbeddingEngine,
  getJanDataFolderPath,
  fs,
  joinPath,
  modelInfo,
  SessionInfo,
  UnloadResult,
  chatCompletion,
  chatCompletionChunk,
  ImportOptions,
  type SpecDraftKind,
  chatCompletionRequest,
  events,
  AppEvent,
  DownloadEvent,
  chatCompletionRequestMessage,
  SettingComponentProps,
  DropdownComponentProps,
  logger,
} from '@janhq/core'
import {
  readSettingsFile,
  writeSettingsFile,
  settingsFileExists,
} from './settings-store'

import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import {
  getProxyConfig,
  buildEmbedBatches,
  mergeEmbedResponses,
  detectEmbeddingFromGgufMeta,
  detectMtpLayersFromGgufMeta,
  resolveSpecDraftKind,
  detectTemplateKwargsFromChatTemplate,
  chatTemplateSupportsTools,
  getDefaultEmbeddingModelId,
  modelFileProblem,
  ggufShardPaths,
  ggufFirstShardPath,
  assertSha256Matches,
  setDefaultEmbeddingModelId,
  isValidModelId,
  isSafeModelRef,
  legacyAutoUnload,
  modelsMaxFromAutoUnload,
  type EmbedBatchResult,
} from './util'
import {
  generatePreset,
  threadCacheDir,
  contextSizeToPersist,
  DEFAULT_EMBEDDING_UBATCH,
  CACHE_RAM_AUTO,
  describeFitBudget,
  toModelId,
} from './preset'
import {
  kvDefaultsInEffect,
  lowestComputeCapability,
  resolveKvCacheTypes,
  shouldRetryLoadWithF16Kv,
} from './kvCache'
import { isGpuCrashDuringLoad, shouldRetryLoadOnCpu } from './cpuFallback'
import {
  evaluateEmbeddingVector,
  evaluateGpuOffload,
  backendFromDeviceIds,
  type EmbeddingVectorProblem,
  type GpuOffloadCheck,
  type ReadinessStatus,
} from './readiness'
import {
  getBackendSetting,
  setBackendSetting,
  removeBackendSetting,
} from './backend-settings'
import { basename } from '@tauri-apps/api/path'
import {
  asI32,
  loadLlamaModel,
  readGgufMetadata,
  sha256File,
  findGgufTensors,
  isModelSupported,
  unloadLlamaModel,
  startEngine,
  stopEngine as pluginStopEngine,
  engineSlotsIdle,
  eraseThreadSlotState,
  getEngineInfo as pluginGetEngineInfo,
  getEngineVersion as pluginGetEngineVersion,
  reloadEngineModels,
  engineDevices,
  engineAddonRestartPending,
  generateApiKey as pluginGenerateApiKey,
  findSessionByModel as pluginFindSessionByModel,
  ensureSessionReady as pluginEnsureSessionReady,
  getLoadedModels as pluginGetLoadedModels,
  LlamacppConfig,
  ModelConfig,
  TemplateKwarg,
  EmbeddingResponse,
  ModelProps,
  DeviceList,
  EngineVersion,
} from '@janhq/tauri-plugin-llamacpp-api'
import { overrideAmdVulkanMemory } from './deviceMemory'
import { getSystemUsage, getSystemInfo } from '@janhq/tauri-plugin-hardware-api'

const EMBEDDING_CHECK_VERSION = 3
const MTP_CHECK_VERSION = 1

// The tensor that marks a DSpark draft: it is a DFlash one plus this Markov
// head (common/speculative.cpp, llama-arch.cpp LLM_TENSOR_DSPARK_MARKOV_W1).
const MARKOV_HEAD_TENSOR = 'markov_w1.weight'
const TEMPLATE_KWARGS_CHECK_VERSION = 1

// Provider settings that end up in `router.preset.ini` (`[*]` global section
// in preset.ts). Mutating any of these needs the preset reloaded so the new
// value is read; cosmetic / process-only keys (models_max, timeout,
// llamacpp_env, idle_unload_minutes) are handled separately or not at all.
const PRESET_AFFECTING_KEYS = new Set<string>([
  'ctx_size',
  'fit',
  'fit_target',
  'fit_ctx',
  'flash_attn',
  'extra_args',
  'cache_type_k',
  'cache_type_v',
  'parallel',
  'reserve_background_slots',
  'cont_batching',
  'ngram_speculation',
  'threads',
  'threads_batch',
  'n_predict',
  'batch_size',
  'ubatch_size',
  'n_cpu_moe',
  'n_cpu_ffn',
  'no_kv_offload',
  'device',
  'split_mode',
  'main_gpu',
  'no_mmap',
  'mlock',
  'rope_scaling',
  'rope_freq_base',
  'rope_freq_scale',
  'ctx_shift',
  'cache_ram',
  // persist_thread_cache decides whether slot-save-path is emitted at all;
  // thread_cache_size is not a preset key but rides the same reload, which
  // carries it to the worker (see reload_engine_models).
  'persist_thread_cache',
  'thread_cache_size',
  'cache_reuse',
  'swa_full',
  'keep',
  'kv_unified',
  'tensor_split',
  'no_op_offload',
  'ctx_checkpoints',
  'checkpoint_min_step',
  'kv_unified_per_slot',
  'agent_slots',
  'reasoning_preserve',
  'lazy_mode',
])


/**
 * A class that implements the InferenceExtension interface from the @janhq/core package.
 * The class provides methods for initializing and stopping a model, and for making inference requests.
 * It also subscribes to events emitted by the @janhq/core package and handles new message requests.
 */

type YamlSettingValue = string | number | boolean | null

type PersistedProviderSetting = {
  controller_props?: {
    value?: unknown
  }
}

type PersistedModelState = {
  id?: unknown
  settings?: Record<string, PersistedProviderSetting>
}

const MODEL_PROVIDER_STORE_KEY = 'model-provider'
/** Set once the user has agreed to the first-run download. */
const SETUP_CONSENT_KEY = 'llamacpp-first-run-setup-started'
/**
 * The embedding model Flint prefers when it is already installed.
 *
 * There is deliberately no URL beside this id. Flint used to fetch this model
 * from huggingface.co at startup, and again on the first RAG call if that had
 * failed, so a fresh launch reached the internet without the user asking for
 * anything. Nothing downloads a model on Flint's initiative any more: an
 * embedding feature either finds a model already installed or reports that it
 * is unavailable.
 */
const FALLBACK_EMBEDDING_MODEL_ID = 'sentence-transformer-mini'
const LLAMACPP_MODEL_SETTINGS_BACKFILL_KEY =
  'llamacpp_model_yaml_backfill_v2'

/// The GPU-layers value the old UI shipped as its default. v1 of the backfill
/// copied it into every model.yml, which pins offload to 100 layers and defeats
/// llama.cpp's own -1 (auto, VRAM-aware) -- an OOM on a small GPU. v2 removes it
/// again. A user who deliberately chose exactly 100 loses that choice, which is
/// the right trade: 100 was never a considered value, it was the default.
const LEGACY_NGL_DEFAULT = 100

/// Matches the `timeout` default in settings.json.
const DEFAULT_TIMEOUT = 600
const TOKENIZE_TIMEOUT_MS = 60_000
const TOKENIZE_CONCURRENCY = 4
const EMBED_TIMEOUT_MS = 120_000

/**
 * fetch with a deadline for the response headers. A deadline hit rejects with
 * `Request timed out`; an abort from `external` keeps its own reason.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  ms: number,
  external?: AbortSignal
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('Request timed out'))
  }, ms)
  const onExternal = () => controller.abort(external?.reason)
  if (external) {
    if (external.aborted) controller.abort(external.reason)
    else external.addEventListener('abort', onExternal, { once: true })
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (e) {
    if (timedOut) throw new Error('Request timed out')
    throw e
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternal)
  }
}

// Short and non-empty: enough to exercise tokenize plus pooling without making
// setup wait on a long prompt.
const EMBEDDING_PROBE_TEXT = 'jan setup embedding probe'

/** Thrown, and recognised by `verifyEmbeddingModel`, when nothing is installed. */
const NO_EMBEDDING_MODEL_MESSAGE =
  'No embedding model is installed. Flint does not download one on its own; ' +
  'import one from Models > Llama.cpp.'

export interface EmbeddingModelReport {
  status: ReadinessStatus
  /** No embedding model is installed yet; not a failure on a clean profile. */
  notConfigured?: boolean
  modelId?: string
  dimension?: number
  problem?: EmbeddingVectorProblem
  error?: string
  /** The engine has not finished setting up, so nothing was concluded. */
  pending?: boolean
}

export interface GpuOffloadReport extends GpuOffloadCheck {
  backend: string
  /** Set when the device probe itself failed, leaving `reason` undetermined. */
  error?: string
  /** The engine has not finished setting up, so nothing was concluded. */
  pending?: boolean
}

// Sampling defaults are floats/ints where 0 is a meaningful value (e.g.
// temperature=0), so unlike ctx_len these coercions keep 0 and only reject
// blank/non-finite input.
const coerceFloatSetting = (v: unknown): YamlSettingValue => {
  if (v === '' || v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
const coerceIntSetting = (v: unknown): YamlSettingValue => {
  if (v === '' || v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.floor(n) : null
}

const KV_CACHE_TYPE_SETTINGS = new Set([
  'f32',
  'f16',
  'bf16',
  'q8_0',
  'q4_0',
  'q4_1',
  'iq4_nl',
  'q5_0',
  'q5_1',
])
const coerceKvCacheTypeSetting = (v: unknown): YamlSettingValue =>
  typeof v === 'string' && KV_CACHE_TYPE_SETTINGS.has(v.trim().toLowerCase())
    ? v.trim().toLowerCase()
    : null

const MODEL_SETTINGS_YAML_MAPPING: Record<
  string,
  {
    yamlKey: string
    coerce: (v: unknown) => YamlSettingValue
  }
> = {
  // Sampling defaults: persisted to model.yml and emitted into the router
  // preset so they apply server-side to every request (chat and external API),
  // overridable per-request. Keys mirror MODEL_SAMPLING_SETTING_KEYS in the
  // web-app transport.
  temperature: { yamlKey: 'temperature', coerce: coerceFloatSetting },
  top_k: { yamlKey: 'top_k', coerce: coerceIntSetting },
  top_p: { yamlKey: 'top_p', coerce: coerceFloatSetting },
  min_p: { yamlKey: 'min_p', coerce: coerceFloatSetting },
  // Not coerceIntSetting: upstream throws on a negative window on both the
  // preset path and the per-request path, so a legacy -1 from the old
  // "-1 = full context" UI has to be dropped, not passed through. Omitting the
  // key lets upstream's own default (64) apply.
  repeat_last_n: {
    yamlKey: 'repeat_last_n',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null
    },
  },
  repeat_penalty: { yamlKey: 'repeat_penalty', coerce: coerceFloatSetting },
  presence_penalty: { yamlKey: 'presence_penalty', coerce: coerceFloatSetting },
  frequency_penalty: {
    yamlKey: 'frequency_penalty',
    coerce: coerceFloatSetting,
  },
  // Fixed seed. A negative value means "random" upstream, so it is dropped.
  seed: {
    yamlKey: 'seed',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isInteger(n) && n >= 0 ? n : null
    },
  },
  ctx_len: {
    yamlKey: 'ctx_size',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    },
  },
  ngl: {
    yamlKey: 'n_gpu_layers',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      // -1 is auto (VRAM-aware) and -2 or below means all layers, so the floor
      // is -2 rather than 0.
      return Number.isFinite(n) && n >= -2 ? Math.floor(n) : null
    },
  },
  chat_template: {
    yamlKey: 'chat_template',
    coerce: (v) =>
      typeof v === 'string' && v.trim().length > 0 ? v : null,
  },
  grammar: {
    yamlKey: 'grammar',
    coerce: (v) =>
      typeof v === 'string' && v.trim().length > 0 ? v : null,
  },
  batch_size: {
    yamlKey: 'batch_size',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    },
  },
  ubatch_size: {
    yamlKey: 'ubatch_size',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    },
  },
  cpu_moe: {
    yamlKey: 'cpu_moe',
    coerce: (v) => (v === true ? true : null),
  },
  n_cpu_moe: {
    yamlKey: 'n_cpu_moe',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    },
  },
  n_cpu_ffn: {
    yamlKey: 'n_cpu_ffn',
    coerce: (v) => {
      if (v === '' || v == null) return null
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
    },
  },
  no_kv_offload: {
    yamlKey: 'no_kv_offload',
    coerce: (v) => (v === true ? true : null),
  },
  // Per-model overrides of the global setting. `auto` / empty means "inherit the
  // global one", so it is dropped rather than written as a value that would pin
  // the model to the auto default.
  ctx_shift: {
    yamlKey: 'ctx_shift',
    coerce: (v) =>
      v === 'on' || v === true ? true : v === 'off' || v === false ? false : null,
  },
  cache_type_k: {
    yamlKey: 'cache_type_k',
    coerce: coerceKvCacheTypeSetting,
  },
  cache_type_v: {
    yamlKey: 'cache_type_v',
    coerce: coerceKvCacheTypeSetting,
  },
  override_tensor_buffer_t: {
    yamlKey: 'override_tensor',
    coerce: (v) =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim() : null,
  },
  offload_mmproj: {
    yamlKey: 'mmproj_offload',
    coerce: (v) => (v === false ? false : null),
  },
  // Server-side default for the reasoning toggle (llama-server `--reasoning`),
  // so API clients get the same behavior as the chat UI. `auto` leaves it unset.
  server_reasoning: {
    yamlKey: 'reasoning',
    coerce: (v) => (v === 'on' || v === 'off' ? v : null),
  },
  // Free-form llama-server options for this model only (e.g. --cache-type-k
  // turbo3). Written after every other option in the preset.
  model_extra_args: {
    yamlKey: 'extra_args',
    coerce: (v) =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim() : null,
  },
}

async function readPersistedLlamacppModels(): Promise<PersistedModelState[]> {
  try {
    const raw = await getBackendSetting(MODEL_PROVIDER_STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const providers = parsed?.state?.providers
    if (!Array.isArray(providers)) return []
    const llamacpp = providers.find(
      (provider: { provider?: unknown }) => provider?.provider === 'llamacpp'
    )
    return Array.isArray(llamacpp?.models) ? llamacpp.models : []
  } catch (error) {
    logger.warn('Failed to read persisted llamacpp model settings:', error)
    return []
  }
}

// Folder structure for llamacpp extension:
// <Flint's data folder>/llamacpp
//  - models/<modelId>/
//    - model.yml (required)
//    - model.gguf (optional, present if downloaded from URL)
//    - mmproj.gguf (optional, present if mmproj exists and it was downloaded from URL)
// Contents of model.yml can be found in ModelConfig interface
//
//  - backends/<backend_version>/<backend_type>/
//    - build/bin/llama-server (or llama-server.exe on Windows)
//
//  - lib/
//    - e.g. libcudart.so.12

export default class llamacpp_extension extends AIEngine implements EmbeddingEngine {
  provider: string = 'llamacpp'
  timeout: number = 600
  llamacpp_env: string = ''
  readonly providerId: string = 'llamacpp'

  private config: LlamacppConfig
  private providerPath!: string
  private apiSecret: string = 'JustAskNow'
  private pendingDownloads: Map<string, Promise<void>> = new Map()
  /** Keyed by modelId; two imports of one model would cancel each other. */
  private pendingImports: Map<string, Promise<void>> = new Map()
  /**
   * Retained so setup can still report an embedding problem, but no longer set
   * by a startup download -- there is no longer a startup download.
   */
  private embedderBootstrapError?: string
  /**
   * True while the fallback embedder is being fetched.
   *
   * The old readiness gate keyed off "no backend selected yet", which happened
   * to cover this window on a fresh install. The engine ships with the app now,
   * so that proxy is gone and this is the direct signal -- without it, a normal
   * first-run download is reported as a failed embedding check.
   */
  private loadingModels = new Map<string, Promise<SessionInfo>>() // Track loading promises
  private unlistenValidationStarted?: () => void

  private enginePort?: number
  private engineApiKey?: string
  private engineVersion?: EngineVersion
  private presetPath?: string
  private engineStartLock: Promise<void> | null = null
  private userModelsMax: number = 1
  private engineEmbeddingBonus: number = 0
  private loadedChatOrder: string[] = []
  // Models whose `auto` KV cache defaults failed to load and now run f16. Kept
  // for the session so the next load does not fail the same way; cleared when
  // a KV or flash-attn setting changes.
  private kvFallbackModels = new Set<string>()
  /** Models whose load crashed on an unsupported CPU instruction; kept off the GPU. */
  private cpuFallbackModels = new Set<string>()

  // The engine worker spawn runs off the onLoad critical path; awaited via
  // ensureEngineReady() before any model load so inference never races it.
  private backgroundInit?: Promise<void>
  /** Single-flight provisioning run; see ensureProvisioned(). */
  private provisioning?: Promise<void>

  override async onLoad(): Promise<void> {
    super.onLoad() // Calls registerEngine() from AIEngine

    await this.migrateLocalStorageToFile()

    // The engine is bundled at a pinned version, so there is no backend or
    // version to migrate or select. `registerSettings` drops the keys that no
    // longer exist in SETTINGS (llamacpp_version, llamacpp_backend,
    // check_for_updates, auto_update_engine, verify_backend_deps) from the
    // persisted set on its own.
    const settings = structuredClone(SETTINGS)
    // registerSettings rewrites the persisted set without `auto_unload`, so
    // the legacy value has to be read first.
    let legacyAutoUnloadValue: boolean | undefined
    try {
      legacyAutoUnloadValue = legacyAutoUnload(await readSettingsFile())
    } catch (e) {
      logger.warn('Could not read legacy auto_unload:', e)
    }
    await this.registerSettings(settings)

    this.config = (await this.loadConfig(settings)) as LlamacppConfig

    // Auto-fit is on by default: it places as many layers on the GPU as VRAM
    // allows, and leaves a context size the user or model set alone. Turn it
    // back on for users the old force-off migration left with it disabled.
    await this.migrateFitOn()

    await this.migrateAutoUnloadToModelsMax(legacyAutoUnloadValue)

    await this.migrateUbatchAuto()

    await this.migrateCacheRamAuto()

    this.timeout = asI32(this.config.timeout, DEFAULT_TIMEOUT) || DEFAULT_TIMEOUT
    this.llamacpp_env = this.config.llamacpp_env

    // This sets the base directory where model files for this provider are stored.
    await this.getProviderPath()

    await this.migratePersistedModelSettingsToYaml()

    // Set up validation event listeners to bridge Tauri events to frontend
    this.unlistenValidationStarted = await listen<{
      modelId: string
      downloadType: string
    }>('onModelValidationStarted', (event) => {
      events.emit(DownloadEvent.onModelValidationStarted, event.payload)
    })

    // Deferred off onLoad so the UI unblocks; performLoad awaits it via
    // ensureEngineReady(). The engine is bundled with the app, so provisioning
    // fetches nothing: no backend catalog, no engine download, and no longer an
    // embedder either.
    this.backgroundInit = this.ensureProvisioned()
  }


  /**
   * Runs the first-run provisioning the setup screen asked for, and remembers
   * that it was asked so a later launch does not wait again.
   */
  async startFirstRunSetup(): Promise<void> {
    try {
      await setBackendSetting(SETUP_CONSENT_KEY, 'true')
    } catch (e) {
      logger.warn('Could not persist the first-run setup flag:', e)
    }
    await this.ensureProvisioned()
  }

  /**
   * Starts the engine, then installs the fallback embedder. Single-flight:
   * startup, the setup screen and the first model load can all ask for it, and
   * only one run happens.
   *
   * There is no backend selection step any more -- the engine is linked into
   * the shipped worker at a pinned version, so the ordering dance between
   * "download a backend first" and "start first for availability" is gone.
   */
  private ensureProvisioned(): Promise<void> {
    if (!this.provisioning) {
      const run: Promise<void> = (async () => {
        try {
          await this.startEngine()
        } catch (e) {
          logger.error('Engine failed to start during provisioning:', e)
          this.reportMissingLibrariesFromError(e)
          // Forget the failed run so the next call retries instead of handing
          // back the cached failure for the rest of the session.
          await Promise.resolve()
          if (this.provisioning === run) this.provisioning = undefined
        }
      })()
      this.provisioning = run
    }
    this.backgroundInit = this.provisioning
    return this.provisioning
  }


  /**
   * Why the startup embedder install failed, for setup to report. Undefined
   * when it succeeded or has not run; the import is retried on demand, so this
   * is advisory rather than terminal.
   */
  /**
   * A launch failure that names unresolvable libraries is the one dependency
   * problem a bundled engine still has: the GPU driver runtime (CUDA, Vulkan)
   * lives on the user's machine, not in the app. Raises the same dependency
   * dialog the old pre-flight backend verification did.
   */
  private reportMissingLibrariesFromError(error: unknown): void {
    const err = error as { code?: string; missing_libraries?: unknown }
    if (err?.code !== 'MISSING_SHARED_LIBRARY') return

    const libs = Array.isArray(err.missing_libraries)
      ? err.missing_libraries.filter(
          (lib): lib is string => typeof lib === 'string'
        )
      : []
    if (libs.length === 0) return

    // The engine is bundled, so there is no selected variant to name. The
    // unresolved library itself identifies the runtime that is missing, and
    // getBackendDisplayName matches on exactly these substrings.
    const joined = libs.join(' ').toLowerCase()
    const backend = ['cuda', 'vulkan', 'hip', 'metal'].find((b) =>
      joined.includes(b)
    )
    events.emit(AppEvent.onBackendVerificationFailed, {
      backend: backend ?? '',
      missingLibraries: libs,
    })
  }

  getEmbedderBootstrapError(): string | undefined {
    return this.embedderBootstrapError
  }

  /**
   * Proves the embedding model can actually produce a usable vector, rather
   * than inferring health from a completed download. Never throws: setup
   * reports the problem and lets the user continue.
   */
  async verifyEmbeddingModel(): Promise<EmbeddingModelReport> {
    let modelId: string | undefined
    try {
      const sInfo = await this.ensureEmbeddingModelLoaded()
      modelId = sInfo.model_id
      const response = await this.embed([EMBEDDING_PROBE_TEXT])
      const check = evaluateEmbeddingVector(response?.data?.[0]?.embedding)
      return {
        status: check.ok ? 'ok' : 'warning',
        modelId,
        dimension: check.dimension,
        problem: check.problem,
      }
    } catch (e) {
      // Nothing installed and nothing failed: a clean profile, not an error.
      // Reporting it as one put a red warning on every first run.
      if (
        !this.getEmbedderBootstrapError() &&
        e instanceof Error &&
        e.message === NO_EMBEDDING_MODEL_MESSAGE
      ) {
        return { status: 'ok', notConfigured: true }
      }
      // A failed startup install is the more specific cause, and it is the one
      // the user can act on.
      return {
        status: 'warning',
        modelId,
        error:
          this.getEmbedderBootstrapError() ??
          (e instanceof Error ? e.message : String(e)),
      }
    }
  }

  /**
   * Detects a GPU backend that runs entirely on the CPU. Such a router starts
   * cleanly and reports healthy, so this comparison against the engine's own
   * device list is the only signal that offload never happened.
   */
  async verifyGpuOffload(): Promise<GpuOffloadReport> {
    let devices: DeviceList[]
    try {
      devices = await this.getDevices()
    } catch (e) {
      // Without a device list there is no basis for a reason code, and guessing
      // one would point the user at the wrong fix.
      return {
        status: 'warning',
        backend: '',
        gpuExpected: false,
        engineDeviceCount: 0,
        error: e instanceof Error ? e.message : String(e),
      }
    }

    let hardwareGpuCount = 0
    let hardwareGpus: string[] | undefined
    try {
      const gpus = (await getSystemInfo())?.gpus ?? []
      hardwareGpuCount = gpus.length
      hardwareGpus = gpus.map((gpu) => gpu.name ?? '')
    } catch (e) {
      logger.warn('Hardware GPU probe failed during setup verification:', e)
    }

    return {
      backend: backendFromDeviceIds(devices.map((d) => d.id)),
      ...evaluateGpuOffload({
        engineDeviceCount: devices.length,
        hardwareGpuCount,
        hardwareGpus,
        engineDevices: devices.map((d) => ({ id: d.id, name: d.name })),
      }),
    }
  }

  override async getSettings(): Promise<SettingComponentProps[]> {
    return readSettingsFile()
  }

  /**
   * Each setting's saved value, or its default. One read of the settings file:
   * `getSetting` per key re-read it every time (~6 IPC calls each), which held
   * the window's first render back by a few hundred milliseconds.
   */
  async loadConfig(
    settings: SettingComponentProps[]
  ): Promise<Record<string, unknown>> {
    const saved = await this.getSettings()
    const config: Record<string, unknown> = {}
    for (const item of settings) {
      const value = saved.find((s) => s.key === item.key)?.controllerProps.value
      config[item.key] = value ?? item.controllerProps.value
    }
    return config
  }

  override async updateSettings(
    componentProps: Partial<SettingComponentProps>[]
  ): Promise<void> {
    const current = await readSettingsFile()
    const changed: { key: string; value: unknown }[] = []
    const updated = current.length
      ? current.map((s) => {
          const patch = componentProps.find((p) => p.key === s.key)
          if (patch?.controllerProps) {
            const nextValue = (patch.controllerProps as { value?: unknown })
              .value
            const prevValue = (s.controllerProps as { value?: unknown }).value
            if (nextValue !== prevValue) {
              changed.push({ key: s.key, value: nextValue })
            }
            return {
              ...s,
              controllerProps: { ...s.controllerProps, value: nextValue },
            } as SettingComponentProps
          }
          return s
        })
      : ((): SettingComponentProps[] => {
          const arr = componentProps as SettingComponentProps[]
          for (const s of arr) {
            changed.push({
              key: s.key,
              value: (s.controllerProps as { value?: unknown })?.value,
            })
          }
          return arr
        })()
    // A setting added after the file was written (ngram_speculation, a new
    // ubatch mode) is not in it: without this its change was dropped, so the
    // preset kept the old value until something else rewrote it.
    if (current.length) {
      for (const p of componentProps) {
        if (!p.key || current.some((s) => s.key === p.key)) continue
        const value = (p.controllerProps as { value?: unknown } | undefined)?.value
        updated.push(p as SettingComponentProps)
        changed.push({ key: p.key, value })
      }
    }
    await writeSettingsFile(updated)
    const previousConfig = { ...this.config }
    const previousTimeout = this.timeout
    const previousEnv = this.llamacpp_env
    for (const { key, value } of changed) {
      this.onSettingUpdate(key, value)
    }
    if (this.presetRefreshTimer) {
      clearTimeout(this.presetRefreshTimer)
      this.presetRefreshTimer = null
      // Startup migrations are included in the initial preset. Once loaded,
      // an awaited settings save must include engine application, not merely
      // schedule it after the caller has already sent its next request.
      if (this.backgroundInit) {
        try {
          await this.refreshEnginePreset()
        } catch (error) {
          this.config = previousConfig
          this.timeout = previousTimeout
          this.llamacpp_env = previousEnv
          await writeSettingsFile(current)
          throw error
        }
      }
    }
  }

  override async registerSettings(
    settings: SettingComponentProps[]
  ): Promise<void> {
    settings.forEach((s) => {
      s.extensionName = this.name
    })
    const old = await readSettingsFile()
    if (old.length) {
      settings.forEach((s) => {
        const prev = old.find((o) => o.key === s.key)
        if (!prev) return
        const cp = s.controllerProps as Record<string, unknown>
        const pcp = prev.controllerProps as Record<string, unknown>
        if (pcp.value !== undefined) cp.value = pcp.value
        if ('options' in cp) {
          const newOptions = (cp.options as unknown[]) ?? []
          if (newOptions.length === 0 && Array.isArray(pcp.options)) {
            cp.options = pcp.options
          }
          const opts = (cp.options as { value: unknown }[]) ?? []
          if (opts.length && !opts.some((o) => o.value === cp.value)) {
            cp.value = opts[0]?.value
          }
        }
      })
    }
    await writeSettingsFile(settings)
  }

  // The ONLY sanctioned localStorage use in this extension: a one-time read +
  // clear migrating pre-backend llamacpp settings into the file store. All
  // other persistence goes through backend-settings.ts. Guarded by
  // no-localstorage.test.ts via the `localstorage-migration-allowed` markers.
  private async migrateLocalStorageToFile(): Promise<void> {
    if (await settingsFileExists()) return
    if (!this.name) return
    let raw: string | null = null
    try {
      raw = localStorage.getItem(this.name) // localstorage-migration-allowed
    } catch {
      raw = null
    }
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        await writeSettingsFile(parsed as SettingComponentProps[])
        logger.info(
          `Migrated llamacpp settings from localStorage → file (${parsed.length} entries)`
        )
      }
    } catch (e) {
      logger.warn('Failed to migrate localStorage settings to file:', e)
      return
    }
    try {
      localStorage.removeItem(this.name) // localstorage-migration-allowed
    } catch (e) {
      logger.warn('Failed to clear migrated localStorage entry:', e)
    }
  }

  /**
   * Serialized: two concurrent calls would each run the stop-then-spawn
   * sequence, and the second would kill the worker the first had just brought
   * up. A late caller gets the in-flight start rather than a restart.
   */
  /** Live device ids, only when a saved device needs checking. */
  private async knownDeviceIds(): Promise<string[] | undefined> {
    const dev = (this.config as { device?: unknown }).device
    if (typeof dev !== 'string' || dev.trim() === '') return undefined
    try {
      return (await this.getDevices()).map((d) => d.id)
    } catch {
      return undefined
    }
  }

  /** True when models can only run on the CPU: device `none`, or no GPU. */
  private async cpuOnly(): Promise<boolean> {
    const dev = (this.config as { device?: unknown }).device
    if (typeof dev === 'string' && dev.trim() === 'none') return true
    try {
      const gpus = (await getSystemInfo())?.gpus
      return Array.isArray(gpus) && gpus.length === 0
    } catch {
      return false
    }
  }

  /** Lowest NVIDIA compute capability on this machine, if any. */
  private async gpuComputeCapability(): Promise<number | undefined> {
    try {
      return lowestComputeCapability((await getSystemInfo())?.gpus)
    } catch {
      return undefined
    }
  }

  private async startEngine(): Promise<void> {
    const inflight = this.engineStartLock
    if (inflight) {
      logger.info('startEngine already in progress; awaiting the in-flight run')
      await inflight.catch(() => undefined)
      return
    }
    this.engineStartLock = this.runStartEngine().finally(() => {
      this.engineStartLock = null
    })
    return this.engineStartLock
  }

  /** VRAM of the largest GPU in MiB, for the `auto` ubatch. */
  private async gpuMemoryMiB(): Promise<number | undefined> {
    try {
      const gpus = (await getSystemInfo())?.gpus ?? []
      const largest = Math.max(
        0,
        ...gpus.map((g) => Number(g?.total_memory) || 0)
      )
      return largest > 0 ? largest : undefined
    } catch {
      return undefined
    }
  }

  /** Total and free system RAM in MiB, for the `auto` prompt cache size. */
  private async systemMemoryMiB(): Promise<{ total?: number; free?: number }> {
    try {
      const u = await getSystemUsage()
      const total = Number(u?.total_memory) || undefined
      const used = Number(u?.used_memory)
      return {
        total,
        free: total && Number.isFinite(used) ? Math.max(0, total - used) : undefined,
      }
    } catch {
      return {}
    }
  }

  private async runStartEngine(): Promise<void> {
    const providerPath = await this.getProviderPath()
    const janDataFolderPath = await getJanDataFolderPath()
    const { path: presetPath, embeddingCount } = await generatePreset(
      providerPath,
      janDataFolderPath,
      this.config,
      {
        kvFallbackModels: this.kvFallbackModels,
        cpuFallbackModels: this.cpuFallbackModels,
        knownDeviceIds: await this.knownDeviceIds(),
        gpuComputeCapability: await this.gpuComputeCapability(),
        gpuMemoryMiB: await this.gpuMemoryMiB(),
        systemMemoryMiB: await this.systemMemoryMiB(),
        cpuOnly: await this.cpuOnly(),
      }
    )

    const modelsMax = this.resolveModelsMax(embeddingCount)

    // Idempotent in the plugin: a second start returns the running worker
    // rather than orphaning it, so a redundant call is a no-op instead of a
    // cold restart. That is also why there is no adoption dance here: the
    // worker exits on stdin EOF, which the OS delivers when this process dies
    // by any means -- including SIGKILL, where kill_on_drop never runs -- so
    // there is nothing to adopt or reap. Not because a child dies with its
    // parent; it does not, it gets reparented.
    const envs: Record<string, string> = {}
    envs['LLAMA_ARG_TIMEOUT'] = String(this.timeout)
    envs['LLAMA_FLINT_IDLE_UNLOAD_MINUTES'] = String(
      this.resolveIdleUnloadMinutes()
    )
    if (this.llamacpp_env) this.parseEnvFromString(envs, this.llamacpp_env)

    const info = await startEngine(
      presetPath,
      modelsMax,
      this.resolveThreadCacheBudget(),
      envs,
      this.customServerPath()
    )
    this.enginePort = info.port
    this.engineApiKey = info.api_key
    this.presetPath = presetPath
    logger.info(
      `Engine worker started on port ${info.port} (pid ${info.pid}, models_max=${modelsMax}, ${info.models.length} models registered, preset=${presetPath})`
    )
  }

  /**
   * Drops a thread's saved prompt cache, for a thread the user deleted.
   *
   * Best-effort by design: the cache is invisible to the user and the store
   * prunes by size anyway, so failing here must not make deleting a thread
   * fail. Returns how many states were dropped.
   */
  async forgetThreadCache(threadId: string): Promise<number> {
    try {
      return await eraseThreadSlotState({
        threadId,
        cacheDir: threadCacheDir(await this.getProviderPath()),
      })
    } catch (e) {
      logger.warn(`could not drop the saved cache for thread ${threadId}: ${e}`)
      return 0
    }
  }

  /**
   * The disk budget for saved thread caches, in MiB.
   *
   * 0 is the off switch on the worker side, so the toggle and the size collapse
   * into one number: a disabled feature and a zero budget are the same thing,
   * and keeping them separate would let the worker create a directory it would
   * never write to.
   */
  private resolveThreadCacheBudget(): number {
    if (this.config.persist_thread_cache === false) return 0
    const raw = Number(this.config.thread_cache_size)
    if (!Number.isFinite(raw) || raw <= 0) return 0
    return Math.floor(raw)
  }

  /**
   * Minutes a model may sit unused before the worker unloads it. The setting
   * defaults to 30 (settings.json); 0 is off, and a missing, blank or invalid
   * value is treated as 0 so it changes nothing.
   */
  private resolveIdleUnloadMinutes(): number {
    const raw = Number((this.config as { idle_unload_minutes?: unknown }).idle_unload_minutes)
    if (!Number.isFinite(raw) || raw <= 0) return 0
    return Math.floor(raw)
  }

  /** The user's own llama-server, or undefined for the bundled engine. */
  private customServerPath(): string | undefined {
    const raw = (this.config as { custom_server_path?: unknown }).custom_server_path
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
  }

  /**
   * `models_max` including the embedding slot bonus.
   *
   * Reserves one extra slot when any embedder is installed so loading it does
   * not evict the user's chat model. Only one embedding model is ever resident
   * (RAG calls load() once per request), so the bonus is +1 regardless of how
   * many are installed. 0 (unlimited) stays unlimited.
   */
  private resolveModelsMax(embeddingCount: number): number {
    const raw = (this.config as { models_max?: unknown }).models_max
    let modelsMax = 1
    if (typeof raw === 'number') modelsMax = raw
    else if (typeof raw === 'string' && raw.trim().length > 0) {
      const n = parseInt(raw, 10)
      if (!Number.isNaN(n) && n >= 0) modelsMax = n
    }
    this.userModelsMax = modelsMax
    const bonus = modelsMax > 0 && embeddingCount > 0 ? 1 : 0
    this.engineEmbeddingBonus = bonus
    return modelsMax + bonus
  }

  /**
   * Apply a preset change (model added/removed/renamed or a per-model setting)
   * to the running worker. Models whose preset section is unchanged stay
   * loaded, so an embedder import or a settings write no longer cold-reloads
   * the model the user is talking to.
   *
   * Unlike the router this also resizes `models_max`, so a change in the
   * embedding slot bonus no longer needs a restart either -- which was the one
   * remaining case that evicted a live chat model.
   */
  private async refreshEnginePreset(): Promise<void> {
    if (!(await this.getEngineInfo())) {
      await this.startEngine() // cold start
      return
    }
    // A custom llama-server has no live reload: it reads the preset at start.
    if (this.customServerPath()) {
      await this.restartEngineForEnv()
      return
    }

    const providerPath = await this.getProviderPath()
    const janDataFolderPath = await getJanDataFolderPath()
    const { path: presetPath, embeddingCount } = await generatePreset(
      providerPath,
      janDataFolderPath,
      this.config,
      {
        kvFallbackModels: this.kvFallbackModels,
        cpuFallbackModels: this.cpuFallbackModels,
        knownDeviceIds: await this.knownDeviceIds(),
        gpuComputeCapability: await this.gpuComputeCapability(),
        gpuMemoryMiB: await this.gpuMemoryMiB(),
        systemMemoryMiB: await this.systemMemoryMiB(),
        cpuOnly: await this.cpuOnly(),
      }
    )
    this.presetPath = presetPath

    try {
      const report = await reloadEngineModels(
        presetPath,
        this.resolveModelsMax(embeddingCount),
        this.resolveThreadCacheBudget(),
        this.resolveIdleUnloadMinutes()
      )
      logger.info(
        `Engine preset reloaded: +${report.added.length} ~${report.changed.length} -${report.removed.length}, ${report.kept.length} kept loaded`
      )
    } catch (e) {
      logger.warn('Live engine reload failed; stopping and restarting the engine:', e)
      // start_engine is idempotent while a worker is up, so without a stop the
      // "restart" returned the same worker holding the old preset.
      await pluginStopEngine()
      this.enginePort = undefined
      this.engineApiKey = undefined
      await this.startEngine()
    }
  }

  /**
   * Public accessor for downstream consumers. Returns `null` if the engine
   * worker hasn't started successfully yet.
   */
  async getEngineInfo(): Promise<{ port: number; apiKey: string } | null> {
    // Deliberately not answered from the cached port: get_engine_info is the
    // one place a worker that died is noticed -- it reaps the handle and
    // reports nothing running -- and every caller here uses this as the
    // liveness probe before deciding whether to respawn. Answering from
    // enginePort would keep handing out a closed port for the rest of the
    // session, which is exactly the crash the worker process exists to survive.
    try {
      const info = await pluginGetEngineInfo()
      if (info) {
        this.enginePort = info.port
        this.engineApiKey = info.api_key
        return { port: info.port, apiKey: info.api_key }
      }
      this.enginePort = undefined
      this.engineApiKey = undefined
    } catch (e) {
      logger.warn('get_engine_info failed:', e)
    }
    return null
  }

  /**
   * The bundled engine's identity. Cached after the first call: these are
   * compile-time constants of the plugin, so they cannot change while the app
   * is running, and the settings screen asks on every mount.
   */
  async getEngineVersion(): Promise<EngineVersion> {
    if (!this.engineVersion) {
      this.engineVersion = await pluginGetEngineVersion()
    }
    return this.engineVersion
  }

  /**
   * Fetch runtime properties for a loaded model from the router's
   * `/props?model=<id>` endpoint. Returns `undefined` if the router isn't
   * running, the model isn't loaded, or the response is unusable. `nCtx` is
   * the post-fit value — what `fit_ctx` settled on — so it's the right
   * denominator for the token-usage popup.
   */
  async getModelProps(
    modelId: string
  ): Promise<
    | (ModelProps & {
        modalities?: { vision: boolean; video: boolean; audio: boolean }
        /** The sampling settings the server reports as its own defaults. */
        generationDefaults?: Record<string, unknown>
      })
    | undefined
  > {
    const engine = await this.getEngineInfo()
    if (!engine || !modelId) return undefined
    // A request naming an unloaded model loads it on demand, so `/props` alone
    // would trigger a load. Gate on the loaded-set first.
    try {
      const loaded = await this.getLoadedModels()
      if (!loaded.includes(modelId)) return undefined
    } catch {
      return undefined
    }
    try {
      const url = `http://127.0.0.1:${engine.port}/props?model=${encodeURIComponent(modelId)}`
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${engine.apiKey}` },
      })
      if (!res.ok) return undefined
      const json = (await res.json()) as {
        default_generation_settings?: {
          n_ctx?: number
          params?: Record<string, unknown>
        }
        total_slots?: number
        n_ctx?: number
        model_alias?: string
        is_sleeping?: boolean
        modalities?: { vision?: boolean; video?: boolean; audio?: boolean }
      }
      // Per-slot window first; a build that reports it only at the top
      // level (as an auto-fit load can) still has a real answer.
      const perSlot = json?.default_generation_settings?.n_ctx
      const n =
        typeof perSlot === 'number' && perSlot > 0 ? perSlot : json?.n_ctx
      if (typeof n !== 'number' || n <= 0) return undefined
      const m = json.modalities
      return {
        nCtx: n,
        totalSlots:
          typeof json.total_slots === 'number' ? json.total_slots : undefined,
        modelAlias: json.model_alias,
        isSleeping: !!json.is_sleeping,
        generationDefaults: json.default_generation_settings?.params,
        modalities: m
          ? { vision: !!m.vision, video: !!m.video, audio: !!m.audio }
          : undefined,
      }
    } catch {
      return undefined
    }
  }

  private async readMmprojCapabilities(
    mmprojPath: string
  ): Promise<{ vision: boolean; audio: boolean }> {
    try {
      const janDataFolderPath = await getJanDataFolderPath()
      const fullPath = await joinPath([janDataFolderPath, mmprojPath])
      const meta = (await readGgufMetadata(fullPath)).metadata ?? {}
      const truthy = (v: string | undefined) =>
        typeof v === 'string' && v.toLowerCase() === 'true'
      const vision = truthy(meta['clip.has_vision_encoder'])
      const audio = truthy(meta['clip.has_audio_encoder'])
      if (!vision && !audio) return { vision: true, audio: false }
      return { vision, audio }
    } catch (error) {
      logger.warn('Failed to read mmproj capabilities:', error)
      return { vision: true, audio: false }
    }
  }

  private async migrateAutoUnloadToModelsMax(
    old: boolean | undefined
  ): Promise<void> {
    const MIGRATION_KEY = 'llamacpp_models_max_migrated_v1'
    if (await getBackendSetting(MIGRATION_KEY)) return

    try {
      if (old !== undefined) {
        const targetValue = modelsMaxFromAutoUnload(old)
        const settings = await this.getSettings()
        await this.updateSettings(
          settings.map((item) => {
            if (item.key === 'models_max') {
              item.controllerProps.value = targetValue
            }
            return item
          })
        )
        ;(this.config as any).models_max = targetValue
        logger.info(
          `Migrated auto_unload=${old} -> models_max=${targetValue}`
        )
      }
    } catch (e) {
      logger.warn('migrateAutoUnloadToModelsMax failed:', e)
      return
    }

    await setBackendSetting(MIGRATION_KEY, '1')
  }

  private async migrateFitOn(): Promise<void> {
    const MIGRATION_KEY = 'llamacpp_fit_on_v1'
    if (await getBackendSetting(MIGRATION_KEY)) return

    if (this.config.fit === false) {
      const settings = await this.getSettings()
      await this.updateSettings(
        settings.map((item) => {
          if (item.key === 'fit') {
            item.controllerProps.value = true
          }
          return item
        })
      )
      this.config.fit = true
      logger.info('Migrated fit setting: enabled')
    }

    await setBackendSetting(MIGRATION_KEY, '1')
  }

  /**
   * uBatch Size became `0 = auto`. Every install saved the old default (512,
   * or 1024 briefly) as a value, so those two move to auto once; anything
   * else was typed by the user and stays.
   */
  private async migrateUbatchAuto(): Promise<void> {
    const MIGRATION_KEY = 'llamacpp_ubatch_auto_v1'
    if (await getBackendSetting(MIGRATION_KEY)) return

    const v = Number(this.config.ubatch_size)
    if (v === 512 || v === 1024) {
      const settings = await this.getSettings()
      await this.updateSettings(
        settings.map((item) => {
          if (item.key === 'ubatch_size') {
            item.controllerProps.value = 0
          }
          return item
        })
      )
      this.config.ubatch_size = 0
      logger.info(`Migrated ubatch_size=${v} -> 0 (auto)`)
    }

    await setBackendSetting(MIGRATION_KEY, '1')
  }

  /**
   * Prompt Cache RAM gained `-2 = auto` (sized from system RAM). Installs saved
   * the old default 4096 as a value, so that moves to auto once; anything else
   * was typed by the user and stays.
   */
  private async migrateCacheRamAuto(): Promise<void> {
    const MIGRATION_KEY = 'llamacpp_cache_ram_auto_v1'
    if (await getBackendSetting(MIGRATION_KEY)) return

    if (Number(this.config.cache_ram) === 4096) {
      const settings = await this.getSettings()
      await this.updateSettings(
        settings.map((item) => {
          if (item.key === 'cache_ram') {
            item.controllerProps.value = CACHE_RAM_AUTO
          }
          return item
        })
      )
      this.config.cache_ram = CACHE_RAM_AUTO
      logger.info(`Migrated cache_ram=4096 -> ${CACHE_RAM_AUTO} (auto)`)
    }

    await setBackendSetting(MIGRATION_KEY, '1')
  }

  private async migratePersistedModelSettingsToYaml(): Promise<void> {
    if (await getBackendSetting(LLAMACPP_MODEL_SETTINGS_BACKFILL_KEY)) return

    const persistedModels = await readPersistedLlamacppModels()
    const providerPath = await this.getProviderPath()

    // v1's n_gpu_layers stamp lives in model.yml, not in the persisted
    // settings, so it has to be swept even when nothing is persisted.
    await this.stripLegacyNglFromModelYaml(providerPath)

    if (persistedModels.length === 0) {
      await setBackendSetting(LLAMACPP_MODEL_SETTINGS_BACKFILL_KEY, '1')
      return
    }

    for (const persistedModel of persistedModels) {
      const modelId =
        typeof persistedModel.id === 'string' ? persistedModel.id : undefined
      if (!modelId || !persistedModel.settings) continue

      const configPath = await joinPath([
        providerPath,
        'models',
        modelId,
        'model.yml',
      ])
      if (!(await fs.existsSync(configPath))) continue

      const cfg = (await invoke<ModelConfig>('read_yaml', {
        path: configPath,
      })) as ModelConfig & Record<string, unknown>

      let touched = false

      // Undo v1's n_gpu_layers stamp so upstream's auto offload applies again.
      if (cfg.n_gpu_layers === LEGACY_NGL_DEFAULT) {
        delete (cfg as Record<string, unknown>).n_gpu_layers
        touched = true
        logger.info(
          `Removed legacy n_gpu_layers=${LEGACY_NGL_DEFAULT} from ${modelId}; GPU offload is auto again`
        )
      }

      for (const [sidebarKey, persistedSetting] of Object.entries(
        persistedModel.settings
      )) {
        const mapping = MODEL_SETTINGS_YAML_MAPPING[sidebarKey]
        if (!mapping) continue

        if (mapping.yamlKey in cfg) continue

        const value = persistedSetting?.controller_props?.value
        // Never re-copy the legacy default; that is what v1 did.
        if (sidebarKey === 'ngl' && Number(value) === LEGACY_NGL_DEFAULT) {
          continue
        }

        const next = mapping.coerce(value)
        if (next === null) continue

        ;(cfg as Record<string, unknown>)[mapping.yamlKey] = next
        touched = true
      }

      if (touched) {
        await invoke<void>('write_yaml', { data: cfg, savePath: configPath })
      }
    }

    await setBackendSetting(LLAMACPP_MODEL_SETTINGS_BACKFILL_KEY, '1')
  }

  /**
   * Removes v1's `n_gpu_layers: 100` stamp from every model.yml.
   *
   * Separate from the settings backfill because the stamp is in the yaml even
   * for models that no longer appear in the persisted provider settings, so
   * iterating the persisted list would miss them.
   */
  private async stripLegacyNglFromModelYaml(providerPath: string): Promise<void> {
    const modelsDir = await joinPath([providerPath, 'models'])
    if (!(await fs.existsSync(modelsDir))) return

    let entries: string[] = []
    try {
      entries = await fs.readdirSync(modelsDir)
    } catch (e) {
      logger.warn('Could not list models while sweeping legacy ngl:', e)
      return
    }

    for (const entry of entries) {
      const configPath = await joinPath([entry, 'model.yml'])
      try {
        if (!(await fs.existsSync(configPath))) continue
        // Read as a bag rather than ModelConfig: that type covers the
        // plugin's own fields, not every per-model key the sidebar writes.
        const cfg = await fs.readYaml<Record<string, unknown>>(configPath)
        if (cfg?.n_gpu_layers !== LEGACY_NGL_DEFAULT) continue
        delete cfg.n_gpu_layers
        await fs.writeYaml(configPath, cfg)
        logger.info(
          `Removed legacy n_gpu_layers=${LEGACY_NGL_DEFAULT} from ${configPath}`
        )
      } catch (e) {
        // Per-model isolation: one unreadable yaml must not block the sweep.
        logger.warn(`Legacy ngl sweep skipped ${configPath}:`, e)
      }
    }
  }

  async getProviderPath(): Promise<string> {
    if (!this.providerPath) {
      this.providerPath = await joinPath([
        await getJanDataFolderPath(),
        this.providerId,
      ])
    }
    return this.providerPath
  }

  override async onUnload(): Promise<void> {
    // Terminate all active sessions

    // Clean up validation event listeners
    if (this.unlistenValidationStarted) {
      this.unlistenValidationStarted()
    }

    // Deliberately does NOT stop the engine worker. It outlives any single
    // extension instance: the app owns its lifetime and stops it on
    // ExitRequested/Exit. An extension teardown is not an app exit -- React
    // StrictMode and HMR both unload and immediately reload us, and awaiting
    // backgroundInit here (as this used to) meant blocking until the worker was
    // up, then killing exactly the process it had just started.
    this.enginePort = undefined
    this.engineApiKey = undefined
  }

  onSettingUpdate<T>(key: string, value: T): void {
    this.config[key] = value
    if (key === 'cache_type_k' || key === 'cache_type_v' || key === 'flash_attn') {
      this.kvFallbackModels.clear()
    }

    if (key === 'custom_server_path') {
      // Swapping engines means a new process; same path as an env change.
      if (this.backgroundInit) this.scheduleEnvRestart()
    } else if (key === 'llamacpp_env') {
      const next = String(value ?? '')
      const changed = next !== this.llamacpp_env
      this.llamacpp_env = next
      // The env is only read when the worker is spawned, so a running worker
      // keeps the old one until it is restarted.
      if (changed && this.backgroundInit) this.scheduleEnvRestart()
    } else if (key === 'timeout') {
      // Clamped through the plugin's own coercion: the field is a text input, so
      // clearing it yields '' and a bare cast produced NaN. 0 or negative would
      // make the request timeout fire immediately and abort every stream.
      this.timeout = asI32(value, DEFAULT_TIMEOUT) || DEFAULT_TIMEOUT
    } else if (key === 'models_max' || key === 'idle_unload_minutes') {
      // Not a `[*]` preset key, so it is deliberately absent from
      // PRESET_AFFECTING_KEYS -- but the worker still has to be told, or
      // "Max Concurrently Loaded Models" (and the idle-unload timeout) only
      // ever updated this.config.
      this.schedulePresetRefresh()
    } else if (PRESET_AFFECTING_KEYS.has(key)) {
      // The running worker was started with the previous preset; without a
      // reload the new value is invisible to inference. Debounced so a flurry
      // of slider/dropdown updates collapses into one bounce.
      this.schedulePresetRefresh()
    }
  }

  private envRestartTimer: ReturnType<typeof setTimeout> | null = null
  private scheduleEnvRestart(): void {
    if (this.envRestartTimer) clearTimeout(this.envRestartTimer)
    this.envRestartTimer = setTimeout(() => {
      this.envRestartTimer = null
      this.restartEngineForEnv().catch((e) =>
        logger.warn('Engine restart after environment change failed:', e)
      )
    }, 800)
  }

  /**
   * Restart the worker so a changed `llamacpp_env` takes effect. Skipped while
   * a generation is running (the restart would kill it); in that case the new
   * value is picked up at the next start and a warning says so.
   */
  private async restartEngineForEnv(): Promise<void> {
    if (!(await this.getEngineInfo())) return // next start reads the new env
    if (!(await engineSlotsIdle())) {
      logger.warn(
        'Environment variables changed while a model is generating; the engine will use them after its next restart.'
      )
      return
    }
    await pluginStopEngine()
    this.enginePort = undefined
    this.engineApiKey = undefined
    await this.startEngine()
  }

  /**
   * An engine add-on (the CUDA pack) installed or removed since the worker
   * started only loads when the worker restarts: do that before this load,
   * while nothing is generating. Best-effort; on any doubt the load goes on
   * with the running engine.
   */
  private async applyEngineAddonChange(): Promise<void> {
    try {
      const pending = await engineAddonRestartPending()
      if (!pending) return
      logger.info('Engine add-on changed since the engine started; restarting it before this load')
      await this.restartEngineForEnv()
    } catch (e) {
      logger.debug('engine add-on check skipped:', e)
    }
  }

  private presetRefreshTimer: ReturnType<typeof setTimeout> | null = null
  private schedulePresetRefresh(): void {
    if (this.presetRefreshTimer) clearTimeout(this.presetRefreshTimer)
    this.presetRefreshTimer = setTimeout(() => {
      this.presetRefreshTimer = null
      this.refreshEnginePreset().catch((e) =>
        logger.warn('Preset refresh after settings update failed:', e)
      )
    }, 600)
  }

  private async generateApiKey(modelId: string, port: string): Promise<string> {
    const hash = await pluginGenerateApiKey(modelId + port, this.apiSecret)
    return hash
  }

  override async get(modelId: string): Promise<modelInfo | undefined> {
    const modelPath = await joinPath([
      await this.getProviderPath(),
      'models',
      modelId,
    ])
    const path = await joinPath([modelPath, 'model.yml'])

    if (!(await fs.existsSync(path))) return undefined

    const modelConfig = await invoke<ModelConfig>('read_yaml', {
      path,
    })

    const isEmbedding = await this.resolveEmbeddingConfig(modelId, modelConfig)
    await this.resolveMtpLayersConfig(modelId, modelConfig)
    const templateKwargs = await this.resolveTemplateKwargsConfig(
      modelId,
      modelConfig
    )

    return {
      id: modelId,
      name: modelConfig.name ?? modelId,
      quant_type: undefined, // TODO: parse quantization type from model.yml or model.gguf
      providerId: this.provider,
      port: 0, // port is not known until the model is loaded
      sizeBytes: modelConfig.size_bytes ?? 0,
      embedding: isEmbedding,
      template_kwargs: templateKwargs,
    } as modelInfo
  }

  async getModelContextLimit(modelId: string): Promise<number | undefined> {
    const config = await invoke<ModelConfig>('read_yaml', {
      path: await joinPath([await this.getProviderPath(), 'models', modelId, 'model.yml']),
    })
    const path = await joinPath([await getJanDataFolderPath(), config.model_path])
    const { metadata } = await readGgufMetadata(path)
    const limit = Number(metadata?.[`${metadata?.['general.architecture']}.context_length`])
    return Number.isInteger(limit) && limit > 0 ? limit : undefined
  }

  /**
   * Checks if embedding status is known. If not, reads GGUF, detects it,
   * and updates the model.yml for future performance.
   */
  private async resolveEmbeddingConfig(
    modelId: string,
    modelConfig: ModelConfig
  ): Promise<boolean> {
    const cfg = modelConfig as ModelConfig & { embedding_check_v?: number }
    const hasFlag = typeof cfg.embedding === 'boolean'
    const upToDate = cfg.embedding_check_v === EMBEDDING_CHECK_VERSION
    if (hasFlag && upToDate) {
      return cfg.embedding as boolean
    }
    if (hasFlag && cfg.embedding === true) {
      return true
    }

    let isEmbedding = false
    try {
      const janDataFolderPath = await getJanDataFolderPath()
      const fullModelPath = await joinPath([
        janDataFolderPath,
        modelConfig.model_path,
      ])

      if (await fs.existsSync(fullModelPath)) {
        const metadata = await readGgufMetadata(fullModelPath)
        if (detectEmbeddingFromGgufMeta(metadata.metadata)) {
          isEmbedding = true
        }
      }
    } catch (e) {
      logger.warn(`Failed to check metadata for ${modelId}`, e)
      return cfg.embedding === true
    }

    try {
      const configPath = await joinPath([
        await this.getProviderPath(),
        'models',
        modelId,
        'model.yml',
      ])

      cfg.embedding = isEmbedding
      cfg.embedding_check_v = EMBEDDING_CHECK_VERSION
      if (isEmbedding) {
        const c = cfg as ModelConfig & {
          pooling?: string
          ubatch_size?: number
          batch_size?: number
        }
        if (!c.pooling) c.pooling = 'mean'
        if (!c.ubatch_size) c.ubatch_size = 2048
        if (!c.batch_size) c.batch_size = 2048
      }

      await invoke<void>('write_yaml', {
        data: cfg,
        savePath: configPath,
      })
    } catch (e) {
      logger.warn(`Failed to update config for ${modelId}`, e)
    }

    return isEmbedding
  }

  /**
   * A GGUF with no embedded chat template (GPT-2 style base models) cannot
   * serve /chat/completions: llama.cpp falls back to chatml and the model
   * emits template garbage. Such models are flagged `completion_only` so chat
   * goes to /v1/completions instead. A user-set `chat_template` in model.yml
   * wins, and the result is cached in model.yml.
   */
  private async resolveCompletionOnlyConfig(
    modelId: string,
    modelConfig: ModelConfig,
    isEmbedding: boolean
  ): Promise<boolean> {
    if (isEmbedding) return false
    const cfg = modelConfig as ModelConfig & { chat_template?: string }
    if (typeof cfg.chat_template === 'string' && cfg.chat_template.trim()) {
      return false
    }
    if (typeof cfg.completion_only === 'boolean') return cfg.completion_only

    let completionOnly = false
    try {
      const fullModelPath = await joinPath([
        await getJanDataFolderPath(),
        modelConfig.model_path,
      ])
      if (!(await fs.existsSync(fullModelPath))) return false
      const { metadata } = await readGgufMetadata(fullModelPath)
      const template = metadata?.['tokenizer.chat_template']
      completionOnly = !(typeof template === 'string' && template.trim())
    } catch (e) {
      logger.warn(`Failed to check chat template for ${modelId}`, e)
      return false
    }

    try {
      cfg.completion_only = completionOnly
      await invoke<void>('write_yaml', {
        data: cfg,
        savePath: await joinPath([
          await this.getProviderPath(),
          'models',
          modelId,
          'model.yml',
        ]),
      })
    } catch (e) {
      logger.warn(`Failed to persist completion_only for ${modelId}`, e)
    }
    return completionOnly
  }

  private async resolveMtpLayersConfig(
    modelId: string,
    modelConfig: ModelConfig
  ): Promise<number> {
    const cfg = modelConfig as ModelConfig & {
      mtp_layers?: number
      mtp_check_v?: number
    }
    if (
      typeof cfg.mtp_layers === 'number' &&
      cfg.mtp_check_v === MTP_CHECK_VERSION
    ) {
      return cfg.mtp_layers
    }

    let mtpLayers = 0
    try {
      const janDataFolderPath = await getJanDataFolderPath()
      const fullModelPath = await joinPath([
        janDataFolderPath,
        modelConfig.model_path,
      ])
      if (await fs.existsSync(fullModelPath)) {
        const metadata = await readGgufMetadata(fullModelPath)
        mtpLayers = detectMtpLayersFromGgufMeta(metadata.metadata)
      }
    } catch (e) {
      logger.warn(`Failed to check MTP metadata for ${modelId}`, e)
      return cfg.mtp_layers ?? 0
    }

    try {
      const configPath = await joinPath([
        await this.getProviderPath(),
        'models',
        modelId,
        'model.yml',
      ])
      cfg.mtp_layers = mtpLayers
      cfg.mtp_check_v = MTP_CHECK_VERSION
      await invoke<void>('write_yaml', {
        data: cfg,
        savePath: configPath,
      })
    } catch (e) {
      logger.warn(`Failed to persist MTP layers for ${modelId}`, e)
    }

    return mtpLayers
  }

  /**
   * Detect which chat-template kwargs (e.g. `preserve_thinking`) a model's
   * embedded jinja template accepts, caching the result in model.yml. Migrates
   * pre-existing models lazily the first time list() sees a stale check version.
   */
  private async resolveTemplateKwargsConfig(
    modelId: string,
    modelConfig: ModelConfig
  ): Promise<TemplateKwarg[]> {
    const cfg = modelConfig as ModelConfig & {
      template_kwargs?: TemplateKwarg[]
      template_kwargs_check_v?: number
    }
    if (
      Array.isArray(cfg.template_kwargs) &&
      cfg.template_kwargs_check_v === TEMPLATE_KWARGS_CHECK_VERSION
    ) {
      return cfg.template_kwargs
    }

    let kwargs: TemplateKwarg[] = []
    try {
      const janDataFolderPath = await getJanDataFolderPath()
      const fullModelPath = await joinPath([
        janDataFolderPath,
        modelConfig.model_path,
      ])
      if (await fs.existsSync(fullModelPath)) {
        const metadata = await readGgufMetadata(fullModelPath)
        kwargs = detectTemplateKwargsFromChatTemplate(
          metadata.metadata?.['tokenizer.chat_template']
        )
      }
    } catch (e) {
      logger.warn(`Failed to check template kwargs for ${modelId}`, e)
      return cfg.template_kwargs ?? []
    }

    try {
      const configPath = await joinPath([
        await this.getProviderPath(),
        'models',
        modelId,
        'model.yml',
      ])
      cfg.template_kwargs = kwargs
      cfg.template_kwargs_check_v = TEMPLATE_KWARGS_CHECK_VERSION
      await invoke<void>('write_yaml', {
        data: cfg,
        savePath: configPath,
      })
    } catch (e) {
      logger.warn(`Failed to persist template kwargs for ${modelId}`, e)
    }

    return kwargs
  }

  /**
   * Models the last `list()` left out because their model.yml resolves outside
   * the data folder (janhq/jan#8374: a junction or symlink under
   * `llamacpp/models` pointing at another drive). `read_yaml` refuses those on
   * purpose; this only records them so the UI can say why they are missing.
   */
  private skippedLinkedModels: { id: string; path: string; reason: 'outside_data_folder' }[] = []

  getSkippedModels(): { id: string; path: string; reason: 'outside_data_folder' }[] {
    return [...this.skippedLinkedModels]
  }

  // Implement the required LocalProvider interface methods
  override async list(): Promise<modelInfo[]> {
    const skipped: { id: string; path: string; reason: 'outside_data_folder' }[] = []
    this.skippedLinkedModels = skipped
    const modelsDir = await joinPath([await this.getProviderPath(), 'models'])
    if (!(await fs.existsSync(modelsDir))) {
      await fs.mkdir(modelsDir)
    }

    // Legacy migration is best-effort: a failure here must never blank the
    // model list. Pre-router users without anything to migrate would never
    // notice, but a single throw used to bubble out of list() and return [].
    try {
      await this.migrateLegacyModels()
    } catch (err) {
      logger.warn(`list: migrateLegacyModels failed, continuing: ${String(err)}`)
    }

    let modelIds: string[] = []

    // DFS. Mirror the defensive pattern in preset.ts: an unreadable entry
    // (Windows AV quarantine, junction, locked file) must not kill the whole
    // scan — log and continue past it.
    let stack = [modelsDir]
    while (stack.length > 0) {
      const currentDir = stack.pop()

      // check if model.yml exists
      const modelConfigPath = await joinPath([currentDir, 'model.yml'])
      if (await fs.existsSync(modelConfigPath)) {
        modelIds.push(toModelId(modelsDir, currentDir))
        continue
      }

      let children: string[] = []
      try {
        children = await fs.readdirSync(currentDir)
      } catch (err) {
        logger.warn(`list: readdir failed for ${currentDir}: ${String(err)}`)
        continue
      }
      for (const child of children) {
        try {
          const dirInfo = await fs.fileStat(child)
          if (!dirInfo?.isDirectory) continue
          stack.push(child)
        } catch (err) {
          logger.warn(`list: stat failed for ${child}: ${String(err)}`)
        }
      }
    }

    // Per-model isolation: one malformed model.yml (or a write_yaml failure
    // inside resolveEmbeddingConfig) must not discard the other entries.
    let modelInfos: modelInfo[] = []
    for (const modelId of modelIds) {
      try {
        const path = await joinPath([modelsDir, modelId, 'model.yml'])
        const modelConfig = await invoke<ModelConfig>('read_yaml', { path })
        const isEmbedding = await this.resolveEmbeddingConfig(
          modelId,
          modelConfig
        )
        const templateKwargs = await this.resolveTemplateKwargsConfig(
          modelId,
          modelConfig
        )

        const capabilities: string[] = []
        if (
          await this.resolveCompletionOnlyConfig(
            modelId,
            modelConfig,
            isEmbedding
          )
        ) {
          capabilities.push('raw_completion')
        }
        if (modelConfig.mmproj_path) {
          const caps = await this.readMmprojCapabilities(
            modelConfig.mmproj_path
          )
          if (caps.vision) capabilities.push('vision')
          if (caps.audio) capabilities.push('audio')
          // 'video' is intentionally NOT derived from the mmproj here — video
          // support also depends on the backend being built with MTMD_VIDEO,
          // which the GGUF can't reveal. It's reconciled from /props after the
          // model loads (see useReconcileVideoCapability).
        }

        const mp = modelConfig.model_path ?? ''
        const isAbsolute = mp.startsWith('/') || /^[A-Za-z]:[\\/]/.test(mp)

        const modelInfo = {
          id: modelId,
          name: modelConfig.name ?? modelId,
          quant_type: undefined, // TODO: parse quantization type from model.yml or model.gguf
          providerId: this.provider,
          port: 0, // port is not known until the model is loaded
          sizeBytes: modelConfig.size_bytes ?? 0,
          embedding: isEmbedding,
          imported: isAbsolute,
          capabilities: capabilities.length > 0 ? capabilities : undefined,
          template_kwargs: templateKwargs,
        } as modelInfo
        modelInfos.push(modelInfo)
      } catch (err) {
        logger.warn(`list: skipping model ${modelId}: ${String(err)}`)
        if (String(err).includes('outside of Jan data folder')) {
          skipped.push({
            id: modelId,
            path: await joinPath([modelsDir, modelId]),
            reason: 'outside_data_folder',
          })
        }
      }
    }

    return modelInfos
  }

  private async migrateLegacyModels() {
    // Attempt to migrate only once
    if ((await getBackendSetting('cortex_models_migrated')) === 'true') return

    const janDataFolderPath = await getJanDataFolderPath()
    const modelsDir = await joinPath([janDataFolderPath, 'models'])
    if (!(await fs.existsSync(modelsDir))) return

    // DFS
    let stack = [modelsDir]
    while (stack.length > 0) {
      const currentDir = stack.pop()

      const files = await fs.readdirSync(currentDir)
      for (const child of files) {
        try {
          const childPath = await joinPath([currentDir, child])
          const stat = await fs.fileStat(childPath)
          if (
            files.some((e) => e.endsWith('model.yml')) &&
            !child.endsWith('model.yml')
          )
            continue
          if (!stat.isDirectory && child.endsWith('.yml')) {
            // check if model.yml exists
            const modelConfigPath = child
            if (await fs.existsSync(modelConfigPath)) {
              const legacyModelConfig = await invoke<{
                files: string[]
                model: string
              }>('read_yaml', {
                path: modelConfigPath,
              })
              const legacyModelPath = legacyModelConfig.files?.[0]
              if (!legacyModelPath) continue
              let modelId = toModelId(modelsDir, currentDir)

              modelId =
                modelId !== 'imported'
                  ? modelId.replace(/^(cortex\.so|huggingface\.co)[\/\\]/, '')
                  : (await basename(child)).replace('.yml', '')

              const modelName = legacyModelConfig.model ?? modelId
              const configPath = await joinPath([
                await this.getProviderPath(),
                'models',
                modelId,
                'model.yml',
              ])
              if (await fs.existsSync(configPath)) continue // Don't reimport

              // this is relative to Flint's data folder
              const modelDir = `${this.providerId}/models/${modelId}`

              let size_bytes = (
                await fs.fileStat(
                  await joinPath([janDataFolderPath, legacyModelPath])
                )
              ).size

              const modelConfig = {
                model_path: legacyModelPath,
                mmproj_path: undefined, // legacy models do not have mmproj
                name: modelName,
                size_bytes,
              } as ModelConfig
              await fs.mkdir(await joinPath([janDataFolderPath, modelDir]))
              await invoke<void>('write_yaml', {
                data: modelConfig,
                savePath: configPath,
              })
              continue
            }
          }
        } catch (error) {
          logger.error(`Error migrating model ${child}:`, error)
        }
      }

      let subdirs: string[] = []
      try {
        subdirs = await fs.readdirSync(currentDir)
      } catch (err) {
        logger.warn(
          `migrateLegacyModels: readdir failed for ${currentDir}: ${String(err)}`
        )
        continue
      }
      for (const child of subdirs) {
        try {
          const dirInfo = await fs.fileStat(child)
          if (!dirInfo?.isDirectory) continue
          stack.push(child)
        } catch (err) {
          logger.warn(
            `migrateLegacyModels: stat failed for ${child}: ${String(err)}`
          )
        }
      }
    }
    await setBackendSetting('cortex_models_migrated', 'true')
  }

  /**
   * Unload a model if it is running so its files are not held open by the
   * worker while we rename or delete them. Worker-down errors are ignored.
   */
  private async unloadIfLoaded(modelId: string): Promise<void> {
    try {
      const sInfo = await pluginFindSessionByModel(modelId)
      if (!sInfo) return
      await unloadLlamaModel(modelId)
    } catch (e) {
      logger.warn(`Could not unload ${modelId} before changing its files:`, e)
    }
    this.loadedChatOrder = this.loadedChatOrder.filter((m) => m !== modelId)
  }

  /** rm with a few bounded retries; Windows keeps files busy briefly. */
  private async rmWithRetry(path: string): Promise<void> {
    let delay = 200
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.rm(path)
        return
      } catch (e) {
        if (attempt >= 5) throw e
        await new Promise((r) => setTimeout(r, delay))
        delay *= 2
      }
    }
  }

  /**
   * Update a model with new information.
   * @param modelId
   * @param model
   */
  async update(modelId: string, model: Partial<modelInfo>): Promise<void> {
    if (!isSafeModelRef(modelId)) throw new Error(`Invalid modelId: ${modelId}`)
    // Nothing to rename; without this the folder became "undefined".
    if (model.id === undefined) return
    if (!isValidModelId(model.id))
      throw new Error(
        `Invalid modelId: ${model.id}. Only alphanumeric and / _ - . characters are allowed.`
      )
    const modelFolderPath = await joinPath([
      await this.getProviderPath(),
      'models',
      modelId,
    ])
    const modelConfig = await invoke<ModelConfig>('read_yaml', {
      path: await joinPath([modelFolderPath, 'model.yml']),
    })
    const newFolderPath = await joinPath([
      await this.getProviderPath(),
      'models',
      model.id,
    ])
    // Check if newFolderPath exists
    if (await fs.existsSync(newFolderPath)) {
      throw new Error(`Model with ID ${model.id} already exists`)
    }
    const newModelConfigPath = await joinPath([newFolderPath, 'model.yml'])
    await this.unloadIfLoaded(modelId)
    await fs.mv(modelFolderPath, newFolderPath)
    try {
      // now replace what values have previous model name with format
      await invoke('write_yaml', {
        data: {
          ...modelConfig,
          model_path: modelConfig?.model_path?.replace(
            `${this.providerId}/models/${modelId}`,
            `${this.providerId}/models/${model.id}`
          ),
          mmproj_path: modelConfig?.mmproj_path?.replace(
            `${this.providerId}/models/${modelId}`,
            `${this.providerId}/models/${model.id}`
          ),
        },
        savePath: newModelConfigPath,
      })
    } catch (e) {
      // Put the folder back so the model is not left half-renamed.
      try {
        await fs.mv(newFolderPath, modelFolderPath)
      } catch (rollbackError) {
        logger.error(
          `Rename rollback failed (${newFolderPath} -> ${modelFolderPath})`,
          rollbackError
        )
      }
      throw e
    }

    // The router's preset still references the old model id until we
    // regenerate; without this a `POST /models/load <new-id>` would 404.
    try {
      await this.refreshEnginePreset()
    } catch (e) {
      logger.warn(`Router restart after model rename (${modelId} → ${model.id}) failed`, e)
    }
  }

  /**
   * Joins concurrent imports of the same model instead of starting a second one.
   * Two callers racing (startup embedder bootstrap and an on-demand embed) both
   * passed the `model.yml` existence guard, then registered the same download
   * task id -- which Rust resolves by cancelling the first and deleting its
   * partial file. The loser then returned without writing `model.yml`, so its
   * caller went on to load a model that was never installed.
   */
  override async import(modelId: string, opts: ImportOptions): Promise<void> {
    const inFlight = this.pendingImports.get(modelId)
    if (inFlight) {
      logger.info(`Joining in-flight import of "${modelId}"`)
      return inFlight
    }

    const task = this.runImport(modelId, opts).finally(() => {
      this.pendingImports.delete(modelId)
    })
    this.pendingImports.set(modelId, task)
    return task
  }

  private async runImport(modelId: string, opts: ImportOptions): Promise<void> {
    if (!isValidModelId(modelId))
      throw new Error(
        `Invalid modelId: ${modelId}. Only alphanumeric and / _ - . characters are allowed.`
      )

    const configPath = await joinPath([
      await this.getProviderPath(),
      'models',
      modelId,
      'model.yml',
    ])
    if (await fs.existsSync(configPath))
      throw new Error(`Model ${modelId} already exists`)

    // this is relative to Flint's data folder
    const modelDir = `${this.providerId}/models/${modelId}`

    // we only use these from opts
    // opts.modelPath: URL to the model file
    // opts.mmprojPath: URL to the mmproj file

    const janDataFolderPath = await getJanDataFolderPath()

    /**
     * Resolve a model file that must already exist.
     *
     * This build does not fetch models, so a URL is refused rather than
     * downloaded: the file has to be on disk before it can be imported.
     */
    const requireLocalFile = async (path: string) => {
      if (/^https?:\/\//i.test(path)) {
        throw new Error(
          `Refusing to fetch ${path}: this build does not download models. ` +
            'Point the import at a file already on this machine.'
        )
      }
      if (path.split(/[\/]/).includes('..')) {
        throw new Error(`Refusing path with '..' segment: ${path}`)
      }
      // The Hugging Face downloader returns a path relative to the data
      // folder. Checking that string directly looks in the process working
      // directory (notably / on a Linux desktop launch).
      const fullPath = await joinPath([janDataFolderPath, path])
      if (!(await fs.existsSync(fullPath)))
        throw new Error(`File not found: ${fullPath}`)
      return path
    }

    // Picking shard 2 of a split model registers shard 1: that is the file
    // llama.cpp loads, and it keeps the size and shard checks below honest.
    const pickedModelPath = await requireLocalFile(opts.modelPath)
    let modelPath = ggufFirstShardPath(pickedModelPath)
    if (modelPath !== pickedModelPath) await requireLocalFile(modelPath)
    let mmprojPath = opts.mmprojPath
      ? await requireLocalFile(opts.mmprojPath)
      : undefined
    // Speculative-decoding draft companion; paired with the main model. The
    // file name stays `mtp.gguf` for every flavour: it is the local name of
    // the paired draft, and changing it would orphan existing installs.
    let draftModelPath = opts.specDraftPath
      ? await requireLocalFile(opts.specDraftPath)
      : undefined



    // Validate GGUF files
    const fullModelPath = await joinPath([janDataFolderPath, modelPath])

    if (opts.modelSha256) {
      assertSha256Matches(
        'model',
        opts.modelSha256,
        // The checksum belongs to the file that was picked, not to shard 1.
        await sha256File(await joinPath([janDataFolderPath, pickedModelPath]))
      )
    }
    if (opts.mmprojSha256 && mmprojPath) {
      assertSha256Matches(
        'mmproj',
        opts.mmprojSha256,
        await sha256File(await joinPath([janDataFolderPath, mmprojPath]))
      )
    }
    let isEmbedding = false
    let mtpLayers = 0
    let specKind: SpecDraftKind = 'mtp'
    let templateKwargs: TemplateKwarg[] = []
    let resolvedName: string | undefined

    try {
      // Validate main model file
      const modelMetadata = await readGgufMetadata(fullModelPath)
      logger.info(
        `Model GGUF validation successful: version ${modelMetadata.version}, tensors: ${modelMetadata.tensor_count}`
      )

      if (detectEmbeddingFromGgufMeta(modelMetadata.metadata)) {
        isEmbedding = true
      }
      mtpLayers = detectMtpLayersFromGgufMeta(modelMetadata.metadata)
      templateKwargs = detectTemplateKwargsFromChatTemplate(
        modelMetadata.metadata?.['tokenizer.chat_template']
      )

      const rawName = modelMetadata.metadata?.['general.name']
      if (typeof rawName === 'string') {
        const normalized = rawName.trim().replace(/\s+/g, '-')
        if (normalized.length > 0) resolvedName = normalized
      }

      // Validate mmproj file if present
      if (mmprojPath) {
        const fullMmprojPath = await joinPath([janDataFolderPath, mmprojPath])
        const mmprojMetadata = await readGgufMetadata(fullMmprojPath)
        logger.info(
          `Mmproj GGUF validation successful: version ${mmprojMetadata.version}, tensors: ${mmprojMetadata.tensor_count}`
        )
      }

      // Validate the draft, decide which spec type it implements, and read
      // its head count (the main gguf usually lacks nextn_predict_layers when
      // MTP ships as a separate file).
      if (draftModelPath) {
        const fullDraftPath = await joinPath([janDataFolderPath, draftModelPath])
        const draftMetadata = await readGgufMetadata(fullDraftPath)
        // Only asked for a DFlash-architecture draft, since that is the one
        // case a tensor decides (DSpark = DFlash + Markov head).
        const hasMarkovHead =
          draftMetadata.metadata?.['general.architecture'] === 'dflash'
            ? (await findGgufTensors(fullDraftPath, [MARKOV_HEAD_TENSOR]))
                .length > 0
            : undefined
        specKind = resolveSpecDraftKind(draftMetadata.metadata, {
          hasMarkovHead,
          hint: opts.specDraftKind,
        })
        const draftLayers = detectMtpLayersFromGgufMeta(draftMetadata.metadata)
        // Only an MTP head reports nextn layers; the other flavours have none,
        // and the count is what makes the settings panel offer the toggle.
        mtpLayers = draftLayers > 0 ? draftLayers : Math.max(mtpLayers, 1)
      }
    } catch (error) {
      logger.error('GGUF validation failed:', error)
      throw new Error(
        `Invalid GGUF file(s): ${
          error.message || 'File format validation failed'
        }`
      )
    }

    // Calculate file sizes
    let size_bytes = (await fs.fileStat(fullModelPath)).size
    // Split GGUF: the first shard is only part of the model. Every other shard
    // has to exist (llama.cpp's own split error is opaque) and counts toward
    // the size.
    for (const shard of ggufShardPaths(fullModelPath).slice(1)) {
      if (!(await fs.existsSync(shard))) {
        throw new Error(`Missing model shard: ${shard}`)
      }
      size_bytes += (await fs.fileStat(shard)).size
    }
    if (mmprojPath) {
      size_bytes += (
        await fs.fileStat(await joinPath([janDataFolderPath, mmprojPath]))
      ).size
    }
    if (draftModelPath) {
      size_bytes += (
        await fs.fileStat(await joinPath([janDataFolderPath, draftModelPath]))
      ).size
    }

    if (!resolvedName) {
      const base = opts.modelPath.split(/[\\/]/).pop() ?? modelId
      resolvedName = base.replace(/\.gguf$/i, '') || modelId
    }

    // TODO: add updateModelConfig() method
    const modelConfig = {
      model_path: modelPath,
      mmproj_path: mmprojPath,
      name: resolvedName,
      size_bytes,
      model_sha256: opts.modelSha256,
      model_size_bytes: opts.modelSize,
      mmproj_sha256: opts.mmprojSha256,
      mmproj_size_bytes: opts.mmprojSize,
      embedding: isEmbedding,
      embedding_check_v: EMBEDDING_CHECK_VERSION,
      mtp_layers: mtpLayers,
      mtp_check_v: MTP_CHECK_VERSION,
      template_kwargs: templateKwargs,
      template_kwargs_check_v: TEMPLATE_KWARGS_CHECK_VERSION,
      // A separate draft gguf is downloaded only to be used, so enable it by
      // default. Embedded-MTP models stay opt-in (no flag written here) and
      // need no spec_type: their flavour is always draft-mtp.
      ...(draftModelPath
        ? {
            mtp_model_path: draftModelPath,
            mtp: true,
            spec_type: `draft-${specKind}`,
          }
        : {}),
      ...(isEmbedding
        ? { pooling: 'mean', ubatch_size: 2048, batch_size: 2048 }
        : {}),
    } as ModelConfig
    await fs.mkdir(await joinPath([janDataFolderPath, modelDir]))
    await invoke<void>('write_yaml', {
      data: modelConfig,
      savePath: configPath,
    })
    events.emit(AppEvent.onModelImported, {
      modelId,
      modelPath,
      mmprojPath,
      size_bytes,
      model_sha256: opts.modelSha256,
      model_size_bytes: opts.modelSize,
      mmproj_sha256: opts.mmprojSha256,
      mmproj_size_bytes: opts.mmprojSize,
      embedding: isEmbedding,
    })

    try {
      await this.refreshEnginePreset()
    } catch (e) {
      logger.warn(`Router refresh after import(${modelId}) failed:`, e)
    }
  }

  /**
   * Deletes the entire model folder for a given modelId
   * @param modelId The model ID to delete
   */
  private async deleteModelFolder(modelId: string): Promise<void> {
    if (!isSafeModelRef(modelId)) {
      logger.warn(`Refusing to delete model folder for unsafe id: ${modelId}`)
      return
    }
    try {
      const modelDir = await joinPath([
        await this.getProviderPath(),
        'models',
        modelId,
      ])

      if (await fs.existsSync(modelDir)) {
        logger.info(`Cleaning up model directory: ${modelDir}`)
        await fs.rm(modelDir)
      }
    } catch (deleteError) {
      logger.warn('Failed to delete model directory:', deleteError)
    }
  }

  override async abortImport(modelId: string): Promise<void> {
    // No download to cancel; a failed import leaves only its folder behind.
    await this.deleteModelFolder(modelId)
  }

  override async pauseImport(_modelId: string): Promise<void> {
    // Nothing is ever in flight: models are read from disk, not fetched.
  }

  private async getRandomPort(): Promise<number> {
    return 49152 + Math.floor(Math.random() * (65535 - 49152))
  }

  private parseEnvFromString(
    target: Record<string, string>,
    envString: string
  ): void {
    envString
      .split(';')
      .filter((pair) => pair.trim())
      .forEach((pair) => {
        const [key, ...valueParts] = pair.split('=')
        const cleanKey = key?.trim()

        if (
          cleanKey &&
          valueParts.length > 0 &&
          !cleanKey.startsWith('LLAMA')
        ) {
          target[cleanKey] = valueParts.join('=').trim()
        }
      })
  }

  /**
   * Loads a model with it kept off the GPU for the rest of this run, after
   * the person agreed to it when the GPU driver crashed during a load.
   */
  async loadOnCpu(modelId: string): Promise<SessionInfo> {
    this.cpuFallbackModels.add(modelId)
    await this.refreshEnginePreset()
    await this.ensureEngineReady()
    return this.load(modelId)
  }

  override async load(
    modelId: string,
    settings?: unknown,
    isEmbedding: boolean = false
  ): Promise<SessionInfo> {
    const sInfo = await this.findSessionByModel(modelId)
    if (sInfo) {
      throw new Error('Model already loaded!!')
    }

    if (!isEmbedding && !this.loadingModels.has(modelId)) {
      await this.persistShownContextSize(modelId, settings)
    }

    if (this.loadingModels.has(modelId)) {
      return this.loadingModels.get(modelId)!
    }

    const loadingPromise = this.performLoad(modelId, isEmbedding)
    this.loadingModels.set(modelId, loadingPromise)

    try {
      return await loadingPromise
    } finally {
      this.loadingModels.delete(modelId)
    }
  }

  /**
   * The context the model settings show is the one the engine must run: write
   * it to model.yml (and so the preset's ctx-size) before loading when the two
   * disagree. A failure only logs; the load goes on with what model.yml says.
   */
  private async persistShownContextSize(
    modelId: string,
    settings: unknown
  ): Promise<void> {
    if (!settings || typeof settings !== 'object') return
    try {
      const configPath = await joinPath([
        await this.getProviderPath(),
        'models',
        modelId,
        'model.yml',
      ])
      if (!(await fs.existsSync(configPath))) return
      const cfg = (await invoke<ModelConfig>('read_yaml', {
        path: configPath,
      })) as ModelConfig
      const ctx = contextSizeToPersist(settings as Record<string, unknown>, cfg)
      if (ctx !== undefined) {
        // null removes model.yml's ctx_size so the Default context size applies.
        await this.updateModelSettings(modelId, { ctx_len: ctx })
      }
    } catch (e) {
      logger.warn(`Could not apply the context size for ${modelId}`, e)
    }
  }

  // Awaits the deferred startup, then makes one direct attempt if the worker
  // still isn't up. Safe to call redundantly: start_engine returns the running
  // worker rather than spawning a second one.
  private async ensureEngineReady(): Promise<void> {
    await this.ensureProvisioned().catch(() => undefined)
    if (!(await this.getEngineInfo())) {
      await this.startEngine()
    }
  }

  /**
   * Logs what auto-fit has to work with before a load: each GPU's reported
   * size, what is free right now and what the memory to keep free leaves. The
   * engine's own fit lines are trace-level, so this is the only record of why
   * a model stopped short of the card's VRAM. Best effort: never blocks a load.
   */
  private async logFitBudget(modelId: string): Promise<void> {
    try {
      const devices = (await this.getDevices()).filter(
        (d) => !/^cpu/i.test(d.id)
      )
      const lines = describeFitBudget(
        devices,
        this.config.fit !== false,
        this.config.fit_target
      )
      for (const line of lines) logger.info(`Loading ${modelId}: ${line}`)
    } catch (e) {
      logger.debug('Could not read device memory for the fit log:', e)
    }
  }

  private async performLoad(
    modelId: string,
    isEmbedding: boolean = false
  ): Promise<SessionInfo> {
    await this.applyEngineAddonChange()
    await this.ensureEngineReady()
    if (!(await this.getEngineInfo())) {
      throw new Error(
        'The llama.cpp engine is not running. Please restart the app.'
      )
    }

    await this.preflightModelFiles(modelId)

    if (!isEmbedding) {
      await this.evictChatIfAtCapacity(modelId)
    }

    await this.logFitBudget(modelId)

    try {
      let info: SessionInfo
      try {
        info = await loadLlamaModel(modelId, isEmbedding)
      } catch (error) {
        // One retry with f16 KV when the `auto` defaults are what failed.
        if (await this.shouldFallBackToF16Kv(modelId, error)) {
          logger.warn(
            `Load of ${modelId} failed with the quantized KV cache default; retrying once with an f16 KV cache:`,
            error
          )
          this.kvFallbackModels.add(modelId)
          await this.refreshEnginePreset()
          info = await loadLlamaModel(modelId, isEmbedding)
        } else if (
          shouldRetryLoadOnCpu({
            error,
            alreadyRetried: this.cpuFallbackModels.has(modelId),
            configuredDevice: (this.config as { device?: unknown }).device,
          })
        ) {
          // An engine process that hit an instruction this CPU lacks. One
          // retry with the model off the GPU; a slower run beats no run.
          logger.warn(
            `Load of ${modelId} crashed on a CPU instruction this machine lacks; retrying once on the CPU only (slower):`,
            error
          )
          this.cpuFallbackModels.add(modelId)
          await this.refreshEnginePreset()
          await this.ensureEngineReady()
          info = await loadLlamaModel(modelId, isEmbedding)
        } else if (
          error &&
          typeof error === 'object' &&
          isGpuCrashDuringLoad({
            error,
            alreadyOnCpu: this.cpuFallbackModels.has(modelId),
            configuredDevice: (this.config as { device?: unknown }).device,
          })
        ) {
          // The GPU driver crashed the engine while the model was loading.
          // The CPU may well run it, but slower, so the app asks first and
          // calls `loadOnCpu` on a yes instead of this switching silently.
          throw { ...(error as object), cpu_fallback_offered: true }
        } else {
          throw error
        }
      }
      if (!isEmbedding) {
        this.loadedChatOrder = this.loadedChatOrder.filter((m) => m !== modelId)
        this.loadedChatOrder.push(modelId)
      }
      return info
    } catch (error) {
      logger.error('Error in load command:\n', error)
      throw error
    }
  }

  /**
   * Whether `error` came from the `auto` KV cache defaults, i.e. a retry with
   * f16 could succeed. Explicit user settings never qualify.
   */
  private async shouldFallBackToF16Kv(
    modelId: string,
    error: unknown
  ): Promise<boolean> {
    if (this.kvFallbackModels.has(modelId)) return false
    let mc: { cache_type_k?: string; cache_type_v?: string; flash_attn?: string } = {}
    try {
      mc =
        (await invoke<typeof mc>('read_yaml', {
          path: await joinPath([
            await this.getProviderPath(),
            'models',
            modelId,
            'model.yml',
          ]),
        })) ?? {}
    } catch {
      // No per-model overrides readable: the global settings decide.
    }
    const cfg = this.config as Partial<LlamacppConfig>
    const has = (v: unknown) => typeof v === 'string' && v.length > 0
    return shouldRetryLoadWithF16Kv({
      error,
      alreadyRetried: false,
      defaultsInEffect: kvDefaultsInEffect({
        cacheTypeK: has(mc.cache_type_k) ? mc.cache_type_k : cfg.cache_type_k,
        cacheTypeV: has(mc.cache_type_v) ? mc.cache_type_v : cfg.cache_type_v,
        flashAttn: mc.flash_attn ?? cfg.flash_attn,
        computeCapability: await this.gpuComputeCapability(),
      }),
    })
  }

  /**
   * Fail with a plain reason when a model's file is gone or cut short, instead
   * of the loader's own error, which names neither. Anything that cannot be
   * read here is left for the load itself to report.
   */
  private async preflightModelFiles(modelId: string): Promise<void> {
    let config: ModelConfig & { model_size_bytes?: number }
    let dataFolder: string
    try {
      dataFolder = await getJanDataFolderPath()
      config = await invoke<ModelConfig & { model_size_bytes?: number }>(
        'read_yaml',
        {
          path: await joinPath([
            await this.getProviderPath(),
            'models',
            modelId,
            'model.yml',
          ]),
        }
      )
    } catch {
      return
    }
    if (!config || typeof config !== 'object') return

    const files: Array<{ label: string; path?: string; expected?: number }> = [
      { label: 'model', path: config.model_path, expected: config.model_size_bytes },
      {
        label: 'multimodal projector',
        path: config.mmproj_path,
        expected: config.mmproj_size_bytes,
      },
    ]
    if (config.mtp_model_path) {
      files.push({ label: 'draft model', path: config.mtp_model_path })
    }
    // Shards 2..N of a split model: presence only, their sizes are not recorded.
    if (config.model_path) {
      for (const s of ggufShardPaths(config.model_path).slice(1)) {
        files.push({ label: 'model shard', path: s })
      }
    }
    for (const file of files) {
      if (!file.path) continue
      const full = await joinPath([dataFolder, file.path])
      let exists = false
      let size: number | undefined
      try {
        exists = await fs.existsSync(full)
        if (exists) size = (await fs.fileStat(full))?.size
      } catch {
        continue
      }
      const problem = modelFileProblem({
        label: file.label,
        path: full,
        exists,
        size,
        expectedSize: file.expected,
      })
      if (problem) throw new Error(problem)
    }
  }

  /**
   * Enforce `userModelsMax` against chat models only. Reconciles the local
   * FIFO against the router's loaded set, then unloads the oldest chat model
   * if loading `incomingModelId` would exceed the user-configured cap.
   */
  private async evictChatIfAtCapacity(incomingModelId: string): Promise<void> {
    if (this.userModelsMax <= 0) return // unlimited

    let loaded: string[] = []
    try {
      loaded = await this.getLoadedModels()
    } catch {
      // If we can't introspect, fall back to the local FIFO — better to
      // over-evict than to violate the cap.
      loaded = [...this.loadedChatOrder]
    }
    const loadedSet = new Set(loaded)
    this.loadedChatOrder = this.loadedChatOrder.filter(
      (m) => loadedSet.has(m) && m !== incomingModelId
    )

    while (this.loadedChatOrder.length >= this.userModelsMax) {
      const victim = this.loadedChatOrder.shift()
      if (!victim) break
      try {
        const result = await unloadLlamaModel(victim)
        if (!result.success) {
          logger.warn(
            `Pre-eviction of ${victim} reported failure: ${result.error}`
          )
        } else {
          logger.info(
            `Pre-evicted chat model ${victim} to make room for ${incomingModelId}`
          )
        }
      } catch (e) {
        logger.warn(`Pre-eviction of ${victim} threw:`, e)
      }
    }
  }

  override async unload(modelId: string): Promise<UnloadResult> {
    const sInfo = await this.findSessionByModel(modelId)
    if (!sInfo) {
      throw new Error(`No active session found for model: ${modelId}`)
    }
    try {
      const result = await unloadLlamaModel(modelId)
      if (result.success) {
        this.loadedChatOrder = this.loadedChatOrder.filter((m) => m !== modelId)
        logger.info(`Successfully unloaded model ${modelId}`)
      } else {
        logger.warn(`Failed to unload model ${modelId}: ${result.error}`)
      }
      return result
    } catch (error) {
      logger.error('Error in unload command:', error)
      return {
        success: false,
        error: `Failed to unload model: ${error}`,
      }
    }
  }

  private async *handleStreamingResponse(
    url: string,
    headers: HeadersInit,
    body: string,
    abortController?: AbortController
  ): AsyncIterable<chatCompletionChunk> {
    // AbortSignal.any() is not available in all runtimes (e.g. WebKit/JavaScriptCore),
    // so we manually combine the timeout and external abort signals.
    const combinedController = new AbortController()
    const timeoutId = setTimeout(
      () => combinedController.abort(new Error('Request timed out')),
      this.timeout * 1000
    )
    const externalSignal = abortController?.signal
    const onExternalAbort = () =>
      combinedController.abort(externalSignal?.reason)
    if (externalSignal) {
      if (externalSignal.aborted) {
        combinedController.abort(externalSignal.reason)
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, {
          once: true,
        })
      }
    }
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        connectTimeout: Number(this.timeout) * 1000, // default 10 minutes
        signal: combinedController.signal,
      })
    } catch (e) {
      externalSignal?.removeEventListener('abort', onExternalAbort)
      throw e
    } finally {
      clearTimeout(timeoutId)
    }
    if (!response.ok) {
      externalSignal?.removeEventListener('abort', onExternalAbort)
      const errorData = await response.json().catch(() => null)
      throw new Error(
        `API request failed with status ${response.status}: ${JSON.stringify(
          errorData
        )}`
      )
    }

    if (!response.body) {
      externalSignal?.removeEventListener('abort', onExternalAbort)
      throw new Error('Response body is null')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let jsonStr = ''
    // After the headers arrive the stream may still stall; abort it when no
    // chunk shows up for the configured timeout (a total cap would kill long
    // generations).
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(
        () => combinedController.abort(new Error('Request timed out')),
        this.timeout * 1000
      )
    }
    try {
      while (true) {
        armIdle()
        const { done, value } = await reader.read()
        // Not waiting on the server while the consumer processes this chunk.
        if (idleTimer) clearTimeout(idleTimer)

        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })

        // Process complete lines in the buffer
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep the last incomplete line in the buffer

        for (const line of lines) {
          const trimmedLine = line.trim()
          if (!trimmedLine) continue
          // SSE comments (`: keep-alive` from a proxy) and the other SSE
          // fields carry no completion data.
          if (
            trimmedLine.startsWith(':') ||
            /^(event|id|retry)\s*:/.test(trimmedLine)
          ) {
            continue
          }

          if (trimmedLine.startsWith('error:')) {
            jsonStr = trimmedLine.slice(6).trim()
            const error = JSON.parse(jsonStr)
            throw new Error(error.message)
          } else if (trimmedLine.startsWith('data:')) {
            // The space after the colon is optional per the SSE spec.
            jsonStr = trimmedLine.slice(5).trim()
            if (jsonStr === '[DONE]') continue
          } else {
            // it should not normally reach here
            throw new Error('Malformed chunk')
          }
          try {
            const data = JSON.parse(jsonStr)
            const chunk = data as chatCompletionChunk

            yield chunk
          } catch (e) {
            logger.error('Error parsing JSON from stream or server error:', e)
            // re‑throw so the async iterator terminates with an error
            throw e
          }
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      // Cancel first so an early consumer exit closes the HTTP body instead of
      // leaving it open until the abort signal fires.
      await reader.cancel().catch(() => {})
      try {
        reader.releaseLock()
      } catch {
        // already released
      }
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }
  }

  private async findSessionByModel(
    modelId: string
  ): Promise<SessionInfo | null> {
    try {
      return await pluginFindSessionByModel(modelId)
    } catch (e) {
      logger.error(e)
      throw new Error(String(e))
    }
  }

  private async ensureHealthySession(modelId: string): Promise<SessionInfo> {
    return pluginEnsureSessionReady(modelId, false)
  }

  override async chat(
    opts: chatCompletionRequest,
    abortController?: AbortController
  ): Promise<chatCompletion | AsyncIterable<chatCompletionChunk>> {
    const sessionInfo = await this.ensureHealthySession(opts.model)
    const baseUrl = `http://127.0.0.1:${sessionInfo.port}/v1`
    const url = `${baseUrl}/chat/completions`
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${sessionInfo.api_key}`,
    }
    // always enable prompt progress return if stream is true
    // Requires llamacpp version > b6399
    // Example json returned from server
    // {"choices":[{"finish_reason":null,"index":0,"delta":{"role":"assistant","content":null}}],"created":1758113912,"id":"chatcmpl-UwZwgxQKyJMo7WzMzXlsi90YTUK2BJro","model":"qwen","system_fingerprint":"b1-e4912fc","object":"chat.completion.chunk","prompt_progress":{"total":36,"cache":0,"processed":36,"time_ms":5706760300}}
    // (chunk.prompt_progress?.processed / chunk.prompt_progress?.total) * 100
    // chunk.prompt_progress?.cache is for past tokens already in kv cache
    opts.return_progress = true
    // Per-chunk timings so callers can track live token counts during
    // generation instead of only once the stream finishes.
    opts.timings_per_token = true

    const body = JSON.stringify(opts)
    if (opts.stream) {
      return this.handleStreamingResponse(url, headers, body, abortController)
    }
    // Handle non-streaming response
    const response = await fetchWithTimeout(
      url,
      { method: 'POST', headers, body },
      this.timeout * 1000,
      abortController?.signal
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => null)
      throw new Error(
        `API request failed with status ${response.status}: ${JSON.stringify(
          errorData
        )}`
      )
    }

    const completionResponse = (await response.json()) as chatCompletion

    return completionResponse
  }

  /** Relative paths under `downloads/` that a model folder's yaml points at. */
  private async downloadedFilesOf(modelDir: string): Promise<string[]> {
    try {
      const cfg = await fs.readYaml<Record<string, unknown>>(
        await joinPath([modelDir, 'model.yml'])
      )
      return ['model_path', 'mmproj_path', 'mtp_model_path']
        .map((k) => cfg?.[k])
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.replace(/\\/g, '/'))
        .filter(
          (p) => p.startsWith('downloads/') && !p.split('/').includes('..')
        )
    } catch {
      return []
    }
  }

  /**
   * Delete downloaded GGUFs no remaining model.yml references. Files outside
   * `downloads/` (user-imported in place) are never touched.
   */
  private async removeUnreferencedDownloads(
    files: string[]
  ): Promise<string[]> {
    const failed: string[] = []
    if (files.length === 0) return failed
    try {
      const modelsDir = await joinPath([await this.getProviderPath(), 'models'])
      const stillUsed = new Set<string>()
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 6) return
        let entries: string[] = []
        try {
          entries = await fs.readdirSync(dir)
        } catch {
          return
        }
        for (const entry of entries) {
          const yml = await joinPath([entry, 'model.yml'])
          if (await fs.existsSync(yml)) {
            for (const p of await this.downloadedFilesOf(entry)) stillUsed.add(p)
          } else {
            await walk(entry, depth + 1)
          }
        }
      }
      await walk(modelsDir, 0)
      const dataFolder = await getJanDataFolderPath()
      for (const rel of files) {
        if (stillUsed.has(rel)) continue
        try {
          await fs.rm(await joinPath([dataFolder, rel]))
        } catch (e) {
          logger.warn(`Could not remove downloaded file ${rel}:`, e)
          failed.push(rel)
        }
      }
    } catch (e) {
      logger.warn('Cleanup of downloaded model files failed:', e)
    }
    return failed
  }

  override async delete(modelId: string): Promise<void> {
    if (!isSafeModelRef(modelId)) throw new Error(`Invalid modelId: ${modelId}`)
    const modelDir = await joinPath([
      await this.getProviderPath(),
      'models',
      modelId,
    ])

    if (!(await fs.existsSync(await joinPath([modelDir, 'model.yml'])))) {
      throw new Error(`Model ${modelId} does not exist`)
    }

    // Collect the model's downloaded files before its yaml goes away.
    const owned = await this.downloadedFilesOf(modelDir)
    await this.unloadIfLoaded(modelId)
    await this.rmWithRetry(modelDir)
    let leftovers: string[] = []
    try {
      leftovers = await this.removeUnreferencedDownloads(owned)
    } finally {
      try {
        await this.refreshEnginePreset()
      } catch (e) {
        logger.warn(`Router refresh after delete(${modelId}) failed:`, e)
      }
    }
    if (leftovers.length > 0) {
      throw new Error(
        `Model ${modelId} was removed but these files could not be deleted: ${leftovers.join(', ')}`
      )
    }
  }

  override async getLoadedModels(): Promise<string[]> {
    try {
      let models: string[] = await pluginGetLoadedModels()
      return models
    } catch (e) {
      logger.error(e)
      throw new Error(e)
    }
  }

  /**
   * Check if mmproj.gguf file exists for a given model ID
   * @param modelId - The model ID to check for mmproj.gguf
   * @returns Promise<boolean> - true if mmproj.gguf exists, false otherwise
   */
  async checkMmprojExists(modelId: string): Promise<boolean> {
    try {
      const modelConfigPath = await joinPath([
        await this.getProviderPath(),
        'models',
        modelId,
        'model.yml',
      ])

      const modelConfig = await invoke<ModelConfig>('read_yaml', {
        path: modelConfigPath,
      })

      // If mmproj_path is not defined in YAML, return false
      if (modelConfig.mmproj_path) {
        return true
      }

      const mmprojPath = await joinPath([
        await this.getProviderPath(),
        'models',
        modelId,
        'mmproj.gguf',
      ])
      return await fs.existsSync(mmprojPath)
    } catch (e) {
      logger.error(`Error checking mmproj.gguf for model ${modelId}:`, e)
      return false
    }
  }

  async getMtpInfo(modelId: string): Promise<{
    mtp_layers: number
    mtp: boolean
    spec_draft_n_max?: number
    spec_draft_n_min?: number
    spec_draft_p_min?: number
    spec_draft_sampling?: 'greedy' | 'probabilistic'
  }> {
    const path = await joinPath([
      await this.getProviderPath(),
      'models',
      modelId,
      'model.yml',
    ])
    if (!(await fs.existsSync(path))) {
      return { mtp_layers: 0, mtp: false }
    }
    const cfg = (await invoke<ModelConfig>('read_yaml', { path })) as ModelConfig & {
      mtp_layers?: number
      mtp?: boolean
      spec_draft_n_max?: number
      spec_draft_n_min?: number
      spec_draft_p_min?: number
      spec_draft_sampling?: string
    }
    return {
      mtp_layers: typeof cfg.mtp_layers === 'number' ? cfg.mtp_layers : 0,
      mtp: cfg.mtp === true,
      spec_draft_n_max: cfg.spec_draft_n_max,
      spec_draft_n_min: cfg.spec_draft_n_min,
      spec_draft_p_min: cfg.spec_draft_p_min,
      spec_draft_sampling:
        cfg.spec_draft_sampling === 'greedy' ||
        cfg.spec_draft_sampling === 'probabilistic'
          ? cfg.spec_draft_sampling
          : undefined,
    }
  }

  async updateMtpSettings(
    modelId: string,
    patch: {
      mtp?: boolean
      spec_draft_n_max?: number | null
      spec_draft_n_min?: number | null
      spec_draft_p_min?: number | null
      spec_draft_sampling?: 'greedy' | 'probabilistic' | null
    }
  ): Promise<void> {
    const configPath = await joinPath([
      await this.getProviderPath(),
      'models',
      modelId,
      'model.yml',
    ])
    if (!(await fs.existsSync(configPath))) {
      throw new Error(`model.yml not found for ${modelId}`)
    }
    const cfg = (await invoke<ModelConfig>('read_yaml', { path: configPath })) as ModelConfig & {
      mtp?: boolean
      spec_draft_n_max?: number
      spec_draft_n_min?: number
      spec_draft_p_min?: number
      spec_draft_sampling?: string
    }

    if (typeof patch.mtp === 'boolean') cfg.mtp = patch.mtp
    if ('spec_draft_sampling' in patch) {
      if (patch.spec_draft_sampling === null) {
        delete cfg.spec_draft_sampling
      } else if (
        patch.spec_draft_sampling === 'greedy' ||
        patch.spec_draft_sampling === 'probabilistic'
      ) {
        cfg.spec_draft_sampling = patch.spec_draft_sampling
      }
    }
    const assignNumeric = (
      key: 'spec_draft_n_max' | 'spec_draft_n_min' | 'spec_draft_p_min',
      value: number | null | undefined
    ) => {
      if (value === null) {
        delete cfg[key]
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        cfg[key] = value
      }
    }
    if ('spec_draft_n_max' in patch) assignNumeric('spec_draft_n_max', patch.spec_draft_n_max)
    if ('spec_draft_n_min' in patch) assignNumeric('spec_draft_n_min', patch.spec_draft_n_min)
    if ('spec_draft_p_min' in patch) assignNumeric('spec_draft_p_min', patch.spec_draft_p_min)

    await invoke<void>('write_yaml', { data: cfg, savePath: configPath })

    try {
      await this.refreshEnginePreset()
    } catch (e) {
      logger.warn(`Failed to restart router after MTP update for ${modelId}`, e)
    }
  }

  /**
   * Persist a per-model setting into `model.yml` and apply the engine preset
   * before resolving. A failed application restores the saved configuration
   * and rejects so the caller can report the error.
   *
   * Sidebar keys are mapped to the canonical `model.yml` / preset keys here.
   * Keys not in the mapping are silently ignored — they're either Flint-side
   * concerns (the composer's `reasoning`, `auto_increase_ctx_len`) or not yet emitted by
   * `preset.ts` (deferred to phase b).
   */
  async updateModelSettings(
    modelId: string,
    patch: Record<string, string | number | boolean | null | undefined>
  ): Promise<void> {
    const configPath = await joinPath([
      await this.getProviderPath(),
      'models',
      modelId,
      'model.yml',
    ])
    if (!(await fs.existsSync(configPath))) {
      throw new Error(`model.yml not found for ${modelId}`)
    }
    const cfg = (await invoke<ModelConfig>('read_yaml', {
      path: configPath,
    })) as ModelConfig & Record<string, unknown>
    const previousConfig = { ...cfg }

    let touched = false
    for (const [sidebarKey, value] of Object.entries(patch)) {
      const m = MODEL_SETTINGS_YAML_MAPPING[sidebarKey]
      if (!m) continue
      const next = m.coerce(value)
      if (next === null) {
        if (m.yamlKey in cfg) {
          delete (cfg as Record<string, unknown>)[m.yamlKey]
          touched = true
        }
      } else {
        ;(cfg as Record<string, unknown>)[m.yamlKey] = next
        touched = true
      }
    }

    if (!touched) return

    await invoke<void>('write_yaml', { data: cfg, savePath: configPath })

    try {
      await this.refreshEnginePreset()
    } catch (e) {
      await invoke<void>('write_yaml', {
        data: previousConfig,
        savePath: configPath,
      })
      throw e
    }
  }

  async getDevices(): Promise<DeviceList[]> {
    // set envs
    const envs: Record<string, string> = {}
    if (this.llamacpp_env) this.parseEnvFromString(envs, this.llamacpp_env)

    try {
      const dList = await engineDevices(envs)
      // On Linux with AMD GPUs, llama.cpp via Vulkan may report UMA (shared) memory as device-local.
      // For clearer UX, override with dedicated VRAM from the hardware plugin when available.
      try {
        const sysInfo = await getSystemInfo()
        if (sysInfo?.os_type === 'linux' && Array.isArray(sysInfo.gpus)) {
          const usage = await getSystemUsage()
          if (usage && Array.isArray(usage.gpus)) {
            return overrideAmdVulkanMemory(dList, sysInfo.gpus, usage.gpus)
          }
        }
      } catch (e) {
        logger.warn('Device memory override (AMD/Linux) failed:', e)
      }

      return dList
    } catch (error) {
      logger.error('Failed to query devices:\n', error)
      throw new Error('Failed to load llamacpp backend')
    }
  }

  /**
   * Resolves the default/preferred embedding model, importing and loading
   * sentence-transformer-mini as the fallback, then ensures a session exists.
   * Shared by embed() and getEmbeddingContextSize() so both agree on which
   * model is "the" embedding model.
   */
  private async ensureEmbeddingModelLoaded(): Promise<SessionInfo> {
    // Hot path: a configured, installed embedding model needs one yml read
    // (get() runs the same embedding resolution list() does), not a full
    // relisting of every model on disk per embed/tokenize call.
    const configured = await getDefaultEmbeddingModelId('llamacpp')
    if (configured) {
      let configuredInfo: modelInfo | undefined
      try {
        configuredInfo = await this.get(configured)
      } catch (e) {
        logger.warn(`Could not read embedding model "${configured}":`, e)
      }
      if (configuredInfo && (configuredInfo as any).embedding === true) {
        let fast = await this.findSessionByModel(configured)
        if (!fast) {
          fast = await this.load(configured, undefined, true)
        }
        return fast as SessionInfo
      }
    }

    const downloadedModelList = await this.list()
    const installedEmbedding = downloadedModelList.filter(
      (m) => (m as any).embedding === true
    )
    const hasMini = downloadedModelList.some(
      (m) => m.id === FALLBACK_EMBEDDING_MODEL_ID
    )
    let preferred = await getDefaultEmbeddingModelId('llamacpp')

    if (!preferred && installedEmbedding.length === 1 && !hasMini) {
      preferred = installedEmbedding[0].id
      await setDefaultEmbeddingModelId('llamacpp', preferred)
      logger.info(
        `Auto-promoted "${preferred}" as default embedding model (single installed model, sentence-transformer-mini not present)`
      )
    }

    const preferredMatch =
      preferred && installedEmbedding.find((m) => m.id === preferred)

    if (preferred && !preferredMatch) {
      logger.warn(
        `Default embedding model "${preferred}" not installed; falling back to sentence-transformer-mini`
      )
    }

    // Only a model that is already on disk. Reaching for the network here is
    // what made a first RAG call download from huggingface.co behind the
    // user's back, including right after a failed startup install.
    const targetModelId = preferredMatch
      ? (preferred as string)
      : hasMini
        ? FALLBACK_EMBEDDING_MODEL_ID
        : installedEmbedding[0]?.id

    if (!targetModelId) {
      throw new Error(NO_EMBEDDING_MODEL_MESSAGE)
    }

    let sInfo = await this.findSessionByModel(targetModelId)
    if (!sInfo) {
      sInfo = await this.load(targetModelId, undefined, true)
    }
    return sInfo as SessionInfo
  }

  /**
   * Actual post-fit context window of the embedding model, read from the
   * router's /props endpoint (the same source getModelProps uses for chat
   * models). Used by RAG ingestion to size chunks so they don't exceed the
   * model's n_ctx (e.g. sentence-transformer-mini natively caps at 256).
   */
  async getEmbeddingContextSize(): Promise<number | undefined> {
    const sInfo = await this.ensureEmbeddingModelLoaded()
    const props = await this.getModelProps(sInfo.model_id)
    return props?.nCtx
  }

  /**
   * Real token counts from the embedding model's own tokenizer via /tokenize
   * on its session port. Char-based chunking can't reliably predict token
   * count (subword tokenizers vary widely by content), so callers that need
   * a hard guarantee against exceed_context_size_error should verify with
   * this rather than estimating from character length.
   */
  async countEmbeddingTokens(texts: string[]): Promise<number[]> {
    const sInfo = await this.ensureEmbeddingModelLoaded()
    const counts: number[] = new Array(texts.length)
    const countOne = async (text: string): Promise<number> => {
      const res = await fetchWithTimeout(
        `http://127.0.0.1:${sInfo.port}/tokenize`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${sInfo.api_key}`,
          },
          body: JSON.stringify({ content: text, model: sInfo.model_id }),
        },
        TOKENIZE_TIMEOUT_MS
      )
      if (!res.ok) {
        throw new Error(`Tokenize request failed with status ${res.status}`)
      }
      const json = (await res.json()) as { tokens?: unknown[] }
      return Array.isArray(json.tokens) ? json.tokens.length : 0
    }
    // Small bounded pool: one model resolution for the whole batch, and a
    // few tokenize requests in flight instead of one at a time.
    let next = 0
    const worker = async () => {
      while (next < texts.length) {
        const i = next++
        counts[i] = await countOne(texts[i])
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(TOKENIZE_CONCURRENCY, texts.length) }, worker)
    )
    return counts
  }

  /**
   * Token budget for one embedding request.
   *
   * Deliberately not the engine-wide `ubatch_size`: preset.ts pins every
   * embedding model's section to its own ubatch (DEFAULT_EMBEDDING_UBATCH) and
   * to `ctx-size = 0`, so the real ceiling is the embedder's own trained
   * context -- 512 on MiniLM. llama.cpp rejects a batch wider than either with
   * no retry path, so the budget is the smaller of the two.
   */
  private async embedBatchBudget(sInfo: SessionInfo): Promise<number> {
    let budget = DEFAULT_EMBEDDING_UBATCH
    try {
      const props = await this.getModelProps(sInfo.model_id)
      const nCtx = props?.nCtx
      if (typeof nCtx === 'number' && nCtx > 0) {
        budget = Math.min(budget, nCtx)
      }
    } catch (e) {
      // Without /props the pinned ubatch is still a valid ceiling.
      logger.warn('Could not read embedder context size; using the pinned ubatch:', e)
    }
    return budget
  }

  async embed(text: string[]): Promise<EmbeddingResponse> {
    const sInfo = await this.ensureEmbeddingModelLoaded()
    const batches = buildEmbedBatches(text, await this.embedBatchBudget(sInfo))

    const attemptRequest = async (
      session: SessionInfo,
      batchInput: string[]
    ) => {
      const baseUrl = `http://127.0.0.1:${session.port}/v1/embeddings`
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.api_key}`,
      }
      const body = JSON.stringify({
        input: batchInput,
        model: session.model_id,
        encoding_format: 'float',
      })
      const response = await fetchWithTimeout(
        baseUrl,
        { method: 'POST', headers, body },
        EMBED_TIMEOUT_MS
      )
      return response
    }

    const batchResults: Array<{ result: EmbedBatchResult; offset: number }> = []

    // The token estimate assumes ~3 chars per token; CJK or emoji-heavy text
    // can exceed the batch budget and llama.cpp rejects it outright. On such a
    // rejection split the batch in half and retry, down to a single input.
    const sendBatch = async (
      batchInput: string[],
      offset: number
    ): Promise<void> => {
      const response = await attemptRequest(sInfo, batchInput)
      if (!response.ok) {
        const errorData = await response.json().catch(() => null)
        const tooLarge =
          response.status === 400 || response.status === 413 || response.status === 500
        if (tooLarge && batchInput.length > 1) {
          const mid = Math.ceil(batchInput.length / 2)
          await sendBatch(batchInput.slice(0, mid), offset)
          await sendBatch(batchInput.slice(mid), offset + mid)
          return
        }
        throw new Error(
          `API request failed with status ${response.status}: ${JSON.stringify(errorData)}`
        )
      }
      batchResults.push({
        result: (await response.json()) as EmbedBatchResult,
        offset,
      })
    }

    for (const { batch, offset } of batches) {
      await sendBatch(batch, offset)
    }

    return mergeEmbedResponses(
      sInfo.model_id,
      batchResults
    ) as EmbeddingResponse
  }

  /**
   * Check if a tool is supported by the model
   * Currently read from GGUF chat_template
   * @param modelId
   * @returns
   */
  async isToolSupported(modelId: string): Promise<boolean> {
    const janDataFolderPath = await getJanDataFolderPath()
    const modelConfigPath = await joinPath([
      this.providerPath,
      'models',
      modelId,
      'model.yml',
    ])
    const modelConfig = await invoke<ModelConfig>('read_yaml', {
      path: modelConfigPath,
    })
    // model option is required
    // NOTE: model_path and mmproj_path can be either relative to Flint's data folder or absolute path
    const modelPath = await joinPath([
      janDataFolderPath,
      modelConfig.model_path,
    ])
    return chatTemplateSupportsTools(
      (await readGgufMetadata(modelPath)).metadata?.['tokenizer.chat_template']
    )
  }

  /**
   * Check the support status of a model by its path (local/remote)
   *
   * Returns:
   * - "RED"    → weights don't fit in total memory
   * - "YELLOW" → weights fit in VRAM but need system RAM, or KV cache doesn't fit
   * - "GREEN"  → both weights + KV cache fit in VRAM
   */
  async isModelSupported(
    path: string,
    ctxSize?: number,
    overrides?: {
      cacheTypeK?: string
      cacheTypeV?: string
      noKvOffload?: boolean
    }
  ): Promise<'RED' | 'YELLOW' | 'GREEN'> {
    try {
      // The estimate must use the cache width the model will load with: its
      // own setting when it has one, else the engine-wide one.
      const cfg = this.config as Partial<LlamacppConfig> | undefined
      const has = (v: unknown): v is string =>
        typeof v === 'string' && v.length > 0
      const kv = resolveKvCacheTypes({
        cacheTypeK: has(overrides?.cacheTypeK)
          ? overrides?.cacheTypeK
          : cfg?.cache_type_k,
        cacheTypeV: has(overrides?.cacheTypeV)
          ? overrides?.cacheTypeV
          : cfg?.cache_type_v,
        flashAttn: cfg?.flash_attn,
      })
      const result = await isModelSupported(
        path,
        Number(ctxSize),
        kv.k,
        kv.v,
        overrides?.noKvOffload === true ? true : cfg?.no_kv_offload === true
      )
      return result
    } catch (e) {
      throw new Error(String(e))
    }
  }

  /**
   * Validate GGUF file and check for unsupported architectures like CLIP
   */
  async validateGgufFile(filePath: string): Promise<{
    isValid: boolean
    error?: string
    metadata?: any
  }> {
    try {
      logger.info(`Validating GGUF file: ${filePath}`)
      const metadata = await readGgufMetadata(filePath)

      // Check if architecture is 'clip' which is not supported for text generation
      const architecture = metadata.metadata?.['general.architecture']
      logger.info(`Model architecture: ${architecture}`)

      if (architecture === 'clip') {
        const errorMessage =
          'This model has CLIP architecture and cannot be imported as a text generation model. CLIP models are designed for vision tasks and require different handling.'
        logger.error('CLIP architecture detected:', architecture)
        return {
          isValid: false,
          error: errorMessage,
          metadata,
        }
      }

      logger.info('Model validation passed. Architecture:', architecture)
      return {
        isValid: true,
        metadata,
      }
    } catch (error) {
      logger.error('Failed to validate GGUF file:', error)
      return {
        isValid: false,
        error: `Failed to read model metadata: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      }
    }
  }

  async getTokensCount(opts: chatCompletionRequest): Promise<number> {
    let imageTokens = 0
    const hasImages = opts.messages.some(
      (msg) =>
        Array.isArray(msg.content) &&
        msg.content.some((content) => content.type === 'image_url')
    )

    if (hasImages) {
      try {
        const janDataFolderPath = await getJanDataFolderPath()
        const modelConfigPath = await joinPath([
          this.providerPath,
          'models',
          opts.model,
          'model.yml',
        ])
        const modelConfig = await invoke<ModelConfig>('read_yaml', {
          path: modelConfigPath,
        })
        if (modelConfig.mmproj_path) {
          const mmprojPath = await joinPath([
            janDataFolderPath,
            modelConfig.mmproj_path,
          ])
          const metadata = await readGgufMetadata(mmprojPath)
          imageTokens = await this.calculateImageTokens(
            opts.messages,
            metadata.metadata
          )
        }
      } catch (error) {
        logger.warn('Failed to calculate image tokens:', error)
        imageTokens = this.estimateImageTokensFallback(opts.messages)
      }
    }

    let textChars = 0
    for (const msg of opts.messages) {
      if (typeof msg.content === 'string') {
        textChars += msg.content.length
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            textChars += part.text.length
          }
        }
      }
    }
    const textTokens = Math.ceil(textChars / 4)
    return textTokens + imageTokens
  }

  private async calculateImageTokens(
    messages: chatCompletionRequestMessage[],
    metadata: Record<string, string>
  ): Promise<number> {
    // Extract vision parameters from metadata
    const projectionDim =
      Math.floor(Number(metadata['clip.vision.projection_dim']) / 10) || 256

    // Count images in messages
    let imageCount = 0
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        imageCount += message.content.filter(
          (content) => content.type === 'image_url'
        ).length
      }
    }

    logger.info(
      `Calculated ${projectionDim} tokens per image, ${imageCount} images total`
    )
    return projectionDim * imageCount - imageCount // remove the lingering <__image__> placeholder token
  }

  private estimateImageTokensFallback(
    messages: chatCompletionRequestMessage[]
  ): number {
    // Fallback estimation if metadata reading fails
    const estimatedTokensPerImage = 256 // Gemma's siglip

    let imageCount = 0
    for (const message of messages) {
      if (Array.isArray(message.content)) {
        imageCount += message.content.filter(
          (content) => content.type === 'image_url'
        ).length
      }
    }

    logger.warn(
      `Fallback estimation: ${estimatedTokensPerImage} tokens per image, ${imageCount} images total`
    )
    return imageCount * estimatedTokensPerImage - imageCount // remove the lingering <__image__> placeholder token
  }
}
