import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Trash2, Plus, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  paramsSettings,
  paramGroups,
  paramCategories,
  evaluateDisabled,
  isGroupedParamKey,
  type ParamDef,
  type ParamGroup,
} from '@/lib/predefinedParams'
import {
  paramsForProviders,
  resolveProviderCaps,
  isModelLevelRejected,
} from '@/lib/providerCaps'
import { DynamicControllerSetting } from '@/containers/dynamicControllerSetting'

export interface ParametersSectionProps {
  params: Record<string, unknown>
  providers: Array<Pick<ProviderObject, 'provider'>>
  onToggle: (def: ParamDef) => void
  onChange: (key: string, value: unknown) => void
  onRemove: (key: string) => void
  /** Bulk add (used when adding a coupled group). */
  onAddMany?: (values: Record<string, unknown>) => void
  /** Bulk remove (used when removing a coupled group). */
  onRemoveMany?: (keys: string[]) => void
  /** When set, params model-rejected by (providerId, modelId) are flagged
   *  in active rows and hidden from the add menu. Pass from the composer
   *  where the selected model is known; omit in the assistant editor. */
  providerId?: string
  modelId?: string
}

export function ParametersSection({
  params,
  providers,
  onToggle,
  onChange,
  onRemove,
  onAddMany,
  onRemoveMany,
  providerId,
  modelId,
}: ParametersSectionProps) {
  const modelRejects = (key: string) =>
    !!(providerId && modelId && isModelLevelRejected(key, providerId, modelId))
  const supportIndex = useMemo(() => {
    const idx: Record<
      string,
      { supportedBy: string[]; maybeBy: string[]; known: boolean }
    > = {}
    for (const def of Object.values(paramsSettings)) {
      idx[def.key] = { supportedBy: [], maybeBy: [], known: false }
    }
    for (const entry of paramsForProviders(providers)) {
      idx[entry.def.key] = {
        supportedBy: entry.supportedBy,
        maybeBy: entry.maybeBy,
        known: true,
      }
    }
    return idx
  }, [providers])

  const activeKeys = Object.keys(params)
  const activeGroups = paramGroups.filter((g) =>
    g.members.some((k) => k in params)
  )
  const activeStandaloneKeys = activeKeys
    .filter((k) => k in paramsSettings && !isGroupedParamKey(k))
    .sort((a, b) => canonicalOrder(a) - canonicalOrder(b))
  const unknownKeys = activeKeys.filter((k) => !(k in paramsSettings))

  const addStandalone = (def: ParamDef) => onToggle(def)
  const addGroup = (group: ParamGroup) => {
    if (onAddMany) {
      const defaults: Record<string, unknown> = {}
      for (const memberKey of group.members) {
        const def = paramsSettings[memberKey]
        if (!def) continue
        defaults[memberKey] =
          memberKey === group.triggerKey ? group.triggerValue : def.value
      }
      onAddMany(defaults)
    } else {
      for (const memberKey of group.members) {
        const def = paramsSettings[memberKey]
        if (!def) continue
        if (memberKey in params) continue
        onChange(
          memberKey,
          memberKey === group.triggerKey ? group.triggerValue : def.value
        )
      }
    }
  }
  const removeGroup = (group: ParamGroup) => {
    const keys = group.members.filter((k) => k in params)
    if (onRemoveMany) onRemoveMany(keys)
    else keys.forEach(onRemove)
  }

  const hasAny = activeGroups.length + activeStandaloneKeys.length > 0

  return (
    <div className="space-y-3">
      {!hasAny && (
        <div className="text-xs text-muted-foreground py-2">
          No overrides — using model defaults.
        </div>
      )}

      {activeStandaloneKeys.map((key) => (
        <StandaloneRow
          key={key}
          paramKey={key}
          params={params}
          support={supportIndex[key]}
          modelRejected={modelRejects(key)}
          onChange={onChange}
          onRemove={onRemove}
        />
      ))}

      {activeGroups.map((group) => (
        <GroupBlock
          key={group.id}
          group={group}
          params={params}
          onChange={onChange}
          onRemoveGroup={() => removeGroup(group)}
        />
      ))}

      {unknownKeys.length > 0 && (
        <div className="text-xs text-muted-foreground">
          {unknownKeys.length} unrecognized parameter
          {unknownKeys.length === 1 ? '' : 's'} hidden:{' '}
          {unknownKeys.join(', ')}
        </div>
      )}

      <AddParameterMenu
        params={params}
        providers={providers}
        onAddStandalone={addStandalone}
        onAddGroup={addGroup}
        modelRejects={modelRejects}
      />
    </div>
  )
}

