/**
 * Teraso CRM service worker.
 *
 * Its whole job is push (PRD 7.7): show the notification the server sent, and
 * put the owner on the right deal card when it is clicked.
 *
 * It deliberately CACHES NOTHING. An offline shell would be a nice-to-have; a
 * cache in this worker holding CRM responses would be a copy of clients, phone
 * numbers and deal history sitting in Cache Storage for every account that ever
 * used the device, outliving logout and surviving the query-cache eviction the
 * app does on sign-out. Access tokens are never written here either — they live
 * in memory in the page, and this worker never sees or requests one.
 *
 * Served from `webapp/public`, so it is plain JavaScript with no build step: it
 * is copied to the origin root verbatim in both dev and production.
 */

/** Take over without waiting for every open tab to be closed. */
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

/**
 * The payload is `{ notificationId, kind, title, body, href }` as sent by the
 * backend's push dispatcher. A push that arrives without a readable body still
 * shows something: the subscription was made with `userVisibleOnly: true`, so a
 * silent push would have the browser show its own generic notification and, on
 * repeat, revoke the permission.
 */
self.addEventListener('push', (event) => {
  const payload = readPayload(event)

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      // Only the destination is retained; nothing else from the payload is
      // stored on the notification.
      data: { href: payload.href },
      // Notifications about the same deal replace each other rather than
      // stacking up into a wall the owner has to dismiss one by one.
      tag: payload.href,
      renotify: true,
    }),
  )
})

/**
 * Focus an open CRM tab and navigate it, or open a new one.
 *
 * The href comes from the server, where it is a stored column validated against
 * the app's own path prefix, and it is resolved against this worker's origin —
 * so a click can never navigate off-origin even if a payload were malformed.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const target = safeAppUrl(event.notification.data && event.notification.data.href)

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (const client of windowClients) {
          if (new URL(client.url).origin !== self.location.origin) continue
          if ('focus' in client) {
            return 'navigate' in client ? client.navigate(target).then((c) => c && c.focus()) : client.focus()
          }
        }
        return self.clients.openWindow(target)
      }),
  )
})

function readPayload(event) {
  const fallback = {
    title: 'Teraso CRM',
    body: 'Откройте CRM, чтобы посмотреть событие.',
    href: '/app/deals',
  }

  if (!event.data) return fallback

  try {
    const parsed = event.data.json()
    return {
      title: typeof parsed.title === 'string' && parsed.title ? parsed.title : fallback.title,
      body: typeof parsed.body === 'string' && parsed.body ? parsed.body : fallback.body,
      href: typeof parsed.href === 'string' && parsed.href ? parsed.href : fallback.href,
    }
  } catch {
    return fallback
  }
}

/** Same-origin, in-app destinations only. */
function safeAppUrl(href) {
  const fallback = new URL('/app/deals', self.location.origin)
  if (typeof href !== 'string' || !href.startsWith('/app/') ) return fallback.href

  const url = new URL(href, self.location.origin)
  return url.origin === self.location.origin ? url.href : fallback.href
}
