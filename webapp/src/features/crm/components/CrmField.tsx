import { useId, type ReactNode } from 'react'

import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

/**
 * The CRM's form fields, built on the shared `ui/field` primitives.
 *
 * There is exactly one of these for the three CRM forms, rather than a private
 * field shell inside each, for two reasons the auth feature already learned:
 *
 * - the error element is linked to its input through `aria-describedby`, so a
 *   screen reader announces the message when focus returns to a field after a
 *   failed submit. A loose `role="alert"` next to the input does not.
 * - ids come from `useId()` instead of being hard-coded. Hard-coded ids are
 *   safe only while one dialog is mounted at a time, which stops being true the
 *   moment Task 8 renders a stage dialog per board card.
 */

type BaseFieldProps = {
  description?: string
  error?: string | null
  label: string
}

export function CrmTextField({
  description,
  error,
  inputMode,
  label,
  list,
  onBlur,
  onChange,
  placeholder,
  type,
  value,
}: BaseFieldProps & {
  inputMode?: 'decimal' | 'tel'
  list?: string
  onBlur?: () => void
  onChange: (value: string) => void
  placeholder?: string
  type?: 'date' | 'datetime-local'
  value: string
}) {
  return (
    <CrmField description={description} error={error} label={label}>
      {({ describedBy, id, invalid }) => (
        <Input
          aria-describedby={describedBy}
          aria-invalid={invalid}
          id={id}
          inputMode={inputMode}
          list={list}
          onBlur={onBlur}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          type={type}
          value={value}
        />
      )}
    </CrmField>
  )
}

export function CrmTextareaField({
  description,
  error,
  label,
  maxLength,
  onChange,
  placeholder,
  rows,
  value,
}: BaseFieldProps & {
  maxLength?: number
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
  value: string
}) {
  return (
    <CrmField description={description} error={error} label={label}>
      {({ describedBy, id, invalid }) => (
        <Textarea
          aria-describedby={describedBy}
          aria-invalid={invalid}
          id={id}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          rows={rows}
          value={value}
        />
      )}
    </CrmField>
  )
}

export function CrmSelectField({
  description,
  error,
  label,
  onChange,
  options,
  placeholder,
  value,
}: BaseFieldProps & {
  onChange: (value: string) => void
  options: ReadonlyArray<{ label: string; value: string }>
  placeholder?: string
  value?: string
}) {
  return (
    <CrmField description={description} error={error} label={label}>
      {({ describedBy, id, invalid }) => (
        <Select onValueChange={onChange} value={value}>
          <SelectTrigger aria-describedby={describedBy} aria-invalid={invalid} id={id}>
            <SelectValue placeholder={placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </CrmField>
  )
}

function CrmField({
  children,
  description,
  error,
  label,
}: BaseFieldProps & {
  children: (control: {
    describedBy: string | undefined
    id: string
    invalid: boolean | undefined
  }) => ReactNode
}) {
  const id = useId()
  const errorId = useId()
  const descriptionId = useId()
  const invalid = Boolean(error)
  const describedBy =
    [invalid ? errorId : null, description ? descriptionId : null]
      .filter(Boolean)
      .join(' ') || undefined

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children({ describedBy, id, invalid: invalid || undefined })}
      {description && <FieldDescription id={descriptionId}>{description}</FieldDescription>}
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </Field>
  )
}
