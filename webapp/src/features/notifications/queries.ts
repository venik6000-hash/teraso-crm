import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { NotificationListQuery } from '@teraso-crm/contracts'
import { useCallback, useEffect, useState } from 'react'

import { useAuth } from '@/features/auth'
import {
  currentPushPermission,
  ensurePushSubscription,
  isPushSupported,
  onPushSubscriptionChanged,
  registerServiceWorker,
  requestPushPermission,
  toPushSubscriptionPayload,
} from '@/platform/pwa/register'
import { getVapidPublicKey, listNotifications, markNotificationsRead, subscribeToPush } from './api'
import { toRussianTransportMessage, unreadIdsToMark, type PushPermissionState } from './model'

/**
 * Cache keys for the notification centre.
 *
 * Rooted at `['notifications']`, which is not an arbitrary choice: every CRM
 * mutation already invalidates that root (a deal turning critical writes a
 * notification), and `features/auth/queries.ts` already evicts it on logout.
 * Keying anywhere else would serve the next account the previous one's inbox.
 */
export const notificationQueryKeys = {
  inbox: (filters: NotificationListQuery) => ['notifications', 'inbox', filters] as const,
  vapidKey: () => ['notifications', 'vapid-key'] as const,
}

/**
 * How often the inbox refetches while the app is open.
 *
 * Polling is safe here specifically because `createAuthRateLimit`
 * short-circuits on GET, so reads are not metered — unlike the mark-read POST,
 * which shares one bucket with every CRM write and is therefore batched.
 */
const INBOX_POLL_INTERVAL_MS = 60_000

export function useNotificationInboxQuery(filters: NotificationListQuery) {
  const auth = useAuth()
  return useQuery({
    queryKey: notificationQueryKeys.inbox(filters),
    queryFn: () => listNotifications(auth.transport, filters),
    enabled: auth.isAuthenticated,
    refetchInterval: INBOX_POLL_INTERVAL_MS,
  })
}

/**
 * Marks the open inbox read in one request.
 *
 * The mutation takes the notifications rather than ids so the capping rule
 * lives in one place, and it no-ops on an inbox that is already read instead of
 * spending a request from the shared write budget to update zero rows.
 */
export function useMarkNotificationsReadMutation() {
  const auth = useAuth()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (notifications: Parameters<typeof unreadIdsToMark>[0]) => {
      const ids = unreadIdsToMark(notifications)
      if (ids.length === 0) return null
      return markNotificationsRead(auth.transport, ids)
    },
    onSuccess: (result) => {
      if (!result) return
      void queryClient.invalidateQueries({ queryKey: ['notifications'] })
    },
    /**
     * A failure here is surfaced by the caller through `isError`, never
     * swallowed. This endpoint shares one per-IP bucket with every CRM write,
     * so a 429 is its most likely failure — and a silent one would leave the
     * unread badge stuck with no explanation.
     */
  })
}

type PushSubscriptionState = {
  permission: PushPermissionState
  isPending: boolean
  error: Error | null
  enable: () => void
}

/**
 * Owns the browser push lifecycle for the signed-in session (PRD 7.7).
 *
 * Two behaviours here are deliberate and easy to get wrong:
 *
 * 1. Permission is requested ONLY from `enable`, which a click calls. Asking on
 *    load is how an origin earns a permanent denial that no script can undo.
 * 2. An already-granted permission still re-posts the subscription on every
 *    boot. The server may have retired the endpoint after a 404/410 from the
 *    push service without the browser knowing, and the POST is an upsert — so
 *    re-sending is how a silently dropped subscription heals itself.
 */
export function usePushSubscription(): PushSubscriptionState {
  const auth = useAuth()
  const [permission, setPermission] = useState<PushPermissionState>(() => readPermission())
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const synchronize = useCallback(
    async (granted: boolean) => {
      if (!granted) return
      const registration = await registerServiceWorker()
      if (!registration) return

      const publicKey = await getVapidPublicKey(auth.transport)
      const subscription = await ensurePushSubscription(registration, publicKey)
      await subscribeToPush(auth.transport, toPushSubscriptionPayload(subscription))
    },
    [auth.transport],
  )

  useEffect(() => {
    if (!auth.isAuthenticated || readPermission() !== 'granted') return

    let cancelled = false
    const refresh = () =>
      void synchronize(true).catch((cause) => {
        // A deployment without VAPID keys answers 404 here. That is a supported
        // configuration, not a failure the owner needs to see: the inbox is the
        // source of truth either way, so it is logged and swallowed.
        if (!cancelled) console.warn('[notifications] push refresh failed', cause)
      })

    refresh()
    // The push service can rotate the subscription while the app is open; the
    // worker re-subscribes and tells the page, which is the only side that can
    // authenticate the re-registration.
    const stopListening = onPushSubscriptionChanged(refresh)

    return () => {
      cancelled = true
      stopListening()
    }
  }, [auth.isAuthenticated, synchronize])

  const enable = useCallback(() => {
    setIsPending(true)
    setError(null)

    void (async () => {
      try {
        const result = await requestPushPermission()
        setPermission(result === 'granted' ? 'granted' : result === 'denied' ? 'denied' : 'default')
        await synchronize(result === 'granted')
      } catch (cause) {
        setError(new Error(toRussianTransportMessage(cause)))
      } finally {
        setIsPending(false)
      }
    })()
  }, [synchronize])

  return { permission, isPending, error, enable }
}

function readPermission(): PushPermissionState {
  if (!isPushSupported()) return 'unsupported'
  const permission = currentPushPermission()
  return permission === 'granted' || permission === 'denied' ? permission : 'default'
}