interface StandaloneRowProps {
  paramKey: string
  params: Record<string, unknown>
  support?: { supportedBy: string[]; maybeBy: string[]; known: boolean }
  modelRejected?: boolean
  onChange: (key: string, value: unknown) => void
  onRemove: (key: string) => void
}

function StandaloneRow({
  paramKey,
  params,
  support,
  modelRejected,
  onChange,
  onRemove,
}: StandaloneRowProps) {
  const def = paramsSettings[paramKey]
  if (!def) return null
  const disabledReason = evaluateDisabled(def, params)
  const value = params[paramKey] ?? def.value
  const capUnsupported =
    support && def.capability !== 'core' && def.capability !== 'client_only' && !support.known
  const unsupported = modelRejected || capUnsupported
  const maybeOnly =
    !modelRejected &&
    support &&
    support.known &&
    support.supportedBy.length === 0 &&
    support.maybeBy.length > 0
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-center gap-1 min-w-0 flex-1 text-sm">
          <span className="truncate">{def.title}</span>
          {unsupported && (
            <TriangleAlert
              size={12}
              className="text-destructive shrink-0"
              aria-label="Not supported — will be stripped on send"
            />
          )}
          {!unsupported && maybeOnly && (
            <TriangleAlert
              size={12}
              className="text-amber-500 shrink-0"
              aria-label="May be ignored by this provider"
            />
          )}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onRemove(paramKey)}
          className="shrink-0 h-7 w-7"
          aria-label={`Remove ${def.title}`}
        >
          <Trash2 size={14} className="text-destructive" />
        </Button>
      </div>
      <DynamicControllerSetting
        controllerType={def.controllerType}
        controllerProps={{
          value: value as string | number | boolean,
          ...(def.controllerProps ?? {}),
        }}
        disabledReason={disabledReason ?? undefined}
        onChange={(v) => onChange(paramKey, v)}
      />
      {(unsupported || def.effectHint) && (
        <div
          className={
            unsupported
              ? 'text-xs text-destructive'
              : 'text-xs text-muted-foreground'
          }
        >
          {unsupported ? 'Not supported — will be skipped.' : def.effectHint}
        </div>
      )}
    </div>
  )
}

interface GroupBlockProps {
  group: ParamGroup
  params: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  onRemoveGroup: () => void
}

function GroupBlock({
  group,
  params,
  onChange,
  onRemoveGroup,
}: GroupBlockProps) {
  return (
    <div className="rounded-md border border-border/60 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{group.title}</div>
          <div className="text-xs text-muted-foreground">{group.description}</div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemoveGroup}
          aria-label={`Remove ${group.title}`}
        >
          <Trash2 size={16} className="text-destructive" />
        </Button>
      </div>
      <div className="space-y-2 pl-2 border-l border-border/40">
        {group.members
          .filter((k) => k in params)
          .map((memberKey) => {
            const def = paramsSettings[memberKey]
            if (!def) return null
            const disabledReason = evaluateDisabled(def, params)
            const value = params[memberKey] ?? def.value
            return (
              <div key={memberKey} className="space-y-1">
                <div className="text-xs text-muted-foreground">{def.title}</div>
                <DynamicControllerSetting
                  controllerType={def.controllerType}
                  controllerProps={{
                    value: value as string | number | boolean,
                    ...(def.controllerProps ?? {}),
                  }}
                  disabledReason={disabledReason ?? undefined}
                  onChange={(v) => onChange(memberKey, v)}
                />
              </div>
            )
          })}
      </div>
    </div>
  )
}

interface AddParameterMenuProps {
  params: Record<string, unknown>
  providers: Array<Pick<ProviderObject, 'provider'>>
  onAddStandalone: (def: ParamDef) => void
  onAddGroup: (group: ParamGroup) => void
  modelRejects: (key: string) => boolean
}

