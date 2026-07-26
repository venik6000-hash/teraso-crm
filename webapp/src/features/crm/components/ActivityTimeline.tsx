import { DEAL_DETAIL_ACTIVITY_LIMIT } from '@teraso-crm/contracts'
import type { DealActivityDto } from '@teraso-crm/contracts'

import { Badge } from '@/components/ui/badge'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty'
import { Typography } from '@/components/typography'
import {
  ACTIVITY_KIND_LABELS,
  DEAL_STAGE_LABELS,
  LOSS_REASON_LABELS,
  TASK_KIND_LABELS,
  formatDateTime,
  personLabel,
} from '../model'

/**
 * The immutable history (PRD 7.1). Entries are read-only by design — nothing in
 * the interface edits or deletes one — and every entry states when it happened
 * and who caused it.
 *
 * A null author means the entry was written by the system (an inbound lead, a
 * scheduled task transition) rather than by a person, so it is named as such
 * instead of being left blank.
 */
export function ActivityTimeline({
  activities,
  hasMore,
}: {
  activities: ReadonlyArray<DealActivityDto>
  hasMore: boolean
}) {
  if (activities.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Событий пока нет</EmptyTitle>
          <EmptyDescription>
            Здесь появятся заявка, смены этапа и класса, задачи и заметки.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="grid gap-4">
      {hasMore && (
        <Typography variant="caption" tone="muted">
          {`Показаны последние ${DEAL_DETAIL_ACTIVITY_LIMIT} событий, история длиннее`}
        </Typography>
      )}
      <ol className="grid gap-3">
        {activities.map((entry) => (
          <li className="grid gap-1 border-l-2 pl-3" key={entry.id}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                <Typography variant="controlXs">
                  {ACTIVITY_KIND_LABELS[entry.kind]}
                </Typography>
              </Badge>
              <Typography variant="caption" tone="muted" wrap="nowrap">
                {formatDateTime(entry.createdAt)}
              </Typography>
              <Typography
                title={entry.authorName ?? undefined}
                tone="muted"
                variant="caption"
              >
                {personLabel(entry.authorName, 'Система')}
              </Typography>
            </div>
            <ActivityBody entry={entry} />
          </li>
        ))}
      </ol>
    </div>
  )
}

function ActivityBody({ entry }: { entry: DealActivityDto }) {
  const details: string[] = []

  if (entry.fromStage && entry.toStage) {
    details.push(
      `${DEAL_STAGE_LABELS[entry.fromStage]} → ${DEAL_STAGE_LABELS[entry.toStage]}`,
    )
  } else if (entry.toStage) {
    details.push(DEAL_STAGE_LABELS[entry.toStage])
  }

  const metadata = entry.metadata
  if (metadata?.lossReason) {
    details.push(`Причина потери: ${LOSS_REASON_LABELS[metadata.lossReason]}`)
  }
  if (metadata?.taskKind) {
    details.push(TASK_KIND_LABELS[metadata.taskKind])
  }
  if (metadata?.dueAt) {
    details.push(`Срок: ${formatDateTime(metadata.dueAt)}`)
  }
  for (const change of metadata?.changes ?? []) {
    details.push(`${change.field}: ${change.before ?? '—'} → ${change.after ?? '—'}`)
  }

  return (
    <div className="grid gap-0.5">
      {entry.text && <Typography variant="bodySm">{entry.text}</Typography>}
      {details.map((detail) => (
        <Typography key={detail} variant="caption" tone="muted">
          {detail}
        </Typography>
      ))}
    </div>
  )
}
