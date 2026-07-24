import { NEXT_STEP_GRACE_MINUTES, OPEN_DEAL_STAGES, type DealStage } from '@teraso-crm/contracts'

/**
 * Server-authoritative urgency (PRD 5, PRD 7.4). These are not stored columns:
 * they are functions of wall-clock time, so any column would be stale the moment
 * nobody wrote to it.
 *
 * `activeDueAt` is the deal's nearest ACTIVE task due time, which is enough to
 * decide all three flags: if the earliest active task is already due then some
 * task is overdue, and if it is not in the future then there is no next step.
 *
 * Task 4 owns stage transitions and adds `validateStageChange` beside this
 * function. The criticality rule lives here rather than in Task 4 because every
 * deal summary this module serves has to carry these three flags, and the list
 * filters select on them.
 */
export type DealCriticality = {
  noNextStep: boolean
  hasOverdueTask: boolean
  isCritical: boolean
}

const NEXT_STEP_GRACE_MS = NEXT_STEP_GRACE_MINUTES * 60 * 1000
const openStages = new Set<DealStage>(OPEN_DEAL_STAGES)

export function isOpenStage(stage: DealStage): boolean {
  return openStages.has(stage)
}

export function evaluateDealCriticality(input: {
  stage: DealStage
  now: Date
  createdAt: Date
  activeDueAt: Date | null
}): DealCriticality {
  // WON and LOST are exempt from the next-step rule entirely (PRD 7.4).
  if (!isOpenStage(input.stage)) {
    return { noNextStep: false, hasOverdueTask: false, isCritical: false }
  }

  const due = input.activeDueAt
  const hasOverdueTask = due !== null && due.getTime() <= input.now.getTime()
  const noNextStep = due === null || due.getTime() <= input.now.getTime()
  const graceElapsed = input.createdAt.getTime() <= nextStepGraceCutoff(input.now).getTime()

  return {
    noNextStep,
    hasOverdueTask,
    isCritical: hasOverdueTask || (noNextStep && graceElapsed),
  }
}

/**
 * A deal created at or before this instant has used up its next-step grace
 * window. The list query compares `deals.created_at` against the same value, so
 * the SQL predicate and the function above read the window from one constant.
 */
export function nextStepGraceCutoff(now: Date): Date {
  return new Date(now.getTime() - NEXT_STEP_GRACE_MS)
}
