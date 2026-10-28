import { ListFilter, LayoutGrid, List as ListIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SearchField } from '@/containers/engine/EngineKit'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'

export type McpStatusFilter = 'all' | 'on' | 'off'

type Props = {
  value: string
  onChange: (value: string) => void
  statusFilter: McpStatusFilter
  onStatusFilterChange: (filter: McpStatusFilter) => void
  view: 'list' | 'cards'
  onViewChange: (view: 'list' | 'cards') => void
}

/** The server list's search box with its status filter and view switch. */
export function McpServerSearch({
  value,
  onChange,
  statusFilter,
  onStatusFilterChange,
  view,
  onViewChange,
}: Props) {
  const { t } = useTranslation()
  return (
    <SearchField
      className="ml-auto w-[300px] max-w-full"
      value={value}
      onChange={onChange}
      placeholder={t('mcp-servers:searchPlaceholder')}
      trailing={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('engine:mcp.filterLabel')}
                title={t('engine:mcp.filterLabel')}
                className={cn(statusFilter !== 'all' && 'text-acc-text')}
              >
                <ListFilter aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={statusFilter}
                onValueChange={(v) =>
                  onStatusFilterChange(v as McpStatusFilter)
                }
              >
                <DropdownMenuRadioItem value="all">
                  {t('engine:mcp.filterAll')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="on">
                  {t('engine:mcp.filterOn')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="off">
                  {t('engine:mcp.filterOff')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('engine:mcp.viewLabel')}
            title={
              view === 'list'
                ? t('engine:mcp.viewCards')
                : t('engine:mcp.viewList')
            }
            onClick={() =>
              onViewChange(view === 'list' ? 'cards' : 'list')
            }
          >
            {view === 'list' ? (
              <LayoutGrid aria-hidden />
            ) : (
              <ListIcon aria-hidden />
            )}
          </Button>
        </>
      }
    />
  )
}
