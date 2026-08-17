import {
  ACTIVE_DEAL_STAGES,
  OPEN_DEAL_STAGES,
  type DealBoardQuery,
  type DealSortField,
  type SortDirection,
} from '@teraso-crm/contracts'

import { Prisma } from '../../../generated/prisma/client'
import { nextStepGraceCutoff } from '../domain/deal-rules'
import { kyivDayEndExclusive, kyivDayStart, kyivTodayRange } from '../domain/kyiv-time'
import { phoneSearchDigits } from '../domain/phone'

/* ------------------------------------------------------------------ *
 * List query builder
 *
 * The deal list is raw SQL because `sort=nearestTaskDueAt` orders by the minimum
 * due time of a filtered relation, which Prisma cannot express; splitting the
 * path would be worse than one query. Hydration then goes back through Prisma so
 * the DTO mapping stays typed against the schema.
 *
 * Every request value is interpolated through Prisma's tagged template, which
 * binds it as a parameter. Nothing here concatenates request data into SQL —
 * including the sort column and direction, which are looked up in the fixed
 * fragment tables below rather than passed through from the query string.
 * ------------------------------------------------------------------ */

export const sortColumns: Record<DealSortField, Prisma.Sql> = {
  submittedAt: Prisma.sql`d.submitted_at`,
  nearestTaskDueAt: Prisma.sql`nearest_task.due_at`,
  potentialAmount: Prisma.sql`d.potential_amount`,
}

export const sortDirections: Record<SortDirection, Prisma.Sql> = {
  asc: Prisma.sql`ASC NULLS LAST`,
  desc: Prisma.sql`DESC NULLS LAST`,
}

/** Escapes the LIKE metacharacters so a term containing % or _ stays literal. */
export function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

const openStagesSql = Prisma.sql`(${Prisma.join(OPEN_DEAL_STAGES.map((stage) => Prisma.sql`${stage}::deal_stage`))})`

/** The board's columns, LOST excluded — the same set the DTO groups into. */
export const activeStagesSql = Prisma.sql`(${Prisma.join(ACTIVE_DEAL_STAGES.map((stage) => Prisma.sql`${stage}::deal_stage`))})`

/**
 * The nearest ACTIVE task per deal as a lateral join. The list and the board
 * both build on this exact fragment so `nearest_task.due_at` means one thing on
 * both surfaces — the quick-flag predicates below and the board reuse it rather
 * than each spelling the subquery out and risking a silent divergence.
 */
export const nearestActiveTaskLateral = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT t.due_at
    FROM deal_tasks t
    WHERE t.deal_id = d.id AND t.status = 'ACTIVE'::task_status
    ORDER BY t.due_at ASC, t.id ASC
    LIMIT 1
  ) nearest_task ON TRUE
`

/* ------------------------------------------------------------------ *
 * Urgency predicates
 *
 * These restate `evaluateDealCriticality` in SQL, because filtering, counting
 * and paging all have to happen in the database. There is exactly ONE SQL copy
 * of each rule and it lives here: the list, the board and the dashboard's
 * operational counters all call these, so the bidirectional drift guard in the
 * integration test covers every surface rather than only the one it was written
 * against.
 *
 * Aliases they read from the surrounding query: every predicate reads `d`, the
 * deal row. `overdueTaskSql` additionally reads `nearest_task` from
 * `nearestActiveTaskLateral`, and `criticalDealSql` composes that predicate — so
 * those two require the lateral to be joined, while `isOpenDealSql` and
 * `noNextStepSql` stand on `d` alone. `dealUrgencyFrom` below is the canonical
 * FROM clause that joins it.
 * ------------------------------------------------------------------ */

/** Stages still expected to carry a next step; WON and LOST are exempt. */
export const isOpenDealSql = Prisma.sql`d.stage IN ${openStagesSql}`

/** The nearest active task exists and its time has arrived. */
export function overdueTaskSql(now: Date): Prisma.Sql {
  return Prisma.sql`nearest_task.due_at IS NOT NULL AND nearest_task.due_at <= ${now}`
}

/**
 * No active task remains in the future.
 *
 * Deliberately NOT read off `nearest_task`, for the same reason `dueToday` below
 * scans the tasks instead of the lateral: the minimum due time answers "is
 * something already due", not "is anything still ahead". A deal carrying a call
 * overdue since yesterday AND a measurement booked for next Tuesday has its
 * nearest task in the past while a next step demonstrably exists, so this asks
 * the deal's active tasks directly — matching `hasFutureActiveTask` in
 * `evaluateDealCriticality`.
 */
export function noNextStepSql(now: Date): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM deal_tasks t
    WHERE t.deal_id = d.id
      AND t.status = 'ACTIVE'::task_status
      AND t.due_at > ${now}
  )`
}

