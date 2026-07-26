import type { DashboardSourceDto } from '@teraso-crm/contracts'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Typography } from '@/components/typography'
import { formatMoney } from '../model'

/**
 * Performance by source and UTM (PRD 7.8 item 6).
 *
 * A real table with real column headers, so a screen reader announces each
 * figure with the measure it belongs to — five numbers per row is exactly the
 * case where a grid of divs stops being readable.
 *
 * The three measures answer different questions on purpose: leads and wins are
 * counted inside the period, while open pipeline is a snapshot of money still in
 * play. A source that brought nothing this month but still holds open deals is
 * the row worth seeing, so the header says which is which.
 *
 * On a phone the table scrolls inside its own container rather than widening the
 * page (PRD 10).
 */
export function SourcePerformanceTable({
  sources,
}: {
  sources: ReadonlyArray<DashboardSourceDto>
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Источники</CardTitle>
        <CardDescription>
          Заявки и успешные сделки — за период; открытая воронка — на сейчас.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sources.length === 0 ? (
          <Typography tone="muted" variant="bodySm">
            За период заявок не было.
          </Typography>
        ) : (
          <div className="w-full overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Источник</TableHead>
                  <TableHead scope="col">UTM Source</TableHead>
                  <TableHead scope="col">Заявок</TableHead>
                  <TableHead scope="col">Открытая воронка</TableHead>
                  <TableHead scope="col">Успешных</TableHead>
                  <TableHead scope="col">Сумма успешных</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((row) => (
                  <TableRow key={`${row.source}::${row.utmSource ?? ''}`}>
                    <TableCell>
                      <Typography variant="bodySm">{row.source}</Typography>
                    </TableCell>
                    <TableCell>
                      {/* Never a blank cell: "no UTM" is a finding about the
                          traffic, not missing data. */}
                      <Typography tone={row.utmSource ? 'default' : 'muted'} variant="bodySm">
                        {row.utmSource ?? 'Без UTM'}
                      </Typography>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <Typography variant="bodySm">{String(row.leadCount)}</Typography>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <Typography variant="bodySm" wrap="nowrap">
                        {formatMoney(row.openPipelineAmount)}
                      </Typography>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <Typography variant="bodySm">{String(row.wonCount)}</Typography>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <Typography variant="bodySm" wrap="nowrap">
                        {formatMoney(row.wonAmount)}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
