import {
  NOTIFICATIONS_MAX_READ_BATCH,
  type NotificationKind,
  type NotificationDto,
} from '@teraso-crm/contracts'

/**
 * Presentation and pure rules for the notification centre (PRD 7.7).
 *
 * Deliberately free of React and of the transport, so the batching rule and the
 * message translation below are exercised directly rather than through a
 * rendered component.
 */

/**
 * Kinds cross the wire in English and are shown in Russian. Each entry pairs
 * with an icon in the inbox, so a kind is never carried by colour alone
 * (PRD 7.0).
 */
export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  NEW_LEAD: 'Новая заявка',
  TASK_DUE: 'Наступила задача',
  TASK_OVERDUE: 'Просроченная задача',
  LEAD_NEEDS_ACTION: 'Заявка без следующего шага',
}

/**
 * The ids to send in one `POST /api/notifications/read`.
 *
 * That endpoint shares a single per-IP rate bucket with every CRM write, so
 * opening an inbox must cost one request rather than one per entry. The
 * contract caps a batch at `NOTIFICATIONS_MAX_READ_BATCH`, and already-read
 * entries are dropped because they would spend that budget updating nothing.
 *
 * A fuller inbox than one batch is not a problem worth extra machinery: the
 * remainder is marked the next time the inbox is opened, and the unread count
 * the server returns stays authoritative throughout.
 */
export function unreadIdsToMark(notifications: ReadonlyArray<NotificationDto>): string[] {
  return notifications
    .filter((entry) => entry.readAt === null)
    .slice(0, NOTIFICATIONS_MAX_READ_BATCH)
    .map((entry) => entry.id)
}

/**
 * Russian text for a transport failure.
 *
 * The backend answers a rate limit with an English body (`RATE_LIMITED` /
 * "Too many authentication requests") because the limiter is shared with the
 * template's own auth routes, and this is a Russian surface. Anything the API
 * authored in Russian passes through untouched, so a domain rejection such as
 * «Недопустимый переход воронки» still reaches the owner in the words the
 * server chose.
 *
 * Cyrillic is the test rather than the status code, exactly as
 * `features/crm/validation.ts` does it for Zod: a code-based rule would have to
 * be kept in step with every message the API can produce.
 */
export function toRussianTransportMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null

  if (code === 'RATE_LIMITED') {
    return 'Слишком много запросов подряд. Подождите минуту и повторите.'
  }
  if (message && /[А-Яа-яЁё]/.test(message)) return message
  return 'Не удалось выполнить запрос. Попробуйте ещё раз.'
}

/**
 * How the browser currently stands on push, as one value the card can switch on.
 *
 * `unsupported` is its own state rather than a variant of `denied`: nothing the
 * owner does in a browser without a PushManager will change the answer, so the
 * explanation differs even though both end in the same fallback.
 */
export type PushPermissionState = 'unsupported' | 'default' | 'granted' | 'denied'
