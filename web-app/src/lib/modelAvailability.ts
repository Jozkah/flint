/**
 * What state a model is actually in.
 *
 * The distinction that matters: an installed local model that simply is not
 * loaded is *ready*, not offline. Marking it offline would be wrong on the
 * most common case there is — a llama.cpp model sitting on disk between runs.
 * Offline means something tried to reach a remote endpoint and could not.
 */

import { isLoopback, originOf } from '@/hooks/useProviderReachability'

export type ModelAvailability =
  /** Local weights on disk, ready to load. Not loaded is not offline. */
  | 'local-ready'
  /** Loaded and serving right now. */
  | 'loaded'
  /** Being loaded into memory. */
  | 'loading'
  /** Being fetched. */
  | 'downloading'
  /** A remote provider with a key, no failure on record. */
  | 'remote-ready'
  /** A remote provider whose endpoint just failed to answer. */
  | 'offline'
  /** Configured but unusable: no API key, no base URL. */
  | 'misconfigured'
  /** The provider is switched off. */
  | 'disabled'

export type AvailabilityInput = {
  /** Local engines serve from disk; everything else is a remote endpoint. */
  isLocal: boolean
  providerActive: boolean
  /** Remote providers need one; local ones do not. */
  hasApiKey: boolean
  baseUrl?: string | null
  /** Origins with a transport failure on record. */
  unreachableOrigins: Readonly<Record<string, unknown>>
  modelLoaded?: boolean
  modelLoading?: boolean
  modelDownloading?: boolean
}

/**
 * Resolve one model's state.
 *
 * Order matters: an inactive provider is disabled whatever else is true, and
 * work in progress (downloading, loading) outranks the resting state, because
 * that is what the user is waiting on.
 */
export function modelAvailability(input: AvailabilityInput): ModelAvailability {
  if (!input.providerActive) return 'disabled'
  if (input.modelDownloading) return 'downloading'
  if (input.modelLoading) return 'loading'

  if (input.isLocal) {
    // On disk and not loaded is the resting state, not a fault.
    return input.modelLoaded ? 'loaded' : 'local-ready'
  }

  if (!input.hasApiKey) return 'misconfigured'

  const origin = originOf(input.baseUrl)
  // A loopback endpoint is the local engine; its health is the engine's to
  // report, and a transport blip there is not a provider being offline.
  if (origin && !isLoopback(origin) && origin in input.unreachableOrigins) {
    return 'offline'
  }
  return 'remote-ready'
}

/** Only one state earns the red treatment. */
export const isOffline = (a: ModelAvailability): boolean => a === 'offline'

/**
 * Row styling for an unavailable model.
 *
 * A faint wash and a hairline, not a solid fill: the row must stay readable
 * and stay selectable — a model being unreachable now does not mean the user
 * cannot pick it, and hover and selection have to keep working over the top.
 */
export const OFFLINE_ROW_CLASS =
  'bg-destructive/[0.06] dark:bg-destructive/[0.10] ring-1 ring-inset ring-destructive/25'

export const OFFLINE_DOT_CLASS = 'bg-destructive/70'
