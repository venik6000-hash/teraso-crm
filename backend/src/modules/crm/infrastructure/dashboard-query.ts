import {
  DASHBOARD_SOURCE_LIMIT,
  FUNNEL_TRANSITIONS,
  type DashboardDto,
  type DashboardFunnelStepDto,
  type DashboardPeriod,
  type DashboardRangeDto,
  type DashboardSourceDto,
  type DealStage,
} from '@teraso-crm/contracts'

import { Prisma } from '../../../generated/prisma/client'
import {
  kyivDateOf,
  kyivDayEndExclusive,
  kyivDayStart,
  kyivTodayRange,
} from '../domain/kyiv-time'
import {
  criticalDealSql,
  dealUrgencyFrom,
  isOpenDealSql,
  noNextStepSql,
} from './deal-list-query'
import { toMoneyString } from './serialization'

/* ------------------------------------------------------------------ *
 * Dashboard aggregation (PRD 7.8)
 *
 * Every total is summed by PostgreSQL over the Decimal columns and comes back as
 * a Prisma.Decimal, which is then serialized once through `toMoneyString`.
 * Nothing is added up in JavaScript at any point, here or in the browser: a
 * 14,2 decimal does not survive a round trip through a double, and a dashboard
 * that quietly disagrees with the deal cards about revenue is worse than none.
 *
 * The urgency counters reuse the predicates in deal-list-query.ts rather than
 * restating them, so the list, the board and these counters cannot drift.
 *
 * Every request value is bound through Prisma's tagged template. Nothing here
 * concatenates request data into SQL.
 * ------------------------------------------------------------------ */

/**
 * Trailing window lengths in days, ending on the current Kyiv day.
 *
 * Calendar buckets were the obvious alternative and are worse for this product:
 * on the first of a month a calendar «месяц» shows an empty dashboard, which
 * reads as "the CRM lost my data" rather than "the month just started".
 */
const TRAILING_WINDOW_DAYS: Record<'today' | 'week' | 'month', number> = {
  today: 1,
  week: 7,
  month: 30,
}

const DAY_MS = 24 * 60 * 60 * 1000

/** A UTC half-open range, already resolved against Kyiv day boundaries. */
type ResolvedRange = { start: Date; end: Date; range: DashboardRangeDto }

/**
 * Turns a validated period into Kyiv day boundaries.
 *
 * `custom` is guaranteed by the contract to carry both dates in the right
 * order, so this never has to repair one. The resolved calendar dates are
 * echoed back in the response, which is what lets the screen name the window it
 * is showing without recomputing Kyiv offsets in the browser.
 */
export function resolveDashboardRange(period: DashboardPeriod, now: Date): ResolvedRange {
  if (period.period === 'custom') {
    return {
      start: kyivDayStart(period.from!),
      end: kyivDayEndExclusive(period.to!),
      range: { period: 'custom', from: period.from!, to: period.to! },
    }
  }

  const today = kyivTodayRange(now)
  const days = TRAILING_WINDOW_DAYS[period.period]
  // The window ends with today, so a 1-day window is today alone.
  const to = kyivDateOf(now)
  const from = shiftIsoDate(to, -(days - 1))

  return {
    start: kyivDayStart(from),
    end: today.end,
    range: { period: period.period, from, to },
  }
}

/**
 * Moves a calendar date by whole days.
 *
 * The shift happens against UTC midnight rather than against the resolved Kyiv
 * instant, because UTC has no clock changes: subtracting six times 24 hours
 * from the START of a Kyiv day lands an hour early whenever the window spans
 * the spring change, and therefore resolves to the previous date. Dates are
 * shifted as dates; only then are they turned into Kyiv boundaries.
 */
function shiftIsoDate(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00.000Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10)
}

/**
 * The scalar half of the report: five period measures and five snapshots, in one
 * round trip. They are subqueries of a single SELECT rather than ten separate
 * statements so every figure describes the same instant — issued separately, a
 * deal turning critical between two of them would produce a report that
 * contradicts itself.
 */
type ScalarRow = {
  open_pipeline_amount: Prisma.Decimal
  prepayment_received_amount: Prisma.Decimal
  won_payment_amount: Prisma.Decimal
  won_deal_count: bigint
  new_lead_count: bigint
  tasks_due_today_count: bigint
  overdue_task_count: bigint
  no_next_step_deal_count: bigint
  critical_deal_count: bigint
}

