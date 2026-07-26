import { expect, test } from 'bun:test'
import {
  NOTIFICATIONS_MAX_READ_BATCH,
  dealPath,
  type NotificationDto,
} from '@teraso-crm/contracts'
import { renderToStaticMarkup } from 'react-dom/server'

import { NotificationBell } from '../src/features/notifications/components/NotificationBell'
import { NotificationInbox } from '../src/features/notifications/components/NotificationInbox'
import { PushPermissionCard } from '../src/features/notifications/components/PushPermissionCard'
import {
  NOTIFICATION_KIND_LABELS,
  toRussianTransportMessage,
  unreadIdsToMark,
} from '../src/features/notifications/model'
import { renderInRouter } from './render-in-router'

const DEAL_ID = '11111111-1111-4111-8111-111111111111'

function notification(overrides: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'NEW_LEAD',
    title: 'Новая заявка',
    body: 'Олена Ковальчук · quiz',
    href: dealPath(DEAL_ID),
    dealId: DEAL_ID,
    deliveryState: 'PENDING',
    readAt: null,
    createdAt: '2026-07-20T08:30:00.000Z',
    ...overrides,
  }
}

/* ------------------------------------------------------------------ *
 * Push permission (PRD 7.7)
 * ------------------------------------------------------------------ */

/**
 * The inbox is the source of truth, push is best effort. A browser that refuses
 * permission must therefore leave the owner with a working product and a clear
 * statement of what still works — not a dead end.
 */
test('inbox remains useful after push denial', () => {
  const html = renderToStaticMarkup(<PushPermissionCard permission="denied" />)

  expect(html).toContain('Уведомления остаются в CRM')
  // A denied permission cannot be re-requested from script, so offering the
  // button again would be a control that silently does nothing.
  expect(html).not.toContain('Разрешить уведомления')
})

test('explains the fallback on a browser without push support', () => {
  const html = renderToStaticMarkup(<PushPermissionCard permission="unsupported" />)

  expect(html).toContain('Уведомления остаются в CRM')
  expect(html).not.toContain('Разрешить уведомления')
})

test('offers the permission prompt only when it can still be granted', () => {
  expect(renderToStaticMarkup(<PushPermissionCard permission="default" />)).toContain(
    'Разрешить уведомления',
  )
  const granted = renderToStaticMarkup(<PushPermissionCard permission="granted" />)
  expect(granted).toContain('Push включён')
  expect(granted).not.toContain('Разрешить уведомления')
})

test('reports a subscription failure in Russian without offering a broken retry loop', () => {
  const html = renderToStaticMarkup(
    <PushPermissionCard error={new Error('Push-уведомления не настроены')} permission="default" />,
  )

  expect(html).toContain('Push-уведомления не настроены')
})

/* ------------------------------------------------------------------ *
 * Inbox
 * ------------------------------------------------------------------ */

test('renders inbox entries with their kind and destination', async () => {
  const html = await renderInRouter(
    <NotificationInbox
      notifications={[notification(), notification({ id: '33333333-3333-4333-8333-333333333333', kind: 'TASK_OVERDUE', title: 'Просроченная задача' })]}
      unreadCount={2}
    />,
    '/app/notifications',
  )

  expect(html).toContain('Новая заявка')
  expect(html).toContain('Просроченная задача')
  expect(html).toContain(NOTIFICATION_KIND_LABELS.TASK_OVERDUE)
  expect(html).toContain(dealPath(DEAL_ID))
})

/**
 * `deliveryState` is server plumbing: it briefly reads FAILED between the
 * dispatcher claiming a row and the send succeeding, so showing it would tell
 * the owner a delivered notification had failed.
 */
test('never renders push delivery state as user-facing status', async () => {
  const html = await renderInRouter(
    <NotificationInbox notifications={[notification({ deliveryState: 'FAILED' })]} unreadCount={1} />,
    '/app/notifications',
  )

  for (const state of ['FAILED', 'PENDING', 'SKIPPED', 'SENT']) {
    expect(html).not.toContain(state)
  }
})

test('states the empty inbox rather than rendering nothing', async () => {
  const html = await renderInRouter(
    <NotificationInbox notifications={[]} unreadCount={0} />,
    '/app/notifications',
  )

  expect(html).toContain('Уведомлений пока нет')
})

test('shows the unread count on the bell and hides it at zero', () => {
  expect(renderToStaticMarkup(<NotificationBell unreadCount={3} />)).toContain('3')
  const quiet = renderToStaticMarkup(<NotificationBell unreadCount={0} />)
  expect(quiet).toContain('Уведомления')
  expect(quiet).not.toContain('непрочитанных')
})

/* ------------------------------------------------------------------ *
 * Batching and transport errors
 * ------------------------------------------------------------------ */

/**
 * `POST /api/notifications/read` shares one per-IP rate bucket with every CRM
 * write, so marking an inbox read must be ONE request, and the contract caps a
 * batch at 200 ids.
 */
test('marks unread notifications in a single capped batch', () => {
  const unread = Array.from({ length: NOTIFICATIONS_MAX_READ_BATCH + 5 }, (_, index) =>
    notification({ id: `${index}` }),
  )

  const ids = unreadIdsToMark(unread)
  expect(ids).toHaveLength(NOTIFICATIONS_MAX_READ_BATCH)

  // Already-read entries are not resent: they would consume the batch budget
  // and update nothing.
  expect(unreadIdsToMark([notification({ readAt: '2026-07-20T09:00:00.000Z' })])).toEqual([])
  expect(unreadIdsToMark([])).toEqual([])
})

/** The backend's rate-limit body is English on an otherwise Russian surface. */
test('translates a transport rate limit into Russian at the boundary', () => {
  expect(toRussianTransportMessage(rateLimited())).toBe(
    'Слишком много запросов подряд. Подождите минуту и повторите.',
  )
  // An authored Russian message from the API passes through untouched.
  expect(toRussianTransportMessage(new Error('Сделка не найдена'))).toBe('Сделка не найдена')
})

function rateLimited() {
  const error = new Error('Too many authentication requests') as Error & { code: string }
  error.code = 'RATE_LIMITED'
  return error
}
