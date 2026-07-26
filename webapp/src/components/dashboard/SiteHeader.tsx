import type { ReactNode } from 'react'

import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Typography } from '@/components/typography'

/**
 * `actions` sits in the shell rather than on each page so a workspace-wide
 * control — the notification centre — is present on every screen of that
 * workspace, including the profile and settings pages the CRM's own page shell
 * does not wrap.
 */
export function SiteHeader({ actions, title }: { actions?: ReactNode; title: string }) {
  return (
    <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center border-b bg-background/95 backdrop-blur transition-[width,height] motion-reduce:transition-none">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          className="mx-2 data-[orientation=vertical]:h-4"
          orientation="vertical"
        />
        <Typography as="span" variant="h6">
          {title}
        </Typography>
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}
