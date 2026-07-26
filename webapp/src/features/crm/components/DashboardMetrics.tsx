import { Link } from '@tanstack/react-router'
import type { DashboardDto } from '@teraso-crm/contracts'
import type { ReactNode } from 'react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Typography } from '@/components/typography'
import { formatMoney } from '../model'

/**
 * The dashboard's headline figures (PRD 7.8 items 1-4).
 *
 * Every amount is rendered exactly as the API served it. The three money cards
 * are separate because they answer different questions and are attributed by
 * different dates: open pipeline is a snapshot of money still in play, while
 * prepayments and full payments are counted from their own payment dates. A
 * prepayment is commercially confirmed but is NOT a win (PRD 12), which is why
 * it never shares a card with one.
 *
 * The operational counters deep-link into the deal list's quick filters, so
 * «6 критичных» is one click away from the six deals it counts.
 */
export function DashboardMetrics({ report }: { report: DashboardDto }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MoneyCard
          description="Заполненные потенциальные суммы открытых сделок — на сейчас, независимо от периода."
          title="Открытая воронка"
          value={formatMoney(report.openPipelineAmount)}
        />
        <MoneyCard
          description="Суммы предоплат, дата которых попадает в период."
          title="Полученные предоплаты"
          value={formatMoney(report.prepaymentReceivedAmount)}
        />
        <MoneyCard
          description={`Полные оплаты за период · сделок: ${report.wonDealCount}`}
          testId="dashboard-won-amount"
          title="Успешные сделки"
          value={formatMoney(report.wonPaymentAmount)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Оперативные задачи</CardTitle>
          <CardDescription>
            Состояние на сейчас. Любой счётчик открывает соответствующий список сделок.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <CounterCell label="Новых заявок" value={report.newLeadCount} />
          <CounterCell
            label="Задач на сегодня"
            search={{ dueToday: true }}
            value={report.tasksDueTodayCount}
          />
          <CounterCell
            label="Просроченных задач"
            search={{ overdue: true }}
            value={report.overdueTaskCount}
          />
          <CounterCell
            label="Без следующего шага"
            search={{ noNextStep: true }}
            value={report.noNextStepDealCount}
          />
          <CounterCell
            label="Критичных сделок"
            search={{ isCritical: true }}
            value={report.criticalDealCount}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function MoneyCard({
  description,
  testId,
  title,
  value,
}: {
  description: string
  testId?: string
  title: string
  value: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Typography as="p" data-testid={testId} variant="h3" wrap="nowrap">
          {value}
        </Typography>
      </CardContent>
    </Card>
  )
}

/**
 * A counter, linked to the list it describes when there is a filter for it.
 *
 * «Новых заявок» has no link: it counts leads submitted inside the dashboard's
 * period, and the list's own date filter is a different question — linking it to
 * an unfiltered list would silently show a different number from the one
 * clicked.
 */
function CounterCell({
  label,
  search,
  value,
}: {
  label: string
  search?: Record<string, boolean>
  value: number
}) {
  const body = (
    <>
      <Typography as="p" variant="h4">
        {String(value)}
      </Typography>
      <Typography tone="muted" variant="caption">
        {label}
      </Typography>
    </>
  )

  return <div className="grid gap-1">{search ? <CounterLink search={search}>{body}</CounterLink> : body}</div>
}

function CounterLink({
  children,
  search,
}: {
  children: ReactNode
  search: Record<string, boolean>
}) {
  return (
    <Link className="grid gap-1 hover:underline" search={search} to="/app/deals">
      {children}
    </Link>
  )
}
