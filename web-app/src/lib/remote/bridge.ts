// The window's side of remote access: a phone's RPC arrives as a
// `remote://rpc` event, is dispatched to a typed handler, and the answer goes
// back through `remote_rpc_respond`. The Rust server has already checked the
// device's token and the approval settings; handlers only read and act on the
// app's own stores and services.

import type {
  RemoteError,
  RemoteMethod,
  RemoteMethods,
  RemoteRpcRequest,
} from './protocol'

export class RemoteRpcError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export type RemoteHandlerContext = { device: RemoteRpcRequest['device'] }

export type RemoteHandler<M extends RemoteMethod> = (
  params: RemoteMethods[M]['params'],
  ctx: RemoteHandlerContext
) => Promise<RemoteMethods[M]['result']> | RemoteMethods[M]['result']

/** `push.*` is answered by the server itself and never reaches the window. */
export type ServerMethod = Extract<RemoteMethod, `push.${string}`>
export type RemoteHandlers = { [M in Exclude<RemoteMethod, ServerMethod>]: RemoteHandler<M> }

export type RemoteReply = { result: unknown } | { error: RemoteError }

const notImplemented = (method: string) => () => {
  throw new RemoteRpcError(
    'not_implemented',
    `${method} is not available from phones yet`
  )
}

/** Methods reserved for later phases, answered with a clear error. */
export const PLANNED_METHODS = [
  'chat.send',
  'cowork.send',
  'run.stop',
  'room.send',
  'room.control',
  'room.create',
  'room.update',
  'room.delete',
  'settings.set',
  'approvals.respond',
] as const satisfies readonly RemoteMethod[]

export const plannedHandlers = Object.fromEntries(
  PLANNED_METHODS.map((m) => [m, notImplemented(m)])
) as unknown as Pick<RemoteHandlers, (typeof PLANNED_METHODS)[number]>

/** Runs one request against `handlers`. Never throws: every failure becomes
 * an `error` reply, so the phone always gets an answer. */
export async function dispatchRemoteRpc(
  req: RemoteRpcRequest,
  handlers: RemoteHandlers
): Promise<RemoteReply> {
  if (!Object.prototype.hasOwnProperty.call(handlers, req.method)) {
    return {
      error: { code: 'unknown_method', message: `Unknown method ${req.method}` },
    }
  }
  const handler = handlers[req.method as keyof RemoteHandlers] as (
    params: unknown,
    ctx: RemoteHandlerContext
  ) => unknown
  try {
    const result = await handler(req.params ?? {}, { device: req.device })
    return { result: result ?? null }
  } catch (e) {
    if (e instanceof RemoteRpcError) {
      return { error: { code: e.code, message: e.message } }
    }
    // Internal details stay on the desktop; the phone gets a generic line.
    console.error(`remote: ${req.method} failed`, e)
    return { error: { code: 'internal', message: 'Flint could not do that' } }
  }
}
