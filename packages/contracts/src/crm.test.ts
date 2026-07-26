import { describe, expect, test } from 'bun:test'

// Imported through two paths on purpose: the module paths exercise the schemas,
// and the './index' import smoke-tests that the barrel actually re-exports them,
// since every consumer outside this package imports from '@teraso-crm/contracts'.
import type {
  DealActivityDto,
  DealDetailDto,
  DealSummaryDto,
  DealTaskDto,
} from './crm'
import {
  ACTIVE_DEAL_STAGES,
  DASHBOARD_SOURCE_LIMIT,
  FUNNEL_TRANSITIONS,
  dashboardFunnelStepSchema,
  dashboardPeriodSchema,
  dashboardSchema,
  dealActivityMetadataSchema,
  dealActivitySchema,
  dealBoardQuerySchema,
  dealCreateSchema,
  dealDetailSchema,
  dealListQuerySchema,
  dealListResponseSchema,
  dealStageChangeSchema,
  dealSummarySchema,
  dealTaskSchema,
  dealUpdateSchema,
  inboundQuizLeadSchema,
  leadClassSchema,
  taskCreateSchema,
  taskUpdateSchema,
} from './crm'
import { moneyAmountSchema, moneyResponseSchema } from './primitives'
import {
  notificationReadRequestSchema,
  notificationSchema,
  pushSubscriptionCreateSchema,
} from './notifications'
import { APP_PATH_PREFIX, dealPath } from './app-paths'
import { dealStageSchema, lossReasonSchema, notificationKindSchema } from './index'

const inboundLead = {
  externalId: 'lead_68f0c1',
  receivedAt: '2026-07-23T09:00:00.000Z',
  name: 'Олександр',
  phone: '+380935335353',
  source: 'teraso.com.ua',
  form: 'Квіз',
  landingUrl: 'https://teraso.com.ua/kviz',
} as const

const uuid = (last: string) => `019c0000-0000-7000-8000-00000000000${last}`

const task: DealTaskDto = {
  id: uuid('2'),
  dealId: uuid('1'),
  kind: 'CALL',
  title: 'Первично обработать заявку',
  dueAt: '2026-07-23T09:30:00.000Z',
  status: 'ACTIVE',
  assigneeUserId: null,
  assigneeName: null,
  completedAt: null,
  createdAt: '2026-07-23T09:00:00.000Z',
}

const summary: DealSummaryDto = {
  id: uuid('1'),
  client: {
    id: uuid('3'),
    name: 'Олександр',
    phoneNormalized: '+380935335353',
    createdAt: '2026-07-23T09:00:00.000Z',
  },
  stage: 'NEW',
  leadClass: null,
  lossReason: null,
  source: 'teraso.com.ua',
  form: 'Квіз',
  submittedAt: '2026-07-23T09:00:00.000Z',
  potentialAmount: '65000.00',
  responsibleUserId: null,
  responsibleName: null,
  nearestActiveTask: task,
  isCritical: false,
  noNextStep: false,
  hasOverdueTask: false,
  createdAt: '2026-07-23T09:00:00.000Z',
}

const activity: DealActivityDto = {
  id: uuid('4'),
  dealId: uuid('1'),
  kind: 'STAGE_CHANGED',
  text: null,
  fromStage: 'NEW',
  toStage: 'QUALIFIED',
  authorUserId: null,
  authorName: null,
  metadata: null,
  createdAt: '2026-07-23T09:10:00.000Z',
}

const detail: DealDetailDto = {
  ...summary,
  landingUrl: 'https://teraso.com.ua/kviz',
  material: 'WPC',
  areaLabel: '30-50 м²',
  budgetLabel: 'до 100 000 грн',
  objectType: 'Тераса',
  needTiming: 'Зараз',
  preferredChannel: 'TELEGRAM',
  prepaymentAmount: null,
  prepaymentPaidAt: null,
  fullPaymentAmount: null,
  fullPaymentPaidAt: null,
  currentNote: null,
  updatedAt: '2026-07-23T09:10:00.000Z',
  tasks: [task],
  activities: [activity],
  hasMoreTasks: false,
  hasMoreActivities: false,
  attribution: null,
}

describe('CRM contracts', () => {
  test('requires a stable incoming id', () => {
    expect(() => inboundQuizLeadSchema.parse({ phone: '+380935335353' })).toThrow()
  })

  test('requires an ISO due date', () => {
    expect(() => taskCreateSchema.parse({ kind: 'CALL', dueAt: 'tomorrow' })).toThrow()
  })
})

