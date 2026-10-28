/**
 * janhq/jan#9438: when mlx-server dies mid-request (a Metal out-of-memory on a
 * long prompt, say), the chat saw only a bare network error. The MLX plugin
 * knows why the process ended: `is_mlx_process_running` answers a crashed
 * server's pid with its crash as a structured engine error, which
 * `describeEngineError` turns into a readable message.
 */

import { describeEngineError } from '@/lib/engineError'

type Invoke =(cmd: string, args: Record<string, unknown>) => Promise<unknown>

/** The server's crash as an Error, or `fallback` when it is still running. */
export async function mlxCrashOr(
  invoke: Invoke,
  pid: number,
  fallback: unknown
): Promise<unknown> {
  try {
    // The socket can close a moment before the process is gone: ask twice.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((res) => setTimeout(res, 300))
      if ((await invoke('plugin:mlx|is_mlx_process_running', { pid })) !== true)
        break
    }
    return fallback
  } catch (report) {
    // Readable and localized for the chat; the structured error stays
    // reachable through `cause` for `parseEngineError`.
    const err = new Error(describeEngineError(report)) as Error & {
      cause?: unknown
    }
    err.cause = report
    return err
  }
}

/**
 * Wraps a fetch so a failure against a dead MLX server, on the request or
 * while reading the streamed body, is replaced by why the server died.
 */
export function withMlxCrashReport(
  fetchImpl: typeof globalThis.fetch,
  invoke: Invoke,
  pid: number
): typeof globalThis.fetch {
  return async (input, init) => {
    const aborted = () => init?.signal?.aborted === true
    let response: Response
    try {
      response = await fetchImpl(input, init)
    } catch (error) {
      if (aborted()) throw error
      throw await mlxCrashOr(invoke, pid, error)
    }
    const body = response.body
    if (!body) return response

    const reader = body.getReader()
    const guarded = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read()
          if (done) controller.close()
          else controller.enqueue(value)
        } catch (error) {
          controller.error(
            aborted() ? error : await mlxCrashOr(invoke, pid, error)
          )
        }
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    })
    return new Response(guarded, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
