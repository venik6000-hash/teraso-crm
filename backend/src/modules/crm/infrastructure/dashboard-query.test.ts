import { describe, expect, test } from 'bun:test'

import { resolveDashboardRange } from './dashboard-query'

/**
 * The dashboard's period windows (PRD 7.8).
 *
 * These are resolved on the server and echoed back to the browser, so the
 * screen never recomputes Kyiv day boundaries. The rules worth pinning are that
 * the windows TRAIL — they end on the current Kyiv day rather than snapping to
 * a calendar bucket — and that they are resolved in Kyiv, which is UTC+2 in
 * winter and UTC+3 in summer.
 */
describe('dashboard period windows', () => {
  /** 12:00 Kyiv on a summer day (UTC+3). */
  const summerNoon = new Date('2026-07-15T09:00:00.000Z')

  test('resolves "today" to the single current Kyiv day', () => {
    const { start, end, range } = resolveDashboardRange({ period: 'today' }, summerNoon)

    expect(range).toEqual({ period: 'today', from: '2026-07-15', to: '2026-07-15' })
    expect(start.toISOString()).toBe('2026-07-14T21:00:00.000Z')
    expect(end.toISOString()).toBe('2026-07-15T21:00:00.000Z')
  })

  test('resolves "week" to seven days ending today, not to a calendar week', () => {
    const { start, end, range } = resolveDashboardRange({ period: 'week' }, summerNoon)

    expect(range).toEqual({ period: 'week', from: '2026-07-09', to: '2026-07-15' })
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
  })

  /**
   * The reason the windows trail: on the first of a month a calendar «месяц»
   * would report on a few hours of data and read as lost history.
   */
  test('resolves "month" to thirty days ending today, including on the first', () => {
    const firstOfMonth = new Date('2026-08-01T09:00:00.000Z')
    const { range } = resolveDashboardRange({ period: 'month' }, firstOfMonth)

    expect(range).toEqual({ period: 'month', from: '2026-07-03', to: '2026-08-01' })
  })

  test('keeps a custom period exactly as asked and spans full Kyiv days', () => {
    const { start, end, range } = resolveDashboardRange(
      { period: 'custom', from: '2026-07-01', to: '2026-07-23' },
      summerNoon,
    )

    expect(range).toEqual({ period: 'custom', from: '2026-07-01', to: '2026-07-23' })
    // Inclusive of the last day: the upper bound is the start of the day after.
    expect(start.toISOString()).toBe('2026-06-30T21:00:00.000Z')
    expect(end.toISOString()).toBe('2026-07-23T21:00:00.000Z')
  })

  /**
   * A window that spans the spring change is 23 hours shorter than a naive
   * multiplication would make it, which is exactly why the boundaries are
   * resolved through the Kyiv helpers rather than by adding milliseconds.
   */
  test('resolves a window across the spring clock change against real Kyiv offsets', () => {
    const afterSpringChange = new Date('2026-03-30T09:00:00.000Z')
    const { start, end, range } = resolveDashboardRange({ period: 'week' }, afterSpringChange)

    expect(range).toEqual({ period: 'week', from: '2026-03-24', to: '2026-03-30' })
    expect(start.toISOString()).toBe('2026-03-23T22:00:00.000Z')
    expect(end.toISOString()).toBe('2026-03-30T21:00:00.000Z')
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000)
  })

  test('resolves the winter offset for the same trailing window', () => {
    const winterNoon = new Date('2026-01-15T10:00:00.000Z')
    const { start, range } = resolveDashboardRange({ period: 'today' }, winterNoon)

    expect(range).toEqual({ period: 'today', from: '2026-01-15', to: '2026-01-15' })
    expect(start.toISOString()).toBe('2026-01-14T22:00:00.000Z')
  })
})
