import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useAppTranslation } from '@/i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import { REPLY_LANGUAGES } from '@/lib/replyLanguage'

/** Pins the language the model replies in, in chats, Cowork and rooms. */
export default function ReplyLanguageSwitcher() {
  const { t } = useAppTranslation()
  const replyLanguage = useGeneralSetting((s) => s.replyLanguage)
  const setReplyLanguage = useGeneralSetting((s) => s.setReplyLanguage)
  const auto = t('settings:general.replyLanguageAuto')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          data-testid="reply-language"
          className="w-full min-w-[140px] justify-between pointer-coarse:h-11"
        >
          {REPLY_LANGUAGES.find((l) => l.value === replyLanguage)?.label ?? auto}
          <Icon name="arrow-down" size={12} className="ml-2 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-44 overflow-y-auto">
        {[{ value: '', label: auto }, ...REPLY_LANGUAGES].map((lang) => (
          <DropdownMenuItem
            key={lang.value || 'auto'}
            className={cn(
              'my-0.5 cursor-pointer',
              replyLanguage === lang.value && 'bg-secondary-foreground/8'
            )}
            onClick={() => setReplyLanguage(lang.value)}
          >
            {lang.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
