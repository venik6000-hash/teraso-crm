import { Alert02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import { Badge } from '@/components/ui/badge'
import { Typography } from '@/components/typography'

/**
 * The «Критичная» marker.
 *
 * `isCritical` is computed on the server on every read and is never re-derived
 * here: it is a function of wall-clock time that the backend guards against
 * drift, and a third copy of the rule living in the browser would be invisible
 * to that guard.
 *
 * Per PRD 7.0 the state is carried by words and an icon, not by the red alone —
 * the badge always says «Требует действия», and names the reason when the row
 * knows it.
 */
export function CriticalBadge({
  hasOverdueTask = false,
  isCritical,
  noNextStep = false,
}: {
  hasOverdueTask?: boolean
  isCritical: boolean
  noNextStep?: boolean
}) {
  if (!isCritical) return null

  const reasons = [
    noNextStep ? 'нет следующего шага' : null,
    hasOverdueTask ? 'просроченная задача' : null,
  ].filter((reason): reason is string => reason !== null)

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant="destructive">
        <HugeiconsIcon aria-hidden icon={Alert02Icon} strokeWidth={2} />
        <Typography variant="controlXs">Требует действия</Typography>
      </Badge>
      {reasons.length > 0 && (
        <Typography variant="caption" tone="muted">
          {reasons.join(', ')}
        </Typography>
      )}
    </span>
  )
}
