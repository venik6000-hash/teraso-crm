import { taskKindSchema, type TaskCreateInput, type TaskKind } from '@teraso-crm/contracts'
import { useState } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Typography } from '@/components/typography'
import {
  TASK_KIND_LABELS,
  buildTaskInput,
  toKyivDateTimeInput,
} from '../model'
import { emptyFormErrors } from '../validation'
import { CrmSelectField, CrmTextField } from './CrmField'

/**
 * Schedules the next step (PRD 7.4).
 *
 * Type, exact time and text are all mandatory, and all three are enforced by
 * `taskCreateSchema` through `buildTaskInput` rather than by a second set of
 * checks here — so the dialog cannot accept something the API would refuse.
 *
 * The time field is `datetime-local`, which speaks the device's own zone, so the
 * value is converted against Europe/Kyiv explicitly (PRD 10). A phone set to
 * another zone would otherwise schedule the call an hour out.
 *
 * The assignee defaults to the current user and is sent explicitly: the server
 * never infers an assignee from the caller's identity, so a default that stayed
 * implicit would silently become "the deal's responsible user".
 */
export function TaskDialog({
  currentUserId,
  description,
  isPending = false,
  onOpenChange,
  onSubmit,
  open,
  submitError = null,
  title = 'Новая задача',
}: {
  currentUserId?: string
  description?: string
  isPending?: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: TaskCreateInput) => void
  open: boolean
  submitError?: Error | null
  title?: string
}) {
  const [kind, setKind] = useState<TaskKind>('CALL')
  const [taskTitle, setTaskTitle] = useState('')
  const [dueAtInput, setDueAtInput] = useState(() => defaultDueAt())
  const [errors, setErrors] = useState(emptyFormErrors)

  const submit = () => {
    const built = buildTaskInput({
      assigneeUserId: currentUserId,
      dueAtInput,
      kind,
      title: taskTitle,
    })

    if (!built.ok) {
      setErrors(built.errors)
      return
    }

    setErrors(emptyFormErrors)
    onSubmit(built.value)
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ??
              'У открытой сделки всегда должен быть следующий шаг с датой и временем.'}
          </DialogDescription>
        </DialogHeader>

        {(errors.formMessage || submitError) && (
          <Alert variant="destructive">
            <AlertTitle>Задача не сохранена</AlertTitle>
            <AlertDescription>{errors.formMessage ?? submitError?.message}</AlertDescription>
          </Alert>
        )}

        <div className="grid gap-4">
          <CrmSelectField
            error={errors.fields.kind}
            label="Тип задачи"
            onChange={(value) => setKind(taskKindSchema.parse(value))}
            options={taskKindSchema.options.map((option) => ({
              label: TASK_KIND_LABELS[option],
              value: option,
            }))}
            value={kind}
          />

          <CrmTextField
            error={errors.fields.title}
            label="Что сделать"
            onChange={setTaskTitle}
            placeholder="Перезвонить и уточнить площадь"
            value={taskTitle}
          />

          <div data-testid="task-due-at">
            <CrmTextField
              description="Время по Киеву"
              error={errors.fields.dueAt}
              label="Дата и время"
              onChange={setDueAtInput}
              type="datetime-local"
              value={dueAtInput}
            />
          </div>
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              <Typography variant="control">Отмена</Typography>
            </Button>
          </DialogClose>
          <Button data-testid="save-task" disabled={isPending} onClick={submit} type="button">
            <Typography variant="control">Сохранить задачу</Typography>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Tomorrow at 10:00 Kyiv.
 *
 * A default of "now" would be a task that is instantly overdue, which is the one
 * value the next-step rule treats as no next step at all — the form would
 * cheerfully record something that leaves the deal critical.
 */
function defaultDueAt() {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
  return `${toKyivDateTimeInput(tomorrow.toISOString()).slice(0, 10)}T10:00`
}
