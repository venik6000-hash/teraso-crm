import { Link } from '@tanstack/react-router'
import {
  leadClassSchema,
  materialSchema,
  preferredChannelSchema,
  taskKindSchema,
  type AssignableUserDto,
  type ClientLookupResponse,
  type DealCreateInput,
  type TaskKind,
} from '@teraso-crm/contracts'
import { useId, useState } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Typography } from '@/components/typography'
import {
  DEAL_DETAIL_ROUTE_PATH,
  DEAL_FIELD_LABELS,
  LEAD_CLASS_LABELS,
  MATERIAL_LABELS,
  NOT_SET,
  PREFERRED_CHANNEL_LABELS,
  TASK_KIND_LABELS,
  assignableUserOptions,
  buildDealCreateInput,
  formatPhone,
} from '../model'
import { emptyFormErrors, phoneFieldError } from '../validation'
import { CrmSelectField, CrmTextField, CrmTextareaField } from './CrmField'

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
 *
 * «Ответственный» is pre-filled with the current user and then SENT — the server
 * never infers an owner from the caller's identity — and «Не назначен» stays a
 * deliberate choice for a lead nobody has picked up yet. The payload is assembled
 * by `buildDealCreateInput`, which lives in the model because this form renders
 * inside a Sheet and a portal is a poor place to keep the only copy of a rule.
 */