describe('CRM enums', () => {
  test('rejects a lead class outside A, B and C', () => {
    expect(leadClassSchema.parse('A')).toBe('A')
    expect(leadClassSchema.parse('C')).toBe('C')
    expect(() => leadClassSchema.parse('D')).toThrow()
    expect(() => leadClassSchema.parse('a')).toThrow()
  })

  test('keeps the funnel and loss vocabulary in the order the migration froze', () => {
    expect(dealStageSchema.options).toEqual([
      'NEW',
      'QUALIFIED',
      'PROPOSAL_SENT',
      'PREPAYMENT',
      'WON',
      'LOST',
    ])
    expect(lossReasonSchema.options).toEqual([
      'WRONG_NUMBER',
      'NO_ANSWER',
      'INAPPROPRIATE',
      'IGNORED_AFTER_CALL',
      'IGNORED_AFTER_SCORING',
      'CURIOSITY',
      'CHOSEN_COMPETITOR',
      'NEED_DISAPPEARED',
    ])
    expect(notificationKindSchema.options).toEqual([
      'NEW_LEAD',
      'TASK_DUE',
      'TASK_OVERDUE',
      'LEAD_NEEDS_ACTION',
    ])
  })
})

describe('deal stage changes', () => {
  test('refuses to close a deal as lost without a reason', () => {
    expect(() => dealStageChangeSchema.parse({ stage: 'LOST' })).toThrow()
    expect(dealStageChangeSchema.parse({ stage: 'LOST', lossReason: 'NO_ANSWER' })).toEqual({
      stage: 'LOST',
      lossReason: 'NO_ANSWER',
    })
    expect(() => dealStageChangeSchema.parse({ stage: 'LOST', lossReason: null })).toThrow()
  })

  test('refuses a loss reason on a stage that is not a loss', () => {
    expect(() =>
      dealStageChangeSchema.parse({ stage: 'QUALIFIED', lossReason: 'CURIOSITY' }),
    ).toThrow()
  })

  test('lets a reopen clear the stored loss reason', () => {
    expect(dealStageChangeSchema.parse({ stage: 'NEW', lossReason: null })).toEqual({
      stage: 'NEW',
      lossReason: null,
    })
  })

  test('requires both amount and date for prepayment and full payment', () => {
    expect(() => dealStageChangeSchema.parse({ stage: 'PREPAYMENT' })).toThrow()
    expect(() =>
      dealStageChangeSchema.parse({ stage: 'PREPAYMENT', prepaymentAmount: '20000.00' }),
    ).toThrow()
    expect(
      dealStageChangeSchema.parse({
        stage: 'PREPAYMENT',
        prepaymentAmount: '20000.00',
        prepaymentPaidAt: '2026-07-23T09:00:00.000Z',
      }),
    ).toMatchObject({ stage: 'PREPAYMENT' })

    expect(() => dealStageChangeSchema.parse({ stage: 'WON' })).toThrow()
    expect(
      dealStageChangeSchema.parse({
        stage: 'WON',
        fullPaymentAmount: '80000.00',
        fullPaymentPaidAt: '2026-07-23T09:00:00.000Z',
      }),
    ).toMatchObject({ stage: 'WON' })
  })

  // The dashboard sums received money from the payment DATES, not from the
  // stage, so a payment field parked on an unrelated stage is counted as revenue.
  test('refuses payment fields on a stage that did not earn them', () => {
    expect(() =>
      dealStageChangeSchema.parse({
        stage: 'QUALIFIED',
        fullPaymentAmount: '80000.00',
        fullPaymentPaidAt: '2026-07-23T09:00:00.000Z',
      }),
    ).toThrow()
    expect(() =>
      dealStageChangeSchema.parse({
        stage: 'QUALIFIED',
        prepaymentAmount: '20000.00',
        prepaymentPaidAt: '2026-07-23T09:00:00.000Z',
      }),
    ).toThrow()
    expect(() =>
      dealStageChangeSchema.parse({ stage: 'NEW', fullPaymentPaidAt: '2026-07-23T09:00:00.000Z' }),
    ).toThrow()
    // A full payment does not re-state the prepayment: it is already stored.
    expect(() =>
      dealStageChangeSchema.parse({
        stage: 'WON',
        fullPaymentAmount: '80000.00',
        fullPaymentPaidAt: '2026-07-23T09:00:00.000Z',
        prepaymentAmount: '20000.00',
        prepaymentPaidAt: '2026-07-20T09:00:00.000Z',
      }),
    ).toThrow()
    expect(() =>
      dealStageChangeSchema.parse({
        stage: 'PREPAYMENT',
        prepaymentAmount: '20000.00',
        prepaymentPaidAt: '2026-07-23T09:00:00.000Z',
        fullPaymentAmount: '80000.00',
      }),
    ).toThrow()
  })
})

