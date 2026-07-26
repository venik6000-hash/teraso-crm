import { expect, test } from 'bun:test'
import { FUNNEL_TRANSITIONS, type DashboardDto } from '@teraso-crm/contracts'
import { renderToStaticMarkup } from 'react-dom/server'

import { DashboardMetrics } from '../src/features/crm/components/DashboardMetrics'
import { FunnelChart } from '../src/features/crm/components/FunnelChart'
import { SourcePerformanceTable } from '../src/features/crm/components/SourcePerformanceTable'
import {
  DASHBOARD_PERIOD_LABELS,
  formatMoney,
  formatShare,
  toDashboardPeriodSearch,
} from '../src/features/crm/model'
import { renderInRouter } from './render-in-router'

function report(overrides: Partial<DashboardDto> = {}): DashboardDto {
  return {
    range: { period: 'month', from: '2026-06-24', to: '2026-07-23' },
    openPipelineAmount: '65000.00',
    prepaymentReceivedAmount: '20000.00',
    wonPaymentAmount: '80000.00',
    wonDealCount: 1,
    newLeadCount: 4,
    tasksDueTodayCount: 2,
    overdueTaskCount: 3,
    noNextStepDealCount: 5,
    criticalDealCount: 6,
    funnel: [
      { fromStage: 'NEW', toStage: 'QUALIFIED', count: 4, share: 1 },
      { fromStage: 'QUALIFIED', toStage: 'PROPOSAL_SENT', count: 4, share: 1 },
      { fromStage: 'PROPOSAL_SENT', toStage: 'PREPAYMENT', count: 3, share: 0.75 },
      { fromStage: 'PREPAYMENT', toStage: 'WON', count: 2, share: 0.5 },
    ],
    sources: [
      {
        source: 'teraso.com.ua',
        utmSource: 'google',
        leadCount: 2,
        openPipelineAmount: '65000.00',
        wonCount: 0,
        wonAmount: '0.00',
      },
    ],
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * Money (PRD 7.8)
 * ------------------------------------------------------------------ */

/**
 * Amounts arrive as decimal strings already summed in PostgreSQL. The screen
 * formats them and never adds them: a JavaScript number cannot hold a 14,2
 * decimal without loss, so a total computed here would eventually disagree with
 * the deal cards.
 */
test('formats served decimal strings as UAH without recomputing them', () => {
  expect(formatMoney('65000.00')).toBe('65 000 ₴')
  expect(formatMoney('0.00')).toBe('0 ₴')
  expect(formatMoney(null)).toBe('—')
})

test('renders each headline figure from its own served field', async () => {
  const html = await renderInRouter(<DashboardMetrics report={report()} />, '/app/dashboard')

  expect(html).toContain('65 000')
  expect(html).toContain('20 000')
  expect(html).toContain('80 000')
  // A prepayment is commercially confirmed but not a win, so the two are
  // separate cards with separate labels (PRD 12).
  expect(html).toContain('Полученные предоплаты')
  expect(html).toContain('Успешные сделки')
  expect(html).toContain('Открытая воронка')
})

/** The e2e journey reads the full-payment total through this id. */
test('exposes the won amount under a stable test id', async () => {
  const html = await renderInRouter(<DashboardMetrics report={report()} />, '/app/dashboard')
  expect(html).toContain('data-testid="dashboard-won-amount"')
})

test('shows the operational counters PRD 7.8 item 4 names', async () => {
  const html = await renderInRouter(<DashboardMetrics report={report()} />, '/app/dashboard')

  expect(html).toContain('Новых заявок')
  expect(html).toContain('Задач на сегодня')
  expect(html).toContain('Просроченных задач')
  expect(html).toContain('Без следующего шага')
})

/* ------------------------------------------------------------------ *
 * Funnel (PRD 7.8 item 5)
 * ------------------------------------------------------------------ */

test('labels every adjacent transition with its count and share', () => {
  const html = renderToStaticMarkup(<FunnelChart funnel={report().funnel} />)

  // Colour is never the only carrier: each bar is named and numbered.
  expect(html).toContain('Новая заявка')
  expect(html).toContain('Квалификация пройдена')
  expect(html).toContain('75')
  expect(html).toContain('50')
})

test('states an empty funnel rather than drawing a blank chart', () => {
  const empty = FUNNEL_TRANSITIONS.map((transition) => ({ ...transition, count: 0, share: 0 }))
  const html = renderToStaticMarkup(<FunnelChart funnel={empty} />)

  expect(html).toContain('За период переходов между этапами не было')
})

test('formats a share as a whole percentage', () => {
  expect(formatShare(0.75)).toBe('75%')
  expect(formatShare(1)).toBe('100%')
  expect(formatShare(0)).toBe('0%')
})

/* ------------------------------------------------------------------ *
 * Sources (PRD 7.8 item 6)
 * ------------------------------------------------------------------ */

test('renders an accessible source table with both period and snapshot measures', () => {
  const html = renderToStaticMarkup(<SourcePerformanceTable sources={report().sources} />)

  expect(html).toContain('teraso.com.ua')
  expect(html).toContain('google')
  expect(html).toContain('<th')
  expect(html).toContain('scope="col"')
  expect(html).toContain('65 000')
})

test('names a source with no UTM rather than leaving the cell blank', () => {
  const html = renderToStaticMarkup(
    <SourcePerformanceTable sources={[{ ...report().sources[0]!, utmSource: null }]} />,
  )
  expect(html).toContain('Без UTM')
})

test('states an empty source table', () => {
  const html = renderToStaticMarkup(<SourcePerformanceTable sources={[]} />)
  expect(html).toContain('За период заявок не было')
})

/* ------------------------------------------------------------------ *
 * Period selection
 * ------------------------------------------------------------------ */

test('keeps the default period out of the address bar and carries a custom one', () => {
  expect(toDashboardPeriodSearch({ period: 'month' })).toEqual({})
  expect(toDashboardPeriodSearch({ period: 'today' })).toEqual({ period: 'today' })
  expect(
    toDashboardPeriodSearch({ period: 'custom', from: '2026-07-01', to: '2026-07-23' }),
  ).toEqual({ period: 'custom', from: '2026-07-01', to: '2026-07-23' })
})

test('names every period in Russian', () => {
  expect(DASHBOARD_PERIOD_LABELS.today).toBe('Сегодня')
  expect(DASHBOARD_PERIOD_LABELS.week).toBe('Неделя')
  expect(DASHBOARD_PERIOD_LABELS.month).toBe('Месяц')
  expect(DASHBOARD_PERIOD_LABELS.custom).toBe('Период')
})

/**
 * The counters deep-link into the list's quick filters, which is why
 * `isCritical` has a URL representation but no control of its own in the filter
 * bar.
 */
test('links the operational counters into the filtered deal list', async () => {
  const html = await renderInRouter(<DashboardMetrics report={report()} />, '/app/dashboard')

  expect(html).toContain('isCritical')
  expect(html).toContain('overdue')
  expect(html).toContain('noNextStep')
})
