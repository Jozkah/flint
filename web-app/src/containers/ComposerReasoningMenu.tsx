import { Brain } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu'
import {
  THINKING_BUDGET_LEVELS,
  thinkingBudgetLabel,
  DEFAULT_THINKING_BUDGET_LEVEL,
  tokensForThinkingBudgetLevel,
  isThinkingBudgetLevelKey,
  type ThinkingBudgetLevelKey,
} from '@/lib/thinkingBudget'
import { cn } from '@/lib/utils'
import { REASONING_MENU_PROVIDERS } from '@/lib/reasoningMenu'
import { useTranslation } from '@/i18n/react-i18next-compat'

type ReasoningMode = 'auto' | 'on' | 'off'

/**
 * The reasoning menu for a model that sizes its own thinking and so has no
 * effort bar: Auto / On / Off, and for llama.cpp a thinking budget.
 */
export function ComposerReasoningMenu({
  selectedProvider,
  modelSettings,
  chatOverridesReasoning,
  reasoningDefault,
  approxContextSize,
  onSetting,
}: {
  selectedProvider: string
  modelSettings:
    | Record<string, { controller_props?: { value?: unknown } } | undefined>
    | undefined
  /** This chat has its own reasoning override. */
  chatOverridesReasoning: boolean
  /** "Reasoning for new chats" from Settings. */
  reasoningDefault: string | undefined
  /** Best-effort preview only; the request-time value may differ. */
  approxContextSize: number
  onSetting: (key: string, title: string, value: string) => void
}) {
  const { t } = useTranslation()
  // The token-budget submenu only applies to local llama.cpp
  // (budget resolved against live n_ctx). Cloud providers size
  // their own budget dynamically, so on/off/auto is enough.
  const showThinkingBudget = selectedProvider === 'llamacpp'
  // Auto/On/Off writes the `reasoning` setting, which only the
  // first-party providers wire into a request.
  const showReasoningModes = (
    REASONING_MENU_PROVIDERS as readonly string[]
  ).includes(selectedProvider)
  const ownReasoning =
    (modelSettings?.reasoning?.controller_props?.value as
      | ReasoningMode
      | undefined) ?? 'auto'
  // "Reasoning for new chats" fills in where neither the
  // chat nor the model has chosen.
  const reasoningValue =
    ownReasoning === 'auto' &&
    !chatOverridesReasoning &&
    (reasoningDefault === 'on' || reasoningDefault === 'off')
      ? reasoningDefault
      : ownReasoning
  const setReasoning = (value: ReasoningMode) =>
    onSetting('reasoning', 'Reasoning', value)
  const label =
    reasoningValue === 'on'
      ? t('chat:composer.reasoningOn')
      : reasoningValue === 'off'
        ? t('chat:composer.reasoningOff')
        : t('chat:composer.reasoningAuto')
  const tooltipText =
    reasoningValue === 'on'
      ? t('chat:composer.reasoningOnTip')
      : reasoningValue === 'off'
        ? t('chat:composer.reasoningOffTip')
        : t('chat:composer.reasoningAutoTip')

  // Stored as a symbolic level, not an absolute token count:
  // the live context size (post auto-fit) is only known once
  // the model is actually loaded, so resolving to tokens
  // happens at send time (custom-chat-transport.ts) against
  // whatever the context size turns out to be then.
  const rawBudgetLevel =
    modelSettings?.thinking_budget_tokens?.controller_props?.value
  const currentBudgetLevel = isThinkingBudgetLevelKey(rawBudgetLevel)
    ? rawBudgetLevel
    : DEFAULT_THINKING_BUDGET_LEVEL
  const setThinkingBudget = (level: ThinkingBudgetLevelKey) =>
    onSetting('thinking_budget_tokens', 'Thinking Budget', level)
  const currentBudgetLabel = thinkingBudgetLabel(currentBudgetLevel)

  const check = (on: boolean) =>
    on && <span className="ml-auto text-xs text-muted-foreground">✓</span>

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="hit-y size-7 rounded-[7px] pointer-coarse:size-11"
              aria-label={t('chat:composer.reasoningLabel', { state: label })}
            >
              <Brain
                className={cn(
                  'size-4 text-muted-foreground',
                  reasoningValue === 'on' && 'text-foreground',
                  reasoningValue === 'off' && 'opacity-50'
                )}
              />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-64">
        {showReasoningModes && (
          <>
            <DropdownMenuItem onClick={() => setReasoning('auto')}>
              {t('chat:composer.reasoningAuto')}
              {check(reasoningValue === 'auto')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setReasoning('on')}>
              {t('chat:composer.reasoningOn')}
              {check(reasoningValue === 'on')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setReasoning('off')}>
              {t('chat:composer.reasoningOff')}
              {check(reasoningValue === 'off')}
            </DropdownMenuItem>
          </>
        )}
        {showThinkingBudget && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <span className="flex-1">
                  {t('chat:composer.thinkingBudget')}
                </span>
                <span className="text-xs text-muted-foreground">
                  {currentBudgetLabel}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                collisionPadding={{ top: 12, right: 12, bottom: 16, left: 12 }}
              >
                {THINKING_BUDGET_LEVELS.map((level) => {
                  const approxTokens = tokensForThinkingBudgetLevel(
                    level.key,
                    approxContextSize
                  )
                  return (
                    <DropdownMenuItem
                      key={level.key}
                      onClick={() => setThinkingBudget(level.key)}
                      className="gap-2"
                    >
                      <span className="flex-1">
                        {thinkingBudgetLabel(level.key)}
                      </span>
                      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                        {approxTokens === -1 ? '' : `~${approxTokens}`}
                      </span>
                      <span className="w-3 shrink-0 text-xs text-muted-foreground">
                        {currentBudgetLevel === level.key ? '✓' : ''}
                      </span>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
