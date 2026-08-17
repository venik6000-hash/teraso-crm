import { Link } from '@tanstack/react-router'
import { CRITICAL_TASKS_LIMIT, type CriticalTaskDto } from '@teraso-crm/contracts'

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
 * Order and membership are the server's: nothing here filters by the clock, and
 * the queue is capped server-side — `hasMore` says when a longer backlog is
 * waiting behind the rows on screen, because a truncated list that looks complete
 * would tell the owner the work is done.
 *
 * A reschedule action lives here too: an overdue call very often needs to move
 * rather than close, and sending the owner to the full deal card for that would
 * cost exactly the extra taps this queue exists to avoid. Cancelling a task does
 * not get a row here — it is the rarer, more deliberate call, and it belongs on
 * the deal card where the rest of the deal's history is visible, not as a
 * fourth button competing for space on an already dense one-handed row.
 */
export function TaskQueue({
  hasMore,
  items,
  onComplete,
  onReschedule,
}: {
  /** The server's own truncation flag, required so the page cannot forget it. */
  hasMore: boolean
  items: ReadonlyArray<CriticalTaskDto>
  onComplete?: (item: CriticalTaskDto) => void
  /** Absent hides the control, matching `onComplete`. */
  onReschedule?: (item: CriticalTaskDto) => void
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
    <div className="grid gap-3">
      {hasMore && (
        <Typography tone="muted" variant="caption">
          {`Показаны первые ${CRITICAL_TASKS_LIMIT} задач, список длиннее`}
        </Typography>
      )}
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
              {onReschedule && (
                <Button
                  data-testid="reschedule-task"
                  onClick={() => onReschedule({ deal, task })}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Typography variant="control">Перенести</Typography>
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
