import type { DashboardFunnelStepDto } from '@teraso-crm/contracts'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { Typography } from '@/components/typography'
import { DEAL_STAGE_LABELS, formatShare } from '../model'

/**
 * Funnel conversions over the period (PRD 7.8 item 5).
 *
 * The chart is paired with a plain list of the same numbers, and that pairing is
 * the point rather than redundancy: PRD 7.0 forbids colour being the only
 * carrier of meaning, a bar chart is unreadable to a screen reader, and the four
 * counts are the actual finding. The chart shows the SHAPE; the list states the
 * values.
 *
 * Both read the counts and shares the server computed from STAGE_CHANGED
 * activities. Nothing here divides one count by another — the normalization is
 * the server's, so the browser cannot invent a second definition of conversion.
 */

const chartConfig = {
  count: { label: 'Переходов', color: 'var(--chart-1)' },
} satisfies ChartConfig

export function FunnelChart({ funnel }: { funnel: ReadonlyArray<DashboardFunnelStepDto> }) {
  const hasMovement = funnel.some((step) => step.count > 0)
  const data = funnel.map((step) => ({
    label: `${DEAL_STAGE_LABELS[step.fromStage]} → ${DEAL_STAGE_LABELS[step.toStage]}`,
    shortLabel: DEAL_STAGE_LABELS[step.toStage],
    count: step.count,
    share: step.share,
  }))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Конверсии по этапам</CardTitle>
        <CardDescription>
          Переходы между соседними этапами за период. Доля считается от первого перехода воронки.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {hasMovement ? (
          <ChartContainer className="min-h-48 w-full" config={chartConfig}>
            <BarChart accessibilityLayer data={[...data]} layout="vertical" margin={{ left: 12 }}>
              <CartesianGrid horizontal={false} />
              <XAxis allowDecimals={false} dataKey="count" type="number" />
              <YAxis
                axisLine={false}
                dataKey="shortLabel"
                tickLine={false}
                type="category"
                width={140}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="count" fill="var(--color-count)" radius={4} />
            </BarChart>
          </ChartContainer>
        ) : (
          <Typography tone="muted" variant="bodySm">
            За период переходов между этапами не было.
          </Typography>
        )}

        {/* The same numbers as text: the accessible reading of the chart. */}
        <ul className="grid gap-2">
          {data.map((step) => (
            <li className="flex flex-wrap items-baseline justify-between gap-2" key={step.label}>
              <Typography variant="bodySm">{step.label}</Typography>
              <Typography tone="muted" variant="caption" wrap="nowrap">
                {`${step.count} · ${formatShare(step.share)}`}
              </Typography>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
