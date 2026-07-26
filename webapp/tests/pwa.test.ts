import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { APP_PATH_PREFIX } from '@teraso-crm/contracts'

/**
 * The installable shell (PRD 7.7, PRD 10).
 *
 * The service worker is plain JavaScript served verbatim from `public/`, so it
 * never passes through the type checker or the bundler. These assertions are the
 * only automated guard it has, and the caching one is the important half: a
 * cache in this worker would hold clients, phone numbers and deal history in
 * Cache Storage, outliving logout and surviving the query-cache eviction the app
 * performs on sign-out.
 */

const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'))
const serviceWorker = readFileSync(new URL('../public/service-worker.js', import.meta.url), 'utf8')
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

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

test('the document links the manifest so the app is installable', () => {
  expect(indexHtml).toContain('rel="manifest"')
  expect(indexHtml).toContain('/manifest.webmanifest')
  expect(indexHtml).toContain('name="theme-color"')
})

/**
 * The guard that matters. A `caches.open(...)` here would be a copy of CRM data
 * on disk for every account that ever used the device.
 */
test('the service worker caches nothing at all', () => {
  for (const forbidden of ['caches.open', 'caches.match', 'CacheStorage', 'cache.put', 'cache.addAll']) {
    expect(serviceWorker).not.toContain(forbidden)
  }
  // No fetch interception either: without a handler there is no path by which a
  // CRM response, or the bearer token on it, could be retained.
  expect(serviceWorker).not.toContain("addEventListener('fetch'")
})

test('the service worker never touches credentials or storage', () => {
  for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB', 'accessToken', 'Authorization']) {
    expect(serviceWorker).not.toContain(forbidden)
  }
})

test('the service worker shows the pushed notification and opens its stored href', () => {
  expect(serviceWorker).toContain("addEventListener('push'")
  expect(serviceWorker).toContain('showNotification')
  expect(serviceWorker).toContain("addEventListener('notificationclick'")
  expect(serviceWorker).toContain('openWindow')
  // Focus an existing tab before opening a new one, so a click does not pile up
  // duplicate CRM windows.
  expect(serviceWorker).toContain('matchAll')
})

/**
 * The href is a stored, contract-validated column, and the worker resolves it
 * against its own origin — so even a malformed payload cannot navigate the
 * owner off-site.
 */
test('the service worker only ever navigates inside the app', () => {
  expect(serviceWorker).toContain("startsWith('/app/')")
  expect(serviceWorker).toContain('self.location.origin')
})