describe('deal tasks', () => {
  test('rejects an invalid due time even when every other field is valid', () => {
    const draft = { kind: 'CALL', title: 'Перезвонить', dueAt: '2026-07-23T09:30:00.000Z' }
    expect(taskCreateSchema.parse(draft)).toMatchObject({ kind: 'CALL' })
    expect(() => taskCreateSchema.parse({ ...draft, dueAt: 'tomorrow' })).toThrow()
    expect(() => taskCreateSchema.parse({ ...draft, dueAt: '2026-07-23' })).toThrow()
    expect(() => taskCreateSchema.parse({ ...draft, kind: 'EMAIL' })).toThrow()
    expect(() => taskCreateSchema.parse({ ...draft, title: '   ' })).toThrow()
    // Creates cannot clear an assignee; only a PATCH can.
    expect(() => taskCreateSchema.parse({ ...draft, assigneeUserId: null })).toThrow()
  })

  test('keeps instants in UTC so Europe/Kyiv stays a presentation concern', () => {
    expect(() =>
      taskCreateSchema.parse({
        kind: 'CALL',
        title: 'Перезвонить',
        dueAt: '2026-07-23T12:30:00+03:00',
      }),
    ).toThrow()
  })

  test('updates one field at a time and refuses an empty patch', () => {
    expect(taskUpdateSchema.parse({ status: 'COMPLETED' })).toEqual({ status: 'COMPLETED' })
    expect(taskUpdateSchema.parse({ assigneeUserId: null })).toEqual({ assigneeUserId: null })
    expect(taskUpdateSchema.parse({ dueAt: '2026-07-24T09:00:00.000Z' })).toEqual({
      dueAt: '2026-07-24T09:00:00.000Z',
    })
    expect(() => taskUpdateSchema.parse({})).toThrow()
    expect(() => taskUpdateSchema.parse({ status: 'DONE' })).toThrow()
    expect(() => taskUpdateSchema.parse({ dealId: uuid('1') })).toThrow()
  })
})

describe('deal creation', () => {
  test('accepts the minimum a manual deal needs', () => {
    expect(
      dealCreateSchema.parse({ name: '  Олександр  ', phone: ' +380935335353 ', source: 'Звонок' }),
    ).toEqual({ name: 'Олександр', phone: '+380935335353', source: 'Звонок' })
  })

  test('carries an optional initial task and the need fields', () => {
    const created = dealCreateSchema.parse({
      name: 'Олександр',
      phone: '+380935335353',
      source: 'Звонок',
      material: 'WOOD',
      potentialAmount: '65000.00',
      preferredChannel: 'VIBER',
      initialTask: {
        kind: 'CALL',
        title: 'Перезвонить',
        dueAt: '2026-07-23T09:30:00.000Z',
      },
    })
    expect(created).toMatchObject({ material: 'WOOD', preferredChannel: 'VIBER' })
    expect(created.initialTask).toMatchObject({ kind: 'CALL' })
  })

  test('refuses identity it cannot use, and any funnel field', () => {
    expect(() => dealCreateSchema.parse({ phone: '+380935335353', source: 'Звонок' })).toThrow()
    expect(() => dealCreateSchema.parse({ name: 'A', phone: '123', source: 'Звонок' })).toThrow()
    expect(() =>
      dealCreateSchema.parse({ name: '  ', phone: '+380935335353', source: 'x' }),
    ).toThrow()
    // Stage, loss and payment fields move only through dealStageChangeSchema.
    const base = { name: 'A', phone: '+380935335353', source: 'x' }
    expect(() => dealCreateSchema.parse({ ...base, stage: 'WON' })).toThrow()
    expect(() => dealCreateSchema.parse({ ...base, lossReason: 'NO_ANSWER' })).toThrow()
    expect(() => dealCreateSchema.parse({ ...base, fullPaymentAmount: '80000.00' })).toThrow()
    expect(() => dealCreateSchema.parse({ ...base, initialTask: { kind: 'CALL' } })).toThrow()
  })
})

