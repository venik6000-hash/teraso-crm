import { describe, expect, test } from 'bun:test'

import { evaluateDealCriticality, nextStepGraceCutoff } from './deal-rules'

/**
 * PRD 7.4 and PRD 5. These three flags are served, never recomputed in the
 * browser, and the same rule has to hold in two places: this pure function fills
 * the DTO booleans, and an equivalent SQL predicate selects rows for the quick
 * filters. Both are driven from the contracts' OPEN_DEAL_STAGES and
 * NEXT_STEP_GRACE_MINUTES, and the integration test asserts the two agree in
 * both directions.
 */
describe('deal criticality', () => {
  const createdAt = new Date('2026-07-23T09:00:00.000Z')

  test('marks a deal critical after its task is due', () => {
    expect(
      evaluateDealCriticality({
        stage: 'NEW',
        now: new Date('2026-07-23T10:31:00.000Z'),
        createdAt,
        activeDueAt: new Date('2026-07-23T10:30:00.000Z'),
      }).isCritical,
    ).toBe(true)
  })

  test('gives a fresh taskless deal a 30-minute grace period', () => {
    const state = evaluateDealCriticality({
      stage: 'NEW',
      now: new Date('2026-07-23T10:20:00.000Z'),
      createdAt: new Date('2026-07-23T10:00:00.000Z'),
      activeDueAt: null,
    })

    expect(state.noNextStep).toBe(true)
    expect(state.isCritical).toBe(false)
  })

  test('turns a taskless deal critical once the grace window has elapsed', () => {
    const fresh = new Date('2026-07-23T10:00:00.000Z')

    expect(
      evaluateDealCriticality({
        stage: 'NEW',
        now: new Date('2026-07-23T10:29:59.999Z'),
        createdAt: fresh,
        activeDueAt: null,
      }).isCritical,
    ).toBe(false)
    expect(
      evaluateDealCriticality({
        stage: 'NEW',
        now: new Date('2026-07-23T10:30:00.000Z'),
        createdAt: fresh,
        activeDueAt: null,
      }).isCritical,
    ).toBe(true)
  })

  test('treats a future task as a satisfied next step', () => {
    const state = evaluateDealCriticality({
      stage: 'QUALIFIED',
      now: new Date('2026-07-23T10:00:00.000Z'),
      createdAt,
      activeDueAt: new Date('2026-07-23T18:00:00.000Z'),
    })

    expect(state).toEqual({ noNextStep: false, hasOverdueTask: false, isCritical: false })
  })

  /** A task due exactly now is already overdue: PRD 7.4 says "at or before now". */
  test('counts a task due exactly now as overdue', () => {
    const now = new Date('2026-07-23T10:00:00.000Z')
    const state = evaluateDealCriticality({ stage: 'NEW', now, createdAt, activeDueAt: now })

    expect(state).toEqual({ noNextStep: true, hasOverdueTask: true, isCritical: true })
  })

  test('exempts won and lost deals from every flag', () => {
    for (const stage of ['WON', 'LOST'] as const) {
      expect(
        evaluateDealCriticality({
          stage,
          now: new Date('2026-07-24T10:00:00.000Z'),
          createdAt,
          activeDueAt: new Date('2026-07-23T08:00:00.000Z'),
        }),
      ).toEqual({ noNextStep: false, hasOverdueTask: false, isCritical: false })
    }
  })

  test('applies the rule to every open stage', () => {
    for (const stage of ['NEW', 'QUALIFIED', 'PROPOSAL_SENT', 'PREPAYMENT'] as const) {
      expect(
        evaluateDealCriticality({
          stage,
          now: new Date('2026-07-24T10:00:00.000Z'),
          createdAt,
          activeDueAt: null,
        }),
      ).toEqual({ noNextStep: true, hasOverdueTask: false, isCritical: true })
    }
  })
})

/**
 * The SQL predicate for the `noNextStep`-driven part of `isCritical` compares
 * `created_at` against this cutoff, so both sides of the duplication read the
 * grace window from one place.
 */
test('exposes the grace cutoff the SQL filter compares against', () => {
  expect(nextStepGraceCutoff(new Date('2026-07-23T10:30:00.000Z')).toISOString()).toBe(
    '2026-07-23T10:00:00.000Z',
  )
})