type FunnelRow = { from_stage: DealStage; to_stage: DealStage; transition_count: bigint }

type SourceRow = {
  source: string
  utm_source: string | null
  lead_count: bigint
  open_pipeline_amount: Prisma.Decimal
  won_count: bigint
  won_amount: Prisma.Decimal
}

type DashboardQueryClient = {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>
}

export async function queryDashboard(
  client: DashboardQueryClient,
  period: DashboardPeriod,
  now: Date,
): Promise<DashboardDto> {
  const { start, end, range } = resolveDashboardRange(period, now)
  const today = kyivTodayRange(now)

  const [scalars, funnel, sources] = await Promise.all([
    client.$queryRaw<ScalarRow[]>(scalarQuery({ start, end, now, today })),
    client.$queryRaw<FunnelRow[]>(funnelQuery(start, end)),
    client.$queryRaw<SourceRow[]>(sourceQuery(start, end)),
  ])

  const totals = scalars[0]!

  return {
    range,
    openPipelineAmount: money(totals.open_pipeline_amount),
    prepaymentReceivedAmount: money(totals.prepayment_received_amount),
    wonPaymentAmount: money(totals.won_payment_amount),
    wonDealCount: count(totals.won_deal_count),
    newLeadCount: count(totals.new_lead_count),
    tasksDueTodayCount: count(totals.tasks_due_today_count),
    overdueTaskCount: count(totals.overdue_task_count),
    noNextStepDealCount: count(totals.no_next_step_deal_count),
    criticalDealCount: count(totals.critical_deal_count),
    funnel: toFunnelSteps(funnel),
    sources: sources.map(toSourceRow),
  }
}

function scalarQuery({
  end,
  now,
  start,
  today,
}: {
  end: Date
  now: Date
  start: Date
  today: { start: Date; end: Date }
}): Prisma.Sql {
  /**
   * Received money is attributed by its own payment date, never by the deal's
   * current stage. That is the whole reason a prepayment is not a win: a deal
   * that was prepaid in May and fully paid in July contributes to May's
   * prepayments and July's revenue, and to neither figure twice.
   */
  const prepaidInPeriod = Prisma.sql`d.prepayment_paid_at >= ${start} AND d.prepayment_paid_at < ${end}`
  const paidInPeriod = Prisma.sql`d.full_payment_paid_at >= ${start} AND d.full_payment_paid_at < ${end}`
  /** Open work only: a task still attached to a closed deal is not on anyone's list. */
  const openTaskDeal = Prisma.sql`
    t.status = 'ACTIVE'::task_status
    AND EXISTS (SELECT 1 FROM deals d WHERE d.id = t.deal_id AND ${isOpenDealSql})
  `

  return Prisma.sql`
    SELECT
      (
        SELECT COALESCE(SUM(d.potential_amount), 0)
        FROM deals d
        WHERE ${isOpenDealSql} AND d.potential_amount IS NOT NULL
      ) AS open_pipeline_amount,
      (
        SELECT COALESCE(SUM(d.prepayment_amount), 0)
        FROM deals d
        WHERE ${prepaidInPeriod}
      ) AS prepayment_received_amount,
      (
        SELECT COALESCE(SUM(d.full_payment_amount), 0)
        FROM deals d
        WHERE ${paidInPeriod}
      ) AS won_payment_amount,
      (SELECT COUNT(*) FROM deals d WHERE ${paidInPeriod}) AS won_deal_count,
      (
        SELECT COUNT(*)
        FROM deals d
        WHERE d.submitted_at >= ${start} AND d.submitted_at < ${end}
      ) AS new_lead_count,
      (
        SELECT COUNT(*)
        FROM deal_tasks t
        WHERE ${openTaskDeal} AND t.due_at >= ${today.start} AND t.due_at < ${today.end}
      ) AS tasks_due_today_count,
      (
        SELECT COUNT(*)
        FROM deal_tasks t
        WHERE ${openTaskDeal} AND t.due_at <= ${now}
      ) AS overdue_task_count,
      (
        SELECT COUNT(*) ${dealUrgencyFrom}
        WHERE ${isOpenDealSql} AND ${noNextStepSql(now)}
      ) AS no_next_step_deal_count,
      (
        SELECT COUNT(*) ${dealUrgencyFrom}
        WHERE ${criticalDealSql(now)}
      ) AS critical_deal_count
  `
}

