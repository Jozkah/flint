import { useMemo } from 'react'
import {
  SlidersHorizontal,
  ChevronDown,
  Settings,
  User,
} from 'lucide-react'
import { Link } from '@tanstack/react-router'

import { route } from '@/constants/routes'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

import { AssistantsMenu } from '@/components/AssistantsMenu'
import { AvatarEmoji } from '@/containers/AvatarEmoji'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ParametersSection } from '@/containers/ParametersSection'
import { useAssistant } from '@/hooks/useAssistant'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useDraftSampling } from '@/hooks/useDraftSampling'
import { paramsSettings, type ParamDef } from '@/lib/predefinedParams'
import { isPredefinedRemoteProvider } from '@/lib/providerCaps'
import { cn, getProviderTitle } from '@/lib/utils'
import {
  WebSearchToggleRow,
  type WebSearchToggle,
} from '@/containers/WebSearchToggleRow'

interface SamplerPopoverProps {
  /** Provider ID of the currently-selected model, if any. Used to scope the
   *  chip palette to a single provider's capabilities. */
  providerId?: string
  /** Currently-selected model ID. Drives model-family rejection (e.g. o1/gpt-5
   *  reasoning models reject temperature/top_p). */
  modelId?: string
  /** Optional assistant switcher. When omitted, the header shows the active
   *  assistant name as static text. */
  assistantSwitcher?: {
    assistants: Assistant[]
    currentThread: Thread | undefined
    selectedAssistantId: string | undefined
    setSelectedAssistantId: (id: string) => void
    updateCurrentThreadAssistant: (assistant: Assistant) => void
  }
  /** Off-thread edits wait in a draft for the new chat instead of changing
   *  the assistant itself. Off for surfaces that read the assistant directly. */
  draftOffThread?: boolean
  /** Web search for this chat, as a row in the panel (no separate button). */
  webSearch?: WebSearchToggle
}

