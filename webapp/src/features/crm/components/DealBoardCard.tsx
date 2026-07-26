import { Link } from '@tanstack/react-router'
import type { DealSummaryDto } from '@teraso-crm/contracts'

import { Typography } from '@/components/typography'
import { DEAL_DETAIL_ROUTE_PATH, formatDate, formatMoney } from '../model'
import { CriticalBadge } from './CriticalBadge'
import { LeadClassBadge, NextStepBadge } from './DealBadges'

/**
 * One card on the board (PRD 7.6): name, submitted date, source, class,
 * potential amount and the nearest task.
 *
 * The stage is not repeated on the card — the column already states it, and a
 * badge saying «Новая заявка» inside the «Новая заявка» column is noise on the
 * one surface where vertical space is scarcest.
 *
 * Urgency comes from the row as served. Nothing here consults the clock.
 *
 * Dragging is wired by the parent, which owns the dnd sensors; this component
 * stays a plain card so it renders identically in the drag overlay and in the
 * column, and so the tests exercise it without a DnD context.
 */
export function DealBoardCard({
  deal,
  dragHandle,
  isDragging = false,
}: {
  deal: DealSummaryDto
  dragHandle?: React.HTMLAttributes<HTMLDivElement>
  isDragging?: boolean
}) {
  return (
    <article
      className={`grid gap-2 rounded-xl border bg-card p-3 ring-1 ring-border ${
        isDragging ? 'opacity-60' : ''
      }`}
      data-testid={`deal-row-${deal.id}`}
    >
      {/*
        The drag surface is separate from the link: a card that is both would
        make every attempt to open a deal on a touchscreen a potential drag.
        The link is the primary action and stays a real anchor, so it opens in a
        new tab and is reachable by keyboard.
      */}
      <div {...dragHandle} className="grid cursor-grab gap-2 active:cursor-grabbing">
        <Typography asChild variant="bodySmMedium">
          <Link
            aria-label={`Открыть сделку: ${deal.client.name}`}
            params={{ dealId: deal.id }}
            to={DEAL_DETAIL_ROUTE_PATH}
          >
            {deal.client.name}
          </Link>
        </Typography>

        <div className="flex flex-wrap items-center gap-1.5">
          <LeadClassBadge leadClass={deal.leadClass} />
          <CriticalBadge
            hasOverdueTask={deal.hasOverdueTask}
            isCritical={deal.isCritical}
            noNextStep={deal.noNextStep}
          />
        </div>

        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Typography tone="muted" truncate variant="caption">
            {deal.source}
          </Typography>
          <Typography variant="bodySmMedium" wrap="nowrap">
            {formatMoney(deal.potentialAmount)}
          </Typography>
        </div>

        <Typography tone="muted" variant="caption" wrap="nowrap">
          {`Заявка: ${formatDate(deal.submittedAt)}`}
        </Typography>

        <NextStepBadge isOverdue={deal.hasOverdueTask} task={deal.nearestActiveTask} />
      </div>
    </article>
  )
}