export function DealForm({
  assignableUsers = [],
  currentUserId,
  existingClient,
  isPending,
  onCancel,
  onPhoneChange,
  onSubmit,
  submitError,
}: {
  /** Empty while the roster loads, which the parent page has already requested. */
  assignableUsers?: ReadonlyArray<AssignableUserDto>
  currentUserId?: string
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
  const [responsibleUserId, setResponsibleUserId] = useState(currentUserId ?? NOT_SET)
  const [material, setMaterial] = useState(NOT_SET)
  const [areaLabel, setAreaLabel] = useState('')
  const [budgetLabel, setBudgetLabel] = useState('')
  const [objectType, setObjectType] = useState('')
  const [needTiming, setNeedTiming] = useState('')
  const [preferredChannel, setPreferredChannel] = useState(NOT_SET)
  const [potentialAmount, setPotentialAmount] = useState('')
  const [currentNote, setCurrentNote] = useState('')
  const [withTask, setWithTask] = useState(false)
  const [taskKind, setTaskKind] = useState<TaskKind>('CALL')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDueAt, setTaskDueAt] = useState('')
  const [errors, setErrors] = useState(emptyFormErrors)
  const withTaskId = useId()

  const livePhoneError = phoneTouched ? phoneFieldError(phone) : null
  const duplicate = existingClient?.client ?? null

  const submit = () => {
    const built = buildDealCreateInput({
      name,
      phone,
      source,
      form,
      landingUrl,
      submittedAt,
      leadClass,
      responsibleUserId,
      material,
      areaLabel,
      budgetLabel,
      objectType,
      needTiming,
      preferredChannel,
      potentialAmount,
      currentNote,
      withTask,
      taskKind,
      taskTitle,
      taskDueAt,
    })

    if (!built.ok) {
      setErrors(built.errors)
      return
    }

    setErrors(emptyFormErrors)
    onSubmit(built.value)
  }

  return (
    <form
      className="grid gap-6"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      {(submitError || errors.formMessage) && (
        <Alert variant="destructive">
          <AlertTitle>Сделка не создана</AlertTitle>
          <AlertDescription>
            {submitError?.message ?? errors.formMessage}
          </AlertDescription>
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
            <CrmTextField
              error={errors.fields.name}
              label={DEAL_FIELD_LABELS.name}
              onChange={setName}
              value={name}
            />
            <CrmTextField
              error={livePhoneError ?? errors.fields.phone}
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
            <CrmTextField
              error={errors.fields.source}
              label={DEAL_FIELD_LABELS.source}
              onChange={setSource}
              placeholder="Звонок, Instagram, рекомендация"
              value={source}
            />
            <CrmTextField
              error={errors.fields.form}
              label={DEAL_FIELD_LABELS.form}
              onChange={setForm}
              value={form}
            />
            <CrmTextField
              error={errors.fields.landingUrl}
              label={DEAL_FIELD_LABELS.landingUrl}
              onChange={setLandingUrl}
              placeholder="https://teraso.com.ua/..."
              value={landingUrl}
            />
            <CrmTextField
              description="Время по Киеву; пусто — сейчас"
              error={errors.fields.submittedAt}
              label={DEAL_FIELD_LABELS.submittedAt}
              onChange={setSubmittedAt}
              type="datetime-local"
              value={submittedAt}
            />
            <CrmSelectField
              description="По умолчанию — вы"
              error={errors.fields.responsibleUserId}
              label={DEAL_FIELD_LABELS.responsible}
              onChange={setResponsibleUserId}
              options={assignableUserOptions(assignableUsers)}
              value={responsibleUserId}
            />
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
            <CrmSelectField
              label={DEAL_FIELD_LABELS.leadClass}
              onChange={setLeadClass}
              options={enumOptions(leadClassSchema.options, LEAD_CLASS_LABELS)}
              value={leadClass}
            />
            <CrmSelectField
              label={DEAL_FIELD_LABELS.material}
              onChange={setMaterial}
              options={enumOptions(materialSchema.options, MATERIAL_LABELS)}
              value={material}
            />
            <CrmTextField
              error={errors.fields.areaLabel}
              label={DEAL_FIELD_LABELS.areaLabel}
              onChange={setAreaLabel}
              value={areaLabel}
            />
            <CrmTextField
              error={errors.fields.budgetLabel}
              label={DEAL_FIELD_LABELS.budgetLabel}
              onChange={setBudgetLabel}
              value={budgetLabel}
            />
            <CrmTextField
              error={errors.fields.objectType}
              label={DEAL_FIELD_LABELS.objectType}
              onChange={setObjectType}
              value={objectType}
            />
            <CrmTextField
              error={errors.fields.needTiming}
              label={DEAL_FIELD_LABELS.needTiming}
              onChange={setNeedTiming}
              value={needTiming}
            />
            <CrmSelectField
              label={DEAL_FIELD_LABELS.preferredChannel}
              onChange={setPreferredChannel}
              options={enumOptions(preferredChannelSchema.options, PREFERRED_CHANNEL_LABELS)}
              value={preferredChannel}
            />
            <CrmTextField
              error={errors.fields.potentialAmount}
              inputMode="decimal"
              label={DEAL_FIELD_LABELS.potentialAmount}
              onChange={setPotentialAmount}
              placeholder="65000.00"
              value={potentialAmount}
            />
          </div>
          <div className="pt-4">
            <CrmTextareaField
              error={errors.fields.currentNote}
              label={DEAL_FIELD_LABELS.currentNote}
              maxLength={500}
              onChange={setCurrentNote}
              rows={2}
              value={currentNote}
            />
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
                id={withTaskId}
                onCheckedChange={(checked) => setWithTask(checked === true)}
              />
              <Label htmlFor={withTaskId}>Сразу назначить следующий шаг</Label>
            </div>
            {withTask && (
              <div className="grid gap-4 sm:grid-cols-3">
                <CrmSelectField
                  label="Тип задачи"
                  onChange={(value) => setTaskKind(taskKindSchema.parse(value))}
                  options={taskKindSchema.options.map((option) => ({
                    label: TASK_KIND_LABELS[option],
                    value: option,
                  }))}
                  value={taskKind}
                />
                <CrmTextField
                  error={errors.fields['initialTask.title'] ?? errors.fields.initialTask}
                  label="Что сделать"
                  onChange={setTaskTitle}
                  value={taskTitle}
                />
                <CrmTextField
                  description="Время по Киеву"
                  error={errors.fields['initialTask.dueAt']}
                  label="Срок"
                  onChange={setTaskDueAt}
                  type="datetime-local"
                  value={taskDueAt}
                />
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

/** The «Не задано» entry every optional enum select needs; see `NOT_SET`. */
function enumOptions<TOption extends string>(
  options: ReadonlyArray<TOption>,
  labels: Record<TOption, string>,
) {
  return [
    { label: 'Не задано', value: NOT_SET },
    ...options.map((option) => ({ label: labels[option], value: option })),
  ]
}
