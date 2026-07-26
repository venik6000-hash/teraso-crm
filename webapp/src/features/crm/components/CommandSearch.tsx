import { Search01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { Typography } from '@/components/typography'
import {
  DEAL_DETAIL_ROUTE_PATH,
  DEAL_STAGE_LABELS,
  MIN_DEAL_SEARCH_LENGTH,
  formatPhone,
  isSearchTermTooShort,
  parseDealListSearch,
} from '../model'
import { useDealListQuery } from '../queries'

/**
 * Jump to a deal by name or phone from anywhere in the CRM.
 *
 * Opens on Cmd/Ctrl+K, and on a phone — where there is no such shortcut — the
 * trigger stays a visible button in the page header (PRD 10). The search runs
 * against the same list endpoint the deals page uses, so one set of rules
 * decides what a term matches.
 */
export function CommandSearch() {
  const navigate = useNavigate()
  const [isOpen, setIsOpen] = useState(false)
  const [term, setTerm] = useState('')

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'k' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      setIsOpen((open) => !open)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const trimmed = term.trim()
  const deals = useDealListQuery(
    parseDealListSearch({ q: trimmed, pageSize: 8, sort: 'submittedAt' }),
  )
  const results = trimmed.length >= MIN_DEAL_SEARCH_LENGTH ? (deals.data?.items ?? []) : []

  return (
    <>
      <Button
        aria-label="Найти сделку"
        onClick={() => setIsOpen(true)}
        type="button"
        variant="outline"
      >
        <HugeiconsIcon aria-hidden icon={Search01Icon} strokeWidth={2} />
        <Typography variant="control">Найти</Typography>
        <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
      </Button>

      <CommandDialog
        description="Поиск сделки по имени клиента или телефону"
        onOpenChange={setIsOpen}
        open={isOpen}
        title="Поиск по сделкам"
      >
        {/* The endpoint already decides what a term matches, so cmdk must not
            filter the answer a second time with its own fuzzy scoring. */}
        <Command shouldFilter={false}>
          <CommandInput
            onValueChange={setTerm}
            placeholder="Имя или телефон"
            value={term}
          />
          <CommandList>
            {isSearchTermTooShort(trimmed) ? (
              <CommandEmpty>
                {`Введите не меньше ${MIN_DEAL_SEARCH_LENGTH} символов`}
              </CommandEmpty>
            ) : results.length === 0 ? (
              <CommandEmpty>
                {deals.isFetching ? 'Ищем…' : 'Ничего не найдено'}
              </CommandEmpty>
            ) : (
              <CommandGroup heading="Сделки">
                {results.map((deal) => (
                  <CommandItem
                    key={deal.id}
                    onSelect={() => {
                      setIsOpen(false)
                      setTerm('')
                      void navigate({
                        params: { dealId: deal.id },
                        to: DEAL_DETAIL_ROUTE_PATH,
                      })
                    }}
                    value={deal.id}
                  >
                    <div className="grid min-w-0 gap-0.5">
                      <Typography variant="bodySmMedium" truncate>
                        {deal.client.name}
                      </Typography>
                      <Typography variant="caption" tone="muted">
                        {`${formatPhone(deal.client.phoneNormalized)} · ${DEAL_STAGE_LABELS[deal.stage]}`}
                      </Typography>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  )
}
