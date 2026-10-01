import { useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatTime, parseTime } from './scheduleForm'

type Props = {
  id: string
  times: string[]
  onChange: (times: string[]) => void
  invalid?: boolean
}

/** The times of day a preset runs at: a chip each, and a field to add one. */
export function TimeChips({ id, times, onChange, invalid }: Props) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('12:00')

  const add = () => {
    const parsed = parseTime(draft)
    if (!parsed) return
    const text = formatTime(parsed)
    if (times.includes(text)) return
    onChange([...times, text].sort())
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap gap-1.5" aria-label={t('schedules:editor.times')}>
        {times.map((time) => (
          <li
            key={time}
            className="inline-flex h-7 items-center gap-1 rounded-md border-[0.8px] border-border bg-card pr-1 pl-2.5 font-mono text-xs text-foreground"
          >
            {time}
            <button
              type="button"
              className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-nav-hover hover:text-foreground"
              aria-label={t('schedules:editor.removeTime', { time })}
              onClick={() => onChange(times.filter((x) => x !== time))}
            >
              <X className="size-3" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="time"
          step={60}
          value={draft}
          aria-label={t('schedules:editor.timeLabel')}
          aria-invalid={invalid || undefined}
          className="w-32"
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="button" variant="outline" size="sm" onClick={add}>
          {t('schedules:editor.addTime')}
        </Button>
      </div>
    </div>
  )
}
