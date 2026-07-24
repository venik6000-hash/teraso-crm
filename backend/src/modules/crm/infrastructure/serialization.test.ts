import { describe, expect, test } from 'bun:test'
import { moneyResponseSchema } from '@teraso-crm/contracts'

import { Prisma } from '../../../generated/prisma/client'
import { toIsoInstant, toMoneyString } from './serialization'

/**
 * The single Decimal/Date conversion boundary for the CRM module. It exists in
 * one place on purpose: `Decimal.toString()` returns "65000" for 65000.00, which
 * satisfies the lenient request schema and renders identically through
 * Intl.NumberFormat, so a serializer that skipped the canonical conversion would
 * disagree with the rest of the API invisibly. `moneyResponseSchema` demands
 * exactly two decimals precisely to make that mistake fail loudly.
 */
describe('money serialization', () => {
  test('produces the canonical two-decimal form the response schema requires', () => {
    expect(toMoneyString(new Prisma.Decimal('65000'))).toBe('65000.00')
    expect(toMoneyString(new Prisma.Decimal('65000.00'))).toBe('65000.00')
    expect(toMoneyString(new Prisma.Decimal('65000.5'))).toBe('65000.50')
    expect(toMoneyString(new Prisma.Decimal('0'))).toBe('0.00')
  })

  test('the raw Decimal string would not survive response validation', () => {
    const amount = new Prisma.Decimal('65000.00')

    expect(moneyResponseSchema.safeParse(amount.toString()).success).toBe(false)
    expect(moneyResponseSchema.safeParse(toMoneyString(amount)).success).toBe(true)
  })

  test('round-trips the widest amount the Decimal(14, 2) column allows', () => {
    const widest = toMoneyString(new Prisma.Decimal('999999999999.99'))

    expect(widest).toBe('999999999999.99')
    expect(moneyResponseSchema.safeParse(widest).success).toBe(true)
  })

  test('passes null through so a nullable DTO field stays null', () => {
    expect(toMoneyString(null)).toBeNull()
  })
})

describe('instant serialization', () => {
  test('emits UTC ISO-8601 with a Z suffix', () => {
    expect(toIsoInstant(new Date('2026-07-23T10:30:00.000Z'))).toBe('2026-07-23T10:30:00.000Z')
  })

  test('passes null through', () => {
    expect(toIsoInstant(null)).toBeNull()
  })
})
