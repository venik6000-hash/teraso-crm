import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from '@/components/ui/card'
import { Typography } from '@/components/typography'

export function DataTableFrame({
  children,
  description,
  nextDisabled,
  nextLabel = 'Next',
  onNext,
  onPrevious,
  previousDisabled,
  previousLabel = 'Previous',
  summary,
  title,
  toolbar,
}: {
  children: ReactNode
  description?: string
  nextDisabled: boolean
  /** The workspace is English and the CRM is Russian; both share this frame. */
  nextLabel?: string
  onNext: () => void
  onPrevious: () => void
  previousDisabled: boolean
  previousLabel?: string
  summary: string
  title: string
  toolbar?: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <Typography as="h2" variant="h6">
          {title}
        </Typography>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <div className="grid gap-5">
          {toolbar && (
            <Typography as="div" variant="bodySm">
              {toolbar}
            </Typography>
          )}
          <div className="overflow-x-auto">{children}</div>
        </div>
      </CardContent>
      <CardFooter className="flex-col items-stretch justify-between gap-3 border-t sm:flex-row sm:items-center">
        <Typography variant="bodySm" tone="muted">
          {summary}
        </Typography>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Button
            disabled={previousDisabled}
            onClick={onPrevious}
            type="button"
            variant="outline"
          >
            {previousLabel}
          </Button>
          <Button
            disabled={nextDisabled}
            onClick={onNext}
            type="button"
            variant="outline"
          >
            {nextLabel}
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}
