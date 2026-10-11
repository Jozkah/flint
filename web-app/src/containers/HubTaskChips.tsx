import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
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
  const [open, setOpen] = useState(false)
  const hidden: HubTask | undefined = MORE_TASKS.find((t) => t.id === value)

  return (
    <>
      {PRIMARY_TASKS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={cn(PILL, value === id ? ON : OFF)}
        >
          {label}
        </button>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="More ways to browse"
            aria-pressed={Boolean(hidden)}
            className={cn(PILL, hidden ? ON : OFF)}
          >
            {hidden ? hidden.label : 'More'}
            <ChevronDown className="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-48 p-1">
          {MORE_TASKS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={value === id}
              onClick={() => {
                onChange(id)
                setOpen(false)
              }}
              className="flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-accent"
            >
              {label}
              {value === id && <Check className="size-3.5" />}
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </>
  )
}
