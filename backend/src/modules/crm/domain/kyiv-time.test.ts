import { describe, expect, test } from 'bun:test'

import { kyivDayEndExclusive, kyivDayStart, kyivTodayRange } from './kyiv-time'

/**
 * PRD 10 fixes Europe/Kyiv as the interpretation zone for tasks and dates, so a
 * calendar date from a filter is a Kyiv day, not a UTC one. Kyiv is UTC+2 in
 * winter and UTC+3 in summer; a fixed offset would be wrong for half the year
 * and would silently shift "Сегодня" by an hour twice a year.
 */
describe('Kyiv day boundaries', () => {
  test('resolves a winter date at UTC+2', () => {
    expect(kyivDayStart('2026-01-15').toISOString()).toBe('2026-01-14T22:00:00.000Z')
    expect(kyivDayEndExclusive('2026-01-15').toISOString()).toBe('2026-01-15T22:00:00.000Z')
  })

  test('resolves a summer date at UTC+3', () => {
    expect(kyivDayStart('2026-07-15').toISOString()).toBe('2026-07-14T21:00:00.000Z')
    expect(kyivDayEndExclusive('2026-07-15').toISOString()).toBe('2026-07-15T21:00:00.000Z')
  })

  /** Spring forward: 2026-03-29 starts at UTC+2 and ends at UTC+3, so it is 23 hours long. */
  test('handles the spring-forward day without losing an hour', () => {
    const start = kyivDayStart('2026-03-29')
    const end = kyivDayEndExclusive('2026-03-29')

    expect(start.toISOString()).toBe('2026-03-28T22:00:00.000Z')
    expect(end.toISOString()).toBe('2026-03-29T21:00:00.000Z')
    expect(end.getTime() - start.getTime()).toBe(23 * 60 * 60 * 1000)
  })

  /** Fall back: 2026-10-25 starts at UTC+3 and ends at UTC+2, so it is 25 hours long. */
  test('handles the fall-back day without gaining an hour', () => {
    const start = kyivDayStart('2026-10-25')
    const end = kyivDayEndExclusive('2026-10-25')

    expect(start.toISOString()).toBe('2026-10-24T21:00:00.000Z')
    expect(end.toISOString()).toBe('2026-10-25T22:00:00.000Z')
    expect(end.getTime() - start.getTime()).toBe(25 * 60 * 60 * 1000)
  })

  test('crosses a month boundary', () => {
    expect(kyivDayStart('2026-03-01').toISOString()).toBe('2026-02-28T22:00:00.000Z')
    expect(kyivDayEndExclusive('2026-12-31').toISOString()).toBe('2026-12-31T22:00:00.000Z')
  })
})

describe('Kyiv today', () => {
  /**
   * The case that makes UTC days wrong: 22:30 UTC is already the next calendar
   * day in Kyiv, so a "Сегодня" filter anchored on UTC would show the wrong day
   * every evening.
   */
  test('uses the Kyiv calendar day, not the UTC one', () => {
    const lateEvening = kyivTodayRange(new Date('2026-07-15T21:30:00.000Z'))

    expect(lateEvening.start.toISOString()).toBe('2026-07-15T21:00:00.000Z')
    expect(lateEvening.end.toISOString()).toBe('2026-07-16T21:00:00.000Z')
  })

  test('brackets the instant it is given', () => {
    const now = new Date('2026-01-15T09:00:00.000Z')
    const { start, end } = kyivTodayRange(now)

    expect(start.getTime()).toBeLessThanOrEqual(now.getTime())
    expect(end.getTime()).toBeGreaterThan(now.getTime())
  })
})
