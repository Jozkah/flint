import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  MORE_TASKS,
  PRIMARY_TASKS,
  type HubTask,
  type HubTaskId,
} from '@/lib/hubTasks'

const PILL =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border-[0.8px] px-3 text-xs font-medium transition-colors'
const OFF =
  'border-border bg-card text-secondary-foreground hover:border-border-strong hover:text-foreground'
const ON = 'border-transparent bg-foreground text-background'

type Props = {
  value: HubTaskId
  onChange: (task: HubTaskId) => void
}

/**
 * Task-style filter chips for Discover: a calm row of plain-language choices
 * and a "More" popover for the rest. "All" resets.
 */
export function HubTaskChips({ value, onChange }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const labelOf = (id: HubTaskId) => t(`uiLeftovers:hubTasks.${id}`)
  const hidden: HubTask | undefined = MORE_TASKS.find((task) => task.id === value)

  return (
    <>
      {PRIMARY_TASKS.map(({ id }) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={cn(PILL, value === id ? ON : OFF)}
        >
          {labelOf(id)}
        </button>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('uiLeftovers:hubTasks.moreAria')}
            aria-pressed={Boolean(hidden)}
            className={cn(PILL, hidden ? ON : OFF)}
          >
            {hidden ? labelOf(hidden.id) : t('uiLeftovers:hubTasks.more')}
            <ChevronDown className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-48 p-1">
          {MORE_TASKS.map(({ id }) => (
            <button
              key={id}
              type="button"
              aria-pressed={value === id}
              onClick={() => {
                onChange(id)
                setOpen(false)
              }}
              className="flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[length:calc(var(--ui-font-base)*0.8125)] hover:bg-accent"
            >
              {labelOf(id)}
              {value === id && <Check className="size-3.5" />}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </>
  )
}
