// The remote-access wire protocol: events, socket messages and pairing. Re-exported by protocol.ts.
// Kept free of app imports so the phone bundle can use it as is.

import type {
  SessionKind,
  RemoteToolStep,
  RemotePrompt,
  StudioJobWire,
  PushNotice,
} from './protocolTypes'

// ---------------------------------------------------------------------------
// Events (desktop -> phone)
// ---------------------------------------------------------------------------

export type RemoteEvent =
  | { type: 'approval.requested'; requestId: string; toolName: string; threadId: string; kind?: SessionKind }
  | { type: 'approval.resolved'; requestId: string }
  | { type: 'ask.requested'; requestId: string; threadId: string; question: string }
  | { type: 'ask.resolved'; requestId: string }
  | { type: 'prompt.requested'; id: string; kind: RemotePrompt['kind']; title: string; threadId?: string }
  | { type: 'prompt.resolved'; id: string }
  | { type: 'run.started'; kind: SessionKind; id: string }
  | { type: 'run.finished'; kind: SessionKind; id: string }
  | { type: 'notification'; title: string; body: string }
  /** Not sent to sockets: the server turns it into Web Push for phones that
   * are not looking (src-tauri/src/core/remote/push.rs). */
  | ({ type: 'push.notify' } & PushNotice)
  /** Reply text (and reasoning) appended at `offset` of what was sent so far
   * for `messageId`. A phone that sees a gap asks `stream.get`. */
  | {
      type: 'stream.delta'
      kind: SessionKind
      id: string
      messageId: string
      offset: number
      text: string
      reasoningOffset?: number
      reasoning?: string
      author?: string
    }
  /** A tool step began or changed. */
  | { type: 'stream.tool'; kind: SessionKind; id: string; messageId: string; step: RemoteToolStep }
  /** A tool step shown earlier for `messageId` is gone (the turn was rewritten).
   * Added later: phones that do not know it ignore it and catch up on
   * `stream.done` / `stream.get`. */
  | { type: 'stream.toolRemoved'; kind: SessionKind; id: string; messageId: string; stepId: string }
  /** The reply is complete (or stopped); read `thread.messages` for it. */
  | { type: 'stream.done'; kind: SessionKind; id: string; messageId: string }
  /** Messages, queue or details of a conversation changed. */
  | { type: 'thread.updated'; kind: SessionKind; id: string }
  /** Studio's job moved on (progress), throttled to a few a second. */
  | { type: 'studio.progress'; job: StudioJobWire | null }
  /** Studio's models, gallery or activity changed; read `studio.status`. */
  | { type: 'studio.updated' }

/** Conversation-scoped events go to sockets subscribed to this topic. */
export const threadTopic = (id: string) => `thread:${id}`

/** One WebSocket message from the server. */
export type RemoteSocketMessage =
  | { type: 'ready'; deviceId: string }
  | { type: 'event'; topic: string | null; event: RemoteEvent }
  | { type: 'lagged'; missed: number }
  | { type: 'pong' }

/** One WebSocket message to the server. */
export type RemoteClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; topics: string[] }
  | { type: 'unsubscribe'; topics: string[] }
  | { type: 'ping' }
  /** The page was hidden or shown; a hidden page gets Web Push instead. */
  | { type: 'visibility'; hidden: boolean }

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export type PairRequest = { code: string; deviceName: string }
export type PairResponse = { status: 'pending'; pollId: string; confirmNumber: string }
export type PairStatus =
  | { status: 'pending' }
  | { status: 'approved'; token: string; deviceId: string }
  | { status: 'rejected' }
  | { status: 'expired' }
