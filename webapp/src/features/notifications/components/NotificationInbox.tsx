import {
  Alert02Icon,
  Notification03Icon,
  Task01Icon,
  TimeQuarterPassIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Link } from '@tanstack/react-router'
import type { NotificationDto, NotificationKind } from '@teraso-crm/contracts'

import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Typography } from '@/components/typography'
import { formatDateTime } from '@/features/crm'
import { NOTIFICATION_KIND_LABELS } from '../model'

/**
 * The notification centre (PRD 7.7).
 *
 * It is the source of truth whether or not the browser granted push, so it
 * renders the same list in every push state and never depends on one.
 *
 * `deliveryState` is deliberately absent from the rendering. It is server
 * plumbing that reads FAILED for the moment between the dispatcher claiming a
 * row and the send succeeding, so surfacing it would report a delivered
 * notification as failed — and the owner has no action to take either way.
 */

const iconByKind: Record<NotificationKind, Parameters<typeof HugeiconsIcon>[0]['icon']> = {
  NEW_LEAD: Notification03Icon,
  TASK_DUE: Task01Icon,
  TASK_OVERDUE: TimeQuarterPassIcon,
  LEAD_NEEDS_ACTION: Alert02Icon,
}

/** The two kinds that mean work is already late carry the destructive variant. */
const isUrgentKind = (kind: NotificationKind) =>
  kind === 'TASK_OVERDUE' || kind === 'LEAD_NEEDS_ACTION'

export function NotificationInbox({
  error = null,
  isError = false,
  isPending = false,
  notifications,
  onOpen,
  onRetry,
  unreadCount,
}: {
  error?: Error | null
  isError?: boolean
  isPending?: boolean
  notifications: ReadonlyArray<NotificationDto>
  onOpen?: () => void
  onRetry?: () => void
  unreadCount: number
}) {
  if (isPending) {
    return (
      <div aria-label="Загружаем уведомления" className="grid gap-3" role="status">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  if (isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Уведомления не загрузились</AlertTitle>
        <AlertDescription>{error?.message ?? 'Попробуйте ещё раз.'}</AlertDescription>
        {onRetry && (
          <AlertAction>
            <Button onClick={onRetry} size="sm" type="button" variant="outline">
              <Typography variant="control">Повторить</Typography>
            </Button>
          </AlertAction>
        )}
      </Alert>
    )
  }

  if (notifications.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Уведомлений пока нет</EmptyTitle>
          <EmptyDescription>
            Здесь появятся новые заявки, наступившие и просроченные задачи.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="grid gap-2">
      <Typography tone="muted" variant="caption">
        {unreadCount > 0 ? `Непрочитанных: ${unreadCount}` : 'Все уведомления прочитаны'}
      </Typography>
      <ul className="grid gap-2">
        {notifications.map((entry) => (
          <li key={entry.id}>
            <NotificationRow notification={entry} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One entry, linking at the destination the SERVER stored.
 *
 * `href` is a denormalized column built from the contract's `dealPath`, and the
 * service worker opens that exact value on a push click. Rebuilding the path
 * here would give a click inside the app a different destination from the same
 * notification clicked on the lock screen.
 */
function NotificationRow({
  notification,
  onOpen,
}: {
  notification: NotificationDto
  onOpen?: () => void
}) {
  const isUnread = notification.readAt === null

  return (
    <Link
      className="flex items-start gap-3 rounded-md border p-3 hover:bg-accent"
      onClick={onOpen}
      to={notification.href}
    >
      <HugeiconsIcon
        aria-hidden
        className="mt-0.5 shrink-0"
        icon={iconByKind[notification.kind]}
        strokeWidth={2}
      />
      <div className="grid min-w-0 gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={isUrgentKind(notification.kind) ? 'destructive' : 'secondary'}>
            <Typography variant="controlXs">
              {NOTIFICATION_KIND_LABELS[notification.kind]}
            </Typography>
          </Badge>
          {/* Unread is stated in words, not carried by weight or colour alone. */}
          {isUnread && (
            <Typography tone="muted" variant="caption">
              Новое
            </Typography>
          )}
        </div>
        <Typography variant="control">{notification.title}</Typography>
        <Typography tone="muted" variant="caption">
          {notification.body}
        </Typography>
        <Typography tone="muted" variant="caption">
          {formatDateTime(notification.createdAt)}
        </Typography>
      </div>
    </Link>
  )
}
