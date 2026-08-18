import { describe, expect, test } from 'bun:test'

import { ImportArgsError, parseImportArgs, toInboundLead } from './import-site-leads'

/**
 * The mapping from a site's own lead backup onto the inbound contract.
 *
 * Two sites feed this CRM and they write different backups. teraso.com.ua stores
 * flat `utm_source`/`utm_campaign` columns and a `lead_<utc-stamp>_<rand>` id;
 * teraso.in.ua nests the same values under `utm` and issues a bare random id. A
 * row from either has to produce the same card, and — more importantly — the same
 * receipt on a re-run, because the receipt is the only thing standing between a
 * top-up import and a board full of duplicate deals.
 */

/** A minimal row that maps cleanly, so each test can vary one thing. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    lead_id: '569a4ba2caf6c4e3',
    time: '2026-08-16 11:06:20',
    source: 'consult',
    name: 'Олена',
    phone: '+38 (067) 362-27-31',
    ...overrides,
  }
}

function mapped(overrides: Record<string, unknown> = {}, source = 'teraso.in.ua') {
  const result = toInboundLead(row(overrides), source)
  if (!result.ok) throw new Error(`expected a lead, got skip: ${result.reason} ${result.detail ?? ''}`)
  return result.lead
}

describe('toInboundLead', () => {
  test('writes the receipt under the site it was given, not a hardcoded one', () => {
    expect(mapped({}, 'teraso.in.ua').source).toBe('teraso.in.ua')
    expect(mapped({}, 'teraso.com.ua').source).toBe('teraso.com.ua')
  })

  /**
   * The idempotency key. Both sites' ids pass through untouched, so re-running an
   * import matches the receipt the first run wrote instead of opening a new deal.
   */
  test('carries the site’s own lead id through as the external id', () => {
    expect(mapped().externalId).toBe('569a4ba2caf6c4e3')
    expect(mapped({ lead_id: 'lead_20260715110059_ab12' }).externalId).toBe(
      'lead_20260715110059_ab12',
    )
  })

  /**
   * Both hosts record `time` on the Kyiv wall clock with no offset in the string,
   * which is verifiable rather than assumed: on teraso.in.ua every row whose
   * `time` reads 00:00–02:59 sits in the backup file of the PREVIOUS UTC day,
   * because the file name is `gmdate()` while the field is `date()`. Reading it as
   * UTC would file each lead three hours early.
   */
  test('reads the recorded time as Kyiv wall clock', () => {
    expect(mapped({ time: '2026-08-16 11:06:20' }).receivedAt).toBe('2026-08-16T08:06:20.000Z')
    // The 01:21 lead that lands in the previous day's file.
    expect(mapped({ time: '2026-07-20 01:21:51' }).receivedAt).toBe('2026-07-19T22:21:51.000Z')
  })

  /**
   * teraso.com.ua stamps its id with `gmdate('YmdHis')`, so that id is UTC by
   * definition and outranks the row's wall-clock field.
   */
  test('prefers the UTC stamp inside a teraso.com.ua id over the wall clock', () => {
    expect(
      mapped({ lead_id: 'lead_20260715110059_ab12', time: '2026-07-15 14:00:59' }).receivedAt,
    ).toBe('2026-07-15T11:00:59.000Z')
  })

  describe('advertising attribution', () => {
    const utm = {
      utm_source: 'facebook',
      utm_medium: 'cpc',
      utm_campaign: '[IN.UA] Lead / LAL / CBO20 / 2026-07',
      utm_content: 'LAL 1%',
      utm_term: 'IMG / Problem farba',
      gclid: '',
      fbclid: 'PAcGRvZgJmZGlk',
    }

    /**
     * The whole point of importing these rows: without the campaign the owner
     * cannot tell which ad paid for which customer.
     */
    test('reads the nested utm block teraso.in.ua writes', () => {
      expect(mapped({ utm }).attribution).toMatchObject({
        utmSource: 'facebook',
        utmMedium: 'cpc',
        utmCampaign: '[IN.UA] Lead / LAL / CBO20 / 2026-07',
        utmContent: 'LAL 1%',
        utmTerm: 'IMG / Problem farba',
      })
    })

    test('still reads the flat columns teraso.com.ua writes', () => {
      expect(mapped({ utm_source: 'google', utm_campaign: 'brand', gclid: 'Cj0KC' }).attribution)
        .toMatchObject({ utmSource: 'google', utmCampaign: 'brand', gclid: 'Cj0KC' })
    })

    test('prefers a flat column when a row somehow carries both', () => {
      expect(mapped({ utm, utm_source: 'google' }).attribution?.utmSource).toBe('google')
    })

    test('leaves attribution off entirely when the row carries none', () => {
      expect(mapped().attribution).toBeUndefined()
    })

    /** An empty nested value is not attribution, and must not fabricate a block. */
    test('ignores blank nested values', () => {
      expect(mapped({ utm: { utm_source: '', gclid: '' } }).attribution).toBeUndefined()
    })
  })

  describe('landing url', () => {
    test('uses the page url teraso.in.ua records', () => {
      expect(mapped({ page_url: 'https://meta.teraso.in.ua/?utm_source=facebook' }).landingUrl).toBe(
        'https://meta.teraso.in.ua/?utm_source=facebook',
      )
    })

    test('falls back to the recorded landing url', () => {
      expect(mapped({ landing_url: 'https://teraso.in.ua/pool' }).landingUrl).toBe(
        'https://teraso.in.ua/pool',
      )
    })

    /** A row with no URL at all still has to satisfy the contract's `url()`. */
    test('falls back to the site the import was pointed at', () => {
      expect(mapped({}, 'teraso.in.ua').landingUrl).toBe('https://teraso.in.ua/')
      expect(mapped({}, 'teraso.com.ua').landingUrl).toBe('https://teraso.com.ua/')
    })
  })

  describe('rows that are not customers', () => {
    test('skips somebody’s own test', () => {
      const result = toInboundLead(row({ name: 'Тест Codex, не обрабатывать' }), 'teraso.in.ua')
      expect(result).toMatchObject({ ok: false, reason: 'test-lead' })
    })

    test('skips filler and non-Ukrainian numbers', () => {
      expect(toInboundLead(row({ phone: '+380000000000' }), 'teraso.in.ua')).toMatchObject({
        ok: false,
        reason: 'placeholder-phone',
      })
      expect(toInboundLead(row({ phone: '0055434655864' }), 'teraso.in.ua')).toMatchObject({
        ok: false,
        reason: 'placeholder-phone',
      })
    })

    test('skips a messenger tap, which carries no contact', () => {
      expect(toInboundLead(row({ source: 'contact_click' }), 'teraso.in.ua')).toMatchObject({
        ok: false,
        reason: 'contact-click',
      })
    })
  })

  test('labels the form the way the site labels it', () => {
    expect(mapped({ source: 'consult' }).form).toBe('Консультація')
    expect(mapped({ source: 'pool' }).form).toBe('Басейн')
    expect(mapped({ source: 'site_feedback' }).form).toBe('Сайт (форма)')
  })
})

