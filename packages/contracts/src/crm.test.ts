import { describe, expect, test } from 'bun:test'

import {
  dealListQuerySchema,
  dealStageChangeSchema,
  dealUpdateSchema,
  dashboardPeriodSchema,
  dealActivityMetadataSchema,
  inboundQuizLeadSchema,
  leadClassSchema,
  moneyAmountSchema,
  taskCreateSchema,
} from './crm'
import { pushSubscriptionCreateSchema, notificationReadRequestSchema } from './notifications'
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

  test('keeps the funnel and loss vocabulary exactly as the PRD names it', () => {
    expect(dealStageSchema.options).toEqual([
      'NEW',
      'QUALIFIED',
      'PROPOSAL_SENT',
      'PREPAYMENT',
      'WON',
      'LOST',
    ])
    expect(lossReasonSchema.options).toHaveLength(8)
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
  })

  test('refuses a loss reason on a stage that is not a loss', () => {
    expect(() =>
      dealStageChangeSchema.parse({ stage: 'QUALIFIED', lossReason: 'CURIOSITY' }),
    ).toThrow()
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
})

describe('deal tasks', () => {
  test('rejects an invalid due time even when every other field is valid', () => {
    const task = { kind: 'CALL', title: 'Перезвонить', dueAt: '2026-07-23T09:30:00.000Z' }
    expect(taskCreateSchema.parse(task)).toMatchObject({ kind: 'CALL' })
    expect(() => taskCreateSchema.parse({ ...task, dueAt: 'tomorrow' })).toThrow()
    expect(() => taskCreateSchema.parse({ ...task, dueAt: '2026-07-23' })).toThrow()
    expect(() => taskCreateSchema.parse({ ...task, kind: 'EMAIL' })).toThrow()
    expect(() => taskCreateSchema.parse({ ...task, title: '   ' })).toThrow()
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
      responsibleUserId: '019c0000-0000-7000-8000-000000000001',
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
    expect(() => dealUpdateSchema.parse({ stage: 'WON' })).toThrow()
    expect(() => dealUpdateSchema.parse({ potentialAmount: '65000.999' })).toThrow()
  })
})

describe('deal activity metadata', () => {
  test('carries the stage transition the dashboard funnel is computed from', () => {
    expect(
      dealActivityMetadataSchema.parse({ fromStage: 'NEW', toStage: 'QUALIFIED' }),
    ).toEqual({ fromStage: 'NEW', toStage: 'QUALIFIED' })
    expect(dealActivityMetadataSchema.parse({ fromStage: null, toStage: 'NEW' })).toEqual({
      fromStage: null,
      toStage: 'NEW',
    })
    expect(() => dealActivityMetadataSchema.parse({ toStage: 'ARCHIVED' })).toThrow()
    expect(() => dealActivityMetadataSchema.parse({ typoedKey: 'NEW' })).toThrow()
  })

  test('records field level before and after values', () => {
    const metadata = {
      changes: [{ field: 'leadClass', before: null, after: 'B' }],
    }
    expect(dealActivityMetadataSchema.parse(metadata)).toEqual(metadata)
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
    expect(
      notificationReadRequestSchema.parse({
        notificationIds: ['019c0000-0000-7000-8000-000000000001'],
      }),
    ).toEqual({ notificationIds: ['019c0000-0000-7000-8000-000000000001'] })
    expect(() => notificationReadRequestSchema.parse({ notificationIds: [] })).toThrow()
    expect(() => notificationReadRequestSchema.parse({ notificationIds: ['nope'] })).toThrow()
  })
})
