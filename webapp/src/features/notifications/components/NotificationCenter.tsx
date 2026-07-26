import { useEffect, useState } from 'react'

import { toRussianTransportMessage } from '../model'
import { useMarkNotificationsReadMutation, useNotificationInboxQuery } from '../queries'
import { NotificationBell } from './NotificationBell'
import { NotificationInbox } from './NotificationInbox'

/**
 * The inbox as a self-contained header control (PRD 7.7).
 *
 * It lives in this feature rather than inside the CRM's page shell because it is
 * this feature's own composition: the CRM only decides *where* to put it. That
 * also keeps the dependency running one way, so the notification centre no
 * longer reaches back into the CRM for anything.
 */

/** One page is one mark-read request; the contract caps a batch at 200 ids. */
const INBOX_PAGE_SIZE = 50

export function NotificationCenter() {
  const [isOpen, setIsOpen] = useState(false)
  const inbox = useNotificationInboxQuery({
    page: 1,
    pageSize: INBOX_PAGE_SIZE,
    unreadOnly: false,
  })
  const markRead = useMarkNotificationsReadMutation()
  const items = inbox.data?.items ?? []

  /**
   * Marking read is keyed to the sheet BEING open together with loaded data,
   * not to the moment it was opened. Opening the bell before the first response
   * arrives used to mark nothing at all, while the sheet promised the opposite.
   */
  useEffect(() => {
    if (!isOpen || items.length === 0 || markRead.isPending) return
    if (items.every((entry) => entry.readAt !== null)) return
    markRead.mutate(items)
    // `markRead` is intentionally absent: including the mutation object would
    // re-run this on every render it produces, and the guards above already
    // make a second run a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, items])

  return (
    <NotificationBell
      onOpenChange={setIsOpen}
      open={isOpen}
      unreadCount={inbox.data?.unreadCount ?? 0}
    >
      <NotificationInbox
        error={inbox.isError ? inbox.error : null}
        isError={inbox.isError}
        isMarking={markRead.isPending}
        isPending={inbox.isPending}
        markError={markRead.isError ? toRussianTransportMessage(markRead.error) : null}
        notifications={items}
        onOpen={() => setIsOpen(false)}
        onRetry={() => void inbox.refetch()}
        unreadCount={inbox.data?.unreadCount ?? 0}
      />
    </NotificationBell>
  )
}
