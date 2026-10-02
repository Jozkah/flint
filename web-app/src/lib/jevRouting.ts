import type { Assistant } from '@janhq/core'
import { useJevSettings } from '@/hooks/useJevSettings'
import { useAutomationSettings } from '@/hooks/useAutomationSettings'
import { jevSuggestSkill, shouldAskForSkill, type JevFallback } from '@/lib/jev'

/**
 * The built-ins Jev is allowed to route between automatically.
 *
 * Custom/project assistants are intentionally excluded: choosing one is an
 * explicit user/project decision and routing away from it could discard custom
 * instructions. The same goes for a built-in the user picked themselves, or
 * "None": callers report those as `pinned`, and only a conversation still on
 * the default is routed. Flint (`jan`) is the generalist default; the other
 * four are specialists.
 */
export const JEV_ROUTABLE_ASSISTANT_IDS = [
  'jan',
  'quartz',
  'coal',
  'blaze',
  'redstone',
] as const

const ROUTABLE_IDS = new Set<string>(JEV_ROUTABLE_ASSISTANT_IDS)

export type JevSuggestedMode = 'review' | 'ask' | 'auto'

const MODE_DESCRIPTIONS: Record<JevSuggestedMode, string> = {
  review:
    'Review mode: inspect, reason, explain, and propose. Prefer understanding and verification over making changes.',
  ask:
    'Ask mode: work interactively and prepare the task, expecting user confirmation around consequential changes.',
  auto:
    'Auto mode: execution-first; carry the task through autonomously within permissions the user has already granted. This suggestion never grants permission itself.',
}

const ROUTE_PREFIX = 'jev-route:'

export type JevPromptRoute = {
  assistantId: string | null
  mode: JevSuggestedMode | null
  probability: number | null
  fallback: JevFallback | null
}

type RouteOption = { name: string; description: string }

function routeName(assistantId: string, mode?: JevSuggestedMode): string {
  return mode
    ? `${ROUTE_PREFIX}${assistantId}:${mode}`
    : `${ROUTE_PREFIX}${assistantId}`
}

export function parseJevRouteChoice(choice: string | null): {
  assistantId: string
  mode: JevSuggestedMode | null
} | null {
  if (!choice?.startsWith(ROUTE_PREFIX)) return null
  const [assistantId, rawMode, ...rest] = choice.slice(ROUTE_PREFIX.length).split(':')
  if (!assistantId || rest.length > 0 || !ROUTABLE_IDS.has(assistantId)) return null
  if (!rawMode) return { assistantId, mode: null }
  if (rawMode !== 'review' && rawMode !== 'ask' && rawMode !== 'auto') return null
  return { assistantId, mode: rawMode }
}

/**
 * Build the bounded choice set handed to Jev. A caller that asks for mode
 * guidance sends the cross product of five assistants and three work-style
 * suggestions (15 choices, below the backend's 24-choice cap); otherwise it
 * sends only the five assistants.
 */
export function buildJevRouteOptions(
  assistants: readonly Pick<Assistant, 'id' | 'name' | 'description'>[],
  includeCoworkMode: boolean
): RouteOption[] {
  const candidates = assistants.filter((assistant) => ROUTABLE_IDS.has(assistant.id))
  if (!includeCoworkMode) {
    return candidates.map((assistant) => ({
      name: routeName(assistant.id),
      description: `${assistant.name}: ${assistant.description ?? 'general assistant'}`,
    }))
  }

  const modes: JevSuggestedMode[] = ['review', 'ask', 'auto']
  return candidates.flatMap((assistant) =>
    modes.map((mode) => ({
      name: routeName(assistant.id, mode),
      description: `${assistant.name}: ${assistant.description ?? 'general assistant'} ${MODE_DESCRIPTIONS[mode]}`,
    }))
  )
}

/** Resolves to `null` if `signal` aborts first; a stopped turn must not wait on Jev. */
export function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return work
  if (signal.aborted) return Promise.resolve(null)
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/**
 * Ask Jev which built-in should handle this prompt and, when requested, which
 * mode it recommends to that assistant. The mode is advisory only: callers may
 * put it in the model's system prompt, but must never use it to widen
 * tool/folder permissions.
 *
 * This deliberately uses the existing Jev skill-choice channel. That keeps the
 * API key, opt-in (`skillMode`), budgets, timeout, probability threshold,
 * receipts and fail-closed fallback in the Rust backend instead of creating a
 * second network path in the renderer.
 *
 * Nothing is sent for a temporary chat, a prompt too short to mean anything,
 * or a conversation whose assistant the user chose (`pinned`). When Jev
 * abstains or is unavailable the current assistant is kept.
 */
export async function chooseJevPromptRoute(args: {
  message: string
  assistants: readonly Pick<Assistant, 'id' | 'name' | 'description'>[]
  currentAssistantId?: string
  includeCoworkMode?: boolean
  /** The user explicitly chose this conversation's assistant (or "None"). */
  pinned?: boolean
  /** A temporary chat: its prompts are not sent anywhere for routing. */
  temporary?: boolean
  /** Stopping the turn stops waiting for Jev. */
  signal?: AbortSignal
}): Promise<JevPromptRoute | null> {
  const message = args.message.trim()
  if (!shouldAskForSkill(message)) return null
  if (args.temporary || args.pinned) return null
  // The user turned automatic assistant routing off.
  if (!useAutomationSettings.getState().routeAssistants) return null

  // A custom/project assistant is pinned intentionally. Jev only orchestrates
  // the built-in Flint family.
  if (args.currentAssistantId && !ROUTABLE_IDS.has(args.currentAssistantId)) {
    return null
  }

  const jevMode = useJevSettings.getState().skillMode
  if (jevMode === 'off') return null

  const options = buildJevRouteOptions(
    args.assistants,
    Boolean(args.includeCoworkMode)
  )
  if (options.length <= 1) return null

  try {
    const decision = await raceAbort(jevSuggestSkill(message, options), args.signal)
    if (!decision) return null
    const parsed = parseJevRouteChoice(decision.skill)
    if (!parsed) {
      // Abstained or unconfident: keep whatever assistant the conversation
      // has rather than resetting it (or the applied one) to Flint.
      return {
        assistantId: null,
        mode: null,
        probability: decision.probability,
        fallback: decision.fallback,
      }
    }
    return {
      assistantId: parsed.assistantId,
      mode: parsed.mode,
      probability: decision.probability,
      fallback: decision.fallback,
    }
  } catch (error) {
    // Routing is decision support, never a reason to fail the user's prompt.
    console.debug('[Jev] prompt routing unavailable:', error)
    return null
  }
}

/** System-prompt text for a routed turn. It changes behaviour, never authority. */
export function jevModeSuggestion(mode: JevSuggestedMode | null): string | undefined {
  if (!mode) return undefined
  return [
    `Jev suggests ${mode.toUpperCase()} as the work style for this turn.`,
    MODE_DESCRIPTIONS[mode],
    'This is behavioural guidance only. It does not change tool permissions, folder access, approval requirements, or any other security boundary.',
  ].join(' ')
}
