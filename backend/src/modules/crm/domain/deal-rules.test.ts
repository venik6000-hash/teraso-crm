import { describe, expect, test } from 'bun:test'

import { evaluateDealCriticality, nextStepGraceCutoff, validateStageChange } from './deal-rules'

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

/**
 * PRD 7.3 (funnel order, the eight loss reasons, reopen-only-with-event) and
 * PRD 6.2/6.3. The reachable-transition graph is server-authoritative and lives
 * here, apart from `dealStageChangeSchema`, which only guards the field set each
 * destination may carry. Every case below throws a `CrmFailure`, so the transport
 * layer answers 400 with the Russian message rather than 500.
 */
describe('stage transitions', () => {
  const paidAt = '2026-07-23T12:00:00.000Z'
  const openStages = ['NEW', 'QUALIFIED', 'PROPOSAL_SENT', 'PREPAYMENT'] as const

  test('cannot enter prepayment without payment fields', () => {
    expect(() =>
      validateStageChange({
        from: 'PROPOSAL_SENT',
        to: 'PREPAYMENT',
        prepaymentAmount: undefined,
        prepaymentPaidAt: undefined,
      }),
    ).toThrow('Укажите сумму и дату предоплаты')
  })

  test('walks every forward step of the active path', () => {
    expect(validateStageChange({ from: 'NEW', to: 'QUALIFIED' })).toEqual({ kind: 'advance' })
    expect(validateStageChange({ from: 'QUALIFIED', to: 'PROPOSAL_SENT' })).toEqual({
      kind: 'advance',
    })
    expect(
      validateStageChange({
        from: 'PROPOSAL_SENT',
        to: 'PREPAYMENT',
        prepaymentAmount: '1000',
        prepaymentPaidAt: paidAt,
      }),
    ).toEqual({ kind: 'advance' })
    expect(
      validateStageChange({
        from: 'PREPAYMENT',
        to: 'WON',
        fullPaymentAmount: '5000',
        fullPaymentPaidAt: paidAt,
      }),
    ).toEqual({ kind: 'advance' })
  })

  test('rejects a zero or missing prepayment amount', () => {
    for (const prepaymentAmount of [undefined, '0', '0.00']) {
      expect(() =>
        validateStageChange({ from: 'PROPOSAL_SENT', to: 'PREPAYMENT', prepaymentAmount, prepaymentPaidAt: paidAt }),
      ).toThrow('Укажите сумму и дату предоплаты')
    }
    expect(() =>
      validateStageChange({ from: 'PROPOSAL_SENT', to: 'PREPAYMENT', prepaymentAmount: '1000', prepaymentPaidAt: undefined }),
    ).toThrow('Укажите сумму и дату предоплаты')
  })

  test('requires a positive amount and a date to win', () => {
    for (const [fullPaymentAmount, fullPaymentPaidAt] of [
      [undefined, paidAt],
      ['0', paidAt],
      ['5000', undefined],
    ] as const) {
      expect(() =>
        validateStageChange({ from: 'PREPAYMENT', to: 'WON', fullPaymentAmount, fullPaymentPaidAt }),
      ).toThrow('Укажите сумму и дату полной оплаты')
    }
  })

  test('closes any open stage as lost only with a reason', () => {
    for (const from of openStages) {
      expect(validateStageChange({ from, to: 'LOST', lossReason: 'NO_ANSWER' })).toEqual({
        kind: 'lose',
      })
      expect(() => validateStageChange({ from, to: 'LOST' })).toThrow('Выберите причину потери')
    }
  })

  test('reopens a won or lost deal back to a new deal', () => {
    expect(validateStageChange({ from: 'WON', to: 'NEW' })).toEqual({ kind: 'reopen' })
    expect(validateStageChange({ from: 'LOST', to: 'NEW' })).toEqual({ kind: 'reopen' })
  })

  test('rejects skips, backward moves and edits of a closed deal', () => {
    const illegal: ReadonlyArray<readonly [string, string]> = [
      ['NEW', 'PROPOSAL_SENT'],
      ['NEW', 'PREPAYMENT'],
      ['NEW', 'WON'],
      ['NEW', 'NEW'],
      ['QUALIFIED', 'NEW'],
      ['QUALIFIED', 'PREPAYMENT'],
      ['QUALIFIED', 'WON'],
      ['QUALIFIED', 'QUALIFIED'],
      ['PROPOSAL_SENT', 'QUALIFIED'],
      ['PROPOSAL_SENT', 'NEW'],
      ['PROPOSAL_SENT', 'WON'],
      ['PREPAYMENT', 'QUALIFIED'],
      ['PREPAYMENT', 'PROPOSAL_SENT'],
      ['PREPAYMENT', 'NEW'],
      ['WON', 'QUALIFIED'],
      ['WON', 'PROPOSAL_SENT'],
      ['WON', 'PREPAYMENT'],
      ['WON', 'WON'],
      ['WON', 'LOST'],
      ['LOST', 'QUALIFIED'],
      ['LOST', 'PROPOSAL_SENT'],
      ['LOST', 'PREPAYMENT'],
      ['LOST', 'WON'],
      ['LOST', 'LOST'],
    ]

    for (const [from, to] of illegal) {
      expect(() =>
        validateStageChange({
          from: from as never,
          to: to as never,
          // Enough payment/reason context that a rejection can only be the graph
          // itself, never a missing-field check masquerading as an illegal move.
          prepaymentAmount: '1000',
          prepaymentPaidAt: paidAt,
          fullPaymentAmount: '5000',
          fullPaymentPaidAt: paidAt,
          lossReason: 'NO_ANSWER',
        }),
      ).toThrow('Недопустимый переход')
    }
  })
})
