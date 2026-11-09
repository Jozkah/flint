// What ChatInput takes: its surface, scope, model and the callbacks it calls.

import type { ReactNode } from 'react'
import type { ModelSelection } from '@/hooks/useConversationPane'
import type { TokenUsageSource } from '@/hooks/useTokensCount'
import type { ChatStatus } from 'ai'
import type { ModelCheck } from '@/hooks/useComposerSend'
import type { NamedSource } from '@/lib/referenceMenu'
import type { SlashBuiltin } from '@/lib/slashCommands'
import type { SlashSurface } from '@/hooks/useSlashCommands'

export type ChatInputProps = {
  className?: string
  showSpeedToken?: boolean
  /**
   * Hide the composer's token counter. For a surface that already shows token
   * usage elsewhere (Cowork shows it per turn), so the same number is not
   * reported twice.
   */
  hideTokenCounter?: boolean
  /**
   * Compacts the open conversation, offered from the context circle. Chat
   * compacts through its registered compactor; a surface with its own (Cowork)
   * supplies this.
   */
  onCompact?: () => void
  model?: ThreadModel
  initialMessage?: boolean
  projectId?: string
  projectAssistantId?: string
  onSubmit?: (
    text: string,
    files?: Array<{ type: string; mediaType: string; url: string }>,
    /**
     * Call when the send is refused before anything started (no tool-calling
     * model, say): the composer then gets its text and attachments back.
     */
    onRefused?: () => void
  ) => void
  onStop?: () => void
  chatStatus?: ChatStatus
  // Overrides the conversation scope this input belongs to — both its message
  // queue and its pending attachments (default: useThreads' currentThreadId).
  // Callers outside the general chat (e.g. Cowork, keyed by session id) pass
  // their own id so each gets an independent queue and attachment draft.
  scopeKey?: string
  /**
   * Whether the surface's tool set is configured from this composer.
   *
   * False for a surface that builds its own set (Cowork, via
   * `buildCoworkTools`). Its toggles here would be inert on this surface while
   * still writing the global chat stores, so a user turning "agent tools" off
   * in Cowork would silently disable them in Chat.
   */
  ownsToolSet?: boolean
  /**
   * The folder `@` references may name (AH-204). A reference is a path inside
   * it, read through the backend's confined reader; with none, the picker
   * offers nothing and a typed reference resolves to nothing. Never the home
   * directory: that used to make every file under it, keys included, one `@`
   * away from the prompt.
   */
  referenceRoot?: string | null
  /**
   * What else `@` can name besides files (AH-204): the skills and saved agents
   * of the surface. Offered in the same ranked list, inserted as typed
   * references (`@skill:name`, `@agent:name`).
   */
  referenceSources?: { skills?: NamedSource[]; agents?: NamedSource[] }
  /**
   * Surface-specific controls docked in the composer's control row (Cowork's
   * plan toggle and folder chip). They sit outside the streaming dim, because
   * both configure the *next* message rather than the run in flight.
   */
  surfaceControls?: ReactNode
  /** Put the assistant, sampling, tools, web search and reasoning controls
   * behind one Options button (Cowork), for a quieter row. */
  groupOptions?: boolean
  /**
   * Where this composer's web search choice is kept (useWebSearchChoice).
   * Absent: the chat shown (or the new-chat draft). `null`: nothing yet, so
   * the default from Settings shows until `ensureWebSearchScope` makes one.
   */
  webSearchScope?: string | null
  /** Makes the scope a choice is written to (Cowork creates its session). */
  ensureWebSearchScope?: () => string
  /**
   * The model selector, docked under the composer at the right. The reasoning
   * effort control, when the model has one, sits to its left. Absent, the
   * effort control still shows (alone) so it is reachable on every surface.
   */
  modelControl?: ReactNode
  /** Controls under the composer at the left (Cowork's mode and access). */
  belowLeft?: ReactNode
  /**
   * Like `belowLeft`, but handed the reasoning-effort control so the surface
   * can fold it into its own settings group; the effort is then not drawn on
   * the right.
   */
  belowLeftWithEffort?: (ctx: {
    effort: ReactNode
    effortOverridden: boolean
    effortLabel: string | null
  }) => ReactNode
  /**
   * Replaces the default stop button while streaming.
   *
   * Cowork supplies one control that asks how far to stop; without this slot
   * it would have to render a second stop button beside this one, which is
   * exactly the thing being removed.
   */
  stopControl?: ReactNode
  /**
   * The surface shows held messages in a panel of its own (Cowork's held
   * input, with Send and Discard), so the composer leaves them out of its
   * chips and each held message is shown once.
   */
  heldShownElsewhere?: boolean
  /**
   * A surface that can hold a project folder (Cowork). When set, a pasted
   * path to a folder offers to attach it; `attached` are the folders it
   * already has, which are not offered again.
   */
  pastedFolder?: {
    attached: readonly string[]
    onAttach: (path: string) => void
  }
  /**
   * Usage for a surface that keeps no thread messages (Cowork). Rendering the
   * counter here rather than in the caller is what keeps its placement, the
   * `tokenCounterCompact` setting and the spacing to the send button identical
   * across surfaces.
   */
  tokenSource?: TokenUsageSource
  /**
   * The thread this composer writes to, when that is not the current thread:
   * a split conversation pane passes its own, because the current thread is
   * whichever pane is active. Defaults to useThreads' currentThreadId.
   */
  threadId?: string
  /**
   * The model this composer sends with, when the surface decides it rather
   * than the global picker or a thread: a Cowork session sends with its own
   * saved model, so "is a model chosen" has to ask the session.
   */
  modelSelection?: ModelSelection
  /**
   * The key this composer's per-conversation model overrides (reasoning
   * effort) are stored under, when that is not a thread: a Cowork session's
   * id, which is the key its transport resolves the model with. Defaults to
   * the thread id; an empty string means "no conversation yet" (the global
   * model setting is written, as on the new-chat screen) rather than falling
   * back to whichever chat thread is current.
   */
  modelOverrideScope?: string
  /**
   * The saved model that no longer resolves, named in the message shown
   * instead of the generic "select a model" when nothing can be sent with.
   */
  unavailableModel?: string
  /**
   * Checked before a send, for a host that owns the model choice (Cowork): if
   * the saved model is gone, ask the user for another and record it. `'retry'`
   * means a replacement was applied and the send should go ahead once it shows;
   * `'stop'` means the user cancelled. Absent, a chat checks its own thread.
   */
  confirmModel?: () => ModelCheck | Promise<ModelCheck>
  /**
   * Keeps this composer's draft apart from the main one. The second pane of a
   * split conversation passes a scope; without one the shared main draft is
   * used, as before.
   */
  draftScope?: string
  /**
   * Whether the composer may take focus on its own -- on mount, on a thread
   * change, when a reply finishes. A split pane the user is not working in
   * must not pull focus away from the one they are.
   */
  takeFocus?: boolean
  /**
   * Which surface's `/` commands this composer offers (default Home). Plugin
   * commands and skills are filtered by that surface's enablement toggle.
   */
  slashSurface?: SlashSurface
  /** Cowork's folder: its project commands and skills join the global ones. */
  slashProject?: string | null
  /** Surface built-ins; Home gets `/new` by default. `/help` is always there. */
  slashBuiltins?: SlashBuiltin[]
}
