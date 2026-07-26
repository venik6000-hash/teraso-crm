import { Link } from '@tanstack/react-router'
import {
  dealCreateSchema,
  leadClassSchema,
  materialSchema,
  preferredChannelSchema,
  taskKindSchema,
  type ClientLookupResponse,
  type DealCreateInput,
} from '@teraso-crm/contracts'
import { useState, type ReactNode } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Typography } from '@/components/typography'
import {
  DEAL_DETAIL_ROUTE_PATH,
  DEAL_FIELD_LABELS,
  LEAD_CLASS_LABELS,
  MATERIAL_LABELS,
  PREFERRED_CHANNEL_LABELS,
  TASK_KIND_LABELS,
  dealFormFieldErrors,
  formatPhone,
  phoneFieldError,
  toInstantFromKyivInput,
} from '../model'

/**
 * Manual deal creation (PRD 7.1).
 *
 * The phone is checked as it is typed, and the lookup result is a warning, not
 * a block: a returning customer legitimately starts a second deal, so the form
 * points at the client's existing card and lets the owner continue. Submission
 * carries the phone, and the server attaches the deal to the client that
 * already owns that number — the form never picks a client id itself.
 *
 * An initial task is optional here even though an open deal is expected to have
 * a next step: the 30-minute grace window (PRD 7.4) exists precisely so the
 * owner can record a lead first and plan the follow-up second.
 */

const NOT_SET = '__not_set__'

