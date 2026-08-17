import {
  DEAL_DETAIL_TASK_LIMIT,
  type AssignableUserDto,
  type DealDetailDto,
  type DealStageChangeInput,
  type DealTaskDto,
  type DealUpdateInput,
  type TaskCreateInput,
  type TaskUpdateInput,
} from '@teraso-crm/contracts'
import { useState, type ReactNode } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Typography } from '@/components/typography'
import {
  DEAL_FIELD_LABELS,
  LOSS_REASON_LABELS,
  MATERIAL_LABELS,
  PREFERRED_CHANNEL_LABELS,
  TASK_KIND_LABELS,
  TASK_STATUS_LABELS,
  formatDateTime,
  formatMoney,
  formatPhone,
  personLabel,
  safeExternalHref,
} from '../model'
import { ActivityTimeline } from './ActivityTimeline'
import { ContactActions } from './ContactActions'
import { CriticalBadge } from './CriticalBadge'
import { LeadClassBadge, NextStepBadge, StageBadge } from './DealBadges'
import { DealDeleteDialog } from './DealDeleteDialog'
import { DealEditDialog } from './DealEditDialog'
import { DealStageDialog } from './DealStageDialog'
import { TaskActions } from './TaskActions'
import { TaskDialog } from './TaskDialog'
import { TaskRescheduleDialog } from './TaskRescheduleDialog'

/**
 * The deal card (PRD 7.1).
 *
 * The blocks follow the PRD table: основное, потребность, финансы, связь,
 * заметки и лента, маркетинг. Marketing is the exception — external identifiers
 * are attribution data, not working fields, so they live behind a drawer and
 * never appear in the operational header.
 *
 * On a phone the two columns stack, so the client, the contact buttons and the
 * note stay above the fold and reachable one-handed (PRD 10).
 *
 * The «Задачи» tab is where a task is actually worked (PRD 6.2): an active task
 * offers «Выполнена», «Перенести» and «Отменить» through `TaskActions`, and a
 * terminal one offers nothing, because the server refuses to edit it.
 */
