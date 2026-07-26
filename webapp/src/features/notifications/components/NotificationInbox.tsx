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
import { Toggle } from '@/components/ui/toggle'
import { Typography } from '@/components/typography'
import { formatKyivDateTime } from '@/platform/kyiv-time'
import { NOTIFICATION_KIND_LABELS, unreadIdsToMark } from '../model'

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
 *
 * Marking read is bounded by the PAGE, not by the contract's 200-id batch cap,
 * so a busy week leaves more unread than one request can clear. That is stated
 * rather than hidden: the button says how many remain and stays available, and
 * the caller narrows the list to unread so each press works through the backlog
 * instead of re-marking the same newest page for ever.
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
  hasNext = false,
  isError = false,
  isMarking = false,
  isPending = false,
  markError = null,
  notifications,
  onMarkRead,
  onNextPage,
  onOpen,
  onPreviousPage,
  onRetry,
  onToggleUnreadOnly,
  page = 1,
  unreadCount,
  unreadOnly = false,
}: {
  error?: Error | null
  hasNext?: boolean
  isError?: boolean
  isMarking?: boolean
  isPending?: boolean
  markError?: string | null
  notifications: ReadonlyArray<NotificationDto>
  onMarkRead?: () => void
  onNextPage?: () => void
  onOpen?: () => void
  onPreviousPage?: () => void
  onRetry?: () => void
  onToggleUnreadOnly?: (unreadOnly: boolean) => void
  page?: number
  unreadCount: number
  unreadOnly?: boolean
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

  // How many this press can actually clear, so the control never promises more
  // than the single request behind it will do.
  const markableNow = unreadIdsToMark(notifications).length
  const remainingAfterMark = Math.max(0, unreadCount - markableNow)

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Typography tone="muted" variant="caption">
          {unreadCount > 0 ? `Непрочитанных: ${unreadCount}` : 'Все уведомления прочитаны'}
        </Typography>
        <div className="flex flex-wrap items-center gap-2">
          {onToggleUnreadOnly && (
            <Toggle
              aria-label="Показывать только непрочитанные"
              onPressedChange={onToggleUnreadOnly}
              pressed={unreadOnly}
              variant="outline"
            >
              <Typography variant="controlXs">Только непрочитанные</Typography>
            </Toggle>
          )}
          {onMarkRead && markableNow > 0 && (
            <Button
              disabled={isMarking}
              onClick={onMarkRead}
              size="sm"
              type="button"
              variant="outline"
            >
              <Typography variant="control">
                {isMarking ? 'Отмечаем…' : 'Отметить прочитанными'}
              </Typography>
            </Button>
          )}
        </div>
      </div>

      {/*
        A failed mark-read used to be invisible. That request shares one rate
        bucket with every CRM write, so the 429 that batching exists to avoid
        was precisely the failure nobody could see.
      */}
      {markError && (
        <Alert variant="destructive">
          <AlertTitle>Не удалось отметить прочитанными</AlertTitle>
          <AlertDescription>{markError}</AlertDescription>
        </Alert>
      )}

      {onMarkRead && markableNow > 0 && remainingAfterMark > 0 && (
        <Typography tone="muted" variant="caption">
          {`За раз отмечается ${markableNow}, останется ещё ${remainingAfterMark} — нажмите повторно.`}
        </Typography>
      )}

      {notifications.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {unreadOnly ? 'Непрочитанных уведомлений нет' : 'Уведомлений пока нет'}
            </EmptyTitle>
            <EmptyDescription>
              {unreadOnly
                ? 'Всё прочитано. Снимите фильтр, чтобы посмотреть историю.'
                : 'Здесь появятся новые заявки, наступившие и просроченные задачи.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="grid gap-2">
          {notifications.map((entry) => (
            <li key={entry.id}>
              <NotificationRow notification={entry} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}

      {(onNextPage || onPreviousPage) && (page > 1 || hasNext) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            disabled={page <= 1}
            onClick={onPreviousPage}
            size="sm"
            type="button"
            variant="outline"
          >
            <Typography variant="control">Назад</Typography>
          </Button>
          <Typography tone="muted" variant="caption">
            {`Страница ${page}`}
          </Typography>
          <Button
            disabled={!hasNext}
            onClick={onNextPage}
            size="sm"
            type="button"
            variant="outline"
          >
            <Typography variant="control">Дальше</Typography>
          </Button>
        </div>
      )}
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
          {formatKyivDateTime(notification.createdAt)}
        </Typography>
      </div>
    </Link>
  )
}
