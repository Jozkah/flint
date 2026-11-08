// The answer handlers a phone calls: approvals, asks and prompts.

import { RemoteRpcError, type RemoteHandlers } from './bridge'
import { checkAskAnswers } from './asks'
import { offers } from './prompts'
import type { AskAnswer } from '@/types/coworkSession'
import type { ApprovalRespondParams, AskRespondParams, PromptRespondParams } from './protocol'
import type { ActionContext } from './actionTypes'
import { isRecord, str, WIRE_DECISION } from './actionParams'

/** Answers: approvals, asks and prompts. */
export function approvalHandlers(ctx: ActionContext): Pick<RemoteHandlers, 'approvals.respond' | 'asks.respond' | 'approvals.prompt'> {
  const { a } = ctx
  return {
    'approvals.respond': async (params) => {
      const p = (isRecord(params) ? params : {}) as Partial<ApprovalRespondParams>
      const requestId = str(p.requestId)
      if (!requestId || (p.decision !== 'allow' && p.decision !== 'deny')) {
        throw new RemoteRpcError('bad_params', 'requestId and decision are required')
      }
      const scope = p.scope ?? 'once'
      if (!(scope in WIRE_DECISION)) throw new RemoteRpcError('bad_params', 'Unknown scope')
      // The server already refused these; the window checks again, since it
      // is the one that records the grant.
      const perms = await a.permissions()
      if (!perms?.approvals) {
        throw new RemoteRpcError('forbidden', 'Approvals from phones are turned off on the computer')
      }
      if (p.decision === 'allow' && scope === 'always' && !perms?.alwaysAllow) {
        throw new RemoteRpcError('forbidden', '"Always allow" from phones is turned off on the computer')
      }
      const pending = a.findApproval(requestId)
      if (!pending) return { status: 'gone' }
      if (p.decision === 'allow' && !pending.scopes.includes(scope)) {
        throw new RemoteRpcError('bad_params', 'That permission is not offered for this request')
      }
      a.resolveApproval(
        pending.toolCallId,
        requestId,
        p.decision === 'deny' ? 'deny' : WIRE_DECISION[scope]
      )
      return { status: 'answered' }
    },
    'asks.respond': (params) => {
      const p = (isRecord(params) ? params : {}) as Partial<AskRespondParams>
      const requestId = str(p.requestId)
      const threadId = str(p.threadId)
      if (!requestId || !threadId) throw new RemoteRpcError('bad_params', 'requestId and threadId are required')
      if (!a.findAsk || !a.answerAsk) {
        throw new RemoteRpcError('not_implemented', 'Answering questions is not available from phones yet')
      }
      const ask = a.findAsk(threadId, requestId)
      if (!ask) return { status: 'gone' }
      let answers: AskAnswer[] | null = null
      if (p.answers !== null && p.answers !== undefined) {
        const checked = checkAskAnswers(ask, p.answers)
        if (typeof checked === 'string') throw new RemoteRpcError('bad_params', checked)
        answers = checked
      }
      return { status: a.answerAsk(threadId, requestId, answers) ? 'answered' : 'gone' }
    },
    'approvals.prompt': async (params) => {
      const p = (isRecord(params) ? params : {}) as Partial<PromptRespondParams>
      const id = str(p.id)
      if (!id || typeof p.action !== 'string') throw new RemoteRpcError('bad_params', 'id and action are required')
      if (!a.findPrompt || !a.respondPrompt) {
        throw new RemoteRpcError('not_implemented', 'Answering this is not available from phones yet')
      }
      // The server already refused it when approvals from phones are off; the
      // window checks again, since it is the one that acts.
      const perms = await a.permissions()
      if (!perms?.approvals) {
        throw new RemoteRpcError('forbidden', 'Approvals from phones are turned off on the computer')
      }
      const prompt = a.findPrompt(id)
      if (!prompt) return { status: 'gone' }
      if (!offers(prompt, p.action)) throw new RemoteRpcError('bad_params', 'That answer is not offered for this prompt')
      return { status: a.respondPrompt(id, p.action) ? 'answered' : 'gone' }
    },
  }
}
