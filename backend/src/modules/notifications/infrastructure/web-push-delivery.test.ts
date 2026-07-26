import { describe, expect, test } from 'bun:test'

import { createWebPushDelivery, disabledPushDelivery } from './web-push-delivery'

const vapid = {
  subject: 'mailto:crm@teraso.com.ua',
  publicKey: 'BOl_yWecy7dd7cqwIR8tarfNq2VkxRE02mfa-NEaqCLA81r8GivBYWAZpmG_zKM6rJFc7vMpSHM9JGIjWEI11GA',
  privateKey: 'BUCJiIHPD65Vc69ARTp7LVfMFgnheEm-JEGN5n46Vxw',
}

const subscription = {
  id: 'sub-1',
  endpoint: 'https://push.example/endpoint-1',
  p256dh: 'p256dh-key',
  auth: 'auth-secret',
}

const payload = {
  notificationId: '0196f6f8-6600-7000-8000-000000000001',
  kind: 'TASK_DUE' as const,
  title: 'Пора выполнить задачу',
  body: '«Позвонить» — Олександр',
  href: '/deals/0196f6f8-6600-7000-8000-000000000002',
}

/** A provider rejection shaped like `web-push`'s own WebPushError. */
function pushError(statusCode: number) {
  return Object.assign(new Error(`Received unexpected response code ${statusCode}`), {
    statusCode,
  })
}

describe('createWebPushDelivery', () => {
  test('reports a successful send and hands the payload to the provider as JSON', async () => {
    const calls: Array<{
      endpoint: string
      payload: string
      subject: string
      privateKey: string
      timeout: number
    }> = []
    const delivery = createWebPushDelivery(vapid, async (target, body, options) => {
      calls.push({
        endpoint: target.endpoint,
        payload: String(body),
        subject: options.vapidDetails.subject,
        privateKey: options.vapidDetails.privateKey,
        timeout: options.timeout,
      })
      return undefined
    })

    expect(delivery.configured).toBe(true)
    expect(await delivery.send(subscription, payload)).toEqual({ status: 'sent' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.endpoint).toBe(subscription.endpoint)
    expect(JSON.parse(calls[0]!.payload)).toEqual(payload)
    expect(calls[0]!.subject).toBe(vapid.subject)
    expect(calls[0]!.privateKey).toBe(vapid.privateKey)
  })

  /**
   * Node's `https.request` has no default timeout, so a push service that accepts
   * the connection and never answers would hold the request open forever — and the
   * dispatcher sends serially, on an unattended schedule, so that is not one lost
   * notification but a pass that never ends. A missing timeout is invisible in
   * every other test here, which is why it is asserted on its own.
   */
  test('bounds every send with a socket timeout', async () => {
    const timeouts: Array<number | undefined> = []
    const delivery = createWebPushDelivery(vapid, async (_target, _body, options) => {
      timeouts.push(options.timeout)
      return undefined
    })

    await delivery.send(subscription, payload)

    expect(timeouts).toHaveLength(1)
    expect(typeof timeouts[0]).toBe('number')
    expect(timeouts[0]).toBeGreaterThan(0)
    expect(timeouts[0]).toBeLessThanOrEqual(30_000)
  })

  test('keeps the subscription when a send times out', async () => {
    const delivery = createWebPushDelivery(vapid, async () => {
      throw new Error('socket hang up')
    })

    expect(await delivery.send(subscription, payload)).toEqual({
      status: 'failed',
      reason: 'socket hang up',
    })
  })

  test('treats 404 and 410 as terminal so only those retire an endpoint', async () => {
    for (const statusCode of [404, 410]) {
      const delivery = createWebPushDelivery(vapid, async () => {
        throw pushError(statusCode)
      })
      expect(await delivery.send(subscription, payload)).toEqual({ status: 'expired' })
    }
  })

  test('keeps the subscription for every non-terminal provider failure', async () => {
    for (const statusCode of [400, 401, 403, 413, 429, 500, 503]) {
      const delivery = createWebPushDelivery(vapid, async () => {
        throw pushError(statusCode)
      })
      const outcome = await delivery.send(subscription, payload)
      expect(outcome.status).toBe('failed')
    }
  })

  test('keeps the subscription when the provider is unreachable', async () => {
    const delivery = createWebPushDelivery(vapid, async () => {
      throw new Error('ECONNRESET')
    })

    const outcome = await delivery.send(subscription, payload)
    expect(outcome).toEqual({ status: 'failed', reason: 'ECONNRESET' })
  })

  test('an absent VAPID pair yields an unconfigured adapter that never calls the provider', async () => {
    let called = false
    const delivery = createWebPushDelivery(undefined, async () => {
      called = true
      return undefined
    })

    expect(delivery.configured).toBe(false)
    expect(await delivery.send(subscription, payload)).toEqual({
      status: 'failed',
      reason: 'push delivery is not configured',
    })
    expect(called).toBe(false)
    expect(disabledPushDelivery.configured).toBe(false)
  })
})
