import { describe, expect, test } from 'bun:test'
import {
  dealActivityKindSchema,
  dealStageSchema,
  leadClassSchema,
  lossReasonSchema,
  materialSchema,
  notificationDeliveryStateSchema,
  notificationKindSchema,
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