export function DealForm({
  existingClient,
  isPending,
  onCancel,
  onPhoneChange,
  onSubmit,
  submitError,
}: {
  existingClient: ClientLookupResponse | undefined
  isPending: boolean
  onCancel: () => void
  onPhoneChange?: (phone: string) => void
  onSubmit: (input: DealCreateInput) => void
  submitError: Error | null
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [phoneTouched, setPhoneTouched] = useState(false)
  const [source, setSource] = useState('')
  const [form, setForm] = useState('')
  const [landingUrl, setLandingUrl] = useState('')
  const [submittedAt, setSubmittedAt] = useState('')
  const [leadClass, setLeadClass] = useState(NOT_SET)
  const [material, setMaterial] = useState(NOT_SET)
  const [areaLabel, setAreaLabel] = useState('')
  const [budgetLabel, setBudgetLabel] = useState('')
  const [objectType, setObjectType] = useState('')
  const [needTiming, setNeedTiming] = useState('')
  const [preferredChannel, setPreferredChannel] = useState(NOT_SET)
  const [potentialAmount, setPotentialAmount] = useState('')
  const [currentNote, setCurrentNote] = useState('')
  const [withTask, setWithTask] = useState(false)
  const [taskKind, setTaskKind] = useState<string>('CALL')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDueAt, setTaskDueAt] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const livePhoneError = phoneTouched ? phoneFieldError(phone) : null
  const duplicate = existingClient?.client ?? null

  const submit = () => {
    const payload: Record<string, unknown> = {
      name: name.trim(),
      phone: phone.trim(),
      source: source.trim(),
    }
    if (form.trim()) payload.form = form.trim()
    if (landingUrl.trim()) payload.landingUrl = landingUrl.trim()
    if (submittedAt) payload.submittedAt = toInstantFromKyivInput(submittedAt)
    if (leadClass !== NOT_SET) payload.leadClass = leadClass
    if (material !== NOT_SET) payload.material = material
    if (areaLabel.trim()) payload.areaLabel = areaLabel.trim()
    if (budgetLabel.trim()) payload.budgetLabel = budgetLabel.trim()
    if (objectType.trim()) payload.objectType = objectType.trim()
    if (needTiming.trim()) payload.needTiming = needTiming.trim()
    if (preferredChannel !== NOT_SET) payload.preferredChannel = preferredChannel
    if (potentialAmount.trim()) payload.potentialAmount = potentialAmount.trim()
    if (currentNote.trim()) payload.currentNote = currentNote.trim()
    if (withTask) {
      payload.initialTask = {
        kind: taskKind,
        title: taskTitle.trim(),
        dueAt: toInstantFromKyivInput(taskDueAt),
      }
    }

    const parsed = dealCreateSchema.safeParse(payload)
    if (!parsed.success) {
      setErrors(dealFormFieldErrors(parsed.error.issues))
      return
    }

    setErrors({})
    onSubmit(parsed.data)
  }

  return (
    <form
      className="grid gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {submitError && (
        <Alert variant="destructive">
          <AlertTitle>Сделка не создана</AlertTitle>
          <AlertDescription>{submitError.message}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <Typography as="h2" variant="h6">
            Клиент
          </Typography>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              error={errors.name}
              id="new-deal-name"
              label={DEAL_FIELD_LABELS.name}
              onChange={setName}
              value={name}
            />
            <TextField
              error={livePhoneError ?? errors.phone}
              id="new-deal-phone"
              inputMode="tel"
              label={DEAL_FIELD_LABELS.phone}
              onBlur={() => {
                setPhoneTouched(true)
                // The duplicate lookup runs once the number is finished rather
                // than on every keystroke: format feedback is already live, and
                // a request per character would ask the server thirteen times
                // for one phone.
                onPhoneChange?.(phone)
              }}
              onChange={(value) => {
                setPhone(value)
                setPhoneTouched(true)
              }}
              placeholder="+380671234567"
              value={phone}
            />
          </div>

          {duplicate && (
            <div className="pt-4">
              <Alert>
                <AlertTitle>Клиент с этим номером уже есть</AlertTitle>
                <AlertDescription>
                  <div className="grid gap-1">
                    <Typography variant="bodySm">
                      {`${duplicate.name} · ${formatPhone(duplicate.phoneNormalized)}`}
                    </Typography>
                    {existingClient?.openDeal ? (
                      <Typography asChild variant="bodySm">
                        <Link
                          params={{ dealId: existingClient.openDeal.id }}
                          to={DEAL_DETAIL_ROUTE_PATH}
                        >
                          Открыть текущую сделку клиента
                        </Link>
                      </Typography>
                    ) : (
                      <Typography asChild variant="bodySm">
                        <Link
                          search={{ q: duplicate.phoneNormalized }}
                          to="/app/deals"
                        >
                          Показать сделки клиента
                        </Link>
                      </Typography>
                    )}
                    <Typography variant="caption" tone="muted">
                      Новая сделка присоединится к этому клиенту, обе истории сохранятся.
                    </Typography>
                  </div>
                </AlertDescription>
              </Alert>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Typography as="h2" variant="h6">
            Заявка
          </Typography>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              error={errors.source}
              id="new-deal-source"
              label={DEAL_FIELD_LABELS.source}
              onChange={setSource}
              placeholder="Звонок, Instagram, рекомендация"
              value={source}
            />
            <TextField
              error={errors.form}
              id="new-deal-form"
              label={DEAL_FIELD_LABELS.form}
              onChange={setForm}
              value={form}
            />
            <TextField
              error={errors.landingUrl}
              id="new-deal-landing-url"
              label={DEAL_FIELD_LABELS.landingUrl}
              onChange={setLandingUrl}
              placeholder="https://teraso.com.ua/..."
              value={landingUrl}
            />
            <FieldShell
              error={errors.submittedAt}
              id="new-deal-submitted-at"
              label={DEAL_FIELD_LABELS.submittedAt}
            >
              <Input
                id="new-deal-submitted-at"
                onChange={(event) => setSubmittedAt(event.target.value)}
                type="datetime-local"
                value={submittedAt}
              />
            </FieldShell>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Typography as="h2" variant="h6">
            Потребность и деньги
          </Typography>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <EnumField
              id="new-deal-lead-class"
              label={DEAL_FIELD_LABELS.leadClass}
              labels={LEAD_CLASS_LABELS}
              onChange={setLeadClass}
              options={leadClassSchema.options}
              value={leadClass}
            />
            <EnumField
              id="new-deal-material"
              label={DEAL_FIELD_LABELS.material}
              labels={MATERIAL_LABELS}
              onChange={setMaterial}
              options={materialSchema.options}
              value={material}
            />
            <TextField
              error={errors.areaLabel}
              id="new-deal-area"
              label={DEAL_FIELD_LABELS.areaLabel}
              onChange={setAreaLabel}
              value={areaLabel}
            />
            <TextField
              error={errors.budgetLabel}
              id="new-deal-budget"
              label={DEAL_FIELD_LABELS.budgetLabel}
              onChange={setBudgetLabel}
              value={budgetLabel}
            />
            <TextField
              error={errors.objectType}
              id="new-deal-object-type"
              label={DEAL_FIELD_LABELS.objectType}
              onChange={setObjectType}
              value={objectType}
            />
            <TextField
              error={errors.needTiming}
              id="new-deal-need-timing"
              label={DEAL_FIELD_LABELS.needTiming}
              onChange={setNeedTiming}
              value={needTiming}
            />
            <EnumField
              id="new-deal-channel"
              label={DEAL_FIELD_LABELS.preferredChannel}
              labels={PREFERRED_CHANNEL_LABELS}
              onChange={setPreferredChannel}
              options={preferredChannelSchema.options}
              value={preferredChannel}
            />
            <TextField
              error={errors.potentialAmount}
              id="new-deal-potential-amount"
              inputMode="decimal"
              label={DEAL_FIELD_LABELS.potentialAmount}
              onChange={setPotentialAmount}
              placeholder="65000.00"
              value={potentialAmount}
            />
          </div>
          <div className="pt-4">
            <FieldShell
              error={errors.currentNote}
              id="new-deal-note"
              label={DEAL_FIELD_LABELS.currentNote}
            >
              <Textarea
                id="new-deal-note"
                maxLength={500}
                onChange={(event) => setCurrentNote(event.target.value)}
                rows={2}
                value={currentNote}
              />
            </FieldShell>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <Typography as="h2" variant="h6">
            Первая задача
          </Typography>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4">
            <div className="flex items-center gap-2">
              <Checkbox
                checked={withTask}
                id="new-deal-with-task"
                onCheckedChange={(checked) => setWithTask(checked === true)}
              />
              <Label htmlFor="new-deal-with-task">Сразу назначить следующий шаг</Label>
            </div>
            {withTask && (
              <div className="grid gap-4 sm:grid-cols-3">
                <EnumField
                  id="new-deal-task-kind"
                  label="Тип задачи"
                  labels={TASK_KIND_LABELS}
                  onChange={setTaskKind}
                  options={taskKindSchema.options}
                  value={taskKind}
                  withNotSet={false}
                />
                <TextField
                  error={errors['initialTask.title'] ?? errors.initialTask}
                  id="new-deal-task-title"
                  label="Что сделать"
                  onChange={setTaskTitle}
                  value={taskTitle}
                />
                <FieldShell
                  error={errors['initialTask.dueAt']}
                  id="new-deal-task-due"
                  label="Срок"
                >
                  <Input
                    id="new-deal-task-due"
                    onChange={(event) => setTaskDueAt(event.target.value)}
                    type="datetime-local"
                    value={taskDueAt}
                  />
                </FieldShell>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button onClick={onCancel} type="button" variant="outline">
          <Typography variant="control">Отмена</Typography>
        </Button>
        <Button disabled={isPending} type="submit">
          <Typography variant="control">Создать сделку</Typography>
        </Button>
      </div>
    </form>
  )
}

function TextField({
  error,
  id,
  inputMode,
  label,
  onBlur,
  onChange,
  placeholder,
  value,
}: {
  error?: string | null
  id: string
  inputMode?: 'decimal' | 'tel'
  label: string
  onBlur?: () => void
  onChange: (value: string) => void
  placeholder?: string
  value: string
}) {
  return (
    <FieldShell error={error} id={id} label={label}>
      <Input
        aria-invalid={error ? true : undefined}
        id={id}
        inputMode={inputMode}
        onBlur={onBlur}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </FieldShell>
  )
}

function EnumField<TOption extends string>({
  id,
  label,
  labels,
  onChange,
  options,
  value,
  withNotSet = true,
}: {
  id: string
  label: string
  labels: Record<TOption, string>
  onChange: (value: string) => void
  options: ReadonlyArray<TOption>
  value: string
  withNotSet?: boolean
}) {
  return (
    <FieldShell id={id} label={label}>
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {withNotSet && <SelectItem value={NOT_SET}>Не задано</SelectItem>}
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {labels[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  )
}

function FieldShell({
  children,
  error,
  id,
  label,
}: {
  children: ReactNode
  error?: string | null
  id: string
  label: string
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <Typography role="alert" variant="caption" tone="destructive">
          {error}
        </Typography>
      )}
    </div>
  )
}
