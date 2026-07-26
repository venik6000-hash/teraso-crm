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
 * It nevertheless answers `fetch`, because Chrome and Edge require a fetch
 * handler that can produce a response offline before they will offer to install
 * the app at all — and on iOS, where installation is what unlocks push in the
 * first place, the owner has to be able to install it. The handler is scoped to
 * NAVIGATION requests and only ever runs when the network has already failed;
 * it answers from a string constant in this file. `/api/*` is never touched and
 * nothing is ever written to Cache Storage, so the install criterion is met with
 * zero CRM bytes stored.
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
/**
 * The offline answer for a navigation. A string constant, not a cached page:
 * caching the shell would mean caching whatever the shell was serving.
 */
const OFFLINE_DOCUMENT = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Teraso CRM</title></head>
<body style="font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#18181b">
<main style="padding:24px;text-align:center;max-width:32rem">
<h1 style="font-size:1.25rem;margin:0 0 8px">Нет соединения</h1>
<p style="margin:0;color:#52525b">CRM недоступна без интернета. Проверьте связь и обновите страницу — данные не потеряны, они хранятся на сервере.</p>
</main></body></html>`

/**
 * Navigations only, network first, and nothing is ever stored.
 *
 * Requests to the API are left entirely alone: they must fail as themselves so
 * the app's own error states — and its token refresh — behave normally.
 */
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return
  if (new URL(event.request.url).pathname.startsWith('/api/')) return

  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(OFFLINE_DOCUMENT, {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
    ),
  )
})

/**
 * A push service may rotate a subscription on its own. Without this the old
 * endpoint simply dies and the new one is only registered the next time the
 * owner opens the app — which is exactly what they are not doing if they are
 * relying on push. The page owns the API call, so the worker asks whichever
 * client is open to re-register, and re-subscribes itself so the browser has a
 * live endpoint either way.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const applicationServerKey =
        (event.oldSubscription && event.oldSubscription.options
          ? event.oldSubscription.options.applicationServerKey
          : null) || null
      if (!applicationServerKey) return

      const subscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      })

      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      for (const client of windowClients) {
        client.postMessage({ type: 'push-subscription-changed', subscription: subscription.toJSON() })
      }
    })(),
  )
})

self.addEventListener('push', (event) => {
  const payload = readPayload(event)
  // Sanitised once, here, so the stored destination and the coalescing tag can
  // never describe different places.
  const href = safeAppUrl(payload.href)

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      // Only the destination is retained; nothing else from the payload is
      // stored on the notification.
      data: { href },
      // Repeats ABOUT THE SAME THING replace each other rather than stacking
      // up. The kind is part of the tag on purpose: «Новая заявка» and
      // «Просроченная задача» about one deal are different news, and keying on
      // the destination alone let the second silently erase the first.
      tag: `${payload.kind}:${href}`,
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
      })
      // `navigate()` rejects for an uncontrolled client, and `matchAll` above
      // deliberately admits those — so without this the rejection propagates
      // into waitUntil and the click does nothing at all.
      .catch(() => self.clients.openWindow(target)),
  )
})

function readPayload(event) {
  const fallback = {
    title: 'Teraso CRM',
    body: 'Откройте CRM, чтобы посмотреть событие.',
    href: '/app/deals',
    kind: 'NOTIFICATION',
  }

  if (!event.data) return fallback

  try {
    const parsed = event.data.json()
    return {
      title: typeof parsed.title === 'string' && parsed.title ? parsed.title : fallback.title,
      body: typeof parsed.body === 'string' && parsed.body ? parsed.body : fallback.body,
      href: typeof parsed.href === 'string' && parsed.href ? parsed.href : fallback.href,
      kind: typeof parsed.kind === 'string' && parsed.kind ? parsed.kind : fallback.kind,
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

// Exposed for the policy test, which evaluates this file in a stub `self` scope
// and calls the two pure helpers directly. Assigning them to the worker's own
// global is a no-op at runtime and keeps the test honest about behaviour rather
// than asserting on source text.
self.__testables = { readPayload, safeAppUrl }
