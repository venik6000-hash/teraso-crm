import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { APP_PATH_PREFIX } from '@teraso-crm/contracts'

/**
 * The installable shell (PRD 7.7, PRD 10).
 *
 * The service worker is plain JavaScript served verbatim from `public/`, so it
 * never passes through the type checker or the bundler — these assertions are
 * the only automated guard it has.
 *
 * The two halves of that guard are different in kind. The no-cache rules are
 * POLICY and are asserted against the source, because the point is that certain
 * APIs must not appear at all. Everything else is BEHAVIOUR and is asserted by
 * evaluating the worker in a stub `self` scope and calling its pure helpers: a
 * source-text check would pass just as happily against a guard that had been
 * inverted, commented out or left unreachable.
 */

const manifest = JSON.parse(
  readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'),
)
const serviceWorker = readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8')
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

const ORIGIN = 'https://crm.example'

type Payload = { title: string; body: string; href: string; kind: string }

/** Runs the worker against a stub global and hands back its pure helpers. */
function loadWorker() {
  const listeners: Record<string, unknown> = {}
  const self = {
    addEventListener: (type: string, handler: unknown) => {
      listeners[type] = handler
    },
    location: { origin: ORIGIN },
    registration: {},
    clients: {},
    skipWaiting: () => {},
  } as Record<string, unknown>

  new Function('self', serviceWorker)(self)

  const testables = self.__testables as {
    readPayload: (event: { data?: { json: () => unknown } }) => Payload
    safeAppUrl: (href: unknown) => string
  }
  return { ...testables, listeners }
}

test('the manifest describes an installable Russian CRM', () => {
  expect(manifest).toMatchObject({
    name: 'Teraso CRM',
    short_name: 'Teraso CRM',
    lang: 'ru',
    display: 'standalone',
    start_url: '/app/dashboard',
    theme_color: '#18181b',
    background_color: '#fafafa',
  })
  // The launch destination has to be inside the authenticated workspace, or the
  // installed app opens on the sign-in screen every time.
  expect(manifest.start_url.startsWith(`${APP_PATH_PREFIX}/`)).toBe(true)
  expect(manifest.icons.length).toBeGreaterThan(0)
})

/**
 * A board that scrolls horizontally is the headline surface of this release, so
 * the installed app must not be pinned to portrait.
 */
test('the manifest does not lock the installed app to one orientation', () => {
  expect(manifest.orientation).toBeUndefined()
})

test('the document links the manifest so the app is installable', () => {
  expect(indexHtml).toContain('rel="manifest"')
  expect(indexHtml).toContain('/manifest.webmanifest')
  expect(indexHtml).toContain('name="theme-color"')
})

/* ------------------------------------------------------------------ *
 * Policy: what must never appear
 * ------------------------------------------------------------------ */

/**
 * The guard that matters. A `caches.open(...)` here would be a copy of CRM data
 * on disk for every account that ever used the device, outliving logout.
 */
test('the service worker stores nothing, anywhere', () => {
  for (const forbidden of [
    'caches.open',
    'caches.match',
    'CacheStorage',
    'cache.put',
    'cache.addAll',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'accessToken',
    'Authorization',
  ]) {
    expect(serviceWorker).not.toContain(forbidden)
  }
})

/* ------------------------------------------------------------------ *
 * Behaviour
 * ------------------------------------------------------------------ */

/**
 * Chrome and Edge will not offer to install an app whose worker cannot answer a
 * navigation offline, and on iOS installation is what unlocks push at all — so
 * the handler exists, and is scoped so that satisfying that criterion stores
 * nothing.
 */
test('the worker handles the events the product depends on', () => {
  const { listeners } = loadWorker()

  expect(listeners.fetch).toBeDefined()
  expect(listeners.push).toBeDefined()
  expect(listeners.notificationclick).toBeDefined()
  // The browser-side half of subscription rotation.
  expect(listeners.pushsubscriptionchange).toBeDefined()
})

test('the worker refuses to navigate anywhere outside the app', () => {
  const { safeAppUrl } = loadWorker()
  const fallback = `${ORIGIN}/app/deals`

  // An absolute off-origin URL, and the protocol-relative form a plain
  // startsWith('/') check would admit.
  expect(safeAppUrl('https://evil.example.com/app/deals')).toBe(fallback)
  expect(safeAppUrl('//evil.example.com')).toBe(fallback)
  expect(safeAppUrl('/login')).toBe(fallback)
  expect(safeAppUrl('/application/deals')).toBe(fallback)
  expect(safeAppUrl(null)).toBe(fallback)
  expect(safeAppUrl('null')).toBe(fallback)
  expect(safeAppUrl(42)).toBe(fallback)
  expect(safeAppUrl(undefined)).toBe(fallback)

  // A real destination survives untouched.
  expect(safeAppUrl('/app/deals/11111111-1111-4111-8111-111111111111')).toBe(
    `${ORIGIN}/app/deals/11111111-1111-4111-8111-111111111111`,
  )
})

/**
 * The subscription is made with `userVisibleOnly`, so a push that shows nothing
 * costs the origin its permission. Every malformed payload therefore still has
 * to produce a notification.
 */
test('a hostile or missing payload still yields a usable notification', () => {
  const { readPayload } = loadWorker()

  expect(readPayload({})).toMatchObject({ title: 'Teraso CRM', href: '/app/deals' })
  expect(
    readPayload({
      data: {
        json: () => {
          throw new Error('not json')
        },
      },
    }),
  ).toMatchObject({ title: 'Teraso CRM' })
  expect(
    readPayload({ data: { json: () => ({ title: 42, body: null, href: [] }) } }),
  ).toMatchObject({ title: 'Teraso CRM', href: '/app/deals' })

  const real = readPayload({
    data: {
      json: () => ({
        title: 'Новая заявка',
        body: 'Олена',
        href: '/app/deals/x',
        kind: 'NEW_LEAD',
      }),
    },
  })
  expect(real).toMatchObject({ title: 'Новая заявка', kind: 'NEW_LEAD' })
})

/**
 * Two different pieces of news about one deal must not erase each other on the
 * lock screen, which is what keying the tag on the destination alone did.
 */
test('notifications about one deal coalesce per kind, not per destination', () => {
  expect(serviceWorker).toContain('`${payload.kind}:${href}`')
})