describe('money amounts', () => {
  test('accepts only non-negative decimal strings within Decimal(14, 2)', () => {
    expect(moneyAmountSchema.parse('65000.00')).toBe('65000.00')
    expect(moneyAmountSchema.parse('65000')).toBe('65000')
    expect(moneyAmountSchema.parse('65000.5')).toBe('65000.5')
    expect(moneyAmountSchema.parse('0.00')).toBe('0.00')
    expect(moneyAmountSchema.parse('  65000.00  ')).toBe('65000.00')
    expect(moneyAmountSchema.parse('999999999999.99')).toBe('999999999999.99')
  })

  test('rejects every format that would silently round or flip a sign', () => {
    expect(() => moneyAmountSchema.parse('65000.999')).toThrow()
    expect(() => moneyAmountSchema.parse('-1000.00')).toThrow()
    expect(() => moneyAmountSchema.parse('+65000.00')).toThrow()
    expect(() => moneyAmountSchema.parse('')).toThrow()
    expect(() => moneyAmountSchema.parse('65 000.00')).toThrow()
    expect(() => moneyAmountSchema.parse('65,000.00')).toThrow()
    expect(() => moneyAmountSchema.parse('1234567890123.00')).toThrow()
    expect(() => moneyAmountSchema.parse(65000)).toThrow()
  })

  // Decimal.toString() gives "65000" and Decimal.toFixed(2) gives "65000.00";
  // both satisfy the request form, so responses pin the canonical one.
  test('requires exactly two decimals on the way out', () => {
    expect(moneyResponseSchema.parse('65000.00')).toBe('65000.00')
    expect(moneyResponseSchema.parse('0.00')).toBe('0.00')
    expect(() => moneyResponseSchema.parse('65000')).toThrow()
    expect(() => moneyResponseSchema.parse('65000.0')).toThrow()
    expect(() => moneyResponseSchema.parse('65000.000')).toThrow()
    expect(() => dealSummarySchema.parse({ ...summary, potentialAmount: '65000' })).toThrow()
  })
})

describe('deal list query', () => {
  test('reads a quick filter of "false" as off rather than on', () => {
    const parsed = dealListQuerySchema.parse({
      noNextStep: 'false',
      overdue: '0',
      dueToday: 'true',
      isCritical: '1',
    })
    expect(parsed.noNextStep).toBe(false)
    expect(parsed.overdue).toBe(false)
    expect(parsed.dueToday).toBe(true)
    expect(parsed.isCritical).toBe(true)
    expect(dealListQuerySchema.parse({ overdue: true }).overdue).toBe(true)
    expect(() => dealListQuerySchema.parse({ overdue: 'yes' })).toThrow()
    expect(() => dealListQuerySchema.parse({ overdue: 2 })).toThrow()
  })

  test('defaults every quick filter to off and sorts by newest submission', () => {
    expect(dealListQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 20,
      sort: 'submittedAt',
      direction: 'desc',
      noNextStep: false,
      overdue: false,
      dueToday: false,
      isCritical: false,
    })
  })

  test('coerces paging, drops blank text filters and rejects unknown ones', () => {
    const parsed = dealListQuerySchema.parse({
      q: '  Олександр  ',
      source: '',
      stage: 'PREPAYMENT',
      leadClass: 'B',
      needTiming: 'Зараз',
      responsibleUserId: uuid('1'),
      amountMin: '10000.00',
      page: '2',
      pageSize: '50',
      sort: 'nearestTaskDueAt',
      direction: 'asc',
    })
    expect(parsed).toMatchObject({
      q: 'Олександр',
      stage: 'PREPAYMENT',
      leadClass: 'B',
      page: 2,
      pageSize: 50,
      sort: 'nearestTaskDueAt',
      direction: 'asc',
    })
    expect(parsed.source).toBeUndefined()
    expect(() => dealListQuerySchema.parse({ sort: 'createdAt' })).toThrow()
    expect(() => dealListQuerySchema.parse({ unknownFilter: 'x' })).toThrow()
    expect(() => dealListQuerySchema.parse({ responsibleUserId: 'nope' })).toThrow()
  })

  test('bounds paging so a hostile query cannot ask for the whole table', () => {
    expect(() => dealListQuerySchema.parse({ page: '0' })).toThrow()
    expect(() => dealListQuerySchema.parse({ page: '-1' })).toThrow()
    expect(() => dealListQuerySchema.parse({ page: '1001' })).toThrow()
    expect(dealListQuerySchema.parse({ page: '1000' }).page).toBe(1000)
    expect(() => dealListQuerySchema.parse({ pageSize: '101' })).toThrow()
    expect(dealListQuerySchema.parse({ pageSize: '100' }).pageSize).toBe(100)
    expect(() => dealListQuerySchema.parse({ pageSize: '1.5' })).toThrow()
  })

  test('the board takes filters but neither paging nor sorting', () => {
    expect(dealBoardQuerySchema.parse({ stage: 'NEW', isCritical: 'true' })).toMatchObject({
      stage: 'NEW',
      isCritical: true,
    })
    expect(() => dealBoardQuerySchema.parse({ page: '2' })).toThrow()
    expect(() => dealBoardQuerySchema.parse({ sort: 'submittedAt' })).toThrow()
  })
})

