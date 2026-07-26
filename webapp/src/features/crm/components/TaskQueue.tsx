import { Link } from '@tanstack/react-router'
import type { CriticalTaskDto } from '@teraso-crm/contracts'

import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Typography } from '@/components/typography'
import {
  DEAL_DETAIL_ROUTE_PATH,
  TASK_KIND_LABELS,
  formatDateTime,
  formatPhone,
} from '../model'
import { CriticalBadge } from './CriticalBadge'
import { StageBadge } from './DealBadges'

/**
 * The critical queue: overdue tasks on open deals, soonest first, as served by
 * `GET /api/crm/tasks/critical`.
 *
 * This is the one-handed mobile surface of PRD 10, so every row is a full-width
 * card with the call action next to the name — the owner opens the CRM on a
 * phone to see what is late and to ring the client, and that path is two taps.
 *
 * Order and membership are the server's: nothing here filters by the clock.
 */
export function TaskQueue({
  items,
  onComplete,
}: {
  items: ReadonlyArray<CriticalTaskDto>
  onComplete?: (item: CriticalTaskDto) => void
}) {
  if (items.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Просроченных задач нет</EmptyTitle>
          <EmptyDescription>
            Всё, что запланировано, ещё впереди. Новые просрочки появятся здесь автоматически.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <ul className="grid gap-3">
      {items.map(({ deal, task }) => (
        <li className="grid gap-2 rounded-xl border p-4" key={task.id}>
          <div className="flex flex-wrap items-center gap-1.5">
            <StageBadge stage={deal.stage} />
            <CriticalBadge
              hasOverdueTask={deal.hasOverdueTask}
              isCritical={deal.isCritical}
              noNextStep={deal.noNextStep}
            />
          </div>

          <Typography asChild variant="bodySmMedium">
            <Link
              aria-label={`Открыть сделку: ${deal.client.name}`}
              params={{ dealId: deal.id }}
              to={DEAL_DETAIL_ROUTE_PATH}
            >
              {deal.client.name}
            </Link>
          </Typography>

          <Typography variant="bodySm">
            {`${TASK_KIND_LABELS[task.kind]}: ${task.title}`}
          </Typography>
          <Typography tone="muted" variant="caption">
            {`Срок: ${formatDateTime(task.dueAt)}`}
          </Typography>

          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" type="button">
              {/* A real tel: link, so one tap dials from the phone the owner
                  is already holding (PRD 7.1, PRD 10). */}
              <a href={`tel:${deal.client.phoneNormalized}`}>
                <Typography variant="control">
                  {`Позвонить ${formatPhone(deal.client.phoneNormalized)}`}
                </Typography>
              </a>
            </Button>
            {onComplete && (
              <Button
                onClick={() => onComplete({ deal, task })}
                size="sm"
                type="button"
                variant="outline"
              >
                <Typography variant="control">Выполнена</Typography>
              </Button>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
