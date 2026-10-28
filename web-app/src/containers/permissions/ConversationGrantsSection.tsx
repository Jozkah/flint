import { useCallback, useMemo } from 'react'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useToolApproval } from '@/hooks/useToolApproval'
import { useThreads } from '@/hooks/useThreads'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { similarToolCallLabel } from '@/lib/similarToolCall'
import { ROW, EMPTY, REVOKE } from '@/containers/permissions/shared'

export function ConversationGrantsSection() {
  const { t } = useTranslation()
  const approvedTools = useToolApproval((s) => s.approvedTools)
  const approvedMcpTools = useToolApproval((s) => s.approvedMcpTools)
  const revokeToolForThread = useToolApproval((s) => s.revokeToolForThread)
  const revokeMcpToolForThread = useToolApproval(
    (s) => s.revokeMcpToolForThread
  )
  const threads = useThreads((s) => s.threads)
  const coworkSessions = useCoworkSessions((s) => s.sessions)

  const conversationTitle = useCallback(
    (id: string) =>
      threads[id]?.title ||
      coworkSessions.find((session) => session.id === id)?.title ||
      t('permissions:settings.untitledConversation', { id: id.slice(0, 8) }),
    [threads, coworkSessions, t]
  )

  const conversations = useMemo(() => {
    const ids = [
      ...Object.keys(approvedTools),
      ...Object.keys(approvedMcpTools ?? {}),
    ].filter((id, index, all) => all.indexOf(id) === index)
    return ids
      .map((id) => ({
        id,
        tools: approvedTools[id] ?? [],
        mcpTools: approvedMcpTools?.[id] ?? [],
      }))
      .filter((row) => row.tools.length > 0 || row.mcpTools.length > 0)
  }, [approvedTools, approvedMcpTools])

  return (
    <Card
      anchor="settings-permissions-conversations"
      title={t('permissions:settings.conversations')}
      description={t('permissions:settings.conversationsDesc')}
      aside={
        <span className="tabular-nums">
          {conversations.reduce(
            (n, row) => n + row.tools.length + row.mcpTools.length,
            0
          )}
        </span>
      }
    >
      {conversations.length === 0 ? (
        <p className={EMPTY}>
          {t('permissions:settings.noConversationGrants')}
        </p>
      ) : (
        // Bounded: dozens of per-conversation grants scroll inside the
        // card instead of stretching the whole page.
        <ul
          data-testid="permissions-conversation-list"
          className="flex max-h-[26rem] flex-col divide-y divide-border overflow-y-auto pr-1 [scrollbar-width:thin]"
        >
          {conversations.map(({ id: threadId, tools, mcpTools }) => (
            <li key={threadId} className="py-1.5">
              <p className="truncate pt-1 text-[length:calc(var(--ui-font-base)*0.6875)] font-medium tracking-[.025em] text-subtle-foreground uppercase">
                {conversationTitle(threadId)}
              </p>
              <ul className="flex flex-col">
                {tools.map((tool) => (
                  <li key={tool} className={ROW}>
                    <span className="min-w-0 break-all text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                      {similarToolCallLabel(tool) ?? t('permissions:settings.toolLabel', { tool })}
                    </span>
                    <Button
                      variant="destructive"
                      className={REVOKE}
                      aria-label={t('permissions:settings.revokeLabel', {
                        name: `${tool} (${conversationTitle(threadId)})`,
                      })}
                      onClick={() => revokeToolForThread(threadId, tool)}
                    >
                      {t('permissions:settings.revoke')}
                    </Button>
                  </li>
                ))}
                {mcpTools.map((grant) => (
                  <li
                    key={`${grant.server}::${grant.tool}`}
                    className={ROW}
                  >
                    <span className="min-w-0 break-all text-[length:calc(var(--ui-font-base)*0.8125)] font-medium text-foreground">
                      {t('permissions:settings.mcpToolLabel', {
                        server: grant.server,
                        tool: grant.tool,
                      })}
                    </span>
                    <Button
                      variant="destructive"
                      className={REVOKE}
                      aria-label={t('permissions:settings.revokeLabel', {
                        name: `${grant.server} ${grant.tool} (${conversationTitle(threadId)})`,
                      })}
                      onClick={() =>
                        revokeMcpToolForThread(
                          threadId,
                          grant.server,
                          grant.tool
                        )
                      }
                    >
                      {t('permissions:settings.revoke')}
                    </Button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