describe('deal updates', () => {
  test('separates an untouched field from one that is explicitly cleared', () => {
    expect(dealUpdateSchema.parse({ leadClass: 'A' })).toEqual({ leadClass: 'A' })
    expect(dealUpdateSchema.parse({ potentialAmount: null })).toEqual({ potentialAmount: null })
    expect(dealUpdateSchema.parse({ currentNote: 'Ждёт бюджет' })).toEqual({
      currentNote: 'Ждёт бюджет',
    })
    expect(() => dealUpdateSchema.parse({})).toThrow()
    expect(() => dealUpdateSchema.parse({ potentialAmount: '65000.999' })).toThrow()
  })

  test('cannot move the funnel or invent a payment', () => {
    expect(() => dealUpdateSchema.parse({ stage: 'WON' })).toThrow()
    expect(() => dealUpdateSchema.parse({ lossReason: 'NO_ANSWER' })).toThrow()
    expect(() => dealUpdateSchema.parse({ fullPaymentAmount: '80000.00' })).toThrow()
    expect(() => dealUpdateSchema.parse({ fullPaymentPaidAt: '2026-07-23T09:00:00.000Z' })).toThrow()
  })
})

describe('deal activity', () => {
  test('carries the stage transition as typed fields, not as loose metadata', () => {
    expect(dealActivitySchema.parse(activity)).toMatchObject({
      fromStage: 'NEW',
      toStage: 'QUALIFIED',
    })
    expect(
      dealActivitySchema.parse({ ...activity, fromStage: null, toStage: 'NEW' }),
    ).toMatchObject({ toStage: 'NEW' })
    expect(() => dealActivitySchema.parse({ ...activity, toStage: 'ARCHIVED' })).toThrow()
    // The funnel must never depend on a key the metadata bag may or may not have.
    expect(() => dealActivityMetadataSchema.parse({ toStage: 'QUALIFIED' })).toThrow()
  })

  test('records field level before and after values in metadata', () => {
    const metadata = { changes: [{ field: 'leadClass', before: null, after: 'B' }] }
    expect(dealActivityMetadataSchema.parse(metadata)).toEqual(metadata)
    expect(() => dealActivityMetadataSchema.parse({ typoedKey: 'NEW' })).toThrow()
    expect(() => dealActivityMetadataSchema.parse({ changes: [{ field: 'x' }] })).toThrow()
  })
})

describe('response DTOs', () => {
  test('round-trip the shapes a repository must produce', () => {
    expect(dealTaskSchema.parse(task)).toEqual(task)
    expect(dealSummarySchema.parse(summary)).toEqual(summary)
    expect(dealDetailSchema.parse(detail)).toEqual(detail)
    expect(
      dealListResponseSchema.parse({
        items: [summary],
        page: 1,
        pageSize: 20,
        total: 1,
        hasNext: false,
      }),
    ).toMatchObject({ total: 1, hasNext: false })
  })

  test('reject an extra column leaking out of the repository', () => {
    expect(() => dealSummarySchema.parse({ ...summary, currentNote: 'internal' })).toThrow()
    expect(() => dealTaskSchema.parse({ ...task, dealStage: 'NEW' })).toThrow()
    expect(() => dealDetailSchema.parse({ ...detail, passwordHash: 'must-not-leak' })).toThrow()
  })

  test('require the fields the UI renders urgency and history from', () => {
    const { isCritical, ...withoutCritical } = summary
    expect(() => dealSummarySchema.parse(withoutCritical)).toThrow()
    // Both truncation flags are required, so a producer that caps a collection
    // cannot silently omit telling the UI that it did.
    const { hasMoreActivities, ...withoutActivityFlag } = detail
    expect(() => dealDetailSchema.parse(withoutActivityFlag)).toThrow()
    const { hasMoreTasks, ...withoutTaskFlag } = detail
    expect(() => dealDetailSchema.parse(withoutTaskFlag)).toThrow()
    expect(dealSummarySchema.parse({ ...summary, nearestActiveTask: null })).toMatchObject({
      nearestActiveTask: null,
    })
  })

  test('cap embedded tasks and history so paging can be added without a breaking change', () => {
    const manyActivities = Array.from({ length: 51 }, () => activity)
    expect(() => dealDetailSchema.parse({ ...detail, activities: manyActivities })).toThrow()
    const manyTasks = Array.from({ length: 51 }, () => task)
    expect(() => dealDetailSchema.parse({ ...detail, tasks: manyTasks })).toThrow()
  })
})