export function SamplerPopover({
  providerId,
  modelId,
  assistantSwitcher,
  draftOffThread = false,
  webSearch,
}: SamplerPopoverProps) {
  const { t } = useTranslation()
  const currentAssistant = useAssistant((s) => s.currentAssistant)
  const updateAssistant = useAssistant((s) => s.updateAssistant)
  const assistantsLoading = useAssistant((s) => s.loading)
  const providers = useModelProvider((s) => s.providers)

  const scopedProviders = useMemo(() => {
    if (providerId) {
      const p = providers.find((x) => x.provider === providerId)
      return p ? [p] : []
    }
    return providers.filter((p) => p.active)
  }, [providers, providerId])

  // The header must match the switcher's checkmark in every context:
  //  - inside a thread: the thread's assigned assistant, including "None"
  //    (model-only) which must NOT fall back to the global default;
  //  - off-thread with a switcher (home screen): the dropdown selection
  //    (selectedAssistantId), since that's what a new chat will use;
  //  - no switcher at all: the global current assistant.
  const inThread = !!assistantSwitcher?.currentThread
  const threadAssistant = assistantSwitcher?.currentThread?.assistants?.[0]
  const isThreadAssistant =
    !!threadAssistant && threadAssistant.id !== 'model-only'
  const selectedAssistant = assistantSwitcher
    ? assistantSwitcher.assistants.find(
        (a) => a.id === assistantSwitcher.selectedAssistantId
      )
    : currentAssistant
  const activeAssistant: Assistant | undefined = inThread
    ? isThreadAssistant
      ? threadAssistant
      : undefined
    : selectedAssistant

  const draftParams = useDraftSampling((s) =>
    activeAssistant ? s.byAssistant[activeAssistant.id] : undefined
  )
  const useDraft = draftOffThread && !inThread
  const params =
    (useDraft ? draftParams : undefined) ?? activeAssistant?.parameters ?? {}
  const samplerKeys = Object.keys(params).filter((k) => k in paramsSettings)
  const hasOverrides = samplerKeys.length > 0

  const writeParams = (next: Record<string, unknown>) => {
    if (!activeAssistant) return
    if (useDraft) {
      useDraftSampling.getState().set(activeAssistant.id, next)
      return
    }
    const updated = { ...activeAssistant, parameters: next }
    if (isThreadAssistant && assistantSwitcher) {
      // Sampling overrides belong to this thread. Updating the canonical
      // assistant also rewrites every other thread using that assistant.
      assistantSwitcher.updateCurrentThreadAssistant(updated)
    } else {
      updateAssistant(updated)
    }
  }

  const handleToggle = (def: ParamDef) => {
    if (def.key in params) {
      const next = { ...params }
      delete next[def.key]
      writeParams(next)
    } else {
      writeParams({ ...params, [def.key]: def.value })
    }
  }

  const handleChange = (key: string, value: unknown) => {
    writeParams({ ...params, [key]: value })
  }

  const handleRemove = (key: string) => {
    const next = { ...params }
    delete next[key]
    writeParams(next)
  }

  const handleAddMany = (values: Record<string, unknown>) => {
    writeParams({ ...params, ...values })
  }

  const handleRemoveMany = (keys: string[]) => {
    const next = { ...params }
    for (const k of keys) delete next[k]
    writeParams(next)
  }

  const handleResetAll = () => {
    const next: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(params)) {
      if (!(k in paramsSettings)) next[k] = v
    }
    writeParams(next)
  }

  if (isPredefinedRemoteProvider(providerId)) {
    // Remote providers manage their own sampling. Keep the control visible
    // (disabled) so it is discoverable and explains itself.
    const providerName =
      providers.find((x) => x.provider === providerId)?.displayName ||
      getProviderTitle(providerId as string)
    const reason = t('common:sampler.notSupported', { provider: providerName })
    // Web search still lives behind this button, so it opens; the panel says
    // why sampling is not there.
    if (webSearch) {
      return (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('common:sampler.label')}
              title={t('common:sampler.label')}
              className="size-7 rounded-[7px] pointer-coarse:size-11"
            >
              <SlidersHorizontal className="size-[15px] text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            side="top"
            sideOffset={8}
            collisionPadding={12}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              ;(event.target as HTMLElement | null)?.focus?.()
            }}
            className="w-[320px] p-1"
          >
            <WebSearchToggleRow {...webSearch} />
            <p
              data-testid="sampler-unsupported"
              className="border-t px-2 py-1.5 text-xs text-muted-foreground"
            >
              {reason}
            </p>
          </PopoverContent>
        </Popover>
      )
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" tabIndex={0} data-testid="sampler-unsupported">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('common:sampler.label')}
              title={reason}
              className="size-7 rounded-[7px] pointer-coarse:size-11"
              disabled
            >
              <SlidersHorizontal className="size-[15px] text-muted-foreground" />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{reason}</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  const triggerLabel = assistantsLoading
    ? 'Loading assistant…'
    : activeAssistant
      ? `Sampling — ${activeAssistant.name}`
      : 'Sampling'

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('common:sampler.label')}
              className="relative size-7 rounded-[7px] pointer-coarse:size-11"
              // Web search in the panel is reachable while assistants load.
              disabled={assistantsLoading && !webSearch}
            >
              <SlidersHorizontal
                className={cn(
                  'size-[15px] text-muted-foreground',
                  hasOverrides && 'text-foreground'
                )}
              />
              {/* Overridden sampling: a small orange dot, like a draft marker. */}
              {hasOverrides && (
                <span
                  aria-hidden
                  className="absolute top-1 right-1 size-[5px] rounded-full bg-[#f59e0b]"
                />
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>{triggerLabel}</p>
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        avoidCollisions
        // Focus the panel itself, not its first control: that control's tooltip
        // opened on focus and took the first Escape, so closing took two.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.target as HTMLElement | null)?.focus?.()
        }}
        className="w-[380px] p-0 flex flex-col max-h-[var(--radix-popover-content-available-height)]"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-2 border-b">
          <AssistantHeader
            currentAssistant={activeAssistant}
            assistantSwitcher={assistantSwitcher}
          />
          <div className="flex items-center gap-1 shrink-0">
            {hasOverrides && (
              <Button variant="ghost" size="sm" onClick={handleResetAll}>
                Reset all
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" asChild>
                  <Link to={route.settings.assistant}>
                    <Settings size={16} className="text-muted-foreground" />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Open assistant settings</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
        {webSearch && (
          <div className="border-b px-2 py-1">
            <WebSearchToggleRow {...webSearch} />
          </div>
        )}
        {activeAssistant ? (
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
            <ParametersSection
              params={params}
              providers={scopedProviders}
              providerId={providerId}
              modelId={modelId}
              onToggle={handleToggle}
              onChange={handleChange}
              onRemove={handleRemove}
              onAddMany={handleAddMany}
              onRemoveMany={handleRemoveMany}
            />
          </div>
        ) : (
          <div className="text-xs text-muted-foreground px-4 py-3">
            Pick an assistant above to configure sampling.
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

interface AssistantHeaderProps {
  currentAssistant: Assistant | undefined
  assistantSwitcher: SamplerPopoverProps['assistantSwitcher']
}

function AssistantHeader({
  currentAssistant,
  assistantSwitcher,
}: AssistantHeaderProps) {
  const { t } = useTranslation()
  const label = (
    <span className="flex items-center gap-1.5 min-w-0">
      {currentAssistant?.avatar ? (
        <AvatarEmoji
          avatar={currentAssistant.avatar}
          imageClassName="size-4 object-contain"
          textClassName="text-sm"
        />
      ) : (
        <User size={14} className="text-muted-foreground" />
      )}
      <span className="text-sm font-medium truncate">
        {currentAssistant?.name ?? t('common:noAssistant')}
      </span>
    </span>
  )

  if (!assistantSwitcher) {
    return <div className="flex items-center gap-1 min-w-0">{label}</div>
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 h-7 px-2 gap-1 min-w-0"
        >
          {label}
          <ChevronDown size={14} className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-64 overflow-y-auto"
      >
        <AssistantsMenu
          selectedAssistant={assistantSwitcher.selectedAssistantId}
          setSelectedAssistant={assistantSwitcher.setSelectedAssistantId}
          currentThread={assistantSwitcher.currentThread}
          updateCurrentThreadAssistant={
            assistantSwitcher.updateCurrentThreadAssistant
          }
          assistants={assistantSwitcher.assistants}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
