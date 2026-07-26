import { Link } from '@tanstack/react-router'
import type { DealSummaryDto } from '@teraso-crm/contracts'

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Typography } from '@/components/typography'
import {
  DEAL_DETAIL_ROUTE_PATH,
  formatDateTime,
  formatMoney,
  formatPhone,
  personLabel,
} from '../model'
import { CriticalBadge } from './CriticalBadge'
import { LeadClassBadge, NextStepBadge, StageBadge } from './DealBadges'

/**
 * The deal list (PRD 7.5).
 *
 * On a phone the table collapses into one card per deal — `block sm:table` with
 * a two-column grid inside each row — because a seven-column table on a 390 px
 * screen is exactly the horizontal scroll PRD 10 rules out. Every column keeps
 * its label on the small layout so a stacked card still reads as a record.
 *
 * Urgency, the next step and the overdue state are taken from the row as the
 * API served it. Nothing here consults the clock.
 */
export function DealList({ deals }: { deals: ReadonlyArray<DealSummaryDto> }) {
  return (
    <Table className="block sm:table">
      <TableHeader className="hidden sm:table-header-group">
        <TableRow>
          <TableHead>Клиент</TableHead>
          <TableHead>Этап</TableHead>
          <TableHead>Заявка</TableHead>
          <TableHead>Сумма</TableHead>
          <TableHead>Следующий шаг</TableHead>
          <TableHead>Ответственный</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="grid gap-3 sm:table-row-group">
        {deals.map((deal) => (
          <TableRow
            className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 rounded-xl border-0 p-4 ring-1 ring-border sm:table-row sm:rounded-none sm:border-b sm:p-0 sm:ring-0"
            data-testid={`deal-row-${deal.id}`}
            key={deal.id}
          >
            <TableCell className="col-span-2 min-w-0 p-0 align-top whitespace-normal sm:p-3">
              <div className="grid gap-0.5">
                <Typography asChild variant="bodySmMedium">
                  <Link
                    aria-label={`Открыть сделку: ${deal.client.name}`}
                    params={{ dealId: deal.id }}
                    to={DEAL_DETAIL_ROUTE_PATH}
                  >
                    {deal.client.name}
                  </Link>
                </Typography>
                <Typography variant="caption" tone="muted" wrap="nowrap">
                  {formatPhone(deal.client.phoneNormalized)}
                </Typography>
                <Typography variant="caption" tone="muted" truncate>
                  {deal.source}
                </Typography>
              </div>
            </TableCell>

            <TableCell className="col-span-2 p-0 align-top whitespace-normal sm:p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <StageBadge stage={deal.stage} />
                <LeadClassBadge leadClass={deal.leadClass} />
                <CriticalBadge
                  hasOverdueTask={deal.hasOverdueTask}
                  isCritical={deal.isCritical}
                  noNextStep={deal.noNextStep}
                />
              </div>
            </TableCell>

            <TableCell className="p-0 align-top whitespace-normal sm:p-3 sm:whitespace-nowrap">
              <Typography className="sm:hidden" variant="caption" tone="muted">
                Заявка
              </Typography>
              <Typography variant="bodySm" wrap="nowrap">
                {formatDateTime(deal.submittedAt)}
              </Typography>
            </TableCell>

            <TableCell className="p-0 text-right align-top tabular-nums sm:table-cell sm:p-3 sm:text-left">
              <Typography className="sm:hidden" variant="caption" tone="muted">
                Сумма
              </Typography>
              <Typography variant="bodySmMedium" wrap="nowrap">
                {formatMoney(deal.potentialAmount)}
              </Typography>
            </TableCell>

            <TableCell className="col-span-2 p-0 align-top whitespace-normal sm:p-3">
              <Typography className="sm:hidden" variant="caption" tone="muted">
                Следующий шаг
              </Typography>
              <NextStepBadge isOverdue={deal.hasOverdueTask} task={deal.nearestActiveTask} />
            </TableCell>

            <TableCell className="col-span-2 min-w-0 border-t p-0 pt-3 align-top whitespace-normal sm:table-cell sm:border-0 sm:p-3">
              <Typography className="sm:hidden" variant="caption" tone="muted">
                Ответственный
              </Typography>
              <Typography
                title={deal.responsibleName ?? undefined}
                truncate
                variant="bodySm"
              >
                {personLabel(deal.responsibleName)}
              </Typography>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
