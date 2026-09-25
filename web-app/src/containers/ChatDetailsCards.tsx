/**
 * The cards of a chat's Details column that sit around "What Flint is using":
 * how full the context is and when it compacts, what this conversation
 * changed on disk, which tools are available, and what happened, most recent
 * first. Everything here is read from the conversation's own messages and the
 * stores the rest of the app already keeps; nothing is estimated.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { Frame, FrameBody, FrameHeader } from '@/components/ui/frame'
import { Icon, type IconName } from '@/components/ui/icon'
import { Switch } from '@/components/ui/switch'
import { diffStat } from '@/components/ChangeDiff'
import { useAppState } from '@/hooks/useAppState'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  DEFAULT_COMPACTION_POLICY,
  effectiveReserve,
  getCompactionPolicy,
  setCompactionPolicy,
  type CompactionPolicy,
} from '@/lib/compactionPolicy'
import { parseBashOutput } from '@/lib/toolPresentation'
import { cn } from '@/lib/utils'
import { formatMessageTime } from '@/utils/formatMessageTime'

type ToolPart = {
  type: string
  toolCallId?: string
  state?: string
  input?: unknown
  output?: unknown
}

const isToolPart = (part: { type: string }): part is ToolPart =>
  part.type.startsWith('tool-')

const toolNameOf = (part: ToolPart) => part.type.slice('tool-'.length)

const arg = (input: unknown, key: string): string => {
  const value = (input as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'string' ? value : ''
}

const baseName = (path: string) => path.split(/[\\/]/).pop() || path

const EDIT_TOOLS = new Set(['edit', 'write', 'edit_file', 'write_file'])
const READ_TOOLS = new Set(['read', 'read_file'])
const SEARCH_TOOLS = new Set(['grep', 'find', 'ls', 'glob'])

/* ------------------------------------------------------------------ */

/**
 * "Auto-compact at 92%", from the one compaction policy and this window's
 * size, with the switch that turns it off. Only the desktop can change the
 * policy; elsewhere the row states the default and the switch is disabled.
 */
