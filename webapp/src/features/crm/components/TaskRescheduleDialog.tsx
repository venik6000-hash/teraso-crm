import type { DealTaskDto, TaskUpdateInput } from '@teraso-crm/contracts'
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
import { TASK_KIND_LABELS, buildTaskRescheduleInput, toKyivDateTimeInput } from '../model'
import { emptyFormErrors } from '../validation'
import { CrmTextField } from './CrmField'

/**
 * Moves one task's due time (PRD 6.2, PRD 7.4): the owner calls a day early, or
 * a client asks to push the callback, and the deal's next step should move
 * with it instead of sitting frozen until it turns overdue.
 *
 * Kind, title and assignee stay put — only the time changes — so this sends the
 * single-key `{ dueAt }` patch `taskUpdateSchema` accepts, built through
 * `buildTaskRescheduleInput`. That helper reuses the same Kyiv-to-UTC
 * conversion `TaskDialog` uses for a new task, so a reschedule and a new task
 * agree on what a typed time means without a second timezone implementation.
 *
 * Controlled the same way `TaskDialog` is: the caller owns `open` and decides
 * when to close, and this only validates and calls `onSubmit` once the draft is
 * a payload the server can accept.
 */
export function TaskRescheduleDialog({
  isPending = false,
  onOpenChange,
  onSubmit,
  open,
  submitError = null,
  task,
}: {
  isPending?: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: TaskUpdateInput) => void
  open: boolean
  submitError?: Error | null
  task: DealTaskDto
}) {
  const [dueAtInput, setDueAtInput] = useState(() => toKyivDateTimeInput(task.dueAt))
  const [errors, setErrors] = useState(emptyFormErrors)

  const submit = () => {
    const built = buildTaskRescheduleInput(dueAtInput)
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
          <DialogTitle>Перенести задачу</DialogTitle>
          <DialogDescription>{`${TASK_KIND_LABELS[task.kind]}: ${task.title}`}</DialogDescription>
        </DialogHeader>

        {(errors.formMessage || submitError) && (
          <Alert variant="destructive">
            <AlertTitle>Задача не перенесена</AlertTitle>
            <AlertDescription>{errors.formMessage ?? submitError?.message}</AlertDescription>
          </Alert>
        )}

        <div data-testid="task-reschedule-due-at">
          <CrmTextField
            description="Время по Киеву"
            error={errors.fields.dueAt}
            label="Новые дата и время"
            onChange={setDueAtInput}
            type="datetime-local"
            value={dueAtInput}
          />
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              <Typography variant="control">Отмена</Typography>
            </Button>
          </DialogClose>
          <Button
            data-testid="save-task-reschedule"
            disabled={isPending}
            onClick={submit}
            type="button"
          >
            <Typography variant="control">Перенести</Typography>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
