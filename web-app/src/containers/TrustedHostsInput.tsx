import { Input } from '@/components/ui/input'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useState, useEffect } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

export function TrustedHostsInput({
  isServerRunning,
}: {
  isServerRunning?: boolean
}) {
  const { trustedHosts, setTrustedHosts } = useLocalApiServer()
  const [inputValue, setInputValue] = useState(trustedHosts.join(', '))
  const { t } = useTranslation()

  // Update input value when trustedHosts changes externally
  useEffect(() => {
    setInputValue(trustedHosts.join(', '))
  }, [trustedHosts])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setInputValue(value)
  }

  const handleBlur = () => {
    // A running server keeps its configuration; the field is disabled, and
    // this guards a blur that still arrives (#111).
    if (isServerRunning) return
    // Split by comma and clean up each host
    const hosts = inputValue
      .split(',')
      .map((host) => host.trim())
      .filter((host) => host.length > 0)

    // Remove duplicates
    const uniqueHosts = [...new Set(hosts)]

    setTrustedHosts(uniqueHosts)
    setInputValue(uniqueHosts.join(', '))
  }

  return (
    <Input
      type="text"
      value={inputValue}
      onChange={handleChange}
      onBlur={handleBlur}
      disabled={isServerRunning}
      placeholder={t('common:enterTrustedHosts')}
      className={cn(
        'h-8 text-sm',
        isServerRunning && 'opacity-50'
      )}
    />
  )
}