export function AutoCompactRow({ maxTokens }: { maxTokens?: number }) {
  const { t } = useTranslation()
  const [policy, setPolicy] = useState<CompactionPolicy>(
    DEFAULT_COMPACTION_POLICY
  )
  const [saving, setSaving] = useState(false)
  const [editable, setEditable] = useState(false)

  useEffect(() => {
    let alive = true
    getCompactionPolicy()
      .then((p) => {
        if (!alive) return
        setPolicy(p)
        setEditable(
          typeof window !== 'undefined' &&
            Boolean(
              (window as unknown as { __TAURI_INTERNALS__?: unknown })
                .__TAURI_INTERNALS__
            )
        )
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const percent =
    maxTokens && maxTokens > 0
      ? Math.round(
          ((maxTokens - effectiveReserve(maxTokens, policy)) / maxTokens) * 100
        )
      : undefined

  const toggle = async (auto: boolean) => {
    setSaving(true)
    try {
      setPolicy(await setCompactionPolicy({ auto }))
    } catch {
      // Refused by the backend: the switch stays where the policy is.
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>
        {!policy.auto
          ? t('context:cards.autoCompactOff')
          : percent !== undefined
            ? t('context:cards.autoCompactAt', { percent })
            : t('context:cards.autoCompact')}
      </span>
      <Switch
        checked={policy.auto}
        disabled={!editable || saving}
        onCheckedChange={(v) => void toggle(v)}
        aria-label={t('context:cards.autoCompact')}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */

type FileChange = {
  path: string
  created: boolean
  add?: number
  del?: number
}

/** Files this conversation's edit and write calls changed, in order. */
function useFileChanges(messages: UIMessage[]): FileChange[] {
  const diffs = useToolCallRuntime((s) => s.diffs)
  return useMemo(() => {
    const byPath = new Map<string, FileChange>()
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (const raw of message.parts ?? []) {
        if (!isToolPart(raw)) continue
        const part = raw as ToolPart
        if (!EDIT_TOOLS.has(toolNameOf(part))) continue
        if (part.state !== 'output-available') continue
        const path = arg(part.input, 'path') || arg(part.input, 'file_path')
        if (!path) continue
        const diff = part.toolCallId ? diffs[part.toolCallId] : undefined
        const prev = byPath.get(path)
        const next: FileChange = prev ?? {
          path,
          created: Boolean(diff?.startsWith('@@ created file @@')),
        }
        if (diff) {
          const { add, del } = diffStat(diff)
          next.add = (next.add ?? 0) + add
          next.del = (next.del ?? 0) + del
        }
        byPath.set(path, next)
      }
    }
    return [...byPath.values()]
  }, [messages, diffs])
}

const Stat = ({ add, del }: { add?: number; del?: number }) =>
  add === undefined ? null : (
    <span className="inline-flex shrink-0 gap-1.5 font-mono text-[11.5px] font-medium tabular-nums">
      <span className="text-success">+{add}</span>
      <span className="text-destructive">−{del ?? 0}</span>
    </span>
  )

/** What the conversation changed on disk. Nothing shows until it has. */
export function ChatChangesFrame({
  messages,
  className,
}: {
  messages: UIMessage[]
  className?: string
}) {
  const { t } = useTranslation()
  const changes = useFileChanges(messages)
  if (changes.length === 0) return null
  const known = changes.filter((c) => c.add !== undefined)
  const total = known.reduce(
    (acc, c) => ({ add: acc.add + (c.add ?? 0), del: acc.del + (c.del ?? 0) }),
    { add: 0, del: 0 }
  )
  return (
    <Frame className={className} data-testid="chat-changes">
      <FrameHeader
        icon={<Icon name="x-edit" />}
        title={t('context:cards.changes')}
        actions={
          known.length > 0 ? <Stat add={total.add} del={total.del} /> : undefined
        }
      />
      <FrameBody className="px-4 py-2">
        <ul className="flex flex-col">
          {changes.map((change) => (
            <li
              key={change.path}
              title={change.path}
              className="flex min-h-9 items-center gap-2.5 border-b border-dashed border-border py-1.5 text-xs last:border-b-0"
            >
              <Icon
                name={change.created ? 'x-plus' : 'sb-file'}
                size={14}
                label={change.created ? t('context:cards.newFile') : undefined}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-fg-2">
                {change.path}
              </span>
              <Stat add={change.add} del={change.del} />
            </li>
          ))}
        </ul>
        {known.length < changes.length && (
          <p className="pt-1 pb-1 text-[11px] text-subtle-foreground">
            {t('context:cards.changesSession')}
          </p>
        )}
      </FrameBody>
    </Frame>
  )
}

/* ------------------------------------------------------------------ */

const SERVER_ICON: Record<string, IconName> = {
  filesystem: 'x-folder',
  github: 'x-code',
  playwright: 'x-monitor',
  browser: 'x-monitor',
}

/**
 * The MCP servers whose tools are on offer, each with how many are enabled
 * and one switch for the lot. Availability is global, which the card says.
 */
export function ChatToolsFrame({ className }: { className?: string }) {
  const { t } = useTranslation()
  const allTools = useAppState((s) => s.tools)
  const disabled = useToolAvailable((s) => s.disabledTools)
  const setToolDisabled = useToolAvailable((s) => s.setToolDisabled)

  const servers = useMemo(() => {
    const groups = new Map<string, { name: string; description: string }[]>()
    for (const tool of allTools) {
      if (tool.server === 'Jan Browser MCP') continue
      const list = groups.get(tool.server) ?? []
      list.push(tool)
      groups.set(tool.server, list)
    }
    return [...groups.entries()]
  }, [allTools])

  if (servers.length === 0) return null

  return (
    <Frame className={className} data-testid="chat-tools">
      <FrameHeader icon={<Icon name="flow" />} title={t('context:cards.tools')} />
      <FrameBody className="px-4 py-1">
        <ul className="flex flex-col">
          {servers.map(([server, tools]) => {
            const enabled = tools.filter(
              (tool) => !disabled.includes(`${server}::${tool.name}`)
            ).length
            return (
              <li
                key={server}
                className="group/tr flex items-center gap-3 border-b border-dashed border-border py-3 last:border-b-0"
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg border-[0.8px] border-input bg-card transition-[transform,box-shadow] duration-200 ease-expo group-hover/tr:-translate-y-px group-hover/tr:shadow-lift">
                  <Icon name={SERVER_ICON[server] ?? 'x-puzzle'} size={16} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <b className="truncate font-mono text-[12.5px] font-medium text-foreground">
                    {server}
                  </b>
                  <small className="text-xs text-muted-foreground">
                    {t('context:cards.toolsEnabled', {
                      count: enabled,
                      total: tools.length,
                    })}
                  </small>
                </div>
                <Switch
                  checked={enabled > 0}
                  aria-label={server}
                  onCheckedChange={(on) => {
                    for (const tool of tools) setToolDisabled(server, tool.name, on)
                  }}
                />
              </li>
            )
          })}
        </ul>
        <p className="pb-2 text-[11px] text-subtle-foreground">
          {t('context:cards.toolsHint')}
        </p>
      </FrameBody>
    </Frame>
  )
}

/* ------------------------------------------------------------------ */

type ActivityEntry = {
  key: string
  icon: IconName
  title: string
  detail: ReactNode
  at?: number
}

const createdAtOf = (message: UIMessage): number | undefined => {
  const value = (message.metadata as { createdAt?: Date | string | number } | undefined)
    ?.createdAt
  if (value === undefined) return undefined
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * What happened in the conversation, newest first: the commands it ran, the
 * files it read and edited, the searches, and when it began.
 */
export function ChatActivityFrame({
  messages,
  modelId,
  className,
}: {
  messages: UIMessage[]
  modelId?: string
  className?: string
}) {
  const { t } = useTranslation()
  const timings = useToolCallRuntime((s) => s.timings)
  const diffs = useToolCallRuntime((s) => s.diffs)

  const entries = useMemo(() => {
    const list: ActivityEntry[] = []
    const first = messages[0]
    if (first) {
      list.push({
        key: 'start',
        icon: 'feed-user',
        title: t('context:cards.chatStarted'),
        detail: modelId ?? '',
        at: createdAtOf(first),
      })
    }
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const fallbackAt = createdAtOf(message)
      for (const raw of message.parts ?? []) {
        if (!isToolPart(raw)) continue
        const part = raw as ToolPart
        if (part.state !== 'output-available' && part.state !== 'output-error')
          continue
        const name = toolNameOf(part)
        const at =
          (part.toolCallId ? timings[part.toolCallId]?.endedAt : undefined) ??
          fallbackAt
        const key = part.toolCallId ?? `${message.id}-${list.length}`
        if (READ_TOOLS.has(name)) {
          const path = baseName(arg(part.input, 'path'))
          const prev = list[list.length - 1]
          // Consecutive reads are one step: "Read 5 files".
          if (prev?.icon === 'feed-book') {
            const names = [...(prev.detail as string).split(', ').filter(Boolean), path]
            prev.title = t('context:cards.readFiles', { count: names.length })
            prev.detail = names.join(', ')
            prev.at = at ?? prev.at
            continue
          }
          list.push({ key, icon: 'feed-book', title: t('context:cards.readFile'), detail: path, at })
          continue
        }
        if (EDIT_TOOLS.has(name)) {
          const path = baseName(arg(part.input, 'path') || arg(part.input, 'file_path'))
          const diff = part.toolCallId ? diffs[part.toolCallId] : undefined
          const stat = diff ? diffStat(diff) : undefined
          list.push({
            key,
            icon: 'feed-repeat',
            title: t('context:cards.editedFile'),
            detail: stat ? `${path} +${stat.add} −${stat.del}` : path,
            at,
          })
          continue
        }
        if (name === 'bash') {
          const result = part.output ? parseBashOutput(part.output) : undefined
          const failed =
            part.state === 'output-error' ||
            (result?.exit ?? 0) !== 0 ||
            Boolean(result?.signaled)
          const command = arg(part.input, 'command')
          const passed = result?.text.match(/\b(\d+) passed\b/)?.[0]
          list.push({
            key,
            icon: failed ? 'feed-alert' : 'feed-ticket',
            title: failed
              ? t('context:cards.commandFailed')
              : t('context:cards.ranCommand', { tool: name }),
            detail: [
              failed && result?.exit !== undefined ? `exit ${result.exit}` : '',
              command,
              !failed && passed ? passed : '',
            ]
              .filter(Boolean)
              .join(' · '),
            at,
          })
          continue
        }
        if (SEARCH_TOOLS.has(name) || name.startsWith('web_')) {
          list.push({
            key,
            icon: 'feed-star',
            title: name.startsWith('web_')
              ? t('context:cards.searchedWeb')
              : t('context:cards.searched'),
            detail:
              arg(part.input, 'query') ||
              arg(part.input, 'pattern') ||
              arg(part.input, 'url') ||
              arg(part.input, 'path'),
            at,
          })
          continue
        }
        list.push({
          key,
          icon: 'feed-ticket',
          title: t('context:cards.usedTool', { tool: name }),
          detail: '',
          at,
        })
      }
    }
    return list.reverse().slice(0, 6)
  }, [messages, timings, diffs, modelId, t])

  if (entries.length <= 1) return null

  return (
    <Frame className={className} data-testid="chat-activity">
      <FrameHeader icon={<Icon name="x-activity" />} title={t('context:cards.activity')} />
      <FrameBody className="px-4 py-4">
        <ul className="relative m-0 flex list-none flex-col gap-4 p-0">
          {entries.map((entry, i) => (
            <li key={entry.key} className="group/item relative flex gap-3">
              <span className="relative z-10 flex shrink-0 items-center rounded-lg border-[0.8px] border-input bg-card p-2 transition-[transform,box-shadow] duration-200 ease-expo group-hover/item:-translate-y-px group-hover/item:shadow-lift">
                <Icon
                  name={entry.icon}
                  size={16}
                  className="transition-transform duration-300 group-hover/item:scale-110"
                />
              </span>
              {i < entries.length - 1 && (
                <span
                  aria-hidden
                  className="absolute top-8 -bottom-4 left-[15.5px] w-px bg-[repeating-linear-gradient(to_bottom,var(--border)_0_4px,transparent_4px_8px)]"
                />
              )}
              <div className="flex min-w-0 flex-1 flex-col justify-center gap-2.5 pt-0.5 text-xs tracking-[-0.12px]">
                <div className="flex w-full items-center justify-between gap-2 leading-none">
                  <p className="m-0 truncate font-medium text-foreground">
                    {entry.title}
                  </p>
                  {entry.at !== undefined && (
                    <time
                      className={cn('shrink-0 text-muted-foreground tabular-nums')}
                      dateTime={new Date(entry.at).toISOString()}
                    >
                      {formatMessageTime(entry.at)}
                    </time>
                  )}
                </div>
                {entry.detail && (
                  <p className="m-0 truncate leading-none text-subtle-foreground" title={String(entry.detail)}>
                    {entry.detail}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </FrameBody>
    </Frame>
  )
}
