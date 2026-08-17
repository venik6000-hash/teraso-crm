import type { DealTaskDto } from '@teraso-crm/contracts'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Typography } from '@/components/typography'
import { TASK_KIND_LABELS } from '../model'

/**
 * The three actions PRD 6.2's working loop needs on an active task: close it,
 * push it, or give up on it. A terminal task (COMPLETED/CANCELLED) renders
 * nothing — the server refuses to edit one (`crm-repository.ts`'s
 * `applyTaskUpdate`), so offering these here would only trade a click for a
 * rejection the owner did not ask for.
 *
 * Cancelling is the one state change here that cannot be undone, so it goes
 * through `AlertDialog` rather than firing on click, consistent with how the
 * board's loss-reason confirmation and the deal card's reopen action both gate
 * their own irreversible-ish moves (PRD 7.0).
 *
 * A standalone component rather than inline JSX in `DealDetail` for the same
 * reason `ActivityTimeline` is one: it is the one piece of the tasks tab with
 * real branching (active vs terminal, direct action vs confirmed one), so it
 * is the piece worth testing on its own.
 */
export function TaskActions({
  isSaving,
  onCancel,
  onComplete,
  onReschedule,
  task,
}: {
  isSaving: boolean
  onCancel: () => void
  onComplete: () => void
  onReschedule: () => void
  task: DealTaskDto
}) {
  if (task.status !== 'ACTIVE') return null

  return (
    <div className="flex flex-wrap gap-2 pt-1">
      <Button
        data-testid="complete-task"
        disabled={isSaving}
        onClick={onComplete}
        size="sm"
        type="button"
        variant="outline"
      >
        <Typography variant="control">Выполнена</Typography>
      </Button>
      <Button
        data-testid="reschedule-task"
        disabled={isSaving}
        onClick={onReschedule}
        size="sm"
        type="button"
        variant="outline"
      >
        <Typography variant="control">Перенести</Typography>
      </Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button data-testid="cancel-task-trigger" disabled={isSaving} size="sm" type="button" variant="outline">
            <Typography variant="control">Отменить</Typography>
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Отменить задачу?</AlertDialogTitle>
            <AlertDialogDescription>
              {`${TASK_KIND_LABELS[task.kind]}: ${task.title}. Отменённую задачу нельзя будет вернуть в работу.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Не отменять</AlertDialogCancel>
            <AlertDialogAction data-testid="cancel-task-confirm" disabled={isSaving} onClick={onCancel}>
              Отменить задачу
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