/**
 * Counts real funnel movement over the period.
 *
 * It reads the typed `from_stage`/`to_stage` columns on STAGE_CHANGED rows, not
 * the deals' current stage, so a deal that reached WON before the window does
 * not inflate the report and one that moved twice is counted twice. A REOPENED
 * activity carries no stage pair at all and therefore cannot be counted here —
 * which is exactly why Task 4 writes it as its own kind.
 */
function funnelQuery(start: Date, end: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT a.from_stage, a.to_stage, COUNT(*) AS transition_count
    FROM deal_activities a
    WHERE a.kind = 'STAGE_CHANGED'::deal_activity_kind
      AND a.from_stage IS NOT NULL
      AND a.to_stage IS NOT NULL
      AND a.created_at >= ${start}
      AND a.created_at < ${end}
    GROUP BY a.from_stage, a.to_stage
  `
}

/**
 * The source breakdown (PRD 7.8 item 6).
 *
 * `FILTER` is what keeps the three measures in one pass despite answering
 * different questions: leads and wins are counted inside the window, while open
 * pipeline is a snapshot, so a source that produced nothing this month but
 * still holds open deals stays visible. Rows where every measure is zero are
 * dropped — they are sources whose only deals were lost outside the window and
 * would pad the table with noise.
 */
function sourceQuery(start: Date, end: Date): Prisma.Sql {
  const submittedInPeriod = Prisma.sql`d.submitted_at >= ${start} AND d.submitted_at < ${end}`
  const paidInPeriod = Prisma.sql`d.full_payment_paid_at >= ${start} AND d.full_payment_paid_at < ${end}`

  return Prisma.sql`
    SELECT
      d.source,
      la.utm_source,
      COUNT(*) FILTER (WHERE ${submittedInPeriod}) AS lead_count,
      COALESCE(SUM(d.potential_amount) FILTER (WHERE ${isOpenDealSql}), 0) AS open_pipeline_amount,
      COUNT(*) FILTER (WHERE ${paidInPeriod}) AS won_count,
      COALESCE(SUM(d.full_payment_amount) FILTER (WHERE ${paidInPeriod}), 0) AS won_amount
    FROM deals d
    LEFT JOIN lead_attributions la ON la.deal_id = d.id
    GROUP BY d.source, la.utm_source
    HAVING
      COUNT(*) FILTER (WHERE ${submittedInPeriod}) > 0
      OR COUNT(*) FILTER (WHERE ${paidInPeriod}) > 0
      OR COALESCE(SUM(d.potential_amount) FILTER (WHERE ${isOpenDealSql}), 0) > 0
    ORDER BY lead_count DESC, won_amount DESC, d.source ASC
    LIMIT ${DASHBOARD_SOURCE_LIMIT}
  `
}

/**
 * Projects the grouped counts onto the funnel's fixed shape.
 *
 * The report always lists all four adjacent pairs, including the ones with no
 * movement: a missing row would render as a gap the owner has to interpret,
 * whereas an explicit zero says "nobody advanced here", which is the actual
 * finding. Pairs that are not adjacent — there are none the domain can produce —
 * are simply not looked up.
 */
function toFunnelSteps(rows: ReadonlyArray<FunnelRow>): DashboardFunnelStepDto[] {
  const counts = new Map(
    rows.map((row) => [`${row.from_stage}->${row.to_stage}`, count(row.transition_count)]),
  )
  const steps = FUNNEL_TRANSITIONS.map((transition) => ({
    ...transition,
    count: counts.get(`${transition.fromStage}->${transition.toStage}`) ?? 0,
  }))

  // Normalized against the top of the funnel; see dashboardFunnelStepSchema.
  const top = steps[0]?.count ?? 0
  return steps.map((step) => ({
    ...step,
    share: top === 0 ? 0 : step.count / top,
  }))
}

function toSourceRow(row: SourceRow): DashboardSourceDto {
  return {
    source: row.source,
    utmSource: row.utm_source,
    leadCount: count(row.lead_count),
    openPipelineAmount: money(row.open_pipeline_amount),
    wonCount: count(row.won_count),
    wonAmount: money(row.won_amount),
  }
}

/** `COALESCE(..., 0)` guarantees a value, so this never has a null to handle. */
function money(amount: Prisma.Decimal): string {
  return toMoneyString(amount)!
}

/** PostgreSQL `COUNT(*)` arrives as a bigint; every dashboard count is small. */
function count(value: bigint | number): number {
  return Number(value)
}
