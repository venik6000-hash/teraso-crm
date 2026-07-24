import {
  NEXT_STEP_GRACE_MINUTES,
  OPEN_DEAL_STAGES,
  type DealStage,
  type LossReason,
} from '@teraso-crm/contracts'

import { CrmFailure } from './errors'

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

/* ------------------------------------------------------------------ *
 * Funnel transitions (PRD 7.3, PRD 6.2/6.3)
 *
 * The reachable-stage graph is server-authoritative and lives here, not in the
 * contract: `dealStageChangeSchema` only guards which fields each destination
 * stage may carry, so a payload like `{ stage: 'WON', fullPayment... }` parses
 * yet is a forbidden NEW -> WON skip that only this function rejects.
 *
 *   advance  NEW -> QUALIFIED -> PROPOSAL_SENT -> PREPAYMENT -> WON
 *   lose     NEW | QUALIFIED | PROPOSAL_SENT | PREPAYMENT -> LOST
 *   reopen   WON | LOST -> NEW
 *
 * A reopen is deliberately a distinct kind, not an advance: it emits a REOPENED
 * activity only (never STAGE_CHANGED), because the dashboard funnel counts
 * STAGE_CHANGED rows and an administrative correction must not read as a
 * conversion (PRD 7.8 item 5).
 * ------------------------------------------------------------------ */

export type StageTransitionKind = 'advance' | 'lose' | 'reopen'

export type StageTransition = { kind: StageTransitionKind }

export type StageChangeCheck = {
  from: DealStage
  to: DealStage
  prepaymentAmount?: string | null
  prepaymentPaidAt?: string | null
  fullPaymentAmount?: string | null
  fullPaymentPaidAt?: string | null
  lossReason?: LossReason | null
}

/** The single legal forward step out of each stage; closed stages have none. */
const forwardStep: Record<DealStage, DealStage | null> = {
  NEW: 'QUALIFIED',
  QUALIFIED: 'PROPOSAL_SENT',
  PROPOSAL_SENT: 'PREPAYMENT',
  PREPAYMENT: 'WON',
  WON: null,
  LOST: null,
}

/** Human-readable stage names for the rejection message; PRD 7.3 wording. */
const stageLabels: Record<DealStage, string> = {
  NEW: 'Новая заявка',
  QUALIFIED: 'Квалификация пройдена',
  PROPOSAL_SENT: 'Предложение отправлено',
  PREPAYMENT: 'Предоплата',
  WON: 'Успех',
  LOST: 'Потеряна',
}

const losableStages = new Set<DealStage>(OPEN_DEAL_STAGES)
const reopenableStages = new Set<DealStage>(['WON', 'LOST'])

/**
 * A money string is a real amount only when it is present and above zero.
 *
 * This is the authoritative "> 0" rule for a payment-bearing stage. The contract
 * `moneyAmountSchema` deliberately accepts "0.00" as a valid *format*, and
 * `dealStageChangeSchema.superRefine` (packages/contracts/src/crm.ts) only checks
 * presence — so the same rule lives in two encodings. A future payment-bearing
 * stage must update both sites; the superRefine carries the reciprocal note.
 */
function isPositiveAmount(amount: string | null | undefined): boolean {
  return amount != null && Number(amount) > 0
}

function illegalTransition(from: DealStage, to: DealStage): CrmFailure {
  return new CrmFailure(
    'validation',
    `Недопустимый переход воронки: из «${stageLabels[from]}» в «${stageLabels[to]}»`,
  )
}

/**
 * Validates a requested stage move and classifies it, or throws a `CrmFailure`.
 * The payment-field and loss-reason presence checks are repeated here rather than
 * left to the contract because this is the authoritative rule the repository
 * calls inside its write transaction, and it is exercised directly by unit tests
 * with no HTTP layer in front of it.
 */
export function validateStageChange(input: StageChangeCheck): StageTransition {
  const { from, to } = input

  if (to === 'LOST') {
    if (!losableStages.has(from)) throw illegalTransition(from, to)
    if (!input.lossReason) {
      throw new CrmFailure('validation', 'Выберите причину потери')
    }
    return { kind: 'lose' }
  }

  if (to === 'NEW') {
    if (!reopenableStages.has(from)) throw illegalTransition(from, to)
    return { kind: 'reopen' }
  }

  if (forwardStep[from] !== to) throw illegalTransition(from, to)

  if (to === 'PREPAYMENT' && !(isPositiveAmount(input.prepaymentAmount) && input.prepaymentPaidAt)) {
    throw new CrmFailure('validation', 'Укажите сумму и дату предоплаты')
  }
  if (to === 'WON' && !(isPositiveAmount(input.fullPaymentAmount) && input.fullPaymentPaidAt)) {
    throw new CrmFailure('validation', 'Укажите сумму и дату полной оплаты')
  }

  return { kind: 'advance' }
}
