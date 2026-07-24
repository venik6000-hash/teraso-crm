import { describe, expect, test } from 'bun:test'
import {
  ACTIVE_DEAL_STAGES,
  dealActivityKindSchema,
  dealStageSchema,
  leadClassSchema,
  lossReasonSchema,
  materialSchema,
  notificationDeliveryStateSchema,
  notificationKindSchema,
  OPEN_DEAL_STAGES,
  preferredChannelSchema,
  registerRequestSchema,
  taskKindSchema,
  taskStatusSchema,
} from '@teraso-crm/contracts'

import {
  DealActivityKind,
  DealStage,
  LeadClass,
  LossReason,
  Material,
  NotificationDeliveryState,
  NotificationKind,
  PreferredChannel,
  TaskKind,
  TaskStatus,
} from './generated/prisma/enums'

describe('contracts', () => {
  test('normalizes auth registration payloads', () => {
    const result = registerRequestSchema.parse({
      email: ' USER@Example.COM ',
      password: 'password123',
      displayName: '',
    })

    expect(result).toEqual({
      email: 'user@example.com',
      password: 'password123',
      displayName: undefined,
    })
  })
})

/**
 * The shared Zod enums and the Prisma enums are two hand-maintained copies of
 * one vocabulary, and this is the only place both runtimes are loaded together.
 *
 * Order is asserted, not just membership: PostgreSQL freezes the order at
 * CREATE TYPE, and it governs enum comparison and ORDER BY. A value inserted in
 * the middle of a Zod enum would keep every membership check passing while
 * silently disagreeing with the column the migration created.
 */
describe('CRM enum parity between contracts and Prisma', () => {
  const pairs: ReadonlyArray<readonly [string, readonly string[], Record<string, string>]> = [
    ['DealStage', dealStageSchema.options, DealStage],
    ['LeadClass', leadClassSchema.options, LeadClass],
    ['TaskKind', taskKindSchema.options, TaskKind],
    ['TaskStatus', taskStatusSchema.options, TaskStatus],
    ['LossReason', lossReasonSchema.options, LossReason],
    ['Material', materialSchema.options, Material],
    ['PreferredChannel', preferredChannelSchema.options, PreferredChannel],
    ['DealActivityKind', dealActivityKindSchema.options, DealActivityKind],
    ['NotificationKind', notificationKindSchema.options, NotificationKind],
    ['NotificationDeliveryState', notificationDeliveryStateSchema.options, NotificationDeliveryState],
  ]

  for (const [name, zodValues, prismaEnum] of pairs) {
    test(`${name} matches value for value and in order`, () => {
      expect(Object.values(prismaEnum)).toEqual([...zodValues])
    })
  }
})

/**
 * The CRM deal list casts these constants straight into SQL to select open deals
 * (`d.stage IN (...::deal_stage)`), so a stage the PostgreSQL enum does not
 * contain would fail at query time on a live request rather than at build time.
 * Membership is what matters here; the parity suite above already fixes order.
 */
describe('CRM stage constants against the PostgreSQL enum', () => {
  const stages: string[] = Object.values(DealStage)

  test('every open and active stage is a real DealStage member', () => {
    expect(stages).toEqual(expect.arrayContaining([...OPEN_DEAL_STAGES]))
    expect(stages).toEqual(expect.arrayContaining([...ACTIVE_DEAL_STAGES]))
  })

  /**
   * PRD 7.4 exempts closed deals from the next-step rule, and the criticality
   * domain derives that exemption from this constant rather than restating it.
   */
  test('closed stages stay outside the open set', () => {
    expect(OPEN_DEAL_STAGES).not.toContain(DealStage.WON)
    expect(OPEN_DEAL_STAGES).not.toContain(DealStage.LOST)
    expect(ACTIVE_DEAL_STAGES).not.toContain(DealStage.LOST)
  })
})