describe('dashboard periods', () => {
  test('accepts the named periods and requires a full custom range', () => {
    expect(dashboardPeriodSchema.parse({})).toEqual({ period: 'month' })
    expect(dashboardPeriodSchema.parse({ period: 'today' })).toEqual({ period: 'today' })
    expect(
      dashboardPeriodSchema.parse({ period: 'custom', from: '2026-07-01', to: '2026-07-23' }),
    ).toEqual({ period: 'custom', from: '2026-07-01', to: '2026-07-23' })
    expect(() => dashboardPeriodSchema.parse({ period: 'custom' })).toThrow()
    expect(() => dashboardPeriodSchema.parse({ period: 'custom', from: '2026-07-01' })).toThrow()
    expect(() =>
      dashboardPeriodSchema.parse({ period: 'custom', from: '2026-07-23', to: '2026-07-01' }),
    ).toThrow()
    expect(() => dashboardPeriodSchema.parse({ period: 'week', from: '2026-07-01' })).toThrow()
    expect(() => dashboardPeriodSchema.parse({ period: 'quarter' })).toThrow()
  })

  test('takes calendar dates rather than instants so Kyiv day boundaries stay server side', () => {
    expect(() =>
      dashboardPeriodSchema.parse({
        period: 'custom',
        from: '2026-07-01T00:00:00.000Z',
        to: '2026-07-23T00:00:00.000Z',
      }),
    ).toThrow()
  })
})

describe('dashboard report', () => {
  const report = {
    range: { period: 'month', from: '2026-06-24', to: '2026-07-23' },
    openPipelineAmount: '65000.00',
    prepaymentReceivedAmount: '20000.00',
    wonPaymentAmount: '80000.00',
    wonDealCount: 1,
    newLeadCount: 4,
    tasksDueTodayCount: 0,
    overdueTaskCount: 0,
    noNextStepDealCount: 2,
    criticalDealCount: 0,
    funnel: FUNNEL_TRANSITIONS.map((transition) => ({ ...transition, count: 0, share: null })),
    sources: [
      {
        source: 'teraso.com.ua',
        utmSource: null,
        leadCount: 2,
        openPipelineAmount: '65000.00',
        wonCount: 0,
        wonAmount: '0.00',
      },
    ],
  } as const

  test('accepts a complete report and rejects an unknown key', () => {
    expect(dashboardSchema.parse(report)).toMatchObject({
      openPipelineAmount: '65000.00',
      prepaymentReceivedAmount: '20000.00',
      wonPaymentAmount: '80000.00',
    })
    expect(() => dashboardSchema.parse({ ...report, averageDealSize: '1000.00' })).toThrow()
  })

  /**
   * Every amount is summed in PostgreSQL and serialized through `toMoneyString`.
   * The response form requires exactly two decimals, so a total that skipped
   * that conversion — a raw `Decimal.toString()` yields "65000" — fails here
   * rather than rendering as a second spelling of the same money.
   */
  test('requires canonical two-decimal money everywhere, including zero', () => {
    expect(() => dashboardSchema.parse({ ...report, wonPaymentAmount: '80000' })).toThrow()
    expect(() => dashboardSchema.parse({ ...report, openPipelineAmount: 65000 })).toThrow()
    expect(dashboardSchema.parse({ ...report, wonPaymentAmount: '0.00' }).wonPaymentAmount).toBe(
      '0.00',
    )
  })

  test('derives the funnel pairs from the board order so the two cannot drift', () => {
    expect(FUNNEL_TRANSITIONS).toEqual([
      { fromStage: 'NEW', toStage: 'QUALIFIED' },
      { fromStage: 'QUALIFIED', toStage: 'PROPOSAL_SENT' },
      { fromStage: 'PROPOSAL_SENT', toStage: 'PREPAYMENT' },
      { fromStage: 'PREPAYMENT', toStage: 'WON' },
    ])
    expect(FUNNEL_TRANSITIONS).toHaveLength(ACTIVE_DEAL_STAGES.length - 1)
    // LOST never occupies a column, so it is never a funnel destination either.
    expect(FUNNEL_TRANSITIONS.some((step) => step.toStage === 'LOST')).toBe(false)
  })

  /**
   * The share is a step's own conversion, so two shapes that look wrong are
   * legal and one that looks harmless is not.
   */
  test('accepts a step conversion, including none and more than all of it', () => {
    const step = { fromStage: 'NEW', toStage: 'QUALIFIED', count: 3 } as const

    expect(dashboardFunnelStepSchema.parse({ ...step, share: 0.75 }).share).toBe(0.75)
    // No denominator inside the window: the deals arrived before it started.
    expect(dashboardFunnelStepSchema.parse({ ...step, share: null }).share).toBeNull()
    // A period that clears an older backlog moves more deals out of a stage
    // than entered it, and that throughput must not be clamped away.
    expect(dashboardFunnelStepSchema.parse({ ...step, share: 2 }).share).toBe(2)
    expect(() => dashboardFunnelStepSchema.parse({ ...step, share: -0.1 })).toThrow()
    expect(() => dashboardFunnelStepSchema.parse({ ...step, count: 2.5, share: 0.5 })).toThrow()
  })

  /** Cheap traffic can invent unbounded `utm_source` values, so the table is capped. */
  test('caps the source breakdown', () => {
    const row = report.sources[0]!
    const overLimit = Array.from({ length: DASHBOARD_SOURCE_LIMIT + 1 }, (_, index) => ({
      ...row,
      source: `source-${index}`,
    }))

    expect(() => dashboardSchema.parse({ ...report, sources: overLimit })).toThrow()
    expect(
      dashboardSchema.parse({ ...report, sources: overLimit.slice(0, DASHBOARD_SOURCE_LIMIT) })
        .sources,
    ).toHaveLength(DASHBOARD_SOURCE_LIMIT)
  })

  /** The resolved window is echoed back so the browser never recomputes Kyiv days. */
  test('echoes the resolved window as calendar dates', () => {
    expect(dashboardSchema.parse(report).range).toEqual({
      period: 'month',
      from: '2026-06-24',
      to: '2026-07-23',
    })
    expect(() =>
      dashboardSchema.parse({
        ...report,
        range: { period: 'month', from: '2026-06-24T00:00:00.000Z', to: '2026-07-23' },
      }),
    ).toThrow()
  })
})

