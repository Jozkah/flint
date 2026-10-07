import { useTranslation } from '@/i18n/react-i18next-compat'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  Copy,
  CopyCheck,
  Eye,
  EyeOff,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { copyToClipboard } from '@/lib/clipboard'

type SecretInputProps = Omit<
  React.ComponentProps<typeof Input>,
  'type'
>

export function SecretInput({ className, value, ...props }: SecretInputProps) {
  const [revealed, setRevealed] = useState(false)
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const stringValue = typeof value === 'string' ? value : String(value ?? '')

  const handleCopy = async () => {
    if (!stringValue) return
    if (!(await copyToClipboard(stringValue))) return
    setCopied(true)
    clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative w-full">
      <Input
        {...props}
        value={value}
        type={revealed ? 'text' : 'password'}
        className={cn('pr-16', className)}
      />
      <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
        <button
          type="button"
          tabIndex={-1}
          aria-label={revealed ? t('common:a11y.hide') : t('common:a11y.reveal')}
          className="p-1 rounded text-muted-foreground hover:bg-secondary/50"
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('common:a11y.copy')}
          disabled={!stringValue}
          className="p-1 rounded text-muted-foreground hover:bg-secondary/50 disabled:opacity-40 disabled:pointer-events-none"
          onClick={handleCopy}
        >
          {copied ? (
            <CopyCheck size={16} className="text-primary" />
          ) : (
            <Copy size={16} />
          )}
        </button>
      </div>
    </div>
  )
}
