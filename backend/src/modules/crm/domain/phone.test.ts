import { expect, test } from 'bun:test'

import { normalizeUaPhone, phoneSearchDigits } from './phone'

test('normalizes Ukrainian formatting', () => {
  expect(normalizeUaPhone('+38 (093) 533-53-53')).toBe('+380935335353')
})

test('rejects a number that cannot identify a client', () => {
  expect(() => normalizeUaPhone('123')).toThrow('Укажите корректный номер телефона')
})

/**
 * Every spelling below is the same person. Deduplication rests on all of them
 * collapsing to one string, so this is the deduplication test in miniature.
 */
test('collapses every accepted spelling of one number to a single identity', () => {
  for (const spelling of [
    '+380935335353',
    '380935335353',
    '0935335353',
    '+38 (093) 533-53-53',
    '  093 533 53 53  ',
    '+38-093-533-53-53',
  ]) {
    expect(normalizeUaPhone(spelling)).toBe('+380935335353')
  }
})

test('rejects numbers that would mint a second client for one person', () => {
  for (const invalid of [
    '935335353',
    '+380935335',
    '+3809353353531',
    '+1 202 555 0143',
    '80935335353',
    '',
    'не телефон',
  ]) {
    expect(() => normalizeUaPhone(invalid)).toThrow('Укажите корректный номер телефона')
  }
})

/**
 * Every term below must find the client stored as +380935335353, because the
 * owner searching the list types whatever fragment they remember.
 */
test('reduces a search term to digits that occur in the stored number', () => {
  for (const [term, expected] of [
    ['+380935335353', '935335353'],
    ['0935335353', '935335353'],
    ['093 533', '93533'],
    ['533-53-53', '5335353'],
    ['+38 (093)', '93'],
  ] as const) {
    expect(phoneSearchDigits(term)).toBe(expected)
    expect('+380935335353').toContain(expected)
  }
})

test('falls back to a name-only search when the term has no usable digits', () => {
  for (const term of ['Олександр', '', '  ', '3', '380']) {
    expect(phoneSearchDigits(term)).toBeNull()
  }
})
