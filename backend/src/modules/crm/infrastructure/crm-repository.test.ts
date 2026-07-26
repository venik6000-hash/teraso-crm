import { describe, expect, test } from 'bun:test'

import { inboundLeadLockKey } from './crm-repository'

/**
 * The inbound advisory lock is what serializes retried and concurrent deliveries of
 * one quiz lead. Its key is derived from the `(source, externalId)` idempotency
 * identity, so the derivation must be injective: two different pairs sharing a key
 * would serialize unrelated leads against each other for no reason.
 */
describe('inboundLeadLockKey', () => {
  test('cannot collide when a delimiter appears inside a component', () => {
    // The ambiguous case a plain `${source}:${externalId}` join would collapse.
    expect(inboundLeadLockKey('a', 'b:c')).not.toBe(inboundLeadLockKey('a:b', 'c'))
    expect(inboundLeadLockKey('teraso.com.ua', 'lead:1')).not.toBe(
      inboundLeadLockKey('teraso.com.ua:lead', '1'),
    )
    // An empty component is still distinguishable from a shifted boundary.
    expect(inboundLeadLockKey('', 'a')).not.toBe(inboundLeadLockKey('a', ''))
  })

  test('is stable for one identity, so retries of a lead take the same lock', () => {
    expect(inboundLeadLockKey('teraso.com.ua', 'lead_ABC123')).toBe(
      inboundLeadLockKey('teraso.com.ua', 'lead_ABC123'),
    )
  })

  test('separates leads that differ only in source or only in external id', () => {
    expect(inboundLeadLockKey('teraso.com.ua', 'lead_1')).not.toBe(
      inboundLeadLockKey('Звонок', 'lead_1'),
    )
    expect(inboundLeadLockKey('teraso.com.ua', 'lead_1')).not.toBe(
      inboundLeadLockKey('teraso.com.ua', 'lead_2'),
    )
  })
})
