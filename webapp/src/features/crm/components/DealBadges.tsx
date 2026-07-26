import type { DealStage, LeadClass, DealTaskDto } from '@teraso-crm/contracts'

import { Badge } from '@/components/ui/badge'
import { Typography } from '@/components/typography'
import {
  DEAL_STAGE_LABELS,
  LEAD_CLASS_DESCRIPTIONS,
  LEAD_CLASS_LABELS,
  TASK_KIND_LABELS,
  formatDateTime,
} from '../model'

/**
 * Shared state markers for the list, the card and (later) the board.
 *
 * Every badge spells its state out. The variant only reinforces what the text
 * already says, so the interface still reads correctly in greyscale or for a
 * colour-blind user (PRD 7.0).
 */

const stageVariant: Record<DealStage, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  NEW: 'default',
  QUALIFIED: 'secondary',
  PROPOSAL_SENT: 'secondary',
  PREPAYMENT: 'outline',
  WON: 'outline',
  LOST: 'destructive',
}

export function StageBadge({ stage }: { stage: DealStage }) {
  return (
    <Badge variant={stageVariant[stage]}>
      <Typography variant="controlXs">{DEAL_STAGE_LABELS[stage]}</Typography>
    </Badge>
  )
}

export function LeadClassBadge({ leadClass }: { leadClass: LeadClass | null }) {
  if (!leadClass) {
    return (
      <Typography variant="caption" tone="muted">
        Класс не задан
      </Typography>
    )
  }

  return (
    <Badge title={LEAD_CLASS_DESCRIPTIONS[leadClass]} variant="outline">
      <Typography variant="controlXs">{LEAD_CLASS_LABELS[leadClass]}</Typography>
    </Badge>
  )
}

/**
 * The nearest active task. Whether it is late comes from the deal's server-side
 * `hasOverdueTask`, never from comparing `dueAt` with the browser clock.
 *
 * It reports the value only; naming the field is the caller's job, because both
 * the list column and the card header already label it.
 */
export function NextStepBadge({
  isOverdue,
  task,
}: {
  isOverdue: boolean
  task: DealTaskDto | null
}) {
  if (!task) {
    return (
      <Typography variant="caption" tone="muted">
        Не назначен
      </Typography>
    )
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant={isOverdue ? 'destructive' : 'secondary'}>
        <Typography variant="controlXs">
          {isOverdue ? 'Просрочено' : TASK_KIND_LABELS[task.kind]}
        </Typography>
      </Badge>
      <Typography variant="caption" tone="muted" wrap="nowrap">
        {formatDateTime(task.dueAt)}
      </Typography>
    </span>
  )
}