describe('parseImportArgs', () => {
  test('defaults to the site the CRM was first wired to', () => {
    expect(parseImportArgs(['leads-2026-08.jsonl'])).toEqual({
      dryRun: false,
      paths: ['leads-2026-08.jsonl'],
      source: 'teraso.com.ua',
    })
  })

  test('takes the second site by name', () => {
    expect(parseImportArgs(['--source=teraso.in.ua', 'a.jsonl', 'b.jsonl'])).toEqual({
      dryRun: false,
      paths: ['a.jsonl', 'b.jsonl'],
      source: 'teraso.in.ua',
    })
  })

  test('reads a dry run', () => {
    expect(parseImportArgs(['--dry-run', 'a.jsonl']).dryRun).toBe(true)
  })

  /**
   * The source is the receipt key. A typo in it would silently re-import the whole
   * history under a second identity and open a duplicate deal for every lead, so
   * an unrecognised flag must stop the run rather than be ignored.
   */
  test('refuses an unknown option instead of importing under the default source', () => {
    expect(() => parseImportArgs(['--soruce=teraso.in.ua', 'a.jsonl'])).toThrow(ImportArgsError)
  })

  test('refuses a source that is not a hostname', () => {
    expect(() => parseImportArgs(['--source=https://teraso.in.ua/', 'a.jsonl'])).toThrow(
      ImportArgsError,
    )
    expect(() => parseImportArgs(['--source=', 'a.jsonl'])).toThrow(ImportArgsError)
  })

  test('refuses a run with no file to read', () => {
    expect(() => parseImportArgs(['--dry-run'])).toThrow(ImportArgsError)
  })
})
