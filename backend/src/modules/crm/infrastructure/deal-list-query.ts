import {
  OPEN_DEAL_STAGES,
  type DealListQuery,
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

export function listConditions(query: DealListQuery, now: Date): Prisma.Sql[] {
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

  /**
   * The quick flags below restate `evaluateDealCriticality` in SQL, because
   * filtering and paging have to happen in the database. Both sides read the
   * open-stage set and the grace window from the same contract constants, and
   * the integration test asserts they agree in both directions.
   */
  const isOpen = Prisma.sql`d.stage IN ${openStagesSql}`
  const overdue = Prisma.sql`nearest_task.due_at IS NOT NULL AND nearest_task.due_at <= ${now}`
  const noNextStep = Prisma.sql`(nearest_task.due_at IS NULL OR nearest_task.due_at <= ${now})`

  if (query.noNextStep) conditions.push(Prisma.sql`(${isOpen} AND ${noNextStep})`)
  if (query.overdue) conditions.push(Prisma.sql`(${isOpen} AND ${overdue})`)
  if (query.isCritical) {
    conditions.push(
      Prisma.sql`(${isOpen} AND ((${overdue}) OR (${noNextStep} AND d.created_at <= ${nextStepGraceCutoff(now)})))`,
    )
  }
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
      Prisma.sql`(${isOpen} AND EXISTS (
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
