/**
 * Browser PWA capabilities: the service worker and the PushManager.
 *
 * This module owns the browser side only — registering the worker, reading and
 * requesting permission, and turning a VAPID key into a subscription. It knows
 * nothing about the CRM's API, which is what keeps it in `platform`: the
 * notifications feature supplies the key it fetched and forwards the resulting
 * subscription. Nothing here decides *when* to ask; that is a product decision
 * and belongs to the card the owner clicks.
 */

/** Served from `webapp/public`, so it is registered at the origin root. */
const SERVICE_WORKER_URL = '/service-worker.js'

export function isServiceWorkerSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
}

/**
 * Push needs three separate browser features, and iOS ships two of the three
 * outside an installed PWA — so all of them are checked rather than assuming
 * that a service worker implies a PushManager.
 */
export function isPushSupported(): boolean {
  return (
    isServiceWorkerSupported() &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function currentPushPermission(): NotificationPermission | null {
  return isPushSupported() ? Notification.permission : null
}

/**
 * Registers the worker and resolves once it is ready to receive pushes.
 *
 * Failure is returned as `null` rather than thrown: a browser in private mode
 * or behind a policy that forbids workers must still get a working CRM, and the
 * inbox does not depend on this succeeding.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isServiceWorkerSupported()) return null

  try {
    await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' })
    return await navigator.serviceWorker.ready
  } catch (error) {
    console.warn('[pwa] service worker registration failed', error)
    return null
  }
}

/**
 * Asks the browser for notification permission.
 *
 * Only ever called from a click handler. Requesting on load is what makes a
 * browser remember a permanent denial for the origin, which cannot be undone
 * from script and would cost the owner push for good.
 */
export async function requestPushPermission(): Promise<NotificationPermission> {
  if (!isPushSupported()) return 'denied'
  return Notification.requestPermission()
}

/**
 * The current subscription for this browser, or a new one for the given key.
 *
 * An existing subscription is reused when it is present, because re-subscribing
 * would rotate the endpoint and orphan the row the server already holds.
 */
export async function ensurePushSubscription(
  registration: ServiceWorkerRegistration,
  vapidPublicKey: string,
): Promise<PushSubscription> {
  const existing = await registration.pushManager.getSubscription()
  if (existing) return existing

  return registration.pushManager.subscribe({
    // Required by every current browser: an unauthenticated subscription is no
    // longer accepted, and Chrome refuses the call outright without it.
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  })
}

/**
 * The wire shape of a subscription, ready to POST.
 *
 * `toJSON()` is the browser's own serialization and matches the contract field
 * for field, so the payload is forwarded rather than rebuilt. The keys are
 * asserted here because `PushSubscriptionJSON` types them as optional while a
 * real subscription always carries both — a missing one means the browser
 * handed back something unusable, and failing here is clearer than a schema
 * error three layers later.
 */
export function toPushSubscriptionPayload(subscription: PushSubscription) {
  const json = subscription.toJSON()
  const p256dh = json.keys?.p256dh
  const auth = json.keys?.auth
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error('Браузер вернул неполную подписку на уведомления')
  }

  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh, auth },
    userAgent: typeof navigator === 'undefined' ? undefined : navigator.userAgent.slice(0, 300),
  }
}

/**
 * Listens for the worker's report that the push service rotated the
 * subscription.
 *
 * The worker re-subscribes on its own, but only the page can authenticate to
 * the API, so it forwards the new subscription here. Without this the rotated
 * endpoint is only registered the next time the app is opened — which is
 * exactly what someone relying on push is not doing.
 */
export function onPushSubscriptionChanged(handler: () => void): () => void {
  if (!isServiceWorkerSupported()) return () => {}

  const listener = (event: MessageEvent) => {
    if (event.data && event.data.type === 'push-subscription-changed') handler()
  }
  navigator.serviceWorker.addEventListener('message', listener)
  return () => navigator.serviceWorker.removeEventListener('message', listener)
}

/**
 * VAPID keys are URL-safe base64; `applicationServerKey` wants raw bytes.
 *
 * The conversion is done here rather than by handing the string straight to
 * `subscribe()`: browsers that accept a string differ on whether they expect
 * standard or URL-safe base64, and a key that decodes to the wrong bytes fails
 * at delivery time rather than at subscription time.
 */
function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  // Allocated over a plain ArrayBuffer rather than left generic: the DOM types
  // for `applicationServerKey` exclude a SharedArrayBuffer-backed view.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index)
  }
  return bytes
}