describe('inbound quiz leads', () => {
  test('accepts the quiz payload with its optional marketing attribution', () => {
    expect(inboundQuizLeadSchema.parse(inboundLead)).toMatchObject({
      externalId: 'lead_68f0c1',
      source: 'teraso.com.ua',
    })
    expect(
      inboundQuizLeadSchema.parse({
        ...inboundLead,
        material: 'WPC',
        areaLabel: '30-50 м²',
        budgetLabel: 'до 100 000 грн',
        needTiming: 'Зараз',
        preferredChannel: 'TELEGRAM',
        attribution: { utmSource: 'google', gclid: 'Cj0KCQ', metaEventId: 'evt_1' },
      }),
    ).toMatchObject({ material: 'WPC', preferredChannel: 'TELEGRAM' })
  })

  // The site deploys independently, so a new field there must not reject leads.
  test('drops unknown site fields instead of refusing the delivery', () => {
    const parsed = inboundQuizLeadSchema.parse({ ...inboundLead, newSiteField: 'whatever' })
    expect(parsed).toMatchObject({ externalId: 'lead_68f0c1' })
    expect('newSiteField' in parsed).toBe(false)
  })

  test('refuses a payload that cannot be deduplicated or contacted', () => {
    expect(() => inboundQuizLeadSchema.parse({ ...inboundLead, externalId: undefined })).toThrow()
    expect(() => inboundQuizLeadSchema.parse({ ...inboundLead, externalId: '' })).toThrow()
    expect(() => inboundQuizLeadSchema.parse({ ...inboundLead, phone: '123' })).toThrow()
    expect(() => inboundQuizLeadSchema.parse({ ...inboundLead, receivedAt: '23.07.2026' })).toThrow()
    expect(() => inboundQuizLeadSchema.parse({ ...inboundLead, landingUrl: 'teraso' })).toThrow()
    expect(() => inboundQuizLeadSchema.parse({ ...inboundLead, material: 'CONCRETE' })).toThrow()
  })
})