export function DealDetail({
  assignableUsers,
  currentUserId,
  deal,
  error = null,
  isSaving,
  onAddNote,
  onChangeStage,
  onCreateTask,
  onDeleteDeal,
  onSaveNote,
  onUpdateDeal,
  onUpdateTask,
}: {
  /** The «Ответственный» picker's options, handed to the edit dialog unchanged. */
  assignableUsers?: ReadonlyArray<AssignableUserDto>
  currentUserId?: string
  deal: DealDetailDto
  error?: Error | null
  isSaving: boolean
  onAddNote: (text: string) => Promise<unknown>
  onChangeStage: (input: DealStageChangeInput) => void
  /** Absent leaves the card read-only for tasks, which is how tests render it. */
  onCreateTask?: (input: TaskCreateInput) => void
  /** Absent hides «Удалить» entirely: no handler, no irreversible button. */
  onDeleteDeal?: () => void
  onSaveNote: (note: string | null) => void
  onUpdateDeal: (input: DealUpdateInput) => void
  /** Absent leaves every task read-only, matching `onCreateTask`. */
  onUpdateTask?: (taskId: string, input: TaskUpdateInput) => void
}) {
  const landingHref = safeExternalHref(deal.landingUrl)
  const [isSchedulingTask, setIsSchedulingTask] = useState(false)
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false)
  const [reschedulingTask, setReschedulingTask] = useState<DealTaskDto | null>(null)

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <StageBadge stage={deal.stage} />
                <LeadClassBadge leadClass={deal.leadClass} />
                <CriticalBadge
                  hasOverdueTask={deal.hasOverdueTask}
                  isCritical={deal.isCritical}
                  noNextStep={deal.noNextStep}
                />
              </div>
              <Typography as="h2" variant="h4">
                {deal.client.name}
              </Typography>
              <Typography variant="body" tone="muted" wrap="nowrap">
                {formatPhone(deal.client.phoneNormalized)}
              </Typography>
              <div className="grid gap-0.5">
                <Typography variant="caption" tone="muted">
                  Следующий шаг
                </Typography>
                <NextStepBadge isOverdue={deal.hasOverdueTask} task={deal.nearestActiveTask} />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid gap-5">
              <ContactActions phoneNormalized={deal.client.phoneNormalized} />

              {error && (
                <Alert variant="destructive">
                  <AlertTitle>Изменение не сохранено</AlertTitle>
                  <AlertDescription>{error.message}</AlertDescription>
                </Alert>
              )}

              {/* Keyed on `updatedAt` so a saved change resets the drafts these
                  dialogs hold; otherwise reopening one would diff a stale draft
                  against the deal it just changed. */}
              <div className="flex flex-wrap gap-2">
                <DealStageDialog
                  deal={deal}
                  isSaving={isSaving}
                  key={`stage-${deal.updatedAt}`}
                  onChangeStage={onChangeStage}
                />
                <DealEditDialog
                  assignableUsers={assignableUsers}
                  deal={deal}
                  isSaving={isSaving}
                  key={`edit-${deal.updatedAt}`}
                  onSubmit={onUpdateDeal}
                />
                {onCreateTask && (
                  <Button onClick={() => setIsSchedulingTask(true)} size="sm" type="button" variant="outline">
                    <Typography variant="control">Новая задача</Typography>
                  </Button>
                )}
                <AttributionDrawer deal={deal} />
                {/*
                  Last in the row and behind its own confirmation: it is the only
                  irreversible action on this card. Absent when the page passes no
                  handler, matching how tasks stay read-only in a bare render.
                */}
                {onDeleteDeal && (
                  <Button
                    onClick={() => setIsConfirmingDelete(true)}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    <Typography variant="control">Удалить</Typography>
                  </Button>
                )}
              </div>

              {onDeleteDeal && isConfirmingDelete && (
                <DealDeleteDialog
                  deal={deal}
                  isDeleting={isSaving}
                  onCancel={() => setIsConfirmingDelete(false)}
                  onConfirm={onDeleteDeal}
                />
              )}

              {onCreateTask && (
                <TaskDialog
                  currentUserId={currentUserId}
                  isPending={isSaving}
                  key={`task-${deal.updatedAt}`}
                  onOpenChange={setIsSchedulingTask}
                  onSubmit={(input) => {
                    setIsSchedulingTask(false)
                    onCreateTask(input)
                  }}
                  open={isSchedulingTask}
                />
              )}

              {deal.stage === 'LOST' && deal.lossReason && (
                <Alert>
                  <AlertTitle>Сделка потеряна</AlertTitle>
                  <AlertDescription>
                    {LOSS_REASON_LABELS[deal.lossReason]}
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Typography as="h2" variant="h6">
              Основное
            </Typography>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldRow label={DEAL_FIELD_LABELS.source} value={deal.source} />
              <FieldRow label={DEAL_FIELD_LABELS.form} value={deal.form} />
              <FieldRow
                label={DEAL_FIELD_LABELS.submittedAt}
                value={formatDateTime(deal.submittedAt)}
              />
              <FieldRow
                label={DEAL_FIELD_LABELS.responsible}
                value={personLabel(deal.responsibleName)}
              />
              <FieldRow label={DEAL_FIELD_LABELS.landingUrl}>
                {landingHref ? (
                  <Typography asChild variant="bodySm">
                    <a href={landingHref} rel="noreferrer noopener" target="_blank">
                      {landingHref}
                    </a>
                  </Typography>
                ) : (
                  <Typography variant="bodySm" tone="muted" wrap="break">
                    {deal.landingUrl ?? '—'}
                  </Typography>
                )}
              </FieldRow>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Typography as="h2" variant="h6">
              Потребность
            </Typography>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldRow
                label={DEAL_FIELD_LABELS.material}
                value={deal.material ? MATERIAL_LABELS[deal.material] : null}
              />
              <FieldRow label={DEAL_FIELD_LABELS.areaLabel} value={deal.areaLabel} />
              <FieldRow label={DEAL_FIELD_LABELS.budgetLabel} value={deal.budgetLabel} />
              <FieldRow label={DEAL_FIELD_LABELS.objectType} value={deal.objectType} />
              <FieldRow label={DEAL_FIELD_LABELS.needTiming} value={deal.needTiming} />
              <FieldRow
                label={DEAL_FIELD_LABELS.preferredChannel}
                value={
                  deal.preferredChannel
                    ? PREFERRED_CHANNEL_LABELS[deal.preferredChannel]
                    : null
                }
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Typography as="h2" variant="h6">
              Финансы
            </Typography>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldRow
                label={DEAL_FIELD_LABELS.potentialAmount}
                value={formatMoney(deal.potentialAmount)}
              />
              <FieldRow
                label={DEAL_FIELD_LABELS.prepayment}
                value={
                  deal.prepaymentAmount
                    ? `${formatMoney(deal.prepaymentAmount)} · ${formatDateTime(deal.prepaymentPaidAt)}`
                    : null
                }
              />
              <FieldRow
                label={DEAL_FIELD_LABELS.fullPayment}
                value={
                  deal.fullPaymentAmount
                    ? `${formatMoney(deal.fullPaymentAmount)} · ${formatDateTime(deal.fullPaymentPaidAt)}`
                    : null
                }
              />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6">
        {/* Deliberately not keyed on `updatedAt`: a refetch — including the
            push-driven invalidation Task 8 adds — must not wipe a note the
            owner is halfway through typing. */}
        <CurrentNoteCard
          isSaving={isSaving}
          note={deal.currentNote}
          onSaveNote={onSaveNote}
        />

        <Card>
          <CardHeader>
            <Typography as="h2" variant="h6">
              Заметки и лента
            </Typography>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="history">
              <TabsList>
                <TabsTrigger value="history">
                  <Typography variant="control">История</Typography>
                </TabsTrigger>
                <TabsTrigger value="tasks">
                  <Typography variant="control">Задачи</Typography>
                </TabsTrigger>
              </TabsList>
              <TabsContent value="history">
                <div className="grid gap-5 pt-4">
                  <NoteComposer isSaving={isSaving} onAddNote={onAddNote} />
                  <ActivityTimeline
                    activities={deal.activities}
                    hasMore={deal.hasMoreActivities}
                  />
                </div>
              </TabsContent>
              <TabsContent value="tasks">
                <div className="grid gap-3 pt-4">
                  {deal.hasMoreTasks && (
                    <Typography variant="caption" tone="muted">
                      {`Показаны последние ${DEAL_DETAIL_TASK_LIMIT} задач, список длиннее`}
                    </Typography>
                  )}
                  {deal.tasks.length === 0 ? (
                    <Typography variant="bodySm" tone="muted">
                      Задач пока нет.
                    </Typography>
                  ) : (
                    deal.tasks.map((task) => (
                      <div className="grid gap-1 border-l-2 pl-3" key={task.id}>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">
                            <Typography variant="controlXs">
                              {TASK_KIND_LABELS[task.kind]}
                            </Typography>
                          </Badge>
                          <Badge variant="secondary">
                            <Typography variant="controlXs">
                              {TASK_STATUS_LABELS[task.status]}
                            </Typography>
                          </Badge>
                          <Typography variant="caption" tone="muted" wrap="nowrap">
                            {formatDateTime(task.dueAt)}
                          </Typography>
                        </div>
                        <Typography variant="bodySm">{task.title}</Typography>
                        {onUpdateTask && (
                          <TaskActions
                            isSaving={isSaving}
                            onCancel={() => onUpdateTask(task.id, { status: 'CANCELLED' })}
                            onComplete={() => onUpdateTask(task.id, { status: 'COMPLETED' })}
                            onReschedule={() => setReschedulingTask(task)}
                            task={task}
                          />
                        )}
                      </div>
                    ))
                  )}
                </div>

                {onUpdateTask && reschedulingTask && (
                  <TaskRescheduleDialog
                    isPending={isSaving}
                    key={reschedulingTask.id}
                    onOpenChange={(open) => {
                      if (!open) setReschedulingTask(null)
                    }}
                    onSubmit={(input) => {
                      onUpdateTask(reschedulingTask.id, input)
                      setReschedulingTask(null)
                    }}
                    open
                    task={reschedulingTask}
                  />
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function FieldRow({
  children,
  label,
  value,
}: {
  children?: ReactNode
  label: string
  value?: string | null
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <Typography variant="caption" tone="muted">
        {label}
      </Typography>
      {children ?? (
        <Typography variant="bodySm" tone={value ? 'default' : 'muted'}>
          {value || '—'}
        </Typography>
      )}
    </div>
  )
}

/**
 * The single short note pinned to the header, distinct from the timeline: it is
 * overwritten in place, so clearing it sends an explicit `null` rather than an
 * empty string the contract would reject.
 */
function CurrentNoteCard({
  isSaving,
  note,
  onSaveNote,
}: {
  isSaving: boolean
  note: string | null
  onSaveNote: (note: string | null) => void
}) {
  const [draft, setDraft] = useState(note ?? '')
  const trimmed = draft.trim()
  const isUnchanged = trimmed === (note ?? '')

  return (
    <Card>
      <CardHeader>
        <Typography as="h2" variant="h6">
          {DEAL_FIELD_LABELS.currentNote}
        </Typography>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            onSaveNote(trimmed === '' ? null : trimmed)
          }}
        >
          <Textarea
            aria-label={DEAL_FIELD_LABELS.currentNote}
            maxLength={500}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Например: ждёт замер в четверг"
            rows={3}
            value={draft}
          />
          <div className="flex justify-end">
            <Button disabled={isSaving || isUnchanged} size="sm" type="submit">
              <Typography variant="control">Сохранить заметку</Typography>
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

/**
 * The composer clears only after the entry is actually recorded, and reports a
 * failure next to the box the text is still sitting in. Clearing optimistically
 * threw away whatever the owner had typed and announced the problem at the far
 * end of the card.
 */
function NoteComposer({
  isSaving,
  onAddNote,
}: {
  isSaving: boolean
  onAddNote: (text: string) => Promise<unknown>
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = text.trim()
    if (!trimmed) return
    setError(null)
    try {
      await onAddNote(trimmed)
      setText('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось добавить запись')
    }
  }

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <Textarea
        aria-label="Новая запись в ленте"
        aria-invalid={error ? true : undefined}
        maxLength={4000}
        onChange={(event) => setText(event.target.value)}
        placeholder="Что произошло по сделке"
        rows={2}
        value={text}
      />
      {error && (
        <Typography role="alert" variant="caption" tone="destructive">
          {error}
        </Typography>
      )}
      <div className="flex justify-end">
        <Button disabled={isSaving || text.trim() === ''} size="sm" type="submit" variant="outline">
          <Typography variant="control">Добавить в ленту</Typography>
        </Button>
      </div>
    </form>
  )
}

/**
 * Attribution lives behind a drawer on purpose (PRD 7.1): external identifiers
 * support marketing analysis and must not compete with the working fields, so
 * no raw UTM value, click identifier or Meta event id appears in the default
 * operational header.
 */
function AttributionDrawer({ deal }: { deal: DealDetailDto }) {
  const attribution = deal.attribution

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button size="sm" type="button" variant="ghost">
          <Typography variant="control">Маркетинг и атрибуция</Typography>
        </Button>
      </SheetTrigger>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Маркетинг и атрибуция</SheetTitle>
          <SheetDescription>
            Данные для анализа рекламы. Они не заменяют рабочие поля сделки.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 px-4 pb-6">
          {attribution === null ? (
            <Typography variant="bodySm" tone="muted">
              Заявка создана вручную, данных атрибуции нет.
            </Typography>
          ) : (
            <>
              <FieldRow label="Внешний ID заявки" value={attribution.externalId} />
              <FieldRow label="Форма" value={deal.form} />
              <FieldRow label="UTM Source" value={attribution.utmSource} />
              <FieldRow label="UTM Medium" value={attribution.utmMedium} />
              <FieldRow label="UTM Campaign" value={attribution.utmCampaign} />
              <FieldRow label="UTM Content" value={attribution.utmContent} />
              <FieldRow label="UTM Term" value={attribution.utmTerm} />
              <FieldRow label="gclid" value={attribution.gclid} />
              <FieldRow label="gbraid" value={attribution.gbraid} />
              <FieldRow label="Meta event ID" value={attribution.metaEventId} />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
