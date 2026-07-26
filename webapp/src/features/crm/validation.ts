import type { z } from 'zod'

/**
 * Russian validation feedback for the CRM forms.
 *
 * Zod's structural messages are English ("Invalid input: expected string,
 * received undefined"); only the business rules written into the contracts are
 * Russian. Every message the owner can see has to be Russian, so structural
 * issues are translated here, at the form boundary, while an authored contract
 * message passes through untouched.
 *
 * The two are told apart by looking for Cyrillic rather than by issue code: a
 * contract can attach its own text to any code, and installing a global Zod
 * error map would reach every other consumer of that package — including the
 * backend, which shares it.
 *
 * CRM-scoped on purpose. The account console is legitimately English, so this
 * does not belong in `src/platform` until a second Russian surface exists.
 */

export type FormErrors = {
  /** Keyed by both `initialTask.dueAt` and `initialTask`, first message wins. */
  fields: Record<string, string>
  /** Issues with no path — a form-level refine or an unrecognized key. */
  formMessage: string | null
}

export function toRussianMessage(issue: z.core.$ZodIssue): string {
  if (/[А-Яа-яЁё]/.test(issue.message)) return issue.message

  switch (issue.code) {
    case 'invalid_type':
      return 'Заполните поле'
    case 'too_small': {
      const minimum = Number(issue.minimum)
      if (issue.origin === 'string') {
        return minimum <= 1
          ? 'Заполните поле'
          : `Слишком короткое значение: не меньше ${minimum} символов`
      }
      return `Значение не может быть меньше ${minimum}`
    }
    case 'too_big': {
      const maximum = Number(issue.maximum)
      return issue.origin === 'string'
        ? `Слишком длинное значение: не больше ${maximum} символов`
        : `Значение не может быть больше ${maximum}`
    }
    case 'invalid_format':
      switch (issue.format) {
        case 'datetime':
          return 'Укажите дату и время'
        case 'date':
          return 'Укажите дату'
        case 'url':
          return 'Укажите ссылку вида https://example.com'
        case 'uuid':
          return 'Недопустимый идентификатор'
        default:
          return 'Недопустимый формат'
      }
    case 'invalid_value':
      return 'Выберите значение из списка'
    case 'unrecognized_keys':
      return 'Недопустимое поле'
    default:
      return 'Недопустимое значение'
  }
}

/**
 * Splits issues into per-field messages and a form-level one.
 *
 * The form-level message is a separate property rather than a `_form` entry in
 * the same record precisely so a form cannot forget it: a path-less issue used
 * to be generated, stored under a key nobody rendered, and surfaced to the
 * owner as a submit button that did nothing.
 *
 * Nested paths are published twice — as `initialTask.dueAt` and as
 * `initialTask` — so a form can point at the exact input when it renders the
 * subfields and still fall back to one message beside a grouped control.
 */
export function toFormErrors(issues: ReadonlyArray<z.core.$ZodIssue>): FormErrors {
  const fields: Record<string, string> = {}
  let formMessage: string | null = null

  for (const issue of issues) {
    const path = issue.path.filter((part): part is string => typeof part === 'string')
    const message = toRussianMessage(issue)

    if (path.length === 0) {
      formMessage ??= message
      continue
    }
    for (const key of [path.join('.'), path[0]!]) {
      if (fields[key]) continue
      fields[key] = message
    }
  }

  return { fields, formMessage }
}

/** No issues yet: the shape a form starts from and resets to. */
export const emptyFormErrors: FormErrors = { fields: {}, formMessage: null }

/**
 * Live phone feedback while the field is being typed. It mirrors the contract's
 * own length bounds instead of guessing at a national format: the server
 * normalizes the number, and a stricter client rule would reject numbers the
 * API accepts.
 */
export function phoneFieldError(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'Заполните поле'
  if (!/^\+?[\d\s()-]+$/.test(trimmed)) return 'Номер может содержать только цифры'
  if (trimmed.length < 7) return 'Слишком короткий номер'
  if (trimmed.length > 40) return 'Слишком длинный номер'
  return null
}