describe('notification contracts', () => {
  test('refuses a push subscription missing an endpoint or either key', () => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'BPk1', auth: 'tBHI' },
    }
    expect(pushSubscriptionCreateSchema.parse(subscription)).toMatchObject(subscription)
    expect(() =>
      pushSubscriptionCreateSchema.parse({ ...subscription, endpoint: undefined }),
    ).toThrow()
    expect(() =>
      pushSubscriptionCreateSchema.parse({ ...subscription, keys: { auth: 'tBHI' } }),
    ).toThrow()
    expect(() =>
      pushSubscriptionCreateSchema.parse({ ...subscription, keys: { p256dh: 'BPk1' } }),
    ).toThrow()
    expect(() =>
      pushSubscriptionCreateSchema.parse({ ...subscription, keys: { p256dh: '', auth: '' } }),
    ).toThrow()
  })

  /**
   * The stored endpoint is a URL the SERVER dereferences on an unattended
   * schedule, so the scheme is a security boundary rather than a formatting
   * preference: any authenticated user could otherwise park an internal address
   * here and read reachability back out of `deliveryState`.
   */
  test('accepts only https push endpoints', () => {
    const subscription = { keys: { p256dh: 'BPk1', auth: 'tBHI' } }

    expect(
      pushSubscriptionCreateSchema.parse({
        ...subscription,
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      }).endpoint,
    ).toBe('https://fcm.googleapis.com/fcm/send/abc')

    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'http://169.254.169.254/latest/meta-data/',
      'http://localhost:5432/',
      'ftp://internal.example/queue',
      'file:///etc/passwd',
    ]) {
      expect(() => pushSubscriptionCreateSchema.parse({ ...subscription, endpoint })).toThrow()
    }
  })

  test('keeps the browser expirationTime field the PushManager actually sends', () => {
    expect(
      pushSubscriptionCreateSchema.parse({
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        expirationTime: null,
        keys: { p256dh: 'BPk1', auth: 'tBHI' },
      }),
    ).toMatchObject({ expirationTime: null })
  })

  test('marks notifications read by id and rejects an empty batch', () => {
    expect(notificationReadRequestSchema.parse({ notificationIds: [uuid('1')] })).toEqual({
      notificationIds: [uuid('1')],
    })
    expect(() => notificationReadRequestSchema.parse({ notificationIds: [] })).toThrow()
    expect(() => notificationReadRequestSchema.parse({ notificationIds: ['nope'] })).toThrow()
  })

  // The service worker hands href to clients.openWindow(); an absolute URL there
  // would let a stored notification navigate the owner off-origin.
  test('confines a notification link to a same-origin path', () => {
    const notification = {
      id: uuid('1'),
      kind: 'NEW_LEAD',
      title: 'Новая заявка',
      body: 'Олександр',
      href: `/app/deals/${uuid('2')}`,
      dealId: uuid('2'),
      deliveryState: 'PENDING',
      readAt: null,
      createdAt: '2026-07-23T09:00:00.000Z',
    } as const
    expect(notificationSchema.parse(notification)).toEqual(notification)
    expect(() =>
      notificationSchema.parse({ ...notification, href: 'https://evil.example.com/steal' }),
    ).toThrow()
    expect(() => notificationSchema.parse({ ...notification, href: '//evil.example.com' })).toThrow()
    expect(() => notificationSchema.parse({ ...notification, href: 'app/deals' })).toThrow()
    // eventKey is an internal cron dedup key and must not reach the client.
    expect(() =>
      notificationSchema.parse({ ...notification, eventKey: 'task-due:task-1' }),
    ).toThrow()
  })

  /**
   * `href` is denormalized into every stored row and handed straight to
   * `clients.openWindow()`, so a producer spelling its own path would commit a
   * dead link that only surfaces when somebody clicks a push — repairable then
   * only by a data migration. The prefix is therefore pinned at the boundary,
   * and every producer builds the path from `dealPath`.
   */
  test('pins a notification link to the authenticated app prefix', () => {
    const notification = {
      id: uuid('1'),
      kind: 'NEW_LEAD',
      title: 'Новая заявка',
      body: 'Олександр',
      href: dealPath(uuid('2')),
      dealId: uuid('2'),
      deliveryState: 'PENDING',
      readAt: null,
      createdAt: '2026-07-23T09:00:00.000Z',
    } as const

    expect(dealPath(uuid('2'))).toBe(`${APP_PATH_PREFIX}/deals/${uuid('2')}`)
    expect(notificationSchema.parse(notification).href).toBe(`/app/deals/${uuid('2')}`)

    for (const href of [
      // The unauthenticated marketing surface, and the exact shape a producer
      // that spelled the path itself would emit.
      `/deals/${uuid('2')}`,
      '/login',
      // A bare prefix is not a destination.
      APP_PATH_PREFIX,
      `${APP_PATH_PREFIX}/`,
      // Prefix as a substring rather than a path segment.
      '/application/deals',
    ]) {
      expect(() => notificationSchema.parse({ ...notification, href })).toThrow()
    }
  })
})