/**
 * Open, and either already late or past its next-step grace window. The cutoff
 * comes from `nextStepGraceCutoff` so this predicate and the domain function
 * read the window from the same contract constant.
 */
export function criticalDealSql(now: Date): Prisma.Sql {
  return Prisma.sql`(${isOpenDealSql} AND ((${overdueTaskSql(now)}) OR (${noNextStepSql(now)} AND d.created_at <= ${nextStepGraceCutoff(now)})))`
}

/** Deals joined to their nearest active task — the shape the predicates expect. */
export const dealUrgencyFrom = Prisma.sql`FROM deals d ${nearestActiveTaskLateral}`

/**
 * Accepts the shared filter base (`DealBoardQuery`); the list passes its wider
 * query, whose extra paging and sort keys this function never reads, so board
 * and list select rows through one predicate builder.
 */
export function listConditions(query: DealBoardQuery, now: Date): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = []

  if (query.q) {
    const digits = phoneSearchDigits(query.q)
    const byName = Prisma.sql`c.name ILIKE ${likePattern(query.q)} ESCAPE '\\'`
    conditions.push(
      digits
        ? Prisma.sql`(${byName} OR c.phone_normalized LIKE ${likePattern(digits)} ESCAPE '\\')`
        : Prisma.sql`(${byName})`,
    )
  }
  if (query.stage) conditions.push(Prisma.sql`d.stage = ${query.stage}::deal_stage`)
  if (query.leadClass) conditions.push(Prisma.sql`d.lead_class = ${query.leadClass}::lead_class`)
  if (query.source) conditions.push(Prisma.sql`d.source = ${query.source}`)
  if (query.material) conditions.push(Prisma.sql`d.material = ${query.material}::material`)
  if (query.needTiming) conditions.push(Prisma.sql`d.need_timing = ${query.needTiming}`)
  if (query.responsibleUserId) {
    conditions.push(Prisma.sql`d.responsible_user_id = ${query.responsibleUserId}::uuid`)
  }
  if (query.submittedFrom) {
    conditions.push(Prisma.sql`d.submitted_at >= ${kyivDayStart(query.submittedFrom)}`)
  }
  if (query.submittedTo) {
    conditions.push(Prisma.sql`d.submitted_at < ${kyivDayEndExclusive(query.submittedTo)}`)
  }
  if (query.amountMin) {
    conditions.push(Prisma.sql`d.potential_amount >= ${query.amountMin}::numeric`)
  }
  if (query.amountMax) {
    conditions.push(Prisma.sql`d.potential_amount <= ${query.amountMax}::numeric`)
  }

  // The quick flags select on the shared urgency predicates above, so the list,
  // the board and the dashboard counters cannot drift apart.
  if (query.noNextStep) {
    conditions.push(Prisma.sql`(${isOpenDealSql} AND ${noNextStepSql(now)})`)
  }
  if (query.overdue) conditions.push(Prisma.sql`(${isOpenDealSql} AND ${overdueTaskSql(now)})`)
  if (query.isCritical) conditions.push(criticalDealSql(now))
  if (query.dueToday) {
    /**
     * "Сегодня" is an operational work filter, so it is gated by `isOpen` like
     * the other three quick flags: a WON or LOST deal that still carries an
     * active task due today is closed work and must not surface here. Within an
     * open deal it looks at any active task in the Kyiv day rather than only the
     * nearest one, so a deal carrying both an overdue task and one due today is
     * genuinely counted as due today.
     */
    const today = kyivTodayRange(now)
    conditions.push(
      Prisma.sql`(${isOpenDealSql} AND EXISTS (
        SELECT 1 FROM deal_tasks t
        WHERE t.deal_id = d.id
          AND t.status = 'ACTIVE'::task_status
          AND t.due_at >= ${today.start}
          AND t.due_at < ${today.end}
      ))`,
    )
  }

  return conditions
}