function AddParameterMenu({
  params,
  providers,
  onAddStandalone,
  onAddGroup,
  modelRejects,
}: AddParameterMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo<Array<{ cat: ParamCategory; entries: MenuEntry[] }>>(() => {
    return paramCategories
      .map((cat) => {
        const standalone: MenuEntry[] = cat.paramKeys
          .map((k) => paramsSettings[k])
          .filter((def): def is ParamDef => Boolean(def))
          .filter((def) => isCapabilitySupported(def, providers))
          .filter((def) => !modelRejects(def.key))
          .map((def) => ({
            kind: 'param' as const,
            def,
            active: def.key in params,
            support: providerSupportFor(def, providers),
          }))
        const groups: MenuEntry[] = cat.groupIds
          .map((id) => paramGroups.find((g) => g.id === id))
          .filter((g): g is ParamGroup => Boolean(g))
          .filter((g) => isGroupCapabilitySupported(g, providers))
          .map((g) => ({
            kind: 'group' as const,
            group: g,
            active: g.members.some((k) => k in params),
          }))
        const entries = [...standalone, ...groups]
        return { cat, entries }
      })
      .filter(({ entries }) => entries.length > 0)
  }, [params, providers, modelRejects])

  const filtered = useMemo(() => filterMenuItems(items, query), [items, query])
  // Only enabled rows take part in keyboard navigation.
  const selectable = useMemo(
    () => filtered.flatMap(({ entries }) => entries.filter((e) => !e.active)),
    [filtered]
  )

  useEffect(() => {
    setActiveIdx(0)
  }, [query])

  const current: MenuEntry | undefined =
    selectable[Math.min(activeIdx, selectable.length - 1)]
  const currentId = current ? entryId(current) : undefined

  useEffect(() => {
    if (!currentId) return
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-entry-id="${currentId}"]`
    )
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [currentId])

  if (items.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        {t('common:paramSearch.noneForProvider')}
      </div>
    )
  }

  const add = (entry: MenuEntry) => {
    if (entry.active) return
    if (entry.kind === 'param') onAddStandalone(entry.def)
    else onAddGroup(entry.group)
    setOpen(false)
    setQuery('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (selectable.length) setActiveIdx((i) => (i + 1) % selectable.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (selectable.length)
        setActiveIdx((i) => (i - 1 + selectable.length) % selectable.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (current) add(current)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-start">
          <Plus size={14} className="mr-1" />
          {t('common:paramSearch.addParameter')}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 p-0 flex flex-col max-h-[60vh]"
        onEscapeKeyDown={(e) => {
          // The first Esc clears the query; the next one closes the menu.
          if (query) {
            e.preventDefault()
            setQuery('')
          }
        }}
      >
        <div className="p-2 border-b">
          <Input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="add-param-list"
            aria-activedescendant={currentId ? `add-param-${currentId}` : undefined}
            aria-label={t('common:paramSearch.placeholder')}
            placeholder={t('common:paramSearch.placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            className="h-8 text-sm"
          />
        </div>
        <div
          ref={listRef}
          id="add-param-list"
          role="listbox"
          className="overflow-y-auto p-1"
        >
          {filtered.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground text-center">
              {t('common:paramSearch.noMatches')}
            </div>
          )}
          {filtered.map(({ cat, entries }, catIdx) => (
            <div key={cat.id} role="group" aria-label={cat.title}>
              {catIdx > 0 && <div className="-mx-1 my-1 h-px bg-border" />}
              <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                {cat.title}
              </div>
              {entries.map((entry) => {
                const id = entryId(entry)
                const highlighted = currentId === id
                const title = entry.kind === 'param' ? entry.def.title : entry.group.title
                const desc =
                  entry.kind === 'param'
                    ? (entry.def.effectHint ?? entry.def.description)
                    : entry.group.description
                const maybeBy =
                  entry.kind === 'param' &&
                  entry.support.supportedBy.length === 0 &&
                  entry.support.maybeBy.length > 0
                    ? entry.support.maybeBy
                    : null
                const warning = maybeBy
                  ? t('common:paramSearch.maybeUnsupported', {
                      providers: maybeBy.join(', '),
                    })
                  : ''
                return (
                  <div
                    key={id}
                    id={`add-param-${id}`}
                    data-entry-id={id}
                    role="option"
                    aria-selected={highlighted}
                    aria-disabled={entry.active || undefined}
                    onMouseMove={() => {
                      if (entry.active) return
                      const i = selectable.findIndex((s) => entryId(s) === id)
                      if (i >= 0 && i !== activeIdx) setActiveIdx(i)
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => add(entry)}
                    className={cn(
                      'flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 cursor-default select-none',
                      highlighted && 'bg-accent text-accent-foreground',
                      entry.active && 'opacity-50'
                    )}
                  >
                    <div className="flex items-center gap-1 w-full">
                      <span className="text-sm">
                        <Highlight text={title} query={query} />
                      </span>
                      {maybeBy && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="ml-auto" aria-label={warning}>
                              <TriangleAlert size={11} className="text-amber-500" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="right">{warning}</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground line-clamp-1">
                      <Highlight text={desc} query={query} />
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

type MenuEntry =
  | {
      kind: 'param'
      def: ParamDef
      active: boolean
      support: { supportedBy: string[]; maybeBy: string[] }
    }
  | { kind: 'group'; group: ParamGroup; active: boolean }

type ParamCategory = (typeof paramCategories)[number]

function entryId(entry: MenuEntry): string {
  return entry.kind === 'param' ? `p-${entry.def.key}` : `g-${entry.group.id}`
}

function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

function entryHaystack(entry: MenuEntry): string {
  const parts =
    entry.kind === 'param'
      ? [entry.def.title, entry.def.description, entry.def.effectHint ?? '', entry.def.key]
      : [entry.group.title, entry.group.description, entry.group.id, ...entry.group.members]
  let text = parts.join(' ').toLowerCase()
  // Common shorthand people type for context settings.
  if (text.includes('context')) text += ' ctx'
  // Let "top k" find top_k and "topk" find Top K.
  return `${text} ${text.replace(/_/g, ' ')} ${text.replace(/[\s_-]+/g, '')}`
}

/**
 * Filter the Add parameter menu by a search query. Every whitespace-separated
 * term must appear (case-insensitive substring) in the entry's name,
 * description or key. Categories left without entries are dropped.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function filterMenuItems<C, E extends MenuEntry>(
  items: Array<{ cat: C; entries: E[] }>,
  query: string
): Array<{ cat: C; entries: E[] }> {
  const terms = queryTerms(query)
  if (terms.length === 0) return items
  return items
    .map(({ cat, entries }) => ({
      cat,
      entries: entries.filter((e) => {
        const hay = entryHaystack(e)
        return terms.every((term) => hay.includes(term))
      }),
    }))
    .filter(({ entries }) => entries.length > 0)
}

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = queryTerms(query)
  if (terms.length === 0 || !text) return <>{text}</>
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const parts = text.split(new RegExp(`(${escaped.join('|')})`, 'gi'))
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-transparent text-foreground font-semibold underline">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

/**
 * Stable display order for active rows: same order the Add menu uses
 * (categories top-to-bottom, items within a category in declared order).
 * Unknown / category-less keys sort to the end, preserving relative order.
 */
const CANONICAL_INDEX: Record<string, number> = (() => {
  const idx: Record<string, number> = {}
  let i = 0
  for (const cat of paramCategories) {
    for (const key of cat.paramKeys) {
      if (!(key in idx)) idx[key] = i++
    }
  }
  return idx
})()

function canonicalOrder(key: string): number {
  return key in CANONICAL_INDEX ? CANONICAL_INDEX[key] : Number.MAX_SAFE_INTEGER
}

function providerSupportFor(
  def: ParamDef,
  providers: Array<Pick<ProviderObject, 'provider'>>
): { supportedBy: string[]; maybeBy: string[] } {
  const supportedBy: string[] = []
  const maybeBy: string[] = []
  for (const p of providers) {
    const caps = resolveProviderCaps(p)
    if (caps.supported.has(def.capability)) supportedBy.push(p.provider)
    else if (caps.maybe.has(def.capability)) maybeBy.push(p.provider)
  }
  return { supportedBy, maybeBy }
}

function isCapabilitySupported(
  def: ParamDef,
  providers: Array<Pick<ProviderObject, 'provider'>>
): boolean {
  if (def.capability === 'client_only' || def.capability === 'core') return true
  return providers.some((p) => {
    const caps = resolveProviderCaps(p)
    return caps.supported.has(def.capability) || caps.maybe.has(def.capability)
  })
}

function isGroupCapabilitySupported(
  group: ParamGroup,
  providers: Array<Pick<ProviderObject, 'provider'>>
): boolean {
  return providers.some((p) => {
    const caps = resolveProviderCaps(p)
    return caps.supported.has(group.capability) || caps.maybe.has(group.capability)
  })
}
