import { Input } from '@/components/ui/input'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'

export function ProxyTimeoutInput({ isServerRunning }: { isServerRunning?: boolean }) {
  const { proxyTimeout, setProxyTimeout } = useLocalApiServer()
  const { t } = useTranslation()
  const [inputValue, setInputValue] = useState(proxyTimeout.toString())
  // A change made elsewhere (a reset, another window) shows here too (F8x3-012/018).
  useEffect(() => {
    setInputValue(proxyTimeout.toString())
  }, [proxyTimeout])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setInputValue(value)
  }

  const handleBlur = () => {
    // A running server keeps its configuration; the field is disabled, and
    // this guards a blur that still arrives (#111).
    if (isServerRunning) return
    const timeout = parseInt(inputValue)
    if (!isNaN(timeout) && timeout >= 0 && timeout <= 86400) {
      setProxyTimeout(timeout)
    } else {
      // Reset to current value if invalid
      setInputValue(proxyTimeout.toString())
    }
  }

  return (
    <Input
      type="number"
      min={0}
      max={86400}
      value={inputValue}
      aria-label={t('settings:localApiServer.proxyTimeout')}
      onChange={handleChange}
      onBlur={handleBlur}
      disabled={isServerRunning}
      className={cn(
        'w-24 h-8 text-sm',
        isServerRunning && 'opacity-50'
      )}
    />
  )
}
